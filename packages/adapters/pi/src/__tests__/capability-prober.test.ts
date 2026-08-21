import { describe, expect, it } from "bun:test";
import { ALL_CAPABILITY_IDS } from "@weaveio/weave-engine";
import {
  PI_ADAPTER_CAPABILITY_CONTRACT,
  PI_FEATURE_ONLY_SURFACE_IDS,
  PI_OVERLAY_ONLY_SURFACE_IDS,
  PI_REQUIRED_FOR_DELEGATION_SURFACE_IDS,
  PI_SESSION_CAPABILITY_SURFACE_IDS,
} from "../capability-declarations.js";
import {
  AGENT_RECOVERY_EXHAUSTED_PRESENT,
  AGENT_RECOVERY_EXHAUSTED_UNSUPPORTED,
  buildBlockedProbeSet,
  DefaultPiCapabilityProber,
  describeDelegationReadinessGap,
  PROJECT_PATH_DEPENDENT_CAPABILITIES,
  probeAgentRecoveryExhaustedFeature,
  sanitizeCapabilityProbeResults,
} from "../capability-prober.js";
import { ADAPTER_PACKAGE_IDENTITY, WEAVE_COMMAND_NAMES } from "../commands.js";
import { PI_HOST_COMPATIBILITY_MATRIX } from "../host-compatibility-matrix.js";
import {
  buildHostSurfaceGapDiagnostics,
  DefaultPiHostSurfaceReader,
  PI_HOST_SURFACE_IDS,
  type PiHostSurfaceId,
  readHostSurfaceReport,
  selectsCustomEditorFallback,
} from "../host-inventory.js";
import type { PiCommandInfo } from "../types.js";

/**
 * A command whose `sourceInfo` proves canonical ownership (Pi adapter contract):
 * `origin: "package"` plus a `source` that resolves, via the same
 * `npm:<name>[@version]` convention Pi's own package manager uses, to this
 * package's exact npm name. Ownership MUST NOT be inferred from the command
 * name or from `path` substring matching.
 */
function ownedCommand(name: string): PiCommandInfo {
  return {
    name,
    source: "extension",
    sourceInfo: {
      path: `/node_modules/${ADAPTER_PACKAGE_IDENTITY}/dist/extension.js`,
      source: `npm:${ADAPTER_PACKAGE_IDENTITY}`,
      scope: "user",
      origin: "package",
    },
  };
}

/** A command registered by some other npm-installed extension. */
function foreignCommand(
  name: string,
  source = "npm:some-other-extension",
): PiCommandInfo {
  return {
    name,
    source: "extension",
    sourceInfo: {
      path: "/node_modules/some-other-extension/dist/index.js",
      source,
      scope: "user",
      origin: "package",
    },
  };
}

function localCommand(name: string): PiCommandInfo {
  return {
    name,
    source: "extension",
    sourceInfo: {
      path: "/Users/example/projects/weave/packages/adapters/pi/dist/extension.js",
      source: "extension",
      scope: "user",
      origin: "top-level",
    },
  };
}

const ALL_OWNED_COMMANDS = WEAVE_COMMAND_NAMES.map(ownedCommand);

describe("PI_ADAPTER_CAPABILITY_CONTRACT", () => {
  it("declares model-thinking activation as emulated through Pi's thinking-level API", () => {
    const capability = PI_ADAPTER_CAPABILITY_CONTRACT.capabilities.find(
      (entry) => entry.id === "model-thinking-activation",
    );
    expect(capability?.readiness).toBe("emulated");
    expect(capability?.description).toBe(
      "Translating a descriptor's per-model thinking-level intent into pi.setThinkingLevel()",
    );
  });
});

describe("buildBlockedProbeSet", () => {
  it("returns exactly one unavailable probe for all 20 capability IDs", () => {
    const probes = buildBlockedProbeSet("interactive-tui-required");
    expect(probes).toHaveLength(ALL_CAPABILITY_IDS.length);
    expect(probes).toHaveLength(ALL_CAPABILITY_IDS.length);
    for (const probe of probes) {
      expect(probe.probeStatus).toBe("unavailable");
      expect(probe.details).toBe("interactive-tui-required");
    }
    const ids = probes.map((probe) => probe.capabilityId).sort();
    expect(ids).toEqual([...ALL_CAPABILITY_IDS].sort());
  });
});

/** The spawn-authority verdict a trusted, fully wired generation reports. */
const READY_AUTHORITY = { status: "ready" } as const;

