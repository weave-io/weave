import { describe, expect, it } from "bun:test";
import type {
  AgentDescriptor,
  CapabilityProbeResult,
} from "@weaveio/weave-engine";
import { ALL_CAPABILITY_IDS } from "@weaveio/weave-engine";
import {
  DefaultPiCapabilityProber,
  type PiCapabilityProbeSource,
  PROJECT_PATH_DEPENDENT_CAPABILITIES,
} from "../capability-prober.js";
import { ADAPTER_PACKAGE_IDENTITY, WEAVE_COMMAND_NAMES } from "../commands.js";
import { PiConfigActivator } from "../config-activator.js";
import { HOST_PACKAGE_NAME } from "../host-compatibility.js";
import { PiSafeInitializer } from "../safe-initializer.js";
import type { PiCommandInfo } from "../types.js";
import { FakeHostPackageReader } from "./fakes/fake-host-package-reader.js";
import { fakeConfigActivator } from "./fakes/fake-pi-host.js";

const ALL_OWNED_COMMANDS: PiCommandInfo[] = WEAVE_COMMAND_NAMES.map((name) => ({
  name,
  source: "extension",
  sourceInfo: {
    path: `/node_modules/${ADAPTER_PACKAGE_IDENTITY}/dist/extension.js`,
    source: `npm:${ADAPTER_PACKAGE_IDENTITY}`,
    scope: "user",
    origin: "package",
  },
}));

/** Fully-controlled prober so tests can force every branch of the gating logic. */
class FixedProber implements PiCapabilityProbeSource {
  constructor(private readonly results: readonly CapabilityProbeResult[]) {}
  probe(): readonly CapabilityProbeResult[] {
    return this.results;
  }
}

function allOkProbes(): CapabilityProbeResult[] {
  return ALL_CAPABILITY_IDS.map((id) => ({
    capabilityId: id,
    probeStatus: "ok" as const,
  }));
}

function sessionOf(mode: "tui" | "rpc" | "json" | "print", trusted: boolean) {
  return {
    mode,
    isProjectTrusted: () => trusted,
    cwd: "/fake/project",
    modelRegistry: { getAvailable: () => [] },
  };
}

