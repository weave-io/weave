import { describe, expect, it } from "bun:test";
import {
  LIVE_PROOF_FAILURE_CODES,
  LIVE_PROOF_LANE_NAMES,
  LIVE_PROOF_REPORT_BOUNDS,
  type LiveProofReport,
  MAX_LIVE_PROOF_ARGUMENT_BYTES,
  MAX_LIVE_PROOF_COUNTER,
  MAX_LIVE_PROOF_REPORT_ARRAY_LENGTH,
  MAX_LIVE_PROOF_REPORT_DEPTH,
  MAX_LIVE_PROOF_REPORT_KEYS,
  MAX_LIVE_PROOF_REPORT_STRING_BYTES,
  MAX_LIVE_PROOF_REPORT_TOTAL_BYTES,
  parseLiveProofArgs,
  parseLiveProofReportJson,
  saturatingIncrement,
  serializeLiveProofReport,
  validateLiveProofReport,
} from "../child-stream-live-proof-contract.js";
import { parseLiveProofArgs as parseLiveProofArgsDirect } from "../child-stream-live-proof-contract-args.js";
import { saturatingIncrement as saturatingIncrementDirect } from "../child-stream-live-proof-contract-counters.js";
import { validateLiveProofReport as validateLiveProofReportDirect } from "../child-stream-live-proof-contract-report-validation.js";
import { serializeLiveProofReport as serializeLiveProofReportDirect } from "../child-stream-live-proof-contract-serialization.js";
import {
  LIVE_PROOF_FAILURE_CODES as LIVE_PROOF_FAILURE_CODES_DIRECT,
  LIVE_PROOF_LANE_NAMES as LIVE_PROOF_LANE_NAMES_DIRECT,
} from "../child-stream-live-proof-contract-types.js";

const DOCUMENTED_LANES = LIVE_PROOF_LANE_NAMES.join(",");

function validReport(): LiveProofReport {
  return {
    schemaVersion: 1,
    identity: {
      currentBuild: "current",
      freshParent: "fresh",
    },
    lanes: LIVE_PROOF_LANE_NAMES.map((name) => ({
      name,
      status: "pass" as const,
      observationCount: 1,
    })),
    isolation: "isolated",
    settlement: "settled",
    registry: "empty",
    diagnostics: "clean",
    cleanup: "complete",
    failures: [],
    counters: {
      events: 4,
      dropped: 0,
      repaints: 4,
      diagnostics: 0,
      cleanupAttempts: 1,
    },
    bounds: LIVE_PROOF_REPORT_BOUNDS,
  };
}

function validArgs(): readonly string[] {
  return [
    "live",
    "--pi",
    "/usr/local/bin/pi",
    "--require-fresh-parent",
    "--require-current-build",
    "--proof-lanes",
    DOCUMENTED_LANES,
    "--content-free-report",
    "/tmp/weave-pi-child-streaming-proof.json",
    "--no-screen-capture",
  ];
}

