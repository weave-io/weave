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
 * @see docs/specs/12-spec-runtime-persistence/12-spec-runtime-persistence.md
 */

import type { ResultAsync } from "neverthrow";
import type { RuntimeStoreError } from "./errors.js";
import type {
  ExecutionLease,
  ExecutionLeaseId,
  JournalQueryFilter,
  OwnerId,
  RuntimeJournalEntry,
  RuntimeJournalEntryId,
  SessionSnapshot,
  SessionSnapshotId,
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
   */
  addArtifact(
    id: WorkflowInstanceId,
    artifact: {
      name: string;
      path: string;
      mimeType?: string;
      description?: string;
    },
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
 * @see docs/specs/12-spec-runtime-persistence/12-spec-runtime-persistence.md
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
