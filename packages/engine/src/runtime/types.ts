/**
 * Runtime Store domain types for Weave engine.
 *
 * Defines WorkflowInstance, ExecutionLease, SessionSnapshot, RuntimeJournalEntry,
 * branded IDs, status enums, severity levels, and structured source types.
 *
 * These types are engine-owned and live in @weave/engine, not @weave/core.
 * No SQLite or Kysely types are referenced here — this file is pure domain.
 *
 * @see docs/specs/12-spec-runtime-persistence/12-spec-runtime-persistence.md
 */

// ---------------------------------------------------------------------------
// JSON domain types
// ---------------------------------------------------------------------------

/**
 * A JSON primitive value: string, number, boolean, or null.
 */
export type JsonPrimitive = string | number | boolean | null;

/**
 * A JSON object with string keys and `JsonValue` values.
 */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/**
 * Any valid JSON value: primitive, object, or array.
 */
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

// ---------------------------------------------------------------------------
// Branded ID types
// ---------------------------------------------------------------------------

/**
 * Branded string type for WorkflowInstance identifiers.
 * Use `createWorkflowInstanceId()` to create values.
 */
export type WorkflowInstanceId = string & {
  readonly __brand: "WorkflowInstanceId";
};

/**
 * Branded string type for ExecutionLease identifiers.
 * Use `createExecutionLeaseId()` to create values.
 */
export type ExecutionLeaseId = string & {
  readonly __brand: "ExecutionLeaseId";
};

/**
 * Branded string type for SessionSnapshot identifiers.
 * Use `createSessionSnapshotId()` to create values.
 */
export type SessionSnapshotId = string & {
  readonly __brand: "SessionSnapshotId";
};

/**
 * Branded string type for RuntimeJournalEntry identifiers.
 * Use `createRuntimeJournalEntryId()` to create values.
 */
export type RuntimeJournalEntryId = string & {
  readonly __brand: "RuntimeJournalEntryId";
};

/**
 * Branded string type for execution owner identifiers (Weave-generated).
 * Use `createOwnerId()` to create values.
 */
export type OwnerId = string & { readonly __brand: "OwnerId" };

// ---------------------------------------------------------------------------
// ID factory helpers
// ---------------------------------------------------------------------------

/** Cast a raw string to WorkflowInstanceId. */
export function createWorkflowInstanceId(raw: string): WorkflowInstanceId {
  return raw as WorkflowInstanceId;
}

/** Cast a raw string to ExecutionLeaseId. */
export function createExecutionLeaseId(raw: string): ExecutionLeaseId {
  return raw as ExecutionLeaseId;
}

/** Cast a raw string to SessionSnapshotId. */
export function createSessionSnapshotId(raw: string): SessionSnapshotId {
  return raw as SessionSnapshotId;
}

/** Cast a raw string to RuntimeJournalEntryId. */
export function createRuntimeJournalEntryId(
  raw: string,
): RuntimeJournalEntryId {
  return raw as RuntimeJournalEntryId;
}

/** Cast a raw string to OwnerId. */
export function createOwnerId(raw: string): OwnerId {
  return raw as OwnerId;
}

// ---------------------------------------------------------------------------
// WorkflowInstance
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a WorkflowInstance.
 *
 * - `created`   — instance exists but execution has not started
 * - `running`   — actively being driven by an execution lease holder
 * - `paused`    — execution suspended, awaiting user or gate signal
 * - `blocked`   — execution blocked on an external dependency
 * - `completed` — all steps finished successfully
 * - `failed`    — execution terminated with an error
 * - `cancelled` — execution explicitly cancelled
 */
export type WorkflowInstanceStatus =
  | "created"
  | "running"
  | "paused"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

