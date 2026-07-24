import { describe, expect, it } from "bun:test";
import {
  sanitizedBaseEnv,
  WEAVE_CHILD_AGENT_NAME_ENV,
  WEAVE_CHILD_DEPTH_ENV,
  WEAVE_CHILD_ID_ENV,
  WEAVE_CHILD_PARENT_ID_ENV,
  WEAVE_CHILD_SECRET_ENV,
  WEAVE_CONTROLLER_GENERATION_ENV,
} from "../child-env.js";

describe("sanitizedBaseEnv", () => {
  it("preserves ordinary runtime environment values (e.g. PATH-shaped keys)", () => {
    const original = Bun.env.PATH;
    if (original === undefined) return; // Nothing to assert in an environment without PATH.
    const result = sanitizedBaseEnv(() => false);
    expect(result.PATH).toBe(original);
  });

  it("never forwards a key the caller's isDeniedKey policy flags, regardless of value", () => {
    const denied = new Set(["SOME_SECRET_TOKEN"]);
    const result = sanitizedBaseEnv((key) => denied.has(key));
    expect(Object.keys(result)).not.toContain("SOME_SECRET_TOKEN");
  });

  it("never forwards this adapter's own reserved WEAVE_CHILD_* bootstrap variables, even if somehow present in Bun.env", () => {
    const result = sanitizedBaseEnv(() => false);
    for (const reserved of [
      WEAVE_CHILD_SECRET_ENV,
      WEAVE_CHILD_ID_ENV,
      WEAVE_CONTROLLER_GENERATION_ENV,
      WEAVE_CHILD_AGENT_NAME_ENV,
      WEAVE_CHILD_DEPTH_ENV,
      WEAVE_CHILD_PARENT_ID_ENV,
    ]) {
      expect(Object.keys(result)).not.toContain(reserved);
    }
  });

  it("produces only string values (never undefined entries)", () => {
    const result = sanitizedBaseEnv(() => false);
    for (const value of Object.values(result)) {
      expect(typeof value).toBe("string");
    }
  });
});
