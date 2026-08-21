import { describe, expect, it } from "bun:test";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import {
  LIVE_PROOF_CLEANUP_STATUSES,
  LIVE_PROOF_DIAGNOSTIC_STATUSES,
  LIVE_PROOF_FAILURE_CODES,
  LIVE_PROOF_IDENTITY_CURRENT_RESULTS,
  LIVE_PROOF_IDENTITY_FRESH_RESULTS,
  LIVE_PROOF_ISOLATION_STATUSES,
  LIVE_PROOF_LANE_NAMES,
  LIVE_PROOF_LANE_STATUSES,
  LIVE_PROOF_REGISTRY_STATUSES,
  LIVE_PROOF_REPORT_BOUNDS,
  LIVE_PROOF_REPORT_KEYS,
  LIVE_PROOF_SETTLEMENT_STATUSES,
  type LiveProofArgs,
  type LiveProofFailureCode,
  type LiveProofIdentityCurrentResult,
  type LiveProofLaneName,
  type LiveProofReport,
} from "../child-stream-live-proof-contract.js";
import {
  LIVE_PROOF_DETERMINISTIC_CHILD_REQUEST,
  type LiveProofChildHandle,
  type LiveProofCurrentIdentityObservation,
  type LiveProofDiagnosticsObservation,
  type LiveProofFreshParentLaunch,
  type LiveProofInspectorHandle,
  type LiveProofIsolationObservation,
  type LiveProofLaneSignal,
  type LiveProofParentHandle,
  type LiveProofPort,
  type LiveProofRegistryObservation,
  type LiveProofResourceContext,
  type LiveProofSettlementObservation,
  runLiveProof,
} from "../child-stream-live-proof-runner.js";

const args: LiveProofArgs = {
  command: "live",
  pi: "/usr/local/bin/pi",
  requireFreshParent: true,
  requireCurrentBuild: true,
  proofLanes: [...LIVE_PROOF_LANE_NAMES],
  contentFreeReport: "proof.json",
  noScreenCapture: true,
};

const parent = { kind: "parent", childText: "not returned" };
const child = { kind: "child", childId: "not returned" };
const inspector = { kind: "inspector", text: "not returned" };

function signal(
  status: "pass" | "fail" | "blocked" = "pass",
): LiveProofLaneSignal {
  return {
    status,
    prefixObserved: status === "pass",
    nonBlankObserved: status === "pass",
    growthObserved: status === "pass",
    observationCount: 2,
    events: 2,
    dropped: 0,
    repaints: 2,
  };
}

function currentIdentity(
  currentBuild: LiveProofIdentityCurrentResult = "current",
): LiveProofCurrentIdentityObservation {
  return {
    currentBuild,
    runtimeLoaded: true,
    artifactComplete: true,
  };
}

function freshParent(
  freshParentState: "fresh" | "stale" | "unverifiable" = "fresh",
): LiveProofFreshParentLaunch {
  return {
    parent,
    freshParent: freshParentState,
    runtimeLoaded: true,
    artifactComplete: true,
  };
}

const settled: LiveProofSettlementObservation = {
  status: "settled",
  childCount: 1,
  settlementCount: 1,
  toolTerminalCount: 1,
  events: 1,
  dropped: 0,
  repaints: 1,
};

const isolated: LiveProofIsolationObservation = {
  parentIsolated: true,
  cardIsolated: true,
  modelIsolated: true,
  durableIsolated: true,
  prohibitedSinkDetected: false,
};

const emptyRegistry: LiveProofRegistryObservation = {
  cardEntries: 0,
  cardBytes: 0,
  inspectorEntries: 0,
  inspectorBytes: 0,
  registryEntries: 0,
  registryBytes: 0,
};

const cleanDiagnostics: LiveProofDiagnosticsObservation = {
  status: "clean",
  count: 0,
  overflow: false,
};

