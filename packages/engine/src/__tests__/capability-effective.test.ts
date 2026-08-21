/**
 * Probe-lowered effective capability contract (adapter capability contract extension / Pi adapter contract).
 */

import { describe, expect, it } from "bun:test";
import type {
  AdapterCapabilityContract,
  CapabilityId,
  CapabilityProbeResult,
  CapabilityReadiness,
} from "../capability-contract.js";
import {
  ALL_CAPABILITY_IDS,
  buildAdapterHealthReport,
  evaluateCoreReadinessProfile,
  evaluateEffectiveCapabilities,
  lowerReadinessByProbe,
  OPTIONAL_CAPABILITIES,
  REQUIRED_CAPABILITIES,
} from "../capability-contract.js";

function contractWith(
  readiness: CapabilityReadiness,
): AdapterCapabilityContract {
  return {
    capabilities: ALL_CAPABILITY_IDS.map((id) => ({
      id,
      description: id,
      readiness,
    })),
  };
}

function probes(
  statusFor: (id: CapabilityId) => CapabilityProbeResult["probeStatus"],
): CapabilityProbeResult[] {
  return ALL_CAPABILITY_IDS.map((id) => ({
    capabilityId: id,
    probeStatus: statusFor(id),
  }));
}

describe("lowerReadinessByProbe", () => {
  it("ok preserves declaration", () => {
    expect(lowerReadinessByProbe("native", "ok")).toBe("native");
    expect(lowerReadinessByProbe("emulated", "ok")).toBe("emulated");
    expect(lowerReadinessByProbe("degraded", "ok")).toBe("degraded");
    expect(lowerReadinessByProbe("unsupported", "ok")).toBe("unsupported");
  });

  it("degraded lowers without raising", () => {
    expect(lowerReadinessByProbe("native", "degraded")).toBe("degraded");
    expect(lowerReadinessByProbe("emulated", "degraded")).toBe("degraded");
    expect(lowerReadinessByProbe("degraded", "degraded")).toBe("degraded");
    expect(lowerReadinessByProbe("unsupported", "degraded")).toBe(
      "unsupported",
    );
  });

  it("unavailable/missing/failed/duplicate/contradictory become unsupported", () => {
    for (const resolution of [
      "unavailable",
      "missing",
      "failed",
      "duplicate",
      "contradictory",
    ] as const) {
      expect(lowerReadinessByProbe("native", resolution)).toBe("unsupported");
      expect(lowerReadinessByProbe("emulated", resolution)).toBe("unsupported");
    }
  });
});

