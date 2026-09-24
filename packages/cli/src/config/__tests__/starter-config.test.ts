import { describe, expect, it } from "bun:test";
import { getBuiltinConfig, mergeConfigsResult } from "@weaveio/weave-config";
import { parseConfig } from "@weaveio/weave-core";
import { starterConfig } from "../starter-config.js";

const builtin = getBuiltinConfig()._unsafeUnwrap();

describe.each([
  "local",
  "global",
] as const)("the %s starter config written by weave init", (scope) => {
  const starter = parseConfig(starterConfig(scope));

  it("is valid Weave DSL", () => {
    expect(starter.isOk()).toBe(true);
  });

  it("leaves every builtin agent exactly as the builtins define it", () => {
    const merged = mergeConfigsResult(
      builtin,
      starter._unsafeUnwrap(),
    )._unsafeUnwrap();
    for (const name of Object.keys(builtin.agents ?? {})) {
      expect(merged.agents?.[name]).toEqual(builtin.agents?.[name]);
    }
  });
});
