/**
 * Code-owned, idempotent, transactional migrations for the Weave Runtime Store.
 *
 * Migrations are defined as an ordered array of `Migration` objects.
 * Each migration has a version number, a name, and a SQL string to execute.
 *
 * On first open, all pending migrations are applied in a single transaction.
 * On subsequent opens, only new migrations are applied.
 *
 * If the stored schema version is greater than the highest known migration
 * version, a typed `migration_version` error is returned — the DB is not
 * mutated.
 *
 * @internal
 */

import type { Database, SQLQueryBindings } from "bun:sqlite";
import { err, ok, Result } from "neverthrow";
import {
  initializationError,
  migrationVersionError,
  type RuntimeStoreError,
} from "../errors.js";

// ---------------------------------------------------------------------------
// Current schema version
// ---------------------------------------------------------------------------

/**
 * The highest schema version this Weave build supports.
 * Increment this when adding a new migration.
 */
export const CURRENT_SCHEMA_VERSION = 5;

// ---------------------------------------------------------------------------
// Migration definition
// ---------------------------------------------------------------------------

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  /**
   * `true` when this migration's SQL recreates a table involved in a
   * foreign key relationship (SQLite has no `ALTER TABLE` support for
   * changing column nullability or a FK's `ON DELETE` action). Foreign key
   * enforcement is disabled for the whole pending-migration transaction
   * when any pending migration sets this flag, and restored immediately
   * after the transaction settles (commit or rollback).
   */
  readonly foreignKeysOff?: boolean;
}

// ---------------------------------------------------------------------------
// Permission grants schema contract (migration v3)
// ---------------------------------------------------------------------------

const RUNTIME_METADATA_TABLE = "runtime_metadata";
const SCHEMA_MIGRATIONS_TABLE = "schema_migrations";
const PERMISSION_GRANTS_TABLE = "permission_grants";
const PERMISSION_GRANTS_STATE_EXPIRY_INDEX =
  "idx_permission_grants_project_state_expiry";

interface ExpectedColumn {
  readonly name: string;
  readonly type: string;
  readonly notnull: 0 | 1;
  readonly dflt_value: null;
  readonly pk: 0 | 1;
}

const RUNTIME_METADATA_COLUMNS: readonly ExpectedColumn[] = [
  {
    name: "key",
    type: "TEXT",
    notnull: 1,
    dflt_value: null,
    pk: 1,
  },
  {
    name: "value",
    type: "TEXT",
    notnull: 1,
    dflt_value: null,
    pk: 0,
  },
];

const SCHEMA_MIGRATIONS_COLUMNS: readonly ExpectedColumn[] = [
  {
    name: "version",
    type: "INTEGER",
    notnull: 1,
    dflt_value: null,
    pk: 1,
  },
  {
    name: "applied_at",
    type: "TEXT",
    notnull: 1,
    dflt_value: null,
    pk: 0,
  },
  {
    name: "name",
    type: "TEXT",
    notnull: 1,
    dflt_value: null,
    pk: 0,
  },
];

const BOOTSTRAP_TABLES_SQL = `
  CREATE TABLE runtime_metadata (
    key   TEXT NOT NULL PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE schema_migrations (
    version    INTEGER NOT NULL PRIMARY KEY,
    applied_at TEXT    NOT NULL,
    name       TEXT    NOT NULL
  );
`;

const PERMISSION_GRANT_COLUMNS: readonly ExpectedColumn[] = [
  {
    name: "grant_id",
    type: "TEXT",
    notnull: 1,
    dflt_value: null,
    pk: 1,
  },
  {
    name: "project_identity",
    type: "TEXT",
    notnull: 1,
    dflt_value: null,
    pk: 0,
  },
  {
    name: "agent_name",
    type: "TEXT",
    notnull: 1,
    dflt_value: null,
    pk: 0,
  },
  {
    name: "registration_owner",
    type: "TEXT",
    notnull: 1,
    dflt_value: null,
    pk: 0,
  },
  {
    name: "tool_identity",
    type: "TEXT",
    notnull: 1,
    dflt_value: null,
    pk: 0,
  },
  {
    name: "registration_revision",
    type: "TEXT",
    notnull: 1,
    dflt_value: null,
    pk: 0,
  },
  {
    name: "policy_fingerprint",
    type: "TEXT",
    notnull: 1,
    dflt_value: null,
    pk: 0,
  },
  {
    name: "request_schema_version",
    type: "TEXT",
    notnull: 1,
    dflt_value: null,
    pk: 0,
  },
  {
    name: "request_digest",
    type: "TEXT",
    notnull: 1,
    dflt_value: null,
    pk: 0,
  },
  {
    name: "display_summary",
    type: "TEXT",
    notnull: 1,
    dflt_value: null,
    pk: 0,
  },
  {
    name: "display_details",
    type: "TEXT",
    notnull: 0,
    dflt_value: null,
    pk: 0,
  },
  {
    name: "created_at",
    type: "INTEGER",
    notnull: 1,
    dflt_value: null,
    pk: 0,
  },
  {
    name: "expires_at",
    type: "INTEGER",
    notnull: 0,
    dflt_value: null,
    pk: 0,
  },
  {
    name: "revoked_at",
    type: "INTEGER",
    notnull: 0,
    dflt_value: null,
    pk: 0,
  },
  {
    name: "state",
    type: "TEXT",
    notnull: 1,
    dflt_value: null,
    pk: 0,
  },
];

const PERMISSION_GRANT_ENVELOPE_COLUMNS = [
  "project_identity",
  "agent_name",
  "registration_owner",
  "tool_identity",
  "registration_revision",
  "policy_fingerprint",
  "request_schema_version",
  "request_digest",
] as const;

const PERMISSION_GRANT_STATE_EXPIRY_COLUMNS = [
  "project_identity",
  "state",
  "expires_at",
] as const;

