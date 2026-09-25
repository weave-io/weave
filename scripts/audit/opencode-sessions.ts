/**
 * Real-session audit (L5) — Spec 38 item 9.
 *
 * Reads an OpenCode session store read-only and prints the WS1 delegation
 * scorecard as Markdown or JSON: aggregate counts only, never message text,
 * prompts, titles, directories or error strings.
 *
 *   bun scripts/audit/opencode-sessions.ts [--harness opencode|opencode2]
 *     [--db <path>] [--since <date>] [--until <date>] [--project <dir>]
 *     [--format md|json]
 *
 * # Stores
 *
 * - `--harness opencode` (default): OpenCode V1, default store
 *   `~/.local/share/opencode/opencode.db` (tables `session`, `message`,
 *   `part`).
 * - `--harness opencode2`: OpenCode V2 (`@opencode/cli`), tables
 *   `session_v2` and `session_message`, delegations as `subagent` tool items
 *   in an assistant message's `content`. Default store
 *   `~/.weave/harnesses/opencode2/data/opencode.db`, where the V2 host that
 *   Weave Fleet manages keeps it on the maintainer's workstation; a V2 host
 *   run elsewhere keeps it under its own data directory, so pass `--db`.
 *
 * The database is opened with `readonly: true` and never written.
 *
 * # Window and scope
 *
 * Sessions are selected by creation time: `--since` inclusive, `--until`
 * exclusive. A date without a time is midnight UTC, and a date-only
 * `--until` includes that whole day, so `--since 2026-09-04 --until
 * 2026-09-18` is 4–18 Sep inclusive. The default is the 7 days before now.
 * Sessions whose directory is under `/tmp/` are excluded (automated test
 * sessions). `--project` keeps sessions whose directory is that directory or
 * below it. Top-level and child sessions both count.
 *
 * # Metrics and definitional differences
 *
 * Definitions: Spec 37 "Metric definitions for the session audit script"
 * and Spec 38 "Metrics" (`docs/specs/37-spec-repository-foundation/`,
 * `docs/specs/38-spec-delegation-accuracy/`). Where this script differs:
 *
 * - Configuration failures: a failed call without a target counts only when
 *   the user did not abort it (`Task cancelled`, `Tool execution aborted`).
 *   The 4–18 Sep baseline (11 of 597) excludes those aborts.
 * - Recovered failures: divided by every failed call, as Spec 38 says, with
 *   transient and configuration failures also reported on their own and the
 *   rest (mostly user aborts, which nothing should resend) as "other".
 *   A recovery is a completed resend (the caller's "retried successfully";
 *   Spec 38 only asks that one is sent). "The same assistant turn, or the
 *   next" is the assistant messages answering the same user message, or the
 *   next user message. The same rule gives "transient failures not
 *   recovered", which the audit reported as "not retried".
 * - Plan-task delegation by Loom: the plan marker is the text the current
 *   commands write — V1's `/start-work` and `/weave:start` share "activated
 *   by the /start-work command"; V2 writes "activated by /weave:start" or
 *   "activated to execute the Weave plan". Only Loom messages after the
 *   first marker in the session count. Two numbers are reported: plan
 *   sessions in which Loom took any turn (the audit's "17 of 20") and Loom
 *   messages with a delegation (Spec 37's definition).
 * - Category-shuttle share: a project defines categories when its effective
 *   Weave config (builtins, global and project `config.weave`) declares one
 *   today, or when it delegated to a `shuttle-*` agent in the window. Config
 *   is read as it is now, not as it was when the session ran.
 * - Delegations in OpenCode V2 are `subagent` tool items (target
 *   `state.input.agent`); V1's are `task` parts (target
 *   `state.input.subagent_type`).
 */

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type ConfigLoadError, loadConfig } from "@weaveio/weave-config";
import { logDestination, logger } from "@weaveio/weave-engine";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { buildScorecard, renderJson, renderMarkdown } from "./scorecard.js";
import {
  type AuditDataset,
  type AuditError,
  type Harness,
  type SessionStore,
  sessionStoreFor,
} from "./session-store.js";

