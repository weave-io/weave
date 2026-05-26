/**
 * SQLite table definitions and typed row shapes for the Weave Runtime Store.
 *
 * Each interface represents a single SQLite table row. The `WeaveDatabase`
 * type is the Kysely database schema used for type-safe query building.
 *
 * Column naming convention: snake_case to match SQLite conventions.
 * JSON columns store serialized JSON strings.
 *
 * @internal
 */

import type { Generated } from "kysely";

// ---------------------------------------------------------------------------
// workflow_instances
// ---------------------------------------------------------------------------

/**
 * Row shape for the `workflow_instances` table.
 */
export interface WorkflowInstanceRow {
  /** Primary key — UUID string. */
  readonly id: string;
  /** Name of the workflow definition. */
  readonly workflow_name: string;
  /** Human-readable goal. */
  readonly goal: string;
  /** URL-safe slug. */
  readonly slug: string;
  /** Lifecycle status. */
  readonly status: string;
  /** Current step name, or null. */
  readonly current_step_name: string | null;
  /** JSON-serialized ArtifactRef[]. */
  readonly artifacts_json: string;
  /** ISO 8601 creation timestamp. */
  readonly created_at: string;
  /** ISO 8601 last-update timestamp. */
  readonly updated_at: string;
  /** ISO 8601 completion timestamp, or null. */
  readonly completed_at: string | null;
  /** Error message if status is 'failed', or null. */
  readonly error_message: string | null;
}

// ---------------------------------------------------------------------------
// execution_leases
// ---------------------------------------------------------------------------

/**
 * Row shape for the `execution_leases` table.
 */
export interface ExecutionLeaseRow {
  /** Primary key — UUID string. */
  readonly id: string;
  /** FK → workflow_instances.id. */
  readonly workflow_instance_id: string;
  /** Weave-generated owner identifier. */
  readonly owner_id: string;
  /** ISO 8601 acquisition timestamp. */
  readonly acquired_at: string;
  /** ISO 8601 expiry timestamp. */
  readonly expires_at: string;
  /** ISO 8601 last heartbeat timestamp, or null. */
  readonly last_heartbeat_at: string | null;
}

// ---------------------------------------------------------------------------
// session_snapshots
// ---------------------------------------------------------------------------

/**
 * Row shape for the `session_snapshots` table.
 */
export interface SessionSnapshotRow {
  /** Primary key — UUID string. */
  readonly id: string;
  /** FK → workflow_instances.id. */
  readonly workflow_instance_id: string;
  /** FK → execution_leases.id. */
  readonly lease_id: string;
  /** Harness adapter name. */
  readonly harness_name: string;
  /** Harness adapter version, or null. */
  readonly harness_version: string | null;
  /** Agent name. */
  readonly agent_name: string;
  /** Model identifier, or null. */
  readonly model_id: string | null;
  /** Step name, or null. */
  readonly step_name: string | null;
  /** Session status. */
  readonly session_status: string;
  /** ISO 8601 recorded timestamp. */
  readonly recorded_at: string;
  /** JSON-serialized metadata Record<string, string | number | boolean>. */
  readonly metadata_json: string;
}

// ---------------------------------------------------------------------------
// runtime_journal_entries
// ---------------------------------------------------------------------------

/**
 * Row shape for the `runtime_journal_entries` table.
 */
export interface RuntimeJournalEntryRow {
  /** Primary key — UUID string. */
  readonly id: string;
  /** ISO 8601 timestamp. */
  readonly timestamp: string;
  /** Source kind: 'engine' | 'adapter'. Indexed. */
  readonly source_kind: string;
  /** Source name. Indexed. */
  readonly source_name: string;
  /** Logical event type. Indexed. */
  readonly event_type: string;
  /** FK → execution_leases.id, or null. Indexed. */
  readonly execution_id: string | null;
  /** FK → workflow_instances.id, or null. Indexed. */
  readonly workflow_instance_id: string | null;
  /** Step name, or null. */
  readonly step_id: string | null;
  /** Severity level. */
  readonly severity: string;
  /** JSON-serialized data payload. */
  readonly data_json: string;
}

// ---------------------------------------------------------------------------
// schema_migrations
// ---------------------------------------------------------------------------

/**
 * Row shape for the `schema_migrations` table.
 *
 * Tracks which migrations have been applied.
 */
interface SchemaMigrationRow {
  /** Migration version number (1-based). */
  readonly version: Generated<number>;
  /** ISO 8601 timestamp when this migration was applied. */
  readonly applied_at: string;
  /** Human-readable migration name. */
  readonly name: string;
}

// ---------------------------------------------------------------------------
// runtime_metadata
// ---------------------------------------------------------------------------

/**
 * Row shape for the `runtime_metadata` table.
 *
 * Stores singleton key-value metadata for the runtime store.
 * Keys include: `schema_version`, `project_salt`.
 */
interface RuntimeMetadataRow {
  /** Metadata key. */
  readonly key: string;
  /** Metadata value (string). */
  readonly value: string;
}

// ---------------------------------------------------------------------------
// WeaveDatabase — Kysely schema type
// ---------------------------------------------------------------------------

/**
 * Kysely database schema for the Weave Runtime Store.
 *
 * Used as the type parameter for `Kysely<WeaveDatabase>`.
 */
export interface WeaveDatabase {
  readonly workflow_instances: WorkflowInstanceRow;
  readonly execution_leases: ExecutionLeaseRow;
  readonly session_snapshots: SessionSnapshotRow;
  readonly runtime_journal_entries: RuntimeJournalEntryRow;
  readonly schema_migrations: SchemaMigrationRow;
  readonly runtime_metadata: RuntimeMetadataRow;
}
