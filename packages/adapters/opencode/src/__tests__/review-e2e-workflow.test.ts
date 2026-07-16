/**
 * Integration tests for the full review fan-out workflow path via buildProjectEffect.
 *
 * Tests exercise the complete pipeline:
 *   DispatchAgentEffect (with reviewFanOutIntent)
 *     → buildProjectEffect callback
 *     → ReviewOrchestrator.fanOut
 *     → adapter.spawnReviewVariants
 *     → ReviewOrchestrator.collate
 *     → translateReviewOutcome
 *     → ok(void) | err(WorkflowRunnerError)
 *
 * All tests use a mock OpenCodeClientFacade — no live SDK or harness calls.
 */

import { describe, expect, it } from "bun:test";
import type { WeaveConfig } from "@weaveio/weave-core";
import type {
  AgentDescriptor,
  DispatchAgentEffect,
  EffectiveToolPolicy,
  ReviewFanOutIntent,
  RunAgentEffect,
} from "@weaveio/weave-engine";
import { errAsync, okAsync } from "neverthrow";
import { OpenCodeAdapter } from "../adapter.js";
import type {
  OpenCodeClientError,
  OpenCodeClientFacade,
} from "../opencode-client.js";
import { buildProjectEffect } from "../projection-helpers.js";

// ---------------------------------------------------------------------------
// MockReviewClient — controllable OpenCodeClientFacade
// ---------------------------------------------------------------------------

type VariantBehavior = {
  sessionId?: string;
  sessionError?: OpenCodeClientError;
  promptOutput?: string;
  promptError?: OpenCodeClientError;
};

class MockReviewClient implements OpenCodeClientFacade {
  private readonly sessionToVariant = new Map<string, string>();

  constructor(
    private readonly behaviors: Record<string, VariantBehavior> = {},
  ) {}

  listAgents() {
    return okAsync([]);
  }

  createAgent() {
    return okAsync(undefined);
  }

  updateAgent() {
    return okAsync(undefined);
  }

  createReviewSession(title: string) {
    const behavior = this.behaviors[title];
    if (behavior?.sessionError) {
      return errAsync(behavior.sessionError);
    }
    const sessionId = behavior?.sessionId ?? `session-${title}`;
    this.sessionToVariant.set(sessionId, title);
    return okAsync({ sessionId });
  }

  promptSession(sessionId: string, _prompt: string, agentName: string) {
    const variantName = this.sessionToVariant.get(sessionId) ?? agentName;
    const behavior = this.behaviors[variantName];
    if (behavior?.promptError) {
      return errAsync(behavior.promptError);
    }
    const output = behavior?.promptOutput ?? "Default review output";
    return okAsync({
      output,
      assistantMessage: { role: "assistant" as const, parts: [] },
    });
  }

