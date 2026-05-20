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
  ArtifactRef,
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
} from "../runtime/types.js";
import {
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
    },
  ): ResultAsync<WorkflowInstance, RuntimeStoreError> {
    const existing = this.store.get(id);
    if (!existing) {
      return errAsync(notFoundError("WorkflowInstance", id));
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
        { name: "plan", path: ".weave/plans/test-goal.md" },
        {
          name: "output",
          path: ".weave/plans/output.json",
          mimeType: "application/json",
        },
      ],
    });
    expect(instance.artifacts).toHaveLength(2);
    expect(instance.artifacts[0]).toEqual({
      name: "plan",
      path: ".weave/plans/test-goal.md",
    });
    expect(instance.artifacts[1]).toMatchObject({
      name: "output",
      mimeType: "application/json",
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

  it("addArtifact appends an artifact reference", async () => {
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
    expect(updated.artifacts[0].name).toBe("plan");
    expect(updated.artifacts[0].path).toBe(".weave/plans/g.md");
  });
});
