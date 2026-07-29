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

  it("declares idle continuation as degraded and names its capability gaps", () => {
    const capability =
      CLAUDE_CODE_ADAPTER_CAPABILITY_CONTRACT.capabilities.find(
        (entry) => entry.id === "idle-continuation",
      );

    expect(capability?.readiness).toBe("degraded");
    expect(capability?.notes).toContain("persisted goal state");
    expect(capability?.notes).toContain("enforced continuation budget");
    expect(capability?.notes).toContain("pause/resume");
    expect(capability?.notes).toContain("status surface");
  });
});
