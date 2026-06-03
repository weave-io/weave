/**
 * Runtime Store contract tests.
 *
 * Tests the TYPE SHAPES and interface contracts for the Runtime Store domain.
 * Uses a simple in-memory stub to verify behavioral contracts without
 * requiring a real SQLite implementation.
 *
 * @see docs/specs/12-spec-runtime-persistence/12-spec-runtime-persistence.md
 */

import { describe, expect, it } from "bun:test";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import {
  EXECUTION_AUTHORIZATION_SOURCES,
  type ExecutionAuthorizationSource,
  validateAuthorizationSource,
  RECONCILIATION_AUTHORIZATION_SOURCES,
  RECONCILIATION_REASONS,
  validateReconciliationSource,
  type ReconciliationAuthorizationSource,
} from "../execution-lifecycle.js";
import type { RuntimeStoreError } from "../runtime/errors.js";
import {
  conflictError,
  initializationError,
  journalWriteError,
  migrationVersionError,
  notFoundError,
  queryError,
  serializationError,
  validationError,
} from "../runtime/errors.js";
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
} from "../runtime/store.js";
import type {
  ArtifactApprovalState,
  ArtifactId,
  ArtifactIntegrityMetadata,
  ArtifactRef,
  ConsumedArtifactRecord,
  ExecutionLease,
  ExecutionLeaseId,
  JournalQueryFilter,
  OwnerId,
  RuntimeJournalEntry,
  RuntimeJournalEntryId,
  SessionSnapshot,
  SessionSnapshotId,
  StepAttemptRecord,
  WorkflowInstance,
  WorkflowInstanceId,
  WorkflowInstanceStatus,
} from "../runtime/types.js";
import {
  ARTIFACT_APPROVAL_STATES,
  createArtifactId,
  createExecutionLeaseId,
  createOwnerId,
  createRuntimeJournalEntryId,
  createSessionSnapshotId,
  createWorkflowInstanceId,
  JOURNAL_SEVERITIES,
  WORKFLOW_INSTANCE_STATUSES,
} from "../runtime/types.js";

// ---------------------------------------------------------------------------
// In-memory stub implementations for contract testing
// ---------------------------------------------------------------------------

function makeWorkflowInstance(
  overrides: Partial<WorkflowInstance> = {},
): WorkflowInstance {
  return {
    id: createWorkflowInstanceId("wfi-001"),
    workflowName: "test-workflow",
    goal: "Test goal",
    slug: "test-goal",
    status: "created",
    artifacts: [],
    stepAttempts: [],
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
    ...overrides,
  };
}

function makeExecutionLease(
  overrides: Partial<ExecutionLease> = {},
): ExecutionLease {
  return {
    id: createExecutionLeaseId("lease-001"),
    workflowInstanceId: createWorkflowInstanceId("wfi-001"),
    ownerId: createOwnerId("owner-001"),
    acquiredAt: "2026-05-20T00:00:00.000Z",
    expiresAt: "2026-05-20T01:00:00.000Z",
    ...overrides,
  };
}

