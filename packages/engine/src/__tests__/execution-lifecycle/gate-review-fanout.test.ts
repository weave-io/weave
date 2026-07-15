/**
 * Tests for gate-step review fan-out intent integration.
 *
 * Verifies that when a `gate` step with `review_verdict` completion names an
 * agent that declares `review_models`, the dispatched `RunAgentEffect` carries
 * a populated `reviewFanOutIntent` field that adapters use to route through
 * `ReviewOrchestrator`.
 *
 * Also verifies the absence / opt-out cases:
 * - Gate step without `review_models` → no `reviewFanOutIntent`
 * - Non-gate step with `review_models` → no `reviewFanOutIntent`
 * - Gate step with `agent_signal` completion → no `reviewFanOutIntent`
 * - No `agentConfigs` in context → no `reviewFanOutIntent`
 *
 * ## V1 gate policy (documented here alongside tests)
 *
 * Weave v1 uses an "any-reject wins" policy:
 * - All variants succeed  → gate passes  (`outcome: "success"`)
 * - Any variant rejects   → gate rejects (`outcome: "blocked"`, `approved: false`)
 * - Partial failure (some variants error, ≥1 succeed) → collated review has
 *   warnings; gate passes if at least one variant approved
 *
 * Adapters receive the intent via `RunAgentEffect.reviewFanOutIntent` and are
 * responsible for executing `ReviewOrchestrator.fanOut` / `collate` and
 * translating the collated outcome into a `StepCompletionSignal`.
 */

import { describe, expect, it } from "bun:test";
import {
  createInMemoryRuntimeStore,
  dispatchStep,
  startExecution,
  type WorkflowExecutionContext,
} from "@weaveio/weave-engine";
import { cfg, createRunningInstance } from "./fixtures.js";

// ---------------------------------------------------------------------------
// Workflow fixtures
// ---------------------------------------------------------------------------

const GATE_REVIEW_VERDICT_WORKFLOW = cfg(`
workflow security-review {
  description "Feature with security gate"
  version 1

  step implement {
    name "Implement feature"
    type autonomous
    agent shuttle
    prompt "Implement the feature: {{instance.goal}}"
    completion agent_signal
  }

  step review-gate {
    name "Security review gate"
    type gate
    agent weft
    prompt "Review the changes for: {{instance.goal}}"
    completion review_verdict
    on_reject pause
  }
}
`);

const GATE_AGENT_SIGNAL_WORKFLOW = cfg(`
workflow gate-agent-signal {
  description "Gate using agent_signal"
  version 1

  step approve {
    name "Manual approve"
    type gate
    agent weft
    prompt "Approve: {{instance.goal}}"
    completion agent_signal
  }
}
`);

const AUTONOMOUS_REVIEW_VERDICT_WORKFLOW = cfg(`
workflow autonomous-review-verdict {
  description "Non-gate step with review_verdict"
  version 1

  step analyze {
    name "Analyze"
    type autonomous
    agent weft
    prompt "Analyze: {{instance.goal}}"
    completion review_verdict
  }
}
`);

// ---------------------------------------------------------------------------
// Agent config fixtures
// ---------------------------------------------------------------------------

const WEFT_WITH_REVIEW_MODELS = {
  weft: {
    description: "Weft review agent",
    models: ["claude-sonnet-4-5"],
    review_models: ["openai/gpt-5", "anthropic/claude-opus-4"],
    mode: "subagent" as const,
  },
};

