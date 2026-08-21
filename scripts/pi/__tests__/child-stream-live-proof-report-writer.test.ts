import { describe, expect, it } from "bun:test";
import {
  LIVE_PROOF_LANE_NAMES,
  LIVE_PROOF_REPORT_BOUNDS,
  type LiveProofReport,
} from "../child-stream-live-proof-contract.js";
import { writeLiveProofReport } from "../child-stream-live-proof-report-writer.js";
import { bytes, createFakeSystem, text } from "./live-proof-fakes.js";

const TARGET = "/tmp/weave-live-proof/report.json";

function greenReport(): LiveProofReport {
  return {
    schemaVersion: 1,
    identity: { currentBuild: "current", freshParent: "fresh" },
    lanes: LIVE_PROOF_LANE_NAMES.map((name) => ({
      name,
      status: "pass" as const,
      observationCount: 3,
    })),
    isolation: "isolated",
    settlement: "settled",
    registry: "empty",
    diagnostics: "clean",
    cleanup: "complete",
    failures: [],
    counters: {
      events: 12,
      dropped: 0,
      repaints: 9,
      diagnostics: 0,
      cleanupAttempts: 4,
    },
    bounds: LIVE_PROOF_REPORT_BOUNDS,
  };
}

describe("writeLiveProofReport", () => {
  it("writes an owner-only report through an atomic rename", async () => {
    const fake = createFakeSystem();
    const result = await writeLiveProofReport({
      system: fake.system,
      target: TARGET,
      report: greenReport(),
    });

    expect(result.isOk()).toBe(true);
    expect(fake.renames).toHaveLength(1);
    expect(fake.renames[0]?.to).toBe(TARGET);
    expect(fake.privateFiles.has(fake.renames[0]?.from ?? "")).toBe(true);
    const written = text(fake.files.get(TARGET));
    expect(written.endsWith("\n")).toBe(true);
    expect(JSON.parse(written).identity.currentBuild).toBe("current");
  });

  it("refuses a symlink target without writing anything", async () => {
    const fake = createFakeSystem({
      kinds: new Map([[TARGET, "symlink" as const]]),
    });
    const result = await writeLiveProofReport({
      system: fake.system,
      target: TARGET,
      report: greenReport(),
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("unsafe-report-target");
    expect(fake.files.has(TARGET)).toBe(false);
    expect(fake.renames).toHaveLength(0);
  });

  it("refuses a directory or other non-regular target", async () => {
    const fake = createFakeSystem({
      kinds: new Map([[TARGET, "other" as const]]),
    });
    const result = await writeLiveProofReport({
      system: fake.system,
      target: TARGET,
      report: greenReport(),
    });

    expect(result._unsafeUnwrapErr().code).toBe("unsafe-report-target");
  });

  it("refuses an already present temporary path", async () => {
    const fake = createFakeSystem();
    const preexisting = `${TARGET}.token-1.tmp`;
    fake.files.set(preexisting, bytes("squatted"));

    const result = await writeLiveProofReport({
      system: fake.system,
      target: TARGET,
      report: greenReport(),
    });

    expect(result._unsafeUnwrapErr().code).toBe("unsafe-report-target");
    expect(text(fake.files.get(preexisting))).toBe("squatted");
  });

  it("removes the partial file when the write fails", async () => {
    const fake = createFakeSystem({ failWriteBytes: true });
    const result = await writeLiveProofReport({
      system: fake.system,
      target: TARGET,
      report: greenReport(),
    });

    expect(result._unsafeUnwrapErr().code).toBe("report-invalid");
    expect(fake.removed).toEqual([`${TARGET}.token-1.tmp`]);
    expect(fake.files.has(TARGET)).toBe(false);
  });

  it("removes the partial file when the rename fails", async () => {
    const fake = createFakeSystem({ failRename: true });
    const result = await writeLiveProofReport({
      system: fake.system,
      target: TARGET,
      report: greenReport(),
    });

    expect(result._unsafeUnwrapErr().code).toBe("report-invalid");
    expect(fake.removed).toEqual([`${TARGET}.token-1.tmp`]);
    expect(fake.files.has(TARGET)).toBe(false);
  });

  it("refuses a report that fails the closed schema", async () => {
    const fake = createFakeSystem();
    const invalid = { ...greenReport(), isolation: "leaky" };

    const result = await writeLiveProofReport({
      system: fake.system,
      target: TARGET,
      report: invalid,
    });

    expect(result._unsafeUnwrapErr().code).toBe("report-invalid");
    expect(fake.files.size).toBe(0);
  });

  it("refuses a report carrying an unexpected content field", async () => {
    const fake = createFakeSystem();
    const leaky = {
      ...greenReport(),
      reasoning: "the child was thinking about secrets",
    };

    const result = await writeLiveProofReport({
      system: fake.system,
      target: TARGET,
      report: leaky,
    });

    expect(result._unsafeUnwrapErr().code).toBe("report-invalid");
    expect(fake.files.size).toBe(0);
  });
});