const log = logger.child({ module: "audit-opencode-sessions" });

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const USAGE =
  "usage: bun scripts/audit/opencode-sessions.ts [--harness opencode|opencode2] [--db <path>] [--since <date>] [--until <date>] [--project <dir>] [--format md|json]";

export type OutputFormat = "md" | "json";

export interface AuditOptions {
  readonly harness: Harness;
  readonly db: string;
  readonly since: number;
  readonly until: number;
  readonly project?: string;
  readonly format: OutputFormat;
}

/** Default store path for each harness, relative to the home directory. */
export function defaultDbPath(harness: Harness, home: string): string {
  if (harness === "opencode2") {
    return join(
      home,
      ".weave",
      "harnesses",
      "opencode2",
      "data",
      "opencode.db",
    );
  }
  return join(home, ".local", "share", "opencode", "opencode.db");
}

function usage(message: string): AuditError {
  return { type: "UsageError", message: `${message}\n${USAGE}` };
}

function parseTime(
  flag: string,
  value: string,
  endOfDay: boolean,
): Result<number, AuditError> {
  const dateOnly = DATE_ONLY.test(value);
  const parsed = Date.parse(dateOnly ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(parsed)) {
    return err(usage(`--${flag} must be a date (YYYY-MM-DD) or ISO time`));
  }
  return ok(dateOnly && endOfDay ? parsed + DAY_MS : parsed);
}

function readFlags(
  argv: readonly string[],
): Result<Map<string, string>, AuditError> {
  const known = new Set([
    "harness",
    "db",
    "since",
    "until",
    "project",
    "format",
  ]);
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] ?? "";
    const value = argv[i + 1];
    const name = flag.slice(2);
    if (!flag.startsWith("--") || !known.has(name)) {
      return err(usage(`unknown argument: ${flag}`));
    }
    if (value === undefined || value.startsWith("--")) {
      return err(usage(`${flag} needs a value`));
    }
    flags.set(name, value);
  }
  return ok(flags);
}

/** Parses the command line; `now` and `home` are injected for tests. */
export function parseAuditArgs(
  argv: readonly string[],
  now: number,
  home: string,
): Result<AuditOptions, AuditError> {
  const flags = readFlags(argv);
  if (flags.isErr()) return err(flags.error);
  const get = (name: string): string | undefined => flags.value.get(name);

  const harness = get("harness") ?? "opencode";
  if (harness !== "opencode" && harness !== "opencode2") {
    return err(usage("--harness must be opencode or opencode2"));
  }
  const format = get("format") ?? "md";
  if (format !== "md" && format !== "json") {
    return err(usage("--format must be md or json"));
  }

  const untilRaw = get("until");
  const until =
    untilRaw === undefined ? ok(now) : parseTime("until", untilRaw, true);
  if (until.isErr()) return err(until.error);
  const sinceRaw = get("since");
  const since =
    sinceRaw === undefined
      ? ok(until.value - 7 * DAY_MS)
      : parseTime("since", sinceRaw, false);
  if (since.isErr()) return err(since.error);
  if (since.value >= until.value) {
    return err(usage("--since must be before --until"));
  }

  const project = get("project");
  return ok({
    harness,
    db: get("db") ?? defaultDbPath(harness, home),
    since: since.value,
    until: until.value,
    project: project === undefined ? undefined : resolve(project),
    format,
  });
}

/** Counts a project's declared categories; injected so tests need no files. */
export type CategoryCounter = (
  projectDir: string,
) => ResultAsync<number, ConfigLoadError[]>;

/**
 * Decides which projects define categories, from each project's effective
 * Weave config. A project whose config cannot be loaded counts as defining
 * none; the metric still counts it when it used a category shuttle.
 */
export class CategoryProjects {
  constructor(private readonly countCategories: CategoryCounter) {}

  resolve(projectDirs: Iterable<string>): ResultAsync<Set<string>, never> {
    const dirs = [...new Set(projectDirs)];
    const counts = dirs.map((dir) =>
      this.countCategories(dir).orElse((errors) => {
        log.debug(
          { projectDir: dir, errors: errors.map((e) => e.type) },
          "Could not load Weave config",
        );
        return ok(0);
      }),
    );
    return ResultAsync.combine(counts).map(
      (values) => new Set(dirs.filter((_, i) => (values[i] ?? 0) > 0)),
    );
  }
}

