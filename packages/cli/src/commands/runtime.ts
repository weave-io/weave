/**
 * Read-only runtime inspection commands.
 *
 * Implements `weave runtime status`, `weave runtime journal --limit <n>`, and
 * `weave runtime preferences [--namespace <ns>] [--limit <n>]`.
 *
 * Every subcommand opens the default Runtime Store path in read-only inspection
 * mode. If the store does not exist, they report a friendly message and exit 0
 * without creating any files.
 *
 * Output never includes raw prompts, completions, transcripts, credentials,
 * cookies, authorization headers, tokens, or raw provider payloads.
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import {
  type AdapterPreferenceRecord,
  CURRENT_SCHEMA_VERSION,
  clampAdapterPreferenceListLimit,
  createSqliteRuntimeStore,
  type ExecutionLease,
  isDeniedKey,
  type RuntimeJournalEntry,
  type RuntimeStore,
  readSchemaVersion,
  type WorkflowInstance,
} from "@weaveio/weave-engine";
import { fromThrowable, ok, type Result } from "neverthrow";
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
  /** Subcommand: "status", "journal", or "preferences". */
  subcommand: "status" | "journal" | "preferences";
  /** --limit flag for journal (default: 50) and preferences (default: 100). */
  limit?: number;
  /**
   * Optional --namespace filter for `preferences`.
   *
   * When absent, the command lists bounded rows across every namespace.
   */
  namespace?: string;
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

/**
 * Read the schema version from a SQLite DB at `dbPath`.
 *
 * Opens the DB in read-only mode, reads the version, then closes it.
 * The `finally` block guarantees `db.close()` runs even when
 * `readSchemaVersion` throws. The outer `fromThrowable` captures any thrown
 * error (bad path, corrupt DB, missing table) and maps it to a typed
 * `ReadFailed` error so callers never see a raw exception.
 */
function readSchemaVersionFromDb(
  dbPath: string,
): Result<number, { type: "ReadFailed" }> {
  return fromThrowable(
    () => {
      const db = new Database(dbPath, { readonly: true });
      try {
        return readSchemaVersion(db);
      } finally {
        db.close();
      }
    },
    () => ({ type: "ReadFailed" as const }),
  )();
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
  const safeDataKeys = Object.keys(entry.data).filter((k) => !isDeniedKey(k));
  const dataStr =
    safeDataKeys.length > 0
      ? ` ${safeDataKeys
          .map((k) => `${k}=${JSON.stringify(entry.data[k])}`)
          .join(" ")}`
      : "";

  return `${entry.timestamp} ${severityLabel} [${sourceLabel}] ${entry.eventType}${dataStr}`;
}

// ---------------------------------------------------------------------------
// Preference value preview
// ---------------------------------------------------------------------------

/**
 * Maximum size, in UTF-8 bytes, of a rendered preference value preview.
 * A single-character ellipsis is appended when the value is truncated, so a
 * truncated preview renders `PREFERENCE_VALUE_PREVIEW_MAX_BYTES` payload bytes
 * plus that marker.
 */
const PREFERENCE_VALUE_PREVIEW_MAX_BYTES = 120;

/** Marker appended to a preview that was cut short. */
const PREFERENCE_VALUE_TRUNCATION_MARKER = "…";

/**
 * Replace every run of control characters with a single space and drop leading
 * and trailing runs, so the result is always one printable line.
 */
function collapseControlCharacters(value: string): string {
  let out = "";
  let pendingSpace = false;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    out += char;
  }
  return out;
}

/**
 * Render a one-line, byte-bounded preview of an opaque preference value.
 *
 * Control characters (including newlines and tabs) collapse to single spaces so
 * one record always occupies exactly one output line. Truncation is measured in
 * UTF-8 bytes, not characters, and never splits a visible character: the byte
 * slice is decoded leniently and any trailing replacement characters produced by
 * a split multi-byte sequence are removed.
 */
function previewPreferenceValue(valueJson: string): string {
  const singleLine = collapseControlCharacters(valueJson);
  const bytes = new TextEncoder().encode(singleLine);
  if (bytes.byteLength <= PREFERENCE_VALUE_PREVIEW_MAX_BYTES) return singleLine;
  const head = new TextDecoder("utf-8")
    .decode(bytes.slice(0, PREFERENCE_VALUE_PREVIEW_MAX_BYTES))
    .replace(/\uFFFD+$/, "");
  return `${head}${PREFERENCE_VALUE_TRUNCATION_MARKER}`;
}

/**
 * Render one preference row as `namespace  key  updated_at  <value preview>`.
 *
 * Values stored under a denied key name are never printed. Preferences must not
 * hold secrets, so this is a defensive backstop rather than a supported use.
 */
function formatPreferenceRecord(record: AdapterPreferenceRecord): string {
  const preview = isDeniedKey(record.key)
    ? "<redacted>"
    : previewPreferenceValue(record.valueJson);
  return `${record.namespace}  ${record.key}  ${record.updatedAt}  ${preview}`;
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
// runtime preferences
// ---------------------------------------------------------------------------

/**
 * List stored adapter preferences.
 *
 * Without `--namespace`, this enumerates every namespace through the
 * repository's bounded `listAll`. With `--namespace`, it lists that one
 * namespace through `list`.
 *
 * Read-only: the command opens the existing store, reads, and closes it. It
 * never writes, creates, or migrates anything.
 */
async function runRuntimePreferences(
  ctx: RuntimeCommandContext,
  _dbPath: string,
  store: RuntimeStore,
): Promise<Result<number, CliError>> {
  const { terminal, theme } = ctx;
  const namespace = ctx.namespace;

  const limit = clampAdapterPreferenceListLimit(ctx.limit);
  const recordsResult =
    namespace === undefined
      ? await store.preferences.listAll(limit)
      : await store.preferences.list(namespace, limit);

  if (recordsResult.isErr()) {
    terminal.stderr(
      `Error querying preferences: ${recordsResult.error.message}`,
    );
    await store.close();
    return ok(1);
  }

  const records = recordsResult.value.slice(0, limit);

  const scopeLabel =
    namespace === undefined ? "all namespaces" : `namespace: ${namespace}`;

  const lines: string[] = [
    "",
    `${theme.boldCyan("Adapter Preferences")} ${theme.dim(`(${scopeLabel}, limit: ${limit}, showing: ${records.length})`)}`,
    "",
  ];

  if (records.length === 0) {
    lines.push(
      namespace === undefined
        ? `  ${theme.dim("No preferences stored.")}`
        : `  ${theme.dim(`No preferences stored in namespace "${namespace}".`)}`,
    );
    lines.push("");
  } else {
    for (const record of records) {
      lines.push(formatPreferenceRecord(record));
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
    let schemaVersion: number = CURRENT_SCHEMA_VERSION;
    if (ctx.schemaVersion !== undefined) {
      schemaVersion = ctx.schemaVersion;
    } else {
      readSchemaVersionFromDb(dbPath).match(
        (version) => {
          schemaVersion = version;
        },
        () => {
          terminal.stderr(
            `${theme.dim("Could not read schema version; using current schema version.")}`,
          );
        },
      );
    }
    return runRuntimeStatus(ctx, dbPath, store, schemaVersion);
  }

  if (ctx.subcommand === "preferences") {
    return runRuntimePreferences(ctx, dbPath, store);
  }

  return runRuntimeJournal(ctx, dbPath, store);
}