describe("live proof argument contract", () => {
  it("accepts the documented flags and requires all four lanes", () => {
    const parsed = parseLiveProofArgs(validArgs());
    expect(parsed.isOk()).toBe(true);
    if (parsed.isErr()) return;
    expect(parsed.value).toEqual({
      command: "live",
      pi: "/usr/local/bin/pi",
      requireFreshParent: true,
      requireCurrentBuild: true,
      proofLanes: [...LIVE_PROOF_LANE_NAMES],
      contentFreeReport: "/tmp/weave-pi-child-streaming-proof.json",
      noScreenCapture: true,
    });
    expect(LIVE_PROOF_LANE_NAMES).toHaveLength(4);
    expect([...new Set(parsed.value.proofLanes)]).toHaveLength(4);
  });

  it("also parses flags after the command has already been consumed", () => {
    const parsed = parseLiveProofArgs(validArgs().slice(1));
    expect(parsed.isOk()).toBe(true);
  });

  it("rejects unknown, omitted, empty, and duplicate values", () => {
    expect(parseLiveProofArgs([...validArgs(), "--unknown"]).isErr()).toBe(
      true,
    );
    expect(
      parseLiveProofArgs(
        validArgs().filter((value) => value !== "--no-screen-capture"),
      ).isErr(),
    ).toBe(true);
    expect(
      parseLiveProofArgs(
        validArgs().map((value, index) => (index === 2 ? "" : value)),
      ).isErr(),
    ).toBe(true);
    expect(
      parseLiveProofArgs([...validArgs(), "--no-screen-capture"]).isErr(),
    ).toBe(true);
  });

  it("rejects unsafe report targets and screen-capture allowances", () => {
    for (const target of [
      "../proof.json",
      "/tmp/../proof.json",
      "/tmp/a/../../proof.json",
      "..\\proof.json",
      "/tmp/proof.txt",
      "",
    ]) {
      const args = [...validArgs()];
      const targetIndex = args.indexOf(
        "/tmp/weave-pi-child-streaming-proof.json",
      );
      args[targetIndex] = target;
      expect(parseLiveProofArgs(args).isErr()).toBe(true);
    }
    for (const flag of ["--allow-screen-capture", "--screen-capture"]) {
      expect(parseLiveProofArgs([...validArgs(), flag]).isErr()).toBe(true);
    }
  });

  it("rejects malformed lane lists and lane overflow", () => {
    for (const laneList of [
      "parent-raw-reasoning-live",
      `${DOCUMENTED_LANES},parent-raw-reasoning-live`,
      "parent-raw-reasoning-live,parent-raw-reasoning-live,inspector-tool-details,inspector-assistant-reply-live",
      "parent-raw-reasoning-live, unknown,inspector-tool-details,inspector-assistant-reply-live",
      `parent-raw-reasoning-live,${DOCUMENTED_LANES.split(",").slice(1, 3).join(",")}`,
    ]) {
      const args = [...validArgs()];
      args[args.indexOf(DOCUMENTED_LANES)] = laneList;
      expect(parseLiveProofArgs(args).isErr()).toBe(true);
    }
    const args = [...validArgs()];
    args[args.indexOf(DOCUMENTED_LANES)] = "x".repeat(513);
    const overflow = parseLiveProofArgs(args);
    expect(overflow.isErr()).toBe(true);
    if (overflow.isErr()) expect(overflow.error.reason).toBe("overflow");
  });

  it("rejects an overlong executable value before any process can start", () => {
    const args = [...validArgs()];
    args[args.indexOf("/usr/local/bin/pi")] = "p".repeat(
      MAX_LIVE_PROOF_ARGUMENT_BYTES + 1,
    );
    const result = parseLiveProofArgs(args);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.reason).toBe("overflow");
  });
});