const PERMISSION_GRANTS_MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS permission_grants (
    grant_id TEXT NOT NULL PRIMARY KEY,
    project_identity TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    registration_owner TEXT NOT NULL,
    tool_identity TEXT NOT NULL,
    registration_revision TEXT NOT NULL,
    policy_fingerprint TEXT NOT NULL,
    request_schema_version TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    display_summary TEXT NOT NULL,
    display_details TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER,
    state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
    CHECK (expires_at IS NULL OR expires_at > created_at),
    CHECK (
      (state = 'active' AND revoked_at IS NULL)
      OR (
        state = 'revoked'
        AND revoked_at IS NOT NULL
        AND revoked_at >= created_at
      )
    ),
    UNIQUE (
      project_identity,
      agent_name,
      registration_owner,
      tool_identity,
      registration_revision,
      policy_fingerprint,
      request_schema_version,
      request_digest
    )
  );
  CREATE INDEX IF NOT EXISTS idx_permission_grants_project_state_expiry
    ON permission_grants (project_identity, state, expires_at);
`;

// ---------------------------------------------------------------------------
// Migration list
// ---------------------------------------------------------------------------

/**
 * All code-owned migrations in ascending version order.
 *
 * Each migration is idempotent when applied in sequence.
 * Never remove or reorder existing migrations — only append new ones.
 */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    sql: `
      -- Runtime metadata (schema version, project salt)
      CREATE TABLE IF NOT EXISTS runtime_metadata (
        key   TEXT NOT NULL PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Schema migrations tracking
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER NOT NULL PRIMARY KEY,
        applied_at TEXT    NOT NULL,
        name       TEXT    NOT NULL
      );

      -- Workflow instances
      CREATE TABLE IF NOT EXISTS workflow_instances (
        id                TEXT NOT NULL PRIMARY KEY,
        workflow_name     TEXT NOT NULL,
        goal              TEXT NOT NULL,
        slug              TEXT NOT NULL,
        status            TEXT NOT NULL,
        current_step_name TEXT,
        artifacts_json    TEXT NOT NULL DEFAULT '[]',
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        completed_at      TEXT,
        error_message     TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_workflow_instances_status
        ON workflow_instances (status);

      CREATE INDEX IF NOT EXISTS idx_workflow_instances_created_at
        ON workflow_instances (created_at);

      -- Execution leases
      CREATE TABLE IF NOT EXISTS execution_leases (
        id                    TEXT NOT NULL PRIMARY KEY,
        workflow_instance_id  TEXT NOT NULL,
        owner_id              TEXT NOT NULL,
        acquired_at           TEXT NOT NULL,
        expires_at            TEXT NOT NULL,
        last_heartbeat_at     TEXT,
        FOREIGN KEY (workflow_instance_id) REFERENCES workflow_instances (id)
      );

      CREATE INDEX IF NOT EXISTS idx_execution_leases_expires_at
        ON execution_leases (expires_at);

      CREATE INDEX IF NOT EXISTS idx_execution_leases_workflow_instance_id
        ON execution_leases (workflow_instance_id);

      -- Session snapshots
      CREATE TABLE IF NOT EXISTS session_snapshots (
        id                    TEXT NOT NULL PRIMARY KEY,
        workflow_instance_id  TEXT NOT NULL,
        lease_id              TEXT NOT NULL,
        harness_name          TEXT NOT NULL,
        harness_version       TEXT,
        agent_name            TEXT NOT NULL,
        model_id              TEXT,
        step_name             TEXT,
        session_status        TEXT NOT NULL,
        recorded_at           TEXT NOT NULL,
        metadata_json         TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (workflow_instance_id) REFERENCES workflow_instances (id),
        FOREIGN KEY (lease_id)             REFERENCES execution_leases (id)
      );

      CREATE INDEX IF NOT EXISTS idx_session_snapshots_workflow_instance_id
        ON session_snapshots (workflow_instance_id);

      CREATE INDEX IF NOT EXISTS idx_session_snapshots_recorded_at
        ON session_snapshots (recorded_at);

      -- Runtime journal entries
      CREATE TABLE IF NOT EXISTS runtime_journal_entries (
        id                    TEXT NOT NULL PRIMARY KEY,
        timestamp             TEXT NOT NULL,
        source_kind           TEXT NOT NULL,
        source_name           TEXT NOT NULL,
        event_type            TEXT NOT NULL,
        execution_id          TEXT,
        workflow_instance_id  TEXT,
        step_id               TEXT,
        severity              TEXT NOT NULL,
        data_json             TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_journal_entries_timestamp
        ON runtime_journal_entries (timestamp);

      CREATE INDEX IF NOT EXISTS idx_journal_entries_workflow_instance_id
        ON runtime_journal_entries (workflow_instance_id);

      CREATE INDEX IF NOT EXISTS idx_journal_entries_execution_id
        ON runtime_journal_entries (execution_id);

      CREATE INDEX IF NOT EXISTS idx_journal_entries_source_kind
        ON runtime_journal_entries (source_kind);

      CREATE INDEX IF NOT EXISTS idx_journal_entries_source_name
        ON runtime_journal_entries (source_name);

      CREATE INDEX IF NOT EXISTS idx_journal_entries_event_type
        ON runtime_journal_entries (event_type);

      CREATE INDEX IF NOT EXISTS idx_journal_entries_severity
        ON runtime_journal_entries (severity);
    `,
  },
  {
    version: 2,
    name: "add_step_attempts_json",
    sql: `
      -- Add step_attempts_json column to workflow_instances.
      -- Stores JSON-serialized StepAttemptRecord[] for consumed-revision tracking.
      -- Default '[]' ensures backward compatibility with existing rows.
      ALTER TABLE workflow_instances
        ADD COLUMN step_attempts_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 3,
    name: "permission_grants",
    sql: PERMISSION_GRANTS_MIGRATION_SQL,
  },
  {
    version: 4,
    name: "usage_observations_and_rollups",
    sql: `
      CREATE TABLE IF NOT EXISTS usage_observations (
        id TEXT PRIMARY KEY NOT NULL,
        timestamp TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_name TEXT NOT NULL,
        workflow_instance_id TEXT,
        step_id TEXT,
        agent_name TEXT,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        total_tokens INTEGER,
        cost REAL,
        normalized_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_usage_observations_timestamp
        ON usage_observations (timestamp);

      CREATE INDEX IF NOT EXISTS idx_usage_observations_workflow_instance_id
        ON usage_observations (workflow_instance_id);

      CREATE INDEX IF NOT EXISTS idx_usage_observations_source
        ON usage_observations (source_kind, source_name);

      CREATE TABLE IF NOT EXISTS usage_rollups (
        rollup_key TEXT PRIMARY KEY NOT NULL,
        source_kind TEXT NOT NULL,
        source_name TEXT NOT NULL,
        workflow_instance_id TEXT,
        step_id TEXT,
        agent_name TEXT,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        total_tokens INTEGER,
        cost REAL,
        observation_count INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_usage_rollups_workflow_instance_id
        ON usage_rollups (workflow_instance_id);

      CREATE INDEX IF NOT EXISTS idx_usage_rollups_source
        ON usage_rollups (source_kind, source_name);
    `,
  },
  {
    version: 5,
    name: "session_snapshots_lease_set_null",
    // SQLite cannot ALTER a column's nullability or a foreign key's
    // ON DELETE action in place, so the table is recreated: a completed
    // WorkflowInstance's terminal lease release must be able to delete the
    // ExecutionLease row without losing the historical SessionSnapshot rows
    // that observed it. NOT NULL + (implicit) ON DELETE NO ACTION on
    // `lease_id` made every such release fail with a foreign key constraint
    // violation (#21 Task 12). `lease_id` becomes nullable with
    // ON DELETE SET NULL: the lease link is severed, the observation
    // survives.
    foreignKeysOff: true,
    sql: `
      CREATE TABLE session_snapshots_v5 (
        id                    TEXT NOT NULL PRIMARY KEY,
        workflow_instance_id  TEXT NOT NULL,
        lease_id              TEXT,
        harness_name          TEXT NOT NULL,
        harness_version       TEXT,
        agent_name            TEXT NOT NULL,
        model_id              TEXT,
        step_name             TEXT,
        session_status        TEXT NOT NULL,
        recorded_at           TEXT NOT NULL,
        metadata_json         TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (workflow_instance_id) REFERENCES workflow_instances (id),
        FOREIGN KEY (lease_id)             REFERENCES execution_leases (id) ON DELETE SET NULL
      );

      INSERT INTO session_snapshots_v5 (
        id, workflow_instance_id, lease_id, harness_name, harness_version,
        agent_name, model_id, step_name, session_status, recorded_at,
        metadata_json
      )
      SELECT
        id, workflow_instance_id, lease_id, harness_name, harness_version,
        agent_name, model_id, step_name, session_status, recorded_at,
        metadata_json
      FROM session_snapshots;

      DROP TABLE session_snapshots;

      ALTER TABLE session_snapshots_v5 RENAME TO session_snapshots;

      CREATE INDEX IF NOT EXISTS idx_session_snapshots_workflow_instance_id
        ON session_snapshots (workflow_instance_id);

      CREATE INDEX IF NOT EXISTS idx_session_snapshots_recorded_at
        ON session_snapshots (recorded_at);
    `,
  },
];

