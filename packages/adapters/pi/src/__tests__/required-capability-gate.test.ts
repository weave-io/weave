/**
 * The required `delegated-specialist-execution` capability and the top-level
 * fail-closed boundary it enforces.
 *
 * These tests prove three things:
 *
 * 1. The capability is declared required and is answered by the real host
 *    surface inventory. A host that cannot prove Pi's session API reports it
 *    unavailable with the closed reason `pi-session-api-unavailable`, and no
 *    environment variable or configuration can raise it.
 * 2. Activation against that host enters health-only mode and names the
 *    unavailable capability without leaking a path or a prompt.
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
import {
  buildDelegationToolRegistration,
  buildRelayedDelegationToolRegistration,
} from "../delegation-tool.js";
import { HOST_PACKAGE_NAME } from "../host-compatibility.js";
import { PI_HOST_SURFACE_IDS } from "../host-compatibility-matrix.js";
import {
  createDefaultPiHostProbePort,
  DefaultPiHostSurfaceReader,
  type PiHostSurfaceReport,
  readHostSurfaceReport,
} from "../host-inventory.js";
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
/** The required host surface that carries Pi's native session API. */
const SESSION_SURFACE = "session-restore" as const;

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

/** A host surface report where every required surface is proven. */
function descriptorSafeReport(): PiHostSurfaceReport {
  return readHostSurfaceReport(
    PI_HOST_SURFACE_IDS.map((surfaceId) => ({
      surfaceId,
      status: "native" as const,
      details: "test-controlled",
    })),
  );
}

/** The report a host without a usable Pi session API produces. */
function pathOnlyReport(): PiHostSurfaceReport {
  return readHostSurfaceReport(
    PI_HOST_SURFACE_IDS.map((surfaceId) =>
      surfaceId === SESSION_SURFACE
        ? {
            surfaceId,
            status: "unavailable" as const,
            details: "required-surface-missing",
          }
        : { surfaceId, status: "native" as const, details: "test-controlled" },
    ),
  );
}

/** A fully capable host namespace: restore, custom session dir, every RPC. */
function completeHostInput() {
  const sessionManager = function SessionManager() {} as unknown as {
    create: () => void;
    open: () => void;
    prototype: Record<string, unknown>;
  };
  sessionManager.create = () => undefined;
  sessionManager.open = () => undefined;
  sessionManager.prototype = {
    getEntries: () => undefined,
    getTree: () => undefined,
    getSessionDir: () => undefined,
    usesDefaultSessionDir: () => undefined,
  };
  return {
    api: {
      appendEntry: () => undefined,
      sendUserMessage: () => undefined,
    } as never,
    ui: {
      custom: () => undefined,
      setEditorComponent: () => undefined,
      getEditorComponent: () => undefined,
      setStatus: () => undefined,
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
      SessionManager: sessionManager,
    },
  };
}

