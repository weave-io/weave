/**
 * Integration tests for OpenCodeAdapter.spawnReviewVariants.
 *
 * Tests the full adapter flow: variant descriptors in, execution results out,
 * and results verified against ReviewOrchestrator.collate().
 *
 * All tests use a mock OpenCodeClientFacade — no live SDK or harness calls.
 */

import { describe, expect, it } from "bun:test";
import type {
  AgentDescriptor,
  ReviewVariantDescriptor,
} from "@weaveio/weave-engine";
import { ReviewOrchestrator } from "@weaveio/weave-engine";
import { errAsync, okAsync } from "neverthrow";
import { OpenCodeAdapter } from "../adapter.js";
import type {
  OpenCodeClientError,
  OpenCodeClientFacade,
} from "../opencode-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDescriptor(
  variantName: string,
  reviewModel: string,
): ReviewVariantDescriptor {
  return {
    variantName,
    reviewModel,
    descriptor: {
      name: variantName,
      composedPrompt: "You are a code reviewer.",
      models: [reviewModel],
      mode: "subagent",
      effectiveToolPolicy: {
        read: "allow",
        write: "deny",
        execute: "deny",
        delegate: "deny",
        network: "deny",
      },
      rawToolPolicy: undefined,
      delegationTargets: [],
      skills: [],
    } satisfies AgentDescriptor,
  };
}

// ---------------------------------------------------------------------------
// MockReviewClient
// ---------------------------------------------------------------------------

type VariantBehavior = {
  sessionId?: string;
  sessionError?: OpenCodeClientError;
  promptOutput?: string;
  promptError?: OpenCodeClientError;
};

/**
 * Controllable mock implementing OpenCodeClientFacade.
 *
 * Behavior is configured per variant name (used as session title).
 * Session IDs are auto-generated as `session-{variantName}` unless overridden.
 */
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
// Tests
// ---------------------------------------------------------------------------