type Stage =
  | "identity"
  | "launch"
  | "delegate"
  | "inspector"
  | "parent-lane"
  | "inspector-reasoning"
  | "tool-details"
  | "assistant-reply"
  | "settlement"
  | "isolation"
  | "registry"
  | "diagnostics"
  | "cleanup-runtime"
  | "cleanup-process"
  | "cleanup-temp"
  | "cleanup-pane";

interface FakeOptions {
  readonly fail?: Stage;
  readonly identity?: LiveProofCurrentIdentityObservation;
  readonly launch?: LiveProofFreshParentLaunch;
  readonly lane?: Partial<Record<LiveProofLaneName, LiveProofLaneSignal>>;
  readonly settlement?: LiveProofSettlementObservation;
  readonly isolation?: LiveProofIsolationObservation;
  readonly registry?: LiveProofRegistryObservation;
  readonly diagnostics?: LiveProofDiagnosticsObservation;
}

class FakeLiveProofPort implements LiveProofPort {
  readonly calls: Record<string, number> = {};
  private readonly options: FakeOptions;

  constructor(options: FakeOptions = {}) {
    this.options = options;
  }

  private called(stage: Stage): void {
    this.calls[stage] = (this.calls[stage] ?? 0) + 1;
  }

  private result<T>(stage: Stage, value: T) {
    this.called(stage);
    if (this.options.fail === stage) {
      return errAsync({ code: "spawn-failed" as const });
    }
    return okAsync(value);
  }

  readCurrentIdentity() {
    return this.result("identity", this.options.identity ?? currentIdentity());
  }

  launchFreshParent() {
    return this.result("launch", this.options.launch ?? freshParent());
  }

  delegateDeterministicChild(
    _parent: LiveProofParentHandle,
    request: typeof LIVE_PROOF_DETERMINISTIC_CHILD_REQUEST,
  ) {
    expect(request).toEqual(LIVE_PROOF_DETERMINISTIC_CHILD_REQUEST);
    return this.result("delegate", child as LiveProofChildHandle);
  }

  selectLiveInspector(
    _parent: LiveProofParentHandle,
    _child: LiveProofChildHandle,
  ) {
    return this.result("inspector", inspector as LiveProofInspectorHandle);
  }

  lane(
    name: LiveProofLaneName,
    stage: Stage,
  ): ReturnType<LiveProofPort["observeParentRawReasoning"]> {
    this.called(stage);
    if (this.options.fail === stage) {
      return errAsync({ code: "lane-failed" as const });
    }
    return okAsync(this.options.lane?.[name] ?? signal());
  }

  observeParentRawReasoning() {
    return this.lane("parent-raw-reasoning-live", "parent-lane");
  }

  observeInspectorRawReasoning() {
    return this.lane("inspector-raw-reasoning-live", "inspector-reasoning");
  }

  observeInspectorToolDetails() {
    return this.lane("inspector-tool-details", "tool-details");
  }

  observeInspectorAssistantReply() {
    return this.lane("inspector-assistant-reply-live", "assistant-reply");
  }

  readSettlement() {
    return this.result("settlement", this.options.settlement ?? settled);
  }

  readIsolation() {
    return this.result("isolation", this.options.isolation ?? isolated);
  }

  readRegistry() {
    return this.result("registry", this.options.registry ?? emptyRegistry);
  }

  readDiagnostics() {
    return this.result(
      "diagnostics",
      this.options.diagnostics ?? cleanDiagnostics,
    );
  }

  cleanup(stage: Stage, _context: LiveProofResourceContext) {
    this.called(stage);
    if (this.options.fail === stage) {
      return errAsync({ code: "cleanup-failed" as const });
    }
    return okAsync(undefined);
  }

  cleanupRuntime(context: LiveProofResourceContext) {
    return this.cleanup("cleanup-runtime", context);
  }

  cleanupProcess(context: LiveProofResourceContext) {
    return this.cleanup("cleanup-process", context);
  }

  cleanupTemp(context: LiveProofResourceContext) {
    return this.cleanup("cleanup-temp", context);
  }

  cleanupPane(context: LiveProofResourceContext) {
    return this.cleanup("cleanup-pane", context);
  }
}

