import { describe, expect, it } from "bun:test";
import { CLAUDE_CODE_ADAPTER_CAPABILITY_CONTRACT } from "../index.js";

describe("Claude Code adapter capability contract", () => {
  it("declares thinking-level activation as unsupported with the host-control gap", () => {
    const capability =
      CLAUDE_CODE_ADAPTER_CAPABILITY_CONTRACT.capabilities.find(
        (entry) => entry.id === "model-thinking-activation",
      );

    expect(capability?.readiness).toBe("unsupported");
    expect(capability?.notes).toContain("no host-controlled per-invocation");
    expect(capability?.notes).toContain("ignored after base-model matching");
  });

  it("declares idle continuation as degraded for the foreground /weave:start projection", () => {
    const capability =
      CLAUDE_CODE_ADAPTER_CAPABILITY_CONTRACT.capabilities.find(
        (entry) => entry.id === "idle-continuation",
      );
    const notes = capability?.notes ?? "";

    expect(capability?.readiness).toBe("degraded");
    expect(notes).toContain("/weave:start");
    expect(notes).toContain("submits and enters plan work");
    expect(notes).toContain("foreground command");
    expect(notes).toContain("persisted idle-continuation state");
    expect(notes).toContain("enforced continuation budget");
    expect(notes).toContain("pause/resume");
    expect(notes).toContain("status surface");
    expect(notes).not.toContain(["goal", "command"].join(" "));
    expect(notes).not.toContain(["/weave", "goal"].join(":"));
  });
});
