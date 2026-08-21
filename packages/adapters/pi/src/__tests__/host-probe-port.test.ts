import { describe, expect, it } from "bun:test";
import {
  buildHostSurfaceGapDiagnostics,
  createDefaultPiHostProbePort,
  DefaultPiHostSurfaceReader,
  isRuntimeModelFallbackEnabled,
  type PiHostProbePort,
  type PiHostSurfaceId,
  readHostSurfaceReport,
  selectsCustomEditorFallback,
} from "../host-inventory.js";
import { fingerprintPiAssistantMessage } from "../model-failover-contract.js";
import { createPiModelFailoverCoordinator } from "../model-failover-coordinator.js";
import type { PiModelInfo } from "../model-resolution.js";
import { RecordingFakePiHost } from "./fakes/fake-pi-host.js";

/**
 * Task 3 remediation coverage. Every Spec 33 §16 session probe is toggled
 * independently through the typed probe port, so one missing capability can
 * never be mistaken for another. Probing must stay side-effect free.
 */

/** Every probe answers `true`: a fully capable host. */
function capablePort(): Record<keyof PiHostProbePort, boolean> {
  return {
    hasSessionCreate: true,
    hasSessionOpen: true,
    hasSessionGetEntries: true,
    hasSessionGetTree: true,
    hasAppendEntry: true,
    hasCustomSessionDirectoryContract: true,
    hasOverlayLifecycle: true,
    hasSupportedVersion: true,
    hasAgentSettledRegistration: true,
    hasTerminalMessageEnd: true,
    hasReplacementReturningContext: true,
    hasMessageStart: true,
    hasModelSelect: true,
    hasCallableSetModel: true,
    hasCallableSendMessage: true,
    hasCallableIdleHelper: true,
    hasCallablePendingMessageHelper: true,
  };
}

function portFrom(answers: Record<keyof PiHostProbePort, boolean>) {
  return (): PiHostProbePort => ({
    hasSessionCreate: () => answers.hasSessionCreate,
    hasSessionOpen: () => answers.hasSessionOpen,
    hasSessionGetEntries: () => answers.hasSessionGetEntries,
    hasSessionGetTree: () => answers.hasSessionGetTree,
    hasAppendEntry: () => answers.hasAppendEntry,
    hasCustomSessionDirectoryContract: () =>
      answers.hasCustomSessionDirectoryContract,
    hasOverlayLifecycle: () => answers.hasOverlayLifecycle,
    hasSupportedVersion: () => answers.hasSupportedVersion,
    hasAgentSettledRegistration: () => answers.hasAgentSettledRegistration,
    hasTerminalMessageEnd: () => answers.hasTerminalMessageEnd,
    hasReplacementReturningContext: () =>
      answers.hasReplacementReturningContext,
    hasMessageStart: () => answers.hasMessageStart,
    hasModelSelect: () => answers.hasModelSelect,
    hasCallableSetModel: () => answers.hasCallableSetModel,
    hasCallableSendMessage: () => answers.hasCallableSendMessage,
    hasCallableIdleHelper: () => answers.hasCallableIdleHelper,
    hasCallablePendingMessageHelper: () =>
      answers.hasCallablePendingMessageHelper,
  });
}

/** Root exports complete enough that only the port decides session surfaces. */
const completeRootExports = {
  VERSION: "0.83.0",
  AssistantMessageComponent: () => undefined,
  ToolExecutionComponent: () => undefined,
  Markdown: () => undefined,
  Image: () => undefined,
  FooterComponent: () => undefined,
  BorderedLoader: () => undefined,
  CustomEditor: () => undefined,
  SessionManager: () => undefined,
};

async function reportFor(answers: Record<keyof PiHostProbePort, boolean>) {
  const reader = new DefaultPiHostSurfaceReader(portFrom(answers));
  const result = await reader.read({
    api: { appendEntry: () => undefined } as never,
    // Complete enough that only the injected port decides session surfaces.
    ui: {
      setStatus: () => undefined,
      setEditorComponent: () => undefined,
      getEditorComponent: () => undefined,
      custom: () => Promise.resolve(undefined),
    } as never,
    rootExports: completeRootExports,
  });
  expect(result.isOk()).toBe(true);
  return readHostSurfaceReport(result._unsafeUnwrap());
}