describe("DefaultPiCapabilityProber", () => {
  const prober = new DefaultPiCapabilityProber();

  it("reports delegation unavailable when no spawn authority verdict exists", () => {
    const probe = prober
      .probe({
        mode: "tui",
        trust: "trusted",
        commands: ALL_OWNED_COMMANDS,
        candidatePlan: {
          configLoaded: true,
          materializationErrorCount: 0,
          primaryDescriptorFound: true,
          primaryModelDryResolved: true,
          delegationToolPlanned: true,
        },
      })
      .find((entry) => entry.capabilityId === "delegated-specialist-execution");

    expect(probe).toEqual({
      capabilityId: "delegated-specialist-execution",
      probeStatus: "unavailable",
      details: "pi-session-api-unavailable",
    });
  });

  it("returns exactly one probe per capability ID, in the trusted case", () => {
    const probes = prober.probe({
      mode: "tui",
      trust: "trusted",
      commands: ALL_OWNED_COMMANDS,
    });
    expect(probes).toHaveLength(ALL_CAPABILITY_IDS.length);
    const ids = probes.map((probe) => probe.capabilityId);
    expect(new Set(ids).size).toBe(ALL_CAPABILITY_IDS.length);
    expect([...ids].sort()).toEqual([...ALL_CAPABILITY_IDS].sort());
  });

  it("reports Pi native tool control without permission interception", () => {
    const probes = prober.probe({
      mode: "tui",
      trust: "trusted",
      commands: ALL_OWNED_COMMANDS,
    });
    expect(
      probes.find((probe) => probe.capabilityId === "tool-policy-mapping"),
    ).toEqual({
      capabilityId: "tool-policy-mapping",
      probeStatus: "ok",
      details: "pi-native-tool-control",
    });
  });

  it("reports command-entrypoints ok when every command is exclusively owned", () => {
    const probes = prober.probe({
      mode: "tui",
      trust: "trusted",
      commands: ALL_OWNED_COMMANDS,
    });
    // Count-free wording: the catalog grows, and a details string naming a
    // fixed number goes stale the moment a command is added.
    expect(
      probes.find((probe) => probe.capabilityId === "command-entrypoints"),
    ).toEqual({
      capabilityId: "command-entrypoints",
      probeStatus: "ok",
      details: "all-commands-exclusively-owned",
    });
  });

  it("requires the child-extension configuration command to be owned", () => {
    const missingPiConfig = ALL_OWNED_COMMANDS.filter(
      (command) => command.name !== "weave:pi-config",
    );
    const probes = prober.probe({
      mode: "tui",
      trust: "trusted",
      commands: missingPiConfig,
    });
    expect(
      probes.find((probe) => probe.capabilityId === "command-entrypoints"),
    ).toEqual({
      capabilityId: "command-entrypoints",
      probeStatus: "unavailable",
      details: "command-collision-or-missing:weave:pi-config",
    });
  });

  it("reports command-entrypoints unavailable when a command is missing", () => {
    const missingOne = ALL_OWNED_COMMANDS.filter(
      (command) => command.name !== "weave:start",
    );
    const probes = prober.probe({
      mode: "tui",
      trust: "trusted",
      commands: missingOne,
    });
    const entry = probes.find(
      (probe) => probe.capabilityId === "command-entrypoints",
    );
    expect(entry?.probeStatus).toBe("unavailable");
    expect(entry?.details).toContain("weave:start");
  });

  it("reports command-entrypoints unavailable when our registration was suffixed by a collision", () => {
    const suffixed = ALL_OWNED_COMMANDS.map((command) =>
      command.name === "weave:health"
        ? { ...command, name: "weave:health:2" }
        : command,
    );
    const probes = prober.probe({
      mode: "tui",
      trust: "trusted",
      commands: suffixed,
    });
    const entry = probes.find(
      (probe) => probe.capabilityId === "command-entrypoints",
    );
    expect(entry?.probeStatus).toBe("unavailable");
  });

  it("reports command-entrypoints unavailable when a rival suffix exists even though we still hold the bare name", () => {
    const rivalSuffixed = foreignCommand("weave:health:1");
    const probes = prober.probe({
      mode: "tui",
      trust: "trusted",
      commands: [...ALL_OWNED_COMMANDS, rivalSuffixed],
    });
    const entry = probes.find(
      (probe) => probe.capabilityId === "command-entrypoints",
    );
    expect(entry?.probeStatus).toBe("unavailable");
    expect(entry?.details).toContain("weave:health");
  });

  it("does not treat a foreign command as owned merely because its path string contains our package name", () => {
    const spoofed = ALL_OWNED_COMMANDS.map((command) =>
      command.name === "weave:start"
        ? {
            ...command,
            sourceInfo: {
              ...command.sourceInfo,
              path: `/node_modules/rogue-extension/vendored/${ADAPTER_PACKAGE_IDENTITY}/dist/index.js`,
              source: "npm:rogue-extension",
            },
          }
        : command,
    );
    const probes = prober.probe({
      mode: "tui",
      trust: "trusted",
      commands: spoofed,
    });
    const entry = probes.find(
      (probe) => probe.capabilityId === "command-entrypoints",
    );
    expect(entry?.probeStatus).toBe("unavailable");
    expect(entry?.details).toContain("weave:start");
  });

  it("does not treat a same-name package-origin command as owned when the npm source name differs", () => {
    const rivalSameName = ALL_OWNED_COMMANDS.map((command) =>
      command.name === "weave:plan"
        ? foreignCommand("weave:plan", "npm:@weaveio/weave-adapter-pi-fake")
        : command,
    );
    const probes = prober.probe({
      mode: "tui",
      trust: "trusted",
      commands: rivalSameName,
    });
    const entry = probes.find(
      (probe) => probe.capabilityId === "command-entrypoints",
    );
    expect(entry?.probeStatus).toBe("unavailable");
  });

  it("allows top-level commands only when local provenance enforcement is explicitly disabled", () => {
    const localProber = new DefaultPiCapabilityProber({
      enforceCommandProvenance: false,
    });
    const probes = localProber.probe({
      mode: "tui",
      trust: "trusted",
      commands: WEAVE_COMMAND_NAMES.map(localCommand),
    });
    expect(
      probes.find((probe) => probe.capabilityId === "command-entrypoints"),
    ).toEqual({
      capabilityId: "command-entrypoints",
      probeStatus: "ok",
      details: "all-commands-present-local-provenance-disabled",
    });
  });

  it("reports token-usage-reporting ok regardless of trust", () => {
    const probes = prober.probe({
      mode: "tui",
      trust: "withheld",
      commands: ALL_OWNED_COMMANDS,
    });
    const entry = probes.find(
      (probe) => probe.capabilityId === "token-usage-reporting",
    );
    expect(entry?.probeStatus).toBe("ok");
  });

  it("reports every not-yet-implemented capability as unavailable when trusted", () => {
    const probes = prober.probe({
      mode: "tui",
      trust: "trusted",
      commands: ALL_OWNED_COMMANDS,
    });
    for (const id of PROJECT_PATH_DEPENDENT_CAPABILITIES) {
      const entry = probes.find((probe) => probe.capabilityId === id);
      expect(entry?.probeStatus).toBe("unavailable");
      // Delegation names the missing spawn authority instead of the generic
      // reason: with no verdict wired, no spawn could succeed.
      expect(entry?.details).toBe(
        id === "delegated-specialist-execution"
          ? "pi-session-api-unavailable"
          : "not-yet-implemented",
      );
    }
  });

  it("reports project-path-dependent capabilities as ok-with-note when trust is withheld", () => {
    const probes = prober.probe({
      mode: "tui",
      trust: "withheld",
      commands: ALL_OWNED_COMMANDS,
    });
    for (const id of PROJECT_PATH_DEPENDENT_CAPABILITIES) {
      const entry = probes.find((probe) => probe.capabilityId === id);
      expect(entry?.probeStatus).toBe("ok");
      expect(entry?.details).toBe("project-trust-withheld");
    }
  });

  it("does not let trust-withheld ok-with-note apply to non-project-path capabilities", () => {
    const probes = prober.probe({
      mode: "tui",
      trust: "withheld",
      commands: ALL_OWNED_COMMANDS,
    });
    const promptComposition = probes.find(
      (probe) => probe.capabilityId === "prompt-composition",
    );
    expect(promptComposition?.probeStatus).toBe("unavailable");
    expect(promptComposition?.details).toBe("not-yet-implemented");
  });

  it("blocks delegated specialist execution on required host gaps but not rendering fallbacks", () => {
    const complete = readHostSurfaceReport(
      PI_HOST_SURFACE_IDS.map((surfaceId) => ({
        surfaceId,
        status: "native",
        details: "ok",
      })),
    );
    const required = PI_HOST_COMPATIBILITY_MATRIX.surfaces.find(
      (surface) => surface.required,
    );
    expect(required).toBeDefined();
    const gap = readHostSurfaceReport(
      PI_HOST_SURFACE_IDS.map((surfaceId) => ({
        surfaceId,
        status: "native" as const,
        details: "ok",
      })).filter((row) => row.surfaceId !== required?.id),
    );
    const base = {
      mode: "tui" as const,
      trust: "trusted" as const,
      commands: ALL_OWNED_COMMANDS,
      candidatePlan: {
        configLoaded: true,
        materializationErrorCount: 0,
        primaryDescriptorFound: true,
        primaryModelDryResolved: true,
        delegationToolPlanned: true,
        eventLoggingPlanned: true,
        runtimeDirectoryContained: true,
        plansDirectoryContained: true,
      },
      delegationAuthority: READY_AUTHORITY,
    };
    const blocked = prober
      .probe({ ...base, hostSurface: gap })
      .find((probe) => probe.capabilityId === "delegated-specialist-execution");
    expect(blocked).toEqual({
      capabilityId: "delegated-specialist-execution",
      probeStatus: "unavailable",
      details: describeDelegationReadinessGap([
        required?.id as PiHostSurfaceId,
      ]),
    });
    const renderingFallback = readHostSurfaceReport(
      PI_HOST_SURFACE_IDS.map((surfaceId, index) => ({
        surfaceId,
        status: index < 6 ? ("fallback" as const) : ("native" as const),
        details: "ok",
      })),
    );
    const allowed = prober
      .probe({ ...base, hostSurface: renderingFallback })
      .find((probe) => probe.capabilityId === "delegated-specialist-execution");
    expect(allowed?.probeStatus).toBe("ok");
    expect(complete.requiredGaps).toEqual([]);
  });

  it("reports sealed delegation, event logging, workflow, and plan capabilities as ok", () => {
    const probes = prober.probe({
      mode: "tui",
      trust: "trusted",
      commands: ALL_OWNED_COMMANDS,
      delegationAuthority: READY_AUTHORITY,
      candidatePlan: {
        configLoaded: true,
        materializationErrorCount: 0,
        primaryDescriptorFound: true,
        primaryModelDryResolved: true,
        delegationToolPlanned: true,
        eventLoggingPlanned: true,
        runtimeDirectoryContained: true,
        plansDirectoryContained: true,
      },
    });
    for (const id of [
      "delegated-specialist-execution",
      "event-logging",
      "workflow-persistence",
      "workflow-step-dispatch",
      "plan-file-compatibility",
    ] as const) {
      const entry = probes.find((probe) => probe.capabilityId === id);
      expect(entry?.probeStatus).toBe("ok");
    }
  });

  it("keeps delegation and event logging unavailable without their candidate-plan proofs", () => {
    const probes = prober.probe({
      mode: "tui",
      trust: "trusted",
      commands: ALL_OWNED_COMMANDS,
      candidatePlan: {
        configLoaded: true,
        materializationErrorCount: 0,
        primaryDescriptorFound: true,
        primaryModelDryResolved: true,
        runtimeDirectoryContained: true,
        plansDirectoryContained: true,
      },
    });
    expect(
      probes.find(
        (probe) => probe.capabilityId === "delegated-specialist-execution",
      )?.probeStatus,
    ).toBe("unavailable");
    expect(
      probes.find((probe) => probe.capabilityId === "event-logging")
        ?.probeStatus,
    ).toBe("unavailable");
  });

  it("never raises workflow-persistence, workflow-step-dispatch, or plan-file-compatibility above unavailable when config failed to load", () => {
    const probes = prober.probe({
      mode: "tui",
      trust: "trusted",
      commands: ALL_OWNED_COMMANDS,
      candidatePlan: {
        configLoaded: false,
        materializationErrorCount: 0,
        primaryDescriptorFound: false,
        primaryModelDryResolved: false,
      },
    });
    for (const id of [
      "workflow-persistence",
      "workflow-step-dispatch",
      "plan-file-compatibility",
    ] as const) {
      const entry = probes.find((probe) => probe.capabilityId === id);
      expect(entry?.probeStatus).toBe("unavailable");
      expect(entry?.details).toBe("config-not-loaded");
    }
  });
});

