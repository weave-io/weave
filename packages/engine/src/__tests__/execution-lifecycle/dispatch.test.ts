/**
 * Tests for dispatch.ts lifecycle module.
 *
 * Verifies:
 * - dispatchStep: legacy and configured dispatch paths
 * - Lease validation, step resolution, artifact input validation
 * - Retry pinning behavior
 */

import { describe, expect, it } from "bun:test";
import {
  createInMemoryRuntimeStore,
  type createWorkflowInstanceId,
  dispatchStep,
  startExecution,
  type WorkflowExecutionContext,
} from "@weaveio/weave-engine";
import { cfg } from "./fixtures.js";

const SIMPLE_WORKFLOW = cfg(`
workflow simple-flow {
  description "Simple two-step workflow"
  version 1

  step plan {
    name "Create plan"
    type autonomous
    agent pattern
    prompt "Create a plan for: {{instance.goal}}"
    completion agent_signal
  }

  step implement {
    name "Implement"
    type autonomous
    agent shuttle
    prompt "Implement the plan for: {{instance.goal}}"
    completion agent_signal
  }
}
`);

async function createRunningInstance(workflowName = "simple-flow") {
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

describe("dispatchStep — legacy (no context)", () => {
  it("dispatches with step name as agent name", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "plan",
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.stepName).toBe("plan");
    expect(result.value.effects).toHaveLength(1);
    const effect = result.value.effects[0];
    expect(effect.kind).toBe("dispatch-agent");
    if (effect.kind === "dispatch-agent") {
      expect(effect.runAgent.agentName).toBe("plan");
    }
  });

  it("returns validation error for missing workflowInstanceId", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await dispatchStep(
      {
        workflowInstanceId: "" as ReturnType<typeof createWorkflowInstanceId>,
        leaseId: "lease-001" as ReturnType<
          typeof import("@weaveio/weave-engine").createExecutionLeaseId
        >,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });
});

describe("dispatchStep — configured (with context)", () => {
  it("dispatches with step.agent as agent name", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    const context: WorkflowExecutionContext = {
      workflowName: "simple-flow",
      goal: "test goal",
      slug: "test-goal",
      workflows: { "simple-flow": SIMPLE_WORKFLOW.workflows["simple-flow"]! },
    };

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "plan",
        context,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.stepName).toBe("plan");
    const effect = result.value.effects[0];
    expect(effect.kind).toBe("dispatch-agent");
    if (effect.kind === "dispatch-agent") {
      expect(effect.runAgent.agentName).toBe("pattern");
      expect(effect.runAgent.completionMethod).toBe("agent_signal");
      expect(effect.runAgent.stepType).toBe("autonomous");
      expect(effect.runAgent.promptMetadata?.byteLength).toBeGreaterThan(0);
    }
  });

  it("returns not_found when step does not exist in workflow", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    const context: WorkflowExecutionContext = {
      workflowName: "simple-flow",
      goal: "test goal",
      slug: "test-goal",
      workflows: { "simple-flow": SIMPLE_WORKFLOW.workflows["simple-flow"]! },
    };

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "nonexistent-step",
        context,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("not_found");
    if (result.error.type === "not_found") {
      expect(result.error.entity).toBe("WorkflowStep");
    }
  });

  it("returns lease_conflict when lease does not match", async () => {
    const { store, instanceId } = await createRunningInstance();

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: "wrong-lease-id" as ReturnType<
          typeof import("@weaveio/weave-engine").createExecutionLeaseId
        >,
        stepName: "plan",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("lease_conflict");
  });
});
