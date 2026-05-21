/**
 * In-memory Runtime Store test utility.
 *
 * Implements the `RuntimeStore` interface using in-memory `Map` collections.
 * No filesystem writes, no harness startup, no adapter discovery.
 *
 * Designed for use in unit and integration tests. Supports configurable
 * failure injection to exercise error paths without a real SQLite database.
 *
 * @see docs/specs/12-spec-runtime-persistence/12-spec-runtime-persistence.md
 */

import { errAsync, okAsync, ResultAsync } from "neverthrow";
import {
  conflictError,
  notFoundError,
  queryError,
  type RuntimeStoreError,
} from "./errors.js";
import { RuntimeJournalWriter } from "./journal-writer.js";
import { sanitizeSnapshotMetadata } from "./sanitizer.js";
import type {
  AcquireLeaseInput,
  CreateWorkflowInstanceInput,
  ExecutionLeaseRepository,
  RecordSessionSnapshotInput,
  RuntimeJournalRepository,
  RuntimeStore,
  RuntimeStoreTransaction,
  SessionSnapshotRepository,
  TransactionCallback,
  UpdateWorkflowInstanceInput,
  WorkflowInstanceRepository,
} from "./store.js";
import type {
  ArtifactRef,
  ExecutionLease,
  ExecutionLeaseId,
  JournalQueryFilter,
  JsonObject,
  OwnerId,
  RuntimeJournalEntry,
  RuntimeJournalEntryId,
  SessionSnapshot,
  SessionSnapshotId,
  WorkflowInstance,
  WorkflowInstanceId,
  WorkflowInstanceStatus,
} from "./types.js";
import {
  createExecutionLeaseId,
  createRuntimeJournalEntryId,
  createSessionSnapshotId,
  createWorkflowInstanceId,
} from "./types.js";

// ---------------------------------------------------------------------------
// Failure injection configuration
// ---------------------------------------------------------------------------

/**
 * Configurable failure injection for the in-memory Runtime Store.
 *
 * Each key maps to a `RuntimeStoreError` that will be returned instead of
 * the normal result when the corresponding operation is called.
 *
 * Set a key to `undefined` to clear the injected failure.
 */
export interface InMemoryRuntimeStoreFailureConfig {
  /** Injected error for `WorkflowInstanceRepository.create`. */
  workflowCreate?: RuntimeStoreError;
  /** Injected error for `WorkflowInstanceRepository.update`. */
  workflowUpdate?: RuntimeStoreError;
  /** Injected error for `WorkflowInstanceRepository.addArtifact`. */
  workflowAddArtifact?: RuntimeStoreError;
  /** Injected error for `ExecutionLeaseRepository.acquire`. */
  leaseAcquire?: RuntimeStoreError;
  /** Injected error for `ExecutionLeaseRepository.heartbeat`. */
  leaseHeartbeat?: RuntimeStoreError;
  /** Injected error for `ExecutionLeaseRepository.release`. */
  leaseRelease?: RuntimeStoreError;
  /** Injected error for `SessionSnapshotRepository.record`. */
  snapshotRecord?: RuntimeStoreError;
  /** Injected error for `RuntimeJournalRepository.append`. */
  journalAppend?: RuntimeStoreError;
  /** Injected error for `RuntimeStore.transaction`. */
  transaction?: RuntimeStoreError;
  /** Injected error for `RuntimeStore.close`. */
  close?: RuntimeStoreError;
}

/**
 * Options for creating an in-memory Runtime Store.
 */
export interface InMemoryRuntimeStoreOptions {
  /**
   * Whether journal write failures roll back the unit of work.
   * Default: false (best-effort mode).
   */
  readonly strictJournal?: boolean;
  /**
   * Clock source for lease expiry checks.
   * Default: `() => new Date()`.
   */
  readonly clock?: () => Date;
  /**
   * Initial failure injection configuration.
   * Can be updated at runtime via `store.failureConfig`.
   */
  readonly failOn?: InMemoryRuntimeStoreFailureConfig;
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

function newId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// InMemoryWorkflowInstanceRepository
// ---------------------------------------------------------------------------

class InMemoryWorkflowInstanceRepository implements WorkflowInstanceRepository {
  private readonly store = new Map<string, WorkflowInstance>();
  private failures: InMemoryRuntimeStoreFailureConfig;

  constructor(failures: InMemoryRuntimeStoreFailureConfig) {
    this.failures = failures;
  }

