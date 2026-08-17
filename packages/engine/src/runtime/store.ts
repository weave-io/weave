/**
 * Runtime Store interfaces — composed repository and transaction/unit-of-work API.
 *
 * Defines the engine-owned persistence contract without tying callers to SQLite.
 * All fallible operations return `ResultAsync<T, RuntimeStoreError>` from neverthrow.
 *
 * Repository interface conventions:
 * - `find*()` — returns `ResultAsync<T | null, RuntimeStoreError>` (null if not found)
 * - `get*()` — returns `ResultAsync<T, RuntimeStoreError>` (errors with `not_found` if missing)
 *
 * @see docs/reference/runtime.md
 */

import { err, ok, Result, type ResultAsync } from "neverthrow";
import { type RuntimeStoreError, validationError } from "./errors.js";
import type {
  AdapterPreferenceRecord,
  ArtifactApprovalActor,
  ArtifactApprovalState,
  ArtifactId,
  ArtifactIntegrityMetadata,
  ConsumedArtifactRecord,
  ExecutionLease,
  ExecutionLeaseId,
  JournalQueryFilter,
  OwnerId,
  RetentionPruneStats,
  RuntimeJournalEntry,
  RuntimeJournalEntryId,
  SessionSnapshot,
  SessionSnapshotId,
  UsageObservation,
  UsageObservationId,
  UsageObservationQueryFilter,
  UsageObservationRecordResult,
  UsageRollup,
  UsageRollupQueryFilter,
  WorkflowInstance,
  WorkflowInstanceId,
  WorkflowInstanceStatus,
} from "./types.js";

// ---------------------------------------------------------------------------
// WorkflowInstance repository
// ---------------------------------------------------------------------------

/**
 * Input for creating a new WorkflowInstance.
 */
export interface CreateWorkflowInstanceInput {
  /**
   * Optional caller-supplied ID. When provided, the store uses this ID instead
   * of generating a new one. The caller is responsible for ensuring uniqueness.
   */
  readonly id?: WorkflowInstanceId;
  readonly workflowName: string;
  readonly goal: string;
  readonly slug: string;
}

/**
 * Input for updating a WorkflowInstance.
 */
export interface UpdateWorkflowInstanceInput {
  readonly status?: WorkflowInstanceStatus;
  readonly currentStepName?: string | null;
  readonly errorMessage?: string | null;
}

/**
 * Repository for WorkflowInstance records.
 *
 * Source-of-truth writes fail the operation on persistence errors.
 */
export interface WorkflowInstanceRepository {
  /**
   * Create a new WorkflowInstance with status `created`.
   */
  create(
    input: CreateWorkflowInstanceInput,
  ): ResultAsync<WorkflowInstance, RuntimeStoreError>;

  /**
   * Find a WorkflowInstance by ID. Returns null if not found.
   */
  findById(
    id: WorkflowInstanceId,
  ): ResultAsync<WorkflowInstance | null, RuntimeStoreError>;

  /**
   * Get a WorkflowInstance by ID. Errors with `not_found` if missing.
   */
  getById(
    id: WorkflowInstanceId,
  ): ResultAsync<WorkflowInstance, RuntimeStoreError>;

  /**
   * List all WorkflowInstances, optionally filtered by status.
   */
  list(filter?: {
    status?: WorkflowInstanceStatus;
  }): ResultAsync<readonly WorkflowInstance[], RuntimeStoreError>;

  /**
   * Update mutable fields of a WorkflowInstance.
   */
  update(
    id: WorkflowInstanceId,
    input: UpdateWorkflowInstanceInput,
  ): ResultAsync<WorkflowInstance, RuntimeStoreError>;

