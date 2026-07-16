import { describe, expect, it } from "bun:test";
import { parseVerdict } from "../review-verdict-parser.js";

describe("parseVerdict", () => {
  it("[APPROVE] in output → approve", () => {
    expect(parseVerdict("[APPROVE]")).toEqual({ verdict: "approve" });
  });

  it("[REJECT] in output → reject with full output as reasoning", () => {
    const output = "This code has issues. [REJECT]";
    expect(parseVerdict(output)).toEqual({
      verdict: "reject",
      reasoning: output,
    });
  });

  it("[BLOCK] in output → block with full output as reasoning", () => {
    const output = "Security vulnerability found. [BLOCK]";
    expect(parseVerdict(output)).toEqual({
      verdict: "block",
      reasoning: output,
    });
  });

  it("no signal → malformed with full output as rawOutput", () => {
    const output = "Looks good to me, but no explicit signal here.";
    expect(parseVerdict(output)).toEqual({
      verdict: "malformed",
      rawOutput: output,
    });
  });

  describe("case variations", () => {
    it("[approve] (lowercase) → approve", () => {
      expect(parseVerdict("[approve]")).toEqual({ verdict: "approve" });
    });

    it("[Approve] (mixed case) → approve", () => {
      expect(parseVerdict("[Approve]")).toEqual({ verdict: "approve" });
    });

    it("[APPROVE] (uppercase) → approve", () => {
      expect(parseVerdict("[APPROVE]")).toEqual({ verdict: "approve" });
    });

    it("[Reject] (mixed case) → reject", () => {
      const output = "[Reject] not good enough";
      expect(parseVerdict(output)).toEqual({
        verdict: "reject",
        reasoning: output,
      });
    });

    it("[block] (lowercase) → block", () => {
      const output = "[block] critical issue";
      expect(parseVerdict(output)).toEqual({
        verdict: "block",
        reasoning: output,
      });
    });
  });

  it("multiple signals: [REJECT] and [APPROVE] → malformed (ambiguous output)", () => {
    const output =
      "Something is wrong [REJECT] and here is why [APPROVE] doesn't matter";
    expect(parseVerdict(output)).toEqual({
      verdict: "malformed",
      rawOutput: output,
    });
  });

  it("signal buried in prose → reject with reasoning", () => {
    const output = "I found issues...\n\n[REJECT]\n\nMissing tests...";
    expect(parseVerdict(output)).toEqual({
      verdict: "reject",
      reasoning: output,
    });
  });

  it("empty string → malformed", () => {
    expect(parseVerdict("")).toEqual({ verdict: "malformed", rawOutput: "" });
  });

  it("whitespace-only → malformed", () => {
    expect(parseVerdict("   \n\t  ")).toEqual({
      verdict: "malformed",
      rawOutput: "   \n\t  ",
    });
  });

  describe("near-miss false positives", () => {
    it("[APPROVED] → malformed", () => {
      const output = "[APPROVED] this looks great";
      expect(parseVerdict(output)).toEqual({
        verdict: "malformed",
        rawOutput: output,
      });
    });

    it("[REJECTION] → malformed", () => {
      const output = "[REJECTION] too many issues";
      expect(parseVerdict(output)).toEqual({
        verdict: "malformed",
        rawOutput: output,
      });
    });

    it("[BLOCKING] → malformed", () => {
      const output = "[BLOCKING] critical failure";
      expect(parseVerdict(output)).toEqual({
        verdict: "malformed",
        rawOutput: output,
      });
    });

    it("APPROVE without brackets → malformed", () => {
      const output = "APPROVE this change";
      expect(parseVerdict(output)).toEqual({
        verdict: "malformed",
        rawOutput: output,
      });
    });
  });

  it("signal at very start of output → works correctly", () => {
    const output = "[APPROVE] everything looks great";
    expect(parseVerdict(output)).toEqual({ verdict: "approve" });
  });

  it("signal at very end of output → works correctly", () => {
    const output = "After careful review I conclude [REJECT]";
    expect(parseVerdict(output)).toEqual({
      verdict: "reject",
      reasoning: output,
    });
  });
});