const WEFT_WITHOUT_REVIEW_MODELS = {
  weft: {
    description: "Weft without review models",
    models: ["claude-sonnet-4-5"],
    mode: "subagent" as const,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function dispatchNamedStep(
  workflowName: string,
  stepName: string,
  workflows: Record<string, unknown>,
  agentConfigs?: Record<string, unknown>,
) {
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
  const leaseId = startResult.value.leaseId;

  const context: WorkflowExecutionContext = {
    workflowName,
    goal: "test goal",
    slug: "test-goal",
    workflows: workflows as WorkflowExecutionContext["workflows"],
    ...(agentConfigs !== undefined
      ? {
          agentConfigs:
            agentConfigs as WorkflowExecutionContext["agentConfigs"],
        }
      : {}),
  };

  const result = await dispatchStep(
    { workflowInstanceId: instanceId, leaseId, stepName, context },
    store,
  );

  return result;
}

// ---------------------------------------------------------------------------
// Tests — fan-out intent IS present
// ---------------------------------------------------------------------------

describe("gate review fan-out intent — present", () => {
  it("gate + review_verdict + agent has review_models → reviewFanOutIntent populated", async () => {
    const result = await dispatchNamedStep(
      "security-review",
      "review-gate",
      GATE_REVIEW_VERDICT_WORKFLOW.workflows,
      WEFT_WITH_REVIEW_MODELS,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const dispatchEffect = result.value.effects.find(
      (e) => e.kind === "dispatch-agent",
    );
    expect(dispatchEffect).toBeDefined();
    if (dispatchEffect?.kind !== "dispatch-agent") return;

    const { runAgent } = dispatchEffect;
    expect(runAgent.stepType).toBe("gate");
    expect(runAgent.completionMethod).toBe("review_verdict");
    expect(runAgent.reviewFanOutIntent).toBeDefined();
    expect(runAgent.reviewFanOutIntent?.agentName).toBe("weft");
    expect(runAgent.reviewFanOutIntent?.reviewModels).toEqual([
      "openai/gpt-5",
      "anthropic/claude-opus-4",
    ]);
  });

  it("reviewFanOutIntent.reviewModels matches agent review_models exactly", async () => {
    const singleModelAgent = {
      weft: {
        description: "Weft",
        models: ["claude-sonnet-4-5"],
        review_models: ["openai/gpt-5"],
        mode: "subagent" as const,
      },
    };

    const result = await dispatchNamedStep(
      "security-review",
      "review-gate",
      GATE_REVIEW_VERDICT_WORKFLOW.workflows,
      singleModelAgent,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const dispatch = result.value.effects.find(
      (e) => e.kind === "dispatch-agent",
    );
    if (dispatch?.kind !== "dispatch-agent") return;
    expect(dispatch.runAgent.reviewFanOutIntent?.reviewModels).toEqual([
      "openai/gpt-5",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tests — fan-out intent is NOT present (opt-out / absence cases)
// ---------------------------------------------------------------------------

describe("gate review fan-out intent — absent", () => {
  it("gate + review_verdict + agent WITHOUT review_models → no reviewFanOutIntent", async () => {
    const result = await dispatchNamedStep(
      "security-review",
      "review-gate",
      GATE_REVIEW_VERDICT_WORKFLOW.workflows,
      WEFT_WITHOUT_REVIEW_MODELS,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const dispatch = result.value.effects.find(
      (e) => e.kind === "dispatch-agent",
    );
    if (dispatch?.kind !== "dispatch-agent") return;
    expect(dispatch.runAgent.reviewFanOutIntent).toBeUndefined();
  });

  it("gate + review_verdict + no agentConfigs in context → no reviewFanOutIntent", async () => {
    // Context without agentConfigs — fan-out cannot be detected
    const result = await dispatchNamedStep(
      "security-review",
      "review-gate",
      GATE_REVIEW_VERDICT_WORKFLOW.workflows,
      // No agentConfigs passed
      undefined,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const dispatch = result.value.effects.find(
      (e) => e.kind === "dispatch-agent",
    );
    if (dispatch?.kind !== "dispatch-agent") return;
    expect(dispatch.runAgent.reviewFanOutIntent).toBeUndefined();
  });

  it("gate + agent_signal completion → no reviewFanOutIntent even with review_models", async () => {
    const result = await dispatchNamedStep(
      "gate-agent-signal",
      "approve",
      GATE_AGENT_SIGNAL_WORKFLOW.workflows,
      WEFT_WITH_REVIEW_MODELS,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const dispatch = result.value.effects.find(
      (e) => e.kind === "dispatch-agent",
    );
    if (dispatch?.kind !== "dispatch-agent") return;
    expect(dispatch.runAgent.stepType).toBe("gate");
    expect(dispatch.runAgent.completionMethod).toBe("agent_signal");
    expect(dispatch.runAgent.reviewFanOutIntent).toBeUndefined();
  });

  it("autonomous + review_verdict → no reviewFanOutIntent even with review_models", async () => {
    const result = await dispatchNamedStep(
      "autonomous-review-verdict",
      "analyze",
      AUTONOMOUS_REVIEW_VERDICT_WORKFLOW.workflows,
      WEFT_WITH_REVIEW_MODELS,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const dispatch = result.value.effects.find(
      (e) => e.kind === "dispatch-agent",
    );
    if (dispatch?.kind !== "dispatch-agent") return;
    expect(dispatch.runAgent.stepType).toBe("autonomous");
    expect(dispatch.runAgent.reviewFanOutIntent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests — non-gate steps are unaffected
// ---------------------------------------------------------------------------

describe("gate review fan-out intent — non-gate steps unaffected", () => {
  it("autonomous step in same workflow has no reviewFanOutIntent", async () => {
    const result = await dispatchNamedStep(
      "security-review",
      "implement",
      GATE_REVIEW_VERDICT_WORKFLOW.workflows,
      WEFT_WITH_REVIEW_MODELS,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const dispatch = result.value.effects.find(
      (e) => e.kind === "dispatch-agent",
    );
    if (dispatch?.kind !== "dispatch-agent") return;
    expect(dispatch.runAgent.stepType).toBe("autonomous");
    expect(dispatch.runAgent.reviewFanOutIntent).toBeUndefined();
  });
});
