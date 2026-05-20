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

import type { Database } from "bun:sqlite";
import { err, ok, type Result } from "neverthrow";
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
export const CURRENT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Migration definition
// ---------------------------------------------------------------------------

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

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
];

// ---------------------------------------------------------------------------
// runMigrations
// ---------------------------------------------------------------------------

/**
 * Apply all pending migrations to the database.
 *
 * - Reads the current schema version from `runtime_metadata`.
 * - If the stored version > CURRENT_SCHEMA_VERSION, returns a
 *   `migration_version` error without mutating the DB.
 * - Applies all pending migrations in a single transaction.
 * - Updates `runtime_metadata.schema_version` and inserts rows into
 *   `schema_migrations` for each applied migration.
 *
 * This function is idempotent: calling it on an up-to-date DB is a no-op.
 */
export function runMigrations(db: Database): Result<void, RuntimeStoreError> {
  // Bootstrap: ensure runtime_metadata and schema_migrations tables exist
  // before we can read the current version. We do this outside a transaction
  // so the tables are visible for the version check.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_metadata (
        key   TEXT NOT NULL PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER NOT NULL PRIMARY KEY,
        applied_at TEXT    NOT NULL,
        name       TEXT    NOT NULL
      );
    `);
  } catch (cause) {
    return err(
      initializationError("Failed to bootstrap migration tables", cause),
    );
  }

  // Read current schema version
  let storedVersion = 0;
  try {
    const row = db
      .prepare(
        "SELECT value FROM runtime_metadata WHERE key = 'schema_version'",
      )
      .get() as { value: string } | null;
    if (row) {
      storedVersion = parseInt(row.value, 10);
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

  // Determine which migrations are pending
  const pending = MIGRATIONS.filter((m) => m.version > storedVersion);
  if (pending.length === 0) {
    return ok(undefined);
  }

  // Apply all pending migrations in a single transaction
  try {
    db.exec("BEGIN");
    try {
      for (const migration of pending) {
        db.exec(migration.sql);
        db.prepare(
          "INSERT OR REPLACE INTO schema_migrations (version, applied_at, name) VALUES (?, ?, ?)",
        ).run(migration.version, new Date().toISOString(), migration.name);
      }

      const newVersion = pending[pending.length - 1].version;
      db.prepare(
        "INSERT OR REPLACE INTO runtime_metadata (key, value) VALUES ('schema_version', ?)",
      ).run(String(newVersion));

      db.exec("COMMIT");
    } catch (cause) {
      db.exec("ROLLBACK");
      return err(initializationError("Migration transaction failed", cause));
    }
  } catch (cause) {
    return err(initializationError("Failed to apply migrations", cause));
  }

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
    return row ? parseInt(row.value, 10) : 0;
  } catch {
    return 0;
  }
}
