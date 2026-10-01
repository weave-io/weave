import { describe, expect, it } from "bun:test";
import { defaultLogLevel } from "../log-level.js";

const argv = (...args: string[]) => ["bun", "weave", ...args];

describe("defaultLogLevel", () => {
  it("keeps warnings for commands that do not report their own problems", () => {
    expect(defaultLogLevel(argv("validate"))).toBe("warn");
    expect(defaultLogLevel(argv("compose", "--harness", "claude-code"))).toBe(
      "warn",
    );
    expect(defaultLogLevel(argv())).toBe("warn");
  });

  it("drops to errors for weave models, which reports checks and skipped lists itself", () => {
    for (const sub of ["status", "update", "apply", "pin"])
      expect(defaultLogLevel(argv("models", sub))).toBe("error");
    expect(defaultLogLevel(argv("models", "update", "--harness", "pi"))).toBe(
      "error",
    );
  });

  it("keeps warnings when the arguments do not parse", () => {
    expect(defaultLogLevel(argv("models", "update", "--harness"))).toBe("warn");
  });
});
