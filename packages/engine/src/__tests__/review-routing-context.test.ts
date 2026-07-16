/**
 * review-routing-context.test.ts
 *
 * Tests for `buildReviewRoutingContext` in compose.ts.
 *
 * Covers:
 * - Returns undefined when no review variants provided (empty array)
 * - Returns undefined when review variants exist but none match delegation targets
 * - Returns grouped variants when matching delegation targets
 * - Filters out agents not in delegation targets
 * - Multiple groups (weft + warp) each with their own variants
 */

import { describe, expect, it } from "bun:test";

import type { AgentDescriptor } from "../compose.js";
import { buildReviewRoutingContext } from "../compose.js";
import type { MaterializedAgent } from "../materialization.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubDescriptor(name: string): AgentDescriptor {
  return {
    name,
    composedPrompt: "",
    models: [],
    mode: "subagent",
    effectiveToolPolicy: {
      read: "ask",
      write: "ask",
      execute: "ask",
      delegate: "ask",
      network: "ask",
    },
    rawToolPolicy: undefined,
    delegationTargets: [],
    skills: [],
  };
}

function makeReviewVariant(
  agentName: string,
  sourceAgentName: string,
  reviewModel: string,
): MaterializedAgent {
  return {
    agentName,
    source: "review-variant",
    reviewMeta: { sourceAgentName, reviewModel },
    descriptor: makeStubDescriptor(agentName),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildReviewRoutingContext", () => {
  it("returns undefined when review variants array is empty", () => {
    const result = buildReviewRoutingContext([], ["weft"]);
    expect(result).toBeUndefined();
  });

  it("returns undefined when no review variants match delegation targets", () => {
    const variants = [
      makeReviewVariant("weft-openai-gpt-5", "weft", "openai/gpt-5"),
      makeReviewVariant("weft-anthropic-claude", "weft", "anthropic/claude"),
    ];
    // delegation targets do NOT include "weft"
    const result = buildReviewRoutingContext(variants, ["warp", "shuttle"]);
    expect(result).toBeUndefined();
  });

  it("returns grouped variants when delegation target matches", () => {
    const variants = [
      makeReviewVariant("weft-openai-gpt-5", "weft", "openai/gpt-5"),
    ];
    const result = buildReviewRoutingContext(variants, ["weft"]);

    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toEqual({
      sourceAgent: "weft",
      variants: [{ name: "weft-openai-gpt-5", model: "openai/gpt-5" }],
    });
  });

  it("groups multiple variants under the same source agent", () => {
    const variants = [
      makeReviewVariant("weft-openai-gpt-5", "weft", "openai/gpt-5"),
      makeReviewVariant("weft-anthropic-claude", "weft", "anthropic/claude"),
    ];
    const result = buildReviewRoutingContext(variants, ["weft"]);

    expect(result).toBeDefined();
    if (result === undefined) return;
    const group = result.groups[0];
    expect(result.groups).toHaveLength(1);
    expect(group?.sourceAgent).toBe("weft");
    expect(group?.variants).toHaveLength(2);
    expect(group?.variants).toEqual([
      { name: "weft-openai-gpt-5", model: "openai/gpt-5" },
      { name: "weft-anthropic-claude", model: "anthropic/claude" },
    ]);
  });

  it("excludes agents whose source agent is not in delegation targets", () => {
    const variants = [
      makeReviewVariant("weft-openai-gpt-5", "weft", "openai/gpt-5"),
      makeReviewVariant("other-openai-gpt-5", "other", "openai/gpt-5"),
    ];
    // only "weft" is a delegation target
    const result = buildReviewRoutingContext(variants, ["weft"]);

    expect(result).toBeDefined();
    if (result === undefined) return;
    const group = result.groups[0];
    expect(result.groups).toHaveLength(1);
    expect(group?.sourceAgent).toBe("weft");
    expect(group?.variants).toHaveLength(1);
    expect(group?.variants[0]?.name).toBe("weft-openai-gpt-5");
  });

  it("ignores agents that are not review-variant source", () => {
    const variants: MaterializedAgent[] = [
      makeReviewVariant("weft-openai-gpt-5", "weft", "openai/gpt-5"),
      {
        agentName: "weft",
        source: "explicit",
        descriptor: makeStubDescriptor("weft"),
      },
    ];
    const result = buildReviewRoutingContext(variants, ["weft"]);

    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.variants).toHaveLength(1);
  });

  it("produces multiple groups for multiple matching source agents (weft + warp)", () => {
    const variants = [
      makeReviewVariant("weft-openai-gpt-5", "weft", "openai/gpt-5"),
      makeReviewVariant("weft-anthropic-claude", "weft", "anthropic/claude"),
      makeReviewVariant("warp-openai-gpt-5", "warp", "openai/gpt-5"),
    ];
    const result = buildReviewRoutingContext(variants, ["weft", "warp"]);

    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(result.groups).toHaveLength(2);

    const weftGroup = result.groups.find((g) => g.sourceAgent === "weft");
    const warpGroup = result.groups.find((g) => g.sourceAgent === "warp");

    expect(weftGroup).toBeDefined();
    expect(weftGroup?.variants).toHaveLength(2);

    expect(warpGroup).toBeDefined();
    expect(warpGroup?.variants).toHaveLength(1);
    expect(warpGroup?.variants[0]?.name).toBe("warp-openai-gpt-5");
  });

  it("returns undefined when delegation targets list is empty", () => {
    const variants = [
      makeReviewVariant("weft-openai-gpt-5", "weft", "openai/gpt-5"),
    ];
    const result = buildReviewRoutingContext(variants, []);
    expect(result).toBeUndefined();
  });
});