describe("PiHostProbePort: independent Spec 33 §16 session probes", () => {
  it("reports ready with no gaps when every probe is present", async () => {
    const report = await reportFor(capablePort());
    expect(report.requiredGaps).toEqual([]);
    expect(report.overlayFallbackGaps).toEqual([]);
    expect(report.featureGaps).toEqual([]);
    expect(selectsCustomEditorFallback(report)).toBe(false);
    expect(isRuntimeModelFallbackEnabled(report)).toBe(true);
    expect(buildHostSurfaceGapDiagnostics(report, "0.83.0")).toEqual([]);
  });

  /**
   * Each row turns off exactly one probe and expects exactly one required gap.
   * All four Spec 33 §16 session surfaces are required for delegation, so each
   * independently forces health-only.
   */
  const requiredCases: readonly {
    readonly probe: keyof PiHostProbePort;
    readonly surface: PiHostSurfaceId;
  }[] = [
    { probe: "hasSessionCreate", surface: "rpc-persistent-session" },
    { probe: "hasSessionOpen", surface: "rpc-persistent-session" },
    { probe: "hasAppendEntry", surface: "rpc-append-entry" },
    { probe: "hasSessionGetEntries", surface: "rpc-session-tree-read" },
    { probe: "hasSessionGetTree", surface: "rpc-session-tree-read" },
    {
      probe: "hasCustomSessionDirectoryContract",
      surface: "custom-session-directory",
    },
  ];

  for (const { probe, surface } of requiredCases) {
    it(`enters health-only with all six diagnostic fields when ${probe} is missing`, async () => {
      const report = await reportFor({ ...capablePort(), [probe]: false });

      expect(report.requiredGaps).toEqual([surface]);
      expect(report.overlayFallbackGaps).toEqual([]);
      expect(selectsCustomEditorFallback(report)).toBe(false);

      const diagnostics = buildHostSurfaceGapDiagnostics(report, "0.83.0");
      const healthOnly = diagnostics.filter(
        (diagnostic) => diagnostic.mode === "health-only",
      );
      expect(healthOnly).toHaveLength(1);
      expect(
        diagnostics.some(
          (diagnostic) => diagnostic.mode === "feature-unavailable",
        ),
      ).toBe(false);
      const diagnostic = healthOnly[0];
      // All six strong-debug fields are present and non-empty.
      expect(diagnostic?.capability).toBe(surface);
      expect(diagnostic?.hostVersion).toBe("0.83.0");
      expect(diagnostic?.contract.length).toBeGreaterThan(0);
      expect(diagnostic?.probeResult.startsWith("unavailable:")).toBe(true);
      expect(diagnostic?.mode).toBe("health-only");
      expect(diagnostic?.remediation.length).toBeGreaterThan(0);
    });
  }

  it("names the custom-session-directory contract check explicitly in probeResult", async () => {
    const missing = await reportFor({
      ...capablePort(),
      hasCustomSessionDirectoryContract: false,
    });
    const [diagnostic] = buildHostSurfaceGapDiagnostics(missing, "0.83.0");
    // JavaScript cannot introspect the optional `sessionDir` parameter, so the
    // probe result must say the contract was judged by method presence.
    expect(diagnostic?.probeResult).toContain("session-dir-contract");
    expect(diagnostic?.probeResult).toContain("method");

    const present = await reportFor(capablePort());
    expect(
      present.probes.find(
        (probe) => probe.surfaceId === "custom-session-directory",
      )?.details,
    ).toContain("session-dir-contract-verified");
  });

  it("selects the custom-editor fallback for a missing overlay lifecycle, never health-only", async () => {
    const report = await reportFor({
      ...capablePort(),
      hasOverlayLifecycle: false,
    });

    expect(report.requiredGaps).toEqual([]);
    expect(report.overlayFallbackGaps).toEqual(["child-overlay-lifecycle"]);
    expect(selectsCustomEditorFallback(report)).toBe(true);

    const [diagnostic] = buildHostSurfaceGapDiagnostics(report, "0.83.0");
    expect(diagnostic?.capability).toBe("child-overlay-lifecycle");
    expect(diagnostic?.mode).toBe("custom-editor-fallback");
    expect(diagnostic?.remediation).toContain("custom-editor");
  });

  it("keeps a missing session read out of the overlay-only bucket", async () => {
    const report = await reportFor({
      ...capablePort(),
      hasSessionGetTree: false,
    });
    // Regression guard: `rpc-session-tree-read` must never be overlay-only.
    expect(report.overlayFallbackGaps).not.toContain("rpc-session-tree-read");
    expect(report.requiredGaps).toContain("rpc-session-tree-read");
  });

  const optionalFallbackProbes: readonly (keyof PiHostProbePort)[] = [
    "hasAgentSettledRegistration",
    "hasTerminalMessageEnd",
    "hasReplacementReturningContext",
    "hasMessageStart",
    "hasModelSelect",
    "hasCallableSetModel",
    "hasCallableSendMessage",
    "hasCallableIdleHelper",
    "hasCallablePendingMessageHelper",
  ];

  for (const probe of optionalFallbackProbes) {
    it(`keeps ready legacy settlement when ${probe} is missing`, async () => {
      const report = await reportFor({ ...capablePort(), [probe]: false });
      expect(report.requiredGaps).toEqual([]);
      expect(report.overlayFallbackGaps).toEqual([]);
      expect(report.featureGaps).toEqual(["runtime-model-fallback"]);
      expect(selectsCustomEditorFallback(report)).toBe(false);
      expect(isRuntimeModelFallbackEnabled(report)).toBe(false);
      const diagnostics = buildHostSurfaceGapDiagnostics(report, "0.83.0");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.capability).toBe("runtime-model-fallback");
      expect(diagnostics[0]?.mode).toBe("feature-unavailable");
      expect(diagnostics[0]?.probeResult.startsWith("unavailable:")).toBe(true);
      expect(diagnostics[0]?.remediation).toContain(
        "legacy visible/child settlement",
      );
    });
  }
});