  /**
   * Add an artifact reference to a WorkflowInstance.
   *
   * The store assigns a stable ArtifactId and sets the initial revision to 1
   * with approvalState `pending`. If an artifact with the same name already
   * exists, the store increments the revision and resets approvalState to
   * `pending` for the new revision, invalidating any prior approval.
   *
   * Raw artifact contents, prompts, tokens, and private paths must never be
   * passed here — only the reference path and optional metadata.
   */
  addArtifact(
    id: WorkflowInstanceId,
    artifact: {
      name: string;
      path: string;
      mimeType?: string;
      description?: string;
      /**
       * Optional integrity-verification metadata.
       * When provided, the digest is stored for tamper detection.
       * The raw artifact content must never be passed here.
       */
      integrity?: ArtifactIntegrityMetadata;
      /**
       * Optional logical name of the agent that produced this artifact.
       * Used to enforce the self-approval prohibition at the lifecycle layer.
       */
      producerAgent?: string;
    },
  ): ResultAsync<WorkflowInstance, RuntimeStoreError>;

  /**
   * Update the approval state of a named artifact on a WorkflowInstance.
   *
   * Only the most recent revision of the named artifact is updated.
   * Fails with `not_found` if the instance or artifact does not exist.
   *
   * @param id - The WorkflowInstance ID.
   * @param artifactId - The stable ArtifactId to update.
   * @param approvalState - The new approval state.
   */
  updateArtifactApproval(
    id: WorkflowInstanceId,
    artifactId: ArtifactId,
    approvalState: ArtifactApprovalState,
    approval?: {
      readonly actor: ArtifactApprovalActor;
      readonly decidedAt: string;
      /** Compare-and-swap binding for the exact reviewed revision. */
      readonly expectedRevision: number;
      /** Required when the stored revision carries integrity metadata. */
      readonly expectedDigest?: string;
    },
  ): ResultAsync<WorkflowInstance, RuntimeStoreError>;

  /**
   * Record a step attempt with its consumed artifact revisions.
   *
   * Appends a `StepAttemptRecord` to the instance's `stepAttempts` list.
   * The attempt number is computed by the store as one more than the current
   * count of attempts for the same step name.
   *
   * Fails with `not_found` if the instance does not exist.
   *
   * @param id - The WorkflowInstance ID.
   * @param stepName - The step name for this attempt.
   * @param consumedArtifacts - Artifact identity+revision pairs consumed at dispatch.
   */
  recordStepAttempt(
    id: WorkflowInstanceId,
    stepName: string,
    consumedArtifacts: readonly ConsumedArtifactRecord[],
  ): ResultAsync<WorkflowInstance, RuntimeStoreError>;
}

// ---------------------------------------------------------------------------
// ExecutionLease repository
// ---------------------------------------------------------------------------

/**
 * Input for acquiring an ExecutionLease.
 */
export interface AcquireLeaseInput {
  /** The WorkflowInstance to drive. */
  readonly workflowInstanceId: WorkflowInstanceId;
  /** Weave-generated owner identifier for this session/process. */
  readonly ownerId: OwnerId;
  /** Duration in milliseconds before the lease expires if not renewed. */
  readonly ttlMs: number;
}

/**
 * Repository for ExecutionLease records.
 *
 * Enforces one active (unexpired) lease per project (issue #50).
 * Lease expiry checks are atomic with acquisition where practical.
 */
export interface ExecutionLeaseRepository {
  /**
   * Acquire a new ExecutionLease.
   *
   * Fails with `conflict` if an unexpired lease already exists.
   * An expired lease may be replaced.
   */
  acquire(
    input: AcquireLeaseInput,
  ): ResultAsync<ExecutionLease, RuntimeStoreError>;

  /**
   * Find the current active lease. Returns null if none exists.
   */
  findActive(): ResultAsync<ExecutionLease | null, RuntimeStoreError>;

  /**
   * Get the current active lease. Errors with `not_found` if none exists.
   */
  getActive(): ResultAsync<ExecutionLease, RuntimeStoreError>;

  /**
   * Find a lease by ID. Returns null if not found.
   */
  findById(
    id: ExecutionLeaseId,
  ): ResultAsync<ExecutionLease | null, RuntimeStoreError>;

