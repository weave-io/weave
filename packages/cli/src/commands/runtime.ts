/**
 * Read-only runtime inspection commands.
 *
 * Implements `weave runtime status` and `weave runtime journal --limit <n>`.
 *
 * Both commands open the default Runtime Store path in read-only inspection
 * mode. If the store does not exist, they report a friendly message and exit 0
 * without creating any files.
 *
 * Output never includes raw prompts, completions, transcripts, credentials,
 * cookies, authorization headers, tokens, or raw provider payloads.
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import {
  CURRENT_SCHEMA_VERSION,
  createSqliteRuntimeStore,
  type ExecutionLease,
  type RuntimeJournalEntry,
  type RuntimeStore,
  readSchemaVersion,
  type WorkflowInstance,
} from "@weave/engine";
import { ok, type Result } from "neverthrow";
import type { CliError } from "../errors.js";
import type { TerminalIO } from "../io/terminal.js";
import type { ThemeColors } from "../theme/colors.js";

// ---------------------------------------------------------------------------
// Default DB path
// ---------------------------------------------------------------------------

/** Default Runtime Store DB path relative to the project root. */
const DEFAULT_RUNTIME_DB_PATH = ".weave/runtime/weave.db";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface RuntimeCommandContext {
  terminal: TerminalIO;
  theme: ThemeColors;
  /** Subcommand: "status" or "journal". */
  subcommand: "status" | "journal";
  /** --limit flag for journal (default: 50). */
  limit?: number;
  /** Project root directory (defaults to cwd). */
  cwd?: string;
  /**
   * Optional store factory override — used in tests to inject an in-memory
   * store without touching the filesystem.
   */
  storeFactory?: (dbPath: string) => RuntimeStore;
  /**
   * Optional existence check override — used in tests to control whether
   * the DB "exists" without real filesystem access.
   */
  dbExists?: (dbPath: string) => Promise<boolean>;
  /**
   * Optional schema version override — used in tests to inject a known
   * schema version without reading from a real SQLite DB.
   * If omitted, the schema version is read from the DB at `dbPath`.
   */
  schemaVersion?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultDbExists(dbPath: string): Promise<boolean> {
  return Bun.file(dbPath).exists();
}

function defaultStoreFactory(dbPath: string): RuntimeStore {
  return createSqliteRuntimeStore({ dbPath });
}

function formatLease(lease: ExecutionLease, theme: ThemeColors): string {
  const now = new Date();
  const expiresAt = new Date(lease.expiresAt);
  const expired = expiresAt <= now;
  const statusLabel = expired
    ? theme.dim("(expired)")
    : theme.boldCyan("(active)");
  return [
    `  Lease ID:    ${lease.id}`,
    `  Owner:       ${lease.ownerId}`,
    `  Acquired:    ${lease.acquiredAt}`,
    `  Expires:     ${lease.expiresAt} ${statusLabel}`,
    ...(lease.lastHeartbeatAt
      ? [`  Heartbeat:   ${lease.lastHeartbeatAt}`]
      : []),
  ].join("\n");
}

function formatInstanceStatus(
  status: WorkflowInstance["status"],
  theme: ThemeColors,
): string {
  if (status === "running") return theme.boldCyan(status);
  if (status === "paused" || status === "blocked")
    return theme.boldYellow(status);
  return theme.dim(status);
}

function formatInstance(
  instance: WorkflowInstance,
  theme: ThemeColors,
): string {
  const statusColor = formatInstanceStatus(instance.status, theme);

  const lines = [
    `  ID:          ${instance.id}`,
    `  Workflow:    ${instance.workflowName}`,
    `  Goal:        ${instance.goal}`,
    `  Status:      ${statusColor}`,
    `  Created:     ${instance.createdAt}`,
    `  Updated:     ${instance.updatedAt}`,
  ];

  if (instance.currentStepName) {
    lines.push(`  Step:        ${instance.currentStepName}`);
  }
  if (instance.completedAt) {
    lines.push(`  Completed:   ${instance.completedAt}`);
  }
  if (instance.errorMessage) {
    lines.push(`  Error:       ${instance.errorMessage}`);
  }
  if (instance.artifacts.length > 0) {
    lines.push(`  Artifacts:   ${instance.artifacts.length}`);
  }

  return lines.join("\n");
}

function formatSeverityLabel(
  severity: RuntimeJournalEntry["severity"],
  theme: ThemeColors,
): string {
  const label = `[${severity.toUpperCase()}]`;
  if (severity === "warn") return theme.boldYellow(label);
  return theme.dim(label);
}

function formatJournalEntry(
  entry: RuntimeJournalEntry,
  theme: ThemeColors,
): string {
  const severityLabel = formatSeverityLabel(entry.severity, theme);

  const sourceLabel = `${entry.source.kind}/${entry.source.name}`;

  // Render data fields — exclude any denied/sensitive keys defensively
  const safeDataKeys = Object.keys(entry.data).filter(
    (k) => !isSensitiveKey(k),
  );
  const dataStr =
    safeDataKeys.length > 0
      ? " " +
        safeDataKeys
          .map((k) => `${k}=${JSON.stringify(entry.data[k])}`)
          .join(" ")
      : "";

  return `${entry.timestamp} ${severityLabel} [${sourceLabel}] ${entry.eventType}${dataStr}`;
}

/**
 * Defensive check for sensitive-looking keys in journal data.
 * Mirrors the denylist in the engine sanitizer.
 */
function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  const denied = new Set([
    "token",
    "apikey",
    "api_key",
    "password",
    "secret",
    "authorization",
    "cookie",
    "bearer",
    "accesstoken",
    "access_token",
    "refreshtoken",
    "refresh_token",
    "clientsecret",
    "client_secret",
    "privatekey",
    "private_key",
    "auth",
    "credentials",
    "credential",
    "prompt",
    "completion",
    "transcript",
    "rawprompt",
    "raw_prompt",
    "rawcompletion",
    "raw_completion",
    "rawtranscript",
    "raw_transcript",
    "systemprompt",
    "system_prompt",
    "userprompt",
    "user_prompt",
    "assistantmessage",
    "assistant_message",
  ]);
  return denied.has(lower);
}

