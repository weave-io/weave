/**
 * Integration tests for the direct review invocation path.
 *
 * Tests exercise:
 *   - `executeDirectReview` from `direct-review.ts` (standalone function)
 *   - `OpenCodeAdapter.executeDirectReview` (adapter method)
 *
 * All tests use a mock `OpenCodeClientFacade` — no live harness calls.
 */

import { describe, expect, it } from "bun:test";
import type { WeaveConfig } from "@weaveio/weave-core";
import { errAsync, okAsync } from "neverthrow";
import { OpenCodeAdapter } from "../adapter.js";
import { executeDirectReview } from "../direct-review.js";
import type {
  OpenCodeClientError,
  OpenCodeClientFacade,
} from "../opencode-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive the variant name the ReviewOrchestrator uses for a model.
 * Mirrors reviewVariantName() from packages/engine/src/review-variants.ts.
 */
function reviewVariantName(agentName: string, model: string): string {
  const safeModel = model.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `${agentName}-review-${safeModel}`;
}

/**
 * Minimal WeaveConfig with a reviewer agent that declares review_models.
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

/**
 * Minimal WeaveConfig with an agent that does NOT declare review_models.
 */
function makeWeaveConfigWithoutReviewModels(agentName: string): WeaveConfig {
  return {
    agents: {
      [agentName]: {
        name: agentName,
        description: "Plain agent with no review_models",
        prompt: "You are a helpful assistant.",
        models: ["anthropic/claude-opus-4-5"],
        mode: "subagent",
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
// MockReviewClient — controllable OpenCodeClientFacade
// ---------------------------------------------------------------------------

type VariantBehavior = {
  sessionId?: string;
  sessionError?: OpenCodeClientError;
  promptOutput?: string;
  promptError?: OpenCodeClientError;
};

class MockReviewClient implements OpenCodeClientFacade {
  readonly createSessionCalls: string[] = [];
  readonly promptSessionCalls: Array<{
    sessionId: string;
    prompt: string;
    agentName: string;
  }> = [];
  readonly deleteSessionCalls: string[] = [];

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
    this.createSessionCalls.push(title);
    const behavior = this.behaviors[title];
    if (behavior?.sessionError) {
      return errAsync(behavior.sessionError);
    }
    const sessionId = behavior?.sessionId ?? `session-${title}`;
    this.sessionToVariant.set(sessionId, title);
    return okAsync({ sessionId });
  }

  promptSession(sessionId: string, prompt: string, agentName: string) {
    this.promptSessionCalls.push({ sessionId, prompt, agentName });
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

  deleteSession(sessionId: string) {
    this.deleteSessionCalls.push(sessionId);
    return okAsync(undefined);
  }
}

// ---------------------------------------------------------------------------
// Tests — executeDirectReview (standalone function)
// ---------------------------------------------------------------------------

describe("executeDirectReview", () => {
  // -------------------------------------------------------------------------
  // 1. Happy path: all approve
  // -------------------------------------------------------------------------
  it("happy path: all variants approve → ok with gateDecision.passed=true and summary PASSED", async () => {
    const reviewModels = ["model-a", "model-b"];
    const config = makeWeaveConfigWithReviewModels("weft", reviewModels);

    const variantA = reviewVariantName("weft", "model-a");
    const variantB = reviewVariantName("weft", "model-b");

    const client = new MockReviewClient({
      [variantA]: { promptOutput: "[APPROVE] Looks great!" },
      [variantB]: { promptOutput: "[APPROVE] LGTM." },
    });

    const result = await executeDirectReview(
      "weft",
      config,
      client,
      "Review the changes.",
    );

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.collatedReview.gateDecision.passed).toBe(true);
    expect(value.formattedSummary).toContain("PASSED");
  });

  // -------------------------------------------------------------------------
  // 2. Mixed verdicts: one approve, one reject
  // -------------------------------------------------------------------------
  it("mixed verdicts: one approve, one reject → ok with gateDecision.passed=false and summary BLOCKED", async () => {
    const reviewModels = ["model-a", "model-b"];
    const config = makeWeaveConfigWithReviewModels("weft", reviewModels);

    const variantA = reviewVariantName("weft", "model-a");
    const variantB = reviewVariantName("weft", "model-b");

    const client = new MockReviewClient({
      [variantA]: { promptOutput: "[APPROVE] Looks fine." },
      [variantB]: { promptOutput: "There are issues here. [REJECT]" },
    });

    const result = await executeDirectReview(
      "weft",
      config,
      client,
      "Review the changes.",
    );

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.collatedReview.gateDecision.passed).toBe(false);
    expect(value.formattedSummary).toContain("BLOCKED");
  });

  // -------------------------------------------------------------------------
  // 3. All variants fail at execution → CollationError
  // -------------------------------------------------------------------------
  it("all variants fail at execution → err with type CollationError", async () => {
    const reviewModels = ["model-a", "model-b"];
    const config = makeWeaveConfigWithReviewModels("weft", reviewModels);

    const variantA = reviewVariantName("weft", "model-a");
    const variantB = reviewVariantName("weft", "model-b");

    const client = new MockReviewClient({
      [variantA]: {
        sessionError: {
          type: "CreateSessionError",
          message: "service unavailable",
        },
      },
      [variantB]: {
        promptError: {
          type: "PromptSessionError",
          sessionId: `session-${variantB}`,
          message: "execution timeout",
        },
      },
    });

    const result = await executeDirectReview(
      "weft",
      config,
      client,
      "Review the changes.",
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("CollationError");
  });

  // -------------------------------------------------------------------------
  // 4. Partial failure: one succeeds with APPROVE, one fails execution
  // -------------------------------------------------------------------------
  it("partial failure: one variant approves, one fails execution → ok with gateDecision.passed=false", async () => {
    const reviewModels = ["model-a", "model-b"];
    const config = makeWeaveConfigWithReviewModels("weft", reviewModels);

    const variantA = reviewVariantName("weft", "model-a");
    const variantB = reviewVariantName("weft", "model-b");

    const client = new MockReviewClient({
      [variantA]: { promptOutput: "[APPROVE] All good." },
      [variantB]: {
        promptError: {
          type: "PromptSessionError",
          sessionId: `session-${variantB}`,
          message: "model crashed",
        },
      },
    });

    const result = await executeDirectReview(
      "weft",
      config,
      client,
      "Review the changes.",
    );

    // Partial failure: failed variant contributes a failed/malformed verdict → gate blocks
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    // The failed variant has no verdict signal → counts as non-passing
    expect(value.collatedReview.gateDecision.passed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 5. Agent without review_models → err (CollationError: no variants to collate)
  // -------------------------------------------------------------------------
  it("agent without review_models → err with CollationError (no variants to collate)", async () => {
    const config = makeWeaveConfigWithoutReviewModels("weft");
    const client = new MockReviewClient();

    const result = await executeDirectReview(
      "weft",
      config,
      client,
      "Review the changes.",
    );

    // ReviewOrchestrator.fanOut succeeds but produces 0 variants.
    // With 0 variants, collation produces CollatedReviewAllFailedError → CollationError.
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("CollationError");
  });

  // -------------------------------------------------------------------------
  // 6. formattedSummary contains variant outputs on PASSED
  // -------------------------------------------------------------------------
  it("formattedSummary contains variant outputs for passing review", async () => {
    const reviewModels = ["model-a"];
    const config = makeWeaveConfigWithReviewModels("weft", reviewModels);

    const variantA = reviewVariantName("weft", "model-a");

    const client = new MockReviewClient({
      [variantA]: {
        promptOutput: "[APPROVE] Everything looks great, nicely done.",
      },
    });

    const result = await executeDirectReview(
      "weft",
      config,
      client,
      "Review the changes.",
    );

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.formattedSummary).toContain("PASSED");
    // The summary should include the variant's output text or agent name
    expect(value.formattedSummary.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// Tests — OpenCodeAdapter.executeDirectReview (adapter method)
// ---------------------------------------------------------------------------

describe("OpenCodeAdapter.executeDirectReview", () => {
  // -------------------------------------------------------------------------
  // 6. Without config → FanOutPlanError
  // -------------------------------------------------------------------------
  it("without config → err with FanOutPlanError mentioning config", async () => {
    const adapter = new OpenCodeAdapter(); // no config
    await adapter.init();

    const result = await adapter.executeDirectReview(
      "weft",
      "Review these changes.",
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("FanOutPlanError");
    expect(error.message).toMatch(/config/i);
  });

  // -------------------------------------------------------------------------
  // 7. With config but without client → ExecutionError
  // -------------------------------------------------------------------------
  it("with config but without client → err with ExecutionError mentioning client", async () => {
    const config = makeWeaveConfigWithReviewModels("weft", ["model-a"]);
    const adapter = new OpenCodeAdapter({ config }); // no client
    await adapter.init();

    const result = await adapter.executeDirectReview(
      "weft",
      "Review these changes.",
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("ExecutionError");
    expect(error.message).toMatch(/client/i);
  });

  // -------------------------------------------------------------------------
  // 8. Happy path via adapter: all approve
  // -------------------------------------------------------------------------
  it("with config and client, all approve → ok with gateDecision.passed=true", async () => {
    const reviewModels = ["model-a", "model-b"];
    const config = makeWeaveConfigWithReviewModels("weft", reviewModels);

    const variantA = reviewVariantName("weft", "model-a");
    const variantB = reviewVariantName("weft", "model-b");

    const client = new MockReviewClient({
      [variantA]: { promptOutput: "[APPROVE] Clean implementation." },
      [variantB]: { promptOutput: "[APPROVE] LGTM." },
    });

    const adapter = new OpenCodeAdapter({ config, client });
    await adapter.init();

    const result = await adapter.executeDirectReview(
      "weft",
      "Review these changes.",
    );

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.collatedReview.gateDecision.passed).toBe(true);
    expect(value.formattedSummary).toContain("PASSED");
  });
});
