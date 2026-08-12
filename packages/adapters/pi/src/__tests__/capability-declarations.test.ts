import { describe, expect, it } from "bun:test";
import { PI_ADAPTER_CAPABILITY_CONTRACT } from "../capability-declarations.js";

describe("Pi adapter capability contract", () => {
  it("declares provider-fast-activation as degraded request-capable, not applied or native", () => {
    const capability = PI_ADAPTER_CAPABILITY_CONTRACT.capabilities.find(
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
    expect(serialized).not.toContain("before_provider_request");
  });
});
