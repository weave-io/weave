import { describe, expect, it } from "bun:test";
import {
  inspectLegacyJsonc,
  MAX_LEGACY_JSONC_SOURCE_LENGTH,
} from "../legacy-jsonc-inspect.js";

describe("inspectLegacyJsonc", () => {
  it("accepts comments and trailing commas", () => {
    expect(inspectLegacyJsonc('{\n// comment\n"agents": {},\n}').isOk()).toBe(
      true,
    );
  });

  it("rejects malformed, duplicate, and dangerous object keys", () => {
    expect(inspectLegacyJsonc('{"agents":')._unsafeUnwrapErr().type).toBe(
      "ParseFailed",
    );
    const duplicate = inspectLegacyJsonc(
      '{"agents": {}, "agents": {}}',
    )._unsafeUnwrapErr();
    expect(duplicate.type).toBe("UnsafeStructure");
    expect(duplicate.warnings[0]?.reason).toContain("duplicate");
    const dangerous = inspectLegacyJsonc(
      '{"agents": {"__proto__": {}}}',
    )._unsafeUnwrapErr();
    expect(dangerous.type).toBe("UnsafeStructure");
    expect(dangerous.warnings[0]).toEqual({
      field: "agents.<entry>",
      reason: "dangerous object key is not allowed",
    });
  });

  it("bounds input and warning output", () => {
    expect(
      inspectLegacyJsonc(
        " ".repeat(MAX_LEGACY_JSONC_SOURCE_LENGTH + 1),
      )._unsafeUnwrapErr().type,
    ).toBe("SourceTooLarge");
    const entries = Array.from(
      { length: 100 },
      (_, index) => `"key${index}": 1, "key${index}": 2`,
    ).join(",");
    const warnings = inspectLegacyJsonc(`{${entries}}`)._unsafeUnwrapErr()
      .warnings;
    expect(warnings.length).toBeLessThanOrEqual(32);
    expect(warnings.at(-1)?.reason).toContain("truncated");
  });
});
