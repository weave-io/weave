import { describe, expect, it } from "bun:test";
import { AdapterCapabilityContractSchema } from "@weaveio/weave-engine";
import { OPENCODE_ADAPTER_CAPABILITY_CONTRACT } from "../capability-declarations.js";

describe("OpenCode adapter capability contract", () => {
  it("parses the declared contract through the exported capability schema", () => {
    const parsed = AdapterCapabilityContractSchema.safeParse(
      OPENCODE_ADAPTER_CAPABILITY_CONTRACT,
    );
    expect(parsed.success).toBe(true);
  });

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

  it("declares provider-fast-activation as degraded request-capable, not applied or native", () => {
    const capability = OPENCODE_ADAPTER_CAPABILITY_CONTRACT.capabilities.find(
      (entry) => entry.id === "provider-fast-activation",
    );
    const serialized = JSON.stringify(capability);

    expect(capability?.readiness).toBe("degraded");
    expect(capability?.runtimeStatus).toBe("not-confirmed");
    expect(capability?.notes).toContain("request");
    expect(capability?.notes).toContain("response-body proof");
    expect(capability?.notes).toContain("cannot claim applied or native");
    expect(capability?.readiness).not.toBe("native");
    expect(serialized).not.toContain("service_tier");
    expect(serialized).not.toContain("anthropic-beta");
    expect(serialized).not.toContain("Authorization");
  });
});
