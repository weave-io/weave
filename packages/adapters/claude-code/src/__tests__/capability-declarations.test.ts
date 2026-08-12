import { describe, expect, it } from "bun:test";
import { AdapterCapabilityContractSchema } from "@weaveio/weave-engine";
import { CLAUDE_CODE_ADAPTER_CAPABILITY_CONTRACT } from "../index.js";

describe("Claude Code adapter capability contract", () => {
  it("parses the declared contract through the exported capability schema", () => {
    const parsed = AdapterCapabilityContractSchema.safeParse(
      CLAUDE_CODE_ADAPTER_CAPABILITY_CONTRACT,
    );
    expect(parsed.success).toBe(true);
  });

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

  it("declares provider-fast-activation as unsupported for static materialization", () => {
    const capability =
      CLAUDE_CODE_ADAPTER_CAPABILITY_CONTRACT.capabilities.find(
        (entry) => entry.id === "provider-fast-activation",
      );
    const serialized = JSON.stringify(capability);

    expect(capability?.readiness).toBe("unsupported");
    expect(capability?.runtimeStatus).toBe("unsupported");
    expect(capability?.notes).toContain("static materialization");
    expect(capability?.notes).toContain("no owned request");
    expect(capability?.readiness).not.toBe("native");
    expect(capability?.readiness).not.toBe("degraded");
    expect(serialized).not.toContain("service_tier");
    expect(serialized).not.toContain("fastMode");
    expect(serialized).not.toContain("anthropic-beta");
  });
});