/** All valid WorkflowInstance status values as a readonly tuple. */
export const WORKFLOW_INSTANCE_STATUSES = [
  "created",
  "running",
  "paused",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly WorkflowInstanceStatus[];

/**
 * Artifact reference stored in a WorkflowInstance.
 *
 * Stores metadata and a reference path only — never artifact contents.
 */
export interface ArtifactRef {
  /** Logical artifact name (matches workflow step output name). */
  readonly name: string;
  /** Relative path to the artifact within the project. */
  readonly path: string;
  /** Optional MIME type hint. */
  readonly mimeType?: string;
  /** Optional human-readable description. */
  readonly description?: string;
}

/**
 * A persisted workflow execution instance.
 *
 * Stores artifact references/metadata only — never artifact contents.
 */
export interface WorkflowInstance {
  /** Unique identifier for this workflow instance. */
  readonly id: WorkflowInstanceId;
  /** Name of the workflow definition being executed. */
  readonly workflowName: string;
  /** Human-readable goal or description for this execution. */
  readonly goal: string;
  /** URL-safe slug derived from the goal, used for plan file naming. */
  readonly slug: string;
  /** Current lifecycle status. */
  readonly status: WorkflowInstanceStatus;
  /** Name of the current step being executed, if any. */
  readonly currentStepName?: string;
  /** Artifact references produced by completed steps. */
  readonly artifacts: readonly ArtifactRef[];
  /** ISO 8601 timestamp when this instance was created. */
  readonly createdAt: string;
  /** ISO 8601 timestamp of the last status update. */
  readonly updatedAt: string;
  /** ISO 8601 timestamp when execution completed (any terminal status). */
  readonly completedAt?: string;
  /** Human-readable error message if status is `failed`. */
  readonly errorMessage?: string;
}

// ---------------------------------------------------------------------------
// ExecutionLease
// ---------------------------------------------------------------------------

/**
 * An execution lease that identifies the active driver of a WorkflowInstance.
 *
 * Only one unexpired lease per project may exist at a time (issue #50).
 * An expired lease may be replaced during resume/recovery; an unexpired
 * lease produces a typed `conflict` error.
 *
 * Lease expiry checks are atomic with acquisition where practical and use
 * one engine-provided clock source per operation.
 */
export interface ExecutionLease {
  /** Unique identifier for this lease. */
  readonly id: ExecutionLeaseId;
  /** The WorkflowInstance this lease is driving. */
  readonly workflowInstanceId: WorkflowInstanceId;
  /** Weave-generated owner identifier (e.g. session ID or process ID). */
  readonly ownerId: OwnerId;
  /** ISO 8601 timestamp when the lease was acquired. */
  readonly acquiredAt: string;
  /** ISO 8601 timestamp when the lease expires if not renewed. */
  readonly expiresAt: string;
  /** ISO 8601 timestamp of the last heartbeat renewal, if any. */
  readonly lastHeartbeatAt?: string;
}

// ---------------------------------------------------------------------------
// SessionSnapshot
// ---------------------------------------------------------------------------

/**
 * Normalized Weave-visible harness session observation.
 *
 * Stores only engine-visible, non-sensitive session metadata.
 *
 * EXPLICITLY EXCLUDED (by type design):
 * - Raw harness dumps or transcripts
 * - Raw prompts or completions
 * - Credentials, tokens, cookies, authorization headers
 * - Raw model/provider payloads
 * - PII-like harness-private fields
 * - User secrets or session-private state
 *
 * @see docs/specs/12-spec-runtime-persistence/12-spec-runtime-persistence.md
 */
export interface SessionSnapshot {
  /** Unique identifier for this snapshot. */
  readonly id: SessionSnapshotId;
  /** The WorkflowInstance this snapshot is associated with. */
  readonly workflowInstanceId: WorkflowInstanceId;
  /** The ExecutionLease active when this snapshot was taken. */
  readonly leaseId: ExecutionLeaseId;
  /** Harness adapter name (e.g. "opencode", "claude-code"). */
  readonly harnessName: string;
  /** Harness adapter version string, if available. */
  readonly harnessVersion?: string;
  /** Name of the agent that was active in this session. */
  readonly agentName: string;
  /** Model identifier used in this session (no provider payload). */
  readonly modelId?: string;
  /** Current step name at the time of snapshot. */
  readonly stepName?: string;
  /** Normalized session status from the harness perspective. */
  readonly sessionStatus: "active" | "idle" | "terminated";
  /** ISO 8601 timestamp when this snapshot was recorded. */
  readonly recordedAt: string;
  /**
   * Structured, sanitized metadata about the session.
   * Must not contain raw prompts, completions, credentials, or tokens.
   */
  readonly metadata: Record<string, string | number | boolean>;
}

// ---------------------------------------------------------------------------
// RuntimeJournalEntry
// ---------------------------------------------------------------------------

/**
 * Severity level for a RuntimeJournalEntry.
 */
export type JournalSeverity = "debug" | "info" | "warn" | "error";

/** All valid JournalSeverity values as a readonly tuple. */
export const JOURNAL_SEVERITIES = [
  "debug",
  "info",
  "warn",
  "error",
] as const satisfies readonly JournalSeverity[];

/**
 * Structured source identifier for a RuntimeJournalEntry.
 *
 * Persisted with indexed `source_kind` and `source_name` columns.
 */
export interface JournalEntrySource {
  /** Whether the entry originated from the engine or an adapter. */
  readonly kind: "engine" | "adapter";
  /** Logical name of the emitting component (e.g. "runner", "adapter-opencode"). */
  readonly name: string;
}

/**
 * A fixed-envelope observational journal entry.
 *
 * The Runtime Journal is observational and is NOT required to reconstruct
 * WorkflowInstance state. It is not event-sourced state.
 *
 * Journal `data` must be:
 * - JSON-serializable
 * - Size-bounded (max 64 KiB serialized)
 * - Sanitized before persistence (no raw prompts, completions, credentials, tokens)
 *
 * Prompt/completion contents are never stored. Salted SHA-256 fingerprints
 * may be stored instead.
 */
export interface RuntimeJournalEntry {
  /** Unique identifier for this journal entry. */
  readonly id: RuntimeJournalEntryId;
  /** ISO 8601 timestamp when this entry was recorded. */
  readonly timestamp: string;
  /** Structured source identifying the emitting component. */
  readonly source: JournalEntrySource;
  /** Logical event type identifier (e.g. "step.started", "lease.acquired"). */
  readonly eventType: string;
  /** The ExecutionLease active when this entry was recorded, if any. */
  readonly executionId?: ExecutionLeaseId;
  /** The WorkflowInstance this entry relates to, if any. */
  readonly workflowInstanceId?: WorkflowInstanceId;
  /** The step name this entry relates to, if any. */
  readonly stepId?: string;
  /** Severity level of this entry. */
  readonly severity: JournalSeverity;
  /**
   * Sanitized, size-bounded JSON data payload.
   * Must not contain raw prompts, completions, credentials, tokens, or PII.
   */
  readonly data: JsonObject;
}

// ---------------------------------------------------------------------------
// Journal query filter
// ---------------------------------------------------------------------------

/**
 * Filter options for querying RuntimeJournalEntry records.
 */
export interface JournalQueryFilter {
  /** Filter by workflow instance ID. */
  readonly workflowInstanceId?: WorkflowInstanceId;
  /** Filter by execution lease ID. */
  readonly executionId?: ExecutionLeaseId;
  /** Filter by source kind. */
  readonly sourceKind?: "engine" | "adapter";
  /** Filter by source name. */
  readonly sourceName?: string;
  /** Filter by event type. */
  readonly eventType?: string;
  /** Filter by exact severity. */
  readonly severity?: JournalSeverity;
  /** ISO 8601 timestamp — only entries after this time. */
  readonly after?: string;
  /** ISO 8601 timestamp — only entries before this time. */
  readonly before?: string;
  /** Maximum number of entries to return. */
  readonly limit?: number;
}