describe("evaluateEffectiveCapabilities", () => {
  it("requires exactly one sanitized probe outcome per capability id (21)", () => {
    const evaluation = evaluateEffectiveCapabilities(
      contractWith("native"),
      probes(() => "ok"),
    );
    expect(evaluation.effectiveCapabilities).toHaveLength(21);
    expect(
      new Set(evaluation.effectiveCapabilities.map((c) => c.id)).size,
    ).toBe(21);
  });

  it("ok probes preserve static declarations in effective readiness", () => {
    const evaluation = evaluateEffectiveCapabilities(
      contractWith("emulated"),
      probes(() => "ok"),
    );
    for (const entry of evaluation.effectiveCapabilities) {
      expect(entry.declaredReadiness).toBe("emulated");
      expect(entry.effectiveReadiness).toBe("emulated");
      expect(entry.probeResolution).toBe("ok");
    }
    expect(evaluation.healthOnlyMode).toBe(false);
    expect(evaluation.profileResult.ready).toBe(true);
  });

  it("degraded probe on required capability enters health-only mode", () => {
    const evaluation = evaluateEffectiveCapabilities(
      contractWith("native"),
      probes((id) => (id === "workflow-persistence" ? "degraded" : "ok")),
    );
    expect(evaluation.healthOnlyMode).toBe(true);
    expect(evaluation.profileResult.ready).toBe(false);
    const entry = evaluation.effectiveCapabilities.find(
      (c) => c.id === "workflow-persistence",
    );
    expect(entry?.effectiveReadiness).toBe("degraded");
    expect(entry?.declaredReadiness).toBe("native");
  });

  it("unavailable probe lowers required capability to unsupported", () => {
    const evaluation = evaluateEffectiveCapabilities(
      contractWith("native"),
      probes((id) => (id === "command-entrypoints" ? "unavailable" : "ok")),
    );
    expect(evaluation.healthOnlyMode).toBe(true);
    const entry = evaluation.effectiveCapabilities.find(
      (c) => c.id === "command-entrypoints",
    );
    expect(entry?.effectiveReadiness).toBe("unsupported");
  });

  it("missing probes are unavailable for every id", () => {
    const evaluation = evaluateEffectiveCapabilities(
      contractWith("native"),
      [],
    );
    expect(evaluation.effectiveCapabilities).toHaveLength(21);
    for (const entry of evaluation.effectiveCapabilities) {
      expect(entry.probeResolution).toBe("missing");
      expect(entry.effectiveReadiness).toBe("unsupported");
    }
    expect(evaluation.healthOnlyMode).toBe(true);
  });

  it("duplicate probes for one id become unsupported", () => {
    const base = probes(() => "ok");
    const duplicated: CapabilityProbeResult[] = [
      ...base,
      { capabilityId: "event-logging", probeStatus: "ok" },
    ];
    const evaluation = evaluateEffectiveCapabilities(
      contractWith("native"),
      duplicated,
    );
    const entry = evaluation.effectiveCapabilities.find(
      (c) => c.id === "event-logging",
    );
    expect(entry?.probeResolution).toBe("duplicate");
    expect(entry?.effectiveReadiness).toBe("unsupported");
    expect(evaluation.healthOnlyMode).toBe(true);
  });

  it("contradictory probes for one id become unsupported", () => {
    const base = probes(() => "ok");
    const contradictory: CapabilityProbeResult[] = [
      ...base,
      { capabilityId: "tool-policy-mapping", probeStatus: "degraded" },
    ];
    // base already has tool-policy-mapping ok — duplicate with different status
    const evaluation = evaluateEffectiveCapabilities(
      contractWith("native"),
      contradictory,
    );
    const entry = evaluation.effectiveCapabilities.find(
      (c) => c.id === "tool-policy-mapping",
    );
    expect(entry?.probeResolution).toBe("contradictory");
    expect(entry?.effectiveReadiness).toBe("unsupported");
  });

  it("optional gaps warn without health-only mode", () => {
    const evaluation = evaluateEffectiveCapabilities(
      contractWith("native"),
      probes((id) =>
        OPTIONAL_CAPABILITIES.includes(id) ? "unavailable" : "ok",
      ),
    );
    expect(evaluation.healthOnlyMode).toBe(false);
    expect(evaluation.profileResult.ready).toBe(true);
    expect(evaluation.profileResult.warnings.length).toBe(
      OPTIONAL_CAPABILITIES.length,
    );
  });

  it("preserves static declarations object unchanged", () => {
    const declarations = contractWith("native");
    const evaluation = evaluateEffectiveCapabilities(
      declarations,
      probes(() => "unavailable"),
    );
    expect(evaluation.declarations).toBe(declarations);
    for (const entry of evaluation.declarations.capabilities) {
      expect(entry.readiness).toBe("native");
    }
  });

  it("never raises readiness above the declaration", () => {
    const evaluation = evaluateEffectiveCapabilities(
      contractWith("unsupported"),
      probes(() => "ok"),
    );
    for (const entry of evaluation.effectiveCapabilities) {
      expect(entry.effectiveReadiness).toBe("unsupported");
    }
  });
});