// ---------------------------------------------------------------------------
// runtime status
// ---------------------------------------------------------------------------

async function runRuntimeStatus(
  ctx: RuntimeCommandContext,
  dbPath: string,
  store: RuntimeStore,
  schemaVersion: number,
): Promise<Result<number, CliError>> {
  const { terminal, theme } = ctx;

  // Query active lease
  const leaseResult = await store.leases.findActive();
  // Query recent workflow instances (all, limit display to 10)
  const instancesResult = await store.instances.list();

  const lines: string[] = [
    "",
    `${theme.boldCyan("Runtime Store Status")}`,
    "",
    `  DB path:       ${dbPath}`,
    `  Schema version: ${schemaVersion}`,
    "",
  ];

  // Active lease
  if (leaseResult.isOk()) {
    const lease = leaseResult.value;
    if (lease) {
      lines.push(`${theme.boldCyan("Active Lease")}`);
      lines.push(formatLease(lease, theme));
      lines.push("");
    } else {
      lines.push(`  ${theme.dim("No active lease.")}`);
      lines.push("");
    }
  } else {
    lines.push(
      `  ${theme.dim(`Could not query lease: ${leaseResult.error.message}`)}`,
    );
    lines.push("");
  }

  // Workflow instances
  if (instancesResult.isOk()) {
    const instances = instancesResult.value;
    const resumable = instances.filter(
      (i) => i.status === "paused" || i.status === "blocked",
    );
    const recent = [...instances]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 10);

    lines.push(
      `${theme.boldCyan("Workflow Instances")} ${theme.dim(`(${instances.length} total)`)}`,
    );
    lines.push("");

    if (resumable.length > 0) {
      lines.push(`  ${theme.boldYellow("Resumable:")} ${resumable.length}`);
      for (const inst of resumable) {
        lines.push(formatInstance(inst, theme));
        lines.push("");
      }
    }

    if (recent.length > 0) {
      lines.push(`  ${theme.dim("Recent (up to 10):")}`);
      for (const inst of recent) {
        lines.push(formatInstance(inst, theme));
        lines.push("");
      }
    } else {
      lines.push(`  ${theme.dim("No workflow instances found.")}`);
      lines.push("");
    }
  } else {
    lines.push(
      `  ${theme.dim(`Could not query instances: ${instancesResult.error.message}`)}`,
    );
    lines.push("");
  }

  terminal.stdout(lines.join("\n"));

  await store.close();
  return ok(0);
}

// ---------------------------------------------------------------------------
// runtime journal
// ---------------------------------------------------------------------------

async function runRuntimeJournal(
  ctx: RuntimeCommandContext,
  _dbPath: string,
  store: RuntimeStore,
): Promise<Result<number, CliError>> {
  const { terminal, theme } = ctx;
  const rawLimit = ctx.limit ?? 50;
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 50;

  const entriesResult = await store.journal.query({ limit });

  if (entriesResult.isErr()) {
    terminal.stderr(`Error querying journal: ${entriesResult.error.message}`);
    await store.close();
    return ok(1);
  }

  const entries = entriesResult.value;

  const lines: string[] = [
    "",
    `${theme.boldCyan("Runtime Journal")} ${theme.dim(`(limit: ${limit}, showing: ${entries.length})`)}`,
    "",
  ];

  if (entries.length === 0) {
    lines.push(`  ${theme.dim("No journal entries found.")}`);
    lines.push("");
  } else {
    for (const entry of entries) {
      lines.push(formatJournalEntry(entry, theme));
    }
    lines.push("");
  }

  terminal.stdout(lines.join("\n"));

  await store.close();
  return ok(0);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run a read-only runtime inspection command.
 *
 * Opens the default Runtime Store path without creating or mutating state
 * if the store does not exist.
 */
export async function runRuntime(
  ctx: RuntimeCommandContext,
): Promise<Result<number, CliError>> {
  const { terminal, theme } = ctx;
  const cwd = ctx.cwd ?? process.cwd();
  const dbPath = resolve(cwd, DEFAULT_RUNTIME_DB_PATH);

  const checkExists = ctx.dbExists ?? defaultDbExists;
  const exists = await checkExists(dbPath);

  if (!exists) {
    terminal.stdout(`${theme.dim("No runtime store found at")} ${dbPath}`);
    return ok(0);
  }

  const factory = ctx.storeFactory ?? defaultStoreFactory;
  const store = factory(dbPath);

  if (ctx.subcommand === "status") {
    // Resolve schema version: use injected value (tests) or read from DB
    let schemaVersion: number;
    if (ctx.schemaVersion !== undefined) {
      schemaVersion = ctx.schemaVersion;
    } else {
      try {
        const db = new Database(dbPath, { readonly: true });
        try {
          schemaVersion = readSchemaVersion(db);
        } finally {
          db.close();
        }
      } catch {
        terminal.stderr(
          `${theme.dim("Could not read schema version; using current schema version.")}`,
        );
        schemaVersion = CURRENT_SCHEMA_VERSION;
      }
    }
    return runRuntimeStatus(ctx, dbPath, store, schemaVersion);
  }

  return runRuntimeJournal(ctx, dbPath, store);
}
