/**
 * RuntimeStoreError — discriminated union for all Runtime Store failure modes.
 *
 * All fallible Runtime Store repository operations return
 * `ResultAsync<T, RuntimeStoreError>` from neverthrow.
 *
 * @see docs/specs/12-spec-runtime-persistence/12-spec-runtime-persistence.md
 */

// ---------------------------------------------------------------------------
// RuntimeStoreError discriminated union
// ---------------------------------------------------------------------------

/**
 * Failure during Runtime Store initialization (e.g. directory creation,
 * database file creation, permission setup).
 */
export interface RuntimeStoreInitializationError {
  readonly type: "initialization";
  /** Human-readable description of the failure. */
  readonly message: string;
  /** Underlying cause, if available. */
  readonly cause?: unknown;
}

/**
 * Failure due to a schema version mismatch.
 *
 * Raised when opening a Runtime Store whose schema version is newer than
 * the running Weave implementation supports. The store is not mutated.
 */
export interface RuntimeStoreMigrationVersionError {
  readonly type: "migration_version";
  /** The schema version found in the store. */
  readonly foundVersion: number;
  /** The maximum schema version this Weave build supports. */
  readonly supportedVersion: number;
  /** Human-readable description of the failure. */
  readonly message: string;
}

/**
 * Failure during serialization or deserialization of a stored record.
 */
export interface RuntimeStoreSerializationError {
  readonly type: "serialization";
  /** Human-readable description of the failure. */
  readonly message: string;
  /** Underlying cause, if available. */
  readonly cause?: unknown;
}

/**
 * Failure during a database query or write operation.
 */
export interface RuntimeStoreQueryError {
  readonly type: "query";
  /** Human-readable description of the failure. */
  readonly message: string;
  /** Underlying cause, if available. */
  readonly cause?: unknown;
}

/**
 * A required record was not found in the store.
 *
 * Returned by `get*` methods when the requested record does not exist.
 * `find*` methods return `null` instead of this error for missing records.
 */
export interface RuntimeStoreNotFoundError {
  readonly type: "not_found";
  /** The entity type that was not found (e.g. "WorkflowInstance"). */
  readonly entity: string;
  /** The ID that was looked up. */
  readonly id: string;
  /** Human-readable description. */
  readonly message: string;
}

/**
 * A conflicting record or lease already exists.
 *
 * Raised when attempting to acquire a lease while an unexpired lease
 * already exists, or when a unique constraint would be violated.
 */
export interface RuntimeStoreConflictError {
  readonly type: "conflict";
  /** The entity type involved in the conflict (e.g. "ExecutionLease"). */
  readonly entity: string;
  /** Human-readable description of the conflict. */
  readonly message: string;
  /** The ID of the conflicting record, if known. */
  readonly conflictingId?: string;
}

/**
 * Input validation failure before a store operation.
 *
 * Raised when a record or query parameter fails validation checks
 * (e.g. invalid status value, missing required field).
 */
export interface RuntimeStoreValidationError {
  readonly type: "validation";
  /** Human-readable description of the validation failure. */
  readonly message: string;
  /** The field or path that failed validation, if applicable. */
  readonly field?: string;
}

/**
 * Failure during a Runtime Journal write operation.
 *
 * In best-effort mode, this error is logged as a warning and the
 * surrounding unit-of-work transaction commits. In strict mode
 * (`settings.runtime.journal.strict = true`), this error rolls back
 * the entire unit of work.
 */
export interface RuntimeStoreJournalWriteError {
  readonly type: "journal_write";
  /** Human-readable description of the failure. */
  readonly message: string;
  /** Underlying cause, if available. */
  readonly cause?: unknown;
}

/**
 * Discriminated union of all Runtime Store error variants.
 *
 * All fallible repository operations return `ResultAsync<T, RuntimeStoreError>`.
 */
export type RuntimeStoreError =
  | RuntimeStoreInitializationError
  | RuntimeStoreMigrationVersionError
  | RuntimeStoreSerializationError
  | RuntimeStoreQueryError
  | RuntimeStoreNotFoundError
  | RuntimeStoreConflictError
  | RuntimeStoreValidationError
  | RuntimeStoreJournalWriteError;

// ---------------------------------------------------------------------------
// Error factory helpers
// ---------------------------------------------------------------------------

/** Create a RuntimeStoreInitializationError. */
export function initializationError(
  message: string,
  cause?: unknown,
): RuntimeStoreInitializationError {
  return { type: "initialization", message, cause };
}

/** Create a RuntimeStoreMigrationVersionError. */
export function migrationVersionError(
  foundVersion: number,
  supportedVersion: number,
  message: string,
): RuntimeStoreMigrationVersionError {
  return { type: "migration_version", foundVersion, supportedVersion, message };
}

/** Create a RuntimeStoreSerializationError. */
export function serializationError(
  message: string,
  cause?: unknown,
): RuntimeStoreSerializationError {
  return { type: "serialization", message, cause };
}

/** Create a RuntimeStoreQueryError. */
export function queryError(
  message: string,
  cause?: unknown,
): RuntimeStoreQueryError {
  return { type: "query", message, cause };
}

/** Create a RuntimeStoreNotFoundError. */
export function notFoundError(
  entity: string,
  id: string,
  message?: string,
): RuntimeStoreNotFoundError {
  return {
    type: "not_found",
    entity,
    id,
    message: message ?? `${entity} with id '${id}' not found`,
  };
}

/** Create a RuntimeStoreConflictError. */
export function conflictError(
  entity: string,
  message: string,
  conflictingId?: string,
): RuntimeStoreConflictError {
  return { type: "conflict", entity, message, conflictingId };
}

/** Create a RuntimeStoreValidationError. */
export function validationError(
  message: string,
  field?: string,
): RuntimeStoreValidationError {
  return { type: "validation", message, field };
}

/** Create a RuntimeStoreJournalWriteError. */
export function journalWriteError(
  message: string,
  cause?: unknown,
): RuntimeStoreJournalWriteError {
  return { type: "journal_write", message, cause };
}