// ---------------------------------------------------------------------------
// Migration validation and metadata parsing
// ---------------------------------------------------------------------------

function validateMigrationDefinitions(): Result<void, RuntimeStoreError> {
  let previousVersion = 0;
  for (const migration of MIGRATIONS) {
    if (
      !Number.isSafeInteger(migration.version) ||
      migration.version <= previousVersion
    ) {
      return err(initializationError("Invalid migration definitions"));
    }
    previousVersion = migration.version;
  }
  return ok(undefined);
}

function parseSchemaVersion(value: unknown): Result<number, RuntimeStoreError> {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    return err(
      initializationError("Invalid schema_version in runtime_metadata"),
    );
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return err(
      initializationError("Invalid schema_version in runtime_metadata"),
    );
  }
  return ok(parsed);
}

interface AppliedMigrationRow {
  readonly version: number;
  readonly name: string;
}

function validateAppliedMigrations(
  rows: readonly AppliedMigrationRow[],
  storedVersion: number,
): Result<void, RuntimeStoreError> {
  let previousVersion = 0;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.version) || row.version <= previousVersion) {
      return err(initializationError("Invalid schema_migrations ledger"));
    }
    if (typeof row.name !== "string" || row.name.length === 0) {
      return err(initializationError("Invalid schema_migrations ledger"));
    }
    previousVersion = row.version;
  }

  const expected = MIGRATIONS.filter(
    (migration) => migration.version <= storedVersion,
  );
  if (rows.length !== expected.length) {
    return err(initializationError("Invalid schema_migrations ledger"));
  }

  for (let index = 0; index < expected.length; index += 1) {
    if (
      rows[index].version !== expected[index].version ||
      rows[index].name !== expected[index].name
    ) {
      return err(initializationError("Invalid schema_migrations ledger"));
    }
  }
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// permission_grants schema verification
// ---------------------------------------------------------------------------

interface TableInfoRow {
  readonly cid: number;
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | number | null;
  readonly pk: number;
}

interface IndexListRow {
  readonly seq: number;
  readonly name: string;
  readonly unique: number;
  readonly origin: string;
  readonly partial: number;
}

interface IndexInfoRow {
  readonly seqno: number;
  readonly cid: number;
  readonly name: string | null;
}

interface IndexXInfoRow {
  readonly seqno: number;
  readonly cid: number;
  readonly name: string | null;
  readonly desc: number;
  readonly coll: string;
  readonly key: number;
}

interface SchemaObjectRow {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
}

/** SQLite autoindex name shape; suffix numbering is not stable across versions. */
const SQLITE_AUTOINDEX_NAME = /^sqlite_autoindex_permission_grants_[1-9]\d*$/;
const RUNTIME_METADATA_AUTOINDEX_NAME =
  /^sqlite_autoindex_runtime_metadata_[1-9]\d*$/;

