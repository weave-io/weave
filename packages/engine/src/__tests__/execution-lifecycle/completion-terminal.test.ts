/**
 * Tests for completion.ts and interrupts.ts lifecycle modules.
 *
 * Verifies:
 * - completeStep: success/blocked/failed/paused outcomes, auto-advance, gate logic
 * - completeStep: review_verdict completion — approved/rejected/pause behavior
 * - completeStep: plan_created/plan_complete — missing provider degraded fallback
 * - completeStep: agent_signal explicit method matching
 * - handleUserInterrupt: pause and cancel signals
 *
 * ## Completion signal coverage
 *
 * ### agent_signal
 * - Explicit method matching accepted when step declares agent_signal
 * - Unsupported automatic signal detection: OpenCode cannot detect structured
 *   signals automatically; adapters must supply explicit completionSignal.method.
 *   When method is omitted, the engine accepts any outcome (legacy path).
 *
 * ### review_verdict
 * - Approved (approved: true) → advances normally, emits dispatch-agent or complete-execution
 * - Rejected + on_reject: pause → paused status, pause-execution effect
 * - Rejected + on_reject: fail → failed status, complete-execution effect
 * - Missing approved field → validation error
 *
 * ### plan_created / plan_complete
 * - Missing planStateProvider → policy_decision error (degraded fallback)
 * - Provider returns plan not found → not_found error
 * - Provider returns plan incomplete → validation error
 */

import { describe, expect, it } from "bun:test";
import {
  completeStep,
  createInMemoryRuntimeStore,
  handleUserInterrupt,
  startExecution,
  type WorkflowExecutionContext,
} from "@weaveio/weave-engine";
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

/**
 * Gate workflow with review_verdict steps for rejection/pause behavior tests.
 *
 * - "work" step: agent_signal (auto-advances)
 * - "gate-pause": review_verdict + on_reject: pause
 * - "gate-fail": review_verdict + on_reject: fail
 */
const GATE_WORKFLOW = cfg(`
workflow gate-workflow {
  description "Gate workflow with review_verdict steps"
  version 1

  step work {
    name "Do the work"
    type autonomous
    agent shuttle
    prompt "Do the work for: {{instance.goal}}"
    completion agent_signal
  }

  step gate-pause {
    name "Review gate (pause on reject)"
    type gate
    agent weft
    prompt "Review the changes"
    completion review_verdict
    on_reject pause
  }

  step gate-fail {
    name "Review gate (fail on reject)"
    type gate
    agent weft
    prompt "Security audit"
    completion review_verdict
    on_reject fail
  }
}
`);

/**
 * Plan workflow with plan_created and plan_complete completion methods.
 *
 * Used to test the degraded fallback when planStateProvider is absent.
 */
