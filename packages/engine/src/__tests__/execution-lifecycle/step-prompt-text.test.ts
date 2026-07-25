/**
 * Regression tests for the ephemeral `stepPromptText` output field
 * (Weave issue #21 Task 12).
 *
 * Root cause: `dispatchStep`/`completeStep`/`reconcileExecution` all render
 * `step.prompt` via `renderStepPrompt`, but historically discarded the
 * rendered text and returned only `{ byteLength }` inside the
 * `RunAgentEffect.promptMetadata` field of the emitted `dispatch-agent`
 * effect. `PiWorkflowController.runDispatchAgentEffect` sends only the
 * activated agent's own `AgentDescriptor.composedPrompt` to the direct-step
 * child, so the child never saw `step.prompt` at all.
 *
 * Fix: `renderStepPrompt` now returns both `{ text, byteLength }`.
 * `byteLength` still travels only inside `RunAgentEffect.promptMetadata`
 * (persisted/logged-safe, unchanged shape). `text` is surfaced solely via
 * the new EPHEMERAL top-level `stepPromptText` field on
 * `DispatchStepOutput` / `CompleteStepOutput` / `ReconcileExecutionOutput` —
 * never inside a `LifecycleEffect`.
 *
 * These tests prove, for every code path that renders a step prompt and
 * emits a `dispatch-agent` effect:
 * 1. `stepPromptText` carries the real rendered text (not just its length).
 * 2. `RunAgentEffect.promptMetadata` remains redacted — only `byteLength`,
 *    never the raw text — so the security invariant on lifecycle effects
 *    is unchanged.
 */

import { describe, expect, it } from "bun:test";
import {
  completeStep,
  createInMemoryRuntimeStore,
  dispatchStep,
  reconcileExecution,
  startExecution,
  type WorkflowExecutionContext,
} from "@weaveio/weave-engine";
import { cfg } from "./fixtures.js";

// ---------------------------------------------------------------------------
// Shared assertion helper
// ---------------------------------------------------------------------------

/**
 * Asserts the shared security contract on a `dispatch-agent` effect's
 * `RunAgentEffect.promptMetadata`: present, positive `byteLength`, and
 * structurally nothing else (in particular, no raw prompt text field).
 */
