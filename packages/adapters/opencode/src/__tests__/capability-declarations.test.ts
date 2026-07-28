import { describe, expect, it } from "bun:test";
import { OPENCODE_ADAPTER_CAPABILITY_CONTRACT } from "../capability-declarations.js";

describe("OpenCode adapter capability contract", () => {
  it("declares model-thinking-activation as degraded with an explicit SDK gap", () => {
    const capability =
      OPENCODE_ADAPTER_CAPABILITY_CONTRACT.capabilities.find(
        (entry) => entry.id === "model-thinking-activation",
      );

    expect(capability?.readiness).toBe("degraded");
    expect(capability?.notes).toContain("exact per-request reasoning-effort");
    expect(capability?.notes).toContain("unconfirmed");
  });
});