describe("native session capability probes", () => {
  const prober = new DefaultPiCapabilityProber();
  /**
   * A `SessionManager` shaped like the installed Pi public type: static
   * `create`/`open` factories plus the read-only instance methods. Every
   * member is tracked so a test can prove probing never calls them.
   */
  const sessionManagerStub = (
    track: (name: string) => (...args: unknown[]) => unknown,
  ) => {
    const constructed = track("SessionManager.construct");
    function SessionManagerStub(this: unknown, ...args: unknown[]) {
      return constructed(...args);
    }
    const stub = SessionManagerStub as unknown as Record<string, unknown>;
    stub.create = track("SessionManager.create");
    stub.open = track("SessionManager.open");
    const proto = SessionManagerStub.prototype as Record<string, unknown>;
    proto.getEntries = track("getEntries");
    proto.getTree = track("getTree");
    proto.getSessionDir = track("getSessionDir");
    proto.usesDefaultSessionDir = track("usesDefaultSessionDir");
    return SessionManagerStub;
  };
  const basePlan = {
    configLoaded: true,
    materializationErrorCount: 0,
    primaryDescriptorFound: true,
    primaryModelDryResolved: true,
    delegationToolPlanned: true,
    eventLoggingPlanned: true,
    runtimeDirectoryContained: true,
    plansDirectoryContained: true,
  };
  const base = {
    mode: "tui" as const,
    trust: "trusted" as const,
    commands: ALL_OWNED_COMMANDS,
    candidatePlan: basePlan,
    delegationAuthority: READY_AUTHORITY,
  };
  const reportWithout = (missing?: string) =>
    readHostSurfaceReport(
      PI_HOST_SURFACE_IDS.filter((surfaceId) => surfaceId !== missing).map(
        (surfaceId) => ({
          surfaceId,
          status: "native" as const,
          details: "validated-native-host-surface",
        }),
      ),
    );

  it("declares the four Spec 33 §16 session capability contracts", () => {
    expect([...PI_SESSION_CAPABILITY_SURFACE_IDS]).toEqual([
      "rpc-persistent-session",
      "rpc-append-entry",
      "rpc-session-tree-read",
      "custom-session-directory",
    ]);
    for (const id of [
      "rpc-persistent-session",
      "rpc-append-entry",
      "rpc-session-tree-read",
      "custom-session-directory",
    ] as const) {
      expect(PI_REQUIRED_FOR_DELEGATION_SURFACE_IDS).toContain(id);
    }
    expect(PI_OVERLAY_ONLY_SURFACE_IDS).toEqual(["child-overlay-lifecycle"]);
    expect(PI_FEATURE_ONLY_SURFACE_IDS).toEqual(["post-recovery-model-switch"]);
  });

  it("probes without creating a session or any other side effect", async () => {
    const calls: string[] = [];
    const track =
      (name: string) =>
      (...args: unknown[]) => {
        calls.push(`${name}:${args.length}`);
        return undefined;
      };
    const result = await new DefaultPiHostSurfaceReader().read({
      api: {
        appendEntry: track("appendEntry"),
        sendUserMessage: track("sendUserMessage"),
      } as never,
      ui: {
        setStatus: track("setStatus"),
        setEditorComponent: track("setEditorComponent"),
        getEditorComponent: track("getEditorComponent"),
        custom: track("custom"),
      } as never,
      rootExports: {
        VERSION: "0.83.0",
        AssistantMessageComponent: () => undefined,
        ToolExecutionComponent: () => undefined,
        Markdown: () => undefined,
        Image: () => undefined,
        FooterComponent: () => undefined,
        BorderedLoader: () => undefined,
        CustomEditor: () => undefined,
        SessionManager: sessionManagerStub(track),
      },
    });
    expect(result.isOk()).toBe(true);
    expect(calls).toEqual([]);
    const report = readHostSurfaceReport(result._unsafeUnwrap());
    // Reading the surface report never constructs, opens, or appends to a
    // session: a complete public namespace proves every required surface
    // through presence alone.
    expect(report.requiredGaps).toEqual([]);
    expect(report.overlayFallbackGaps).toEqual([]);
  });

  it("reports ready with no gaps when every session capability is present", () => {
    const report = reportWithout();
    expect(report.requiredGaps).toEqual([]);
    expect(report.overlayFallbackGaps).toEqual([]);
    expect(selectsCustomEditorFallback(report)).toBe(false);
    expect(buildHostSurfaceGapDiagnostics(report, "0.83.0")).toEqual([]);
    const probe = prober
      .probe({ ...base, hostSurface: report })
      .find((entry) => entry.capabilityId === "delegated-specialist-execution");
    expect(probe?.probeStatus).toBe("ok");
  });

  it("enters health-only with a full diagnostic for each missing required session capability", () => {
    for (const surfaceId of [
      "rpc-persistent-session",
      "rpc-append-entry",
      "rpc-session-tree-read",
      "custom-session-directory",
    ] as const) {
      const report = reportWithout(surfaceId);
      expect(report.requiredGaps).toEqual([surfaceId]);
      expect(report.overlayFallbackGaps).toEqual([]);
      expect(selectsCustomEditorFallback(report)).toBe(false);

      const probe = prober
        .probe({ ...base, hostSurface: report })
        .find(
          (entry) => entry.capabilityId === "delegated-specialist-execution",
        );
      expect(probe).toEqual({
        capabilityId: "delegated-specialist-execution",
        probeStatus: "unavailable",
        details: "pi-session-api-unavailable",
      });

      const [diagnostic, ...rest] = buildHostSurfaceGapDiagnostics(
        report,
        "0.83.0",
      );
      expect(rest).toEqual([]);
      expect(diagnostic?.capability).toBe(surfaceId);
      expect(diagnostic?.hostVersion).toBe("0.83.0");
      expect(diagnostic?.contract.length).toBeGreaterThan(0);
      expect(diagnostic?.probeResult).toBe("unavailable:surface-missing");
      expect(diagnostic?.mode).toBe("health-only");
      expect(diagnostic?.remediation.length).toBeGreaterThan(0);
    }
  });

  it("selects the custom-editor fallback for an overlay-only gap instead of health-only", () => {
    const report = reportWithout("child-overlay-lifecycle");
    expect(report.requiredGaps).toEqual([]);
    expect(report.overlayFallbackGaps).toEqual(["child-overlay-lifecycle"]);
    expect(selectsCustomEditorFallback(report)).toBe(true);
    expect(
      report.probes.find(
        (probe) => probe.surfaceId === "child-overlay-lifecycle",
      ),
    ).toEqual({
      surfaceId: "child-overlay-lifecycle",
      status: "fallback",
      details: "custom-editor-fallback",
    });

    const probe = prober
      .probe({ ...base, hostSurface: report })
      .find((entry) => entry.capabilityId === "delegated-specialist-execution");
    expect(probe?.probeStatus).toBe("ok");

    const [diagnostic] = buildHostSurfaceGapDiagnostics(report, "0.83.0");
    expect(diagnostic?.capability).toBe("child-overlay-lifecycle");
    expect(diagnostic?.mode).toBe("custom-editor-fallback");
    expect(diagnostic?.probeResult).toBe("fallback:custom-editor-fallback");
    expect(diagnostic?.remediation).toContain("custom-editor");
  });

  it("names an unknown host version rather than omitting it", () => {
    const [diagnostic] = buildHostSurfaceGapDiagnostics(
      reportWithout("rpc-append-entry"),
    );
    expect(diagnostic?.hostVersion).toBe("unknown");
  });
});

