import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import {
  liveProofReportPassed,
  runLiveProofCommand,
} from "../child-stream-live-proof-command.js";
import {
  LIVE_PROOF_LANE_NAMES,
  parseLiveProofReportJson,
} from "../child-stream-live-proof-contract.js";
import type {
  LiveProofLaneSignal,
  LiveProofPort,
} from "../child-stream-live-proof-runner.js";
import { createFakeSystem, text } from "./live-proof-fakes.js";

const REPORT_TARGET = "/tmp/weave-pi-child-streaming-proof.json";
const DOCUMENTED_ARGV = [
  "live",
  "--pi",
  "/usr/local/bin/pi",
  "--require-fresh-parent",
  "--require-current-build",
  "--proof-lanes",
  LIVE_PROOF_LANE_NAMES.join(","),
  "--content-free-report",
  REPORT_TARGET,
  "--no-screen-capture",
] as const;

const parent = Object.freeze({ kind: "parent" });
const child = Object.freeze({ kind: "child" });
const inspector = Object.freeze({ kind: "inspector" });

function signal(status: "pass" | "fail" = "pass"): LiveProofLaneSignal {
  return {
    status,
    prefixObserved: status === "pass",
    nonBlankObserved: status === "pass",
    growthObserved: status === "pass",
    observationCount: status === "pass" ? 3 : 0,
    events: 3,
    dropped: 0,
    repaints: 3,
  };
}

function greenPort(
  overrides: Partial<LiveProofPort> = {},
  laneStatus: "pass" | "fail" = "pass",
): LiveProofPort {
  return {
    readCurrentIdentity: () =>
      okAsync({
        currentBuild: "current",
        runtimeLoaded: true,
        artifactComplete: true,
      }),
    launchFreshParent: () =>
      okAsync({
        parent,
        freshParent: "fresh",
        runtimeLoaded: true,
        artifactComplete: true,
      }),
    delegateDeterministicChild: () => okAsync(child),
    selectLiveInspector: () => okAsync(inspector),
    observeParentRawReasoning: () => okAsync(signal(laneStatus)),
    observeInspectorRawReasoning: () => okAsync(signal(laneStatus)),
    observeInspectorToolDetails: () => okAsync(signal(laneStatus)),
    observeInspectorAssistantReply: () => okAsync(signal(laneStatus)),
    readSettlement: () =>
      okAsync({
        status: "settled",
        childCount: 1,
        settlementCount: 1,
        toolTerminalCount: 1,
        events: 4,
        dropped: 0,
        repaints: 4,
      }),
    readIsolation: () =>
      okAsync({
        parentIsolated: true,
        cardIsolated: true,
        modelIsolated: true,
        durableIsolated: true,
        prohibitedSinkDetected: false,
      }),
    readRegistry: () =>
      okAsync({
        cardEntries: 0,
        cardBytes: 0,
        inspectorEntries: 0,
        inspectorBytes: 0,
        registryEntries: 0,
        registryBytes: 0,
      }),
    readDiagnostics: () =>
      okAsync({ status: "clean", count: 0, overflow: false }),
    cleanupRuntime: () => okAsync(undefined),
    cleanupProcess: () => okAsync(undefined),
    cleanupTemp: () => okAsync(undefined),
    cleanupPane: () => okAsync(undefined),
    ...overrides,
  };
}

