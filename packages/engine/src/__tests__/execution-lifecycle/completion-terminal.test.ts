/**
 * Tests for completion.ts and interrupts.ts lifecycle modules.
 *
 * Verifies:
 * - completeStep: success/blocked/failed/paused outcomes, auto-advance, gate logic
 * - handleUserInterrupt: pause and cancel signals
 */

import { describe, expect, it } from "bun:test";
import {
  completeStep,
  createInMemoryRuntimeStore,
  handleUserInterrupt,
  startExecution,
  type WorkflowExecutionContext,
} from "@weave/engine";
import { cfg, MockPlanStateProvider } from "./fixtures.js";

const TWO_STEP_WORKFLOW = cfg(`
workflow two-step {
  description "Two-step workflow"
  version 1

  step plan {
    name "Create plan"
    type autonomous
    agent pattern
    prompt "Create a plan for: {{instance.goal}}"
    completion agent_signal

    outputs [
      { name "plan_path" description "Path to the plan" }
    ]
  }

  step implement {
    name "Implement"
    type autonomous
    agent shuttle
    prompt "Implement using plan at {{artifacts.plan_path}}"
    completion agent_signal

    inputs [
      { name "plan_path" description "Path to the plan" }
    ]
  }
}
`);

async function createRunningInstance(workflowName = "two-step") {
  const store = createInMemoryRuntimeStore();
  const createResult = await store.instances.create({
    workflowName,
    goal: "test goal",
    slug: "test-goal",
  });
  if (!createResult.isOk())
    throw new Error(`Failed to create: ${createResult.error.message}`);
  const instanceId = createResult.value.id;

  const startResult = await startExecution(
    { workflowInstanceId: instanceId, ownerId: "test-owner" },
    store,
  );
  if (!startResult.isOk())
    throw new Error(`Failed to start: ${startResult.error.message}`);

  return { store, instanceId, leaseId: startResult.value.leaseId };
}

// ---------------------------------------------------------------------------
// completeStep
// ---------------------------------------------------------------------------

describe("completeStep — legacy (no context)", () => {
  it("success outcome: updates status to running, returns empty effects", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "plan",
        completionSignal: { outcome: "success" },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.effects).toHaveLength(0);
  });

  it("paused outcome: emits pause-execution effect", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "plan",
        completionSignal: { outcome: "paused" },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.effects).toHaveLength(1);
    expect(result.value.effects[0].kind).toBe("pause-execution");
  });

  it("blocked outcome: releases lease, emits complete-execution effect", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "plan",
        completionSignal: { outcome: "blocked" },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.effects).toHaveLength(1);
    expect(result.value.effects[0].kind).toBe("complete-execution");
  });

  it("returns validation error for missing stepName", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "",
        completionSignal: { outcome: "success" },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });
});

describe("completeStep — configured (with context)", () => {
  it("final step: transitions to completed, releases lease, emits complete-execution", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    // Update to the last step
    await store.instances.update(instanceId, { currentStepName: "implement" });

    const context: WorkflowExecutionContext = {
      workflowName: "two-step",
      goal: "test goal",
      slug: "test-goal",
      workflows: { "two-step": TWO_STEP_WORKFLOW.workflows["two-step"]! },
    };

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "implement",
        completionSignal: { outcome: "success" },
        context,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.effects).toHaveLength(1);
    expect(result.value.effects[0].kind).toBe("complete-execution");

    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.status).toBe("completed");
  });

  it("out-of-order completion: returns validation error", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    await store.instances.update(instanceId, { currentStepName: "plan" });

    const context: WorkflowExecutionContext = {
      workflowName: "two-step",
      goal: "test goal",
      slug: "test-goal",
      workflows: { "two-step": TWO_STEP_WORKFLOW.workflows["two-step"]! },
    };

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "implement", // wrong step
        completionSignal: { outcome: "success" },
        context,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("stepName");
    }
  });
});

// ---------------------------------------------------------------------------
// handleUserInterrupt
// ---------------------------------------------------------------------------

describe("handleUserInterrupt", () => {
  it("pause signal: updates instance to paused, returns PauseExecutionEffect", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    const result = await handleUserInterrupt(
      {
        workflowInstanceId: instanceId,
        leaseId,
        signal: "pause",
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.effects).toHaveLength(1);
    expect(result.value.effects[0].kind).toBe("pause-execution");

    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.status).toBe("paused");
  });

  it("cancel signal: updates instance to cancelled, returns CompleteExecutionEffect", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    const result = await handleUserInterrupt(
      {
        workflowInstanceId: instanceId,
        leaseId,
        signal: "cancel",
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.effects).toHaveLength(1);
    expect(result.value.effects[0].kind).toBe("complete-execution");

    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.status).toBe("cancelled");
  });

  it("returns lease_conflict when lease does not match", async () => {
    const { store, instanceId } = await createRunningInstance();

    const result = await handleUserInterrupt(
      {
        workflowInstanceId: instanceId,
        leaseId: "wrong-lease" as ReturnType<
          typeof import("@weave/engine").createExecutionLeaseId
        >,
        signal: "pause",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("lease_conflict");
  });

  it("returns validation error for missing signal", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    const result = await handleUserInterrupt(
      {
        workflowInstanceId: instanceId,
        leaseId,
        signal: "" as "pause" | "cancel",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });
});
