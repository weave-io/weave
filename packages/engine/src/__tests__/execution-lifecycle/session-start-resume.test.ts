/**
 * Tests for session.ts, start.ts, and resume.ts lifecycle modules.
 *
 * Verifies:
 * - observeSession: stores snapshot, rejects denied metadata, validates required fields
 * - startExecution: creates instance, acquires lease, enforces authorization
 * - resumeExecution: rebinds lease, handles conflicts, enforces authorization
 */

import { describe, expect, it } from "bun:test";
import {
  createExecutionLeaseId,
  createInMemoryRuntimeStore,
  createOwnerId,
  createWorkflowInstanceId,
  observeSession,
  queryError,
  resumeExecution,
  startExecution,
} from "@weaveio/weave-engine";
import { leaseId, wfId } from "./fixtures.js";

// ---------------------------------------------------------------------------
// observeSession
// ---------------------------------------------------------------------------

describe("observeSession", () => {
  it("stores a sanitized SessionSnapshot and returns snapshotId", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await observeSession(
      {
        workflowInstanceId: wfId,
        leaseId,
        harnessName: "opencode",
        agentName: "loom",
        sessionStatus: "active",
        metadata: { stepIndex: 1, isRetry: false },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { snapshotId } = result.value;
    expect(typeof snapshotId).toBe("string");
    expect(snapshotId.length).toBeGreaterThan(0);

    const fetchResult = await store.snapshots.getById(snapshotId);
    expect(fetchResult.isOk()).toBe(true);
    if (!fetchResult.isOk()) return;

    const snapshot = fetchResult.value;
    expect(snapshot.workflowInstanceId).toBe(wfId);
    expect(snapshot.harnessName).toBe("opencode");
    expect(snapshot.agentName).toBe("loom");
    expect(snapshot.sessionStatus).toBe("active");
  });

  it("rejects metadata with 'password' key", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await observeSession(
      {
        workflowInstanceId: wfId,
        leaseId,
        harnessName: "opencode",
        agentName: "loom",
        sessionStatus: "active",
        metadata: { password: "hunter2" } as Record<
          string,
          string | number | boolean
        >,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });

  it("returns validation error for missing workflowInstanceId", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await observeSession(
      {
        workflowInstanceId: "" as typeof wfId,
        leaseId,
        harnessName: "opencode",
        agentName: "loom",
        sessionStatus: "active",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("workflowInstanceId");
    }
  });

  it("returns persistence error when store fails", async () => {
    const store = createInMemoryRuntimeStore({
      failOn: { snapshotRecord: queryError("injected snapshot failure") },
    });
    const result = await observeSession(
      {
        workflowInstanceId: wfId,
        leaseId,
        harnessName: "opencode",
        agentName: "loom",
        sessionStatus: "active",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("persistence");
  });
});

// ---------------------------------------------------------------------------
// startExecution
// ---------------------------------------------------------------------------

describe("startExecution", () => {
  it("creates a WorkflowInstance and acquires an active ExecutionLease", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await startExecution(
      {
        workflowInstanceId: wfId,
        ownerId: "session-start-001",
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { leaseId: acquiredLeaseId, effects } = result.value;
    expect(typeof acquiredLeaseId).toBe("string");
    expect(effects).toHaveLength(0);

    const leaseResult = await store.leases.getById(acquiredLeaseId);
    expect(leaseResult.isOk()).toBe(true);
    if (!leaseResult.isOk()) return;
    expect(leaseResult.value.workflowInstanceId).toBe(wfId);
    expect(leaseResult.value.ownerId).toBe(createOwnerId("session-start-001"));
  });

  it("rejects 'agent' authorization source", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await startExecution(
      {
        workflowInstanceId: wfId,
        ownerId: "session-agent",
        authorizationSource: "agent",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
  });

  it("rejects 'hook' authorization source", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await startExecution(
      {
        workflowInstanceId: wfId,
        ownerId: "session-hook",
        authorizationSource: "hook",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
  });

  it("returned workflowInstanceId matches the created instance and acquired lease", async () => {
    const store = createInMemoryRuntimeStore();
    const targetId = createWorkflowInstanceId("regression-id-match-001");

    const result = await startExecution(
      {
        workflowInstanceId: targetId,
        ownerId: "session-regression-test",
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const output = result.value;
    expect(output.workflowInstanceId).toBe(targetId);

    const instanceResult = await store.instances.getById(targetId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.id).toBe(targetId);

    const leaseResult = await store.leases.getById(output.leaseId);
    expect(leaseResult.isOk()).toBe(true);
    if (!leaseResult.isOk()) return;
    expect(leaseResult.value.workflowInstanceId).toBe(targetId);
  });

  it("returns validation error for missing ownerId", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await startExecution(
      { workflowInstanceId: wfId, ownerId: "" },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });
});

// ---------------------------------------------------------------------------
// resumeExecution
// ---------------------------------------------------------------------------

describe("resumeExecution", () => {
  it("rebinds to an available execution (no active lease)", async () => {
    const store = createInMemoryRuntimeStore();

    const createResult = await store.instances.create({
      workflowName: "resume-workflow",
      goal: "resume goal",
      slug: "resume-goal",
    });
    expect(createResult.isOk()).toBe(true);
    if (!createResult.isOk()) return;
    const instanceId = createResult.value.id;

    await store.instances.update(instanceId, { status: "paused" });

    const result = await resumeExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "session-resume-001",
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { leaseId: newLeaseId, effects } = result.value;
    expect(typeof newLeaseId).toBe("string");
    expect(effects).toHaveLength(0);

    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.status).toBe("running");
  });

  it("returns typed lease_conflict error for unexpired foreign lease", async () => {
    const store = createInMemoryRuntimeStore();

    const createResult = await store.instances.create({
      workflowName: "conflict-workflow",
      goal: "conflict goal",
      slug: "conflict-goal",
    });
    expect(createResult.isOk()).toBe(true);
    if (!createResult.isOk()) return;
    const instanceId = createResult.value.id;

    const firstLeaseResult = await store.leases.acquire({
      workflowInstanceId: instanceId,
      ownerId: "session-foreign-owner" as ReturnType<typeof createOwnerId>,
      ttlMs: 3_600_000,
    });
    expect(firstLeaseResult.isOk()).toBe(true);
    if (!firstLeaseResult.isOk()) return;
    const foreignLeaseId = firstLeaseResult.value.id;

    const result = await resumeExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "session-new-owner",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("lease_conflict");
    if (result.error.type === "lease_conflict") {
      expect(result.error.conflictingLeaseId).toBe(foreignLeaseId);
    }
  });

  it("rejects 'agent' authorization source", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await resumeExecution(
      {
        workflowInstanceId: wfId,
        ownerId: "session-agent",
        authorizationSource: "agent",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
  });

  it("returns not_found error when workflow instance does not exist", async () => {
    const store = createInMemoryRuntimeStore();
    const nonExistentId = createWorkflowInstanceId("non-existent-wf-id");

    const result = await resumeExecution(
      {
        workflowInstanceId: nonExistentId,
        ownerId: "session-not-found",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("not_found");
    if (result.error.type === "not_found") {
      expect(result.error.entity).toBe("WorkflowInstance");
    }
  });
});

// ---------------------------------------------------------------------------
// resumeExecution > recoveryTakeover (Issue #21 Task 12 S020)
// ---------------------------------------------------------------------------

describe("resumeExecution > recoveryTakeover", () => {
  async function pausedInstanceWithOldLease(
    store: ReturnType<typeof createInMemoryRuntimeStore>,
  ) {
    const createResult = await store.instances.create({
      workflowName: "reload-workflow",
      goal: "reload goal",
      slug: "reload-goal",
    });
    if (!createResult.isOk()) throw new Error("failed to create instance");
    const instanceId = createResult.value.id;
    await store.instances.update(instanceId, { status: "paused" });

    const oldLeaseResult = await store.leases.acquire({
      workflowInstanceId: instanceId,
      ownerId: "controller-gen-old" as ReturnType<typeof createOwnerId>,
      ttlMs: 3_600_000,
    });
    if (!oldLeaseResult.isOk()) throw new Error("failed to acquire old lease");

    return { instanceId, oldLease: oldLeaseResult.value };
  }

  it("takes over the exact correlated pre-reload lease and acquires a fresh one", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, oldLease } = await pausedInstanceWithOldLease(store);

    const result = await resumeExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "controller-gen-new",
        authorizationSource: "user",
        recoveryTakeover: {
          expectedLeaseId: oldLease.id,
          expectedOwnerId: createOwnerId("controller-gen-old"),
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.leaseId).not.toBe(oldLease.id);

    const oldLeaseLookup = await store.leases.findById(oldLease.id);
    expect(oldLeaseLookup.isOk()).toBe(true);
    if (!oldLeaseLookup.isOk()) return;
    expect(oldLeaseLookup.value).toBeNull();

    const freshLease = await store.leases.getById(result.value.leaseId);
    expect(freshLease.isOk()).toBe(true);
    if (!freshLease.isOk()) return;
    expect(freshLease.value.ownerId).toBe(createOwnerId("controller-gen-new"));

    const instance = await store.instances.getById(instanceId);
    expect(instance.isOk()).toBe(true);
    if (!instance.isOk()) return;
    expect(instance.value.status).toBe("running");
  });

  it("fails closed with no mutation when the expected lease ID does not match", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, oldLease } = await pausedInstanceWithOldLease(store);

    const result = await resumeExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "controller-gen-new",
        authorizationSource: "user",
        recoveryTakeover: {
          expectedLeaseId: createExecutionLeaseId("some-other-lease"),
          expectedOwnerId: createOwnerId("controller-gen-old"),
        },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("lease_conflict");

    const stillActive = await store.leases.findById(oldLease.id);
    expect(stillActive.isOk()).toBe(true);
    if (!stillActive.isOk()) return;
    expect(stillActive.value).not.toBeNull();

    const instance = await store.instances.getById(instanceId);
    expect(instance.isOk()).toBe(true);
    if (!instance.isOk()) return;
    expect(instance.value.status).toBe("paused");
  });

  it("fails closed with no mutation when the expected owner does not match", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, oldLease } = await pausedInstanceWithOldLease(store);

    const result = await resumeExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "controller-gen-new",
        authorizationSource: "user",
        recoveryTakeover: {
          expectedLeaseId: oldLease.id,
          expectedOwnerId: createOwnerId("some-other-controller-generation"),
        },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("lease_conflict");

    const stillActive = await store.leases.findById(oldLease.id);
    expect(stillActive.isOk()).toBe(true);
    if (!stillActive.isOk()) return;
    expect(stillActive.value).not.toBeNull();
  });

  it("fails closed on malformed correlation (missing expectedLeaseId)", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId } = await pausedInstanceWithOldLease(store);

    const result = await resumeExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "controller-gen-new",
        authorizationSource: "user",
        recoveryTakeover: {
          expectedLeaseId: createExecutionLeaseId(""),
          expectedOwnerId: createOwnerId("controller-gen-old"),
        },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("recoveryTakeover.expectedLeaseId");
    }
  });

  it("fails closed on malformed correlation (whitespace-only expectedOwnerId)", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, oldLease } = await pausedInstanceWithOldLease(store);

    const result = await resumeExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "controller-gen-new",
        authorizationSource: "user",
        recoveryTakeover: {
          expectedLeaseId: oldLease.id,
          expectedOwnerId: createOwnerId("   "),
        },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("recoveryTakeover.expectedOwnerId");
    }
  });

  it("fails closed for a terminal workflow instance even with a well-formed correlation", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, oldLease } = await pausedInstanceWithOldLease(store);
    await store.instances.update(instanceId, { status: "completed" });

    const result = await resumeExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "controller-gen-new",
        authorizationSource: "user",
        recoveryTakeover: {
          expectedLeaseId: oldLease.id,
          expectedOwnerId: createOwnerId("controller-gen-old"),
        },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("lease_conflict");
  });

  it("succeeds via a plain acquire when the correlated lease has already expired (nothing to take over)", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, oldLease } = await pausedInstanceWithOldLease(store);

    // Release the old lease directly to simulate it no longer being active
    // (e.g. it already expired) — takeover should not be required to resume.
    await store.leases.release(
      oldLease.id,
      "controller-gen-old" as ReturnType<typeof createOwnerId>,
    );

    const result = await resumeExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "controller-gen-new",
        authorizationSource: "user",
        recoveryTakeover: {
          expectedLeaseId: oldLease.id,
          expectedOwnerId: createOwnerId("controller-gen-old"),
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.leaseId).not.toBe(oldLease.id);
  });

  it("fails closed with no mutation when authorizationSource is missing for a takeover", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, oldLease } = await pausedInstanceWithOldLease(store);

    const result = await resumeExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "controller-gen-new",
        recoveryTakeover: {
          expectedLeaseId: oldLease.id,
          expectedOwnerId: createOwnerId("controller-gen-old"),
        },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("authorizationSource");
    }

    const stillActive = await store.leases.findById(oldLease.id);
    expect(stillActive.isOk()).toBe(true);
    if (!stillActive.isOk()) return;
    expect(stillActive.value).not.toBeNull();

    const instance = await store.instances.getById(instanceId);
    expect(instance.isOk()).toBe(true);
    if (!instance.isOk()) return;
    expect(instance.value.status).toBe("paused");
  });

  it("fails closed with no mutation when authorizationSource is non-user for a takeover", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, oldLease } = await pausedInstanceWithOldLease(store);

    const result = await resumeExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "controller-gen-new",
        authorizationSource: "agent",
        recoveryTakeover: {
          expectedLeaseId: oldLease.id,
          expectedOwnerId: createOwnerId("controller-gen-old"),
        },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("authorizationSource");
    }

    const stillActive = await store.leases.findById(oldLease.id);
    expect(stillActive.isOk()).toBe(true);
    if (!stillActive.isOk()) return;
    expect(stillActive.value).not.toBeNull();
  });
});