  /** Update the shared failure config reference. */
  setFailures(failures: InMemoryRuntimeStoreFailureConfig): void {
    this.failures = failures;
  }

  create(
    input: CreateWorkflowInstanceInput,
  ): ResultAsync<WorkflowInstance, RuntimeStoreError> {
    if (this.failures.workflowCreate) {
      return errAsync(this.failures.workflowCreate);
    }
    const now = new Date().toISOString();
    const instance: WorkflowInstance = {
      id: input.id ?? createWorkflowInstanceId(newId()),
      workflowName: input.workflowName,
      goal: input.goal,
      slug: input.slug,
      status: "created",
      artifacts: [],
      createdAt: now,
      updatedAt: now,
    };
    this.store.set(instance.id, instance);
    return okAsync(instance);
  }

  findById(
    id: WorkflowInstanceId,
  ): ResultAsync<WorkflowInstance | null, RuntimeStoreError> {
    const instance = this.store.get(id) ?? null;
    return okAsync(instance);
  }

  getById(
    id: WorkflowInstanceId,
  ): ResultAsync<WorkflowInstance, RuntimeStoreError> {
    const instance = this.store.get(id);
    if (!instance) {
      return errAsync(notFoundError("WorkflowInstance", id as string));
    }
    return okAsync(instance);
  }

  list(filter?: {
    status?: WorkflowInstanceStatus;
  }): ResultAsync<readonly WorkflowInstance[], RuntimeStoreError> {
    let instances = Array.from(this.store.values());
    if (filter?.status) {
      instances = instances.filter((i) => i.status === filter.status);
    }
    return okAsync(instances);
  }

  update(
    id: WorkflowInstanceId,
    input: UpdateWorkflowInstanceInput,
  ): ResultAsync<WorkflowInstance, RuntimeStoreError> {
    if (this.failures.workflowUpdate) {
      return errAsync(this.failures.workflowUpdate);
    }
    const existing = this.store.get(id);
    if (!existing) {
      return errAsync(notFoundError("WorkflowInstance", id as string));
    }
    const now = new Date().toISOString();
    const isTerminal =
      input.status === "completed" ||
      input.status === "failed" ||
      input.status === "cancelled";

    let stepPatch: Partial<WorkflowInstance> = {};
    if (input.currentStepName !== undefined) {
      stepPatch =
        input.currentStepName !== null
          ? { currentStepName: input.currentStepName }
          : { currentStepName: undefined };
    }

    let errorPatch: Partial<WorkflowInstance> = {};
    if (input.errorMessage !== undefined) {
      errorPatch =
        input.errorMessage !== null
          ? { errorMessage: input.errorMessage }
          : { errorMessage: undefined };
    }

    const updated: WorkflowInstance = {
      ...existing,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...stepPatch,
      ...errorPatch,
      ...(isTerminal && !existing.completedAt ? { completedAt: now } : {}),
      updatedAt: now,
    };
    this.store.set(id, updated);
    return okAsync(updated);
  }

  addArtifact(
    id: WorkflowInstanceId,
    artifact: {
      name: string;
      path: string;
      mimeType?: string;
      description?: string;
    },
  ): ResultAsync<WorkflowInstance, RuntimeStoreError> {
    if (this.failures.workflowAddArtifact) {
      return errAsync(this.failures.workflowAddArtifact);
    }
    const existing = this.store.get(id);
    if (!existing) {
      return errAsync(notFoundError("WorkflowInstance", id as string));
    }
    const ref: ArtifactRef = {
      name: artifact.name,
      path: artifact.path,
      ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
      ...(artifact.description ? { description: artifact.description } : {}),
    };
    const updated: WorkflowInstance = {
      ...existing,
      artifacts: [...existing.artifacts, ref],
      updatedAt: new Date().toISOString(),
    };
    this.store.set(id, updated);
    return okAsync(updated);
  }

  /** Snapshot current store state for transaction staging. */
  snapshot(): Map<string, WorkflowInstance> {
    return new Map(this.store);
  }

  /** Restore store state from a snapshot (used for transaction rollback). */
  restore(snapshot: Map<string, WorkflowInstance>): void {
    this.store.clear();
    for (const [k, v] of snapshot) {
      this.store.set(k, v);
    }
  }
}

// ---------------------------------------------------------------------------
// InMemoryExecutionLeaseRepository
// ---------------------------------------------------------------------------

class InMemoryExecutionLeaseRepository implements ExecutionLeaseRepository {
  private readonly store = new Map<string, ExecutionLease>();
  private failures: InMemoryRuntimeStoreFailureConfig;
  private readonly clock: () => Date;

