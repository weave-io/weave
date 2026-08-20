import { describe, expect, it } from "bun:test";
import { ALL_CAPABILITY_IDS } from "@weaveio/weave-engine";
import {
  PI_ADAPTER_CAPABILITY_CONTRACT,
  PI_REQUIRED_FOR_DELEGATION_SURFACE_IDS,
} from "../capability-declarations.js";
import { DefaultPiCapabilityProber } from "../capability-prober.js";

const OBSOLETE_DESCRIPTOR_CAPABILITY = "descriptor-relative-native-session-io";
const FORBIDDEN_REPLACEMENT_CAPABILITY = "contained-native-session-io";

describe("Pi-native delegation readiness contract", () => {
  it("removes descriptor-relative session I/O from public and required capability sets", () => {
    const engineCapabilities = new Set<string>(ALL_CAPABILITY_IDS);
    const adapterCapabilities = new Set<string>(
      PI_ADAPTER_CAPABILITY_CONTRACT.capabilities.map(
        (capability) => capability.id,
      ),
    );
    const requiredSurfaces = new Set<string>(
      PI_REQUIRED_FOR_DELEGATION_SURFACE_IDS,
    );

    expect({
      engineDeclaresObsoleteCapability: engineCapabilities.has(
        OBSOLETE_DESCRIPTOR_CAPABILITY,
      ),
      adapterDeclaresObsoleteCapability: adapterCapabilities.has(
        OBSOLETE_DESCRIPTOR_CAPABILITY,
      ),
      adapterRequiresObsoleteSurface: requiredSurfaces.has(
        OBSOLETE_DESCRIPTOR_CAPABILITY,
      ),
      engineDeclaresPublicReplacement: engineCapabilities.has(
        FORBIDDEN_REPLACEMENT_CAPABILITY,
      ),
      adapterDeclaresPublicReplacement: adapterCapabilities.has(
        FORBIDDEN_REPLACEMENT_CAPABILITY,
      ),
    }).toEqual({
      engineDeclaresObsoleteCapability: false,
      adapterDeclaresObsoleteCapability: false,
      adapterRequiresObsoleteSurface: false,
      engineDeclaresPublicReplacement: false,
      adapterDeclaresPublicReplacement: false,
    });
  });

  it("maps a missing Pi session API to one closed path-free readiness reason", () => {
    const rawHostDetail =
      "SessionManager.open failed for /Users/example/private/session.jsonl";
    const probes = new DefaultPiCapabilityProber().probe({
      mode: "tui",
      trust: "trusted",
      commands: [],
      hostSurface: {
        probes: [
          {
            surfaceId: "session-restore",
            status: "unavailable",
            details: rawHostDetail,
          },
        ],
        requiredGaps: ["session-restore"],
        overlayFallbackGaps: [],
        featureGaps: [],
      },
    });
    const readiness = probes.find(
      (probe) => probe.capabilityId === "delegated-specialist-execution",
    );
    const publicOutput = JSON.stringify(readiness);

    expect({
      readiness,
      leakedRawDetail: publicOutput.includes(rawHostDetail),
      leakedPath: publicOutput.includes("/Users/example/private"),
      leakedMethodName: publicOutput.includes("SessionManager.open"),
    }).toEqual({
      readiness: {
        capabilityId: "delegated-specialist-execution",
        probeStatus: "unavailable",
        details: "pi-session-api-unavailable",
      },
      leakedRawDetail: false,
      leakedPath: false,
      leakedMethodName: false,
    });
  });
});
