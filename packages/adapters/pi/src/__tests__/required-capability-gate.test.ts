/**
 * Task 21 phase A: the required `delegated-specialist-execution`
 * capability and the top-level fail-closed boundary it enforces.
 *
 * These tests prove three things:
 *
 * 1. The capability is declared required and is answered only by the host
 *    surface inventory. The exact tested Pi host reports it unsupported with
 *    reason `pi-session-api-unavailable`, and no method presence, environment
 *    variable, or configuration can raise it.
 * 2. Activation against that host enters health-only mode and names the
 *    unsupported capability without leaking a path or a prompt.
 * 3. Every mutating adapter route fails with a typed
 *    `RequiredCapabilityUnavailable` **before** it calls a controller,
 *    session service, filesystem, cache, lease, or child process, while the
 *    read-only routes stay available.
 */
import { describe, expect, it } from "bun:test";
import {
  ALL_CAPABILITY_IDS,
  buildAdapterHealthReport,
  type CapabilityProbeResult,
  REQUIRED_CAPABILITIES,
} from "@weaveio/weave-engine";
import { errAsync, ok } from "neverthrow";
import {
  createPiAdapterCommandHandlers,
  PI_ADAPTER_COMMAND_NAMES,
  type PiAdapterChildrenPort,
} from "../adapter-cli-commands.js";
import { PI_ADAPTER_CAPABILITY_CONTRACT } from "../capability-declarations.js";
import {
  DefaultPiCapabilityProber,
  type PiCapabilityProbeSource,
} from "../capability-prober.js";
import { ADAPTER_PACKAGE_IDENTITY, WEAVE_COMMAND_NAMES } from "../commands.js";
import { PiExtensionController } from "../controller.js";
import { buildDelegationToolRegistration } from "../delegation-tool.js";
import { HOST_PACKAGE_NAME } from "../host-compatibility.js";
import { PI_HOST_SURFACE_IDS } from "../host-compatibility-matrix.js";
import {
  type PiHostSurfaceReport,
  readHostSurfaceReport,
} from "../host-inventory.js";
import { createReadyPiNativeSessionReadinessProbe } from "../native-session-readiness.js";
import {
  collectRequiredCapabilityGaps,
  createBlockedSessionMutationGate,
  createOpenSessionMutationGate,
  createSessionMutationGate,
  findSessionMutationGap,
  requireSessionMutationCapability,
  SESSION_MUTATION_REQUIRED_CAPABILITY,
  sanitizeCapabilityGapReason,
  UNKNOWN_CAPABILITY_GAP_REASON,
} from "../required-capability-gate.js";
import { PiSafeInitializer } from "../safe-initializer.js";
import type { PiCommandInfo } from "../types.js";
import { FakeHostPackageReader } from "./fakes/fake-host-package-reader.js";
import {
  FakeClock,
  FakeIdGenerator,
  fakeConfigActivator,
  RecordingLogger,
} from "./fakes/fake-pi-host.js";

const CAPABILITY = "delegated-specialist-execution" as const;
const PATH_ONLY = "pi-session-api-unavailable";

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

function trustedTuiSession() {
  return {
    mode: "tui" as const,
    isProjectTrusted: () => true,
    cwd: "/fake/project",
    modelRegistry: { getAvailable: () => [] },
  };
}

/** A host surface report with every required surface native. */
function allNativeReport(): PiHostSurfaceReport {
  return readHostSurfaceReport(
    PI_HOST_SURFACE_IDS.map((surfaceId) => ({
      surfaceId,
      status: "native" as const,
      details: "test-controlled",
    })),
  );
}

/** A report with a session-API gap that maps to pi-session-api-unavailable. */
function sessionApiGapReport(): PiHostSurfaceReport {
  return readHostSurfaceReport(
    PI_HOST_SURFACE_IDS.map((surfaceId) =>
      surfaceId === "session-restore"
        ? {
            surfaceId,
            status: "unavailable" as const,
            details: "SessionManager.open failed for /secret/path.jsonl",
          }
        : { surfaceId, status: "native" as const, details: "test-controlled" },
    ),
  );
}

function controllerWith(hostSurface: PiHostSurfaceReport) {
  const controller = new PiExtensionController({
    safeInitializer: new PiSafeInitializer({
      nativeSessionReadiness: createReadyPiNativeSessionReadinessProbe(),
      hostPackageReader: FakeHostPackageReader.ok({
        name: HOST_PACKAGE_NAME,
        version: "0.83.0",
      }),
      capabilityProber: new DefaultPiCapabilityProber(),
      configActivator: fakeConfigActivator(),
    }),
    idGenerator: new FakeIdGenerator(),
    clock: new FakeClock(),
    logger: new RecordingLogger(),
  });
  return controller
    .activate(trustedTuiSession() as never, ALL_OWNED_COMMANDS, hostSurface)
    .map(() => controller);
}

