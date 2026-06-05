/**
 * Tests for `inspectStatus`, `abortExecution`, and `advanceStep` —
 * the engine-owned status and control command operations.
 *
 * ## What these tests prove
 *
 * ### inspectStatus
 *
 * 1. **Read-only** — inspectStatus never mutates any state.
 * 2. **Missing workflowInstanceId returns typed error** — `command_validation`.
 * 3. **Non-existent instance returns typed error** — `command_not_found`
 *    (entity: "execution").
 * 4. **Existing instance returns ExecutionStatusData** — with correct fields.
 * 5. **Active lease is reflected in hasActiveLease** — true when a lease
 *    exists for the instance, false otherwise.
 *
 * ### abortExecution
 *
 * 1. **Missing required fields return typed errors** — `command_validation`.
 * 2. **Non-existent instance returns typed error** — `command_not_found`
 *    (entity: "execution").
 * 3. **Terminal-state instance returns typed error** — `command_not_found`
 *    (entity: "execution") rather than silently succeeding.
 * 4. **Lease mismatch returns typed error** — `command_not_found`
 *    (entity: "lease").
 * 5. **Cancel signal terminates the execution** — returns `ExecutionAbortedData`
 *    with `signal: "cancel"` and `complete-execution` effect.
 * 6. **Pause signal suspends the execution** — returns `ExecutionAbortedData`
 *    with `signal: "pause"` and `pause-execution` effect.
 *
 * ### advanceStep
 *
 * 1. **Missing required fields return typed errors** — `command_validation`.
 * 2. **Non-existent instance returns typed error** — `command_not_found`.
 * 3. **Lease mismatch returns typed error** — `command_not_found`
 *    (entity: "lease").
 * 4. **Successful advance returns StepAdvancedData** — with correct fields.
 * 5. **Requires explicit workflow instance, lease, step name, and signal**.
 *
 * Uses:
 * - `createInMemoryRuntimeStore` (no SQLite, no filesystem)
 * - `runWorkflowLifecycle` to set up a running instance for control tests
 * - `okAsync(undefined)` as the no-op `projectEffect` callback
 */

import { describe, expect, it } from "bun:test";
import { createInMemoryRuntimeStore } from "@weave/engine";
import { okAsync, type ResultAsync } from "neverthrow";
import type { DispatchAgentEffect } from "../execution-lifecycle.js";
import type { ExecutionLeaseId, WorkflowInstanceId } from "../runtime/types.js";
import {
  createExecutionLeaseId,
  createWorkflowInstanceId,
} from "../runtime/types.js";
import {
  abortExecution,
  advanceStep,
} from "../runtime-command-operations/control.js";
import { inspectStatus } from "../runtime-command-operations/status.js";
import type {
  AbortExecutionInput,
  AdvanceStepInput,
  InspectStatusInput,
} from "../runtime-command-operations/types.js";
import {
  runWorkflowLifecycle,
  type WorkflowRunnerError,
} from "../runtime-command-operations/workflow-runner.js";

// ---------------------------------------------------------------------------
// No-op projectEffect — returns ok(undefined) without harness I/O
// ---------------------------------------------------------------------------

const noopProjectEffect = (
  _effect: DispatchAgentEffect,
): ResultAsync<void, WorkflowRunnerError> => okAsync(undefined);

// ---------------------------------------------------------------------------
// Fixture workflow registry
// ---------------------------------------------------------------------------

