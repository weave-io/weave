import { describe, expect, it } from "bun:test";
import { OPENCODE_ADAPTER_CAPABILITY_CONTRACT } from "../capability-declarations.js";

describe("OpenCode adapter capability contract", () => {
  it("declares model-thinking-activation as degraded with an explicit SDK gap", () => {
    const capability = OPENCODE_ADAPTER_CAPABILITY_CONTRACT.capabilities.find(
      (entry) => entry.id === "model-thinking-activation",
    );

    expect(capability?.readiness).toBe("degraded");
    expect(capability?.notes).toContain("exact per-request reasoning-effort");
    expect(capability?.notes).toContain("unconfirmed");
  });

  it("declares idle-continuation as degraded with honest missing controls", () => {
    const capability = OPENCODE_ADAPTER_CAPABILITY_CONTRACT.capabilities.find(
      (entry) => entry.id === "idle-continuation",
    );

    expect(capability?.readiness).toBe("degraded");
    expect(capability?.notes).toContain("no persisted goal state");
    expect(capability?.notes).toContain("no enforced continuation budget");
    expect(capability?.notes).toContain("no pause/resume");
    expect(capability?.notes).toContain("no status surface");
  });
});