function normalizeType(type: string): string {
  return type.trim().toUpperCase();
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function readRelationType(
  db: Database,
  tableName: string,
): Result<"table" | "view" | null, unknown> {
  return Result.fromThrowable(
    () => {
      const row = db
        .prepare(
          "SELECT type FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')",
        )
        .get(tableName) as { type: string } | null;
      if (row === null) return null;
      if (row.type === "table" || row.type === "view") return row.type;
      return null;
    },
    (cause) => cause,
  )();
}

function readTableInfo(
  db: Database,
  tableName: string,
): Result<readonly TableInfoRow[], unknown> {
  return Result.fromThrowable(
    () =>
      db
        .prepare(`PRAGMA table_info(${quoteIdent(tableName)})`)
        .all() as TableInfoRow[],
    (cause) => cause,
  )();
}

function readIndexList(
  db: Database,
  tableName: string,
): Result<readonly IndexListRow[], unknown> {
  return Result.fromThrowable(
    () =>
      db
        .prepare(`PRAGMA index_list(${quoteIdent(tableName)})`)
        .all() as IndexListRow[],
    (cause) => cause,
  )();
}

/**
 * Live sqlite_schema/sqlite_master inventory for one relation.
 * Includes table, indexes, and triggers whose tbl_name matches.
 */
function readSchemaObjectsForTable(
  db: Database,
  tableName: string,
): Result<readonly SchemaObjectRow[], unknown> {
  return Result.fromThrowable(
    () =>
      db
        .prepare(
          `SELECT type, name, tbl_name, sql
           FROM sqlite_master
           WHERE tbl_name = ?
           ORDER BY type, name`,
        )
        .all(tableName) as SchemaObjectRow[],
    (cause) => cause,
  )();
}

function indexColumnNames(db: Database, indexName: string): readonly string[] {
  const rows = db
    .prepare(`PRAGMA index_info(${quoteIdent(indexName)})`)
    .all() as IndexInfoRow[];
  return rows
    .slice()
    .sort((left, right) => left.seqno - right.seqno)
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string");
}

function indexColumnsMatch(
  db: Database,
  indexName: string,
  expected: readonly string[],
): boolean {
  const columns = indexColumnNames(db, indexName);
  if (columns.length !== expected.length) return false;
  return columns.every(
    (column, columnIndex) => column === expected[columnIndex],
  );
}

/**
 * Every indexed key column must use BINARY collation. NOCASE/RTRIM/custom
 * collations make SQLite equality match grant identity envelopes that exact
 * JavaScript comparison would reject.
 */
function indexKeyCollationsAreBinary(db: Database, indexName: string): boolean {
  const rows = Result.fromThrowable(
    () =>
      db
        .prepare(`PRAGMA index_xinfo(${quoteIdent(indexName)})`)
        .all() as IndexXInfoRow[],
    (cause) => cause,
  )();
  if (rows.isErr()) return false;
  for (const row of rows.value) {
    // key=1 marks indexed columns; key=0 is the trailing rowid/payload slot.
    if (row.key !== 1) continue;
    if (typeof row.coll !== "string" || row.coll !== "BINARY") return false;
  }
  return true;
}

/**
 * Fail closed when CREATE SQL declares any non-BINARY collation.
 * BINARY is the SQLite default; explicit `COLLATE BINARY` is allowed.
 * Autoindex rows have null sql and are covered by `PRAGMA index_xinfo`.
 */
function sqlDeclaresOnlyBinaryCollations(sql: string | null): boolean {
  if (typeof sql !== "string" || sql.length === 0) return false;
  const pattern =
    /\bCOLLATE\s+("([^"]*)"|`([^`]*)`|\[([^\]]*)\]|([A-Za-z_][A-Za-z0-9_]*))/gi;
  let match: RegExpExecArray | null = pattern.exec(sql);
  while (match !== null) {
    const name = match[2] ?? match[3] ?? match[4] ?? match[5] ?? "";
    if (name.toUpperCase() !== "BINARY") return false;
    match = pattern.exec(sql);
  }
  return true;
}

/**
 * Reject every trigger in the code-owned database. Per-table inventory checks
 * only see triggers whose `tbl_name` matches; a trigger on e.g.
 * `workflow_instances` can still mutate `runtime_metadata` high-water or
 * rewrite grants and resurrect an expired durable grant after reopen.
 */
function verifyNoDatabaseTriggers(
  db: Database,
): Result<void, RuntimeStoreError> {
  const failure = err(initializationError("Invalid runtime store schema"));
  const read = Result.fromThrowable(
    () =>
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' LIMIT 1",
        )
        .get() as { name: string } | null,
    (cause) => cause,
  )();
  if (read.isErr()) {
    return err(initializationError("Invalid runtime store schema", read.error));
  }
  if (read.value !== null) return failure;
  return ok(undefined);
}

/**
 * Require BINARY collation on every permission identity/index key column via
 * `PRAGMA index_xinfo` plus CREATE SQL structural checks for table/index DDL.
 */
function verifyPermissionGrantsCollations(
  db: Database,
  indexes: readonly IndexListRow[],
): boolean {
  const objects = readSchemaObjectsForTable(db, PERMISSION_GRANTS_TABLE);
  if (objects.isErr()) return false;

  let sawTable = false;
  for (const object of objects.value) {
    if (object.type === "table") {
      // Table DDL must exist and must not declare non-BINARY collations on any
      // column (identity keys included).
      if (!sqlDeclaresOnlyBinaryCollations(object.sql)) return false;
      sawTable = true;
      continue;
    }
    if (object.type === "index") {
      // Named index DDL is checked when present; autoindexes have null sql.
      if (object.sql !== null && !sqlDeclaresOnlyBinaryCollations(object.sql)) {
        return false;
      }
    }
  }
  if (!sawTable) return false;

  for (const index of indexes) {
    if (!indexKeyCollationsAreBinary(db, index.name)) return false;
  }
  return true;
}

function isNonPartialUnique(index: IndexListRow, origin: "pk" | "u"): boolean {
  return index.origin === origin && index.unique === 1 && index.partial === 0;
}