function controllerWith(hostSurface: PiHostSurfaceReport) {
  const controller = new PiExtensionController({
    safeInitializer: new PiSafeInitializer({
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
  it("is a required capability declared once in the closed set", () => {
    expect(SESSION_MUTATION_REQUIRED_CAPABILITY).toBe(CAPABILITY);
    expect(REQUIRED_CAPABILITIES).toContain(CAPABILITY);
    expect(ALL_CAPABILITY_IDS.filter((id) => id === CAPABILITY)).toHaveLength(
      1,
    );
    const entries = PI_ADAPTER_CAPABILITY_CONTRACT.capabilities.filter(
      (entry) => entry.id === CAPABILITY,
    );
    expect(entries).toHaveLength(1);
  });

  it("retires the obsolete descriptor capability from every closed set", () => {
    const obsolete = "descriptor-relative-native-session-io";
    expect([...(ALL_CAPABILITY_IDS as readonly string[])]).not.toContain(
      obsolete,
    );
    expect([...(PI_HOST_SURFACE_IDS as readonly string[])]).not.toContain(
      obsolete,
    );
  });
});

describe("delegated-specialist-execution: production inventory", () => {
  it("proves every required surface on a complete Pi host namespace", async () => {
    const result = await new DefaultPiHostSurfaceReader().read(
      completeHostInput(),
    );
    expect(result.isOk()).toBe(true);
    const report = readHostSurfaceReport(result._unsafeUnwrap());
    expect(report.requiredGaps).toEqual([]);
  });

  it("cannot be raised by any environment variable or configuration", () => {
    const port = createDefaultPiHostProbePort({
      ...completeHostInput(),
      rootExports: { VERSION: "0.83.0" },
    });
    process.env.WEAVE_PI_DESCRIPTOR_RELATIVE_SESSION_IO = "1";
    process.env.WEAVE_PI_UNSAFE_ENABLE_SESSION_IO = "true";
    try {
      expect(port.hasSessionCreate()).toBe(false);
      expect(port.hasSessionOpen()).toBe(false);
      expect(port.hasCustomSessionDirectoryContract()).toBe(false);
    } finally {
      delete process.env.WEAVE_PI_DESCRIPTOR_RELATIVE_SESSION_IO;
      delete process.env.WEAVE_PI_UNSAFE_ENABLE_SESSION_IO;
    }
  });

  it("probes unavailable with one closed path-free reason, and ok only for a proven host", () => {
    const prober = new DefaultPiCapabilityProber();
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
    };
    const blocked = prober
      .probe({ ...base, hostSurface: pathOnlyReport() })
      .find((probe) => probe.capabilityId === CAPABILITY);
    expect(blocked).toEqual({
      capabilityId: CAPABILITY,
      probeStatus: "unavailable",
      details: PATH_ONLY,
    });
    const safe = prober
      .probe({ ...base, hostSurface: descriptorSafeReport() })
      .find((probe) => probe.capabilityId === CAPABILITY);
    expect(safe?.probeStatus).toBe("ok");
    // Without a sealed candidate plan the capability stays fail-closed.
    const unplanned = prober
      .probe({
        mode: "tui" as const,
        trust: "trusted" as const,
        commands: ALL_OWNED_COMMANDS,
      })
      .find((probe) => probe.capabilityId === CAPABILITY);
    expect(unplanned?.probeStatus).toBe("unavailable");
  });
});

describe("delegated-specialist-execution: activation", () => {
  it("enters health-only mode and names the unsupported capability without paths or prompts", async () => {
    const controller = (await controllerWith(pathOnlyReport()))._unsafeUnwrap();
    const generation = controller.getCurrentGeneration();
    expect(generation?.healthOnlyMode).toBe(true);
    const gap = findSessionMutationGap(
      generation?.preflight.requiredCapabilityGaps ?? [],
    );
    expect(gap).toEqual({ capabilityId: CAPABILITY, reason: PATH_ONLY });
    expect(gap?.reason).not.toContain("/");
    const diagnostic = generation?.preflight.hostSurfaceGapDiagnostics.find(
      (entry) => entry.capability === SESSION_SURFACE,
    );
    expect(diagnostic?.mode).toBe("health-only");
    expect(diagnostic?.probeResult).toBe(
      "unavailable:required-surface-missing",
    );
  });

  it("stays ready when every required probe passes, so deep-module coverage survives", async () => {
    const controller = new PiExtensionController({
      safeInitializer: new PiSafeInitializer({
        hostPackageReader: FakeHostPackageReader.ok({
          name: HOST_PACKAGE_NAME,
          version: "0.83.0",
        }),
        capabilityProber: new FixedProber(allOkProbes()),
        configActivator: fakeConfigActivator(),
      }),
      idGenerator: new FakeIdGenerator(),
      clock: new FakeClock(),
      logger: new RecordingLogger(),
    });
    const activated = await controller.activate(
      trustedTuiSession() as never,
      ALL_OWNED_COMMANDS,
      descriptorSafeReport(),
    );
    expect(activated.isOk()).toBe(true);
    const generation = controller.getCurrentGeneration();
    expect(
      findSessionMutationGap(
        generation?.preflight.requiredCapabilityGaps ?? [],
      ),
    ).toBeUndefined();
    expect(controller.evaluateSessionMutationGate().isOk()).toBe(true);
  });

  it("blocks every mutating and cleanup command while keeping read-only commands available", async () => {
    const controller = (await controllerWith(pathOnlyReport()))._unsafeUnwrap();
    for (const name of [
      "weave:start",
      "weave:run",
      "weave:advance",
      "weave:resume",
      "weave:artifact",
      "weave:recover-children",
      "weave:abort",
      "weave:clear-children",
    ] as const) {
      const decision = controller.evaluateCommandGate(name)._unsafeUnwrap();
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe(
        `required-capability-unavailable:${CAPABILITY}`,
      );
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
      descriptorSafeReport(),
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
  const blocked = createBlockedSessionMutationGate(PATH_ONLY);

  function spyingDelegationDeps(calls: string[]) {
    return {
      targets: [
        { agentName: "shuttle", description: "worker", categoryName: "mini" },
      ] as never,
      sessionMutationGate: blocked,
      getController: () => {
        calls.push("getController");
        return undefined;
      },
      getInvocationContext: () => {
        calls.push("getInvocationContext");
        return undefined;
      },
      parentId: "root",
      parentDepth: 0,
      parentAgentName: "loom",
      idGenerator: {
        next: () => {
          calls.push("idGenerator");
          return "child-1";
        },
      },
      buildBootstrap: () => {
        calls.push("buildBootstrap");
        return {};
      },
      buildEnv: () => {
        calls.push("buildEnv");
        return {};
      },
      getParentSessionState: () => {
        calls.push("getParentSessionState");
        return { persistence: "persistent" as const };
      },
    };
  }

  async function runDelegate(params: unknown, calls: string[]) {
    const tool = buildDelegationToolRegistration(
      spyingDelegationDeps(calls) as never,
    );
    const result = await tool.execute(
      "call-1",
      params as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    return JSON.parse(
      (result.content[0] as { type: "text"; text: string }).text,
    ) as { ok: boolean; error: string };
  }

  it("weave_delegate start returns RequiredCapabilityUnavailable with no downstream call", async () => {
    const calls: string[] = [];
    const payload = await runDelegate(
      { kind: "start", agent: "shuttle", task: "do the thing" },
      calls,
    );
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("RequiredCapabilityUnavailable");
    expect(calls).toEqual([]);
  });

  it("weave_delegate retry, continue, steering, and follow-up all fail before any controller call", async () => {
    for (const params of [
      { kind: "retry", threadId: "thread-1" },
      { kind: "continue", threadId: "thread-1", instruction: "keep going" },
      { kind: "steer", threadId: "thread-1", instruction: "change course" },
      { kind: "follow_up", threadId: "thread-1", instruction: "one more" },
    ]) {
      const calls: string[] = [];
      const payload = await runDelegate(params, calls);
      expect(payload.ok).toBe(false);
      expect(payload.error).toBe("RequiredCapabilityUnavailable");
      expect(calls).toEqual([]);
    }
  });

  it("a relayed child weave_delegate fails before reaching its runtime", async () => {
    const calls: string[] = [];
    const tool = buildRelayedDelegationToolRegistration({
      targets: [
        { agentName: "shuttle", description: "worker", categoryName: "mini" },
      ] as never,
      sessionMutationGate: blocked,
      getRuntime: () => {
        calls.push("getRuntime");
        return undefined;
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
    expect(payload.error).toBe("RequiredCapabilityUnavailable");
    expect(calls).toEqual([]);
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

describe("descriptor-relative-native-session-io: gate internals", () => {
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