describe("createDefaultPiHostProbePort", () => {
  /** Records any invocation so the test can prove probing calls nothing. */
  function trackedSessionManager(calls: string[]) {
    function SessionManagerStub() {
      calls.push("construct");
      return undefined;
    }
    const stub = SessionManagerStub as unknown as Record<string, unknown>;
    stub.create = () => calls.push("create");
    stub.open = () => calls.push("open");
    const proto = SessionManagerStub.prototype as Record<string, unknown>;
    proto.getEntries = () => calls.push("getEntries");
    proto.getTree = () => calls.push("getTree");
    proto.getSessionDir = () => calls.push("getSessionDir");
    proto.usesDefaultSessionDir = () => calls.push("usesDefaultSessionDir");
    return SessionManagerStub;
  }

  it("reads concrete public surfaces without creating or opening a session", () => {
    const calls: string[] = [];
    const port = createDefaultPiHostProbePort({
      api: { appendEntry: () => calls.push("appendEntry") } as never,
      ui: {
        custom: () => calls.push("custom"),
        setEditorComponent: () => calls.push("setEditorComponent"),
        getEditorComponent: () => calls.push("getEditorComponent"),
      } as never,
      rootExports: {
        VERSION: "0.83.0",
        SessionManager: trackedSessionManager(calls),
      },
    });

    expect(port.hasSessionCreate()).toBe(true);
    expect(port.hasSessionOpen()).toBe(true);
    expect(port.hasSessionGetEntries()).toBe(true);
    expect(port.hasSessionGetTree()).toBe(true);
    expect(port.hasAppendEntry()).toBe(true);
    expect(port.hasCustomSessionDirectoryContract()).toBe(true);
    expect(port.hasOverlayLifecycle()).toBe(true);
    expect(port.hasSupportedVersion()).toBe(true);
    expect(port.hasAgentSettledRegistration()).toBe(false);
    expect(port.hasCallableSetModel()).toBe(false);
    expect(port.hasCallableSendMessage()).toBe(false);
    expect(port.hasCallableIdleHelper()).toBe(false);
    expect(port.hasCallablePendingMessageHelper()).toBe(false);
    // The whole point: presence checks only.
    expect(calls).toEqual([]);
  });

  it("answers false for each surface the host does not expose", () => {
    const port = createDefaultPiHostProbePort({
      api: {} as never,
      ui: {} as never,
      rootExports: { VERSION: "0.83.0" },
    });
    expect(port.hasSessionCreate()).toBe(false);
    expect(port.hasSessionOpen()).toBe(false);
    expect(port.hasSessionGetEntries()).toBe(false);
    expect(port.hasSessionGetTree()).toBe(false);
    expect(port.hasAppendEntry()).toBe(false);
    expect(port.hasCustomSessionDirectoryContract()).toBe(false);
    expect(port.hasOverlayLifecycle()).toBe(false);
    expect(port.hasAgentSettledRegistration()).toBe(false);
    expect(port.hasTerminalMessageEnd()).toBe(false);
    expect(port.hasReplacementReturningContext()).toBe(false);
    expect(port.hasMessageStart()).toBe(false);
    expect(port.hasModelSelect()).toBe(false);
    expect(port.hasCallableSetModel()).toBe(false);
    expect(port.hasCallableSendMessage()).toBe(false);
    expect(port.hasCallableIdleHelper()).toBe(false);
    expect(port.hasCallablePendingMessageHelper()).toBe(false);
  });

  it("fails the session-directory contract when the host version is unsupported", () => {
    const port = createDefaultPiHostProbePort({
      api: { appendEntry: () => undefined } as never,
      ui: {} as never,
      rootExports: {
        VERSION: "0.80.0",
        SessionManager: trackedSessionManager([]),
      },
    });
    // Method presence alone is not enough: the version contract also carries it.
    expect(port.hasSessionCreate()).toBe(true);
    expect(port.hasSupportedVersion()).toBe(false);
    expect(port.hasCustomSessionDirectoryContract()).toBe(false);
  });

  it("does not mistake a bare SessionManager export for session capabilities", () => {
    const port = createDefaultPiHostProbePort({
      api: {} as never,
      ui: {} as never,
      rootExports: { VERSION: "0.83.0", SessionManager: () => undefined },
    });
    // The old defect: "SessionManager exists, therefore three capabilities exist".
    expect(port.hasSessionCreate()).toBe(false);
    expect(port.hasSessionOpen()).toBe(false);
    expect(port.hasSessionGetEntries()).toBe(false);
    expect(port.hasSessionGetTree()).toBe(false);
    expect(port.hasCustomSessionDirectoryContract()).toBe(false);
  });
});