describe("post-recovery hook feature detection", () => {
  const prober = new DefaultPiCapabilityProber();
  const trustedBase = {
    mode: "tui" as const,
    trust: "trusted" as const,
    commands: ALL_OWNED_COMMANDS,
    candidatePlan: {
      configLoaded: true,
      materializationErrorCount: 0,
      primaryDescriptorFound: true,
      primaryModelDryResolved: true,
      delegationToolPlanned: true,
      eventLoggingPlanned: true,
      runtimeDirectoryContained: true,
      plansDirectoryContained: true,
    },
    delegationAuthority: READY_AUTHORITY,
  };

  function hookHost(features: unknown) {
    return Object.defineProperty({} as object, "features", {
      value: features,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  it("accepts only an own enumerable data property equal to true", () => {
    const supported = probeAgentRecoveryExhaustedFeature(
      hookHost(
        Object.defineProperty({} as object, "agent_recovery_exhausted", {
          value: true,
          enumerable: true,
          writable: false,
          configurable: false,
        }),
      ),
    );
    expect(supported.isOk()).toBe(true);
    if (supported.isOk()) expect(supported.value).toBe(true);
  });

  it("rejects absence, non-true values, inherited keys, accessors, and throws", () => {
    const inherited = Object.create({
      agent_recovery_exhausted: true,
    }) as object;
    const nonEnumerable = Object.defineProperty(
      {} as object,
      "agent_recovery_exhausted",
      { value: true, enumerable: false },
    );
    const accessor = Object.defineProperty(
      {} as object,
      "agent_recovery_exhausted",
      {
        get: () => true,
        enumerable: true,
      },
    );
    const throwingFeatures = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("trap");
        },
      },
    );

    const cases = [
      {},
      { features: undefined },
      hookHost(null),
      hookHost("true"),
      hookHost({ agent_recovery_exhausted: false }),
      hookHost({ agent_recovery_exhausted: "true" }),
      hookHost({ agent_recovery_exhausted: 1 }),
      hookHost(inherited),
      hookHost(nonEnumerable),
      hookHost(accessor),
      hookHost(throwingFeatures),
    ];
    for (const host of cases) {
      const result = probeAgentRecoveryExhaustedFeature(host);
      const supported = result.match(
        (value) => value,
        () => false,
      );
      expect(supported).toBe(false);
    }
  });

  it("treats a hook-less host as an unsupported feature-only surface without changing gates", () => {
    const report = readHostSurfaceReport(
      PI_HOST_SURFACE_IDS.filter(
        (surfaceId) => surfaceId !== "post-recovery-model-switch",
      ).map((surfaceId) => ({
        surfaceId,
        status: "native" as const,
        details: "validated-native-host-surface",
      })),
    );
    expect(report.requiredGaps).toEqual([]);
    expect(report.overlayFallbackGaps).toEqual([]);
    expect(selectsCustomEditorFallback(report)).toBe(false);
    expect(report.featureGaps).toEqual(["post-recovery-model-switch"]);
    expect(buildHostSurfaceGapDiagnostics(report, "0.83.0")).toEqual([
      {
        capability: "post-recovery-model-switch",
        hostVersion: "0.83.0",
        contract:
          "Spec 33 post-recovery hook: pi.features.agent_recovery_exhausted",
        probeResult: `unavailable:${AGENT_RECOVERY_EXHAUSTED_UNSUPPORTED}`,
        mode: "feature-unavailable",
        remediation:
          "Upgrade the Pi host to one that advertises pi.features.agent_recovery_exhausted === true; until then exhausted recovery settles as it does today.",
      },
    ]);
    expect(
      report.probes.find(
        (probe) => probe.surfaceId === "post-recovery-model-switch",
      ),
    ).toEqual({
      surfaceId: "post-recovery-model-switch",
      status: "unavailable",
      details: AGENT_RECOVERY_EXHAUSTED_UNSUPPORTED,
    });

    const probes = prober.probe({ ...trustedBase, hostSurface: report });
    expect(
      probes.some(
        (probe) => (probe.capabilityId as string) === "runtime-model-fallback",
      ),
    ).toBe(false);
    expect(
      probes.find(
        (probe) => probe.capabilityId === "delegated-specialist-execution",
      )?.probeStatus,
    ).toBe("ok");
    expect(
      probes.find((probe) => probe.capabilityId === "command-entrypoints")
        ?.probeStatus,
    ).toBe("ok");
  });

  it("treats a hook-bearing host as a supported feature-only surface", () => {
    const report = readHostSurfaceReport(
      PI_HOST_SURFACE_IDS.map((surfaceId) => ({
        surfaceId,
        status: "native" as const,
        details:
          surfaceId === "post-recovery-model-switch"
            ? AGENT_RECOVERY_EXHAUSTED_PRESENT
            : "validated-native-host-surface",
      })),
    );
    expect(report.requiredGaps).toEqual([]);
    expect(report.overlayFallbackGaps).toEqual([]);
    expect(report.featureGaps).toEqual([]);
    expect(buildHostSurfaceGapDiagnostics(report, "0.83.0")).toEqual([]);
    expect(
      report.probes.find(
        (probe) => probe.surfaceId === "post-recovery-model-switch",
      ),
    ).toEqual({
      surfaceId: "post-recovery-model-switch",
      status: "native",
      details: AGENT_RECOVERY_EXHAUSTED_PRESENT,
    });

    const probes = prober.probe({ ...trustedBase, hostSurface: report });
    expect(
      probes.some(
        (probe) => (probe.capabilityId as string) === "runtime-model-fallback",
      ),
    ).toBe(false);
    expect(
      probes.find(
        (probe) => probe.capabilityId === "delegated-specialist-execution",
      )?.probeStatus,
    ).toBe("ok");
  });
});