describe("live proof counters", () => {
  it("saturates at the hard counter bound", () => {
    expect(saturatingIncrement(0)).toBe(1);
    expect(saturatingIncrement(MAX_LIVE_PROOF_COUNTER)).toBe(
      MAX_LIVE_PROOF_COUNTER,
    );
    expect(saturatingIncrement(MAX_LIVE_PROOF_COUNTER - 1, 2)).toBe(
      MAX_LIVE_PROOF_COUNTER,
    );
    expect(saturatingIncrement(1, -1)).toBe(MAX_LIVE_PROOF_COUNTER);
    expect(saturatingIncrement(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_LIVE_PROOF_COUNTER,
    );
  });
});

describe("content-free live proof report", () => {
  it("validates, canonicalizes lane order, serializes, and parses safely", () => {
    const report = validReport();
    const shuffled: LiveProofReport = {
      ...report,
      lanes: [...report.lanes].reverse(),
    };
    const validated = validateLiveProofReport(shuffled);
    expect(validated.isOk()).toBe(true);
    if (validated.isErr()) return;
    expect(validated.value.lanes.map((lane) => lane.name)).toEqual([
      ...LIVE_PROOF_LANE_NAMES,
    ]);

    const serialized = serializeLiveProofReport(shuffled);
    expect(serialized.isOk()).toBe(true);
    if (serialized.isErr()) return;
    expect(
      new TextEncoder().encode(serialized.value).byteLength,
    ).toBeLessThanOrEqual(MAX_LIVE_PROOF_REPORT_TOTAL_BYTES);
    expect(serialized.value).not.toContain("path");
    expect(serialized.value).not.toContain("content");
    expect(serialized.value).not.toContain("exception");

    const parsed = parseLiveProofReportJson(serialized.value);
    expect(parsed.isOk()).toBe(true);
    if (parsed.isErr()) return;
    expect(parsed.value).toEqual(validated.value);
  });

  it("rejects path, content, exception, and arbitrary fields by schema", () => {
    for (const key of ["path", "content", "exception", "message", "payload"]) {
      const hostile = {
        ...validReport(),
        [key]: "not permitted",
      };
      expect(validateLiveProofReport(hostile).isErr()).toBe(true);
      expect(serializeLiveProofReport(hostile).isErr()).toBe(true);
    }
  });

  it("requires each lane exactly once and uses only closed reasons", () => {
    const duplicate: LiveProofReport = {
      ...validReport(),
      lanes: [
        validReport().lanes[0],
        validReport().lanes[0],
        ...validReport().lanes.slice(2),
      ],
    };
    const duplicateResult = validateLiveProofReport(duplicate);
    expect(duplicateResult.isErr()).toBe(true);
    if (duplicateResult.isErr()) {
      expect(duplicateResult.error.reason).toBe("duplicate-lane");
    }

    const failed: LiveProofReport = {
      ...validReport(),
      lanes: [
        ...validReport().lanes.slice(0, 1),
        {
          name: LIVE_PROOF_LANE_NAMES[1],
          status: "fail",
          observationCount: MAX_LIVE_PROOF_COUNTER,
          reason: "lane-failed",
        },
        ...validReport().lanes.slice(2),
      ],
    };
    expect(validateLiveProofReport(failed).isOk()).toBe(true);

    const arbitraryReason = {
      ...failed,
      failures: ["caller supplied text"],
    };
    expect(validateLiveProofReport(arbitraryReason).isErr()).toBe(true);
  });

  it("enforces exact bounds and saturating counter values", () => {
    const report = {
      ...validReport(),
      bounds: {
        ...validReport().bounds,
        maxDepth: MAX_LIVE_PROOF_REPORT_DEPTH + 1,
      },
    };
    const invalidBounds = validateLiveProofReport(report);
    expect(invalidBounds.isErr()).toBe(true);
    if (invalidBounds.isErr()) {
      expect(invalidBounds.error.reason).toBe("invalid-bounds");
    }

    const invalidCounter = {
      ...validReport(),
      counters: {
        ...validReport().counters,
        events: MAX_LIVE_PROOF_COUNTER + 1,
      },
    };
    expect(validateLiveProofReport(invalidCounter).isErr()).toBe(true);

    const tooManyFailures = {
      ...validReport(),
      failures: Array.from(
        { length: MAX_LIVE_PROOF_REPORT_ARRAY_LENGTH + 1 },
        () => "lane-failed" as const,
      ),
    };
    expect(validateLiveProofReport(tooManyFailures).isErr()).toBe(true);
  });

  it("rejects over-depth, over-key, over-string, and over-byte inputs", () => {
    const tooManyKeys: Record<string, unknown> = { ...validReport() };
    for (let index = 0; index < MAX_LIVE_PROOF_REPORT_KEYS; index += 1) {
      tooManyKeys[`extra-${index}`] = index;
    }
    expect(validateLiveProofReport(tooManyKeys).isErr()).toBe(true);

    const tooLongKey = {
      ...validReport(),
      ["x".repeat(MAX_LIVE_PROOF_REPORT_STRING_BYTES + 1)]: 1,
    };
    expect(validateLiveProofReport(tooLongKey).isErr()).toBe(true);

    const tooLongJson = `${JSON.stringify(validReport())}${" ".repeat(
      MAX_LIVE_PROOF_REPORT_TOTAL_BYTES,
    )}`;
    expect(parseLiveProofReportJson(tooLongJson).isErr()).toBe(true);

    const tooDeep = {
      ...validReport(),
      identity: {
        currentBuild: "current",
        freshParent: "fresh",
        nested: { value: "not permitted" },
      },
    };
    expect(validateLiveProofReport(tooDeep).isErr()).toBe(true);
  });
});

describe("live proof contract façade", () => {
  it("reexports the focused implementations without changing identities", () => {
    expect(parseLiveProofArgs).toBe(parseLiveProofArgsDirect);
    expect(saturatingIncrement).toBe(saturatingIncrementDirect);
    expect(validateLiveProofReport).toBe(validateLiveProofReportDirect);
    expect(serializeLiveProofReport).toBe(serializeLiveProofReportDirect);
    expect(LIVE_PROOF_LANE_NAMES).toBe(LIVE_PROOF_LANE_NAMES_DIRECT);
    expect(LIVE_PROOF_FAILURE_CODES).toBe(LIVE_PROOF_FAILURE_CODES_DIRECT);
  });
});

describe("hostile report inputs", () => {
  it("fails closed for cycles and nested accessors", () => {
    const cyclic = validReport() as unknown as Record<string, unknown>;
    const cyclicIdentity = {
      currentBuild: "current",
      freshParent: "fresh",
    } as Record<string, unknown>;
    cyclicIdentity.currentBuild = cyclicIdentity;
    cyclic.identity = cyclicIdentity;
    expect(() => validateLiveProofReport(cyclic)).not.toThrow();
    expect(validateLiveProofReport(cyclic).isErr()).toBe(true);

    const lane = {
      ...validReport().lanes[0],
    } as Record<string, unknown>;
    Object.defineProperty(lane, "name", {
      enumerable: true,
      get: () => {
        throw new Error("NESTED-SENTINEL");
      },
    });
    const accessor = {
      ...validReport(),
      lanes: [lane, ...validReport().lanes.slice(1)],
    };
    expect(() => serializeLiveProofReport(accessor)).not.toThrow();
    const result = serializeLiveProofReport(accessor);
    expect(result.isErr()).toBe(true);
    expect(JSON.stringify(result)).not.toContain("NESTED-SENTINEL");
  });

  it("fails closed for accessors and revoked proxies without invoking getters", () => {
    const accessor = { ...validReport() } as Record<string, unknown>;
    Object.defineProperty(accessor, "identity", {
      enumerable: true,
      get: () => {
        throw new Error("CHILD-SENTINEL");
      },
    });
    expect(() => serializeLiveProofReport(accessor)).not.toThrow();
    expect(serializeLiveProofReport(accessor).isErr()).toBe(true);

    const revoked = Proxy.revocable(validReport(), {});
    revoked.revoke();
    expect(() => serializeLiveProofReport(revoked.proxy)).not.toThrow();
    const result = serializeLiveProofReport(revoked.proxy);
    expect(result.isErr()).toBe(true);
    expect(JSON.stringify(result)).not.toContain("CHILD-SENTINEL");
  });

  it("fails closed when reflection traps throw and never copies the thrown text", () => {
    const hostile = new Proxy(validReport(), {
      ownKeys: () => {
        throw new Error("CHILD-PAYLOAD-MUST-NOT-CROSS");
      },
    });
    const result = serializeLiveProofReport(hostile);
    expect(result.isErr()).toBe(true);
    expect(JSON.stringify(result)).not.toContain(
      "CHILD-PAYLOAD-MUST-NOT-CROSS",
    );
  });
});