  /**
   * Get a lease by ID. Errors with `not_found` if missing.
   */
  getById(id: ExecutionLeaseId): ResultAsync<ExecutionLease, RuntimeStoreError>;

  /**
   * Renew the lease expiry by updating `lastHeartbeatAt` and extending `expiresAt`.
   *
   * Fails with `not_found` if the lease does not exist.
   * Fails with `conflict` if the lease has expired or is owned by a different owner.
   */
  heartbeat(
    id: ExecutionLeaseId,
    ownerId: OwnerId,
    ttlMs: number,
  ): ResultAsync<ExecutionLease, RuntimeStoreError>;

  /**
   * Release (delete) a lease.
   *
   * Fails with `not_found` if the lease does not exist.
   * Fails with `conflict` if the lease is owned by a different owner.
   *
   * Any `SessionSnapshot` that observed this lease is preserved: its
   * `leaseId` link is severed (set to `undefined`/`NULL`), not deleted.
   * Terminal workflow completion must be able to release the lease that
   * drove it without losing that historical record.
   */
  release(
    id: ExecutionLeaseId,
    ownerId: OwnerId,
  ): ResultAsync<void, RuntimeStoreError>;
}

// ---------------------------------------------------------------------------
// SessionSnapshot repository
// ---------------------------------------------------------------------------

/**
 * Input for recording a SessionSnapshot.
 */
export interface RecordSessionSnapshotInput {
  readonly workflowInstanceId: WorkflowInstanceId;
  /** The active ExecutionLease at record time. Always required to record. */
  readonly leaseId: ExecutionLeaseId;
  readonly harnessName: string;
  readonly harnessVersion?: string;
  readonly agentName: string;
  readonly modelId?: string;
  readonly stepName?: string;
  readonly sessionStatus: "active" | "idle" | "terminated";
  /**
   * Sanitized metadata. Must not contain raw prompts, completions,
   * credentials, tokens, cookies, authorization headers, or PII.
   */
  readonly metadata: Record<string, string | number | boolean>;
}

/**
 * Repository for SessionSnapshot records.
 *
 * Source-of-truth writes fail the operation on persistence errors.
 */
export interface SessionSnapshotRepository {
  /**
   * Record a new SessionSnapshot.
   */
  record(
    input: RecordSessionSnapshotInput,
  ): ResultAsync<SessionSnapshot, RuntimeStoreError>;

  /**
   * Find a SessionSnapshot by ID. Returns null if not found.
   */
  findById(
    id: SessionSnapshotId,
  ): ResultAsync<SessionSnapshot | null, RuntimeStoreError>;

  /**
   * Get a SessionSnapshot by ID. Errors with `not_found` if missing.
   */
  getById(
    id: SessionSnapshotId,
  ): ResultAsync<SessionSnapshot, RuntimeStoreError>;

  /**
   * List all SessionSnapshots for a WorkflowInstance.
   */
  listByWorkflowInstance(
    workflowInstanceId: WorkflowInstanceId,
  ): ResultAsync<readonly SessionSnapshot[], RuntimeStoreError>;

  /**
   * Find the most recent SessionSnapshot for a WorkflowInstance.
   * Returns null if none exists.
   */
  findLatestByWorkflowInstance(
    workflowInstanceId: WorkflowInstanceId,
  ): ResultAsync<SessionSnapshot | null, RuntimeStoreError>;
}

// ---------------------------------------------------------------------------
// RuntimeJournal repository
// ---------------------------------------------------------------------------

/**
 * Repository for RuntimeJournalEntry records.
 *
 * Journal writes are best-effort by default. In strict mode
 * (`settings.runtime.journal.strict = true`), journal write failures
 * roll back the surrounding unit of work.
 */
