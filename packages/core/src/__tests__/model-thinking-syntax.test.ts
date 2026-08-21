import { describe, expect, it } from "bun:test";
import { parseModelIntentEntry, THINKING_LEVEL_VALUES } from "../index.js";

describe("parseModelIntentEntry", () => {
  it("parses every valid thinking-level suffix", () => {
    for (const thinkingLevel of THINKING_LEVEL_VALUES) {
      expect(
        parseModelIntentEntry(
          `provider/model#${thinkingLevel}`,
        )._unsafeUnwrap(),
      ).toEqual({
        baseModel: "provider/model",
        thinkingLevel,
      });
    }
  });

  it("preserves a model without a suffix and leaves the level undefined", () => {
    expect(parseModelIntentEntry("provider/model")._unsafeUnwrap()).toEqual({
      baseModel: "provider/model",
    });
  });

  it("unescapes a literal hash without treating it as a delimiter", () => {
    expect(
      parseModelIntentEntry("provider\\#name/model")._unsafeUnwrap(),
    ).toEqual({
      baseModel: "provider#name/model",
    });
  });

  it("uses the last unescaped hash as the delimiter", () => {
    expect(
      parseModelIntentEntry("provider\\#name/model#minimal")._unsafeUnwrap(),
    ).toEqual({
      baseModel: "provider#name/model",
      thinkingLevel: "minimal",
    });
    expect(
      parseModelIntentEntry("provider#legacy\\#name#high")._unsafeUnwrap(),
    ).toEqual({
      baseModel: "provider#legacy#name",
      thinkingLevel: "high",
    });
  });

  it("preserves backslashes before an unescaped hash in the base model", () => {
    expect(
      parseModelIntentEntry("provider\\\\#name#high")._unsafeUnwrap(),
    ).toEqual({
      baseModel: "provider\\\\#name",
      thinkingLevel: "high",
    });
  });

  it("rejects an unknown suffix with all typed error details", () => {
    const raw = "provider/model#hgih";
    const result = parseModelIntentEntry(raw);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toEqual({
        type: "InvalidThinkingLevelSuffix",
        raw,
        foundSuffix: "hgih",
        allowed: THINKING_LEVEL_VALUES,
        message:
          'Invalid model thinking-level suffix "#hgih". ' +
          `Allowed levels: ${THINKING_LEVEL_VALUES.join(", ")}.`,
      });
    }
  });

  it("rejects an empty unescaped suffix", () => {
    const raw = "provider/model#";
    const result = parseModelIntentEntry(raw);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.foundSuffix).toBe("");
      expect(result.error.raw).toBe(raw);
      expect(result.error.message).toContain("Allowed levels:");
    }
  });
});
