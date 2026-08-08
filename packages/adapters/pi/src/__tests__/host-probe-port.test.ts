import { describe, expect, it } from "bun:test";
import {
  buildHostSurfaceGapDiagnostics,
  createDefaultPiHostProbePort,
  DefaultPiHostSurfaceReader,
  type PiHostProbePort,
  type PiHostSurfaceId,
  readHostSurfaceReport,
  selectsCustomEditorFallback,
} from "../host-inventory.js";

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
    // A hypothetical descriptor-safe host. The production probe port always
    // answers `false` here; only this test double may answer `true`, so the
    // deep-module coverage below still exercises a fully capable host.
    hasDescriptorRelativeSessionIo: true,
    hasSupportedVersion: true,
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
    hasDescriptorRelativeSessionIo: () =>
      answers.hasDescriptorRelativeSessionIo,
    hasSupportedVersion: () => answers.hasSupportedVersion,
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
    expect(selectsCustomEditorFallback(report)).toBe(false);
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
      expect(diagnostics).toHaveLength(1);
      const diagnostic = diagnostics[0];
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