  constructor(failures: InMemoryRuntimeStoreFailureConfig, clock: () => Date) {
    this.failures = failures;
    this.clock = clock;
  }

  /** Update the shared failure config reference. */
  setFailures(failures: InMemoryRuntimeStoreFailureConfig): void {
    this.failures = failures;
  }

  acquire(
    input: AcquireLeaseInput,
  ): ResultAsync<ExecutionLease, RuntimeStoreError> {
    if (this.failures.leaseAcquire) {
      return errAsync(this.failures.leaseAcquire);
    }
    const now = this.clock();
    const nowIso = now.toISOString();

    // Atomic check: find any unexpired lease
    const existing = Array.from(this.store.values()).find(
      (l) => l.expiresAt > nowIso,
    );
    if (existing) {
      return errAsync(
        conflictError(
          "ExecutionLease",
          "An unexpired lease already exists",
          existing.id,
        ),
      );
    }

    const lease: ExecutionLease = {
      id: createExecutionLeaseId(newId()),
      workflowInstanceId: input.workflowInstanceId,
      ownerId: input.ownerId,
      acquiredAt: nowIso,
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
    };
    this.store.set(lease.id, lease);
    return okAsync(lease);
  }

  findActive(): ResultAsync<ExecutionLease | null, RuntimeStoreError> {
    const nowIso = this.clock().toISOString();
    const active =
      Array.from(this.store.values())
        .filter((l) => l.expiresAt > nowIso)
        .sort((a, b) => b.acquiredAt.localeCompare(a.acquiredAt))[0] ?? null;
    return okAsync(active);
  }

  getActive(): ResultAsync<ExecutionLease, RuntimeStoreError> {
    return this.findActive().andThen((lease) => {
      if (!lease) {
        return errAsync(
          notFoundError("ExecutionLease", "active", "No active lease found"),
        );
      }
      return okAsync(lease);
    });
  }

  findById(
    id: ExecutionLeaseId,
  ): ResultAsync<ExecutionLease | null, RuntimeStoreError> {
    const lease = this.store.get(id) ?? null;
    return okAsync(lease);
  }

  getById(
    id: ExecutionLeaseId,
  ): ResultAsync<ExecutionLease, RuntimeStoreError> {
    const lease = this.store.get(id);
    if (!lease) {
      return errAsync(notFoundError("ExecutionLease", id as string));
    }
    return okAsync(lease);
  }

  heartbeat(
    id: ExecutionLeaseId,
    ownerId: OwnerId,
    ttlMs: number,
  ): ResultAsync<ExecutionLease, RuntimeStoreError> {
    if (this.failures.leaseHeartbeat) {
      return errAsync(this.failures.leaseHeartbeat);
    }
    const lease = this.store.get(id);
    if (!lease) {
      return errAsync(notFoundError("ExecutionLease", id as string));
    }
    const now = this.clock();
    const nowIso = now.toISOString();
    if (lease.expiresAt <= nowIso) {
      return errAsync(
        conflictError("ExecutionLease", "Lease has expired", id as string),
      );
    }
    if (lease.ownerId !== ownerId) {
      return errAsync(
        conflictError(
          "ExecutionLease",
          "Lease is owned by a different owner",
          id as string,
        ),
      );
    }
    const renewed: ExecutionLease = {
      ...lease,
      lastHeartbeatAt: nowIso,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    this.store.set(id, renewed);
    return okAsync(renewed);
  }

  release(
    id: ExecutionLeaseId,
    ownerId: OwnerId,
  ): ResultAsync<void, RuntimeStoreError> {
    if (this.failures.leaseRelease) {
      return errAsync(this.failures.leaseRelease);
    }
    const lease = this.store.get(id);
    if (!lease) {
      return errAsync(notFoundError("ExecutionLease", id as string));
    }
    if (lease.ownerId !== ownerId) {
      return errAsync(
        conflictError(
          "ExecutionLease",
          "Lease is owned by a different owner",
          id as string,
        ),
      );
    }
    this.store.delete(id);
    return okAsync(undefined);
  }

  /** Snapshot current store state for transaction staging. */
  snapshot(): Map<string, ExecutionLease> {
    return new Map(this.store);
  }

  /** Restore store state from a snapshot (used for transaction rollback). */
  restore(snapshot: Map<string, ExecutionLease>): void {
    this.store.clear();
    for (const [k, v] of snapshot) {
      this.store.set(k, v);
    }
  }
}

// ---------------------------------------------------------------------------
// InMemorySessionSnapshotRepository
// ---------------------------------------------------------------------------

class InMemorySessionSnapshotRepository implements SessionSnapshotRepository {
  private readonly store = new Map<string, SessionSnapshot>();
  private failures: InMemoryRuntimeStoreFailureConfig;