function expectRedactedPromptMetadata(runAgent: {
  readonly promptMetadata?: { readonly byteLength: number };
}): void {
  expect(runAgent.promptMetadata).toBeDefined();
  const pm = runAgent.promptMetadata as Record<string, unknown>;
  expect(Object.keys(pm)).toEqual(["byteLength"]);
  expect(pm.byteLength).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// dispatchStep
// ---------------------------------------------------------------------------

describe("dispatchStep — stepPromptText (Task 12)", () => {
  const DISPATCH_WORKFLOW = cfg(`
workflow dispatch-flow {
  version 1

  step plan {
    name "Create plan"
    type autonomous
    agent pattern
    prompt "Create a plan for: {{instance.goal}}"
    completion agent_signal
  }
}
`);

  async function setup() {
    const store = createInMemoryRuntimeStore();
    const createResult = await store.instances.create({
      workflowName: "dispatch-flow",
      goal: "ship the dispatch fix",
      slug: "dispatch-fix",
    });
    if (createResult.isErr()) throw new Error("failed to create instance");
    const instanceId = createResult.value.id;

    const startResult = await startExecution(
      { workflowInstanceId: instanceId, ownerId: "test-owner" },
      store,
    );
    if (startResult.isErr()) throw new Error("failed to start execution");

    const context: WorkflowExecutionContext = {
      workflowName: "dispatch-flow",
      goal: "ship the dispatch fix",
      slug: "dispatch-fix",
      workflows: {
        "dispatch-flow": DISPATCH_WORKFLOW.workflows["dispatch-flow"]!,
      },
    };

    return { store, instanceId, leaseId: startResult.value.leaseId, context };
  }

  it("returns the fully rendered step.prompt text as an ephemeral top-level field", async () => {
    const { store, instanceId, leaseId, context } = await setup();

    const result = await dispatchStep(
      { workflowInstanceId: instanceId, leaseId, stepName: "plan", context },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.stepPromptText).toBe(
      "Create a plan for: ship the dispatch fix",
    );
  });

  it("keeps RunAgentEffect.promptMetadata redacted to byteLength only", async () => {
    const { store, instanceId, leaseId, context } = await setup();

    const result = await dispatchStep(
      { workflowInstanceId: instanceId, leaseId, stepName: "plan", context },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const effect = result.value.effects[0];
    expect(effect?.kind).toBe("dispatch-agent");
    if (effect?.kind !== "dispatch-agent") return;
    expectRedactedPromptMetadata(effect.runAgent);

    // The rendered text must never leak into the effect itself.
    expect(JSON.stringify(effect)).not.toContain("ship the dispatch fix");
  });

  it("omits stepPromptText for legacy (no-context) dispatch — nothing was rendered", async () => {
    const { store, instanceId, leaseId } = await setup();

    const result = await dispatchStep(
      { workflowInstanceId: instanceId, leaseId, stepName: "plan" },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.stepPromptText).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// completeStep — auto-advance
// ---------------------------------------------------------------------------

describe("completeStep — auto-advance stepPromptText (Task 12)", () => {
  const TWO_STEP_WORKFLOW = cfg(`
workflow two-step-flow {
  version 1

  step first {
    name "First step"
    type autonomous
    agent pattern
    prompt "First step for: {{instance.goal}}"
    completion agent_signal
  }

  step second {
    name "Second step"
    type autonomous
    agent shuttle
    prompt "Second step for: {{instance.goal}}"
    completion agent_signal
  }
}
`);

  async function setup() {
    const store = createInMemoryRuntimeStore();
    const createResult = await store.instances.create({
      workflowName: "two-step-flow",
      goal: "advance to step two",
      slug: "advance-to-step-two",
    });
    if (createResult.isErr()) throw new Error("failed to create instance");
    const instanceId = createResult.value.id;

    const context: WorkflowExecutionContext = {
      workflowName: "two-step-flow",
      goal: "advance to step two",
      slug: "advance-to-step-two",
      workflows: {
        "two-step-flow": TWO_STEP_WORKFLOW.workflows["two-step-flow"]!,
      },
    };

    const startResult = await startExecution(
      { workflowInstanceId: instanceId, ownerId: "test-owner", context },
      store,
    );
    if (startResult.isErr()) throw new Error("failed to start execution");

    return { store, instanceId, leaseId: startResult.value.leaseId, context };
  }

  it("carries the next step's rendered prompt text on auto-advance", async () => {
    const { store, instanceId, leaseId, context } = await setup();

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "first",
        completionSignal: { outcome: "success", method: "agent_signal" },
        context,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.stepPromptText).toBe(
      "Second step for: advance to step two",
    );

    const effect = result.value.effects[0];
    expect(effect?.kind).toBe("dispatch-agent");
    if (effect?.kind !== "dispatch-agent") return;
    expect(effect.runAgent.agentName).toBe("shuttle");
    expectRedactedPromptMetadata(effect.runAgent);
    expect(JSON.stringify(effect)).not.toContain("advance to step two");
  });

  it("omits stepPromptText when the final step completes (no next dispatch)", async () => {
    const { store, instanceId, leaseId, context } = await setup();

    await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "first",
        completionSignal: { outcome: "success", method: "agent_signal" },
        context,
      },
      store,
    );

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "second",
        completionSignal: { outcome: "success", method: "agent_signal" },
        context,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.effects[0]?.kind).toBe("complete-execution");
    expect(result.value.stepPromptText).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// completeStep — gate rejection retry
// ---------------------------------------------------------------------------

describe("completeStep — gate on_reject:retry stepPromptText (Task 12)", () => {
  const GATE_WORKFLOW = cfg(`
workflow gate-retry-flow {
  version 1

  step review {
    name "Review"
    type gate
    agent weft
    prompt "Review the change for: {{instance.goal}}"
    completion review_verdict
    on_reject retry
  }
}
`);

  async function setup() {
    const store = createInMemoryRuntimeStore();
    const createResult = await store.instances.create({
      workflowName: "gate-retry-flow",
      goal: "harden the gate",
      slug: "harden-the-gate",
    });
    if (createResult.isErr()) throw new Error("failed to create instance");
    const instanceId = createResult.value.id;

    const context: WorkflowExecutionContext = {
      workflowName: "gate-retry-flow",
      goal: "harden the gate",
      slug: "harden-the-gate",
      workflows: {
        "gate-retry-flow": GATE_WORKFLOW.workflows["gate-retry-flow"]!,
      },
    };

    const startResult = await startExecution(
      { workflowInstanceId: instanceId, ownerId: "test-owner", context },
      store,
    );
    if (startResult.isErr()) throw new Error("failed to start execution");

    return { store, instanceId, leaseId: startResult.value.leaseId, context };
  }

  it("carries the re-dispatched gate step's rendered prompt text on rejection retry", async () => {
    const { store, instanceId, leaseId, context } = await setup();

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "review",
        completionSignal: {
          outcome: "success",
          method: "review_verdict",
          approved: false,
          message: "needs another pass",
        },
        context,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.stepPromptText).toBe(
      "Review the change for: harden the gate",
    );

    const effect = result.value.effects[0];
    expect(effect?.kind).toBe("dispatch-agent");
    if (effect?.kind !== "dispatch-agent") return;
    expectRedactedPromptMetadata(effect.runAgent);
    expect(JSON.stringify(effect)).not.toContain("harden the gate");
  });
});

// ---------------------------------------------------------------------------
// reconcileExecution — handler dispatch
// ---------------------------------------------------------------------------

describe("reconcileExecution — handler dispatch stepPromptText (Task 12)", () => {
  const RECONCILE_WORKFLOW = cfg(`
workflow reconcile-flow {
  version 1

  step plan {
    name "Plan"
    type autonomous
    agent pattern
    prompt "Plan for: {{instance.goal}}"
    completion agent_signal
    reconciliation_handlers [
      { reason "user-revision-request" }
    ]
  }

  step implement {
    name "Implement"
    type autonomous
    agent shuttle
    prompt "Implement for: {{instance.goal}}"
    completion agent_signal
  }
}
`);

  async function setup() {
    const store = createInMemoryRuntimeStore();
    const createResult = await store.instances.create({
      workflowName: "reconcile-flow",
      goal: "route back to plan",
      slug: "route-back-to-plan",
    });
    if (createResult.isErr()) throw new Error("failed to create instance");
    const instanceId = createResult.value.id;

    const context: WorkflowExecutionContext = {
      workflowName: "reconcile-flow",
      goal: "route back to plan",
      slug: "route-back-to-plan",
      workflows: {
        "reconcile-flow": RECONCILE_WORKFLOW.workflows["reconcile-flow"]!,
      },
    };

    const startResult = await startExecution(
      { workflowInstanceId: instanceId, ownerId: "test-owner", context },
      store,
    );
    if (startResult.isErr()) throw new Error("failed to start execution");
    // Advance past `plan` so `implement` is the triggering step and `plan`
    // is the nearest upstream declared handler for the reconciliation
    // reason under test.
    await store.instances.update(instanceId, { currentStepName: "implement" });

    return { store, instanceId, leaseId: startResult.value.leaseId, context };
  }

  it("carries the resolved handler step's rendered prompt text", async () => {
    const { store, instanceId, leaseId, context } = await setup();

    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
        triggeringStepName: "implement",
        context,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.handlerFound).toBe(true);
    expect(result.value.handlerStepName).toBe("plan");
    expect(result.value.stepPromptText).toBe("Plan for: route back to plan");

    const effect = result.value.effects[0];
    expect(effect?.kind).toBe("dispatch-agent");
    if (effect?.kind !== "dispatch-agent") return;
    expectRedactedPromptMetadata(effect.runAgent);
    expect(JSON.stringify(effect)).not.toContain("route back to plan");
  });
});
