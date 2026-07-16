import { describe, expect, it } from "bun:test";
import {
  evaluateGateDecision,
  type VariantVerdictInput,
} from "../review-gate-policy.js";
import type { ReviewVerdict } from "../review-verdict-parser.js";

const approve: ReviewVerdict = { verdict: "approve" };
const reject: ReviewVerdict = { verdict: "reject", reasoning: "Not good." };
const block: ReviewVerdict = { verdict: "block", reasoning: "Hard blocked." };
const malformed: ReviewVerdict = { verdict: "malformed", rawOutput: "???" };

function variant(
  variantName: string,
  verdict: ReviewVerdict,
): VariantVerdictInput {
  return { variantName, verdict };
}

describe("evaluateGateDecision", () => {
  it("all approve — passes with no blockers", () => {
    const result = evaluateGateDecision([
      variant("v1", approve),
      variant("v2", approve),
    ]);
    expect(result.passed).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("single reject among approves — fails with one blocker", () => {
    const result = evaluateGateDecision([
      variant("v1", approve),
      variant("v2", reject),
    ]);
    expect(result.passed).toBe(false);
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].variantName).toBe("v2");
    expect(result.blockers[0].verdict).toEqual(reject);
  });

  it("single block among approves — fails with one blocker", () => {
    const result = evaluateGateDecision([
      variant("v1", approve),
      variant("v2", block),
    ]);
    expect(result.passed).toBe(false);
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].variantName).toBe("v2");
    expect(result.blockers[0].verdict).toEqual(block);
  });

  it("malformed verdict among approves — fails with one blocker", () => {
    const result = evaluateGateDecision([
      variant("v1", approve),
      variant("v2", malformed),
    ]);
    expect(result.passed).toBe(false);
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].variantName).toBe("v2");
    expect(result.blockers[0].verdict).toEqual(malformed);
  });

  it("mixed multiple blockers (reject + block) — fails with both", () => {
    const result = evaluateGateDecision([
      variant("v1", reject),
      variant("v2", block),
    ]);
    expect(result.passed).toBe(false);
    expect(result.blockers).toHaveLength(2);
    expect(result.blockers[0].variantName).toBe("v1");
    expect(result.blockers[0].verdict).toEqual(reject);
    expect(result.blockers[1].variantName).toBe("v2");
    expect(result.blockers[1].verdict).toEqual(block);
  });

  it("empty array — fail-closed with no blockers", () => {
    const result = evaluateGateDecision([]);
    expect(result.passed).toBe(false);
    expect(result.blockers).toEqual([]);
  });

  it("single approve — passes with no blockers", () => {
    const result = evaluateGateDecision([variant("v1", approve)]);
    expect(result.passed).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("all reject — fails with all as blockers", () => {
    const result = evaluateGateDecision([
      variant("v1", reject),
      variant("v2", { verdict: "reject", reasoning: "Also bad." }),
    ]);
    expect(result.passed).toBe(false);
    expect(result.blockers).toHaveLength(2);
    expect(result.blockers[0].variantName).toBe("v1");
    expect(result.blockers[1].variantName).toBe("v2");
  });
});