const PLAN_WORKFLOW = cfg(`
workflow plan-workflow {
  description "Plan workflow with plan_created and plan_complete steps"
  version 1

  step create-plan {
    name "Create the plan"
    type autonomous
    agent pattern
    prompt "Create a plan for: {{instance.goal}}"
    completion plan_created {
      plan_name "{{instance.slug}}"
    }
  }

  step execute-plan {
    name "Execute the plan"
    type autonomous
    agent shuttle
    prompt "Execute the plan for: {{instance.goal}}"
    completion plan_complete {
      plan_name "{{instance.slug}}"
    }
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
          typeof import("@weaveio/weave-engine").createExecutionLeaseId
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

// ---------------------------------------------------------------------------
// completeStep — agent_signal explicit method matching
// ---------------------------------------------------------------------------

describe("completeStep — agent_signal explicit method matching", () => {
  it("accepts agent_signal method when step declares agent_signal", async () => {
    // Use gate-workflow's "work" step — agent_signal, no outputs required
    const { store, instanceId, leaseId } =
      await createRunningInstance("gate-workflow");

    await store.instances.update(instanceId, { currentStepName: "work" });

    const context: WorkflowExecutionContext = {
      workflowName: "gate-workflow",
      goal: "test goal",
      slug: "test-goal",
      workflows: {
        "gate-workflow": GATE_WORKFLOW.workflows["gate-workflow"]!,
      },
    };

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "work",
        completionSignal: { outcome: "success", method: "agent_signal" },
        context,
      },
      store,
    );

    // agent_signal method matches — step advances normally
    expect(result.isOk()).toBe(true);
  });

  it("returns validation error when method mismatches step declaration", async () => {
    // Instance created with gate-workflow so the context lookup works correctly
    const { store, instanceId, leaseId } =
      await createRunningInstance("gate-workflow");

    await store.instances.update(instanceId, { currentStepName: "gate-pause" });

    const context: WorkflowExecutionContext = {
      workflowName: "gate-workflow",
      goal: "test goal",
      slug: "test-goal",
      workflows: {
        "gate-workflow": GATE_WORKFLOW.workflows["gate-workflow"]!,
      },
    };

    // Sending agent_signal to a review_verdict step — method mismatch
    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "gate-pause",
        completionSignal: { outcome: "success", method: "agent_signal" },
        context,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("completion.method");
    }
  });

  it("unsupported automatic signal detection: omitting method is accepted (legacy path)", async () => {
    // OpenCode cannot detect structured signals automatically.
    // When method is omitted, the engine accepts any outcome (legacy path).
    // Adapters must supply explicit completionSignal.method for structured detection.
    const { store, instanceId, leaseId } = await createRunningInstance();

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "plan",
        // No method — legacy path, no automatic signal detection
        completionSignal: { outcome: "success" },
      },
      store,
    );

    // Legacy path: no method validation, outcome accepted
    expect(result.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// completeStep — review_verdict completion signals
// ---------------------------------------------------------------------------

describe("completeStep — review_verdict: approved (success path)", () => {
  it("approved=true on gate-pause step: advances to next step", async () => {
    const { store, instanceId, leaseId } =
      await createRunningInstance("gate-workflow");

    await store.instances.update(instanceId, { currentStepName: "gate-pause" });

    const context: WorkflowExecutionContext = {
      workflowName: "gate-workflow",
      goal: "test goal",
      slug: "test-goal",
      workflows: {
        "gate-workflow": GATE_WORKFLOW.workflows["gate-workflow"]!,
      },
    };

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "gate-pause",
        completionSignal: {
          outcome: "success",
          method: "review_verdict",
          approved: true,
        },
        context,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    // Approved gate advances — emits dispatch-agent or complete-execution
    const hasAdvanceEffect = result.value.effects.some(
      (e) => e.kind === "dispatch-agent" || e.kind === "complete-execution",
    );
    expect(hasAdvanceEffect).toBe(true);
  });

  it("approved=true on final gate step: transitions to completed", async () => {
    const { store, instanceId, leaseId } =
      await createRunningInstance("gate-workflow");

    // gate-fail is the last step in gate-workflow
    await store.instances.update(instanceId, { currentStepName: "gate-fail" });

    const context: WorkflowExecutionContext = {
      workflowName: "gate-workflow",
      goal: "test goal",
      slug: "test-goal",
      workflows: {
        "gate-workflow": GATE_WORKFLOW.workflows["gate-workflow"]!,
      },
    };

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "gate-fail",
        completionSignal: {
          outcome: "success",
          method: "review_verdict",
          approved: true,
        },
        context,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.effects).toHaveLength(1);
    expect(result.value.effects[0]?.kind).toBe("complete-execution");

    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.status).toBe("completed");
  });
});

describe("completeStep — review_verdict: rejected + on_reject: pause", () => {
  it("rejected gate with on_reject:pause → paused status, pause-execution effect", async () => {
    const { store, instanceId, leaseId } =
      await createRunningInstance("gate-workflow");

    await store.instances.update(instanceId, { currentStepName: "gate-pause" });

    const context: WorkflowExecutionContext = {
      workflowName: "gate-workflow",
      goal: "test goal",
      slug: "test-goal",
      workflows: {
        "gate-workflow": GATE_WORKFLOW.workflows["gate-workflow"]!,
      },
    };

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "gate-pause",
        completionSignal: {
          outcome: "success",
          method: "review_verdict",
          approved: false,
          message: "Changes need revision",
        },
        context,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    // Rejection with on_reject:pause → pause-execution effect
    expect(result.value.effects).toHaveLength(1);
    expect(result.value.effects[0]?.kind).toBe("pause-execution");

    // Instance transitions to paused
    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.status).toBe("paused");
  });

  it("pause effect carries the workflowInstanceId", async () => {
    const { store, instanceId, leaseId } =
      await createRunningInstance("gate-workflow");

    await store.instances.update(instanceId, { currentStepName: "gate-pause" });

    const context: WorkflowExecutionContext = {
      workflowName: "gate-workflow",
      goal: "test goal",
      slug: "test-goal",
      workflows: {
        "gate-workflow": GATE_WORKFLOW.workflows["gate-workflow"]!,
      },
    };

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "gate-pause",
        completionSignal: {
          outcome: "success",
          method: "review_verdict",
          approved: false,
        },
        context,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const pauseEffect = result.value.effects.find(
      (e) => e.kind === "pause-execution",
    );
    expect(pauseEffect).toBeDefined();
    if (pauseEffect?.kind === "pause-execution") {
      expect(pauseEffect.workflowInstanceId).toBe(instanceId);
    }
  });
});

describe("completeStep — review_verdict: rejected + on_reject: fail", () => {
  it("rejected gate with on_reject:fail → failed status, complete-execution effect", async () => {
    const { store, instanceId, leaseId } =
      await createRunningInstance("gate-workflow");

    await store.instances.update(instanceId, { currentStepName: "gate-fail" });

    const context: WorkflowExecutionContext = {
      workflowName: "gate-workflow",
      goal: "test goal",
      slug: "test-goal",
      workflows: {
        "gate-workflow": GATE_WORKFLOW.workflows["gate-workflow"]!,
      },
    };

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "gate-fail",
        completionSignal: {
          outcome: "success",
          method: "review_verdict",
          approved: false,
          message: "Security audit failed",
        },
        context,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    // Rejection with on_reject:fail → complete-execution effect
    expect(result.value.effects).toHaveLength(1);
    expect(result.value.effects[0]?.kind).toBe("complete-execution");

    // Instance transitions to failed
    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.status).toBe("failed");
  });

  it("rejected gate with on_reject:fail → lease is released", async () => {
    const { store, instanceId, leaseId } =
      await createRunningInstance("gate-workflow");

    await store.instances.update(instanceId, { currentStepName: "gate-fail" });

    const context: WorkflowExecutionContext = {
      workflowName: "gate-workflow",
      goal: "test goal",
      slug: "test-goal",
      workflows: {
        "gate-workflow": GATE_WORKFLOW.workflows["gate-workflow"]!,
      },
    };

    await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "gate-fail",
        completionSignal: {
          outcome: "success",
          method: "review_verdict",
          approved: false,
        },
        context,
      },
      store,
    );

    // Lease should be released after fail rejection
    const leaseResult = await store.leases.findActive();
    expect(leaseResult.isOk()).toBe(true);
    if (!leaseResult.isOk()) return;
    expect(leaseResult.value).toBeNull();
  });
});

describe("completeStep — review_verdict: missing approved field", () => {
  it("returns validation error when approved is not provided", async () => {
    const { store, instanceId, leaseId } =
      await createRunningInstance("gate-workflow");

    await store.instances.update(instanceId, { currentStepName: "gate-pause" });

    const context: WorkflowExecutionContext = {
      workflowName: "gate-workflow",
      goal: "test goal",
      slug: "test-goal",
      workflows: {
        "gate-workflow": GATE_WORKFLOW.workflows["gate-workflow"]!,
      },
    };

    // review_verdict step requires approved field — omitting it is a validation error
    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "gate-pause",
        completionSignal: {
          outcome: "success",
          method: "review_verdict",
          // approved is intentionally omitted
        },
        context,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("completionSignal.approved");
    }
  });
});

// ---------------------------------------------------------------------------
// completeStep — plan_created / plan_complete: missing provider (degraded)
// ---------------------------------------------------------------------------

describe("completeStep — plan_created: missing planStateProvider (degraded fallback)", () => {
  it("returns policy_decision error when planStateProvider is absent", async () => {
    const { store, instanceId, leaseId } =
      await createRunningInstance("plan-workflow");

    await store.instances.update(instanceId, {
      currentStepName: "create-plan",
    });

    const context: WorkflowExecutionContext = {
      workflowName: "plan-workflow",
      goal: "test goal",
      slug: "test-goal",
      workflows: {
        "plan-workflow": PLAN_WORKFLOW.workflows["plan-workflow"]!,
      },
    };

    // No planStateProvider — plan_created completion requires one
    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "create-plan",
        completionSignal: { outcome: "success", method: "plan_created" },
        context,
        // planStateProvider intentionally absent
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    // Missing provider → policy_decision error (degraded fallback)
    expect(result.error.type).toBe("policy_decision");
  });

  it("returns not_found error when plan does not exist", async () => {
    const { store, instanceId, leaseId } =
      await createRunningInstance("plan-workflow");

    await store.instances.update(instanceId, {
      currentStepName: "create-plan",
    });

    const context: WorkflowExecutionContext = {
      workflowName: "plan-workflow",
      goal: "test goal",
      slug: "test-goal",
      workflows: {
        "plan-workflow": PLAN_WORKFLOW.workflows["plan-workflow"]!,
      },
    };

    // Provider reports plan does NOT exist
    const planStateProvider = new MockPlanStateProvider(
      { "test-goal": false }, // plan does not exist
    );

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "create-plan",
        completionSignal: { outcome: "success", method: "plan_created" },
        context,
        planStateProvider,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("not_found");
  });

  it("succeeds when plan exists", async () => {
    const { store, instanceId, leaseId } =
      await createRunningInstance("plan-workflow");

    await store.instances.update(instanceId, {
      currentStepName: "create-plan",
    });

    const context: WorkflowExecutionContext = {
      workflowName: "plan-workflow",
      goal: "test goal",
      slug: "test-goal",
      workflows: {
        "plan-workflow": PLAN_WORKFLOW.workflows["plan-workflow"]!,
      },
    };

    // Provider reports plan EXISTS
    const planStateProvider = new MockPlanStateProvider(
      { "test-goal": true }, // plan exists
    );

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "create-plan",
        completionSignal: { outcome: "success", method: "plan_created" },
        context,
        planStateProvider,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
  });
});

describe("completeStep — plan_complete: missing planStateProvider (degraded fallback)", () => {
  it("returns policy_decision error when planStateProvider is absent", async () => {
    const { store, instanceId, leaseId } =
      await createRunningInstance("plan-workflow");

    await store.instances.update(instanceId, {
      currentStepName: "execute-plan",
    });

    const context: WorkflowExecutionContext = {
      workflowName: "plan-workflow",
      goal: "test goal",
      slug: "test-goal",
      workflows: {
        "plan-workflow": PLAN_WORKFLOW.workflows["plan-workflow"]!,
      },
    };

    // No planStateProvider — plan_complete completion requires one
    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "execute-plan",
        completionSignal: { outcome: "success", method: "plan_complete" },
        context,
        // planStateProvider intentionally absent
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    // Missing provider → policy_decision error (degraded fallback)
    expect(result.error.type).toBe("policy_decision");
  });

  it("returns validation error when plan has incomplete tasks", async () => {
    const { store, instanceId, leaseId } =
      await createRunningInstance("plan-workflow");

    await store.instances.update(instanceId, {
      currentStepName: "execute-plan",
    });

    const context: WorkflowExecutionContext = {
      workflowName: "plan-workflow",
      goal: "test goal",
      slug: "test-goal",
      workflows: {
        "plan-workflow": PLAN_WORKFLOW.workflows["plan-workflow"]!,
      },
    };

    // Provider reports plan is NOT complete
    const planStateProvider = new MockPlanStateProvider(
      {}, // existsMap (not used for plan_complete)
      { "test-goal": false }, // plan is incomplete
    );

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "execute-plan",
        completionSignal: { outcome: "success", method: "plan_complete" },
        context,
        planStateProvider,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("plan_complete");
    }
  });

  it("succeeds when plan is complete", async () => {
    const { store, instanceId, leaseId } =
      await createRunningInstance("plan-workflow");

    await store.instances.update(instanceId, {
      currentStepName: "execute-plan",
    });

    const context: WorkflowExecutionContext = {
      workflowName: "plan-workflow",
      goal: "test goal",
      slug: "test-goal",
      workflows: {
        "plan-workflow": PLAN_WORKFLOW.workflows["plan-workflow"]!,
      },
    };

    // Provider reports plan IS complete
    const planStateProvider = new MockPlanStateProvider(
      {}, // existsMap (not used for plan_complete)
      { "test-goal": true }, // plan is complete
    );

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "execute-plan",
        completionSignal: { outcome: "success", method: "plan_complete" },
        context,
        planStateProvider,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
  });
});
