import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import { makeChildSettlementMissingFailure } from "../errors.js";
import {
  validateRepeatedSettlements,
  type PiSettlementValidationRun,
} from "../repeated-settlement-validator.js";

function successfulRun(run: PiSettlementValidationRun) {
  return okAsync({
    settlement: {
      outcome: "completed" as const,
      summary: `projection-${run.index}`,
      outputByteLength: 20_000,
    },
    privateOutput: `${"x".repeat(12_000)}${run.sentinel}`,
    logs: [] as readonly string[],
  });
}

describe("validateRepeatedSettlements", () => {
  it("rejects a structured ChildSettlementMissing failure even when logs contain no matching text", async () => {
    const result = await validateRepeatedSettlements({
      sequentialRuns: 10,
      maxParallelism: 4,
      run: (run) =>
        run.index === 3
          ? errAsync(makeChildSettlementMissingFailure(`child-${run.index}`))
          : successfulRun(run),
    });

    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.type).toBe("StructuredFailure");
    if (result.error.type !== "StructuredFailure") return;
    expect(result.error.failureCode).toBe("ChildSettlementMissing");
  });

  it("requires ten sequential runs plus one maximum-parallelism batch and every unique sentinel", async () => {
    const observed: PiSettlementValidationRun[] = [];
    const result = await validateRepeatedSettlements({
      sequentialRuns: 10,
      maxParallelism: 6,
      run: (run) => {
        observed.push(run);
        return successfulRun(run);
      },
    });

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(observed.filter((run) => run.mode === "sequential")).toHaveLength(10);
    expect(observed.filter((run) => run.mode === "parallel")).toHaveLength(6);
    expect(new Set(observed.map((run) => run.sentinel)).size).toBe(16);
    expect(result.value.validatedRuns).toBe(16);
  });

  it("rejects a completed run whose private output lost its sentinel", async () => {
    const result = await validateRepeatedSettlements({
      sequentialRuns: 10,
      maxParallelism: 2,
      run: (run) =>
        run.index === 8
          ? okAsync({
              settlement: { outcome: "completed" as const, summary: "bounded" },
              privateOutput: "large output without terminal marker",
              logs: [] as readonly string[],
            })
          : successfulRun(run),
    });

    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.type).toBe("SentinelMissing");
  });
});
