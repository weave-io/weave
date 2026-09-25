/**
 * Read-only readers for OpenCode session stores, normalised into the rows the
 * WS1 delegation metrics need (see `delegation-metrics.ts`).
 *
 * Two stores are supported:
 *
 * - **OpenCode V1** (`opencode`): `~/.local/share/opencode/opencode.db`.
 *   Tables `session`, `message` and `part`; `message.data` and `part.data`
 *   are JSON. A delegation is a `part` with `type = 'tool'` and
 *   `tool = 'task'`; its target is `state.input.subagent_type`, its status
 *   `state.status` and its error the string `state.error`.
 * - **OpenCode V2** (`opencode2`, the `@opencode/cli` host): tables
 *   `session_v2` and `session_message`. Each `session_message` row is one
 *   whole message with a `type` column (`user`, `assistant`, `synthetic`,
 *   `idle`, ...) and an ordering `seq`. An assistant row's `data.content` is
 *   an array; a delegation is an item with `type = 'tool'` and
 *   `name = 'subagent'`, its target `state.input.agent`, its status
 *   `state.status` and its error the object `state.error` (`type`,
 *   `message`). On this workstation the V2 host managed by Weave Fleet keeps
 *   the store at `~/.weave/harnesses/opencode2/data/opencode.db`.
 *
 * Privacy: the readers never return message text, prompts or tool output.
 * Text is inspected inside SQLite only to set the boolean `planMarker`; the
 * only strings that leave the database are identifiers, directories, agent
 * names and the harness's delegation error strings, which the metrics
 * classify and never print.
 */

import type { Database } from "bun:sqlite";
import { err, ok, Result } from "neverthrow";

export type Harness = "opencode" | "opencode2";

export type AuditError =
  | { type: "UsageError"; message: string }
  | { type: "DatabaseOpenError"; path: string; message: string }
  | { type: "UnsupportedSchema"; harness: Harness; missing: string[] }
  | { type: "QueryError"; harness: Harness; message: string }
  | { type: "OutputError"; message: string };

/** Which sessions to read. Times are epoch milliseconds; `until` is exclusive. */
export interface AuditFilter {
  readonly since: number;
  readonly until: number;
  /** Only sessions whose directory is this directory or below it. */
  readonly project?: string;
}

export interface AuditSession {
  readonly id: string;
  readonly parentId: string | null;
  readonly directory: string;
  /** The project root used to look up the project's categories. */
  readonly projectDir: string;
}

export type AuditRole = "user" | "assistant" | "other";

export interface AuditMessage {
  readonly id: string;
  readonly sessionId: string;
  /** Position of the message in its session, ascending. */
  readonly order: number;
  readonly role: AuditRole;
  readonly agent: string | null;
  /** A user message that starts plan execution (`/start-work`, `/weave:start`). */
  readonly planMarker: boolean;
}

export type DelegationStatus = "completed" | "error" | "running" | "other";

export interface AuditDelegation {
  readonly id: string;
  readonly sessionId: string;
  readonly messageId: string;
  /** Position of the delegation within its message, ascending. */
  readonly index: number;
  readonly target: string | null;
  readonly status: DelegationStatus;
  readonly error: string | null;
}

export interface AuditDataset {
  readonly harness: Harness;
  readonly sessions: readonly AuditSession[];
  readonly messages: readonly AuditMessage[];
  readonly delegations: readonly AuditDelegation[];
  /** Sessions in the window left out because their directory is under `/tmp/`. */
  readonly excludedTmpSessions: number;
}

/** A session store the audit can read. */
export interface SessionStore {
  read(filter: AuditFilter): Result<AuditDataset, AuditError>;
}

/**
 * Text a plan-starting command writes into the user message. V1's
 * `/start-work` and `/weave:start` share one template ("You are being
 * activated by the /start-work command"); V2's `/weave:start` template says
 * "activated by /weave:start", and V2's `startPlanExecution` says "activated
 * to execute the Weave plan".
 */
export const PLAN_MARKERS: readonly string[] = [
  "activated by the /start-work command",
  "activated by /weave:start",
  "activated to execute the Weave plan",
];

const TMP_PREFIX = "/tmp/";

interface SessionRow {
  id: string;
  parent_id: string | null;
  directory: string;
  worktree: string | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string | null;
  agent: string | null;
  plan_marker: number;
}