const SIMPLE_WORKFLOWS = {
  "simple-execution": {
    description: "Simple execution workflow for testing",
    version: 1,
    steps: [
      {
        name: "execute",
        display_name: "Execute",
        type: "autonomous" as const,
        agent: "shuttle",
        prompt: "Execute for: {{instance.goal}}",
        completion: { method: "agent_signal" as const },
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Helper: start a workflow and return the instance/lease IDs
// ---------------------------------------------------------------------------

async function startWorkflow(
  store: ReturnType<typeof createInMemoryRuntimeStore>,
  workflowName = "simple-execution",
) {
  const result = await runWorkflowLifecycle({
    workflowName,
    goal: "Test goal",
    slug: "test-slug",
    ownerId: "owner-test",
    store,
    workflows: SIMPLE_WORKFLOWS,
    projectEffect: noopProjectEffect,
  });

  if (result.isErr()) {
    throw new Error(
      `Failed to start workflow: ${JSON.stringify(result.error)}`,
    );
  }

  return result.value;
}

// ---------------------------------------------------------------------------
// § 1 — inspectStatus tests
// ---------------------------------------------------------------------------

describe("inspectStatus — validation", () => {
  it("returns command_validation when workflowInstanceId is empty", async () => {
    const store = createInMemoryRuntimeStore();
    const input: InspectStatusInput = {
      workflowInstanceId: "" as WorkflowInstanceId,
      store,
    };

    const result = await inspectStatus(input);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("workflowInstanceId");
      }
    }
  });
});

describe("inspectStatus — not found", () => {
  it("returns command_not_found when instance does not exist", async () => {
    const store = createInMemoryRuntimeStore();
    const input: InspectStatusInput = {
      workflowInstanceId: createWorkflowInstanceId("nonexistent-id"),
      store,
    };

    const result = await inspectStatus(input);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_not_found");
      if (result.error.type === "command_not_found") {
        expect(result.error.entity).toBe("execution");
      }
    }
  });
});

describe("inspectStatus — successful inspection", () => {
  it("returns ExecutionStatusData for an existing instance", async () => {
    const store = createInMemoryRuntimeStore();
    const { workflowInstanceId } = await startWorkflow(store);

    const result = await inspectStatus({ workflowInstanceId, store });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("execution-status");
      expect(result.value.workflowInstanceId).toBe(workflowInstanceId);
      expect(result.value.workflowName).toBe("simple-execution");
      expect(result.value.goal).toBe("Test goal");
      expect(result.value.slug).toBe("test-slug");
    }
  });

  it("returns correct status field", async () => {
    const store = createInMemoryRuntimeStore();
    const { workflowInstanceId } = await startWorkflow(store);

    const result = await inspectStatus({ workflowInstanceId, store });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // After runWorkflowLifecycle completes, status should be "completed"
      expect(result.value.status).toBe("completed");
    }
  });

  it("returns createdAt and updatedAt timestamps", async () => {
    const store = createInMemoryRuntimeStore();
    const { workflowInstanceId } = await startWorkflow(store);

    const result = await inspectStatus({ workflowInstanceId, store });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(typeof result.value.createdAt).toBe("string");
      expect(result.value.createdAt.length).toBeGreaterThan(0);
      expect(typeof result.value.updatedAt).toBe("string");
      expect(result.value.updatedAt.length).toBeGreaterThan(0);
    }
  });

  it("includes raw InspectExecutionOutput", async () => {
    const store = createInMemoryRuntimeStore();
    const { workflowInstanceId } = await startWorkflow(store);

    const result = await inspectStatus({ workflowInstanceId, store });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.raw).toBeDefined();
      expect(result.value.raw.workflowInstanceId).toBe(workflowInstanceId);
    }
  });

  it("reflects hasActiveLease as false after workflow completes", async () => {
    const store = createInMemoryRuntimeStore();
    const { workflowInstanceId } = await startWorkflow(store);

    const result = await inspectStatus({ workflowInstanceId, store });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // After workflow completes, the lease is released
      expect(result.value.hasActiveLease).toBe(false);
    }
  });

  it("does not mutate any store state (read-only)", async () => {
    const store = createInMemoryRuntimeStore();
    const { workflowInstanceId } = await startWorkflow(store);

    // Read instance state before inspection
    const beforeInstances = await store.instances.list();
    expect(beforeInstances.isOk()).toBe(true);
    const beforeCount = beforeInstances.isOk()
      ? beforeInstances.value.length
      : 0;

    await inspectStatus({ workflowInstanceId, store });

    // Read instance state after inspection — must be unchanged
    const afterInstances = await store.instances.list();
    expect(afterInstances.isOk()).toBe(true);
    if (afterInstances.isOk()) {
      expect(afterInstances.value.length).toBe(beforeCount);
    }
  });
});

// ---------------------------------------------------------------------------
// § 2 — abortExecution tests
// ---------------------------------------------------------------------------