describe("OpenCodeAdapter.spawnReviewVariants", () => {
  it("with mock client — all variants succeed returns ok with success entries", async () => {
    const client = new MockReviewClient({
      "weft-review-claude": { promptOutput: "LGTM — Claude review" },
      "weft-review-gpt": { promptOutput: "Looks good — GPT review" },
    });

    const adapter = new OpenCodeAdapter({ client });
    await adapter.init();

    const variants = [
      makeDescriptor("weft-review-claude", "anthropic/claude-sonnet-4-5"),
      makeDescriptor("weft-review-gpt", "openai/gpt-4o"),
    ];

    const result = await adapter.spawnReviewVariants(
      variants,
      "Review the following code changes...",
    );

    expect(result.isOk()).toBe(true);
    const results = result._unsafeUnwrap();
    expect(results).toHaveLength(2);

    const claudeResult = results.find(
      (r) => r.variantName === "weft-review-claude",
    );
    expect(claudeResult).toMatchObject({
      variantName: "weft-review-claude",
      reviewModel: "anthropic/claude-sonnet-4-5",
      success: true,
      output: "LGTM — Claude review",
    });

    const gptResult = results.find((r) => r.variantName === "weft-review-gpt");
    expect(gptResult).toMatchObject({
      variantName: "weft-review-gpt",
      reviewModel: "openai/gpt-4o",
      success: true,
      output: "Looks good — GPT review",
    });

    // Both sessions were created and cleaned up
    expect(client.createSessionCalls).toContain("weft-review-claude");
    expect(client.createSessionCalls).toContain("weft-review-gpt");
    expect(client.deleteSessionCalls).toHaveLength(2);
  });

  it("without client (translation-only) — returns err with ReviewFanOutSpawnError", async () => {
    const adapter = new OpenCodeAdapter(); // no client
    await adapter.init();

    const variants = [
      makeDescriptor("weft-review-claude", "anthropic/claude-sonnet-4-5"),
    ];

    const result = await adapter.spawnReviewVariants(
      variants,
      "Review the following code changes...",
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("ReviewFanOutSpawnError");
  });

  it("results from all-success are compatible with ReviewOrchestrator.collate()", async () => {
    const client = new MockReviewClient({
      "weft-review-claude": { promptOutput: "LGTM — Claude review" },
      "weft-review-gpt": { promptOutput: "Looks good — GPT review" },
    });

    const adapter = new OpenCodeAdapter({ client });
    await adapter.init();

    const variants = [
      makeDescriptor("weft-review-claude", "anthropic/claude-sonnet-4-5"),
      makeDescriptor("weft-review-gpt", "openai/gpt-4o"),
    ];

    const spawnResult = await adapter.spawnReviewVariants(
      variants,
      "Review the following code changes...",
    );
    expect(spawnResult.isOk()).toBe(true);
    const results = spawnResult._unsafeUnwrap();

    // Pass results to ReviewOrchestrator.collate()
    const collateResult = ReviewOrchestrator.collate(results);

    expect(collateResult.isOk()).toBe(true);
    const collated = collateResult._unsafeUnwrap();
    expect(collated.success).toBe(true);
    expect(collated.warnings).toHaveLength(0);
    expect(collated.collatedOutput).toContain("LGTM — Claude review");
    expect(collated.collatedOutput).toContain("Looks good — GPT review");
  });

  it("partial failure — returns ok with mixed results; collate produces warnings", async () => {
    const client = new MockReviewClient({
      "weft-review-claude": { promptOutput: "LGTM — Claude review" },
      "weft-review-gpt": {
        promptError: {
          type: "PromptSessionError",
          sessionId: "session-weft-review-gpt",
          message: "model timeout",
        },
      },
    });

    const adapter = new OpenCodeAdapter({ client });
    await adapter.init();

    const variants = [
      makeDescriptor("weft-review-claude", "anthropic/claude-sonnet-4-5"),
      makeDescriptor("weft-review-gpt", "openai/gpt-4o"),
    ];

    const spawnResult = await adapter.spawnReviewVariants(
      variants,
      "Review the following code changes...",
    );

    // Partial failure → still ok(results)
    expect(spawnResult.isOk()).toBe(true);
    const results = spawnResult._unsafeUnwrap();
    expect(results).toHaveLength(2);

    const claudeResult = results.find(
      (r) => r.variantName === "weft-review-claude",
    );
    expect(claudeResult?.success).toBe(true);

    const gptResult = results.find((r) => r.variantName === "weft-review-gpt");
    expect(gptResult?.success).toBe(false);
    expect(gptResult?.errorMessage).toMatch(/review prompt failed/i);

    // collate() still produces ok() with one warning
    const collateResult = ReviewOrchestrator.collate(results);
    expect(collateResult.isOk()).toBe(true);
    const collated = collateResult._unsafeUnwrap();
    expect(collated.success).toBe(true);
    expect(collated.warnings).toHaveLength(1);
    expect(collated.warnings[0]?.variantName).toBe("weft-review-gpt");
    expect(collated.collatedOutput).toContain("LGTM — Claude review");
  });

  it("all variants fail — returns ok with all success:false; collate returns CollatedReviewAllFailedError", async () => {
    const client = new MockReviewClient({
      "weft-review-claude": {
        sessionError: {
          type: "CreateSessionError",
          message: "session service unavailable",
        },
      },
      "weft-review-gpt": {
        promptError: {
          type: "PromptSessionError",
          sessionId: "session-weft-review-gpt",
          message: "execution timeout",
        },
      },
    });

    const adapter = new OpenCodeAdapter({ client });
    await adapter.init();

    const variants = [
      makeDescriptor("weft-review-claude", "anthropic/claude-sonnet-4-5"),
      makeDescriptor("weft-review-gpt", "openai/gpt-4o"),
    ];

    const spawnResult = await adapter.spawnReviewVariants(
      variants,
      "Review the following code changes...",
    );

    // All failed → still ok(results), not err
    expect(spawnResult.isOk()).toBe(true);
    const results = spawnResult._unsafeUnwrap();
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.success === false)).toBe(true);

    // collate() returns err when all variants failed
    const collateResult = ReviewOrchestrator.collate(results);
    expect(collateResult.isErr()).toBe(true);
    const error = collateResult._unsafeUnwrapErr();
    expect(error.type).toBe("CollatedReviewAllFailedError");
  });
});
