/**
 * In-memory Runtime Store tests.
 *
 * Verifies that `createInMemoryRuntimeStore` satisfies the same Runtime Store
 * contract as the SQLite store: find/get semantics, lease conflict semantics,
 * transaction/unit-of-work API, and configurable failure injection.
 *
 * All imports come from the public `@weave/engine` barrel — no private paths.
 *
 * @see docs/specs/12-spec-runtime-persistence/12-spec-runtime-persistence.md
 */

import { describe, expect, it } from "bun:test";
import {
  conflictError,
  createExecutionLeaseId,
  createInMemoryRuntimeStore,
  createOwnerId,
  createRuntimeJournalEntryId,
  createSessionSnapshotId,
  createWorkflowInstanceId,
  initializationError,
  journalWriteError,
  queryError,
  type RuntimeStore,
} from "@weave/engine";
import { errAsync, okAsync } from "neverthrow";

// ---------------------------------------------------------------------------
// Typecheck proof: import from public barrel only
// ---------------------------------------------------------------------------

// This assignment proves that `createInMemoryRuntimeStore` returns a value
// assignable to the public `RuntimeStore` interface.
function _typecheckProof(): RuntimeStore {
  return createInMemoryRuntimeStore();
}
void _typecheckProof;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore() {
  return createInMemoryRuntimeStore();
}

// ---------------------------------------------------------------------------
// Tests: basic construction
// ---------------------------------------------------------------------------