  constructor(failures: InMemoryRuntimeStoreFailureConfig) {
    this.failures = failures;
  }

  /** Update the shared failure config reference. */
  setFailures(failures: InMemoryRuntimeStoreFailureConfig): void {
    this.failures = failures;
  }

  record(
    input: RecordSessionSnapshotInput,
  ): ResultAsync<SessionSnapshot, RuntimeStoreError> {
    if (this.failures.snapshotRecord) {
      return errAsync(this.failures.snapshotRecord);
    }
    const sanitizeResult = sanitizeSnapshotMetadata(input.metadata);
    if (sanitizeResult.isErr()) {
      return errAsync(sanitizeResult.error);
    }
    const snapshot: SessionSnapshot = {
      id: createSessionSnapshotId(newId()),
      workflowInstanceId: input.workflowInstanceId,
      leaseId: input.leaseId,
      harnessName: input.harnessName,
      ...(input.harnessVersion ? { harnessVersion: input.harnessVersion } : {}),
      agentName: input.agentName,
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.stepName ? { stepName: input.stepName } : {}),
      sessionStatus: input.sessionStatus,
      recordedAt: new Date().toISOString(),
      metadata: { ...sanitizeResult.value },
    };
    this.store.set(snapshot.id, snapshot);
    return okAsync(snapshot);
  }

  findById(
    id: SessionSnapshotId,
  ): ResultAsync<SessionSnapshot | null, RuntimeStoreError> {
    const snap = this.store.get(id) ?? null;
    return okAsync(snap);
  }

  getById(
    id: SessionSnapshotId,
  ): ResultAsync<SessionSnapshot, RuntimeStoreError> {
    const snap = this.store.get(id);
    if (!snap) {
      return errAsync(notFoundError("SessionSnapshot", id as string));
    }
    return okAsync(snap);
  }

  listByWorkflowInstance(
    workflowInstanceId: WorkflowInstanceId,
  ): ResultAsync<readonly SessionSnapshot[], RuntimeStoreError> {
    const snaps = Array.from(this.store.values())
      .filter((s) => s.workflowInstanceId === workflowInstanceId)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    return okAsync(snaps);
  }

  findLatestByWorkflowInstance(
    workflowInstanceId: WorkflowInstanceId,
  ): ResultAsync<SessionSnapshot | null, RuntimeStoreError> {
    const snaps = Array.from(this.store.values())
      .filter((s) => s.workflowInstanceId === workflowInstanceId)
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
    return okAsync(snaps[0] ?? null);
  }

  /** Snapshot current store state for transaction staging. */
  snapshot(): Map<string, SessionSnapshot> {
    return new Map(this.store);
  }

  /** Restore store state from a snapshot (used for transaction rollback). */
  restore(snapshot: Map<string, SessionSnapshot>): void {
    this.store.clear();
    for (const [k, v] of snapshot) {
      this.store.set(k, v);
    }
  }
}

// ---------------------------------------------------------------------------
// InMemoryRuntimeJournalRepository
// ---------------------------------------------------------------------------

class InMemoryRuntimeJournalRepository implements RuntimeJournalRepository {
  private readonly store = new Map<string, RuntimeJournalEntry>();
  private failures: InMemoryRuntimeStoreFailureConfig;

  constructor(failures: InMemoryRuntimeStoreFailureConfig) {
    this.failures = failures;
  }

  /** Update the shared failure config reference. */
  setFailures(failures: InMemoryRuntimeStoreFailureConfig): void {
    this.failures = failures;
  }

  append(
    entry: Omit<RuntimeJournalEntry, "id" | "timestamp">,
  ): ResultAsync<RuntimeJournalEntry, RuntimeStoreError> {
    if (this.failures.journalAppend) {
      return errAsync(this.failures.journalAppend);
    }
    const full: RuntimeJournalEntry = {
      ...entry,
      id: createRuntimeJournalEntryId(newId()),
      timestamp: new Date().toISOString(),
    };
    this.store.set(full.id, full);
    return okAsync(full);
  }