export interface RuntimeJournalRepository {
  /**
   * Append a new RuntimeJournalEntry.
   *
   * In best-effort mode: failures are logged as warnings and do not
   * propagate to the caller.
   * In strict mode: failures propagate as `journal_write` errors.
   */
  append(
    entry: Omit<RuntimeJournalEntry, "id" | "timestamp">,
  ): ResultAsync<RuntimeJournalEntry, RuntimeStoreError>;

  /**
   * Find a journal entry by ID. Returns null if not found.
   */
  findById(
    id: RuntimeJournalEntryId,
  ): ResultAsync<RuntimeJournalEntry | null, RuntimeStoreError>;

  /**
   * Get a journal entry by ID. Errors with `not_found` if missing.
   */
  getById(
    id: RuntimeJournalEntryId,
  ): ResultAsync<RuntimeJournalEntry, RuntimeStoreError>;

  /**
   * Query journal entries with optional filters.
   */
  query(
    filter?: JournalQueryFilter,
  ): ResultAsync<readonly RuntimeJournalEntry[], RuntimeStoreError>;

  /**
   * Prune journal entries by age first, then oldest above count.
   *
   * `olderThan` is an exclusive ISO 8601 upper bound for age deletion.
   * `maxCount` retains the newest N entries after age pruning.
   */
  prune(options: {
    readonly olderThan?: string;
    readonly maxCount?: number;
  }): ResultAsync<RetentionPruneStats, RuntimeStoreError>;
}

// ---------------------------------------------------------------------------
// Usage repository
// ---------------------------------------------------------------------------

/**
 * Repository for idempotent usage observations and durable rollups.
 *
 * Adapters submit normalized observations; they never write rollup tables
 * directly. Insert + rollup update are atomic. Detail pruning never subtracts
 * durable rollups.
 */
export interface UsageRepository {
  /**
   * Record one detailed observation and update durable rollups atomically.
   *
   * - Same ID + same normalized values → `{ kind: "noop" }`
   * - Same ID + different values → `invariant_violation`
   * - New ID → insert observation and add present fields to the matching rollup
   */
  recordObservation(
    observation: UsageObservation,
  ): ResultAsync<UsageObservationRecordResult, RuntimeStoreError>;

  findObservationById(
    id: UsageObservationId,
  ): ResultAsync<UsageObservation | null, RuntimeStoreError>;

  listObservations(
    filter?: UsageObservationQueryFilter,
  ): ResultAsync<readonly UsageObservation[], RuntimeStoreError>;

  listRollups(
    filter?: UsageRollupQueryFilter,
  ): ResultAsync<readonly UsageRollup[], RuntimeStoreError>;

  /**
   * Prune detailed observations by age first, then oldest above count.
   * Never mutates durable rollups.
   */
  pruneDetails(options: {
    readonly olderThan?: string;
    readonly maxCount?: number;
  }): ResultAsync<RetentionPruneStats, RuntimeStoreError>;
}

// ---------------------------------------------------------------------------
// Adapter preference repository
// ---------------------------------------------------------------------------

/** Maximum namespace length in UTF-16 code units. */
export const ADAPTER_PREFERENCE_NAMESPACE_MAX_CHARS = 64;

/** Maximum key length in UTF-16 code units. */
export const ADAPTER_PREFERENCE_KEY_MAX_CHARS = 128;

/** Maximum serialized preference value size in bytes. */
export const ADAPTER_PREFERENCE_VALUE_MAX_BYTES = 16 * 1024;

/**
 * Default and maximum number of rows returned by `AdapterPreferenceRepository.list`.
 * Callers may pass a smaller limit. Larger or non-finite values are clamped
 * to this bound.
 */
export const ADAPTER_PREFERENCE_LIST_LIMIT = 100;

/**
 * Clamp a `list` limit to `[0, ADAPTER_PREFERENCE_LIST_LIMIT]`.
 * Missing or non-finite values become the documented default of 100.
 */
export function clampAdapterPreferenceListLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return ADAPTER_PREFERENCE_LIST_LIMIT;
  }
  return Math.max(
    0,
    Math.min(Math.floor(limit), ADAPTER_PREFERENCE_LIST_LIMIT),
  );
}

function hasControlOrNul(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function rejectControlChars(
  value: string,
  field: string,
): Result<void, RuntimeStoreError> {
  if (hasControlOrNul(value)) {
    return err(
      validationError(
        `Adapter preference ${field} must not contain control characters or NUL`,
        field,
      ),
    );
  }
  return ok(undefined);
}

/** Validate a preference namespace: non-empty, bounded, no control chars or NUL. */
export function validateAdapterPreferenceNamespace(
  namespace: string,
): Result<void, RuntimeStoreError> {
  if (typeof namespace !== "string") {
    return err(
      validationError(
        "Adapter preference namespace must be a string",
        "namespace",
      ),
    );
  }
  if (namespace.length === 0) {
    return err(
      validationError(
        "Adapter preference namespace must not be empty",
        "namespace",
      ),
    );
  }
  if (namespace.length > ADAPTER_PREFERENCE_NAMESPACE_MAX_CHARS) {
    return err(
      validationError(
        `Adapter preference namespace exceeds ${ADAPTER_PREFERENCE_NAMESPACE_MAX_CHARS} characters`,
        "namespace",
      ),
    );
  }
  return rejectControlChars(namespace, "namespace");
}

/** Validate a preference key: non-empty, bounded, no control chars or NUL. */
export function validateAdapterPreferenceKey(
  key: string,
): Result<void, RuntimeStoreError> {
  if (typeof key !== "string") {
    return err(
      validationError("Adapter preference key must be a string", "key"),
    );
  }
  if (key.length === 0) {
    return err(
      validationError("Adapter preference key must not be empty", "key"),
    );
  }
  if (key.length > ADAPTER_PREFERENCE_KEY_MAX_CHARS) {
    return err(
      validationError(
        `Adapter preference key exceeds ${ADAPTER_PREFERENCE_KEY_MAX_CHARS} characters`,
        "key",
      ),
    );
  }
  return rejectControlChars(key, "key");
}

/**
 * Validate an opaque preference value.
 *
 * The engine checks that the string is valid JSON and within the 16 KiB
 * bound. It does not interpret the payload. Preferences must never contain
 * secrets.
 */
export function validateAdapterPreferenceValue(
  valueJson: string,
): Result<void, RuntimeStoreError> {
  if (typeof valueJson !== "string") {
    return err(
      validationError(
        "Adapter preference value must be a JSON string",
        "value",
      ),
    );
  }
  if (valueJson.includes("\0")) {
    return err(
      validationError("Adapter preference value must not contain NUL", "value"),
    );
  }
  const bytes = new TextEncoder().encode(valueJson).byteLength;
  if (bytes > ADAPTER_PREFERENCE_VALUE_MAX_BYTES) {
    return err(
      validationError(
        `Adapter preference value exceeds the 16 KiB limit (${bytes} bytes)`,
        "value",
      ),
    );
  }
  const parsed = Result.fromThrowable(
    () => JSON.parse(valueJson) as unknown,
    () =>
      validationError("Adapter preference value must be valid JSON", "value"),
  )();
  if (parsed.isErr()) return err(parsed.error);
  return ok(undefined);
}

/** Validate a preference namespace and key together. */
export function validateAdapterPreferenceIdentity(
  namespace: string,
  key: string,
): Result<void, RuntimeStoreError> {
  return validateAdapterPreferenceNamespace(namespace).andThen(() =>
    validateAdapterPreferenceKey(key),
  );
}

/**
 * Harness-neutral bounded key/value repository for adapter configuration.
 *
 * Values are opaque valid JSON strings. The engine does not interpret them
 * and must never persist secrets here.
 */
export interface AdapterPreferenceRepository {
  /**
   * Read one preference. Returns `null` when the pair is absent.
   */
  get(
    namespace: string,
    key: string,
  ): ResultAsync<AdapterPreferenceRecord | null, RuntimeStoreError>;

  /**
   * Insert or overwrite a preference. `updated_at` is set to the store clock.
   */
  set(
    namespace: string,
    key: string,
    valueJson: string,
  ): ResultAsync<AdapterPreferenceRecord, RuntimeStoreError>;

  /**
   * List preferences in one namespace, ordered by key.
   *
   * `limit` defaults to {@link ADAPTER_PREFERENCE_LIST_LIMIT} and is clamped
   * to that maximum.
   */
  list(
    namespace: string,
    limit?: number,
  ): ResultAsync<readonly AdapterPreferenceRecord[], RuntimeStoreError>;

  /**
   * Delete one preference. Missing pairs succeed.
   */
  remove(namespace: string, key: string): ResultAsync<void, RuntimeStoreError>;
}

// ---------------------------------------------------------------------------
// Transaction / Unit-of-Work
// ---------------------------------------------------------------------------

/**
 * A unit-of-work transaction scope.
 *
 * Provides access to all sub-repositories within a single atomic transaction.
 * Changes are committed when the callback resolves successfully, or rolled back
 * on failure.
 *
 * In strict journal mode, journal write failures roll back the entire unit of work.
 * In best-effort mode, journal write failures are logged as warnings and the
 * state commit proceeds.
 */
export interface RuntimeStoreTransaction {
  /** WorkflowInstance repository within this transaction. */
  readonly instances: WorkflowInstanceRepository;
  /** ExecutionLease repository within this transaction. */
  readonly leases: ExecutionLeaseRepository;
  /** SessionSnapshot repository within this transaction. */
  readonly snapshots: SessionSnapshotRepository;
  /** RuntimeJournal repository within this transaction. */
  readonly journal: RuntimeJournalRepository;
  /** Usage repository within this transaction. */
  readonly usage: UsageRepository;
  /** Adapter preference repository within this transaction. */
  readonly preferences: AdapterPreferenceRepository;
}

/**
 * Callback type for unit-of-work transactions.
 */
export type TransactionCallback<T> = (
  tx: RuntimeStoreTransaction,
) => ResultAsync<T, RuntimeStoreError>;

// ---------------------------------------------------------------------------
// Composed RuntimeStore
// ---------------------------------------------------------------------------

/**
 * The composed Runtime Store — exposes focused sub-repositories and a
 * transaction/unit-of-work API.
 *
 * This is the primary interface for all runtime persistence operations.
 * Implementations include the default SQLite/Kysely store and the
 * in-memory test utility.
 *
 * @see docs/reference/runtime.md
 */
export interface RuntimeStore {
  /** WorkflowInstance repository. */
  readonly instances: WorkflowInstanceRepository;
  /** ExecutionLease repository. */
  readonly leases: ExecutionLeaseRepository;
  /** SessionSnapshot repository. */
  readonly snapshots: SessionSnapshotRepository;
  /** RuntimeJournal repository. */
  readonly journal: RuntimeJournalRepository;
  /** Usage observation/rollup repository. */
  readonly usage: UsageRepository;
  /** Harness-neutral adapter preference repository. */
  readonly preferences: AdapterPreferenceRepository;
  /**
   * Execute a unit-of-work transaction.
   *
   * All operations within the callback run atomically. On success, changes
   * are committed. On failure (or if the callback returns an Err), changes
   * are rolled back.
   *
   * Journal write behavior within a transaction depends on the
   * `settings.runtime.journal.strict` configuration:
   * - `false` (default): journal failures are logged as warnings; state commits
   * - `true`: journal failures roll back the entire unit of work
   */
  transaction<T>(
    callback: TransactionCallback<T>,
  ): ResultAsync<T, RuntimeStoreError>;

  /**
   * Close the store and release any held resources (e.g. database connections).
   */
  close(): ResultAsync<void, RuntimeStoreError>;
}