describe("createInMemoryRuntimeStore", () => {
  it("returns a store with all sub-repositories", () => {
    const store = makeStore();
    expect(store.instances).toBeDefined();
    expect(store.leases).toBeDefined();
    expect(store.snapshots).toBeDefined();
    expect(store.journal).toBeDefined();
  });

  it("close returns ok", async () => {
    const store = makeStore();
    const result = await store.close();
    expect(result.isOk()).toBe(true);
  });

  it("is immediately ready — no initialization needed", async () => {
    const store = makeStore();
    const result = await store.instances.create({
      workflowName: "test",
      goal: "test goal",
      slug: "test-goal",
    });
    expect(result.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: WorkflowInstance CRUD
// ---------------------------------------------------------------------------

describe("InMemoryRuntimeStore — WorkflowInstance CRUD", () => {
  it("create returns a WorkflowInstance with status 'created'", async () => {
    const store = makeStore();
    const result = await store.instances.create({
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
    expect(instance.id).toBeDefined();
    expect(instance.createdAt).toBeDefined();
    expect(instance.updatedAt).toBeDefined();
  });

  it("findById returns null for missing instance", async () => {
    const store = makeStore();
    const result = await store.instances.findById(
      createWorkflowInstanceId("missing"),
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it("getById returns not_found error for missing instance", async () => {
    const store = makeStore();
    const result = await store.instances.getById(
      createWorkflowInstanceId("missing"),
    );
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("not_found");
    if (error.type === "not_found") {
      expect(error.entity).toBe("WorkflowInstance");
      expect(error.id).toBe("missing");
    }
  });

  it("findById returns the record when it exists", async () => {
    const store = makeStore();
    const created = (
      await store.instances.create({
        workflowName: "wf",
        goal: "g",
        slug: "g",
      })
    )._unsafeUnwrap();
    const found = (await store.instances.findById(created.id))._unsafeUnwrap();
    expect(found).toEqual(created);
  });

  it("getById returns the record when it exists", async () => {
    const store = makeStore();
    const created = (
      await store.instances.create({
        workflowName: "wf",
        goal: "g",
        slug: "g",
      })
    )._unsafeUnwrap();
    const found = (await store.instances.getById(created.id))._unsafeUnwrap();
    expect(found).toEqual(created);
  });

  it("update changes the status", async () => {
    const store = makeStore();
    const created = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();
    const updated = (
      await store.instances.update(created.id, { status: "running" })
    )._unsafeUnwrap();
    expect(updated.status).toBe("running");
  });

  it("update sets completedAt for terminal statuses", async () => {
    const store = makeStore();
    const created = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();
    const updated = (
      await store.instances.update(created.id, { status: "completed" })
    )._unsafeUnwrap();
    expect(updated.completedAt).toBeDefined();
  });

  it("update returns not_found for missing instance", async () => {
    const store = makeStore();
    const result = await store.instances.update(
      createWorkflowInstanceId("missing"),
      { status: "running" },
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("not_found");
  });

  it("list returns all instances", async () => {
    const store = makeStore();
    await store.instances.create({ workflowName: "wf", goal: "a", slug: "a" });
    await store.instances.create({ workflowName: "wf", goal: "b", slug: "b" });
    const all = (await store.instances.list())._unsafeUnwrap();
    expect(all).toHaveLength(2);
  });

  it("list filters by status", async () => {
    const store = makeStore();
    const a = (
      await store.instances.create({ workflowName: "wf", goal: "a", slug: "a" })
    )._unsafeUnwrap();
    await store.instances.create({ workflowName: "wf", goal: "b", slug: "b" });
    await store.instances.update(a.id, { status: "running" });
    const running = (
      await store.instances.list({ status: "running" })
    )._unsafeUnwrap();
    expect(running).toHaveLength(1);
    expect(running[0].id as string).toBe(a.id as string);
  });

  it("addArtifact appends an artifact reference", async () => {
    const store = makeStore();
    const created = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();
    const updated = (
      await store.instances.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/g.md",
      })
    )._unsafeUnwrap();
    expect(updated.artifacts).toHaveLength(1);
    expect(updated.artifacts[0].name).toBe("plan");
    expect(updated.artifacts[0].path).toBe(".weave/plans/g.md");
  });

  it("addArtifact returns not_found for missing instance", async () => {
    const store = makeStore();
    const result = await store.instances.addArtifact(
      createWorkflowInstanceId("missing"),
      { name: "plan", path: "plan.md" },
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// Tests: ExecutionLease acquire / heartbeat / release
// ---------------------------------------------------------------------------

describe("InMemoryRuntimeStore — ExecutionLease", () => {
  it("acquire creates a new lease when none exists", async () => {
    const store = makeStore();
    const result = await store.leases.acquire({
      workflowInstanceId: createWorkflowInstanceId("wfi-001"),
      ownerId: createOwnerId("owner-001"),
      ttlMs: 60_000,
    });
    expect(result.isOk()).toBe(true);
    const lease = result._unsafeUnwrap();
    expect(lease.ownerId as string).toBe("owner-001");
    expect(lease.workflowInstanceId as string).toBe("wfi-001");
    expect(lease.id).toBeDefined();
    expect(lease.acquiredAt).toBeDefined();
    expect(lease.expiresAt).toBeDefined();
  });

  it("acquire fails with conflict when an unexpired lease exists", async () => {
    const store = makeStore();
    await store.leases.acquire({
      workflowInstanceId: createWorkflowInstanceId("wfi-001"),
      ownerId: createOwnerId("owner-001"),
      ttlMs: 60_000,
    });
    const result = await store.leases.acquire({
      workflowInstanceId: createWorkflowInstanceId("wfi-001"),
      ownerId: createOwnerId("owner-002"),
      ttlMs: 60_000,
    });
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("conflict");
  });

  it("acquire succeeds when the existing lease is expired", async () => {
    const now = new Date();
    let tick = 0;
    const clock = () => {
      // First call: acquire expired lease; subsequent calls: future time
      tick++;
      if (tick <= 1) {
        return new Date(now.getTime() - 120_000); // 2 min ago
      }
      return now;
    };
    const store = createInMemoryRuntimeStore({ clock });
    // Acquire with a 1ms TTL (will be expired by the time we check)
    await store.leases.acquire({
      workflowInstanceId: createWorkflowInstanceId("wfi-001"),
      ownerId: createOwnerId("old-owner"),
      ttlMs: 1,
    });
    // Now acquire again — the old lease is expired
    const result = await store.leases.acquire({
      workflowInstanceId: createWorkflowInstanceId("wfi-001"),
      ownerId: createOwnerId("new-owner"),
      ttlMs: 60_000,
    });
    expect(result.isOk()).toBe(true);
    const lease = result._unsafeUnwrap();
    expect(lease.ownerId as string).toBe("new-owner");
  });

  it("findActive returns null when no lease exists", async () => {
    const store = makeStore();
    const result = await store.leases.findActive();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it("findActive returns the active lease", async () => {
    const store = makeStore();
    await store.leases.acquire({
      workflowInstanceId: createWorkflowInstanceId("wfi-001"),
      ownerId: createOwnerId("owner-001"),
      ttlMs: 60_000,
    });
    const result = await store.leases.findActive();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).not.toBeNull();
  });

  it("getActive returns not_found when no active lease exists", async () => {
    const store = makeStore();
    const result = await store.leases.getActive();
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("not_found");
  });

  it("findById returns null for missing lease", async () => {
    const store = makeStore();
    const result = await store.leases.findById(
      createExecutionLeaseId("missing"),
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it("getById returns not_found for missing lease", async () => {
    const store = makeStore();
    const result = await store.leases.getById(
      createExecutionLeaseId("missing"),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("not_found");
  });

  it("heartbeat renews an active lease", async () => {
    const store = makeStore();
    const acquireResult = await store.leases.acquire({
      workflowInstanceId: createWorkflowInstanceId("wfi-001"),
      ownerId: createOwnerId("owner-001"),
      ttlMs: 60_000,
    });
    const lease = acquireResult._unsafeUnwrap();
    const heartbeatResult = await store.leases.heartbeat(
      lease.id,
      lease.ownerId,
      120_000,
    );
    expect(heartbeatResult.isOk()).toBe(true);
    const renewed = heartbeatResult._unsafeUnwrap();
    expect(renewed.lastHeartbeatAt).toBeDefined();
  });

  it("heartbeat fails with conflict for wrong owner", async () => {
    const store = makeStore();
    const acquireResult = await store.leases.acquire({
      workflowInstanceId: createWorkflowInstanceId("wfi-001"),
      ownerId: createOwnerId("owner-001"),
      ttlMs: 60_000,
    });
    const lease = acquireResult._unsafeUnwrap();
    const result = await store.leases.heartbeat(
      lease.id,
      createOwnerId("wrong-owner"),
      60_000,
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("conflict");
  });

  it("heartbeat fails with not_found for missing lease", async () => {
    const store = makeStore();
    const result = await store.leases.heartbeat(
      createExecutionLeaseId("missing"),
      createOwnerId("owner-001"),
      60_000,
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("not_found");
  });

  it("release removes the lease", async () => {
    const store = makeStore();
    const acquireResult = await store.leases.acquire({
      workflowInstanceId: createWorkflowInstanceId("wfi-001"),
      ownerId: createOwnerId("owner-001"),
      ttlMs: 60_000,
    });
    const lease = acquireResult._unsafeUnwrap();
    const releaseResult = await store.leases.release(lease.id, lease.ownerId);
    expect(releaseResult.isOk()).toBe(true);
    const findResult = await store.leases.findById(lease.id);
    expect(findResult._unsafeUnwrap()).toBeNull();
  });

  it("release fails with conflict for wrong owner", async () => {
    const store = makeStore();
    const acquireResult = await store.leases.acquire({
      workflowInstanceId: createWorkflowInstanceId("wfi-001"),
      ownerId: createOwnerId("owner-001"),
      ttlMs: 60_000,
    });
    const lease = acquireResult._unsafeUnwrap();
    const result = await store.leases.release(
      lease.id,
      createOwnerId("wrong-owner"),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("conflict");
  });

  it("release fails with not_found for missing lease", async () => {
    const store = makeStore();
    const result = await store.leases.release(
      createExecutionLeaseId("missing"),
      createOwnerId("owner-001"),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// Tests: SessionSnapshot
// ---------------------------------------------------------------------------

describe("InMemoryRuntimeStore — SessionSnapshot", () => {
  it("record creates a snapshot", async () => {
    const store = makeStore();
    const result = await store.snapshots.record({
      workflowInstanceId: createWorkflowInstanceId("wfi-001"),
      leaseId: createExecutionLeaseId("lease-001"),
      harnessName: "test-harness",
      agentName: "shuttle",
      sessionStatus: "active",
      metadata: { stepCount: 1 },
    });
    expect(result.isOk()).toBe(true);
    const snap = result._unsafeUnwrap();
    expect(snap.harnessName).toBe("test-harness");
    expect(snap.agentName).toBe("shuttle");
    expect(snap.sessionStatus).toBe("active");
    expect(snap.metadata.stepCount).toBe(1);
    expect(snap.id).toBeDefined();
    expect(snap.recordedAt).toBeDefined();
  });

  it("findById returns null for missing snapshot", async () => {
    const store = makeStore();
    const result = await store.snapshots.findById(
      createSessionSnapshotId("missing"),
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it("getById returns not_found for missing snapshot", async () => {
    const store = makeStore();
    const result = await store.snapshots.getById(
      createSessionSnapshotId("missing"),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("not_found");
  });

  it("listByWorkflowInstance returns snapshots for the instance", async () => {
    const store = makeStore();
    const wfiId = createWorkflowInstanceId("wfi-001");
    await store.snapshots.record({
      workflowInstanceId: wfiId,
      leaseId: createExecutionLeaseId("lease-001"),
      harnessName: "h",
      agentName: "shuttle",
      sessionStatus: "active",
      metadata: {},
    });
    await store.snapshots.record({
      workflowInstanceId: wfiId,
      leaseId: createExecutionLeaseId("lease-001"),
      harnessName: "h",
      agentName: "shuttle",
      sessionStatus: "idle",
      metadata: {},
    });
    // Different instance
    await store.snapshots.record({
      workflowInstanceId: createWorkflowInstanceId("wfi-002"),
      leaseId: createExecutionLeaseId("lease-002"),
      harnessName: "h",
      agentName: "shuttle",
      sessionStatus: "active",
      metadata: {},
    });
    const result = await store.snapshots.listByWorkflowInstance(wfiId);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(2);
  });

  it("findLatestByWorkflowInstance returns the most recent snapshot", async () => {
    const store = makeStore();
    const wfiId = createWorkflowInstanceId("wfi-001");
    await store.snapshots.record({
      workflowInstanceId: wfiId,
      leaseId: createExecutionLeaseId("lease-001"),
      harnessName: "h",
      agentName: "shuttle",
      sessionStatus: "active",
      metadata: { order: 1 },
    });
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 5));
    await store.snapshots.record({
      workflowInstanceId: wfiId,
      leaseId: createExecutionLeaseId("lease-001"),
      harnessName: "h",
      agentName: "shuttle",
      sessionStatus: "idle",
      metadata: { order: 2 },
    });
    const result = await store.snapshots.findLatestByWorkflowInstance(wfiId);
    expect(result.isOk()).toBe(true);
    const latest = result._unsafeUnwrap();
    expect(latest).not.toBeNull();
    expect(latest?.metadata.order).toBe(2);
  });

  it("findLatestByWorkflowInstance returns null when no snapshots exist", async () => {
    const store = makeStore();
    const result = await store.snapshots.findLatestByWorkflowInstance(
      createWorkflowInstanceId("wfi-none"),
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: RuntimeJournal
// ---------------------------------------------------------------------------

describe("InMemoryRuntimeStore — RuntimeJournal", () => {
  it("append creates a journal entry with id and timestamp", async () => {
    const store = makeStore();
    const result = await store.journal.append({
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
    expect(entry.eventType).toBe("step.started");
    expect(entry.severity).toBe("info");
  });

  it("findById returns null for missing entry", async () => {
    const store = makeStore();
    const result = await store.journal.findById(
      createRuntimeJournalEntryId("missing"),
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it("getById returns not_found for missing entry", async () => {
    const store = makeStore();
    const result = await store.journal.getById(
      createRuntimeJournalEntryId("missing"),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("not_found");
  });

  it("query returns all entries when no filter is provided", async () => {
    const store = makeStore();
    await store.journal.append({
      source: { kind: "engine", name: "runner" },
      eventType: "a",
      severity: "info",
      data: {},
    });
    await store.journal.append({
      source: { kind: "adapter", name: "opencode" },
      eventType: "b",
      severity: "warn",
      data: {},
    });
    const result = await store.journal.query();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(2);
  });

  it("query filters by sourceKind", async () => {
    const store = makeStore();
    await store.journal.append({
      source: { kind: "engine", name: "runner" },
      eventType: "a",
      severity: "info",
      data: {},
    });
    await store.journal.append({
      source: { kind: "adapter", name: "opencode" },
      eventType: "b",
      severity: "info",
      data: {},
    });
    const result = await store.journal.query({ sourceKind: "engine" });
    expect(result.isOk()).toBe(true);
    const entries = result._unsafeUnwrap();
    expect(entries).toHaveLength(1);
    expect(entries[0].source.kind).toBe("engine");
  });

  it("query filters by eventType", async () => {
    const store = makeStore();
    await store.journal.append({
      source: { kind: "engine", name: "runner" },
      eventType: "step.started",
      severity: "info",
      data: {},
    });
    await store.journal.append({
      source: { kind: "engine", name: "runner" },
      eventType: "step.completed",
      severity: "info",
      data: {},
    });
    const result = await store.journal.query({ eventType: "step.started" });
    expect(result.isOk()).toBe(true);
    const entries = result._unsafeUnwrap();
    expect(entries).toHaveLength(1);
    expect(entries[0].eventType).toBe("step.started");
  });

  it("query filters by severity", async () => {
    const store = makeStore();
    await store.journal.append({
      source: { kind: "engine", name: "runner" },
      eventType: "a",
      severity: "info",
      data: {},
    });
    await store.journal.append({
      source: { kind: "engine", name: "runner" },
      eventType: "b",
      severity: "error",
      data: {},
    });
    const result = await store.journal.query({ severity: "error" });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(1);
  });

  it("query filters by sourceName", async () => {
    const store = makeStore();
    await store.journal.append({
      source: { kind: "engine", name: "runner" },
      eventType: "a",
      severity: "info",
      data: {},
    });
    await store.journal.append({
      source: { kind: "engine", name: "other" },
      eventType: "b",
      severity: "info",
      data: {},
    });
    const result = await store.journal.query({ sourceName: "runner" });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(1);
  });

  it("query respects limit", async () => {
    const store = makeStore();
    for (let i = 0; i < 5; i++) {
      await store.journal.append({
        source: { kind: "engine", name: "runner" },
        eventType: "tick",
        severity: "debug",
        data: {},
      });
    }
    const result = await store.journal.query({ limit: 3 });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(3);
  });

  it("query filters by workflowInstanceId", async () => {
    const store = makeStore();
    const wfiId = createWorkflowInstanceId("wfi-001");
    await store.journal.append({
      source: { kind: "engine", name: "runner" },
      eventType: "a",
      severity: "info",
      workflowInstanceId: wfiId,
      data: {},
    });
    await store.journal.append({
      source: { kind: "engine", name: "runner" },
      eventType: "b",
      severity: "info",
      data: {},
    });
    const result = await store.journal.query({ workflowInstanceId: wfiId });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: Transaction / unit-of-work
// ---------------------------------------------------------------------------

describe("InMemoryRuntimeStore — transaction", () => {
  it("transaction exposes all sub-repositories", async () => {
    const store = makeStore();
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
    const store = makeStore();
    const result = await store.transaction((_tx) => {
      return errAsync(queryError("Simulated failure"));
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("query");
  });

  it("transaction commits changes on success", async () => {
    const store = makeStore();
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

    // Verify the change is visible outside the transaction
    const found = (await store.instances.findById(instance.id))._unsafeUnwrap();
    expect(found).not.toBeNull();
  });

  it("transaction rolls back changes on Err", async () => {
    const store = makeStore();

    // Pre-create an instance
    const existing = (
      await store.instances.create({
        workflowName: "wf",
        goal: "existing",
        slug: "existing",
      })
    )._unsafeUnwrap();

    // Transaction that creates a new instance then fails
    const result = await store.transaction((tx) => {
      return tx.instances
        .create({
          workflowName: "wf",
          goal: "new-in-tx",
          slug: "new-in-tx",
        })
        .andThen(() => errAsync(queryError("Rollback!")));
    });

    expect(result.isErr()).toBe(true);

    // The new instance should NOT be visible (rolled back)
    const all = (await store.instances.list())._unsafeUnwrap();
    expect(all).toHaveLength(1);
    expect(all[0].id as string).toBe(existing.id as string);
  });

  it("transaction rolls back lease changes on Err", async () => {
    const store = makeStore();

    const result = await store.transaction((tx) => {
      return tx.leases
        .acquire({
          workflowInstanceId: createWorkflowInstanceId("wfi-001"),
          ownerId: createOwnerId("owner-001"),
          ttlMs: 60_000,
        })
        .andThen(() => errAsync(queryError("Rollback!")));
    });

    expect(result.isErr()).toBe(true);

    // Lease should not exist after rollback
    const active = (await store.leases.findActive())._unsafeUnwrap();
    expect(active).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: Failure injection
// ---------------------------------------------------------------------------

describe("InMemoryRuntimeStore — failure injection", () => {
  it("workflowCreate failure injection returns the injected error", async () => {
    const store = createInMemoryRuntimeStore({
      failOn: {
        workflowCreate: initializationError("injected create failure"),
      },
    });
    const result = await store.instances.create({
      workflowName: "wf",
      goal: "g",
      slug: "g",
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("initialization");
  });

  it("leaseAcquire failure injection returns the injected error", async () => {
    const store = createInMemoryRuntimeStore({
      failOn: {
        leaseAcquire: conflictError("ExecutionLease", "injected conflict"),
      },
    });
    const result = await store.leases.acquire({
      workflowInstanceId: createWorkflowInstanceId("wfi-001"),
      ownerId: createOwnerId("owner-001"),
      ttlMs: 60_000,
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("conflict");
  });

  it("journalAppend failure injection returns the injected error", async () => {
    const store = createInMemoryRuntimeStore({
      failOn: {
        journalAppend: journalWriteError("injected journal failure"),
      },
    });
    const result = await store.journal.append({
      source: { kind: "engine", name: "runner" },
      eventType: "test",
      severity: "info",
      data: {},
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("journal_write");
  });

  it("transaction failure injection returns the injected error", async () => {
    const store = createInMemoryRuntimeStore({
      failOn: {
        transaction: queryError("injected transaction failure"),
      },
    });
    const result = await store.transaction((_tx) => okAsync("ok" as const));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("query");
  });

  it("close failure injection returns the injected error", async () => {
    const store = createInMemoryRuntimeStore({
      failOn: {
        close: queryError("injected close failure"),
      },
    });
    const result = await store.close();
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("query");
  });

  it("setFailures updates failure config at runtime", async () => {
    const store = makeStore();

    // Initially no failure
    const ok = await store.instances.create({
      workflowName: "wf",
      goal: "g",
      slug: "g",
    });
    expect(ok.isOk()).toBe(true);

    // Inject failure
    store.setFailures({
      workflowCreate: queryError("now failing"),
    });

    const fail = await store.instances.create({
      workflowName: "wf",
      goal: "g2",
      slug: "g2",
    });
    expect(fail.isErr()).toBe(true);
    expect(fail._unsafeUnwrapErr().type).toBe("query");

    // Clear failure
    store.setFailures({});

    const ok2 = await store.instances.create({
      workflowName: "wf",
      goal: "g3",
      slug: "g3",
    });
    expect(ok2.isOk()).toBe(true);
  });

  it("snapshotRecord failure injection returns the injected error", async () => {
    const store = createInMemoryRuntimeStore({
      failOn: {
        snapshotRecord: queryError("injected snapshot failure"),
      },
    });
    const result = await store.snapshots.record({
      workflowInstanceId: createWorkflowInstanceId("wfi-001"),
      leaseId: createExecutionLeaseId("lease-001"),
      harnessName: "h",
      agentName: "shuttle",
      sessionStatus: "active",
      metadata: {},
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("query");
  });

  it("workflowUpdate failure injection returns the injected error", async () => {
    const store = makeStore();
    const created = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    store.setFailures({ workflowUpdate: queryError("update failure") });

    const result = await store.instances.update(created.id, {
      status: "running",
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("query");
  });

  it("leaseHeartbeat failure injection returns the injected error", async () => {
    const store = makeStore();
    const lease = (
      await store.leases.acquire({
        workflowInstanceId: createWorkflowInstanceId("wfi-001"),
        ownerId: createOwnerId("owner-001"),
        ttlMs: 60_000,
      })
    )._unsafeUnwrap();

    store.setFailures({ leaseHeartbeat: queryError("heartbeat failure") });

    const result = await store.leases.heartbeat(
      lease.id,
      lease.ownerId,
      60_000,
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("query");
  });

  it("leaseRelease failure injection returns the injected error", async () => {
    const store = makeStore();
    const lease = (
      await store.leases.acquire({
        workflowInstanceId: createWorkflowInstanceId("wfi-001"),
        ownerId: createOwnerId("owner-001"),
        ttlMs: 60_000,
      })
    )._unsafeUnwrap();

    store.setFailures({ leaseRelease: queryError("release failure") });

    const result = await store.leases.release(lease.id, lease.ownerId);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("query");
  });
});

// ---------------------------------------------------------------------------
// Tests: No filesystem access
// ---------------------------------------------------------------------------

describe("InMemoryRuntimeStore — no filesystem access", () => {
  it("does not write any files (no .weave/runtime directory created)", async () => {
    // This test verifies the in-memory store is purely in-memory.
    // We simply exercise all operations and verify no errors related to
    // filesystem access occur.
    const store = createInMemoryRuntimeStore();

    const instance = (
      await store.instances.create({
        workflowName: "wf",
        goal: "g",
        slug: "g",
      })
    )._unsafeUnwrap();

    const lease = (
      await store.leases.acquire({
        workflowInstanceId: instance.id,
        ownerId: createOwnerId("owner-001"),
        ttlMs: 60_000,
      })
    )._unsafeUnwrap();

    await store.snapshots.record({
      workflowInstanceId: instance.id,
      leaseId: lease.id,
      harnessName: "test",
      agentName: "shuttle",
      sessionStatus: "active",
      metadata: {},
    });

    await store.journal.append({
      source: { kind: "engine", name: "runner" },
      eventType: "test",
      severity: "info",
      data: {},
    });

    const closeResult = await store.close();
    expect(closeResult.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: Custom clock
// ---------------------------------------------------------------------------

describe("InMemoryRuntimeStore — custom clock", () => {
  it("uses the provided clock for lease expiry checks", async () => {
    const fixedTime = new Date("2026-01-01T00:00:00.000Z");
    const store = createInMemoryRuntimeStore({
      clock: () => fixedTime,
    });

    const result = await store.leases.acquire({
      workflowInstanceId: createWorkflowInstanceId("wfi-001"),
      ownerId: createOwnerId("owner-001"),
      ttlMs: 60_000,
    });
    expect(result.isOk()).toBe(true);
    const lease = result._unsafeUnwrap();
    expect(lease.acquiredAt).toBe("2026-01-01T00:00:00.000Z");
    expect(lease.expiresAt).toBe("2026-01-01T00:01:00.000Z");
  });
});