describe("buildAdapterHealthReport effective integration", () => {
  it("uses effective readiness for profileResult while keeping static contract", () => {
    const contract = contractWith("native");
    const report = buildAdapterHealthReport({
      harness: "synthetic",
      capabilityContract: contract,
      probeResults: probes((id) =>
        id === "agent-materialization" ? "unavailable" : "ok",
      ),
    });

    expect(report.capabilityContract).toBe(contract);
    expect(report.healthOnlyMode).toBe(true);
    expect(report.effectiveCapabilities).toHaveLength(21);
    expect(report.profileResult.ready).toBe(false);
    expect(
      report.profileResult.failures.some(
        (f) => f.capabilityId === "agent-materialization",
      ),
    ).toBe(true);

    // Static declaration remains native in the preserved contract.
    expect(
      report.capabilityContract.capabilities.find(
        (c) => c.id === "agent-materialization",
      )?.readiness,
    ).toBe("native");
  });

  it("all-ok probes match static core profile readiness", () => {
    const contract = contractWith("native");
    const report = buildAdapterHealthReport({
      harness: "synthetic",
      capabilityContract: contract,
      probeResults: probes(() => "ok"),
    });
    const staticProfile = evaluateCoreReadinessProfile(contract);
    expect(report.profileResult.ready).toBe(staticProfile.ready);
    expect(report.healthOnlyMode).toBe(false);
    expect(report.profileResult.passes).toHaveLength(
      REQUIRED_CAPABILITIES.length + OPTIONAL_CAPABILITIES.length,
    );
  });
});

describe("provider-fast-activation effective readiness", () => {
  it("optional provider-fast gaps warn without health-only mode", () => {
    const evaluation = evaluateEffectiveCapabilities(
      contractWith("native"),
      probes((id) =>
        id === "provider-fast-activation" ? "unavailable" : "ok",
      ),
    );
    expect(evaluation.healthOnlyMode).toBe(false);
    expect(evaluation.profileResult.ready).toBe(true);
    const entry = evaluation.effectiveCapabilities.find(
      (capability) => capability.id === "provider-fast-activation",
    );
    expect(entry?.declaredReadiness).toBe("native");
    expect(entry?.effectiveReadiness).toBe("unsupported");
    expect(
      evaluation.profileResult.warnings.some(
        (warning) => warning.capabilityId === "provider-fast-activation",
      ),
    ).toBe(true);
  });

  it("runtime evidence lowers a request-capable ceiling and cannot raise unsupported", () => {
    const contract: AdapterCapabilityContract = {
      capabilities: ALL_CAPABILITY_IDS.map((id) => ({
        id,
        description: id,
        readiness: id === "provider-fast-activation" ? "degraded" : "native",
      })),
    };
    const lowered = evaluateEffectiveCapabilities(
      contract,
      probes((id) =>
        id === "provider-fast-activation" ? "unavailable" : "ok",
      ),
    );
    const raised = evaluateEffectiveCapabilities(
      {
        capabilities: ALL_CAPABILITY_IDS.map((id) => ({
          id,
          description: id,
          readiness:
            id === "provider-fast-activation" ? "unsupported" : "native",
        })),
      },
      probes((id) => (id === "provider-fast-activation" ? "ok" : "ok")),
    );
    expect(
      lowered.effectiveCapabilities.find(
        (capability) => capability.id === "provider-fast-activation",
      )?.effectiveReadiness,
    ).toBe("unsupported");
    expect(
      raised.effectiveCapabilities.find(
        (capability) => capability.id === "provider-fast-activation",
      )?.effectiveReadiness,
    ).toBe("unsupported");
    expect(lowered.healthOnlyMode).toBe(false);
    expect(raised.healthOnlyMode).toBe(false);
  });

  it("omitting the optional capability does not force health-only mode", () => {
    const requiredOnly: AdapterCapabilityContract = {
      capabilities: REQUIRED_CAPABILITIES.map((id) => ({
        id,
        description: id,
        readiness: "native" as const,
      })),
    };
    const evaluation = evaluateEffectiveCapabilities(
      requiredOnly,
      probes((id) =>
        REQUIRED_CAPABILITIES.includes(id) ? "ok" : "unavailable",
      ),
    );
    expect(evaluation.healthOnlyMode).toBe(false);
    expect(
      evaluation.effectiveCapabilities.find(
        (capability) => capability.id === "provider-fast-activation",
      )?.effectiveReadiness,
    ).toBe("unsupported");
  });
});
