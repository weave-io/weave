/**
 * Unit tests for executeReviewVariants.
 *
 * All tests use a mock OpenCodeClientFacade with controllable per-variant
 * behavior. No live SDK calls are made.
 */

import { describe, expect, it } from "bun:test";
import type {
  AgentDescriptor,
  ReviewVariantDescriptor,
} from "@weaveio/weave-engine";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { executeReviewVariants } from "../execute-review-variants.js";
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
      composedPrompt: "You are a reviewer.",
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

function makeSessionError(
  type: "CreateSessionError" | "PromptSessionError" | "DeleteSessionError",
  sessionId = "s1",
): OpenCodeClientError {
  if (type === "CreateSessionError") {
    return { type: "CreateSessionError", message: "session create failed" };
  }
  if (type === "PromptSessionError") {
    return { type: "PromptSessionError", sessionId, message: "prompt failed" };
  }
  return { type: "DeleteSessionError", sessionId, message: "delete failed" };
}

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

type VariantBehavior = {
  sessionId?: string;
  sessionError?: OpenCodeClientError;
  promptOutput?: string;
  promptError?: OpenCodeClientError;
  deleteError?: OpenCodeClientError;
};

/**
 * Builds a mock facade where each variant (keyed by variantName/title) can
 * have individually configured behavior.
 */