function run(
  port: LiveProofPort = new FakeLiveProofPort(),
): Promise<LiveProofReport> {
  return runLiveProof({ args, port }).match(
    (report) => report,
    (_failure: never) => {
      throw new Error("the report runner must not return an error");
    },
  );
}

function hasFailure(
  report: LiveProofReport,
  code: LiveProofFailureCode,
): boolean {
  return report.failures.includes(code);
}

/** Compose a port from the fake plus explicit overrides for red controls. */
function portWith(
  base: FakeLiveProofPort,
  overrides: Partial<LiveProofPort>,
): LiveProofPort {
  const bound: LiveProofPort = {
    readCurrentIdentity: () => base.readCurrentIdentity(),
    launchFreshParent: () => base.launchFreshParent(),
    delegateDeterministicChild: (parentHandle, request) =>
      base.delegateDeterministicChild(parentHandle, request),
    selectLiveInspector: (parentHandle, childHandle) =>
      base.selectLiveInspector(parentHandle, childHandle),
    observeParentRawReasoning: () => base.observeParentRawReasoning(),
    observeInspectorRawReasoning: () => base.observeInspectorRawReasoning(),
    observeInspectorToolDetails: () => base.observeInspectorToolDetails(),
    observeInspectorAssistantReply: () => base.observeInspectorAssistantReply(),
    readSettlement: () => base.readSettlement(),
    readIsolation: () => base.readIsolation(),
    readRegistry: () => base.readRegistry(),
    readDiagnostics: () => base.readDiagnostics(),
    cleanupRuntime: (context) => base.cleanupRuntime(context),
    cleanupProcess: (context) => base.cleanupProcess(context),
    cleanupTemp: (context) => base.cleanupTemp(context),
    cleanupPane: (context) => base.cleanupPane(context),
  };
  return { ...bound, ...overrides };
}

const SECRET = "SENSITIVE-CHILD-TEXT";

/**
 * Every string the report may contain. A report string outside this set is
 * either host text, a path, an id, or an exception message.
 */
const ALLOWED_REPORT_STRINGS: ReadonlySet<string> = new Set<string>([
  ...LIVE_PROOF_REPORT_KEYS,
  ...LIVE_PROOF_LANE_NAMES,
  ...LIVE_PROOF_FAILURE_CODES,
  ...LIVE_PROOF_IDENTITY_CURRENT_RESULTS,
  ...LIVE_PROOF_IDENTITY_FRESH_RESULTS,
  ...LIVE_PROOF_LANE_STATUSES,
  ...LIVE_PROOF_ISOLATION_STATUSES,
  ...LIVE_PROOF_SETTLEMENT_STATUSES,
  ...LIVE_PROOF_REGISTRY_STATUSES,
  ...LIVE_PROOF_DIAGNOSTIC_STATUSES,
  ...LIVE_PROOF_CLEANUP_STATUSES,
  "currentBuild",
  "freshParent",
  "name",
  "status",
  "observationCount",
  "reason",
  "events",
  "dropped",
  "repaints",
  "diagnostics",
  "cleanupAttempts",
  "maxDepth",
  "maxKeys",
  "maxArrayLength",
  "maxStringBytes",
  "maxTotalBytes",
]);

function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, into);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      into.push(key);
      collectStrings(entry, into);
    }
  }
}

function unexpectedStrings(report: LiveProofReport): readonly string[] {
  const found: string[] = [];
  collectStrings(report, found);
  return found.filter((value) => !ALLOWED_REPORT_STRINGS.has(value));
}