interface DelegationRow {
  id: string;
  session_id: string;
  message_id: string;
  target: string | null;
  status: string | null;
  error: string | null;
}

function isUnder(directory: string, root: string): boolean {
  if (root === "/") return directory.startsWith("/");
  const trimmed = root.endsWith("/") ? root.slice(0, -1) : root;
  return directory === trimmed || directory.startsWith(`${trimmed}/`);
}

function toStatus(raw: string | null): DelegationStatus {
  if (raw === "completed") return "completed";
  if (raw === "error") return "error";
  if (raw === "running" || raw === "pending" || raw === "streaming") {
    return "running";
  }
  return "other";
}

function toRole(raw: string | null): AuditRole {
  if (raw === "user") return "user";
  if (raw === "assistant") return "assistant";
  return "other";
}

function markerClause(column: string): string {
  return PLAN_MARKERS.map(
    (marker) => `instr(coalesce(${column}, ''), '${marker}') > 0`,
  ).join(" or ");
}

/**
 * Shared filtering and normalisation; subclasses supply the harness's SQL.
 */
abstract class SqliteSessionStore implements SessionStore {
  protected abstract readonly harness: Harness;
  protected abstract readonly requiredTables: readonly string[];
  protected abstract readonly sessionSql: string;
  protected abstract readonly messageSql: string;
  protected abstract readonly delegationSql: string;

  constructor(private readonly db: Database) {}

  read(filter: AuditFilter): Result<AuditDataset, AuditError> {
    const schema = this.checkSchema();
    if (schema.isErr()) return err(schema.error);
    const rows = this.query(filter);
    if (rows.isErr()) return err(rows.error);
    return ok(this.normalise(rows.value, filter));
  }

  private checkSchema(): Result<void, AuditError> {
    const tables = this.run(() =>
      this.db
        .query("select name from sqlite_master where type = 'table'")
        .all(),
    );
    if (tables.isErr()) return err(tables.error);
    const present = new Set(
      (tables.value as { name: string }[]).map((row) => row.name),
    );
    const missing = this.requiredTables.filter((name) => !present.has(name));
    if (missing.length > 0) {
      return err({ type: "UnsupportedSchema", harness: this.harness, missing });
    }
    return ok(undefined);
  }

  private query(filter: AuditFilter): Result<
    {
      sessions: SessionRow[];
      messages: MessageRow[];
      delegations: DelegationRow[];
    },
    AuditError
  > {
    const params = [filter.since, filter.until];
    return this.run(() => ({
      sessions: this.db.query(this.sessionSql).all(...params) as SessionRow[],
      messages: this.db.query(this.messageSql).all(...params) as MessageRow[],
      delegations: this.db
        .query(this.delegationSql)
        .all(...params) as DelegationRow[],
    }));
  }

