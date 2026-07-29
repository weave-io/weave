import { describe, expect, it } from "bun:test";
import { parseWeaveGoalArgs } from "../goal-args.js";

describe("parseWeaveGoalArgs", () => {
  it("parses empty, status, and check", () => {
    expect(parseWeaveGoalArgs("")).toEqual({ kind: "status" });
    expect(parseWeaveGoalArgs("status")).toEqual({ kind: "status" });
    expect(parseWeaveGoalArgs(" CHECK ")).toEqual({ kind: "status" });
  });
  it("parses pause, resume directions, and every clear alias", () => {
    expect(parseWeaveGoalArgs("pause")).toEqual({ kind: "pause" });
    expect(parseWeaveGoalArgs("resume")).toEqual({ kind: "resume" });
    expect(parseWeaveGoalArgs("resume FRONT END NOW")).toEqual({
      kind: "resume",
      direction: "FRONT END NOW",
    });
    for (const alias of ["clear", "stop", "off", "reset", "none", "cancel"])
      expect(parseWeaveGoalArgs(alias)).toEqual({ kind: "clear" });
  });
  it("escapes control words and accepts safe names", () => {
    expect(parseWeaveGoalArgs("-- status")).toEqual({
      kind: "start",
      planName: "status",
    });
    expect(parseWeaveGoalArgs("my_plan-2")).toEqual({
      kind: "start",
      planName: "my_plan-2",
    });
    for (const name of [
      "/",
      ".",
      "..",
      "../secret",
      "a/b",
      "a b",
      "name with space",
      "a.md",
      "--",
    ])
      expect(parseWeaveGoalArgs(name)).toMatchObject({ kind: "invalid" });
  });
});