describe("runtime-model-fallback public surfaces on a fake host", () => {
  const origin: PiModelInfo = {
    provider: "origin",
    id: "first",
    name: "First",
  };
  const fallback: PiModelInfo = {
    provider: "fallback",
    id: "second",
    name: "Second",
  };
  const failedAssistant = {
    role: "assistant",
    id: "failed-assistant",
    stopReason: "error",
    content: [{ type: "text", text: "bounded partial output" }],
  };

  it("proves presence on a complete fake without invoking host helpers", () => {
    const host = new RecordingFakePiHost({
      currentModel: origin,
      availableModels: [origin, fallback],
    });
    const session = host.createSessionContext();
    const port = createDefaultPiHostProbePort({
      api: host.api,
      ui: session.ui,
      session,
      rootExports: { VERSION: "0.84.2" },
    });

    expect(port.hasAgentSettledRegistration()).toBe(true);
    expect(port.hasTerminalMessageEnd()).toBe(true);
    expect(port.hasReplacementReturningContext()).toBe(true);
    expect(port.hasMessageStart()).toBe(true);
    expect(port.hasModelSelect()).toBe(true);
    expect(port.hasCallableSetModel()).toBe(true);
    expect(port.hasCallableSendMessage()).toBe(true);
    expect(port.hasCallableIdleHelper()).toBe(true);
    expect(port.hasCallablePendingMessageHelper()).toBe(true);
    expect(host.setModelCalls).toEqual([]);
    expect(host.sendMessageCalls).toEqual([]);
  });

  it("does not infer the feature from Pi 0.84.2 or a stale hook flag", () => {
    const port = createDefaultPiHostProbePort({
      api: { features: { agent_recovery_exhausted: true } } as never,
      ui: {} as never,
      rootExports: { VERSION: "0.84.2" },
    });
    expect(port.hasSupportedVersion()).toBe(true);
    expect(port.hasAgentSettledRegistration()).toBe(false);
    expect(port.hasCallableSetModel()).toBe(false);
    expect(port.hasCallableSendMessage()).toBe(false);
    expect(port.hasCallableIdleHelper()).toBe(false);
    expect(port.hasCallablePendingMessageHelper()).toBe(false);
  });

  it("enables the coordinator on a complete fake but still fails malformed event order", async () => {
    const host = new RecordingFakePiHost({
      currentModel: origin,
      availableModels: [origin, fallback],
    });
    const session = host.createSessionContext();
    const rows = await new DefaultPiHostSurfaceReader().read({
      api: host.api,
      ui: session.ui,
      session,
      rootExports: { VERSION: "0.84.2" },
    });
    const report = readHostSurfaceReport(rows._unsafeUnwrap());
    expect(isRuntimeModelFallbackEnabled(report)).toBe(true);

    const fingerprint = fingerprintPiAssistantMessage(failedAssistant);
    expect(fingerprint.isOk()).toBe(true);
    const coordinator = createPiModelFailoverCoordinator({
      host: host.api,
      context: session,
      generationId: "generation-1",
      nativeSessionId: "session-1",
      activationId: "activation-1",
      currentModel: origin,
      candidates: [origin, fallback],
    });
    expect(
      (
        await coordinator.handleFailure({
          failureClass: "provider_unavailable",
          failedModel: origin,
          fingerprint: fingerprint._unsafeUnwrap(),
        })
      ).isOk(),
    ).toBe(true);
    expect(coordinator.onModelSelect({ model: fallback })._unsafeUnwrap()).toBe(
      true,
    );
    expect(coordinator.state).toBe("awaiting-marker-proof");
    expect(
      coordinator.onMessageStart({ type: "turn_start" })._unsafeUnwrap(),
    ).toBe(false);
    expect(coordinator.state).toBe("awaiting-marker-proof");
    const marker = host.sendMessageCalls.at(-1)?.message;
    expect(marker).toBeDefined();
    expect(
      coordinator
        .onMessageStart({ type: "message_start", message: marker })
        ._unsafeUnwrap(),
    ).toBe(true);
    expect(coordinator.state).toBe("awaiting-context-repair");
    expect(
      coordinator.onContext([{ role: "user", content: "task" }]).isErr(),
    ).toBe(true);
    expect(coordinator.state).not.toBe("recovering");
  });
});
