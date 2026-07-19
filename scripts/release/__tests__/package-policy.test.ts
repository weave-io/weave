import { describe, expect, it } from "bun:test";
import { PackagePolicyValidator } from "../package-policy.js";

describe("PackagePolicyValidator", () => {
  it("rejects modified or non-archive bytes before extraction", () => {
    const result = new PackagePolicyValidator().validate(
      new TextEncoder().encode("modified"),
    );
    expect(result.isErr()).toBe(true);
  });
});