describe("runLiveProofCommand", () => {
  it("executes the documented invocation and writes a passing report", async () => {
    const fake = createFakeSystem();
    const outcome = (
      await runLiveProofCommand({
        argv: DOCUMENTED_ARGV,
        repoRoot: "/repo",
        system: fake.system,
        createPort: () => greenPort(),
      })
    )._unsafeUnwrap();

    expect(outcome.exitCode).toBe(0);
    expect(outcome.line).toBe(
      "live: verified; evidence=content-free; lanes=4; cleanup=complete",
    );
    const written = text(fake.files.get(REPORT_TARGET));
    const parsed = parseLiveProofReportJson(written.trim());
    expect(parsed.isOk()).toBe(true);
    expect(liveProofReportPassed(parsed._unsafeUnwrap())).toBe(true);
    // Closed vocabulary only: no rendered reasoning row, prose, or payload.
    expect(written).not.toContain("↪");
    expect(written).not.toContain("•");
    expect(written).not.toContain("path");
    expect(written).not.toContain("/");
  });

  it("rejects malformed arguments without touching the filesystem", async () => {
    const fake = createFakeSystem();
    const outcome = (
      await runLiveProofCommand({
        argv: ["live", "--pi"],
        repoRoot: "/repo",
        system: fake.system,
        createPort: () => greenPort(),
      })
    )._unsafeUnwrap();

    expect(outcome.exitCode).toBe(1);
    expect(outcome.line).toContain("reason=missing-value");
    expect(fake.files.size).toBe(0);
    expect(outcome.report).toBeUndefined();
  });

  it("refuses an explicit screen-capture flag", async () => {
    const fake = createFakeSystem();
    const outcome = (
      await runLiveProofCommand({
        argv: [...DOCUMENTED_ARGV, "--allow-screen-capture"],
        repoRoot: "/repo",
        system: fake.system,
        createPort: () => greenPort(),
      })
    )._unsafeUnwrap();

    expect(outcome.exitCode).toBe(1);
    expect(outcome.line).toContain("reason=screen-capture-forbidden");
    expect(fake.files.size).toBe(0);
  });

  it("exits nonzero for a lane failure and still writes the report", async () => {
    const fake = createFakeSystem();
    const outcome = (
      await runLiveProofCommand({
        argv: DOCUMENTED_ARGV,
        repoRoot: "/repo",
        system: fake.system,
        createPort: () => greenPort({}, "fail"),
      })
    )._unsafeUnwrap();

    expect(outcome.exitCode).toBe(1);
    expect(outcome.line).toContain("reason=lane-failed");
    expect(fake.files.has(REPORT_TARGET)).toBe(true);
  });

  it("exits nonzero when cleanup fails after green lanes", async () => {
    const fake = createFakeSystem();
    const outcome = (
      await runLiveProofCommand({
        argv: DOCUMENTED_ARGV,
        repoRoot: "/repo",
        system: fake.system,
        createPort: () =>
          greenPort({
            cleanupTemp: () => errAsync({ code: "cleanup-failed" }),
          }),
      })
    )._unsafeUnwrap();

    expect(outcome.exitCode).toBe(1);
    expect(outcome.line).toContain("reason=cleanup-failed");
    expect(outcome.report?.cleanup).toBe("incomplete");
  });

  it("exits nonzero when a stale identity blocks the launch", async () => {
    const fake = createFakeSystem();
    const outcome = (
      await runLiveProofCommand({
        argv: DOCUMENTED_ARGV,
        repoRoot: "/repo",
        system: fake.system,
        createPort: () =>
          greenPort({
            readCurrentIdentity: () =>
              okAsync({
                currentBuild: "stale-on-disk",
                runtimeLoaded: false,
                artifactComplete: false,
              }),
          }),
      })
    )._unsafeUnwrap();

    expect(outcome.exitCode).toBe(1);
    expect(outcome.line).toContain("reason=identity-current-failed");
    expect(outcome.report?.identity.currentBuild).toBe("stale-on-disk");
  });

  it("exits nonzero when the report target is unsafe", async () => {
    const fake = createFakeSystem({
      kinds: new Map([[REPORT_TARGET, "symlink" as const]]),
    });
    const outcome = (
      await runLiveProofCommand({
        argv: DOCUMENTED_ARGV,
        repoRoot: "/repo",
        system: fake.system,
        createPort: () => greenPort(),
      })
    )._unsafeUnwrap();

    expect(outcome.exitCode).toBe(1);
    expect(outcome.line).toContain("reason=unsafe-report-target");
    expect(fake.files.has(REPORT_TARGET)).toBe(false);
  });

  it("rejects a report path that is not a bounded json target", async () => {
    const fake = createFakeSystem();
    const outcome = (
      await runLiveProofCommand({
        argv: [
          "live",
          "--pi",
          "/usr/local/bin/pi",
          "--require-fresh-parent",
          "--require-current-build",
          "--proof-lanes",
          LIVE_PROOF_LANE_NAMES.join(","),
          "--content-free-report",
          "/tmp/../etc/passwd",
          "--no-screen-capture",
        ],
        repoRoot: "/repo",
        system: fake.system,
        createPort: () => greenPort(),
      })
    )._unsafeUnwrap();

    expect(outcome.exitCode).toBe(1);
    expect(outcome.line).toContain("reason=unsafe-report-target");
    expect(fake.files.size).toBe(0);
  });

  it("survives a port method that throws before returning", async () => {
    const fake = createFakeSystem();
    const outcome = (
      await runLiveProofCommand({
        argv: DOCUMENTED_ARGV,
        repoRoot: "/repo",
        system: fake.system,
        createPort: () =>
          greenPort({
            delegateDeterministicChild: () => {
              throw new Error("host detail that must not escape");
            },
          }),
      })
    )._unsafeUnwrap();

    expect(outcome.exitCode).toBe(1);
    expect(outcome.line).toContain("reason=spawn-failed");
    expect(text(fake.files.get(REPORT_TARGET))).not.toContain("host detail");
  });
});
