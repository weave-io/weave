import { describe, expect, it } from "bun:test";
import {
  AdapterCapabilityContractSchema,
  OPTIONAL_CAPABILITIES,
  ProviderFastActivationStatusSchema,
  REQUIRED_CAPABILITIES,
  readinessForProviderFastStatus,
} from "@weaveio/weave-engine";
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

  it("declares provider-fast-activation as unsupported without an applied claim", () => {
    const capability = OPENCODE_ADAPTER_CAPABILITY_CONTRACT.capabilities.find(
      (entry) => entry.id === "provider-fast-activation",
    );
    const serialized = JSON.stringify(capability);

    expect(capability?.readiness).toBe("unsupported");
    expect(capability?.runtimeStatus).toBe("unsupported");
    expect(capability?.notes).toContain("no correlated official response-body");
    expect(capability?.notes).toContain("cannot claim applied or native");
    expect(capability?.notes).toContain("agents still materialize");
    expect(capability?.remediationHint).toContain("unsupported");
    expect(capability?.readiness).not.toBe("native");
    expect(capability?.readiness).not.toBe("emulated");
    expect(serialized).not.toContain("service_tier");
    expect(serialized).not.toContain("anthropic-beta");
    expect(serialized).not.toContain("Authorization");
  });

  it("keeps provider-fast-activation optional so materialization is unaffected", () => {
    const capability = OPENCODE_ADAPTER_CAPABILITY_CONTRACT.capabilities.find(
      (entry) => entry.id === "provider-fast-activation",
    );

    expect(OPTIONAL_CAPABILITIES).toContain("provider-fast-activation");
    expect(REQUIRED_CAPABILITIES).not.toContain("provider-fast-activation");
    const runtimeStatus = ProviderFastActivationStatusSchema.safeParse(
      capability?.runtimeStatus,
    );
    expect(runtimeStatus.success).toBe(true);
    if (!runtimeStatus.success) return;
    expect(readinessForProviderFastStatus(runtimeStatus.data)).toBe(
      "unsupported",
    );
  });
});
