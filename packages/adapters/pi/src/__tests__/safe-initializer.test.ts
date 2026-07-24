import { describe, expect, it } from "bun:test";
import type { CapabilityProbeResult } from "@weaveio/weave-engine";
import { ALL_CAPABILITY_IDS } from "@weaveio/weave-engine";
import {
  DefaultPiCapabilityProber,
  type PiCapabilityProbeSource,
  PROJECT_PATH_DEPENDENT_CAPABILITIES,
} from "../capability-prober.js";
import { ADAPTER_PACKAGE_IDENTITY, WEAVE_COMMAND_NAMES } from "../commands.js";
import { HOST_PACKAGE_NAME } from "../host-compatibility.js";
import { PiSafeInitializer } from "../safe-initializer.js";
import type { PiCommandInfo } from "../types.js";
import { FakeHostPackageReader } from "./fakes/fake-host-package-reader.js";

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
  return { mode, isProjectTrusted: () => trusted };
}

describe("PiSafeInitializer.preflight", () => {
  it("reaches a ready (non-health-only) state when every probe is ok, mode is tui, host is compatible", async () => {
    const initializer = new PiSafeInitializer({
      hostPackageReader: FakeHostPackageReader.ok({
        name: HOST_PACKAGE_NAME,
        version: "0.81.1",
      }),
      capabilityProber: new FixedProber(allOkProbes()),
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
    });
    const result = await initializer.preflight(
      sessionOf("tui", false),
      ALL_OWNED_COMMANDS,
    );
    const preflight = result._unsafeUnwrap();
    expect(preflight.trust).toBe("withheld");
    // The narrow project-trust-withheld probes genuinely report "ok" (they prove access was
    // correctly withheld, not that the capability is usable) -- this must not leak into readiness.
    for (const id of PROJECT_PATH_DEPENDENT_CAPABILITIES) {
      const entry = preflight.healthReport.probeResults.find(
        (probe) => probe.capabilityId === id,
      );
      expect(entry?.probeStatus).toBe("ok");
      expect(entry?.details).toBe("project-trust-withheld");
    }
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
    });
    const result = await initializer.preflight(
      sessionOf("tui", true),
      ALL_OWNED_COMMANDS,
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("InvariantViolation");
  });
});
