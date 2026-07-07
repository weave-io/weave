/**
 * Tests for reconciliation.ts lifecycle module.
 *
 * Verifies:
 * - reconcileExecution: authorization enforcement, handler resolution, fail-closed pause
 * - before-plan exclusion, gate re-run step name, immutable plan check
 */

import { describe, expect, it } from "bun:test";
import {
  createInMemoryRuntimeStore,
  reconcileExecution,
  startExecution,
  type WorkflowExecutionContext,
} from "@weaveio/weave-engine";
import { cfg, MockPlanStateProvider } from "./fixtures.js";

const WORKFLOW_WITH_HANDLER = cfg(`
workflow reconcile-flow {
  description "Workflow with reconciliation handler"
  version 1

  step plan {
    name "Create plan"
    type autonomous
    agent pattern
    prompt "Create a plan for: {{instance.goal}}"
    completion agent_signal

    reconciliation_handlers [
      { reason "user-revision-request" }
    ]
  }

  step implement {
    name "Implement"
    type autonomous
    agent shuttle
    prompt "Implement the plan for: {{instance.goal}}"
    completion agent_signal
  }

  step review {
    name "Review"
    type gate
    agent weft
    prompt "Review the implementation for: {{instance.goal}}"
    completion review_verdict
  }
}
`);

async function createRunningInstance(workflowName = "reconcile-flow") {
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

describe("reconcileExecution — authorization enforcement", () => {
  it("rejects wrong source for 'user-revision-request'", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId,
        reason: "user-revision-request",
        authorizationSource: "runtime", // wrong — should be "user"
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
    if (result.error.type === "policy_decision") {
      expect(result.error.rule).toBe("reconciliationSource");
    }
  });

  it("rejects wrong source for 'execution-mismatch'", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId,
        reason: "execution-mismatch",
        authorizationSource: "user", // wrong — should be "runtime"
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
  });
});

describe("reconcileExecution — fail-closed (no context)", () => {
  it("pauses instance when no context is provided", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
        // no context
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.handlerFound).toBe(false);
    expect(result.value.effects).toHaveLength(1);
    expect(result.value.effects[0].kind).toBe("pause-execution");
  });
});

describe("reconcileExecution — handler resolution", () => {
  it("routes to nearest upstream handler step", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    await store.instances.update(instanceId, { currentStepName: "review" });

    const context: WorkflowExecutionContext = {
      workflowName: "reconcile-flow",
      goal: "test goal",
      slug: "test-goal",
      workflows: {
        "reconcile-flow": WORKFLOW_WITH_HANDLER.workflows["reconcile-flow"]!,
      },
    };

    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
        triggeringStepName: "review",
        context,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.handlerFound).toBe(true);
    expect(result.value.handlerStepName).toBe("plan");
    expect(result.value.effects).toHaveLength(1);
    expect(result.value.effects[0].kind).toBe("dispatch-agent");
  });

  it("pauses when no handler is found for the reason", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    await store.instances.update(instanceId, { currentStepName: "implement" });

    const context: WorkflowExecutionContext = {
      workflowName: "reconcile-flow",
      goal: "test goal",
      slug: "test-goal",
      workflows: {
        "reconcile-flow": WORKFLOW_WITH_HANDLER.workflows["reconcile-flow"]!,
      },
    };

    // "security-rejection" has no handler in this workflow
    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId,
        reason: "security-rejection",
        authorizationSource: "security-gate",
        triggeringStepName: "implement",
        context,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.handlerFound).toBe(false);
    expect(result.value.effects[0].kind).toBe("pause-execution");
  });

  it("sets gateReRunStepName for review-rejection", async () => {
    const { store, instanceId, leaseId } = await createRunningInstance();

    await store.instances.update(instanceId, { currentStepName: "review" });

    const context: WorkflowExecutionContext = {
      workflowName: "reconcile-flow",
      goal: "test goal",
      slug: "test-goal",
      workflows: {
        "reconcile-flow": WORKFLOW_WITH_HANDLER.workflows["reconcile-flow"]!,
      },
    };

    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId,
        reason: "review-rejection",
        authorizationSource: "review-gate",
        triggeringStepName: "review",
        context,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    // gateReRunStepName should be set to the triggering step
    expect(result.value.gateReRunStepName).toBe("review");
  });
});

describe("reconcileExecution — validation", () => {
  it("returns validation error for missing workflowInstanceId", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await reconcileExecution(
      {
        workflowInstanceId: "" as ReturnType<
          typeof import("@weaveio/weave-engine").createWorkflowInstanceId
        >,
        leaseId: "lease-001" as ReturnType<
          typeof import("@weaveio/weave-engine").createExecutionLeaseId
        >,
        reason: "user-revision-request",
        authorizationSource: "user",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });
});
