import { describe, expect, it } from "bun:test";
import { resolveOpenCode2Model } from "../v2/model-resolution.js";
import { modelInfo } from "./v2-fixtures.js";

describe("resolveOpenCode2Model", () => {
  const models = [
    modelInfo("alpha", "shared", ["high"]),
    modelInfo("beta", "shared", ["low"]),
    modelInfo("alpha", "fallback", ["balanced"]),
  ];

  it("inherits only when intent is absent", () => {
    expect(resolveOpenCode2Model([], "high", models)._unsafeUnwrap()).toEqual({
      source: "inherit",
    });
  });

  it("resolves qualified models and per-entry variants", () => {
    const result = resolveOpenCode2Model(
      ["alpha/shared#high"],
      "invalid",
      models,
    )._unsafeUnwrap();
    expect(result.ref).toMatchObject({
      providerID: "alpha",
      id: "shared",
      variant: "high",
    });
  });

  it("uses descriptor variants only when the entry omits one", () => {
    expect(
      String(
        resolveOpenCode2Model(
          ["alpha/fallback"],
          "balanced",
          models,
        )._unsafeUnwrap().ref?.variant,
      ),
    ).toBe("balanced");
  });

  it("rejects ambiguous bare models and selects the first viable fallback", () => {
    const result = resolveOpenCode2Model(
      ["shared", "alpha/fallback#balanced"],
      undefined,
      models,
    )._unsafeUnwrap();
    expect(result.selectedIndex).toBe(1);
    expect(String(result.ref?.id)).toBe("fallback");
  });

  it("returns bounded typed failures when no entry is viable", () => {
    const errors = resolveOpenCode2Model(
      ["shared", "missing", "alpha/shared#missing"],
      undefined,
      models,
    )._unsafeUnwrapErr();
    expect(errors.map((error) => error.type)).toEqual([
      "AmbiguousModel",
      "MissingModel",
      "InvalidVariant",
    ]);
  });
});