/**
 * Exact permission_grants index allowlist:
 * - one SQLite PK autoindex on grant_id (origin pk)
 * - one full-envelope UNIQUE autoindex (origin u)
 * - the named non-unique lookup index (origin c)
 *
 * Autoindex *names* are accepted only when they match SQLite's
 * `sqlite_autoindex_<table>_<n>` pattern; the numeric suffix is not pinned
 * because assignment order is not a stable cross-version contract. Any extra
 * unique, partial, expression, or otherwise unexpected index fails closed.
 */
function verifyPermissionGrantsIndexAllowlist(
  db: Database,
  indexes: readonly IndexListRow[],
): boolean {
  if (indexes.length !== 3) return false;

  const remaining = indexes.slice();
  const take = (
    predicate: (index: IndexListRow) => boolean,
  ): IndexListRow | undefined => {
    const foundAt = remaining.findIndex(predicate);
    if (foundAt < 0) return undefined;
    const [found] = remaining.splice(foundAt, 1);
    return found;
  };

  const pk = take(
    (index) =>
      isNonPartialUnique(index, "pk") &&
      SQLITE_AUTOINDEX_NAME.test(index.name) &&
      indexColumnsMatch(db, index.name, ["grant_id"]),
  );
  if (pk === undefined) return false;

  const envelope = take(
    (index) =>
      isNonPartialUnique(index, "u") &&
      SQLITE_AUTOINDEX_NAME.test(index.name) &&
      indexColumnsMatch(db, index.name, PERMISSION_GRANT_ENVELOPE_COLUMNS),
  );
  if (envelope === undefined) return false;

  const lookup = take(
    (index) =>
      index.name === PERMISSION_GRANTS_STATE_EXPIRY_INDEX &&
      index.origin === "c" &&
      index.unique === 0 &&
      index.partial === 0 &&
      indexColumnsMatch(db, index.name, PERMISSION_GRANT_STATE_EXPIRY_COLUMNS),
  );
  if (lookup === undefined) return false;

  return remaining.length === 0;
}

/**
 * Exact sqlite_schema inventory for permission_grants: the table row, the three
 * allowlisted indexes, and zero triggers (or any other object type).
 */
function verifyPermissionGrantsSchemaInventory(
  db: Database,
  indexes: readonly IndexListRow[],
): boolean {
  const objects = readSchemaObjectsForTable(db, PERMISSION_GRANTS_TABLE);
  if (objects.isErr()) return false;

  let tableCount = 0;
  let indexCount = 0;
  for (const object of objects.value) {
    if (object.type === "table") {
      if (object.name !== PERMISSION_GRANTS_TABLE) return false;
      tableCount += 1;
      continue;
    }
    if (object.type === "index") {
      indexCount += 1;
      continue;
    }
    // Reject every trigger and any unexpected object type (view, etc.).
    return false;
  }

  if (tableCount !== 1) return false;
  if (indexCount !== indexes.length) return false;
  return verifyPermissionGrantsIndexAllowlist(db, indexes);
}

function columnsMatchExpected(
  columns: readonly TableInfoRow[],
  expected: readonly ExpectedColumn[],
): boolean {
  if (columns.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    const want = expected[index];
    const actual = columns[index];
    if (actual.name !== want.name) return false;
    if (normalizeType(actual.type) !== want.type) return false;
    if (actual.notnull !== want.notnull) return false;
    if (actual.pk !== want.pk) return false;
    if (actual.dflt_value !== want.dflt_value) return false;
  }
  return true;
}

function hasIntegerPrimaryKey(
  columns: readonly TableInfoRow[],
  columnName: string,
): boolean {
  const column = columns.find((entry) => entry.name === columnName);
  if (column === undefined) return false;
  return (
    column.pk === 1 &&
    normalizeType(column.type) === "INTEGER" &&
    column.notnull === 1
  );
}

/**
 * Exact sqlite_schema inventory for one relation: one table row, the expected
 * index count/allowlist, and zero triggers (or any other object type).
 */
function verifyExactRelationInventory(
  db: Database,
  tableName: string,
  indexes: readonly IndexListRow[],
  indexAllowlistOk: boolean,
): boolean {
  if (!indexAllowlistOk) return false;

  const objects = readSchemaObjectsForTable(db, tableName);
  if (objects.isErr()) return false;

  let tableCount = 0;
  let indexCount = 0;
  for (const object of objects.value) {
    if (object.type === "table") {
      if (object.name !== tableName) return false;
      tableCount += 1;
      continue;
    }
    if (object.type === "index") {
      indexCount += 1;
      continue;
    }
    // Reject every trigger and any unexpected object type (view, etc.).
    return false;
  }

  if (tableCount !== 1) return false;
  return indexCount === indexes.length;
}

function verifyRuntimeMetadataIndexAllowlist(
  db: Database,
  indexes: readonly IndexListRow[],
): boolean {
  if (indexes.length !== 1) return false;
  const index = indexes[0];
  return (
    isNonPartialUnique(index, "pk") &&
    RUNTIME_METADATA_AUTOINDEX_NAME.test(index.name) &&
    indexColumnsMatch(db, index.name, ["key"])
  );
}

function verifySchemaMigrationsIndexAllowlist(
  indexes: readonly IndexListRow[],
): boolean {
  // INTEGER PRIMARY KEY is a rowid alias — SQLite exposes no separate pk index.
  return indexes.length === 0;
}

/**
 * Verify bootstrap `runtime_metadata` / `schema_migrations` match the canonical
 * physical contract, including an exact sqlite_schema inventory (zero
 * triggers/views; only expected PK/index semantics). Hostile triggers that
 * reset `permission_wall_clock_high_water` or rewrite the ledger fail here
 * before contents are trusted. Does not create, alter, or drop relations.
 */