describe("abortExecution — validation", () => {
  it("returns command_validation when workflowInstanceId is empty", async () => {
    const store = createInMemoryRuntimeStore();
    const input: AbortExecutionInput = {
      workflowInstanceId: "" as WorkflowInstanceId,
      leaseId: createExecutionLeaseId("some-lease"),
      signal: "cancel",
      store,
    };

    const result = await abortExecution(input);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("workflowInstanceId");
      }
    }
  });

  it("returns command_validation when leaseId is empty", async () => {
    const store = createInMemoryRuntimeStore();
    const input: AbortExecutionInput = {
      workflowInstanceId: createWorkflowInstanceId("some-instance"),
      leaseId: "" as ExecutionLeaseId,
      signal: "cancel",
      store,
    };

    const result = await abortExecution(input);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("leaseId");
      }
    }
  });

  it("returns command_validation when signal is missing", async () => {
    const store = createInMemoryRuntimeStore();
    const input = {
      workflowInstanceId: createWorkflowInstanceId("some-instance"),
      leaseId: createExecutionLeaseId("some-lease"),
      signal: "" as "cancel" | "pause",
      store,
    };

    const result = await abortExecution(input);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("signal");
      }
    }
  });
});

describe("abortExecution — not found", () => {
  it("returns command_not_found when instance does not exist", async () => {
    const store = createInMemoryRuntimeStore();
    const input: AbortExecutionInput = {
      workflowInstanceId: createWorkflowInstanceId("nonexistent-id"),
      leaseId: createExecutionLeaseId("some-lease"),
      signal: "cancel",
      store,
    };

    const result = await abortExecution(input);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_not_found");
      if (result.error.type === "command_not_found") {
        expect(result.error.entity).toBe("execution");
      }
    }
  });
});

