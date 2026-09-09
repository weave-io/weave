import { describe, expect, it } from "bun:test";
import { parseOpenCode2Options } from "../v2/options.js";

describe("parseOpenCode2Options", () => {
  it("applies bounded defaults", () => {
    expect(parseOpenCode2Options({})._unsafeUnwrap()).toEqual({
      projectConfig: true,
      defaultAgent: undefined,
      refreshIntervalMs: 1000,
    });
  });

  it("rejects unknown fields", () => {
    expect(
      parseOpenCode2Options({ unexpected: true })._unsafeUnwrapErr().code,
    ).toBe("invalid_options");
  });
});
