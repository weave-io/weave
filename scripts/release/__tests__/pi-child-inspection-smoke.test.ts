import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import { makeChildSettlementMissingFailure } from "../../../packages/adapters/pi/src/errors.js";
import {
  runAutonomousSmoke,
  validateLargeOutputSmoke,
  validateSmokeBinding,
} from "../pi-child-inspection-smoke.js";

const binding = {
  artifactSha256: "a".repeat(64),
  subjectSha: "b".repeat(40),
  hostVersion: "0.81.1",
  runAttempt: 17,
} as const;

function observation(sentinel: string) {
  return okAsync({
    settlement: { outcome: "completed" as const, summary: "bounded", outputByteLength: 1_100_000 },
    privateOutput: `${"x".repeat(1_100_000)}${sentinel}`,
    logs: [],
  });
}

describe("autonomous child inspection smoke", () => {
  it("requires a digest, subject, host, and positive run attempt", () => {
    expect(validateSmokeBinding(binding).isOk()).toBe(true);
    expect(validateSmokeBinding({ ...binding, subjectSha: "clean" }).isErr()).toBe(true);
  });

  it("rejects structured ChildSettlementMissing without log text", async () => {
    const result = await validateLargeOutputSmoke(
      (sentinel) => sentinel.endsWith("SEQUENTIAL_3")
        ? errAsync(makeChildSettlementMissingFailure("child-3"))
        : observation(sentinel),
      4,
    );
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error).toEqual({ type: "ChildSettlementMissing", runIndex: 3 });
  });

  it("runs ten sequential and maximum-parallelism children with unique sentinels", async () => {
    const result = await validateLargeOutputSmoke((sentinel) => observation(sentinel), 6);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value).toEqual({ validatedRuns: 16, childSettlementMissingCount: 0 });
  });

  it("emits only sanitized, bounded report data", async () => {
    const result = await runAutonomousSmoke({ binding, maxParallelism: 2, run: observation });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.assertions).toContain("zero-human-input");
    expect(result.value.sanitizedArtifacts.join(" ")).not.toContain("private");
  });
});