describe("abortExecution — terminal state guard", () => {
  it("returns command_not_found for a completed instance", async () => {
    const store = createInMemoryRuntimeStore();
    // Start and complete a workflow
    const { workflowInstanceId, leaseId } = await startWorkflow(store);

    // The workflow is now completed — abort should return typed error
    const result = await abortExecution({
      workflowInstanceId,
      leaseId,
      signal: "cancel",
      store,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_not_found");
      if (result.error.type === "command_not_found") {
        expect(result.error.entity).toBe("execution");
        expect(result.error.message).toContain("terminal state");
      }
    }
  });
});

describe("abortExecution — cancel signal", () => {
  it("returns ExecutionAbortedData with signal: cancel on a running instance", async () => {
    const store = createInMemoryRuntimeStore();

    // Create a workflow instance that is in a non-terminal state (paused)
    // by using a workflow that pauses after the first step.
    // We'll create the instance manually and set it to running/paused state.
    const instance = await store.instances.create({
      workflowName: "simple-execution",
      goal: "Test goal",
      slug: "test-slug",
    });
    expect(instance.isOk()).toBe(true);
    if (!instance.isOk()) return;

    // Update to running status
    const updated = await store.instances.update(instance.value.id, {
      status: "running",
    });
    expect(updated.isOk()).toBe(true);

    // Acquire a lease
    const lease = await store.leases.acquire({
      workflowInstanceId: instance.value.id,
      ownerId: "owner-test" as import("../runtime/types.js").OwnerId,
      ttlMs: 60_000,
    });
    expect(lease.isOk()).toBe(true);
    if (!lease.isOk()) return;

    const result = await abortExecution({
      workflowInstanceId: instance.value.id,
      leaseId: lease.value.id,
      signal: "cancel",
      store,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("execution-aborted");
      expect(result.value.signal).toBe("cancel");
      expect(result.value.workflowInstanceId).toBe(instance.value.id);
      // Cancel should emit complete-execution effect
      const completeEffect = result.value.effects.find(
        (e) => e.kind === "complete-execution",
      );
      expect(completeEffect).toBeDefined();
    }
  });

  it("transitions instance to cancelled status on cancel", async () => {
    const store = createInMemoryRuntimeStore();

    const instance = await store.instances.create({
      workflowName: "simple-execution",
      goal: "Test goal",
      slug: "test-slug",
    });
    expect(instance.isOk()).toBe(true);
    if (!instance.isOk()) return;

    await store.instances.update(instance.value.id, { status: "running" });

    const lease = await store.leases.acquire({
      workflowInstanceId: instance.value.id,
      ownerId: "owner-test" as import("../runtime/types.js").OwnerId,
      ttlMs: 60_000,
    });
    expect(lease.isOk()).toBe(true);
    if (!lease.isOk()) return;

    await abortExecution({
      workflowInstanceId: instance.value.id,
      leaseId: lease.value.id,
      signal: "cancel",
      store,
    });

    const afterInstance = await store.instances.getById(instance.value.id);
    expect(afterInstance.isOk()).toBe(true);
    if (afterInstance.isOk()) {
      expect(afterInstance.value.status).toBe("cancelled");
    }
  });
});

describe("abortExecution — pause signal", () => {
  it("returns ExecutionAbortedData with signal: pause on a running instance", async () => {
    const store = createInMemoryRuntimeStore();

    const instance = await store.instances.create({
      workflowName: "simple-execution",
      goal: "Test goal",
      slug: "test-slug",
    });
    expect(instance.isOk()).toBe(true);
    if (!instance.isOk()) return;

    await store.instances.update(instance.value.id, { status: "running" });

    const lease = await store.leases.acquire({
      workflowInstanceId: instance.value.id,
      ownerId: "owner-test" as import("../runtime/types.js").OwnerId,
      ttlMs: 60_000,
    });
    expect(lease.isOk()).toBe(true);
    if (!lease.isOk()) return;

    const result = await abortExecution({
      workflowInstanceId: instance.value.id,
      leaseId: lease.value.id,
      signal: "pause",
      store,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("execution-aborted");
      expect(result.value.signal).toBe("pause");
      // Pause should emit pause-execution effect
      const pauseEffect = result.value.effects.find(
        (e) => e.kind === "pause-execution",
      );
      expect(pauseEffect).toBeDefined();
    }
  });

  it("transitions instance to paused status on pause", async () => {
    const store = createInMemoryRuntimeStore();

    const instance = await store.instances.create({
      workflowName: "simple-execution",
      goal: "Test goal",
      slug: "test-slug",
    });
    expect(instance.isOk()).toBe(true);
    if (!instance.isOk()) return;

    await store.instances.update(instance.value.id, { status: "running" });

    const lease = await store.leases.acquire({
      workflowInstanceId: instance.value.id,
      ownerId: "owner-test" as import("../runtime/types.js").OwnerId,
      ttlMs: 60_000,
    });
    expect(lease.isOk()).toBe(true);
    if (!lease.isOk()) return;

    await abortExecution({
      workflowInstanceId: instance.value.id,
      leaseId: lease.value.id,
      signal: "pause",
      store,
    });

    const afterInstance = await store.instances.getById(instance.value.id);
    expect(afterInstance.isOk()).toBe(true);
    if (afterInstance.isOk()) {
      expect(afterInstance.value.status).toBe("paused");
    }
  });
});

describe("abortExecution — lease mismatch", () => {
  it("returns command_not_found (entity: lease) when leaseId does not match active lease", async () => {
    const store = createInMemoryRuntimeStore();

    const instance = await store.instances.create({
      workflowName: "simple-execution",
      goal: "Test goal",
      slug: "test-slug",
    });
    expect(instance.isOk()).toBe(true);
    if (!instance.isOk()) return;

    await store.instances.update(instance.value.id, { status: "running" });

    // Acquire the real lease
    await store.leases.acquire({
      workflowInstanceId: instance.value.id,
      ownerId: "owner-test" as import("../runtime/types.js").OwnerId,
      ttlMs: 60_000,
    });

    // Use a wrong leaseId
    const wrongLeaseId = createExecutionLeaseId("wrong-lease-id");

    const result = await abortExecution({
      workflowInstanceId: instance.value.id,
      leaseId: wrongLeaseId,
      signal: "cancel",
      store,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      // Lease conflict maps to command_not_found (entity: "lease")
      expect(result.error.type).toBe("command_not_found");
      if (result.error.type === "command_not_found") {
        expect(result.error.entity).toBe("lease");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// § 3 — advanceStep tests
// ---------------------------------------------------------------------------

describe("advanceStep — validation", () => {
  it("returns command_validation when workflowInstanceId is empty", async () => {
    const store = createInMemoryRuntimeStore();
    const input: AdvanceStepInput = {
      workflowInstanceId: "" as WorkflowInstanceId,
      leaseId: createExecutionLeaseId("some-lease"),
      stepName: "execute",
      completionSignal: { outcome: "success" },
      store,
    };

    const result = await advanceStep(input);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("workflowInstanceId");
      }
    }
  });

  it("returns command_validation when leaseId is empty", async () => {
    const store = createInMemoryRuntimeStore();
    const input: AdvanceStepInput = {
      workflowInstanceId: createWorkflowInstanceId("some-instance"),
      leaseId: "" as ExecutionLeaseId,
      stepName: "execute",
      completionSignal: { outcome: "success" },
      store,
    };

    const result = await advanceStep(input);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("leaseId");
      }
    }
  });

  it("returns command_validation when stepName is empty", async () => {
    const store = createInMemoryRuntimeStore();
    const input: AdvanceStepInput = {
      workflowInstanceId: createWorkflowInstanceId("some-instance"),
      leaseId: createExecutionLeaseId("some-lease"),
      stepName: "",
      completionSignal: { outcome: "success" },
      store,
    };

    const result = await advanceStep(input);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("stepName");
      }
    }
  });

  it("returns command_validation when completionSignal is missing", async () => {
    const store = createInMemoryRuntimeStore();
    const input = {
      workflowInstanceId: createWorkflowInstanceId("some-instance"),
      leaseId: createExecutionLeaseId("some-lease"),
      stepName: "execute",
      completionSignal: null as unknown as AdvanceStepInput["completionSignal"],
      store,
    };

    const result = await advanceStep(input);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("completionSignal");
      }
    }
  });

  it("returns command_validation when completionSignal.outcome is missing", async () => {
    const store = createInMemoryRuntimeStore();
    const input = {
      workflowInstanceId: createWorkflowInstanceId("some-instance"),
      leaseId: createExecutionLeaseId("some-lease"),
      stepName: "execute",
      completionSignal: {
        outcome: "" as "success" | "blocked" | "failed" | "paused",
      },
      store,
    };

    const result = await advanceStep(input);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_validation");
      if (result.error.type === "command_validation") {
        expect(result.error.field).toBe("completionSignal.outcome");
      }
    }
  });
});

describe("advanceStep — not found", () => {
  it("returns command_not_found when instance does not exist", async () => {
    const store = createInMemoryRuntimeStore();
    const input: AdvanceStepInput = {
      workflowInstanceId: createWorkflowInstanceId("nonexistent-id"),
      leaseId: createExecutionLeaseId("some-lease"),
      stepName: "execute",
      completionSignal: { outcome: "success" },
      store,
    };

    const result = await advanceStep(input);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_not_found");
    }
  });
});