  findById(
    id: RuntimeJournalEntryId,
  ): ResultAsync<RuntimeJournalEntry | null, RuntimeStoreError> {
    const entry = this.store.get(id) ?? null;
    return okAsync(entry);
  }

  getById(
    id: RuntimeJournalEntryId,
  ): ResultAsync<RuntimeJournalEntry, RuntimeStoreError> {
    const entry = this.store.get(id);
    if (!entry) {
      return errAsync(notFoundError("RuntimeJournalEntry", id as string));
    }
    return okAsync(entry);
  }

  query(
    filter?: JournalQueryFilter,
  ): ResultAsync<readonly RuntimeJournalEntry[], RuntimeStoreError> {
    let entries = Array.from(this.store.values()).sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp),
    );
    if (filter?.workflowInstanceId) {
      entries = entries.filter(
        (e) => e.workflowInstanceId === filter.workflowInstanceId,
      );
    }
    if (filter?.executionId) {
      entries = entries.filter((e) => e.executionId === filter.executionId);
    }
    if (filter?.sourceKind) {
      entries = entries.filter((e) => e.source.kind === filter.sourceKind);
    }
    if (filter?.sourceName) {
      entries = entries.filter((e) => e.source.name === filter.sourceName);
    }
    if (filter?.eventType) {
      entries = entries.filter((e) => e.eventType === filter.eventType);
    }
    if (filter?.severity) {
      entries = entries.filter((e) => e.severity === filter.severity);
    }
    if (filter?.after) {
      const after = filter.after;
      entries = entries.filter((e) => e.timestamp > after);
    }
    if (filter?.before) {
      const before = filter.before;
      entries = entries.filter((e) => e.timestamp < before);
    }
    if (filter?.limit) {
      entries = entries.slice(0, filter.limit);
    }
    return okAsync(entries);
  }

  /** Snapshot current store state for transaction staging. */
  snapshot(): Map<string, RuntimeJournalEntry> {
    return new Map(this.store);
  }

  /** Restore store state from a snapshot (used for transaction rollback). */
  restore(snapshot: Map<string, RuntimeJournalEntry>): void {
    this.store.clear();
    for (const [k, v] of snapshot) {
      this.store.set(k, v);
    }
  }
}

// ---------------------------------------------------------------------------
// InMemoryRuntimeStore
// ---------------------------------------------------------------------------

/**
 * In-memory implementation of `RuntimeStore`.
 *
 * Uses `Map<string, T>` collections for each entity type.
 * Transactions collect operations in a staging area and commit atomically
 * on success, or discard on failure.
 *
 * Supports configurable failure injection via `failureConfig`.
 */
// ---------------------------------------------------------------------------
// InMemoryJournalWriterRepository
// ---------------------------------------------------------------------------

/**
 * Adapts a `RuntimeJournalWriter` to the `RuntimeJournalRepository` interface
 * for use inside an `InMemoryRuntimeStore` transaction.
 *
 * In best-effort mode, journal append failures are swallowed so the
 * surrounding transaction can commit. In strict mode, failures propagate
 * and cause the transaction to roll back.
 */
class InMemoryJournalWriterRepository implements RuntimeJournalRepository {
  private readonly writer: RuntimeJournalWriter;

  constructor(
    private readonly inner: InMemoryRuntimeJournalRepository,
    strictMode: boolean,
  ) {
    this.writer = new RuntimeJournalWriter(inner, { strictMode });
  }

  append(
    entry: Omit<RuntimeJournalEntry, "id" | "timestamp">,
  ): ResultAsync<RuntimeJournalEntry, RuntimeStoreError> {
    return this.writer
      .write({
        source: entry.source,
        eventType: entry.eventType,
        executionId: entry.executionId,
        workflowInstanceId: entry.workflowInstanceId,
        stepId: entry.stepId,
        severity: entry.severity,
        data: entry.data as JsonObject,
      })
      .andThen((result) => {
        if (result === undefined) {
          // Best-effort mode swallowed the error — return a synthetic entry
          const synthetic: RuntimeJournalEntry = {
            id: createRuntimeJournalEntryId("swallowed"),
            timestamp: new Date().toISOString(),
            source: entry.source,
            eventType: entry.eventType,
            severity: entry.severity,
            data: entry.data as JsonObject,
          };
          return okAsync(synthetic);
        }
        return okAsync(result);
      });
  }