function verifyBootstrapSchemas(db: Database): Result<void, RuntimeStoreError> {
  const failure = err(
    initializationError("Invalid migration bootstrap schema"),
  );

  const metadataRelation = readRelationType(db, RUNTIME_METADATA_TABLE);
  if (metadataRelation.isErr() || metadataRelation.value !== "table")
    return failure;
  const metadataColumns = readTableInfo(db, RUNTIME_METADATA_TABLE);
  if (metadataColumns.isErr()) return failure;
  if (!columnsMatchExpected(metadataColumns.value, RUNTIME_METADATA_COLUMNS))
    return failure;
  const metadataIndexes = readIndexList(db, RUNTIME_METADATA_TABLE);
  if (metadataIndexes.isErr()) return failure;
  if (
    !verifyExactRelationInventory(
      db,
      RUNTIME_METADATA_TABLE,
      metadataIndexes.value,
      verifyRuntimeMetadataIndexAllowlist(db, metadataIndexes.value),
    )
  ) {
    return failure;
  }

  const migrationsRelation = readRelationType(db, SCHEMA_MIGRATIONS_TABLE);
  if (migrationsRelation.isErr() || migrationsRelation.value !== "table")
    return failure;
  const migrationsColumns = readTableInfo(db, SCHEMA_MIGRATIONS_TABLE);
  if (migrationsColumns.isErr()) return failure;
  if (
    !columnsMatchExpected(migrationsColumns.value, SCHEMA_MIGRATIONS_COLUMNS)
  ) {
    return failure;
  }
  if (!hasIntegerPrimaryKey(migrationsColumns.value, "version")) return failure;
  const migrationsIndexes = readIndexList(db, SCHEMA_MIGRATIONS_TABLE);
  if (migrationsIndexes.isErr()) return failure;
  if (
    !verifyExactRelationInventory(
      db,
      SCHEMA_MIGRATIONS_TABLE,
      migrationsIndexes.value,
      verifySchemaMigrationsIndexAllowlist(migrationsIndexes.value),
    )
  ) {
    return failure;
  }

  return ok(undefined);
}

/**
 * Ensure bootstrap tables exist with the canonical physical schema.
 *
 * Fresh empty databases create both tables. Pre-existing relations are never
 * repaired: malformed or partial bootstrap state fails generically and remains
 * unmodified. Tables created by this call are distinguished from pre-existing
 * ones so CREATE cannot mask a bad historical shape.
 */
function ensureBootstrapTables(db: Database): Result<void, RuntimeStoreError> {
  const failure = err(
    initializationError("Invalid migration bootstrap schema"),
  );

  const metadataRelation = readRelationType(db, RUNTIME_METADATA_TABLE);
  if (metadataRelation.isErr()) return failure;
  const migrationsRelation = readRelationType(db, SCHEMA_MIGRATIONS_TABLE);
  if (migrationsRelation.isErr()) return failure;

  const metadataExists = metadataRelation.value !== null;
  const migrationsExist = migrationsRelation.value !== null;

  if (metadataExists !== migrationsExist) return failure;
  if (metadataRelation.value === "view" || migrationsRelation.value === "view")
    return failure;

  if (!metadataExists && !migrationsExist) {
    const created = Result.fromThrowable(
      () => {
        db.exec(BOOTSTRAP_TABLES_SQL);
      },
      (cause) => cause,
    )();
    if (created.isErr()) {
      return err(
        initializationError(
          "Failed to bootstrap migration tables",
          created.error,
        ),
      );
    }
  }

  return verifyBootstrapSchemas(db);
}

function runAllows(
  statement: { run: (...params: SQLQueryBindings[]) => unknown },
  params: readonly SQLQueryBindings[],
): boolean {
  try {
    statement.run(...params);
    return true;
  } catch {
    return false;
  }
}

function runRejects(
  statement: { run: (...params: SQLQueryBindings[]) => unknown },
  params: readonly SQLQueryBindings[],
): boolean {
  return !runAllows(statement, params);
}

/**
 * Verify the live `permission_grants` relation matches the migration-v3
 * contract. Enforces an exact sqlite_schema inventory (zero triggers; only the
 * PK autoindex, full-envelope UNIQUE autoindex, and named lookup index),
 * PRAGMA column/key metadata, and randomized behavioral probes for
 * CHECK/UNIQUE constraints so a pre-existing malformed or hostile relation
 * skipped by `CREATE TABLE IF NOT EXISTS` cannot be adopted.
 */