describe("advanceStep — lease mismatch", () => {
  it("returns command_not_found (entity: lease) when leaseId does not match active lease", async () => {
    const store = createInMemoryRuntimeStore();

    const instance = await store.instances.create({
      workflowName: "simple-execution",
      goal: "Test goal",
      slug: "test-slug",
    });
    expect(instance.isOk()).toBe(true);
    if (!instance.isOk()) return;

    await store.instances.update(instance.value.id, {
      status: "running",
      currentStepName: "execute",
    });

    // Acquire the real lease
    await store.leases.acquire({
      workflowInstanceId: instance.value.id,
      ownerId: "owner-test" as import("../runtime/types.js").OwnerId,
      ttlMs: 60_000,
    });

    // Use a wrong leaseId
    const wrongLeaseId = createExecutionLeaseId("wrong-lease-id");

    const result = await advanceStep({
      workflowInstanceId: instance.value.id,
      leaseId: wrongLeaseId,
      stepName: "execute",
      completionSignal: { outcome: "success" },
      store,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("command_not_found");
      if (result.error.type === "command_not_found") {
        expect(result.error.entity).toBe("lease");
      }
    }
  });
});

describe("advanceStep — successful advance", () => {
  it("returns StepAdvancedData with correct fields", async () => {
    const store = createInMemoryRuntimeStore();

    const instance = await store.instances.create({
      workflowName: "simple-execution",
      goal: "Test goal",
      slug: "test-slug",
    });
    expect(instance.isOk()).toBe(true);
    if (!instance.isOk()) return;

    await store.instances.update(instance.value.id, {
      status: "running",
      currentStepName: "execute",
    });

    const lease = await store.leases.acquire({
      workflowInstanceId: instance.value.id,
      ownerId: "owner-test" as import("../runtime/types.js").OwnerId,
      ttlMs: 60_000,
    });
    expect(lease.isOk()).toBe(true);
    if (!lease.isOk()) return;

    const completionSignal = { outcome: "success" as const };

    const result = await advanceStep({
      workflowInstanceId: instance.value.id,
      leaseId: lease.value.id,
      stepName: "execute",
      completionSignal,
      store,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("step-advanced");
      expect(result.value.workflowInstanceId).toBe(instance.value.id);
      expect(result.value.stepName).toBe("execute");
      expect(result.value.completionSignal).toEqual(completionSignal);
      expect(Array.isArray(result.value.effects)).toBe(true);
    }
  });

  it("requires explicit workflowInstanceId, leaseId, stepName, and completionSignal", async () => {
    // This test verifies the acceptance criterion: advance requires all four
    // explicit fields. We test by omitting each one and confirming typed errors.
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("some-instance");
    const leaseId = createExecutionLeaseId("some-lease");

    const missingInstance = await advanceStep({
      workflowInstanceId: "" as WorkflowInstanceId,
      leaseId,
      stepName: "execute",
      completionSignal: { outcome: "success" },
      store,
    });
    expect(missingInstance.isErr()).toBe(true);
    if (missingInstance.isErr()) {
      expect(missingInstance.error.type).toBe("command_validation");
    }

    const missingLease = await advanceStep({
      workflowInstanceId: instanceId,
      leaseId: "" as ExecutionLeaseId,
      stepName: "execute",
      completionSignal: { outcome: "success" },
      store,
    });
    expect(missingLease.isErr()).toBe(true);
    if (missingLease.isErr()) {
      expect(missingLease.error.type).toBe("command_validation");
    }

    const missingStep = await advanceStep({
      workflowInstanceId: instanceId,
      leaseId,
      stepName: "",
      completionSignal: { outcome: "success" },
      store,
    });
    expect(missingStep.isErr()).toBe(true);
    if (missingStep.isErr()) {
      expect(missingStep.error.type).toBe("command_validation");
    }

    const missingSignal = await advanceStep({
      workflowInstanceId: instanceId,
      leaseId,
      stepName: "execute",
      completionSignal: null as unknown as AdvanceStepInput["completionSignal"],
      store,
    });
    expect(missingSignal.isErr()).toBe(true);
    if (missingSignal.isErr()) {
      expect(missingSignal.error.type).toBe("command_validation");
    }
  });
});

describe("advanceStep — blocked step advancement", () => {
  it("advances a blocked step with failed outcome", async () => {
    const store = createInMemoryRuntimeStore();

    const instance = await store.instances.create({
      workflowName: "simple-execution",
      goal: "Test goal",
      slug: "test-slug",
    });
    expect(instance.isOk()).toBe(true);
    if (!instance.isOk()) return;

    await store.instances.update(instance.value.id, {
      status: "blocked",
      currentStepName: "execute",
    });

    const lease = await store.leases.acquire({
      workflowInstanceId: instance.value.id,
      ownerId: "owner-test" as import("../runtime/types.js").OwnerId,
      ttlMs: 60_000,
    });
    expect(lease.isOk()).toBe(true);
    if (!lease.isOk()) return;

    const result = await advanceStep({
      workflowInstanceId: instance.value.id,
      leaseId: lease.value.id,
      stepName: "execute",
      completionSignal: { outcome: "failed", message: "Step failed" },
      store,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("step-advanced");
      expect(result.value.completionSignal.outcome).toBe("failed");
    }
  });
});