  private normalise(
    rows: {
      sessions: SessionRow[];
      messages: MessageRow[];
      delegations: DelegationRow[];
    },
    filter: AuditFilter,
  ): AuditDataset {
    const inWindow = rows.sessions;
    const nonTmp = inWindow.filter(
      (row) => !row.directory.startsWith(TMP_PREFIX),
    );
    const project = filter.project;
    const kept =
      project === undefined
        ? nonTmp
        : nonTmp.filter((row) => isUnder(row.directory, project));
    const sessions: AuditSession[] = kept.map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      directory: row.directory,
      projectDir:
        row.worktree !== null && row.worktree !== "/"
          ? row.worktree
          : row.directory,
    }));
    const ids = new Set(sessions.map((session) => session.id));

    // Rows arrive ordered by session, then position.
    const orders = new Map<string, number>();
    const messages: AuditMessage[] = [];
    for (const row of rows.messages) {
      if (!ids.has(row.session_id)) continue;
      const order = messages.length;
      orders.set(row.id, order);
      const role = toRole(row.role);
      messages.push({
        id: row.id,
        sessionId: row.session_id,
        order,
        role,
        agent: row.agent,
        planMarker: role === "user" && row.plan_marker === 1,
      });
    }

    const indexes = new Map<string, number>();
    const delegations: AuditDelegation[] = [];
    for (const row of rows.delegations) {
      if (!ids.has(row.session_id)) continue;
      const index = indexes.get(row.message_id) ?? 0;
      indexes.set(row.message_id, index + 1);
      delegations.push({
        id: row.id,
        sessionId: row.session_id,
        messageId: row.message_id,
        index,
        target:
          row.target === null || row.target.trim() === "" ? null : row.target,
        status: toStatus(row.status),
        error: row.error,
      });
    }

    return {
      harness: this.harness,
      sessions,
      messages,
      delegations,
      excludedTmpSessions: inWindow.length - nonTmp.length,
    };
  }

  private run<T>(fn: () => T): Result<T, AuditError> {
    return Result.fromThrowable(
      fn,
      (cause): AuditError => ({
        type: "QueryError",
        harness: this.harness,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    )();
  }
}

/** OpenCode V1: `session`, `message`, `part`. */
export class OpenCodeV1SessionStore extends SqliteSessionStore {
  protected readonly harness = "opencode" as const;
  protected readonly requiredTables = ["session", "message", "part"];

  protected readonly sessionSql = `
    select s.id, s.parent_id, s.directory, p.worktree
    from session s left join project p on p.id = s.project_id
    where s.time_created >= ?1 and s.time_created < ?2`;

  protected readonly messageSql = `
    select m.id, m.session_id,
      json_extract(m.data, '$.role') as role,
      json_extract(m.data, '$.agent') as agent,
      exists (
        select 1 from part t
        where t.message_id = m.id
          and json_extract(t.data, '$.type') = 'text'
          and (${markerClause("json_extract(t.data, '$.text')")})
      ) as plan_marker
    from message m join session s on s.id = m.session_id
    where s.time_created >= ?1 and s.time_created < ?2
    order by m.session_id, m.time_created, m.id`;

  protected readonly delegationSql = `
    select p.id, p.session_id, p.message_id,
      json_extract(p.data, '$.state.input.subagent_type') as target,
      json_extract(p.data, '$.state.status') as status,
      json_extract(p.data, '$.state.error') as error
    from part p join session s on s.id = p.session_id
    where s.time_created >= ?1 and s.time_created < ?2
      and json_extract(p.data, '$.type') = 'tool'
      and json_extract(p.data, '$.tool') = 'task'
    order by p.message_id, p.id`;
}

/** OpenCode V2 (`@opencode/cli`): `session_v2`, `session_message`. */
export class OpenCodeV2SessionStore extends SqliteSessionStore {
  protected readonly harness = "opencode2" as const;
  protected readonly requiredTables = ["session_v2", "session_message"];

  protected readonly sessionSql = `
    select s.id, s.parent_id, s.directory, p.worktree
    from session_v2 s left join project p on p.id = s.project_id
    where s.time_created >= ?1 and s.time_created < ?2`;

  protected readonly messageSql = `
    select m.id, m.session_id,
      case m.type when 'synthetic' then 'user' else m.type end as role,
      json_extract(m.data, '$.agent') as agent,
      (m.type in ('user', 'synthetic')
        and (${markerClause("json_extract(m.data, '$.text')")})) as plan_marker
    from session_message m join session_v2 s on s.id = m.session_id
    where s.time_created >= ?1 and s.time_created < ?2
    order by m.session_id, m.seq`;

  protected readonly delegationSql = `
    select coalesce(json_extract(c.value, '$.id'), m.id || ':' || c.key) as id,
      m.session_id, m.id as message_id,
      coalesce(json_extract(c.value, '$.state.input.agent'),
        json_extract(c.value, '$.state.input.subagent_type')) as target,
      json_extract(c.value, '$.state.status') as status,
      nullif(trim(coalesce(json_extract(c.value, '$.state.error.type'), '')
        || ' ' || coalesce(json_extract(c.value, '$.state.error.message'), '')), '') as error
    from session_message m
      join session_v2 s on s.id = m.session_id,
      json_each(m.data, '$.content') c
    where s.time_created >= ?1 and s.time_created < ?2
      and m.type = 'assistant'
      and json_extract(c.value, '$.type') = 'tool'
      and json_extract(c.value, '$.name') = 'subagent'
    order by m.id, c.key`;
}

/** Builds the store reader for a harness over an open database. */
export function sessionStoreFor(harness: Harness, db: Database): SessionStore {
  if (harness === "opencode2") return new OpenCodeV2SessionStore(db);
  return new OpenCodeV1SessionStore(db);
}