function verifyPermissionGrantsSchema(
  db: Database,
): Result<void, RuntimeStoreError> {
  const failure = err(initializationError("Invalid permission_grants schema"));

  const relation = readRelationType(db, PERMISSION_GRANTS_TABLE);
  if (relation.isErr() || relation.value !== "table") return failure;

  const columns = readTableInfo(db, PERMISSION_GRANTS_TABLE);
  if (columns.isErr()) return failure;
  if (!columnsMatchExpected(columns.value, PERMISSION_GRANT_COLUMNS))
    return failure;

  const indexes = readIndexList(db, PERMISSION_GRANTS_TABLE);
  if (indexes.isErr()) return failure;
  if (!verifyPermissionGrantsSchemaInventory(db, indexes.value)) return failure;
  if (!verifyPermissionGrantsCollations(db, indexes.value)) return failure;

  // Behavioral constraint probes stay inside a savepoint so verification never
  // leaves rows behind, even when nested in the migration transaction.
  // Probe IDs/digests are randomized so fixed-ID trigger bypasses cannot dodge
  // structural rejection; triggers themselves are already forbidden above.
  try {
    db.exec("SAVEPOINT weave_verify_permission_grants");
  } catch {
    return failure;
  }

  const probe = Result.fromThrowable(
    () => {
      const insert = db.prepare(`
        INSERT INTO permission_grants (
          grant_id, project_identity, agent_name, registration_owner,
          tool_identity, registration_revision, policy_fingerprint,
          request_schema_version, request_digest, display_summary,
          display_details, created_at, expires_at, revoked_at, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const probeTag = crypto.randomUUID().replaceAll("-", "");
      const probeId = (label: string): string => `__wpg_${probeTag}_${label}`;
      const probeDigest = (label: string): string => `d_${probeTag}_${label}`;

      const row = (
        grantId: string,
        digest: string,
        createdAt: number,
        expiresAt: number | null,
        revokedAt: number | null,
        state: string,
        identity: {
          project?: string;
          agent?: string;
          owner?: string;
          tool?: string;
          revision?: string;
          fingerprint?: string;
          schema?: string;
        } = {},
      ): SQLQueryBindings[] => [
        grantId,
        identity.project ?? "p",
        identity.agent ?? "a",
        identity.owner ?? "o",
        identity.tool ?? "t",
        identity.revision ?? "r",
        identity.fingerprint ?? "f",
        identity.schema ?? "s",
        digest,
        "summary",
        null,
        createdAt,
        expiresAt,
        revokedAt,
        state,
      ];

      const activeId = probeId("active");
      const activeDigest = probeDigest("active");

      if (
        !runAllows(
          insert,
          row(activeId, activeDigest, 10, null, null, "active"),
        )
      ) {
        throw new Error("active insert rejected");
      }
      if (
        !runAllows(
          insert,
          row(
            probeId("revoked"),
            probeDigest("revoked"),
            10,
            null,
            10,
            "revoked",
          ),
        )
      ) {
        throw new Error("revoked insert rejected");
      }
      if (
        !runAllows(
          insert,
          row(probeId("expiry"), probeDigest("expiry"), 10, 11, null, "active"),
        )
      ) {
        throw new Error("expiry insert rejected");
      }

      const rejected: SQLQueryBindings[][] = [
        row(
          probeId("bad_state"),
          probeDigest("bad_state"),
          10,
          null,
          null,
          "future",
        ),
        row(
          probeId("active_revoked"),
          probeDigest("active_revoked"),
          10,
          null,
          11,
          "active",
        ),
        row(
          probeId("revoked_null"),
          probeDigest("revoked_null"),
          10,
          null,
          null,
          "revoked",
        ),
        row(
          probeId("revoked_before"),
          probeDigest("revoked_before"),
          10,
          null,
          9,
          "revoked",
        ),
        row(
          probeId("expiry_eq"),
          probeDigest("expiry_eq"),
          10,
          10,
          null,
          "active",
        ),
        row(
          probeId("expiry_lt"),
          probeDigest("expiry_lt"),
          10,
          9,
          null,
          "active",
        ),
        // full envelope uniqueness against the randomized active digest
        row(probeId("dup_envelope"), activeDigest, 10, null, null, "active"),
        // primary key uniqueness against the randomized active grant_id
        row(activeId, probeDigest("dup_pk"), 10, null, null, "active", {
          project: "p2",
          agent: "a2",
          owner: "o2",
          tool: "t2",
          revision: "r2",
          fingerprint: "f2",
          schema: "s2",
        }),
      ];

      for (const params of rejected) {
        if (!runRejects(insert, params)) {
          throw new Error("required constraint missing");
        }
      }
    },
    (cause) => cause,
  )();

  const rollbackProbe = Result.fromThrowable(
    () => {
      db.exec("ROLLBACK TO weave_verify_permission_grants");
      db.exec("RELEASE weave_verify_permission_grants");
    },
    (cause) => cause,
  )();

  if (rollbackProbe.isErr()) return failure;
  if (probe.isErr()) return failure;
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// Foreign key enforcement toggle (migration v5 table recreation)
// ---------------------------------------------------------------------------

/**
 * Disable foreign key enforcement for this connection.
 *
 * Must be called with no pending transaction — SQLite silently no-ops a
 * `PRAGMA foreign_keys` write issued inside `BEGIN`/`COMMIT`. Callers must
 * invoke this before `BEGIN` and restore enforcement with
 * {@link enableForeignKeys} once the transaction settles.
 */
function disableForeignKeys(db: Database): Result<void, RuntimeStoreError> {
  return Result.fromThrowable(
    () => {
      db.exec("PRAGMA foreign_keys=OFF;");
    },
    (cause) =>
      initializationError(
        "Failed to disable foreign keys for migration",
        cause,
      ),
  )();
}

/** Restore foreign key enforcement disabled by {@link disableForeignKeys}. */
function enableForeignKeys(db: Database): Result<void, RuntimeStoreError> {
  return Result.fromThrowable(
    () => {
      db.exec("PRAGMA foreign_keys=ON;");
    },
    (cause) =>
      initializationError(
        "Failed to re-enable foreign keys after migration",
        cause,
      ),
  )();
}

/**
 * Run SQLite's built-in `PRAGMA foreign_key_check` and fail closed when it
 * reports any violation. Run after the migration v5 table recreation (with
 * enforcement still off) to prove the copy preserved every foreign key
 * relationship instead of trusting the recreation SQL alone.
 */
function verifyNoForeignKeyViolations(
  db: Database,
): Result<void, RuntimeStoreError> {
  const check = Result.fromThrowable(
    () => db.prepare("PRAGMA foreign_key_check;").all(),
    (cause) => cause,
  )();
  if (check.isErr()) {
    return err(
      initializationError(
        "Failed to verify foreign key integrity",
        check.error,
      ),
    );
  }
  if (check.value.length > 0) {
    return err(
      initializationError("Migration introduced a foreign key violation"),
    );
  }
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// runMigrations
// ---------------------------------------------------------------------------

/**
 * Apply all pending migrations to the database.
 *
 * - Verifies or creates canonical `runtime_metadata` / `schema_migrations`
 *   bootstrap tables before trusting their contents. Verification enforces an
 *   exact sqlite_schema inventory per bootstrap relation (zero triggers/views;
 *   only the expected PK/index semantics) so hostile metadata/ledger triggers
 *   cannot reset high-water or rewrite the migration ledger on open.
 * - Rejects **all** triggers anywhere in the code-owned database (not only on
 *   protected tables). Cross-table triggers on e.g. `workflow_instances` must
 *   not mutate high-water or grants after open.
 * - Reads the current schema version from `runtime_metadata`.
 * - If the stored version > CURRENT_SCHEMA_VERSION, returns a
 *   `migration_version` error without mutating the DB.
 * - Applies all pending migrations in a single transaction.
 * - Updates `runtime_metadata.schema_version` and inserts rows into
 *   `schema_migrations` for each applied migration.
 * - When the effective schema version is >= 3 (including no-pending reopen),
 *   re-verifies the live `permission_grants` relation (including BINARY
 *   collations on identity/index keys) before returning Ok.
 * - Migration v5 recreates `session_snapshots` with a nullable `lease_id`
 *   and `ON DELETE SET NULL` (SQLite cannot ALTER either in place). Foreign
 *   key enforcement is disabled for the whole pending-migration transaction
 *   while any pending migration requires it, and restored immediately after
 *   the transaction settles either way.
 *
 * This function is idempotent: calling it on a healthy up-to-date DB is a no-op
 * aside from live-schema verification. Dropped or altered v3 relations fail
 * closed and are not silently repaired.
 */
export function runMigrations(db: Database): Result<void, RuntimeStoreError> {
  const migrationDefinitions = validateMigrationDefinitions();
  if (migrationDefinitions.isErr()) return err(migrationDefinitions.error);

  // Bootstrap outside the migration transaction so version/ledger reads can
  // see the tables. Pre-existing malformed bootstrap relations fail closed
  // without repair; only a fully absent pair is created.
  const bootstrap = ensureBootstrapTables(db);
  if (bootstrap.isErr()) return err(bootstrap.error);

  // Reject every trigger in the database before trusting metadata, applying
  // migrations, or opening repositories. Cross-table triggers are not visible
  // to per-relation inventory checks.
  const noTriggers = verifyNoDatabaseTriggers(db);
  if (noTriggers.isErr()) return err(noTriggers.error);

  // Read current schema version
  let storedVersion = 0;
  try {
    const row = db
      .prepare(
        "SELECT value FROM runtime_metadata WHERE key = 'schema_version'",
      )
      .get() as { value: string } | null;
    if (row) {
      const parsed = parseSchemaVersion(row.value);
      if (parsed.isErr()) return err(parsed.error);
      storedVersion = parsed.value;
    }
  } catch (cause) {
    return err(initializationError("Failed to read schema version", cause));
  }

  // Fail if DB was created by a newer Weave version
  if (storedVersion > CURRENT_SCHEMA_VERSION) {
    return err(
      migrationVersionError(
        storedVersion,
        CURRENT_SCHEMA_VERSION,
        `Runtime store schema version ${storedVersion} is newer than this Weave build supports (${CURRENT_SCHEMA_VERSION}). Upgrade Weave to open this store.`,
      ),
    );
  }

  // Validate the applied-version ledger before selecting pending work.
  let applied: AppliedMigrationRow[];
  try {
    applied = db
      .prepare(
        "SELECT version, name FROM schema_migrations ORDER BY version ASC",
      )
      .all() as AppliedMigrationRow[];
  } catch (cause) {
    return err(initializationError("Failed to read schema migrations", cause));
  }
  const appliedValidation = validateAppliedMigrations(applied, storedVersion);
  if (appliedValidation.isErr()) return err(appliedValidation.error);

  // Determine pending work in deterministic version order.
  const pending = MIGRATIONS.filter((m) => m.version > storedVersion).sort(
    (left, right) => left.version - right.version,
  );

  if (pending.length === 0) {
    // Healthy reopen still proves the live v3 contract. A table/index dropped
    // or weakened after initialization must not be claimed healthy.
    if (storedVersion >= 3) return verifyPermissionGrantsSchema(db);
    return ok(undefined);
  }

  // Migration v5 recreates `session_snapshots` to change `lease_id`'s
  // nullability and ON DELETE action — SQLite has no ALTER for either, so
  // enforcement must be off for the whole pending-migration transaction, not
  // just that one migration's statements.
  const needsForeignKeysOff = pending.some(
    (migration) => migration.foreignKeysOff === true,
  );
  if (needsForeignKeysOff) {
    const disabled = disableForeignKeys(db);
    if (disabled.isErr()) return err(disabled.error);
  }

  // Apply all pending migrations in a single transaction.
  try {
    db.exec("BEGIN");
    for (const migration of pending) {
      db.exec(migration.sql);
      if (migration.version === 3) {
        const verified = verifyPermissionGrantsSchema(db);
        if (verified.isErr()) {
          throw new Error(verified.error.message);
        }
      }
      if (migration.version === 5) {
        const verified = verifyNoForeignKeyViolations(db);
        if (verified.isErr()) {
          throw new Error(verified.error.message);
        }
      }
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at, name) VALUES (?, ?, ?)",
      ).run(migration.version, new Date().toISOString(), migration.name);
    }

    const newVersion = pending[pending.length - 1].version;
    db.prepare(
      "INSERT OR REPLACE INTO runtime_metadata (key, value) VALUES ('schema_version', ?)",
    ).run(String(newVersion));

    db.exec("COMMIT");
  } catch (cause) {
    const rollback = Result.fromThrowable(
      () => db.exec("ROLLBACK"),
      (rollbackCause) => rollbackCause,
    )();
    if (needsForeignKeysOff) enableForeignKeys(db);
    if (rollback.isErr()) {
      return err(
        initializationError("Migration transaction failed", rollback.error),
      );
    }
    return err(initializationError("Migration transaction failed", cause));
  }

  if (needsForeignKeysOff) {
    const enabled = enableForeignKeys(db);
    if (enabled.isErr()) return err(enabled.error);
  }

  // Post-commit: re-check triggers (a hostile migration body must not leave
  // any behind) and prove the live v3 contract when applicable.
  const noTriggersAfter = verifyNoDatabaseTriggers(db);
  if (noTriggersAfter.isErr()) return err(noTriggersAfter.error);

  const effectiveVersion = pending[pending.length - 1].version;
  if (effectiveVersion >= 3) return verifyPermissionGrantsSchema(db);
  return ok(undefined);
}

/**
 * Read the current schema version from the database.
 * Returns 0 if no version has been stored yet.
 */
export function readSchemaVersion(db: Database): number {
  try {
    const row = db
      .prepare(
        "SELECT value FROM runtime_metadata WHERE key = 'schema_version'",
      )
      .get() as { value: string } | null;
    if (!row) return 0;
    const parsed = parseSchemaVersion(row.value);
    return parsed.isOk() ? parsed.value : 0;
  } catch {
    return 0;
  }
}