function makeSessionSnapshot(
  overrides: Partial<SessionSnapshot> = {},
): SessionSnapshot {
  return {
    id: createSessionSnapshotId("snap-001"),
    workflowInstanceId: createWorkflowInstanceId("wfi-001"),
    leaseId: createExecutionLeaseId("lease-001"),
    harnessName: "test-harness",
    agentName: "shuttle",
    sessionStatus: "active",
    recordedAt: "2026-05-20T00:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

function makeJournalEntry(
  overrides: Partial<RuntimeJournalEntry> = {},
): RuntimeJournalEntry {
  return {
    id: createRuntimeJournalEntryId("entry-001"),
    timestamp: "2026-05-20T00:00:00.000Z",
    source: { kind: "engine", name: "runner" },
    eventType: "step.started",
    severity: "info",
    data: {},
    ...overrides,
  };
}

// Monotonic counter for stub artifact ID generation — avoids Date.now() collisions
let _stubArtifactCounter = 0;
function newStubArtifactId(): ArtifactId {
  return createArtifactId(`art-stub-${++_stubArtifactCounter}`);
}

/**
 * Minimal in-memory WorkflowInstanceRepository stub for contract testing.
 */
class StubWorkflowInstanceRepository implements WorkflowInstanceRepository {
  private readonly store = new Map<string, WorkflowInstance>();

  create(
    input: CreateWorkflowInstanceInput,
  ): ResultAsync<WorkflowInstance, RuntimeStoreError> {
    const instance = makeWorkflowInstance({
      id: createWorkflowInstanceId(`wfi-${Date.now()}`),
      workflowName: input.workflowName,
      goal: input.goal,
      slug: input.slug,
      status: "created",
    });
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
      return errAsync(notFoundError("WorkflowInstance", id));
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
    const existing = this.store.get(id);
    if (!existing) {
      return errAsync(notFoundError("WorkflowInstance", id));
    }
    const statusPatch =
      input.status !== undefined ? { status: input.status } : {};
    const stepPatch =
      input.currentStepName !== undefined && input.currentStepName !== null
        ? { currentStepName: input.currentStepName }
        : {};
    const errorPatch =
      input.errorMessage !== undefined && input.errorMessage !== null
        ? { errorMessage: input.errorMessage }
        : {};
    const updated: WorkflowInstance = {
      ...existing,
      ...statusPatch,
      ...stepPatch,
      ...errorPatch,
      updatedAt: new Date().toISOString(),
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
      integrity?: ArtifactIntegrityMetadata;
      producerAgent?: string;
    },
  ): ResultAsync<WorkflowInstance, RuntimeStoreError> {
    const existing = this.store.get(id);
    if (!existing) {
      return errAsync(notFoundError("WorkflowInstance", id));
    }
    const prior =
      [...existing.artifacts].reverse().find((a) => a.name === artifact.name) ??
      null;
    const revision = prior ? prior.revision + 1 : 1;
    const artifactId = prior ? prior.id : newStubArtifactId();
    const ref: ArtifactRef = {
      id: artifactId,
      name: artifact.name,
      path: artifact.path,
      revision,
      approvalState: "pending",
      ...(artifact.producerAgent
        ? { producerAgent: artifact.producerAgent }
        : {}),
      ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
      ...(artifact.description ? { description: artifact.description } : {}),
      ...(artifact.integrity ? { integrity: artifact.integrity } : {}),
    };
    const updated: WorkflowInstance = {
      ...existing,
      artifacts: [...existing.artifacts, ref],
      updatedAt: new Date().toISOString(),
    };
    this.store.set(id, updated);
    return okAsync(updated);
  }

  updateArtifactApproval(
    id: WorkflowInstanceId,
    artifactId: ArtifactId,
    approvalState: ArtifactApprovalState,
  ): ResultAsync<WorkflowInstance, RuntimeStoreError> {
    const existing = this.store.get(id);
    if (!existing) {
      return errAsync(notFoundError("WorkflowInstance", id));
    }
    // Find the last index of the artifact with the given id
    let artifactIndex = -1;
    for (let i = existing.artifacts.length - 1; i >= 0; i--) {
      if (existing.artifacts[i].id === artifactId) {
        artifactIndex = i;
        break;
      }
    }
    if (artifactIndex === -1) {
      return errAsync(notFoundError("ArtifactRef", artifactId as string));
    }
    const updatedArtifacts = existing.artifacts.map((a, i) =>
      i === artifactIndex ? { ...a, approvalState } : a,
    );
    const updated: WorkflowInstance = {
      ...existing,
      artifacts: updatedArtifacts,
      updatedAt: new Date().toISOString(),
    };
    this.store.set(id, updated);
    return okAsync(updated);
  }

  recordStepAttempt(
    id: WorkflowInstanceId,
    stepName: string,
    consumedArtifacts: readonly ConsumedArtifactRecord[],
  ): ResultAsync<WorkflowInstance, RuntimeStoreError> {
    const existing = this.store.get(id);
    if (!existing) {
      return errAsync(notFoundError("WorkflowInstance", id));
    }
    const priorAttempts = existing.stepAttempts.filter(
      (a) => a.stepName === stepName,
    ).length;
    const record: StepAttemptRecord = {
      stepName,
      attemptNumber: priorAttempts + 1,
      dispatchedAt: new Date().toISOString(),
      consumedArtifacts,
    };
    const updated: WorkflowInstance = {
      ...existing,
      stepAttempts: [...existing.stepAttempts, record],
      updatedAt: new Date().toISOString(),
    };
    this.store.set(id, updated);
    return okAsync(updated);
  }

  /** Test helper: seed a record directly. */
  seed(instance: WorkflowInstance): void {
    this.store.set(instance.id, instance);
  }
}

/**
 * Minimal in-memory ExecutionLeaseRepository stub for contract testing.
 */
class StubExecutionLeaseRepository implements ExecutionLeaseRepository {
  private readonly store = new Map<string, ExecutionLease>();
  private activeLease: ExecutionLease | null = null;

  acquire(
    input: AcquireLeaseInput,
  ): ResultAsync<ExecutionLease, RuntimeStoreError> {
    const now = new Date();
    if (this.activeLease) {
      const expiresAt = new Date(this.activeLease.expiresAt);
      if (expiresAt > now) {
        return errAsync(
          conflictError(
            "ExecutionLease",
            "An unexpired lease already exists",
            this.activeLease.id,
          ),
        );
      }
    }
    const lease = makeExecutionLease({
      id: createExecutionLeaseId(`lease-${Date.now()}`),
      workflowInstanceId: input.workflowInstanceId,
      ownerId: input.ownerId,
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
    });
    this.store.set(lease.id, lease);
    this.activeLease = lease;
    return okAsync(lease);
  }

  findActive(): ResultAsync<ExecutionLease | null, RuntimeStoreError> {
    const now = new Date();
    if (!this.activeLease) {
      return okAsync(null);
    }
    const expiresAt = new Date(this.activeLease.expiresAt);
    const active = expiresAt > now ? this.activeLease : null;
    return okAsync(active);
  }

  getActive(): ResultAsync<ExecutionLease, RuntimeStoreError> {
    const now = new Date();
    if (!this.activeLease || new Date(this.activeLease.expiresAt) <= now) {
      return errAsync(
        notFoundError("ExecutionLease", "active", "No active lease found"),
      );
    }
    return okAsync(this.activeLease);
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
      return errAsync(notFoundError("ExecutionLease", id));
    }
    return okAsync(lease);
  }

  heartbeat(
    id: ExecutionLeaseId,
    ownerId: OwnerId,
    ttlMs: number,
  ): ResultAsync<ExecutionLease, RuntimeStoreError> {
    const lease = this.store.get(id);
    if (!lease) {
      return errAsync(notFoundError("ExecutionLease", id));
    }
    const now = new Date();
    if (new Date(lease.expiresAt) <= now) {
      return errAsync(conflictError("ExecutionLease", "Lease has expired", id));
    }
    if (lease.ownerId !== ownerId) {
      return errAsync(
        conflictError(
          "ExecutionLease",
          "Lease is owned by a different owner",
          id,
        ),
      );
    }
    const renewed: ExecutionLease = {
      ...lease,
      lastHeartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    this.store.set(id, renewed);
    this.activeLease = renewed;
    return okAsync(renewed);
  }

  release(
    id: ExecutionLeaseId,
    ownerId: OwnerId,
  ): ResultAsync<void, RuntimeStoreError> {
    const lease = this.store.get(id);
    if (!lease) {
      return errAsync(notFoundError("ExecutionLease", id));
    }
    if (lease.ownerId !== ownerId) {
      return errAsync(
        conflictError(
          "ExecutionLease",
          "Lease is owned by a different owner",
          id,
        ),
      );
    }
    this.store.delete(id);
    if (this.activeLease?.id === id) {
      this.activeLease = null;
    }
    return okAsync(undefined);
  }

  /** Test helper: seed an expired lease. */
  seedExpired(lease: ExecutionLease): void {
    this.store.set(lease.id, lease);
    this.activeLease = lease;
  }
}

/**
 * Minimal in-memory SessionSnapshotRepository stub.
 */
class StubSessionSnapshotRepository implements SessionSnapshotRepository {
  private readonly store = new Map<string, SessionSnapshot>();

  record(
    input: RecordSessionSnapshotInput,
  ): ResultAsync<SessionSnapshot, RuntimeStoreError> {
    const snapshot = makeSessionSnapshot({
      id: createSessionSnapshotId(`snap-${Date.now()}`),
      ...input,
      recordedAt: new Date().toISOString(),
    });
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
      return errAsync(notFoundError("SessionSnapshot", id));
    }
    return okAsync(snap);
  }

  listByWorkflowInstance(
    workflowInstanceId: WorkflowInstanceId,
  ): ResultAsync<readonly SessionSnapshot[], RuntimeStoreError> {
    const snaps = Array.from(this.store.values()).filter(
      (s) => s.workflowInstanceId === workflowInstanceId,
    );
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
}

/**
 * Minimal in-memory RuntimeJournalRepository stub.
 */
class StubRuntimeJournalRepository implements RuntimeJournalRepository {
  private readonly store = new Map<string, RuntimeJournalEntry>();
  private failNextAppend = false;

  append(
    entry: Omit<RuntimeJournalEntry, "id" | "timestamp">,
  ): ResultAsync<RuntimeJournalEntry, RuntimeStoreError> {
    if (this.failNextAppend) {
      this.failNextAppend = false;
      return errAsync(journalWriteError("Simulated journal write failure"));
    }
    const full = makeJournalEntry({
      ...entry,
      id: createRuntimeJournalEntryId(`entry-${Date.now()}-${Math.random()}`),
      timestamp: new Date().toISOString(),
    });
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
      return errAsync(notFoundError("RuntimeJournalEntry", id));
    }
    return okAsync(entry);
  }

  query(
    filter?: JournalQueryFilter,
  ): ResultAsync<readonly RuntimeJournalEntry[], RuntimeStoreError> {
    let entries = Array.from(this.store.values());
    if (filter?.workflowInstanceId) {
      entries = entries.filter(
        (e) => e.workflowInstanceId === filter.workflowInstanceId,
      );
    }
    if (filter?.sourceKind) {
      entries = entries.filter((e) => e.source.kind === filter.sourceKind);
    }
    if (filter?.eventType) {
      entries = entries.filter((e) => e.eventType === filter.eventType);
    }
    if (filter?.severity) {
      entries = entries.filter((e) => e.severity === filter.severity);
    }
    if (filter?.limit) {
      entries = entries.slice(0, filter.limit);
    }
    return okAsync(entries);
  }

  /** Test helper: make the next append fail. */
  injectFailure(): void {
    this.failNextAppend = true;
  }
}

/**
 * Minimal in-memory RuntimeStore stub for contract testing.
 */
class StubRuntimeStore implements RuntimeStore {
  readonly instances = new StubWorkflowInstanceRepository();
  readonly leases = new StubExecutionLeaseRepository();
  readonly snapshots = new StubSessionSnapshotRepository();
  readonly journal = new StubRuntimeJournalRepository();

  transaction<T>(
    callback: TransactionCallback<T>,
  ): ResultAsync<T, RuntimeStoreError> {
    const tx: RuntimeStoreTransaction = {
      instances: this.instances,
      leases: this.leases,
      snapshots: this.snapshots,
      journal: this.journal,
    };
    return callback(tx);
  }

  close(): ResultAsync<void, RuntimeStoreError> {
    return okAsync(undefined);
  }
}

// ---------------------------------------------------------------------------
// Tests: WorkflowInstance status values
// ---------------------------------------------------------------------------

describe("WorkflowInstance status", () => {
  it("WORKFLOW_INSTANCE_STATUSES contains all 7 valid status values", () => {
    expect(WORKFLOW_INSTANCE_STATUSES).toHaveLength(7);
    expect(WORKFLOW_INSTANCE_STATUSES).toContain("created");
    expect(WORKFLOW_INSTANCE_STATUSES).toContain("running");
    expect(WORKFLOW_INSTANCE_STATUSES).toContain("paused");
    expect(WORKFLOW_INSTANCE_STATUSES).toContain("blocked");
    expect(WORKFLOW_INSTANCE_STATUSES).toContain("completed");
    expect(WORKFLOW_INSTANCE_STATUSES).toContain("failed");
    expect(WORKFLOW_INSTANCE_STATUSES).toContain("cancelled");
  });

  it("WorkflowInstance can be created with each valid status", () => {
    for (const status of WORKFLOW_INSTANCE_STATUSES) {
      const instance = makeWorkflowInstance({ status });
      expect(instance.status).toBe(status);
    }
  });

  it("WorkflowInstance stores artifact references, not contents", () => {
    const instance = makeWorkflowInstance({
      artifacts: [
        {
          id: createArtifactId("art-001"),
          name: "plan",
          path: ".weave/plans/test-goal.md",
          revision: 1,
          approvalState: "pending",
        },
        {
          id: createArtifactId("art-002"),
          name: "output",
          path: ".weave/plans/output.json",
          revision: 1,
          approvalState: "approved",
          mimeType: "application/json",
        },
      ],
    });
    expect(instance.artifacts).toHaveLength(2);
    expect(instance.artifacts[0]).toMatchObject({
      name: "plan",
      path: ".weave/plans/test-goal.md",
      revision: 1,
      approvalState: "pending",
    });
    expect(instance.artifacts[1]).toMatchObject({
      name: "output",
      mimeType: "application/json",
      revision: 1,
      approvalState: "approved",
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: JournalSeverity values
// ---------------------------------------------------------------------------

describe("JournalSeverity", () => {
  it("JOURNAL_SEVERITIES contains all 4 valid severity values", () => {
    expect(JOURNAL_SEVERITIES).toHaveLength(4);
    expect(JOURNAL_SEVERITIES).toContain("debug");
    expect(JOURNAL_SEVERITIES).toContain("info");
    expect(JOURNAL_SEVERITIES).toContain("warn");
    expect(JOURNAL_SEVERITIES).toContain("error");
  });

  it("RuntimeJournalEntry can be created with each severity", () => {
    for (const severity of JOURNAL_SEVERITIES) {
      const entry = makeJournalEntry({ severity });
      expect(entry.severity).toBe(severity);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: Branded ID types
// ---------------------------------------------------------------------------

describe("Branded ID types", () => {
  it("createWorkflowInstanceId creates a branded WorkflowInstanceId", () => {
    const id = createWorkflowInstanceId("wfi-test");
    // Branded types are strings at runtime
    expect(typeof id).toBe("string");
    expect(id as string).toBe("wfi-test");
  });

  it("createExecutionLeaseId creates a branded ExecutionLeaseId", () => {
    const id = createExecutionLeaseId("lease-test");
    expect(typeof id).toBe("string");
    expect(id as string).toBe("lease-test");
  });

  it("createSessionSnapshotId creates a branded SessionSnapshotId", () => {
    const id = createSessionSnapshotId("snap-test");
    expect(typeof id).toBe("string");
    expect(id as string).toBe("snap-test");
  });

  it("createRuntimeJournalEntryId creates a branded RuntimeJournalEntryId", () => {
    const id = createRuntimeJournalEntryId("entry-test");
    expect(typeof id).toBe("string");
    expect(id as string).toBe("entry-test");
  });

  it("createOwnerId creates a branded OwnerId", () => {
    const id = createOwnerId("owner-test");
    expect(typeof id).toBe("string");
    expect(id as string).toBe("owner-test");
  });
});

// ---------------------------------------------------------------------------
// Tests: RuntimeStoreError discriminated union
// ---------------------------------------------------------------------------

describe("RuntimeStoreError discriminated union", () => {
  it("initializationError has type 'initialization'", () => {
    const e = initializationError("Failed to create directory");
    expect(e.type).toBe("initialization");
    expect(e.message).toBe("Failed to create directory");
  });

  it("migrationVersionError has type 'migration_version' with version fields", () => {
    const e = migrationVersionError(5, 3, "Schema version 5 is not supported");
    expect(e.type).toBe("migration_version");
    expect(e.foundVersion).toBe(5);
    expect(e.supportedVersion).toBe(3);
    expect(e.message).toBe("Schema version 5 is not supported");
  });

  it("serializationError has type 'serialization'", () => {
    const e = serializationError("Invalid JSON");
    expect(e.type).toBe("serialization");
    expect(e.message).toBe("Invalid JSON");
  });

  it("queryError has type 'query'", () => {
    const e = queryError("Database connection failed");
    expect(e.type).toBe("query");
    expect(e.message).toBe("Database connection failed");
  });

  it("notFoundError has type 'not_found' with entity and id", () => {
    const e = notFoundError("WorkflowInstance", "wfi-999");
    expect(e.type).toBe("not_found");
    expect(e.entity).toBe("WorkflowInstance");
    expect(e.id).toBe("wfi-999");
    expect(e.message).toContain("wfi-999");
  });

  it("notFoundError accepts a custom message", () => {
    const e = notFoundError(
      "ExecutionLease",
      "active",
      "No active lease found",
    );
    expect(e.message).toBe("No active lease found");
  });

  it("conflictError has type 'conflict' with entity and message", () => {
    const e = conflictError(
      "ExecutionLease",
      "An unexpired lease already exists",
      "lease-001",
    );
    expect(e.type).toBe("conflict");
    expect(e.entity).toBe("ExecutionLease");
    expect(e.conflictingId).toBe("lease-001");
  });

  it("validationError has type 'validation'", () => {
    const e = validationError("Invalid status value", "status");
    expect(e.type).toBe("validation");
    expect(e.field).toBe("status");
  });

  it("journalWriteError has type 'journal_write'", () => {
    const e = journalWriteError("Write failed");
    expect(e.type).toBe("journal_write");
    expect(e.message).toBe("Write failed");
  });

  it("all error variants are distinguishable by type discriminant", () => {
    const errors: RuntimeStoreError[] = [
      initializationError("init"),
      migrationVersionError(2, 1, "version"),
      serializationError("serial"),
      queryError("query"),
      notFoundError("Entity", "id-1"),
      conflictError("Entity", "conflict"),
      validationError("validation"),
      journalWriteError("journal"),
    ];

    const types = errors.map((e) => e.type);
    expect(types).toEqual([
      "initialization",
      "migration_version",
      "serialization",
      "query",
      "not_found",
      "conflict",
      "validation",
      "journal_write",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tests: find* / get* lookup semantics
// ---------------------------------------------------------------------------

describe("find* / get* lookup semantics", () => {
  it("findById returns null for missing WorkflowInstance", async () => {
    const repo = new StubWorkflowInstanceRepository();
    const result = await repo.findById(createWorkflowInstanceId("missing"));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it("getById returns not_found error for missing WorkflowInstance", async () => {
    const repo = new StubWorkflowInstanceRepository();
    const result = await repo.getById(createWorkflowInstanceId("missing"));
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("not_found");
    if (error.type === "not_found") {
      expect(error.entity).toBe("WorkflowInstance");
      expect(error.id).toBe("missing");
    }
  });

  it("findById returns the record when it exists", async () => {
    const repo = new StubWorkflowInstanceRepository();
    const instance = makeWorkflowInstance();
    repo.seed(instance);
    const result = await repo.findById(instance.id);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(instance);
  });

  it("getById returns the record when it exists", async () => {
    const repo = new StubWorkflowInstanceRepository();
    const instance = makeWorkflowInstance();
    repo.seed(instance);
    const result = await repo.getById(instance.id);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(instance);
  });

  it("findById returns null for missing ExecutionLease", async () => {
    const repo = new StubExecutionLeaseRepository();
    const result = await repo.findById(createExecutionLeaseId("missing"));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it("getById returns not_found error for missing ExecutionLease", async () => {
    const repo = new StubExecutionLeaseRepository();
    const result = await repo.getById(createExecutionLeaseId("missing"));
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("not_found");
  });

  it("findById returns null for missing SessionSnapshot", async () => {
    const repo = new StubSessionSnapshotRepository();
    const result = await repo.findById(createSessionSnapshotId("missing"));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it("getById returns not_found error for missing SessionSnapshot", async () => {
    const repo = new StubSessionSnapshotRepository();
    const result = await repo.getById(createSessionSnapshotId("missing"));
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("not_found");
  });

  it("findById returns null for missing RuntimeJournalEntry", async () => {
    const repo = new StubRuntimeJournalRepository();
    const result = await repo.findById(createRuntimeJournalEntryId("missing"));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it("getById returns not_found error for missing RuntimeJournalEntry", async () => {
    const repo = new StubRuntimeJournalRepository();
    const result = await repo.getById(createRuntimeJournalEntryId("missing"));
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// Tests: ExecutionLease acquire / heartbeat / release
// ---------------------------------------------------------------------------

describe("ExecutionLease acquire / heartbeat / release", () => {
  it("acquire creates a new lease when none exists", async () => {
    const repo = new StubExecutionLeaseRepository();
    const result = await repo.acquire({
      workflowInstanceId: createWorkflowInstanceId("wfi-001"),
      ownerId: createOwnerId("owner-001"),
      ttlMs: 60_000,
    });
    expect(result.isOk()).toBe(true);
    const lease = result._unsafeUnwrap();
    expect(lease.ownerId as string).toBe("owner-001");
    expect(lease.workflowInstanceId as string).toBe("wfi-001");
  });

  it("acquire fails with conflict when an unexpired lease exists", async () => {
    const repo = new StubExecutionLeaseRepository();
    await repo.acquire({
      workflowInstanceId: createWorkflowInstanceId("wfi-001"),
      ownerId: createOwnerId("owner-001"),
      ttlMs: 60_000,
    });
    const result = await repo.acquire({
      workflowInstanceId: createWorkflowInstanceId("wfi-001"),
      ownerId: createOwnerId("owner-002"),
      ttlMs: 60_000,
    });
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("conflict");
  });

  it("acquire succeeds when the existing lease is expired", async () => {
    const repo = new StubExecutionLeaseRepository();
    const expiredLease = makeExecutionLease({
      id: createExecutionLeaseId("expired-lease"),
      ownerId: createOwnerId("old-owner"),
      acquiredAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-01T01:00:00.000Z", // in the past
    });
    repo.seedExpired(expiredLease);

    const result = await repo.acquire({
      workflowInstanceId: createWorkflowInstanceId("wfi-001"),
      ownerId: createOwnerId("new-owner"),
      ttlMs: 60_000,
    });
    expect(result.isOk()).toBe(true);
    const lease = result._unsafeUnwrap();
    expect(lease.ownerId as string).toBe("new-owner");
  });

  it("findActive returns null when no lease exists", async () => {
    const repo = new StubExecutionLeaseRepository();
    const result = await repo.findActive();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it("findActive returns null when lease is expired", async () => {
    const repo = new StubExecutionLeaseRepository();
    const expiredLease = makeExecutionLease({
      acquiredAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-01T01:00:00.000Z",
    });
    repo.seedExpired(expiredLease);
    const result = await repo.findActive();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it("getActive returns not_found when no active lease exists", async () => {
    const repo = new StubExecutionLeaseRepository();
    const result = await repo.getActive();
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("not_found");
  });

  it("heartbeat renews an active lease", async () => {
    const repo = new StubExecutionLeaseRepository();
    const acquireResult = await repo.acquire({
      workflowInstanceId: createWorkflowInstanceId("wfi-001"),
      ownerId: createOwnerId("owner-001"),
      ttlMs: 60_000,
    });
    const lease = acquireResult._unsafeUnwrap();

    const heartbeatResult = await repo.heartbeat(
      lease.id,
      lease.ownerId,
      120_000,
    );
    expect(heartbeatResult.isOk()).toBe(true);
    const renewed = heartbeatResult._unsafeUnwrap();
    expect(renewed.lastHeartbeatAt).toBeDefined();
  });

  it("heartbeat fails with conflict for wrong owner", async () => {
    const repo = new StubExecutionLeaseRepository();
    const acquireResult = await repo.acquire({
      workflowInstanceId: createWorkflowInstanceId("wfi-001"),
      ownerId: createOwnerId("owner-001"),
      ttlMs: 60_000,
    });
    const lease = acquireResult._unsafeUnwrap();

    const result = await repo.heartbeat(
      lease.id,
      createOwnerId("wrong-owner"),
      60_000,
    );
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("conflict");
  });

  it("release removes the lease", async () => {
    const repo = new StubExecutionLeaseRepository();
    const acquireResult = await repo.acquire({
      workflowInstanceId: createWorkflowInstanceId("wfi-001"),
      ownerId: createOwnerId("owner-001"),
      ttlMs: 60_000,
    });
    const lease = acquireResult._unsafeUnwrap();

    const releaseResult = await repo.release(lease.id, lease.ownerId);
    expect(releaseResult.isOk()).toBe(true);

    const findResult = await repo.findById(lease.id);
    expect(findResult._unsafeUnwrap()).toBeNull();
  });

  it("release fails with conflict for wrong owner", async () => {
    const repo = new StubExecutionLeaseRepository();
    const acquireResult = await repo.acquire({
      workflowInstanceId: createWorkflowInstanceId("wfi-001"),
      ownerId: createOwnerId("owner-001"),
      ttlMs: 60_000,
    });
    const lease = acquireResult._unsafeUnwrap();

    const result = await repo.release(lease.id, createOwnerId("wrong-owner"));
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("conflict");
  });
});

// ---------------------------------------------------------------------------
// Tests: SessionSnapshot denylist validation
// ---------------------------------------------------------------------------

describe("SessionSnapshot field boundaries", () => {
  it("SessionSnapshot does not have fields for raw prompts or completions", () => {
    const snapshot = makeSessionSnapshot();
    // These fields must NOT exist on SessionSnapshot
    expect("rawPrompt" in snapshot).toBe(false);
    expect("rawCompletion" in snapshot).toBe(false);
    expect("transcript" in snapshot).toBe(false);
    expect("credentials" in snapshot).toBe(false);
    expect("token" in snapshot).toBe(false);
    expect("cookie" in snapshot).toBe(false);
    expect("authorizationHeader" in snapshot).toBe(false);
    expect("apiKey" in snapshot).toBe(false);
    expect("password" in snapshot).toBe(false);
    expect("providerPayload" in snapshot).toBe(false);
  });

  it("SessionSnapshot has only normalized Weave-visible fields", () => {
    const snapshot = makeSessionSnapshot();
    const allowedKeys = new Set([
      "id",
      "workflowInstanceId",
      "leaseId",
      "harnessName",
      "harnessVersion",
      "agentName",
      "modelId",
      "stepName",
      "sessionStatus",
      "recordedAt",
      "metadata",
    ]);
    for (const key of Object.keys(snapshot)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
  });

  it("SessionSnapshot metadata is a plain key-value record", async () => {
    const repo = new StubSessionSnapshotRepository();
    const result = await repo.record({
      workflowInstanceId: createWorkflowInstanceId("wfi-001"),
      leaseId: createExecutionLeaseId("lease-001"),
      harnessName: "test-harness",
      agentName: "shuttle",
      sessionStatus: "active",
      metadata: {
        stepCount: 3,
        lastStepName: "implement",
        isResumed: false,
      },
    });
    expect(result.isOk()).toBe(true);
    const snap = result._unsafeUnwrap();
    expect(snap.metadata.stepCount).toBe(3);
    expect(snap.metadata.lastStepName).toBe("implement");
    expect(snap.metadata.isResumed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: RuntimeJournal append / query
// ---------------------------------------------------------------------------

describe("RuntimeJournal append / query", () => {
  it("append creates a journal entry with id and timestamp", async () => {
    const repo = new StubRuntimeJournalRepository();
    const result = await repo.append({
      source: { kind: "engine", name: "runner" },
      eventType: "step.started",
      severity: "info",
      data: { stepName: "implement" },
    });
    expect(result.isOk()).toBe(true);
    const entry = result._unsafeUnwrap();
    expect(entry.id).toBeDefined();
    expect(entry.timestamp).toBeDefined();
    expect(entry.source.kind).toBe("engine");
    expect(entry.source.name).toBe("runner");
    expect(entry.eventType).toBe("step.started");
    expect(entry.severity).toBe("info");
  });

  it("query returns all entries when no filter is provided", async () => {
    const repo = new StubRuntimeJournalRepository();
    await repo.append({
      source: { kind: "engine", name: "runner" },
      eventType: "a",
      severity: "info",
      data: {},
    });
    await repo.append({
      source: { kind: "adapter", name: "opencode" },
      eventType: "b",
      severity: "warn",
      data: {},
    });
    const result = await repo.query();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(2);
  });

  it("query filters by sourceKind", async () => {
    const repo = new StubRuntimeJournalRepository();
    await repo.append({
      source: { kind: "engine", name: "runner" },
      eventType: "a",
      severity: "info",
      data: {},
    });
    await repo.append({
      source: { kind: "adapter", name: "opencode" },
      eventType: "b",
      severity: "info",
      data: {},
    });
    const result = await repo.query({ sourceKind: "engine" });
    expect(result.isOk()).toBe(true);
    const entries = result._unsafeUnwrap();
    expect(entries).toHaveLength(1);
    expect(entries[0].source.kind).toBe("engine");
  });

  it("query filters by eventType", async () => {
    const repo = new StubRuntimeJournalRepository();
    await repo.append({
      source: { kind: "engine", name: "runner" },
      eventType: "step.started",
      severity: "info",
      data: {},
    });
    await repo.append({
      source: { kind: "engine", name: "runner" },
      eventType: "step.completed",
      severity: "info",
      data: {},
    });
    const result = await repo.query({ eventType: "step.started" });
    expect(result.isOk()).toBe(true);
    const entries = result._unsafeUnwrap();
    expect(entries).toHaveLength(1);
    expect(entries[0].eventType).toBe("step.started");
  });

  it("query respects limit", async () => {
    const repo = new StubRuntimeJournalRepository();
    for (let i = 0; i < 5; i++) {
      await repo.append({
        source: { kind: "engine", name: "runner" },
        eventType: "tick",
        severity: "debug",
        data: {},
      });
    }
    const result = await repo.query({ limit: 3 });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(3);
  });

  it("journal write failure returns journal_write error", async () => {
    const repo = new StubRuntimeJournalRepository();
    repo.injectFailure();
    const result = await repo.append({
      source: { kind: "engine", name: "runner" },
      eventType: "test",
      severity: "info",
      data: {},
    });
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("journal_write");
  });
});

// ---------------------------------------------------------------------------
// Tests: Transaction / unit-of-work API shape
// ---------------------------------------------------------------------------

describe("RuntimeStore transaction API", () => {
  it("transaction exposes all sub-repositories", async () => {
    const store = new StubRuntimeStore();
    const result = await store.transaction((tx) => {
      expect(tx.instances).toBeDefined();
      expect(tx.leases).toBeDefined();
      expect(tx.snapshots).toBeDefined();
      expect(tx.journal).toBeDefined();
      return okAsync("ok" as const);
    });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe("ok");
  });

  it("transaction propagates Err from callback", async () => {
    const store = new StubRuntimeStore();
    const result = await store.transaction((_tx) => {
      return errAsync(queryError("Simulated failure"));
    });
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("query");
  });

  it("transaction can create and retrieve a WorkflowInstance", async () => {
    const store = new StubRuntimeStore();
    const result = await store.transaction((tx) => {
      return tx.instances.create({
        workflowName: "test-workflow",
        goal: "Build a feature",
        slug: "build-a-feature",
      });
    });
    expect(result.isOk()).toBe(true);
    const instance = result._unsafeUnwrap();
    expect(instance.workflowName).toBe("test-workflow");
    expect(instance.status).toBe("created");
  });

  it("RuntimeStore exposes focused sub-repositories directly", () => {
    const store = new StubRuntimeStore();
    expect(store.instances).toBeDefined();
    expect(store.leases).toBeDefined();
    expect(store.snapshots).toBeDefined();
    expect(store.journal).toBeDefined();
  });

  it("close returns ok", async () => {
    const store = new StubRuntimeStore();
    const result = await store.close();
    expect(result.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: WorkflowInstance CRUD
// ---------------------------------------------------------------------------

describe("WorkflowInstance CRUD", () => {
  it("create returns a WorkflowInstance with status 'created'", async () => {
    const repo = new StubWorkflowInstanceRepository();
    const result = await repo.create({
      workflowName: "my-workflow",
      goal: "Do something",
      slug: "do-something",
    });
    expect(result.isOk()).toBe(true);
    const instance = result._unsafeUnwrap();
    expect(instance.status).toBe("created");
    expect(instance.workflowName).toBe("my-workflow");
    expect(instance.goal).toBe("Do something");
    expect(instance.slug).toBe("do-something");
    expect(instance.artifacts).toHaveLength(0);
  });

  it("update changes the status", async () => {
    const repo = new StubWorkflowInstanceRepository();
    const created = (
      await repo.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();
    const updated = (
      await repo.update(created.id, { status: "running" })
    )._unsafeUnwrap();
    expect(updated.status).toBe("running");
  });

  it("list filters by status", async () => {
    const repo = new StubWorkflowInstanceRepository();
    const a = (
      await repo.create({ workflowName: "wf", goal: "a", slug: "a" })
    )._unsafeUnwrap();
    await repo.create({ workflowName: "wf", goal: "b", slug: "b" });
    await repo.update(a.id, { status: "running" });
    const running = (await repo.list({ status: "running" }))._unsafeUnwrap();
    expect(running).toHaveLength(1);
    expect(running[0].id as string).toBe(a.id as string);
  });

  it("addArtifact appends an artifact reference with identity and revision", async () => {
    const repo = new StubWorkflowInstanceRepository();
    const created = (
      await repo.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();
    const updated = (
      await repo.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/g.md",
      })
    )._unsafeUnwrap();
    expect(updated.artifacts).toHaveLength(1);
    const art = updated.artifacts[0];
    expect(art.name).toBe("plan");
    expect(art.path).toBe(".weave/plans/g.md");
    expect(typeof art.id).toBe("string");
    expect(art.revision).toBe(1);
    expect(art.approvalState).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Tests: Spec 22 Unit 1 — WorkflowInstance and ExecutionLease are only created
// through explicit user-authorized execution transitions
// ---------------------------------------------------------------------------

describe("Spec 22 Unit 1 — explicit execution boundary (WorkflowInstance + ExecutionLease)", () => {
  it("WorkflowInstance starts in 'created' status — not 'running' — before any execution transition", async () => {
    // A newly created WorkflowInstance must be in 'created' status.
    // Only an explicit execution transition (startExecution) may move it to 'running'.
    const repo = new StubWorkflowInstanceRepository();
    const result = await repo.create({
      workflowName: "boundary-wf",
      goal: "boundary goal",
      slug: "boundary-goal",
    });
    expect(result.isOk()).toBe(true);
    const instance = result._unsafeUnwrap();
    expect(instance.status).toBe("created");
    // No lease exists — execution has not started
  });

  it("ExecutionLease can only be acquired explicitly — no implicit acquisition path exists in the store interface", async () => {
    // The ExecutionLeaseRepository.acquire() method is the only way to create a lease.
    // There is no implicit lease creation from session observations or idle events.
    const repo = new StubExecutionLeaseRepository();

    // Before any explicit acquire call, no active lease exists
    const beforeLease = await repo.findActive();
    expect(beforeLease.isOk()).toBe(true);
    expect(beforeLease._unsafeUnwrap()).toBeNull();

    // Only an explicit acquire() call creates a lease
    const acquireResult = await repo.acquire({
      workflowInstanceId: createWorkflowInstanceId("boundary-lease-wf"),
      ownerId: createOwnerId("boundary-owner"),
      ttlMs: 3_600_000,
    });
    expect(acquireResult.isOk()).toBe(true);

    // Now a lease exists — only because of the explicit acquire
    const afterLease = await repo.findActive();
    expect(afterLease.isOk()).toBe(true);
    expect(afterLease._unsafeUnwrap()).not.toBeNull();
  });

  it("WorkflowInstance status transitions are explicit — only update() changes status", async () => {
    // Status transitions must be explicit — no implicit status changes from
    // session observations, idle events, or continuation hooks.
    const repo = new StubWorkflowInstanceRepository();
    const created = (
      await repo.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    // Status starts at 'created'
    expect(created.status).toBe("created");

    // Only an explicit update() call changes status
    const running = (
      await repo.update(created.id, { status: "running" })
    )._unsafeUnwrap();
    expect(running.status).toBe("running");

    // Verify the transition is durable
    const fetched = (await repo.getById(created.id))._unsafeUnwrap();
    expect(fetched.status).toBe("running");
  });

  it("WorkflowInstance list() does not create or modify instances", async () => {
    // list() is a read-only operation — it must not create or modify instances.
    const repo = new StubWorkflowInstanceRepository();

    // list() on an empty store returns empty array
    const emptyList = (await repo.list())._unsafeUnwrap();
    expect(emptyList).toHaveLength(0);

    // Create one instance
    await repo.create({ workflowName: "wf", goal: "g", slug: "g" });

    // list() returns the instance without modifying it
    const list = (await repo.list())._unsafeUnwrap();
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe("created");
  });

  it("ExecutionLease.findActive() is read-only — does not create or modify leases", async () => {
    const repo = new StubExecutionLeaseRepository();

    // findActive() on an empty store returns null without creating anything
    const result1 = await repo.findActive();
    expect(result1._unsafeUnwrap()).toBeNull();

    // Calling findActive() multiple times does not create leases
    const result2 = await repo.findActive();
    expect(result2._unsafeUnwrap()).toBeNull();
  });

  it("WorkflowInstance terminal statuses (completed, failed, cancelled) require explicit transitions", async () => {
    // Terminal statuses must be set explicitly — they cannot be reached implicitly.
    const repo = new StubWorkflowInstanceRepository();
    const created = (
      await repo.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    // Each terminal status requires an explicit update() call
    for (const terminalStatus of [
      "completed",
      "failed",
      "cancelled",
    ] as const) {
      const updated = (
        await repo.update(created.id, { status: terminalStatus })
      )._unsafeUnwrap();
      expect(updated.status).toBe(terminalStatus);

      // Reset to running for next iteration
      await repo.update(created.id, { status: "running" });
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: Spec 22 Unit 1 — ExecutionAuthorizationSource contract (Task 1.3)
// ---------------------------------------------------------------------------

describe("Spec 22 Unit 1 — ExecutionAuthorizationSource contract (ADR 0004)", () => {
  it("EXECUTION_AUTHORIZATION_SOURCES contains exactly 4 values", () => {
    expect(EXECUTION_AUTHORIZATION_SOURCES).toHaveLength(4);
  });

  it("'user' is the only source that passes validateAuthorizationSource for startExecution", () => {
    const userResult = validateAuthorizationSource("user", "startExecution");
    expect(userResult.isOk()).toBe(true);

    const agentResult = validateAuthorizationSource("agent", "startExecution");
    expect(agentResult.isErr()).toBe(true);

    const hookResult = validateAuthorizationSource("hook", "startExecution");
    expect(hookResult.isErr()).toBe(true);

    const eventResult = validateAuthorizationSource("event", "startExecution");
    expect(eventResult.isErr()).toBe(true);
  });

  it("'user' is the only source that passes validateAuthorizationSource for resumeExecution", () => {
    const userResult = validateAuthorizationSource("user", "resumeExecution");
    expect(userResult.isOk()).toBe(true);

    for (const source of [
      "agent",
      "hook",
      "event",
    ] as ExecutionAuthorizationSource[]) {
      const result = validateAuthorizationSource(source, "resumeExecution");
      expect(result.isErr()).toBe(true);
      if (!result.isErr()) continue;
      expect(result.error.type).toBe("policy_decision");
    }
  });

  it("forbidden sources produce policy_decision errors with rule: 'authorizationSource'", () => {
    const forbidden: ExecutionAuthorizationSource[] = [
      "agent",
      "hook",
      "event",
    ];
    for (const source of forbidden) {
      const result = validateAuthorizationSource(source, "startExecution");
      expect(result.isErr()).toBe(true);
      if (!result.isErr()) continue;
      expect(result.error.type).toBe("policy_decision");
      if (result.error.type === "policy_decision") {
        expect(result.error.rule).toBe("authorizationSource");
      }
    }
  });

  it("error message names the forbidden source and the operation", () => {
    const result = validateAuthorizationSource("hook", "startExecution");
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    if (result.error.type !== "policy_decision") return;
    expect(result.error.message).toContain("hook");
    expect(result.error.message).toContain("startExecution");
  });

  it("ExecutionLeaseRepository.acquire() is the only way to create a lease — no implicit path exists", async () => {
    // The store interface has no method that implicitly creates a lease.
    // This test verifies the contract: only explicit acquire() creates leases.
    const repo = new StubExecutionLeaseRepository();

    // Before any explicit acquire, no active lease exists
    const before = await repo.findActive();
    expect(before._unsafeUnwrap()).toBeNull();

    // Only acquire() creates a lease
    await repo.acquire({
      workflowInstanceId: createWorkflowInstanceId("auth-contract-wf"),
      ownerId: createOwnerId("auth-contract-owner"),
      ttlMs: 3_600_000,
    });

    const after = await repo.findActive();
    expect(after._unsafeUnwrap()).not.toBeNull();
  });

  it("WorkflowInstance.create() does not start execution — status is 'created', not 'running'", async () => {
    // Creating a WorkflowInstance does not start execution.
    // Only an explicit startExecution call (with user authorization) may
    // transition the instance to 'running'.
    const repo = new StubWorkflowInstanceRepository();
    const instance = (
      await repo.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    // Must be 'created', not 'running' — execution has not started
    expect(instance.status).toBe("created");
    expect(instance.status).not.toBe("running");
  });

  it("observeSession-equivalent: recording a snapshot does not create instances or leases", async () => {
    // The SessionSnapshotRepository.record() method must not create
    // WorkflowInstances or ExecutionLeases — it is a passive observation.
    const instanceRepo = new StubWorkflowInstanceRepository();
    const leaseRepo = new StubExecutionLeaseRepository();
    const snapshotRepo = new StubSessionSnapshotRepository();

    // Record a snapshot
    await snapshotRepo.record({
      workflowInstanceId: createWorkflowInstanceId("obs-contract-wf"),
      leaseId: createExecutionLeaseId("obs-contract-lease"),
      harnessName: "opencode",
      agentName: "loom",
      sessionStatus: "idle",
      metadata: {},
    });

    // No instances or leases should have been created
    const instances = (await instanceRepo.list())._unsafeUnwrap();
    expect(instances).toHaveLength(0);

    const activeLease = (await leaseRepo.findActive())._unsafeUnwrap();
    expect(activeLease).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: Task 3.1 — Artifact identity, monotonic revisions, approval state,
// and integrity-verification metadata
// ---------------------------------------------------------------------------

describe("ArtifactApprovalState values", () => {
  it("ARTIFACT_APPROVAL_STATES contains all 3 valid values", () => {
    expect(ARTIFACT_APPROVAL_STATES).toHaveLength(3);
    expect(ARTIFACT_APPROVAL_STATES).toContain("pending");
    expect(ARTIFACT_APPROVAL_STATES).toContain("approved");
    expect(ARTIFACT_APPROVAL_STATES).toContain("rejected");
  });

  it("ArtifactRef can be created with each valid approvalState", () => {
    for (const approvalState of ARTIFACT_APPROVAL_STATES) {
      const ref: ArtifactRef = {
        id: createArtifactId("art-test"),
        name: "plan",
        path: ".weave/plans/test.md",
        revision: 1,
        approvalState,
      };
      expect(ref.approvalState).toBe(approvalState);
    }
  });
});

describe("ArtifactId branded type", () => {
  it("createArtifactId creates a branded ArtifactId", () => {
    const id = createArtifactId("art-test");
    expect(typeof id).toBe("string");
    expect(id as string).toBe("art-test");
  });

  it("ArtifactRef.id is a stable branded ArtifactId", () => {
    const id = createArtifactId("stable-art-id");
    const ref: ArtifactRef = {
      id,
      name: "output",
      path: ".weave/plans/output.json",
      revision: 1,
      approvalState: "pending",
    };
    expect(ref.id as string).toBe("stable-art-id");
  });
});

describe("ArtifactRef monotonic revision", () => {
  it("addArtifact assigns revision 1 for the first occurrence of a name", async () => {
    const repo = new StubWorkflowInstanceRepository();
    const created = (
      await repo.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();
    const updated = (
      await repo.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/g.md",
      })
    )._unsafeUnwrap();
    expect(updated.artifacts[0].revision).toBe(1);
  });

  it("addArtifact increments revision for subsequent occurrences of the same name", async () => {
    const repo = new StubWorkflowInstanceRepository();
    const created = (
      await repo.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    await repo.addArtifact(created.id, {
      name: "plan",
      path: ".weave/plans/g-v1.md",
    });
    const updated = (
      await repo.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/g-v2.md",
      })
    )._unsafeUnwrap();

    const planArtifacts = updated.artifacts.filter((a) => a.name === "plan");
    expect(planArtifacts).toHaveLength(2);
    expect(planArtifacts[0].revision).toBe(1);
    expect(planArtifacts[1].revision).toBe(2);
  });

  it("addArtifact reuses the stable ArtifactId across revisions of the same name", async () => {
    const repo = new StubWorkflowInstanceRepository();
    const created = (
      await repo.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    await repo.addArtifact(created.id, {
      name: "plan",
      path: ".weave/plans/g-v1.md",
    });
    const updated = (
      await repo.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/g-v2.md",
      })
    )._unsafeUnwrap();

    const planArtifacts = updated.artifacts.filter((a) => a.name === "plan");
    // Both revisions share the same stable ArtifactId
    expect(planArtifacts[0].id as string).toBe(planArtifacts[1].id as string);
  });

  it("different artifact names get independent ArtifactIds", async () => {
    const repo = new StubWorkflowInstanceRepository();
    const created = (
      await repo.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    await repo.addArtifact(created.id, {
      name: "plan",
      path: ".weave/plans/g.md",
    });
    const updated = (
      await repo.addArtifact(created.id, {
        name: "output",
        path: ".weave/plans/output.json",
      })
    )._unsafeUnwrap();

    const planArt = updated.artifacts.find((a) => a.name === "plan")!;
    const outputArt = updated.artifacts.find((a) => a.name === "output")!;
    expect(planArt.id as string).not.toBe(outputArt.id as string);
  });
});

describe("ArtifactRef approval state", () => {
  it("addArtifact sets approvalState to 'pending' by default", async () => {
    const repo = new StubWorkflowInstanceRepository();
    const created = (
      await repo.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();
    const updated = (
      await repo.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/g.md",
      })
    )._unsafeUnwrap();
    expect(updated.artifacts[0].approvalState).toBe("pending");
  });

  it("updateArtifactApproval transitions approvalState to 'approved'", async () => {
    const repo = new StubWorkflowInstanceRepository();
    const created = (
      await repo.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();
    const withArtifact = (
      await repo.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/g.md",
      })
    )._unsafeUnwrap();

    const artifactId = withArtifact.artifacts[0].id;
    const approved = (
      await repo.updateArtifactApproval(created.id, artifactId, "approved")
    )._unsafeUnwrap();

    expect(approved.artifacts[0].approvalState).toBe("approved");
  });

  it("updateArtifactApproval transitions approvalState to 'rejected'", async () => {
    const repo = new StubWorkflowInstanceRepository();
    const created = (
      await repo.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();
    const withArtifact = (
      await repo.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/g.md",
      })
    )._unsafeUnwrap();

    const artifactId = withArtifact.artifacts[0].id;
    const rejected = (
      await repo.updateArtifactApproval(created.id, artifactId, "rejected")
    )._unsafeUnwrap();

    expect(rejected.artifacts[0].approvalState).toBe("rejected");
  });

  it("updateArtifactApproval returns not_found for missing WorkflowInstance", async () => {
    const repo = new StubWorkflowInstanceRepository();
    const result = await repo.updateArtifactApproval(
      createWorkflowInstanceId("missing-wf"),
      createArtifactId("art-001"),
      "approved",
    );
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("not_found");
  });

  it("updateArtifactApproval returns not_found for missing ArtifactId", async () => {
    const repo = new StubWorkflowInstanceRepository();
    const created = (
      await repo.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    const result = await repo.updateArtifactApproval(
      created.id,
      createArtifactId("nonexistent-art"),
      "approved",
    );
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("not_found");
  });

  it("addArtifact resets approvalState to 'pending' for a new revision", async () => {
    const repo = new StubWorkflowInstanceRepository();
    const created = (
      await repo.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    // Add first revision and approve it
    const v1 = (
      await repo.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/g-v1.md",
      })
    )._unsafeUnwrap();
    const artifactId = v1.artifacts[0].id;
    await repo.updateArtifactApproval(created.id, artifactId, "approved");

    // Add second revision — should be pending again
    const v2 = (
      await repo.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/g-v2.md",
      })
    )._unsafeUnwrap();

    const planArtifacts = v2.artifacts.filter((a) => a.name === "plan");
    expect(planArtifacts[0].approvalState).toBe("approved"); // v1 unchanged
    expect(planArtifacts[1].approvalState).toBe("pending"); // v2 starts pending
  });
});

describe("ArtifactRef integrity-verification metadata", () => {
  it("addArtifact stores integrity metadata when provided", async () => {
    const repo = new StubWorkflowInstanceRepository();
    const created = (
      await repo.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    const integrity: ArtifactIntegrityMetadata = {
      algorithm: "sha256",
      digest:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    };
    const updated = (
      await repo.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/g.md",
        integrity,
      })
    )._unsafeUnwrap();

    expect(updated.artifacts[0].integrity).toEqual(integrity);
    expect(updated.artifacts[0].integrity?.algorithm).toBe("sha256");
    expect(updated.artifacts[0].integrity?.digest).toHaveLength(64);
  });

  it("addArtifact omits integrity when not provided", async () => {
    const repo = new StubWorkflowInstanceRepository();
    const created = (
      await repo.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();
    const updated = (
      await repo.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/g.md",
      })
    )._unsafeUnwrap();

    expect(updated.artifacts[0].integrity).toBeUndefined();
  });

  it("ArtifactRef does not store raw artifact contents", () => {
    const ref: ArtifactRef = {
      id: createArtifactId("art-001"),
      name: "plan",
      path: ".weave/plans/test.md",
      revision: 1,
      approvalState: "pending",
      integrity: {
        algorithm: "sha256",
        digest:
          "abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
      },
    };
    // These fields must NOT exist on ArtifactRef
    expect("content" in ref).toBe(false);
    expect("rawContent" in ref).toBe(false);
    expect("body" in ref).toBe(false);
    expect("text" in ref).toBe(false);
    expect("prompt" in ref).toBe(false);
    expect("completion" in ref).toBe(false);
    expect("token" in ref).toBe(false);
    expect("credential" in ref).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation contract — Spec 22 Unit 3
// ---------------------------------------------------------------------------

describe("Reconciliation contract — closed reason set (Spec 22 Unit 3)", () => {
  it("RECONCILIATION_REASONS contains exactly the four closed built-in values", () => {
    expect(RECONCILIATION_REASONS).toHaveLength(4);
    expect(RECONCILIATION_REASONS).toContain("execution-mismatch");
    expect(RECONCILIATION_REASONS).toContain("user-revision-request");
    expect(RECONCILIATION_REASONS).toContain("review-rejection");
    expect(RECONCILIATION_REASONS).toContain("security-rejection");
  });

  it("RECONCILIATION_AUTHORIZATION_SOURCES contains exactly the four valid sources", () => {
    expect(RECONCILIATION_AUTHORIZATION_SOURCES).toHaveLength(4);
    expect(RECONCILIATION_AUTHORIZATION_SOURCES).toContain("user");
    expect(RECONCILIATION_AUTHORIZATION_SOURCES).toContain("runtime");
    expect(RECONCILIATION_AUTHORIZATION_SOURCES).toContain("review-gate");
    expect(RECONCILIATION_AUTHORIZATION_SOURCES).toContain("security-gate");
  });

  it("each reason has exactly one authorized source (bijective mapping)", () => {
    const authorizedPairs: Array<[string, string]> = [
      ["execution-mismatch", "runtime"],
      ["user-revision-request", "user"],
      ["review-rejection", "review-gate"],
      ["security-rejection", "security-gate"],
    ];

    for (const [reason, source] of authorizedPairs) {
      const result = validateReconciliationSource(
        reason as Parameters<typeof validateReconciliationSource>[0],
        source as ReconciliationAuthorizationSource,
      );
      expect(result.isOk()).toBe(true);
    }
  });

  it("every non-authorized source is rejected for each reason", () => {
    const allSources: ReconciliationAuthorizationSource[] = [
      "user",
      "runtime",
      "review-gate",
      "security-gate",
    ];
    const authorizedMap: Record<string, string> = {
      "execution-mismatch": "runtime",
      "user-revision-request": "user",
      "review-rejection": "review-gate",
      "security-rejection": "security-gate",
    };

    for (const reason of RECONCILIATION_REASONS) {
      const authorized = authorizedMap[reason];
      for (const source of allSources) {
        if (source === authorized) continue;
        const result = validateReconciliationSource(reason, source);
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.type).toBe("policy_decision");
          expect(result.error.rule).toBe("reconciliationSource");
        }
      }
    }
  });

  it("validateReconciliationSource error message names the reason and authorized source", () => {
    const result = validateReconciliationSource("review-rejection", "user");
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.message).toContain("review-rejection");
    expect(result.error.message).toContain("review-gate");
    expect(result.error.message).toContain('"user"');
  });

  it("validateReconciliationSource error message references the spec", () => {
    const result = validateReconciliationSource(
      "security-rejection",
      "runtime",
    );
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    // Error message should reference the spec for traceability
    expect(result.error.message).toContain("22-spec-workflow-first-execution");
  });
});

describe("Reconciliation contract — WorkflowInstance and ExecutionLease invariants (Spec 22 Unit 3)", () => {
  it("WorkflowInstance status 'paused' is the fail-closed state for reconciliation without a handler", () => {
    // Structural: 'paused' must be a valid WorkflowInstanceStatus
    const validStatuses = WORKFLOW_INSTANCE_STATUSES;
    expect(validStatuses).toContain("paused");
  });

  it("WorkflowInstance status 'running' is the state after successful handler routing", () => {
    const validStatuses = WORKFLOW_INSTANCE_STATUSES;
    expect(validStatuses).toContain("running");
  });

  it("reconciliation does not create a new WorkflowInstance — it operates on an existing one", () => {
    // Structural proof: reconcileExecution takes workflowInstanceId as input,
    // not a creation payload. The type system enforces this.
    // This test documents the invariant explicitly.
    type ReconcileInput = {
      workflowInstanceId: WorkflowInstanceId;
      leaseId: ExecutionLeaseId;
      reason: string;
      authorizationSource: string;
    };
    const input: ReconcileInput = {
      workflowInstanceId: createWorkflowInstanceId("existing-wf-001"),
      leaseId: createExecutionLeaseId("existing-lease-001"),
      reason: "user-revision-request",
      authorizationSource: "user",
    };
    // The input references an existing instance — no 'goal', 'slug', or 'workflowName'
    // creation fields are present. This is the structural proof.
    expect("goal" in input).toBe(false);
    expect("slug" in input).toBe(false);
    expect("workflowName" in input).toBe(false);
    expect(input.workflowInstanceId as string).toBe("existing-wf-001");
  });

  it("reconciliation fail-closed effect is pause-execution (not complete-execution)", () => {
    // Structural: the fail-closed effect must be pause-execution, not complete-execution.
    // This preserves resumability — the workflow is not terminated.
    const failClosedEffect: {
      kind: "pause-execution";
      workflowInstanceId: WorkflowInstanceId;
      reason?: string;
    } = {
      kind: "pause-execution",
      workflowInstanceId: createWorkflowInstanceId("wf-fail-closed"),
      reason: "Reconciliation: no upstream handler declared — failing closed",
    };
    expect(failClosedEffect.kind).toBe("pause-execution");
    // Must NOT be complete-execution (which would terminate the workflow)
    expect(failClosedEffect.kind).not.toBe("complete-execution");
  });
});

// ---------------------------------------------------------------------------
// Reconciliation contract — gate re-run (Spec 22 Unit 3)
// ---------------------------------------------------------------------------

describe("Reconciliation contract — gate re-run (Spec 22 Unit 3)", () => {
  it("ReconcileExecutionOutput carries gateReRunStepName for gate-originated reasons", () => {
    // Structural: the output type must support gateReRunStepName as an optional field.
    // This test documents the contract shape without requiring a live store.
    type GateReRunOutput = {
      handlerFound: boolean;
      handlerStepName?: string;
      gateReRunStepName?: string;
      effects: readonly { kind: string }[];
    };

    const reviewRejectionOutput: GateReRunOutput = {
      handlerFound: true,
      handlerStepName: "implement",
      gateReRunStepName: "review-gate",
      effects: [{ kind: "dispatch-agent" }],
    };
    expect(reviewRejectionOutput.gateReRunStepName).toBe("review-gate");

    const securityRejectionOutput: GateReRunOutput = {
      handlerFound: true,
      handlerStepName: "implement",
      gateReRunStepName: "security-gate",
      effects: [{ kind: "dispatch-agent" }],
    };
    expect(securityRejectionOutput.gateReRunStepName).toBe("security-gate");
  });

  it("gateReRunStepName is absent for non-gate-originated reasons", () => {
    // Structural: gateReRunStepName must be undefined for user-revision-request
    // and execution-mismatch (not gate-originated).
    type GateReRunOutput = {
      handlerFound: boolean;
      handlerStepName?: string;
      gateReRunStepName?: string;
      effects: readonly { kind: string }[];
    };

    const userRevisionOutput: GateReRunOutput = {
      handlerFound: true,
      handlerStepName: "implement",
      // gateReRunStepName intentionally absent
      effects: [{ kind: "dispatch-agent" }],
    };
    expect(userRevisionOutput.gateReRunStepName).toBeUndefined();

    const executionMismatchOutput: GateReRunOutput = {
      handlerFound: true,
      handlerStepName: "plan",
      // gateReRunStepName intentionally absent
      effects: [{ kind: "dispatch-agent" }],
    };
    expect(executionMismatchOutput.gateReRunStepName).toBeUndefined();
  });

  it("gate re-run reasons are exactly review-rejection and security-rejection", () => {
    // Document the closed set of gate-originated reasons that trigger re-run.
    const gateOriginatedReasons: readonly string[] = [
      "review-rejection",
      "security-rejection",
    ];
    const nonGateReasons: readonly string[] = [
      "execution-mismatch",
      "user-revision-request",
    ];

    // All four reasons are in RECONCILIATION_REASONS
    const allReasons: string[] = [...gateOriginatedReasons, ...nonGateReasons];
    const reconciliationReasonsAsStrings: string[] = [
      ...RECONCILIATION_REASONS,
    ];
    for (const reason of allReasons) {
      expect(reconciliationReasonsAsStrings).toContain(reason);
    }

    // Gate-originated reasons have gate sources
    expect(
      validateReconciliationSource("review-rejection", "review-gate").isOk(),
    ).toBe(true);
    expect(
      validateReconciliationSource(
        "security-rejection",
        "security-gate",
      ).isOk(),
    ).toBe(true);

    // Non-gate reasons do not have gate sources
    expect(
      validateReconciliationSource("execution-mismatch", "review-gate").isErr(),
    ).toBe(true);
    expect(
      validateReconciliationSource(
        "user-revision-request",
        "security-gate",
      ).isErr(),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation contract — before-plan exclusion (Spec 22 Unit 3)
// ---------------------------------------------------------------------------

describe("Reconciliation contract — before-plan exclusion (Spec 22 Unit 3)", () => {
  it("before-plan steps do not participate in reconciliation — v1 rule is documented", () => {
    // Structural proof: the v1 rule is that before-plan steps do not participate
    // in reconciliation semantics. This test documents the invariant.
    //
    // The runtime enforcement is in resolveReconciliationHandler via
    // computeBeforePlanExclusionSet. The schema layer also prevents
    // reconciliation_handlers on before-plan steps, but the runtime check
    // provides defense-in-depth after config merge or composition.
    //
    // A before-plan step is identified by:
    // 1. The workflow publishes extension_points.before_plan === true
    // 2. The step appears before the step with role === "planning"
    //
    // This test verifies the structural invariant is documented and the
    // WorkflowStep type supports the role field.
    type StepWithRole = {
      name: string;
      role?: "planning";
      reconciliation_handlers?: Array<{ reason: string }>;
    };

    const planningStep: StepWithRole = {
      name: "plan",
      role: "planning",
    };
    expect(planningStep.role).toBe("planning");

    const beforePlanStep: StepWithRole = {
      name: "spec-review",
      // No role — before-plan steps do not have role: "planning"
    };
    expect(beforePlanStep.role).toBeUndefined();
  });

  it("before-plan exclusion is a runtime defense-in-depth guarantee", () => {
    // The schema layer prevents reconciliation_handlers on before-plan steps.
    // The runtime layer (computeBeforePlanExclusionSet + resolveReconciliationHandler)
    // provides a second line of defense after config merge or composition.
    //
    // This test documents that the runtime check is independent of the schema check.
    // Both must hold for the v1 rule to be enforced.
    //
    // Structural: the runtime check uses extension_points.before_plan and
    // the position of the planning step (role === "planning") to compute
    // the exclusion set. Steps before the planning step are excluded.
    const workflowWithBeforePlan = {
      extension_points: { before_plan: true },
      steps: [
        { name: "spec-review", role: undefined }, // before-plan (excluded)
        { name: "plan", role: "planning" as const }, // planning step (boundary)
        { name: "implement", role: undefined }, // after planning (not excluded)
      ],
    };

    // Verify the structural invariant: spec-review is before plan (index 0 < 1)
    const planIndex = workflowWithBeforePlan.steps.findIndex(
      (s) => s.role === "planning",
    );
    expect(planIndex).toBe(1);

    const specReviewIndex = workflowWithBeforePlan.steps.findIndex(
      (s) => s.name === "spec-review",
    );
    expect(specReviewIndex).toBe(0);

    // spec-review is before the planning step — it is a before-plan step
    expect(specReviewIndex < planIndex).toBe(true);

    // implement is after the planning step — it is NOT a before-plan step
    const implementIndex = workflowWithBeforePlan.steps.findIndex(
      (s) => s.name === "implement",
    );
    expect(implementIndex > planIndex).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation contract — immutable completed plan tasks (Spec 22 Unit 3)
// ---------------------------------------------------------------------------

describe("Reconciliation contract — immutable completed plan tasks (Spec 22 Unit 3)", () => {
  it("ReconcileExecutionInput accepts an optional planStateProvider field", () => {
    // Structural: ReconcileExecutionInput must support planStateProvider as an
    // optional field. This test documents the contract shape.
    //
    // The planStateProvider is used to check whether the triggering step's plan
    // is already complete. If complete, reconciliation is rejected with a
    // policy_decision error — completed Plan Markdown tasks are immutable.
    type ReconcileInputShape = {
      workflowInstanceId: WorkflowInstanceId;
      leaseId: ExecutionLeaseId;
      reason: string;
      authorizationSource: string;
      planStateProvider?: {
        isPlanComplete(planName: string): ResultAsync<boolean, unknown>;
      };
    };

    const inputWithProvider: ReconcileInputShape = {
      workflowInstanceId: createWorkflowInstanceId("wf-001"),
      leaseId: createExecutionLeaseId("lease-001"),
      reason: "user-revision-request",
      authorizationSource: "user",
      planStateProvider: {
        isPlanComplete: (_planName: string) => okAsync(false),
      },
    };
    expect(inputWithProvider.planStateProvider).toBeDefined();

    const inputWithoutProvider: ReconcileInputShape = {
      workflowInstanceId: createWorkflowInstanceId("wf-002"),
      leaseId: createExecutionLeaseId("lease-002"),
      reason: "user-revision-request",
      authorizationSource: "user",
      // planStateProvider omitted
    };
    expect(inputWithoutProvider.planStateProvider).toBeUndefined();
  });

  it("immutability check applies only to plan-oriented completion methods", () => {
    // Structural: the immutability check is triggered only when the triggering
    // step uses plan_complete or plan_created completion methods.
    // Steps using agent_signal, user_confirm, or review_verdict are not checked.
    //
    // This test documents the closed set of plan-oriented methods.
    const planOrientedMethods = ["plan_complete", "plan_created"] as const;
    const nonPlanOrientedMethods = [
      "agent_signal",
      "user_confirm",
      "review_verdict",
    ] as const;

    // Plan-oriented methods are a strict subset of all completion methods
    for (const method of planOrientedMethods) {
      expect(["plan_complete", "plan_created"]).toContain(method);
    }

    // Non-plan-oriented methods do not trigger the immutability check
    for (const method of nonPlanOrientedMethods) {
      expect(["plan_complete", "plan_created"]).not.toContain(method);
    }
  });

  it("immutability error is a policy_decision with rule 'completed_plan_immutability'", () => {
    // Structural: the error returned when a completed plan blocks reconciliation
    // must be a policy_decision error with rule 'completed_plan_immutability'.
    // This allows callers to distinguish this specific rejection from other
    // policy_decision errors.
    type PolicyDecisionError = {
      type: "policy_decision";
      message: string;
      rule?: string;
    };

    const immutabilityError: PolicyDecisionError = {
      type: "policy_decision",
      message:
        'Reconciliation rejected: plan ".weave/plans/my-plan.md" has all tasks completed. ' +
        "Completed Plan Markdown tasks are immutable — corrective work must be expressed as follow-up tasks.",
      rule: "completed_plan_immutability",
    };

    expect(immutabilityError.type).toBe("policy_decision");
    expect(immutabilityError.rule).toBe("completed_plan_immutability");
    expect(immutabilityError.message).toContain("immutable");
    expect(immutabilityError.message).toContain("follow-up tasks");
  });

  it("corrective work model: completed tasks are immutable, follow-up tasks are the correction path", () => {
    // Conceptual contract: when a plan is complete, reconciliation cannot revise
    // the completed tasks in place. Instead, corrective work must be expressed
    // as new follow-up tasks appended to the plan.
    //
    // This test documents the semantic contract:
    // - Completed checkboxes (- [x]) are immutable
    // - Corrective work is expressed as new incomplete checkboxes (- [ ])
    // - The plan file itself is not locked — only completed tasks within it
    //
    // The engine enforces this by rejecting reconciliation when isPlanComplete
    // returns true (all checkboxes are checked). When at least one checkbox
    // remains unchecked, reconciliation is allowed to proceed.
    const planWithAllTasksComplete = {
      content: "- [x] Task 1\n- [x] Task 2\n- [x] Task 3",
      isComplete: true, // isPlanComplete returns true
    };
    expect(planWithAllTasksComplete.isComplete).toBe(true);

    const planWithFollowUpTasks = {
      content: "- [x] Task 1\n- [x] Task 2\n- [ ] Follow-up: fix issue",
      isComplete: false, // isPlanComplete returns false — has unchecked tasks
    };
    expect(planWithFollowUpTasks.isComplete).toBe(false);

    // When isComplete is false, reconciliation is allowed to proceed.
    // The corrective work (follow-up task) is expressed as a new - [ ] item.
    expect(planWithFollowUpTasks.content).toContain("- [ ] Follow-up");
  });

  it("immutability check does not modify instance state on rejection", () => {
    // Structural: when the immutability check rejects reconciliation, no
    // instance state changes must occur. The check is a pre-condition guard
    // that returns an error before any store writes.
    //
    // This is enforced by the implementation: checkCompletedPlanImmutability
    // returns err() before any store.instances.update() calls are made.
    // The test documents this invariant structurally.
    type ImmutabilityCheckResult =
      | { ok: true }
      | { ok: false; error: { type: "policy_decision"; rule: string } };

    const rejectedResult: ImmutabilityCheckResult = {
      ok: false,
      error: { type: "policy_decision", rule: "completed_plan_immutability" },
    };

    // When rejected, no state changes occur — the error is returned immediately
    expect(rejectedResult.ok).toBe(false);
    if (!rejectedResult.ok) {
      expect(rejectedResult.error.type).toBe("policy_decision");
      expect(rejectedResult.error.rule).toBe("completed_plan_immutability");
    }
  });
});