describe("injectable live proof runner", () => {
  it("passes with one child, one inspector, four lanes, and complete cleanup", async () => {
    const port = new FakeLiveProofPort();
    const report = await run(port);

    expect(report.identity).toEqual({
      currentBuild: "current",
      freshParent: "fresh",
    });
    expect(report.lanes.every((lane) => lane.status === "pass")).toBe(true);
    expect(report.isolation).toBe("isolated");
    expect(report.settlement).toBe("settled");
    expect(report.registry).toBe("empty");
    expect(report.diagnostics).toBe("clean");
    expect(report.cleanup).toBe("complete");
    expect(report.failures).toEqual([]);
    expect(report.counters.cleanupAttempts).toBe(4);

    expect(port.calls.delegate).toBe(1);
    expect(port.calls.inspector).toBe(1);
    expect(port.calls["parent-lane"]).toBe(1);
    expect(port.calls["inspector-reasoning"]).toBe(1);
    expect(port.calls["tool-details"]).toBe(1);
    expect(port.calls["assistant-reply"]).toBe(1);
    expect(port.calls["cleanup-runtime"]).toBe(1);
    expect(port.calls["cleanup-process"]).toBe(1);
    expect(port.calls["cleanup-temp"]).toBe(1);
    expect(port.calls["cleanup-pane"]).toBe(1);
    expect(JSON.stringify(report)).not.toContain("not returned");
    expect(JSON.stringify(report)).not.toContain("childId");
    expect(report.bounds).toEqual(LIVE_PROOF_REPORT_BOUNDS);
  });

  it("blocks before launch for stale current identity and always cleans up", async () => {
    const port = new FakeLiveProofPort({
      identity: currentIdentity("stale-on-disk"),
    });
    const report = await run(port);

    expect(report.identity).toEqual({
      currentBuild: "stale-on-disk",
      freshParent: "unverifiable",
    });
    expect(hasFailure(report, "identity-current-failed")).toBe(true);
    expect(port.calls.launch).toBeUndefined();
    expect(port.calls.delegate).toBeUndefined();
    expect(report.cleanup).toBe("complete");
    expect(report.counters.cleanupAttempts).toBe(4);
  });

  it("rejects incomplete pre-build identity before launching a parent", async () => {
    const port = new FakeLiveProofPort({
      identity: { ...currentIdentity(), artifactComplete: false },
    });
    const report = await run(port);

    expect(report.identity.currentBuild).toBe("unverifiable");
    expect(hasFailure(report, "identity-current-failed")).toBe(true);
    expect(port.calls.launch).toBeUndefined();
    expect(report.cleanup).toBe("complete");
  });

  it("rejects reload-only parent evidence and does not delegate", async () => {
    const port = new FakeLiveProofPort({
      launch: freshParent("stale"),
    });
    const report = await run(port);

    expect(report.identity.freshParent).toBe("stale");
    expect(hasFailure(report, "fresh-parent-failed")).toBe(true);
    expect(port.calls.delegate).toBeUndefined();
    expect(report.cleanup).toBe("complete");
  });

  it("keeps the four lanes independent", async () => {
    for (const laneName of LIVE_PROOF_LANE_NAMES) {
      const port = new FakeLiveProofPort({
        lane: {
          [laneName]: signal("fail"),
        },
      });
      const report = await run(port);
      const failed = report.lanes.find((lane) => lane.name === laneName);
      expect(failed?.status).toBe("fail");
      expect(
        report.lanes.filter((lane) => lane.status === "pass"),
      ).toHaveLength(3);
      expect(hasFailure(report, "lane-failed")).toBe(true);
      expect(port.calls["parent-lane"]).toBe(1);
      expect(port.calls["inspector-reasoning"]).toBe(1);
      expect(port.calls["tool-details"]).toBe(1);
      expect(port.calls["assistant-reply"]).toBe(1);
    }
  });

  it("fails closed for duplicate child, settlement, and tool terminal facts", async () => {
    for (const field of [
      "childCount",
      "settlementCount",
      "toolTerminalCount",
    ] as const) {
      const port = new FakeLiveProofPort({
        settlement: { ...settled, [field]: 2 },
      });
      const report = await run(port);
      expect(report.settlement).toBe("unsettled");
      expect(hasFailure(report, "settlement-failed")).toBe(true);
    }
  });

  it("rejects a prohibited sink and does not claim isolation", async () => {
    const port = new FakeLiveProofPort({
      isolation: { ...isolated, prohibitedSinkDetected: true },
    });
    const report = await run(port);

    expect(report.isolation).toBe("violated");
    expect(hasFailure(report, "isolation-failed")).toBe(true);
  });

  it("detects retained card, inspector, and reasoning registry bytes", async () => {
    const port = new FakeLiveProofPort({
      registry: { ...emptyRegistry, inspectorEntries: 1, inspectorBytes: 12 },
    });
    const report = await run(port);

    expect(report.registry).toBe("leaked");
    expect(hasFailure(report, "registry-leaked")).toBe(true);
  });

  it("reports diagnostics overflow and read failure without raw errors", async () => {
    const overflow = await run(
      new FakeLiveProofPort({
        diagnostics: { status: "clean", count: 1, overflow: true },
      }),
    );
    expect(overflow.diagnostics).toBe("unverified");
    expect(overflow.counters.diagnostics).toBe(1);
    expect(hasFailure(overflow, "diagnostics-failed")).toBe(true);

    const failed = await run(new FakeLiveProofPort({ fail: "diagnostics" }));
    expect(failed.diagnostics).toBe("unverified");
    expect(failed.counters.diagnostics).toBe(1_000_000);
    expect(hasFailure(failed, "diagnostics-failed")).toBe(true);
    expect(JSON.stringify(failed)).not.toContain("spawn-failed");
  });

  it("reports each cleanup failure and cannot mask it", async () => {
    for (const stage of [
      "cleanup-runtime",
      "cleanup-process",
      "cleanup-temp",
      "cleanup-pane",
    ] as const) {
      const report = await run(new FakeLiveProofPort({ fail: stage }));
      expect(report.cleanup).toBe("incomplete");
      expect(hasFailure(report, "cleanup-failed")).toBe(true);
      expect(report.counters.cleanupAttempts).toBe(4);
      expect(report.settlement).toBe("settled");
    }
  });

  it("retains earlier failures when cleanup also fails", async () => {
    const port = new FakeLiveProofPort({
      identity: currentIdentity("manifest-mismatch"),
      fail: "cleanup-pane",
    });
    const report = await run(port);

    expect(hasFailure(report, "identity-current-failed")).toBe(true);
    expect(hasFailure(report, "cleanup-failed")).toBe(true);
    expect(report.cleanup).toBe("incomplete");
    expect(report.failures.length).toBeLessThanOrEqual(8);
  });

  it("converts a lane port error to a blocked lane and still observes the others", async () => {
    const port = new FakeLiveProofPort({ fail: "tool-details" });
    const report = await run(port);
    const toolLane = report.lanes.find(
      (lane) => lane.name === "inspector-tool-details",
    );

    expect(toolLane?.status).toBe("blocked");
    expect(report.lanes.filter((lane) => lane.status === "pass")).toHaveLength(
      3,
    );
    expect(hasFailure(report, "lane-failed")).toBe(true);
    expect(port.calls["assistant-reply"]).toBe(1);
  });

  it("rejects an unloaded runtime even when the port claims a current build", async () => {
    const port = new FakeLiveProofPort({
      identity: { ...currentIdentity(), runtimeLoaded: false },
    });
    const report = await run(port);

    expect(report.identity.currentBuild).toBe("unverifiable");
    expect(hasFailure(report, "identity-current-failed")).toBe(true);
    expect(port.calls.launch).toBeUndefined();
    expect(report.lanes.every((lane) => lane.status === "blocked")).toBe(true);
  });

  it("rejects a parent launched from an incomplete artifact", async () => {
    const port = new FakeLiveProofPort({
      launch: { ...freshParent(), artifactComplete: false },
    });
    const report = await run(port);

    expect(report.identity.freshParent).toBe("unverifiable");
    expect(hasFailure(report, "fresh-parent-failed")).toBe(true);
    expect(port.calls.delegate).toBeUndefined();
    expect(report.cleanup).toBe("complete");
  });

  it("blocks every lane when the single child cannot be delegated", async () => {
    const port = new FakeLiveProofPort({ fail: "delegate" });
    const report = await run(port);

    expect(port.calls.delegate).toBe(1);
    expect(port.calls.inspector).toBeUndefined();
    expect(port.calls["parent-lane"]).toBeUndefined();
    expect(report.lanes.every((lane) => lane.status === "blocked")).toBe(true);
    expect(hasFailure(report, "spawn-failed")).toBe(true);
    expect(report.settlement).toBe("unverified");
    expect(report.counters.cleanupAttempts).toBe(4);
  });

  it("blocks only inspector lanes when the single inspector selection fails", async () => {
    const port = new FakeLiveProofPort({ fail: "inspector" });
    const report = await run(port);

    expect(port.calls.delegate).toBe(1);
    expect(port.calls.inspector).toBe(1);
    const parentLane = report.lanes.find(
      (lane) => lane.name === "parent-raw-reasoning-live",
    );
    expect(parentLane?.status).toBe("pass");
    expect(
      report.lanes.filter((lane) => lane.status === "blocked"),
    ).toHaveLength(3);
    expect(hasFailure(report, "spawn-failed")).toBe(true);
  });

  it("treats a thrown or rejected port as a closed failure without exception text", async () => {
    const thrown = await run(
      portWith(new FakeLiveProofPort(), {
        observeInspectorToolDetails: () => {
          throw new Error(SECRET);
        },
      }),
    );
    const thrownLane = thrown.lanes.find(
      (lane) => lane.name === "inspector-tool-details",
    );
    expect(thrownLane?.status).toBe("blocked");
    expect(hasFailure(thrown, "lane-failed")).toBe(true);
    expect(unexpectedStrings(thrown)).toEqual([]);

    const rejected = await run(
      portWith(new FakeLiveProofPort(), {
        cleanupTemp: () =>
          ResultAsync.fromPromise(Promise.reject(new Error(SECRET)), () => ({
            code: "cleanup-failed" as const,
          })).map(() => undefined),
      }),
    );
    expect(rejected.cleanup).toBe("incomplete");
    expect(hasFailure(rejected, "cleanup-failed")).toBe(true);
    expect(rejected.counters.cleanupAttempts).toBe(4);
    expect(unexpectedStrings(rejected)).toEqual([]);
  });

  it("keeps host text, ids, and paths out of the report", async () => {
    const leaky = portWith(new FakeLiveProofPort(), {
      observeParentRawReasoning: () =>
        okAsync({
          ...signal(),
          text: SECRET,
          childId: "child-42",
          path: "/tmp/pi-proof",
        } as unknown as LiveProofLaneSignal),
    });
    const report = await run(leaky);
    const serialized = JSON.stringify(report);

    expect(unexpectedStrings(report)).toEqual([]);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("child-42");
    expect(serialized).not.toContain("/tmp");
    expect(serialized).not.toContain(args.pi);
    expect(serialized).not.toContain(args.contentFreeReport);
  });

  it("saturates an out-of-range diagnostic count instead of reporting it raw", async () => {
    const report = await run(
      new FakeLiveProofPort({
        diagnostics: {
          status: "clean",
          count: Number.MAX_SAFE_INTEGER,
          overflow: false,
        },
      }),
    );

    expect(report.counters.diagnostics).toBe(1_000_000);
    expect(report.diagnostics).toBe("clean");
    expect(report.bounds).toEqual(LIVE_PROOF_REPORT_BOUNDS);
  });

  it("retains no state between runs", async () => {
    const failed = await run(
      new FakeLiveProofPort({
        identity: currentIdentity("manifest-mismatch"),
        fail: "cleanup-pane",
      }),
    );
    expect(failed.cleanup).toBe("incomplete");
    expect(failed.failures.length).toBeGreaterThan(0);

    const clean = await run(new FakeLiveProofPort());
    expect(clean.failures).toEqual([]);
    expect(clean.cleanup).toBe("complete");
    expect(clean.counters.cleanupAttempts).toBe(4);
    expect(clean.lanes.every((lane) => lane.status === "pass")).toBe(true);
  });
});