  deleteSession(_sessionId: string) {
    return okAsync(undefined);
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const DEFAULT_EFFECTIVE_TOOL_POLICY: EffectiveToolPolicy = {
  read: "allow",
  write: "deny",
  execute: "deny",
  delegate: "deny",
  network: "deny",
};

const STUB_DESCRIPTOR: AgentDescriptor = {
  name: "weft",
  description: "Review agent",
  composedPrompt: "You are a code reviewer.",
  models: ["anthropic/claude-opus-4-5"],
  mode: "subagent",
  effectiveToolPolicy: DEFAULT_EFFECTIVE_TOOL_POLICY,
  rawToolPolicy: undefined,
  delegationTargets: [],
  skills: [],
};

function makeReviewFanOutIntent(
  agentName: string,
  reviewModels: string[],
): ReviewFanOutIntent {
  return { agentName, reviewModels };
}

function makeRunAgentEffect(
  agentName: string,
  reviewFanOutIntent?: ReviewFanOutIntent,
): RunAgentEffect {
  return {
    kind: "run-agent",
    agentName,
    agentDescriptor: STUB_DESCRIPTOR,
    effectiveToolPolicy: DEFAULT_EFFECTIVE_TOOL_POLICY,
    rawToolPolicy: undefined,
    resolvedSkills: [],
    stepType: "gate",
    completionMethod: "review_verdict",
    reviewFanOutIntent,
  };
}

function makeDispatchAgentEffect(
  runAgent: RunAgentEffect,
): DispatchAgentEffect {
  return {
    kind: "dispatch-agent",
    runAgent,
  };
}

/**
 * Derive the variant name the ReviewOrchestrator uses for a model.
 * Mirrors reviewVariantName() from packages/engine/src/review-variants.ts.
 */
function reviewVariantName(agentName: string, model: string): string {
  const safeModel = model.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `${agentName}-review-${safeModel}`;
}

/**
 * Minimal WeaveConfig with a given agent that has review_models configured.
 * The ReviewOrchestrator.fanOut will use these to derive variant descriptors.
 */
function makeWeaveConfigWithReviewModels(
  agentName: string,
  reviewModels: string[],
): WeaveConfig {
  return {
    agents: {
      [agentName]: {
        name: agentName,
        description: "Code review agent",
        prompt: "You are a thorough code reviewer.",
        models: ["anthropic/claude-opus-4-5"],
        mode: "subagent",
        temperature: 0.1,
        review_models: reviewModels,
        skills: [],
      },
    },
    categories: {},
    workflows: {},
    disabled: { agents: [], hooks: [], skills: [] },
    settings: {
      log_level: "INFO",
      runtime: { journal: { strict: false } },
    },
    extend_before_plan: { steps: [] },
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: All variants succeed → gate passes (ok(void))
// ---------------------------------------------------------------------------

describe("buildProjectEffect — review fan-out integration", () => {
  it("scenario 1: all variants succeed but outputs contain no verdict signal → gate blocks (malformed)", async () => {
    const reviewModels = ["anthropic/claude-opus-4-5", "openai/gpt-4o"];
    const config = makeWeaveConfigWithReviewModels("weft", reviewModels);

    // Outputs that succeed execution-wise but contain no [APPROVE]/[REJECT]/[BLOCK] signal
    const client = new MockReviewClient({
      [reviewVariantName("weft", "anthropic/claude-opus-4-5")]: {
        promptOutput: "LGTM — Claude review",
      },
      [reviewVariantName("weft", "openai/gpt-4o")]: {
        promptOutput: "Looks good — GPT review",
      },
    });

    const adapter = new OpenCodeAdapter({ client });
    await adapter.init();

    const projectEffect = buildProjectEffect(adapter, config);

    const fanOutIntent = makeReviewFanOutIntent("weft", reviewModels);
    const runAgent = makeRunAgentEffect("weft", fanOutIntent);
    const effect = makeDispatchAgentEffect(runAgent);

    const result = await projectEffect(
      effect,
      "Please review these code changes.",
    );

    // Verdict-level: no signal → malformed → gate blocks
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("projection_error");
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Partial failure → gate still passes with warnings
  // -------------------------------------------------------------------------

  it("scenario 2: partial execution failure (one variant fails) → gate blocks (failed variant treated as malformed)", async () => {
    const reviewModels = ["anthropic/claude-opus-4-5", "openai/gpt-4o"];
    const config = makeWeaveConfigWithReviewModels("weft", reviewModels);

    // We need to know the variant names derived by ReviewOrchestrator.fanOut.
    // reviewVariantName("weft", model) gives e.g. "weft-review-anthropic-claude-opus-4-5".
    const client = new MockReviewClient({
      [reviewVariantName("weft", "anthropic/claude-opus-4-5")]: {
        promptOutput: "[APPROVE] LGTM — Claude review",
      },
      [reviewVariantName("weft", "openai/gpt-4o")]: {
        promptError: {
          type: "PromptSessionError",
          sessionId: `session-${reviewVariantName("weft", "openai/gpt-4o")}`,
          message: "model timeout",
        },
      },
    });

    const adapter = new OpenCodeAdapter({ client });
    await adapter.init();

    const projectEffect = buildProjectEffect(adapter, config);

    const fanOutIntent = makeReviewFanOutIntent("weft", reviewModels);
    const runAgent = makeRunAgentEffect("weft", fanOutIntent);
    const effect = makeDispatchAgentEffect(runAgent);

    const result = await projectEffect(effect, "Review these changes.");

    // Partial failure → failed variant counts as malformed → gate blocks
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("projection_error");
  });

  // -------------------------------------------------------------------------
  // Scenario 3: All variants fail → gate blocks (err(WorkflowRunnerError))
  // -------------------------------------------------------------------------

  it("scenario 3: all variants fail → returns err(WorkflowRunnerError) (gate blocks)", async () => {
    const reviewModels = ["anthropic/claude-opus-4-5", "openai/gpt-4o"];
    const config = makeWeaveConfigWithReviewModels("weft", reviewModels);

    const client = new MockReviewClient({
      [reviewVariantName("weft", "anthropic/claude-opus-4-5")]: {
        promptError: {
          type: "PromptSessionError",
          sessionId: `session-${reviewVariantName("weft", "anthropic/claude-opus-4-5")}`,
          message: "upstream failure",
        },
      },
      [reviewVariantName("weft", "openai/gpt-4o")]: {
        sessionError: {
          type: "CreateSessionError",
          message: "session service unavailable",
        },
      },
    });

    const adapter = new OpenCodeAdapter({ client });
    await adapter.init();

    const projectEffect = buildProjectEffect(adapter, config);

    const fanOutIntent = makeReviewFanOutIntent("weft", reviewModels);
    const runAgent = makeRunAgentEffect("weft", fanOutIntent);
    const effect = makeDispatchAgentEffect(runAgent);

    const result = await projectEffect(effect, "Review these changes.");

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("projection_error");
  });

  // -------------------------------------------------------------------------
  // Scenario 4: No client (translation-only mode) → gate blocks
  // -------------------------------------------------------------------------

  it("scenario 4: adapter without client (translation-only mode) → returns err(WorkflowRunnerError)", async () => {
    const reviewModels = ["anthropic/claude-opus-4-5"];
    const config = makeWeaveConfigWithReviewModels("weft", reviewModels);

    // No client injected → translation-only mode
    const adapter = new OpenCodeAdapter();
    await adapter.init();

    const projectEffect = buildProjectEffect(adapter, config);

    const fanOutIntent = makeReviewFanOutIntent("weft", reviewModels);
    const runAgent = makeRunAgentEffect("weft", fanOutIntent);
    const effect = makeDispatchAgentEffect(runAgent);

    const result = await projectEffect(effect, "Review these changes.");

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("projection_error");
  });

  // -------------------------------------------------------------------------
  // Scenario 6: All variants approve → gate passes (verdict-level)
  // -------------------------------------------------------------------------

  it("scenario 6: all variants output [APPROVE] → gate passes (ok(void))", async () => {
    const reviewModels = ["anthropic/claude-opus-4-5", "openai/gpt-4o"];
    const config = makeWeaveConfigWithReviewModels("weft", reviewModels);

    const client = new MockReviewClient({
      [reviewVariantName("weft", "anthropic/claude-opus-4-5")]: {
        promptOutput: "Code looks clean. [APPROVE]",
      },
      [reviewVariantName("weft", "openai/gpt-4o")]: {
        promptOutput: "[APPROVE] LGTM — no issues found.",
      },
    });

    const adapter = new OpenCodeAdapter({ client });
    await adapter.init();

    const projectEffect = buildProjectEffect(adapter, config);
    const fanOutIntent = makeReviewFanOutIntent("weft", reviewModels);
    const runAgent = makeRunAgentEffect("weft", fanOutIntent);
    const effect = makeDispatchAgentEffect(runAgent);

    const result = await projectEffect(
      effect,
      "Please review these code changes.",
    );

    expect(result.isOk()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Scenario 7: One variant outputs [REJECT] → gate blocks (verdict-level)
  // -------------------------------------------------------------------------

  it("scenario 7: one variant outputs [REJECT] → gate blocks even though execution succeeded", async () => {
    const reviewModels = ["anthropic/claude-opus-4-5", "openai/gpt-4o"];
    const config = makeWeaveConfigWithReviewModels("weft", reviewModels);

    const client = new MockReviewClient({
      [reviewVariantName("weft", "anthropic/claude-opus-4-5")]: {
        promptOutput: "[APPROVE] Looks good to me.",
      },
      [reviewVariantName("weft", "openai/gpt-4o")]: {
        promptOutput: "Missing error handling. [REJECT]",
      },
    });

    const adapter = new OpenCodeAdapter({ client });
    await adapter.init();

    const projectEffect = buildProjectEffect(adapter, config);
    const fanOutIntent = makeReviewFanOutIntent("weft", reviewModels);
    const runAgent = makeRunAgentEffect("weft", fanOutIntent);
    const effect = makeDispatchAgentEffect(runAgent);

    const result = await projectEffect(
      effect,
      "Please review these code changes.",
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("projection_error");
  });

  // -------------------------------------------------------------------------
  // Scenario 8: One variant outputs no verdict signal (malformed) → gate blocks
  // -------------------------------------------------------------------------

  it("scenario 8: one variant outputs no verdict signal (malformed) → gate blocks", async () => {
    const reviewModels = ["anthropic/claude-opus-4-5", "openai/gpt-4o"];
    const config = makeWeaveConfigWithReviewModels("weft", reviewModels);

    const client = new MockReviewClient({
      [reviewVariantName("weft", "anthropic/claude-opus-4-5")]: {
        promptOutput: "[APPROVE] All checks pass.",
      },
      // No verdict signal in output — malformed
      [reviewVariantName("weft", "openai/gpt-4o")]: {
        promptOutput: "I reviewed the code and found some things to note.",
      },
    });

    const adapter = new OpenCodeAdapter({ client });
    await adapter.init();

    const projectEffect = buildProjectEffect(adapter, config);
    const fanOutIntent = makeReviewFanOutIntent("weft", reviewModels);
    const runAgent = makeRunAgentEffect("weft", fanOutIntent);
    const effect = makeDispatchAgentEffect(runAgent);

    const result = await projectEffect(
      effect,
      "Please review these code changes.",
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("projection_error");
  });

  // -------------------------------------------------------------------------
  // Scenario 9: One variant outputs [BLOCK] → gate blocks
  // -------------------------------------------------------------------------

  it("scenario 9: one variant outputs [BLOCK] → gate blocks", async () => {
    const reviewModels = ["anthropic/claude-opus-4-5", "openai/gpt-4o"];
    const config = makeWeaveConfigWithReviewModels("weft", reviewModels);

    const client = new MockReviewClient({
      [reviewVariantName("weft", "anthropic/claude-opus-4-5")]: {
        promptOutput: "[APPROVE] Nothing to flag.",
      },
      [reviewVariantName("weft", "openai/gpt-4o")]: {
        promptOutput: "Critical security vulnerability detected. [BLOCK]",
      },
    });

    const adapter = new OpenCodeAdapter({ client });
    await adapter.init();

    const projectEffect = buildProjectEffect(adapter, config);
    const fanOutIntent = makeReviewFanOutIntent("weft", reviewModels);
    const runAgent = makeRunAgentEffect("weft", fanOutIntent);
    const effect = makeDispatchAgentEffect(runAgent);

    const result = await projectEffect(
      effect,
      "Please review these code changes.",
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("projection_error");
  });

  // -------------------------------------------------------------------------
  // Scenario 10: One [APPROVE] + one execution failure → gate blocks
  //   (failed variant becomes synthetic malformed)
  // -------------------------------------------------------------------------

  it("scenario 10: one [APPROVE] + one execution failure → gate blocks (failed variant treated as malformed)", async () => {
    const reviewModels = ["anthropic/claude-opus-4-5", "openai/gpt-4o"];
    const config = makeWeaveConfigWithReviewModels("weft", reviewModels);

    const client = new MockReviewClient({
      [reviewVariantName("weft", "anthropic/claude-opus-4-5")]: {
        promptOutput: "[APPROVE] Looks good.",
      },
      [reviewVariantName("weft", "openai/gpt-4o")]: {
        promptError: {
          type: "PromptSessionError",
          sessionId: `session-${reviewVariantName("weft", "openai/gpt-4o")}`,
          message: "execution timed out",
        },
      },
    });

    const adapter = new OpenCodeAdapter({ client });
    await adapter.init();

    const projectEffect = buildProjectEffect(adapter, config);
    const fanOutIntent = makeReviewFanOutIntent("weft", reviewModels);
    const runAgent = makeRunAgentEffect("weft", fanOutIntent);
    const effect = makeDispatchAgentEffect(runAgent);

    const result = await projectEffect(
      effect,
      "Please review these code changes.",
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("projection_error");
  });

  // -------------------------------------------------------------------------
  // Scenario 5: Non-review gate step → normal spawnSubagent path
  // -------------------------------------------------------------------------

  it("scenario 5: effect without reviewFanOutIntent → calls spawnSubagent (normal path)", async () => {
    // Use a mock client so spawnSubagent can reconcile without error
    const client = new MockReviewClient();
    const adapter = new OpenCodeAdapter({ client });
    await adapter.init();

    // No config needed for the normal path (no fan-out intent)
    const projectEffect = buildProjectEffect(adapter, undefined);

    // No reviewFanOutIntent → normal dispatch
    const runAgent = makeRunAgentEffect("weft", undefined);
    const effect = makeDispatchAgentEffect(runAgent);

    const result = await projectEffect(effect, "Execute implementation task.");

    // spawnSubagent with mock client: reconcileAgent tries listAgents → ok([]);
    // then tries createAgent → ok(undefined). Should succeed.
    expect(result.isOk()).toBe(true);

    // Verify the agent was registered via spawnSubagent (not review variant path)
    expect(adapter.translatedAgents.has("weft")).toBe(true);
  });
});