  findById(
    id: RuntimeJournalEntryId,
  ): ResultAsync<RuntimeJournalEntry | null, RuntimeStoreError> {
    return this.inner.findById(id);
  }

  getById(
    id: RuntimeJournalEntryId,
  ): ResultAsync<RuntimeJournalEntry, RuntimeStoreError> {
    return this.inner.getById(id);
  }

  query(
    filter?: JournalQueryFilter,
  ): ResultAsync<readonly RuntimeJournalEntry[], RuntimeStoreError> {
    return this.inner.query(filter);
  }
}

// ---------------------------------------------------------------------------
// InMemoryRuntimeStore
// ---------------------------------------------------------------------------

export class InMemoryRuntimeStore implements RuntimeStore {
  readonly instances: InMemoryWorkflowInstanceRepository;
  readonly leases: InMemoryExecutionLeaseRepository;
  readonly snapshots: InMemorySessionSnapshotRepository;
  readonly journal: InMemoryRuntimeJournalRepository;

  private readonly clock: () => Date;
  private readonly strictJournal: boolean;

  /**
   * Mutable failure injection config.
   * Set fields to inject errors for specific operations.
   * Clear fields (set to `undefined`) to stop injecting.
   */
  failureConfig: InMemoryRuntimeStoreFailureConfig;

  constructor(options: InMemoryRuntimeStoreOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.strictJournal = options.strictJournal ?? false;
    this.failureConfig = { ...(options.failOn ?? {}) };

    this.instances = new InMemoryWorkflowInstanceRepository(this.failureConfig);
    this.leases = new InMemoryExecutionLeaseRepository(
      this.failureConfig,
      this.clock,
    );
    this.snapshots = new InMemorySessionSnapshotRepository(this.failureConfig);
    this.journal = new InMemoryRuntimeJournalRepository(this.failureConfig);
  }

  /**
   * Update failure injection config and propagate to all repositories.
   */
  setFailures(config: InMemoryRuntimeStoreFailureConfig): void {
    this.failureConfig = config;
    this.instances.setFailures(config);
    this.leases.setFailures(config);
    this.snapshots.setFailures(config);
    this.journal.setFailures(config);
  }

  transaction<T>(
    callback: TransactionCallback<T>,
  ): ResultAsync<T, RuntimeStoreError> {
    if (this.failureConfig.transaction) {
      return errAsync(this.failureConfig.transaction);
    }

    // Snapshot all repository state before the transaction
    const instancesSnap = this.instances.snapshot();
    const leasesSnap = this.leases.snapshot();
    const snapshotsSnap = this.snapshots.snapshot();
    const journalSnap = this.journal.snapshot();

    // Wrap the journal with a writer that enforces strict/best-effort semantics
    const journalForTx = new InMemoryJournalWriterRepository(
      this.journal,
      this.strictJournal,
    );

    const tx: RuntimeStoreTransaction = {
      instances: this.instances,
      leases: this.leases,
      snapshots: this.snapshots,
      journal: journalForTx,
    };

    return ResultAsync.fromPromise(Promise.resolve(callback(tx)), (cause) =>
      queryError("Transaction callback threw unexpectedly", cause),
    ).andThen((result) => {
      if (result.isErr()) {
        // Rollback: restore all snapshots
        this.instances.restore(instancesSnap);
        this.leases.restore(leasesSnap);
        this.snapshots.restore(snapshotsSnap);
        this.journal.restore(journalSnap);
        return errAsync(result.error);
      }
      // Commit: changes are already applied in-place
      return okAsync(result.value);
    });
  }

  close(): ResultAsync<void, RuntimeStoreError> {
    if (this.failureConfig.close) {
      return errAsync(this.failureConfig.close);
    }
    return okAsync(undefined);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new in-memory Runtime Store for use in tests.
 *
 * The store is immediately ready — no initialization, no filesystem access.
 *
 * @example
 * ```ts
 * import { createInMemoryRuntimeStore } from "@weave/engine";
 *
 * const store = createInMemoryRuntimeStore();
 * const result = await store.instances.create({ ... });
 * ```
 *
 * @example Failure injection
 * ```ts
 * const store = createInMemoryRuntimeStore({
 *   failOn: { leaseAcquire: conflictError("ExecutionLease", "injected") }
 * });
 * ```
 */
export function createInMemoryRuntimeStore(
  options: InMemoryRuntimeStoreOptions = {},
): InMemoryRuntimeStore {
  return new InMemoryRuntimeStore(options);
}