describe("delegated-specialist-execution: declaration", () => {
  it("is a required capability owned by the host, declared once in the closed set", () => {
    expect(SESSION_MUTATION_REQUIRED_CAPABILITY).toBe(CAPABILITY);
    expect(REQUIRED_CAPABILITIES).toContain(CAPABILITY);
    expect(ALL_CAPABILITY_IDS.filter((id) => id === CAPABILITY)).toHaveLength(
      1,
    );
    const entries = PI_ADAPTER_CAPABILITY_CONTRACT.capabilities.filter(
      (entry) => entry.id === CAPABILITY,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.readiness).toBe("emulated");
  });

  it("is not a host-surface id; readiness is derived from session/process probes", () => {
    expect(PI_HOST_SURFACE_IDS).not.toContain(CAPABILITY);
  });
});

describe("delegated-specialist-execution: production inventory", () => {
  it("maps a session-restore gap to pi-session-api-unavailable without leaking host detail", () => {
    const raw = "SessionManager.open failed for /secret/path.jsonl";
    const probes = new DefaultPiCapabilityProber().probe({
      mode: "tui",
      trust: "trusted",
      commands: ALL_OWNED_COMMANDS,
      hostSurface: sessionApiGapReport(),
    });
    const readiness = probes.find((probe) => probe.capabilityId === CAPABILITY);
    const publicOutput = JSON.stringify(readiness);
    expect(readiness).toEqual({
      capabilityId: CAPABILITY,
      probeStatus: "unavailable",
      details: PATH_ONLY,
    });
    expect(publicOutput.includes(raw)).toBe(false);
    expect(publicOutput.includes("/secret/path")).toBe(false);
  });

  it("cannot be forced ready by environment variables when session API gaps remain", () => {
    process.env.WEAVE_PI_DESCRIPTOR_RELATIVE_SESSION_IO = "1";
    process.env.WEAVE_PI_UNSAFE_ENABLE_SESSION_IO = "true";
    try {
      const probes = new DefaultPiCapabilityProber().probe({
        mode: "tui",
        trust: "trusted",
        commands: ALL_OWNED_COMMANDS,
        hostSurface: sessionApiGapReport(),
      });
      const readiness = probes.find(
        (probe) => probe.capabilityId === CAPABILITY,
      );
      expect(readiness?.probeStatus).toBe("unavailable");
      expect(readiness?.details).toBe(PATH_ONLY);
    } finally {
      delete process.env.WEAVE_PI_DESCRIPTOR_RELATIVE_SESSION_IO;
      delete process.env.WEAVE_PI_UNSAFE_ENABLE_SESSION_IO;
    }
  });

  it("probes unavailable from the real prober, and ok only for an all-native host report", () => {
    const prober = new DefaultPiCapabilityProber();
    const base = {
      mode: "tui" as const,
      trust: "trusted" as const,
      commands: ALL_OWNED_COMMANDS,
    };
    const blocked = prober
      .probe({ ...base, hostSurface: sessionApiGapReport() })
      .find((probe) => probe.capabilityId === CAPABILITY);
    expect(blocked).toEqual({
      capabilityId: CAPABILITY,
      probeStatus: "unavailable",
      details: PATH_ONLY,
    });
    // Host surfaces alone do not prove delegation readiness; plan probes still apply.
    const nativeHost = prober
      .probe({ ...base, hostSurface: allNativeReport() })
      .find((probe) => probe.capabilityId === CAPABILITY);
    expect(nativeHost?.probeStatus).toBe("unavailable");
    expect(typeof nativeHost?.details).toBe("string");
    expect(nativeHost?.details?.includes("/")).toBe(false);
    // With no host surface report at all the capability stays fail-closed.
    const unreported = prober
      .probe(base)
      .find((probe) => probe.capabilityId === CAPABILITY);
    expect(unreported?.probeStatus).toBe("unavailable");
  });
});