describe("PiSafeInitializer.preflight", () => {
  it("reaches a ready (non-health-only) state when every probe is ok, mode is tui, host is compatible", async () => {
    const initializer = new PiSafeInitializer({
      hostPackageReader: FakeHostPackageReader.ok({
        name: HOST_PACKAGE_NAME,
        version: "0.81.1",
      }),
      capabilityProber: new FixedProber(allOkProbes()),
      configActivator: fakeConfigActivator(),
    });
    const result = await initializer.preflight(
      sessionOf("tui", true),
      ALL_OWNED_COMMANDS,
    );
    expect(result.isOk()).toBe(true);
    const preflight = result._unsafeUnwrap();
    expect(preflight.healthOnlyMode).toBe(false);
    expect(preflight.modeSupported).toBe(true);
    expect(preflight.hostSupported).toBe(true);
    expect(preflight.trust).toBe("trusted");
  });

  it("enters health-only mode when mode is not tui, without touching the capability prober", async () => {
    let probeCalls = 0;
    class CountingProber implements PiCapabilityProbeSource {
      probe(): readonly CapabilityProbeResult[] {
        probeCalls += 1;
        return allOkProbes();
      }
    }
    const initializer = new PiSafeInitializer({
      hostPackageReader: FakeHostPackageReader.ok({
        name: HOST_PACKAGE_NAME,
        version: "0.81.1",
      }),
      capabilityProber: new CountingProber(),
      configActivator: fakeConfigActivator(),
    });
    const result = await initializer.preflight(
      sessionOf("rpc", true),
      ALL_OWNED_COMMANDS,
    );
    const preflight = result._unsafeUnwrap();
    expect(preflight.healthOnlyMode).toBe(true);
    expect(preflight.modeSupported).toBe(false);
    expect(probeCalls).toBe(0);
    expect(preflight.healthReport.effectiveCapabilities).toHaveLength(19);
    for (const capability of preflight.healthReport.effectiveCapabilities) {
      expect(
        capability.effectiveReadiness === "degraded" ||
          capability.effectiveReadiness === "unsupported",
      ).toBe(true);
    }
  });

  it("enters health-only mode when the host identity is unknown", async () => {
    const initializer = new PiSafeInitializer({
      hostPackageReader: FakeHostPackageReader.ok({
        name: "@mariozechner/pi-coding-agent",
        version: "0.81.1",
      }),
      capabilityProber: new FixedProber(allOkProbes()),
      configActivator: fakeConfigActivator(),
    });
    const result = await initializer.preflight(
      sessionOf("tui", true),
      ALL_OWNED_COMMANDS,
    );
    const preflight = result._unsafeUnwrap();
    expect(preflight.healthOnlyMode).toBe(true);
    expect(preflight.hostSupported).toBe(false);
  });

  it("enters health-only mode when the host version is out of range", async () => {
    const initializer = new PiSafeInitializer({
      hostPackageReader: FakeHostPackageReader.ok({
        name: HOST_PACKAGE_NAME,
        version: "0.82.0",
      }),
      capabilityProber: new FixedProber(allOkProbes()),
      configActivator: fakeConfigActivator(),
    });
    const result = await initializer.preflight(
      sessionOf("tui", true),
      ALL_OWNED_COMMANDS,
    );
    expect(result._unsafeUnwrap().healthOnlyMode).toBe(true);
  });

  it("enters health-only mode when the host package cannot be read at all", async () => {
    const initializer = new PiSafeInitializer({
      hostPackageReader: FakeHostPackageReader.failing(),
      capabilityProber: new FixedProber(allOkProbes()),
      configActivator: fakeConfigActivator(),
    });
    const result = await initializer.preflight(
      sessionOf("tui", true),
      ALL_OWNED_COMMANDS,
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().healthOnlyMode).toBe(true);
  });

  it("reports trust as withheld but forces health-only mode fail-closed, even when every probe (including project-path ones) reports ok", async () => {
    const okProbes = allOkProbes();
    const initializer = new PiSafeInitializer({
      hostPackageReader: FakeHostPackageReader.ok({
        name: HOST_PACKAGE_NAME,
        version: "0.81.1",
      }),
      capabilityProber: new FixedProber(okProbes),
      configActivator: fakeConfigActivator(),
    });
    const result = await initializer.preflight(
      sessionOf("tui", false),
      ALL_OWNED_COMMANDS,
    );
    const preflight = result._unsafeUnwrap();
    expect(preflight.trust).toBe("withheld");
    expect(preflight.healthOnlyMode).toBe(true);
  });

  it("fail-closed proof: the real prober's narrow project-trust-withheld ok status can never promote an untrusted project to ready", async () => {
    const initializer = new PiSafeInitializer({
      hostPackageReader: FakeHostPackageReader.ok({
        name: HOST_PACKAGE_NAME,
        version: "0.81.1",
      }),
      capabilityProber: new DefaultPiCapabilityProber(),
      configActivator: fakeConfigActivator(),
    });
    const result = await initializer.preflight(
      sessionOf("tui", false),
      ALL_OWNED_COMMANDS,
    );
    const preflight = result._unsafeUnwrap();
    expect(preflight.trust).toBe("withheld");
    // Candidate-plan-aware capabilities now report a real outcome derived
    // from the (builtin/global-only) config activation that still runs
    // under withheld trust, rather than the narrow placeholder -- config
    // activation itself succeeds (no loom descriptor in the empty fake
    // plan), so config/agent materialization report ok while primary
    // selection and prompt composition correctly report unavailable.
    const candidatePlanAwareIds = [
      "config-materialization",
      "agent-materialization",
      "primary-agent-selection",
      "prompt-composition",
    ] as const;
    const otherProjectPathDependentIds =
      PROJECT_PATH_DEPENDENT_CAPABILITIES.filter(
        (id) => !(candidatePlanAwareIds as readonly string[]).includes(id),
      );
    for (const id of otherProjectPathDependentIds) {
      const entry = preflight.healthReport.probeResults.find(
        (probe) => probe.capabilityId === id,
      );
      expect(entry?.probeStatus).toBe("ok");
      expect(entry?.details).toBe("project-trust-withheld");
    }
    const configMaterialization = preflight.healthReport.probeResults.find(
      (probe) => probe.capabilityId === "config-materialization",
    );
    expect(configMaterialization?.probeStatus).toBe("ok");
    const agentMaterialization = preflight.healthReport.probeResults.find(
      (probe) => probe.capabilityId === "agent-materialization",
    );
    expect(agentMaterialization?.probeStatus).toBe("ok");
    const primaryAgentSelection = preflight.healthReport.probeResults.find(
      (probe) => probe.capabilityId === "primary-agent-selection",
    );
    expect(primaryAgentSelection?.probeStatus).toBe("unavailable");
    const promptComposition = preflight.healthReport.probeResults.find(
      (probe) => probe.capabilityId === "prompt-composition",
    );
    expect(promptComposition?.probeStatus).toBe("unavailable");
    // Even though config/agent materialization report "ok" under withheld
    // trust, the adapter is still fail-closed to health-only overall.
    expect(preflight.healthOnlyMode).toBe(true);
  });

  it("fail-closed proof: trust-withheld stays health-only even when an adversarial prober also reports command-entrypoints and token-usage-reporting ok", async () => {
    const allOk = allOkProbes();
    const initializer = new PiSafeInitializer({
      hostPackageReader: FakeHostPackageReader.ok({
        name: HOST_PACKAGE_NAME,
        version: "0.81.1",
      }),
      capabilityProber: new FixedProber(allOk),
      configActivator: fakeConfigActivator(),
    });
    const result = await initializer.preflight(
      sessionOf("tui", false),
      ALL_OWNED_COMMANDS,
    );
    const preflight = result._unsafeUnwrap();
    expect(preflight.healthReport.effectiveCapabilities).toHaveLength(19);
    expect(preflight.healthOnlyMode).toBe(true);
  });

  it("enters health-only mode when a required capability is degraded or unsupported", async () => {
    const probes = allOkProbes().map((probe) =>
      probe.capabilityId === "workflow-persistence"
        ? { ...probe, probeStatus: "unavailable" as const }
        : probe,
    );
    const initializer = new PiSafeInitializer({
      hostPackageReader: FakeHostPackageReader.ok({
        name: HOST_PACKAGE_NAME,
        version: "0.81.1",
      }),
      capabilityProber: new FixedProber(probes),
      configActivator: fakeConfigActivator(),
    });
    const result = await initializer.preflight(
      sessionOf("tui", true),
      ALL_OWNED_COMMANDS,
    );
    expect(result._unsafeUnwrap().healthOnlyMode).toBe(true);
  });

  it("does not enter health-only mode from an optional-only gap", async () => {
    const probes = allOkProbes().map((probe) =>
      probe.capabilityId === "eval-integration"
        ? { ...probe, probeStatus: "unavailable" as const }
        : probe,
    );
    const initializer = new PiSafeInitializer({
      hostPackageReader: FakeHostPackageReader.ok({
        name: HOST_PACKAGE_NAME,
        version: "0.81.1",
      }),
      capabilityProber: new FixedProber(probes),
      configActivator: fakeConfigActivator(),
    });
    const result = await initializer.preflight(
      sessionOf("tui", true),
      ALL_OWNED_COMMANDS,
    );
    expect(result._unsafeUnwrap().healthOnlyMode).toBe(false);
  });

  it("returns exactly one probe per ID even when the prober throws (invariant violation)", async () => {
    class ThrowingProber implements PiCapabilityProbeSource {
      probe(): readonly CapabilityProbeResult[] {
        throw new Error("boom");
      }
    }
    const initializer = new PiSafeInitializer({
      hostPackageReader: FakeHostPackageReader.ok({
        name: HOST_PACKAGE_NAME,
        version: "0.81.1",
      }),
      capabilityProber: new ThrowingProber(),
      configActivator: fakeConfigActivator(),
    });
    const result = await initializer.preflight(
      sessionOf("tui", true),
      ALL_OWNED_COMMANDS,
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("InvariantViolation");
  });

  it("reports config/agent-materialization, primary-agent-selection, and prompt-composition as ok from a real candidate plan (Spec 33 \u00a76, \u00a77.2, \u00a728)", async () => {
    const loom: AgentDescriptor = {
      name: "loom",
      composedPrompt: "You are Loom.",
      models: ["claude-sonnet-4-5"],
      mode: "primary",
      effectiveToolPolicy: {
        read: "allow",
        write: "allow",
        execute: "allow",
        delegate: "allow",
        network: "ask",
      },
      rawToolPolicy: undefined,
      delegationTargets: [],
      skills: [],
    };
    const initializer = new PiSafeInitializer({
      hostPackageReader: FakeHostPackageReader.ok({
        name: HOST_PACKAGE_NAME,
        version: "0.81.1",
      }),
      capabilityProber: new DefaultPiCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [{ agentName: "loom", source: "explicit", descriptor: loom }],
        errors: [],
      }),
    });
    const result = await initializer.preflight(
      {
        mode: "tui",
        isProjectTrusted: () => true,
        cwd: "/fake/project",
        modelRegistry: {
          getAvailable: () => [
            { provider: "anthropic", id: "claude-sonnet-4-5" },
          ],
        },
      },
      ALL_OWNED_COMMANDS,
    );
    const preflight = result._unsafeUnwrap();
    const statusOf = (id: string) =>
      preflight.healthReport.probeResults.find((p) => p.capabilityId === id)
        ?.probeStatus;
    expect(statusOf("config-materialization")).toBe("ok");
    expect(statusOf("agent-materialization")).toBe("ok");
    expect(statusOf("primary-agent-selection")).toBe("ok");
    expect(statusOf("prompt-composition")).toBe("ok");
  });

  it("keeps primary-agent-selection ok (with a fallback detail) when the default primary's model intent does not dry-resolve -- Spec 33 \u00a79.2 ties this to descriptor model health, not primary selectability", async () => {
    const loom: AgentDescriptor = {
      name: "loom",
      composedPrompt: "You are Loom.",
      models: ["nonexistent-model"],
      mode: "primary",
      effectiveToolPolicy: {
        read: "allow",
        write: "allow",
        execute: "allow",
        delegate: "allow",
        network: "ask",
      },
      rawToolPolicy: undefined,
      delegationTargets: [],
      skills: [],
    };
    const initializer = new PiSafeInitializer({
      hostPackageReader: FakeHostPackageReader.ok({
        name: HOST_PACKAGE_NAME,
        version: "0.81.1",
      }),
      capabilityProber: new DefaultPiCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [{ agentName: "loom", source: "explicit", descriptor: loom }],
        errors: [],
      }),
    });
    const result = await initializer.preflight(
      {
        mode: "tui",
        isProjectTrusted: () => true,
        cwd: "/fake/project",
        modelRegistry: {
          getAvailable: () => [
            { provider: "anthropic", id: "claude-sonnet-4-5" },
          ],
        },
      },
      ALL_OWNED_COMMANDS,
    );
    const preflight = result._unsafeUnwrap();
    const primaryAgentSelection = preflight.healthReport.probeResults.find(
      (p) => p.capabilityId === "primary-agent-selection",
    );
    expect(primaryAgentSelection?.probeStatus).toBe("ok");
    expect(primaryAgentSelection?.details).toBe(
      "primary-selectable-model-fallback",
    );
    // Not asserting healthOnlyMode here: with the real prober, several
    // other emulated capabilities outside this task's scope (e.g.
    // tool-policy-mapping, workflow-persistence) still legitimately report
    // not-yet-implemented, which correctly keeps the adapter health-only
    // independent of this specific capability's status.
  });

  it("preserves descriptor isolation: an unrelated custom descriptor's composition failure does not degrade agent-materialization or force health-only while Loom remains valid", async () => {
    const loom: AgentDescriptor = {
      name: "loom",
      composedPrompt: "You are Loom.",
      models: ["claude-sonnet-4-5"],
      mode: "primary",
      effectiveToolPolicy: {
        read: "allow",
        write: "allow",
        execute: "allow",
        delegate: "allow",
        network: "ask",
      },
      rawToolPolicy: undefined,
      delegationTargets: [],
      skills: [],
    };
    const initializer = new PiSafeInitializer({
      hostPackageReader: FakeHostPackageReader.ok({
        name: HOST_PACKAGE_NAME,
        version: "0.81.1",
      }),
      capabilityProber: new DefaultPiCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [{ agentName: "loom", source: "explicit", descriptor: loom }],
        errors: [
          {
            type: "DescriptorCompositionFailure",
            agentName: "my-broken-custom-agent",
            cause: {
              type: "PromptSourceMissingError",
              agentName: "my-broken-custom-agent",
              message: "missing prompt",
            },
          },
        ],
      }),
    });
    const result = await initializer.preflight(
      {
        mode: "tui",
        isProjectTrusted: () => true,
        cwd: "/fake/project",
        modelRegistry: {
          getAvailable: () => [
            { provider: "anthropic", id: "claude-sonnet-4-5" },
          ],
        },
      },
      ALL_OWNED_COMMANDS,
    );
    const preflight = result._unsafeUnwrap();
    const statusOf = (id: string) =>
      preflight.healthReport.probeResults.find((p) => p.capabilityId === id)
        ?.probeStatus;
    expect(statusOf("agent-materialization")).toBe("ok");
    expect(statusOf("config-materialization")).toBe("ok");
    expect(statusOf("primary-agent-selection")).toBe("ok");
    expect(statusOf("prompt-composition")).toBe("ok");
    // Not asserting healthOnlyMode here for the same reason as above: other
    // out-of-scope emulated capabilities still legitimately report
    // not-yet-implemented under the real prober.
  });

  it("fails closed with a typed PiAdapterFailure instead of an unhandled rejection when the injected configActivator port rejects", async () => {
    const initializer = new PiSafeInitializer({
      hostPackageReader: FakeHostPackageReader.ok({
        name: HOST_PACKAGE_NAME,
        version: "0.81.1",
      }),
      capabilityProber: new DefaultPiCapabilityProber(),
      configActivator: new PiConfigActivator({
        configLoader: {
          load: () =>
            Promise.reject(
              new Error("leaked: token=sk-super-secret-123"),
            ) as never,
        },
      }),
    });

    const result = await initializer.preflight(
      sessionOf("tui", true),
      ALL_OWNED_COMMANDS,
    );

    // preflight() itself must still succeed (it always reports a health
    // report); the rejection is captured and reflected as an unavailable
    // config-materialization outcome instead of escaping as an unhandled
    // rejection.
    expect(result.isOk()).toBe(true);
    const preflight = result._unsafeUnwrap();
    expect(preflight.configActivationFailure?.correlation).toEqual({
      reason: "config-load-threw",
    });
    expect(JSON.stringify(preflight.configActivationFailure)).not.toContain(
      "sk-super-secret-123",
    );
    expect(preflight.configActivation).toBeUndefined();
    const configMaterialization = preflight.healthReport.probeResults.find(
      (p) => p.capabilityId === "config-materialization",
    );
    expect(configMaterialization?.probeStatus).toBe("unavailable");
  });

  it("fails closed instead of throwing when the injected configActivator port throws synchronously", async () => {
    const initializer = new PiSafeInitializer({
      hostPackageReader: FakeHostPackageReader.ok({
        name: HOST_PACKAGE_NAME,
        version: "0.81.1",
      }),
      capabilityProber: new DefaultPiCapabilityProber(),
      configActivator: new PiConfigActivator({
        configLoader: {
          load: () => {
            throw new Error(
              "leaked: /Users/attacker/.ssh/id_rsa token=sk-super-secret-123",
            );
          },
        },
      }),
    });

    const result = await initializer.preflight(
      sessionOf("tui", true),
      ALL_OWNED_COMMANDS,
    );

    expect(result.isOk()).toBe(true);
    const preflight = result._unsafeUnwrap();
    expect(preflight.configActivation).toBeUndefined();
    expect(preflight.configActivationFailure?.correlation).toEqual({
      reason: "config-load-threw",
    });
    expect(JSON.stringify(preflight.configActivationFailure)).not.toContain(
      "id_rsa",
    );
    expect(JSON.stringify(preflight.configActivationFailure)).not.toContain(
      "sk-super-secret-123",
    );
  });

  it("fails closed instead of crashing preflight when the injected modelRegistry.getAvailable() throws", async () => {
    const loom: AgentDescriptor = {
      name: "loom",
      composedPrompt: "You are Loom.",
      models: ["claude-sonnet-4-5"],
      mode: "primary",
      effectiveToolPolicy: {
        read: "allow",
        write: "allow",
        execute: "allow",
        delegate: "allow",
        network: "ask",
      },
      rawToolPolicy: undefined,
      delegationTargets: [],
      skills: [],
    };
    const initializer = new PiSafeInitializer({
      hostPackageReader: FakeHostPackageReader.ok({
        name: HOST_PACKAGE_NAME,
        version: "0.81.1",
      }),
      capabilityProber: new DefaultPiCapabilityProber(),
      configActivator: fakeConfigActivator({
        agents: [{ agentName: "loom", source: "explicit", descriptor: loom }],
        errors: [],
      }),
    });

    const result = await initializer.preflight(
      {
        mode: "tui",
        isProjectTrusted: () => true,
        cwd: "/fake/project",
        modelRegistry: {
          getAvailable: () => {
            throw new Error("modelRegistry blew up");
          },
        },
      },
      ALL_OWNED_COMMANDS,
    );

    // preflight() must not reject/throw; the primary is still found and
    // remains selectable/usable, just with the model-fallback detail since
    // the catalog could not be read (Spec 33 §9.2 fail-closed behavior).
    expect(result.isOk()).toBe(true);
    const preflight = result._unsafeUnwrap();
    const primaryAgentSelection = preflight.healthReport.probeResults.find(
      (p) => p.capabilityId === "primary-agent-selection",
    );
    expect(primaryAgentSelection?.probeStatus).toBe("ok");
    expect(primaryAgentSelection?.details).toBe(
      "primary-selectable-model-fallback",
    );
  });

  it("sanitizes even a configActivator implementation that itself misbehaves beyond its own type contract (bypassing PiConfigActivator's own wrapping)", async () => {
    class ThrowingConfigActivator extends PiConfigActivator {
      override activate(): never {
        throw new Error(
          "leaked: /Users/attacker/.ssh/id_rsa token=sk-super-secret-123",
        );
      }
    }

    const initializer = new PiSafeInitializer({
      hostPackageReader: FakeHostPackageReader.ok({
        name: HOST_PACKAGE_NAME,
        version: "0.81.1",
      }),
      capabilityProber: new DefaultPiCapabilityProber(),
      configActivator: new ThrowingConfigActivator(),
    });

    const result = await initializer.preflight(
      sessionOf("tui", true),
      ALL_OWNED_COMMANDS,
    );

    expect(result.isOk()).toBe(true);
    const preflight = result._unsafeUnwrap();
    expect(preflight.configActivation).toBeUndefined();
    expect(preflight.configActivationFailure?.correlation).toEqual({
      reason: "config-activation-threw",
    });
    expect(JSON.stringify(preflight.configActivationFailure)).not.toContain(
      "id_rsa",
    );
    expect(JSON.stringify(preflight.configActivationFailure)).not.toContain(
      "sk-super-secret-123",
    );
  });
});