/** Counts categories in the project's effective Weave config. */
export const weaveConfigCategoryCounter: CategoryCounter = (projectDir) =>
  loadConfig(projectDir).map(
    (config) =>
      Object.keys(config.categories).filter(
        (name) => !config.disabled.agents.includes(`shuttle-${name}`),
      ).length,
  );

export interface AuditDependencies {
  readonly openStore: (
    harness: Harness,
    path: string,
  ) => Result<SessionStore, AuditError>;
  readonly countCategories: CategoryCounter;
  readonly write: (text: string) => ResultAsync<void, AuditError>;
  readonly now: () => number;
  readonly home: string;
}

/** Opens the store read-only; the file must already exist. */
export function openReadOnlyStore(
  harness: Harness,
  path: string,
): Result<SessionStore, AuditError> {
  const open = Result.fromThrowable(
    () => new Database(path, { readonly: true }),
    (cause): AuditError => ({
      type: "DatabaseOpenError",
      path,
      message: cause instanceof Error ? cause.message : String(cause),
    }),
  );
  return open().map((db) => sessionStoreFor(harness, db));
}

/** The command: parse flags, read the store, compute and print the scorecard. */
export class SessionAuditCommand {
  constructor(private readonly deps: AuditDependencies) {}

  run(argv: readonly string[]): ResultAsync<void, AuditError> {
    return parseAuditArgs(argv, this.deps.now(), this.deps.home)
      .andThen((options) =>
        this.deps
          .openStore(options.harness, options.db)
          .andThen((store) => store.read(options))
          .map((dataset) => ({ options, dataset })),
      )
      .asyncAndThen(({ options, dataset }) =>
        new CategoryProjects(this.deps.countCategories)
          .resolve(dataset.sessions.map((s) => s.projectDir))
          .map((categoryProjects) =>
            this.render(options, dataset, categoryProjects),
          ),
      )
      .andThen((text) => this.deps.write(text));
  }

  private render(
    options: AuditOptions,
    dataset: AuditDataset,
    categoryProjects: Set<string>,
  ): string {
    const card = buildScorecard({
      dataset,
      since: options.since,
      until: options.until,
      projectFilter: options.project !== undefined,
      definesCategories: (dir) => categoryProjects.has(dir),
    });
    if (options.format === "json") return renderJson(card);
    return renderMarkdown(card);
  }
}

/** Writes to stdout, capturing synchronous and asynchronous failures. */
export function writeStdout(text: string): ResultAsync<void, AuditError> {
  const write = ResultAsync.fromThrowable(
    async (chunk: string): Promise<void> => {
      await Bun.write(Bun.stdout, chunk);
    },
    (cause): AuditError => ({
      type: "OutputError",
      message: cause instanceof Error ? cause.message : String(cause),
    }),
  );
  return write(text);
}

/**
 * Log sink for the command line: stdout carries the scorecard, so logs go to
 * stderr, and below warning level only when `LOG_LEVEL` asks for them (the
 * config loader logs every project it loads at info level).
 */
export class StderrLogSink {
  constructor(
    private readonly minLevel: number,
    private readonly out: { write(chunk: string): boolean } = process.stderr,
  ) {}

  write(chunk: string): boolean {
    const level = Number(/"level":(\d+)/.exec(chunk)?.[1] ?? Infinity);
    if (level < this.minLevel) return true;
    return this.out.write(chunk);
  }
}

const PINO_WARN = 40;

if (import.meta.main) {
  logDestination.redirectTo(
    new StderrLogSink(process.env.LOG_LEVEL === undefined ? PINO_WARN : 0),
  );
  const command = new SessionAuditCommand({
    openStore: openReadOnlyStore,
    countCategories: weaveConfigCategoryCounter,
    write: writeStdout,
    now: () => Date.now(),
    home: homedir(),
  });
  const result = await command.run(process.argv.slice(2));
  if (result.isErr()) {
    log.error({ error: result.error }, "Session audit failed");
    process.exitCode = 1;
  }
}