function makeMockFacade(
  behaviors: Record<string, VariantBehavior>,
): OpenCodeClientFacade & {
  createSessionCalls: string[];
  promptSessionCalls: Array<{ sessionId: string; agentName: string }>;
  deleteSessionCalls: string[];
} {
  const createSessionCalls: string[] = [];
  const promptSessionCalls: Array<{ sessionId: string; agentName: string }> =
    [];
  const deleteSessionCalls: string[] = [];

  // Map sessionId → variantName for prompt/delete routing
  const sessionToVariant = new Map<string, string>();

  return {
    createSessionCalls,
    promptSessionCalls,
    deleteSessionCalls,

    listAgents() {
      return okAsync([]);
    },

    createAgent() {
      return okAsync(undefined);
    },

    updateAgent() {
      return okAsync(undefined);
    },

    createReviewSession(title: string) {
      createSessionCalls.push(title);
      const behavior = behaviors[title];
      if (behavior?.sessionError) {
        return errAsync(behavior.sessionError);
      }
      const sessionId = behavior?.sessionId ?? `session-${title}`;
      sessionToVariant.set(sessionId, title);
      return okAsync({ sessionId });
    },

    promptSession(sessionId: string, _prompt: string, agentName: string) {
      promptSessionCalls.push({ sessionId, agentName });
      const variantName = sessionToVariant.get(sessionId) ?? agentName;
      const behavior = behaviors[variantName];
      if (behavior?.promptError) {
        return errAsync(behavior.promptError);
      }
      const output = behavior?.promptOutput ?? "Review output";
      return okAsync({
        output,
        assistantMessage: { role: "assistant" as const, parts: [] },
      });
    },

    deleteSession(sessionId: string) {
      deleteSessionCalls.push(sessionId);
      const variantName = sessionToVariant.get(sessionId);
      const behavior = variantName ? behaviors[variantName] : undefined;
      if (behavior?.deleteError) {
        return errAsync(behavior.deleteError);
      }
      return okAsync(undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeReviewVariants", () => {
  it("all variants succeed — returns ok with success entries", async () => {
    const variants = [
      makeDescriptor("weft-review-claude", "claude-sonnet-4-5"),
      makeDescriptor("weft-review-gpt", "gpt-4o"),
    ];

    const client = makeMockFacade({
      "weft-review-claude": { promptOutput: "Claude review output" },
      "weft-review-gpt": { promptOutput: "GPT review output" },
    });

    const result = await executeReviewVariants(
      variants,
      client,
      "Review this code",
    );

    expect(result.isOk()).toBe(true);
    const results = result._unsafeUnwrap();
    expect(results).toHaveLength(2);

    const claude = results.find((r) => r.variantName === "weft-review-claude");
    expect(claude).toMatchObject({
      success: true,
      output: "Claude review output",
    });

    const gpt = results.find((r) => r.variantName === "weft-review-gpt");
    expect(gpt).toMatchObject({ success: true, output: "GPT review output" });
  });

  it("partial failure — returns ok with mixed success/failure entries", async () => {
    const variants = [
      makeDescriptor("weft-review-claude", "claude-sonnet-4-5"),
      makeDescriptor("weft-review-gpt", "gpt-4o"),
    ];

    const client = makeMockFacade({
      "weft-review-claude": { promptOutput: "Claude review output" },
      "weft-review-gpt": {
        promptError: makeSessionError(
          "PromptSessionError",
          "session-weft-review-gpt",
        ),
      },
    });

    const result = await executeReviewVariants(
      variants,
      client,
      "Review this code",
    );

    expect(result.isOk()).toBe(true);
    const results = result._unsafeUnwrap();
    expect(results).toHaveLength(2);

    const claude = results.find((r) => r.variantName === "weft-review-claude");
    expect(claude).toMatchObject({
      success: true,
      output: "Claude review output",
    });

    const gpt = results.find((r) => r.variantName === "weft-review-gpt");
    expect(gpt?.success).toBe(false);
    expect(gpt?.errorMessage).toMatch(/prompt failed/i);
  });

  it("session creation failure — variant gets success: false with session error message", async () => {
    const variants = [
      makeDescriptor("weft-review-claude", "claude-sonnet-4-5"),
    ];

    const client = makeMockFacade({
      "weft-review-claude": {
        sessionError: makeSessionError("CreateSessionError"),
      },
    });

    const result = await executeReviewVariants(
      variants,
      client,
      "Review this code",
    );

    expect(result.isOk()).toBe(true);
    const results = result._unsafeUnwrap();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      variantName: "weft-review-claude",
      success: false,
    });
    expect(results[0]?.errorMessage).toMatch(/session/i);
  });

  it("all variants fail — still returns ok with all success: false entries", async () => {
    const variants = [
      makeDescriptor("weft-review-claude", "claude-sonnet-4-5"),
      makeDescriptor("weft-review-gpt", "gpt-4o"),
    ];

    const client = makeMockFacade({
      "weft-review-claude": {
        sessionError: makeSessionError("CreateSessionError"),
      },
      "weft-review-gpt": {
        promptError: makeSessionError(
          "PromptSessionError",
          "session-weft-review-gpt",
        ),
      },
    });

    const result = await executeReviewVariants(
      variants,
      client,
      "Review this code",
    );

    expect(result.isOk()).toBe(true);
    const results = result._unsafeUnwrap();
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.success === false)).toBe(true);
  });

  it("variants execute in parallel — createReviewSession calls are concurrent (active call count)", async () => {
    let activeCalls = 0;
    let maxConcurrent = 0;

    const client: OpenCodeClientFacade = {
      listAgents: () => okAsync([]),
      createAgent: () => okAsync(undefined),
      updateAgent: () => okAsync(undefined),

      createReviewSession(title: string) {
        return okAsync({ sessionId: `session-${title}` });
      },

      promptSession(_sessionId: string, _prompt: string, _agentName: string) {
        activeCalls++;
        if (activeCalls > maxConcurrent) maxConcurrent = activeCalls;
        // Return a promise that resolves on next microtask tick so the
        // concurrency window is observable.
        return ResultAsync.fromSafePromise(
          Promise.resolve().then(() => {
            activeCalls--;
            return {
              output: "output",
              assistantMessage: { role: "assistant" as const, parts: [] },
            };
          }),
        );
      },

      deleteSession: () => okAsync(undefined),
    };

    const variants = [
      makeDescriptor("variant-a", "model-a"),
      makeDescriptor("variant-b", "model-b"),
    ];

    const result = await executeReviewVariants(variants, client, "Review");

    expect(result.isOk()).toBe(true);
    // Both variants were prompted concurrently: max active calls should be 2.
    expect(maxConcurrent).toBe(2);
  });

  it("cleanup (deleteSession) failure does not affect success: true result", async () => {
    const variants = [
      makeDescriptor("weft-review-claude", "claude-sonnet-4-5"),
    ];

    const client = makeMockFacade({
      "weft-review-claude": {
        promptOutput: "Claude review output",
        deleteError: makeSessionError(
          "DeleteSessionError",
          "session-weft-review-claude",
        ),
      },
    });

    const result = await executeReviewVariants(
      variants,
      client,
      "Review this code",
    );

    expect(result.isOk()).toBe(true);
    const results = result._unsafeUnwrap();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      variantName: "weft-review-claude",
      success: true,
      output: "Claude review output",
    });
  });

  it("empty variants array — returns ok with empty results", async () => {
    const client = makeMockFacade({});

    const result = await executeReviewVariants([], client, "Review this code");

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it("empty reviewPrompt — returns err with ReviewFanOutSpawnError", async () => {
    const variants = [
      makeDescriptor("weft-review-claude", "claude-sonnet-4-5"),
    ];
    const client = makeMockFacade({});

    const result = await executeReviewVariants(variants, client, "   ");

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("ReviewFanOutSpawnError");
    expect(error.message).toMatch(/empty/i);
  });
});
