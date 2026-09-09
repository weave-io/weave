import { describe, expect, it } from "bun:test";
import {
  isOpenCode2DelegationTarget,
  OPENCODE2_DELEGATION_ACTION,
} from "../v2/delegation.js";

describe("OpenCode 2 delegation", () => {
  it("uses only native subagent target identity", () => {
    expect(OPENCODE2_DELEGATION_ACTION).toBe("subagent");
    expect(isOpenCode2DelegationTarget("weft", ["weft"])).toBe(true);
    expect(isOpenCode2DelegationTarget("warp", ["weft"])).toBe(false);
  });
});