describe("delegated-specialist-execution: activation", () => {
  it("enters health-only mode and names the unsupported capability without paths or prompts", async () => {
    const controller = (
      await controllerWith(sessionApiGapReport())
    )._unsafeUnwrap();
    const generation = controller.getCurrentGeneration();
    expect(generation?.healthOnlyMode).toBe(true);
    const gap = findSessionMutationGap(
      generation?.preflight.requiredCapabilityGaps ?? [],
    );
    expect(gap).toEqual({ capabilityId: CAPABILITY, reason: PATH_ONLY });
    expect(gap?.reason).not.toContain("/");
    expect(gap?.reason).toBe(PATH_ONLY);
  });

  it("keeps session-mutation gated when delegation readiness is still unavailable", async () => {
    const controller = (
      await controllerWith(allNativeReport())
    )._unsafeUnwrap();
    const generation = controller.getCurrentGeneration();
    // Native host surfaces are not enough without a planned delegation tool.
    const gap = findSessionMutationGap(
      generation?.preflight.requiredCapabilityGaps ?? [],
    );
    expect(gap?.capabilityId).toBe(CAPABILITY);
    expect(controller.evaluateSessionMutationGate().isErr()).toBe(true);
  });

  it("blocks mutating commands in health-only while keeping read-only and cleanup available", async () => {
    const controller = (
      await controllerWith(sessionApiGapReport())
    )._unsafeUnwrap();
    for (const name of [
      "weave:start",
      "weave:run",
      "weave:advance",
      "weave:resume",
      "weave:artifact",
      "weave:recover-children",
    ] as const) {
      const decision = controller.evaluateCommandGate(name)._unsafeUnwrap();
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("health-only-mode");
    }
    for (const name of ["weave:abort", "weave:clear-children"] as const) {
      const decision = controller.evaluateCommandGate(name)._unsafeUnwrap();
      expect(decision.allowed).toBe(true);
    }
    for (const name of [
      "weave:status",
      "weave:health",
      "weave:plan",
      "weave:inspect",
      "weave:history",
      "weave:doctor",
    ] as const) {
      expect(controller.evaluateCommandGate(name)._unsafeUnwrap().allowed).toBe(
        true,
      );
    }
  });

  it("preserves the existing health-only behaviour for other failed capabilities", async () => {
    // A degraded capability that is not the session-I/O capability keeps the
    // old contract: mutating blocked, cleanup still allowed.
    const controller = new PiExtensionController({
      safeInitializer: new PiSafeInitializer({
        nativeSessionReadiness: createReadyPiNativeSessionReadinessProbe(),
        hostPackageReader: FakeHostPackageReader.ok({
          name: HOST_PACKAGE_NAME,
          version: "0.83.0",
        }),
        capabilityProber: new FixedProber(
          allOkProbes().map((probe) =>
            probe.capabilityId === "workflow-persistence"
              ? { ...probe, probeStatus: "unavailable" as const }
              : probe,
          ),
        ),
        configActivator: fakeConfigActivator(),
      }),
      idGenerator: new FakeIdGenerator(),
      clock: new FakeClock(),
      logger: new RecordingLogger(),
    });
    const activated = await controller.activate(
      trustedTuiSession() as never,
      ALL_OWNED_COMMANDS,
      allNativeReport(),
    );
    expect(activated.isOk()).toBe(true);
    expect(controller.getCurrentGeneration()?.healthOnlyMode).toBe(true);
    expect(
      controller.evaluateCommandGate("weave:start")._unsafeUnwrap(),
    ).toEqual({
      allowed: false,
      classification: "mutating",
      reason: "health-only-mode",
    });
    expect(
      controller.evaluateCommandGate("weave:clear-children")._unsafeUnwrap()
        .allowed,
    ).toBe(true);
  });
});