describe("sanitizeCapabilityProbeResults", () => {
  function okProbe(id: string, details?: string) {
    return details === undefined
      ? { capabilityId: id, probeStatus: "ok" }
      : { capabilityId: id, probeStatus: "ok", details };
  }

  function fullValidSet(): Record<string, unknown>[] {
    return ALL_CAPABILITY_IDS.map((id) => okProbe(id));
  }

  it("passes a fully well-formed probe set through unchanged, one row per ID", () => {
    const sanitized = sanitizeCapabilityProbeResults(fullValidSet());
    expect(sanitized).toHaveLength(ALL_CAPABILITY_IDS.length);
    expect([...sanitized.map((probe) => probe.capabilityId)].sort()).toEqual(
      [...ALL_CAPABILITY_IDS].sort(),
    );
    for (const probe of sanitized) {
      expect(probe.probeStatus).toBe("ok");
    }
  });

  it("normalizes a missing capability ID to a single unavailable row", () => {
    const raw = fullValidSet().filter(
      (probe) => probe.capabilityId !== "workflow-persistence",
    );
    const sanitized = sanitizeCapabilityProbeResults(raw);
    expect(sanitized).toHaveLength(ALL_CAPABILITY_IDS.length);
    const entry = sanitized.find(
      (probe) => probe.capabilityId === "workflow-persistence",
    );
    expect(entry?.probeStatus).toBe("unavailable");
  });

  it("normalizes a duplicated capability ID (same status) to a single unavailable row", () => {
    const raw = [...fullValidSet(), okProbe("workflow-persistence")];
    const sanitized = sanitizeCapabilityProbeResults(raw);
    expect(sanitized).toHaveLength(ALL_CAPABILITY_IDS.length);
    const entries = sanitized.filter(
      (probe) => probe.capabilityId === "workflow-persistence",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.probeStatus).toBe("unavailable");
  });

  it("normalizes a contradictory capability ID (disagreeing statuses) to a single unavailable row", () => {
    const raw = fullValidSet().map((probe) =>
      probe.capabilityId === "tool-policy-mapping"
        ? { ...probe, probeStatus: "unavailable" }
        : probe,
    );
    raw.push(okProbe("tool-policy-mapping"));
    const sanitized = sanitizeCapabilityProbeResults(raw);
    expect(sanitized).toHaveLength(ALL_CAPABILITY_IDS.length);
    const entries = sanitized.filter(
      (probe) => probe.capabilityId === "tool-policy-mapping",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.probeStatus).toBe("unavailable");
  });

  it("normalizes a malformed probeStatus value to a single unavailable row", () => {
    const raw = fullValidSet().map((probe) =>
      probe.capabilityId === "event-logging"
        ? { ...probe, probeStatus: "super-ok" }
        : probe,
    );
    const sanitized = sanitizeCapabilityProbeResults(raw);
    expect(sanitized).toHaveLength(ALL_CAPABILITY_IDS.length);
    const entry = sanitized.find(
      (probe) => probe.capabilityId === "event-logging",
    );
    expect(entry?.probeStatus).toBe("unavailable");
  });

  it("drops an entry for an unrecognized capability ID without adding an extra row", () => {
    const raw = [
      ...fullValidSet(),
      { capabilityId: "not-a-real-capability", probeStatus: "ok" },
    ];
    const sanitized = sanitizeCapabilityProbeResults(raw);
    expect(sanitized).toHaveLength(ALL_CAPABILITY_IDS.length);
    expect(
      sanitized.some(
        (probe) => (probe.capabilityId as string) === "not-a-real-capability",
      ),
    ).toBe(false);
  });

  it("normalizes unsafe (oversized) detail data to a single unavailable row", () => {
    const raw = fullValidSet().map((probe) =>
      probe.capabilityId === "agent-materialization"
        ? { ...probe, details: "x".repeat(10_000) }
        : probe,
    );
    const sanitized = sanitizeCapabilityProbeResults(raw);
    expect(sanitized).toHaveLength(ALL_CAPABILITY_IDS.length);
    const entry = sanitized.find(
      (probe) => probe.capabilityId === "agent-materialization",
    );
    expect(entry?.probeStatus).toBe("unavailable");
  });

  it("normalizes unsafe (non-printable / control-character) detail data to a single unavailable row", () => {
    const raw = fullValidSet().map((probe) =>
      probe.capabilityId === "primary-agent-selection"
        ? { ...probe, details: "leaked-secret\u0000\nsomething" }
        : probe,
    );
    const sanitized = sanitizeCapabilityProbeResults(raw);
    expect(sanitized).toHaveLength(ALL_CAPABILITY_IDS.length);
    const entry = sanitized.find(
      (probe) => probe.capabilityId === "primary-agent-selection",
    );
    expect(entry?.probeStatus).toBe("unavailable");
  });

  it("handles every anomaly kind at once and still returns exactly 20 fail-closed rows", () => {
    const raw: Record<string, unknown>[] = [
      // missing: config-materialization omitted entirely
      okProbe("agent-materialization"),
      okProbe("primary-agent-selection"),
      okProbe("delegated-specialist-execution"),
      okProbe("prompt-composition"),
      okProbe("tool-policy-mapping"),
      // duplicate
      okProbe("workflow-persistence"),
      okProbe("workflow-persistence"),
      // contradictory
      okProbe("workflow-step-dispatch"),
      { capabilityId: "workflow-step-dispatch", probeStatus: "unavailable" },
      okProbe("plan-file-compatibility"),
      okProbe("command-entrypoints"),
      okProbe("event-logging"),
      // malformed status
      { capabilityId: "token-usage-reporting", probeStatus: "weird-status" },
      okProbe("context-window-monitor"),
      okProbe("idle-continuation"),
      okProbe("compaction-recovery"),
      okProbe("analytics-dashboard"),
      okProbe("static-artifact-generation"),
      okProbe("eval-integration"),
      okProbe("multiple-active-workflows"),
      okProbe("model-thinking-activation"),
      // unknown ID, must be dropped without adding a row
      { capabilityId: "not-a-real-capability", probeStatus: "ok" },
      // unsafe detail on an otherwise well-formed, unique, valid-status probe
      {
        ...okProbe("multiple-active-workflows"),
        details: "\u0007bell-and-\u0000null",
      },
    ];
    const sanitized = sanitizeCapabilityProbeResults(raw);
    expect(sanitized).toHaveLength(ALL_CAPABILITY_IDS.length);
    expect([...sanitized.map((probe) => probe.capabilityId)].sort()).toEqual(
      [...ALL_CAPABILITY_IDS].sort(),
    );
    const byId = new Map(sanitized.map((probe) => [probe.capabilityId, probe]));
    expect(byId.get("config-materialization")?.probeStatus).toBe("unavailable");
    expect(byId.get("workflow-persistence")?.probeStatus).toBe("unavailable");
    expect(byId.get("workflow-step-dispatch")?.probeStatus).toBe("unavailable");
    expect(byId.get("token-usage-reporting")?.probeStatus).toBe("unavailable");
    // multiple-active-workflows now has 2 raw entries (its own + the unsafe-detail one) -> duplicate -> unavailable
    expect(byId.get("multiple-active-workflows")?.probeStatus).toBe(
      "unavailable",
    );
    expect(byId.get("agent-materialization")?.probeStatus).toBe("ok");
  });
});
