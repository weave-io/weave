import { describe, expect, it } from "bun:test";
import { AdapterCapabilityContractSchema } from "@weaveio/weave-engine";
import { PI_ADAPTER_CAPABILITY_CONTRACT } from "../capability-declarations.js";

describe("Pi adapter capability contract", () => {
  it("parses the declared contract through the exported capability schema", () => {
    const parsed = AdapterCapabilityContractSchema.safeParse(
      PI_ADAPTER_CAPABILITY_CONTRACT,
    );
    expect(parsed.success).toBe(true);
  });

  it("declares provider-fast-activation as unsupported, never requested or applied", () => {
    const capability = PI_ADAPTER_CAPABILITY_CONTRACT.capabilities.find(
      (entry) => entry.id === "provider-fast-activation",
    );
    const serialized = JSON.stringify(capability);

    expect(capability?.readiness).toBe("unsupported");
    expect(capability?.runtimeStatus).toBe("unsupported");
    expect(capability?.notes).toContain("sends no acceleration control");
    expect(capability?.notes).toContain("unchanged");
    expect(capability?.readiness).not.toBe("native");
    expect(capability?.readiness).not.toBe("degraded");
    expect(serialized).not.toContain("applied");
    expect(serialized).not.toContain("requested");
    expect(serialized).not.toContain("not-confirmed");
    expect(serialized).not.toContain("service_tier");
    expect(serialized).not.toContain("anthropic-beta");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("before_provider_request");
  });
});