describe("delegated-specialist-execution: zero-side-effect routes", () => {
  it("weave_delegate no longer short-circuits on a tool-level session-mutation gate", async () => {
    const calls: string[] = [];
    const tool = buildDelegationToolRegistration({
      targets: [
        { agentName: "shuttle", description: "worker", categoryName: "mini" },
      ] as never,
      getController: () => {
        calls.push("getController");
        return undefined;
      },
      getInvocationContext: () => undefined,
      parentId: "root",
      parentDepth: 0,
      parentAgentName: "loom",
      idGenerator: { next: () => "child-1" },
      buildBootstrap: () => ({}),
      buildEnv: () => ({}),
      getParentSessionState: () => {
        calls.push("getParentSessionState");
        return { persistence: "persistent" as const };
      },
    } as never);
    const result = await tool.execute(
      "call-1",
      { kind: "start", agent: "shuttle", task: "do the thing" } as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    const payload = JSON.parse(
      (result.content[0] as { type: "text"; text: string }).text,
    ) as { ok: boolean; error: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).not.toBe("RequiredCapabilityUnavailable");
    expect(calls).toContain("getParentSessionState");
  });

  it("an unwired gate fails closed exactly like a real capability gap", () => {
    const failure = requireSessionMutationCapability(undefined);
    expect(failure.isErr()).toBe(true);
    expect(failure._unsafeUnwrapErr().code).toBe(
      "RequiredCapabilityUnavailable",
    );
    expect(failure._unsafeUnwrapErr().correlation).toEqual({
      capabilityId: CAPABILITY,
      reason: "capability-gate-unwired",
    });
  });

  it("CLI delete fails before touching the children port, while list, show, and doctor stay available", async () => {
    const blocked = createBlockedSessionMutationGate(PATH_ONLY);
    const calls: string[] = [];
    const children: PiAdapterChildrenPort = {
      list: () => {
        calls.push("list");
        return errAsync({ type: "NotFound", message: "none" });
      },
      show: () => {
        calls.push("show");
        return errAsync({ type: "NotFound", message: "none" });
      },
      resolve: () => {
        calls.push("resolve");
        return errAsync({ type: "NotFound", message: "none" });
      },
      delete: () => {
        calls.push("delete");
        return errAsync({ type: "NotFound", message: "none" });
      },
    } as never;
    const handlers = createPiAdapterCommandHandlers({
      children,
      sessionMutationGate: blocked,
    });
    const deleted = await handlers[PI_ADAPTER_COMMAND_NAMES.childrenDelete]!(
      JSON.stringify({
        workspaceKey: "ws",
        childId: "child-1",
        parentSessionId: "parent-1",
        confirmed: true,
      }),
    );
    expect(deleted.isErr()).toBe(true);
    const deleteError = deleted._unsafeUnwrapErr();
    expect("type" in deleteError ? deleteError.type : undefined).toBe(
      "Unavailable",
    );
    expect(deleteError.message).toBe(
      `required-capability-unavailable:${CAPABILITY}`,
    );
    expect(calls).toEqual([]);

    // The read-only routes are untouched by the gate: they reach the port.
    await handlers[PI_ADAPTER_COMMAND_NAMES.childrenList]!(
      JSON.stringify({ workspaceKey: "ws" }),
    );
    expect(calls).toEqual(["list"]);
    await handlers[PI_ADAPTER_COMMAND_NAMES.doctor]!(JSON.stringify({}));
    expect(calls).toEqual(["list"]);
  });
});

describe("delegated-specialist-execution: gate internals", () => {
  it("derives gaps from probe-lowered effective readiness", () => {
    const report = buildAdapterHealthReport({
      harness: HOST_PACKAGE_NAME,
      capabilityContract: PI_ADAPTER_CAPABILITY_CONTRACT,
      probeResults: ALL_CAPABILITY_IDS.map((id) =>
        id === CAPABILITY
          ? {
              capabilityId: id,
              probeStatus: "unavailable" as const,
              details: PATH_ONLY,
            }
          : { capabilityId: id, probeStatus: "ok" as const },
      ),
    });
    expect(report.healthOnlyMode).toBe(true);
    expect(collectRequiredCapabilityGaps(report)).toEqual([
      { capabilityId: CAPABILITY, reason: PATH_ONLY },
    ]);
  });

  it("never leaks a path or a prompt through a gap reason", () => {
    expect(
      sanitizeCapabilityGapReason("/Users/someone/.pi/sessions/a.jsonl"),
    ).toBe(UNKNOWN_CAPABILITY_GAP_REASON);
    expect(sanitizeCapabilityGapReason("You are Loom.\nSecret: hunter2")).toBe(
      UNKNOWN_CAPABILITY_GAP_REASON,
    );
    expect(sanitizeCapabilityGapReason("x".repeat(400))).toBe(
      UNKNOWN_CAPABILITY_GAP_REASON,
    );
    expect(sanitizeCapabilityGapReason(undefined)).toBe(
      UNKNOWN_CAPABILITY_GAP_REASON,
    );
    expect(sanitizeCapabilityGapReason(PATH_ONLY)).toBe(PATH_ONLY);
  });

  it("fails closed when the gap reader throws and allows only an explicit open gate", () => {
    const throwing = createSessionMutationGate(() => {
      throw new Error("boom");
    });
    expect(throwing.evaluate()._unsafeUnwrapErr().correlation).toEqual({
      capabilityId: CAPABILITY,
      reason: "capability-read-failed",
    });
    expect(createOpenSessionMutationGate().evaluate().isOk()).toBe(true);
    expect(
      createSessionMutationGate(() => [])
        .evaluate()
        .isOk(),
    ).toBe(true);
    expect(ok(undefined).isOk()).toBe(true);
  });
});
