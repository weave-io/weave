import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import { makeChildSettlementMissingFailure } from "../../../packages/adapters/pi/src/errors.js";
import {
  artifactDigest,
  runAutonomousSmoke,
  validateLargeOutputSmoke,
  validateSmokeBinding,
} from "../pi-child-inspection-smoke.js";

const binding = {
  artifactSha256: "a".repeat(64),
  subjectSha: "b".repeat(40),
  hostVersion: "0.81.1",
  checklistVersion: 2,
  runAttempt: 17,
} as const;

function observation(sentinel: string) {
  return okAsync({
    settlement: {
      outcome: "completed" as const,
      summary: "bounded",
      outputByteLength: 1_100_000,
    },
    privateOutput: `${"x".repeat(1_100_000)}${sentinel}`,
    logs: [],
  });
}

describe("autonomous child inspection smoke", () => {
  it("CLI rejects an unusable invocation instead of exiting silently", async () => {
    const process = Bun.spawn(
      [
        "bun",
        "run",
        "scripts/release/pi-child-inspection-smoke.ts",
        "--artifact",
        "/definitely/missing.tar.gz",
        "--repeat-oversized-settlement",
        "10",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(code).not.toBe(0);
    expect(`${stdout}${stderr}`).toContain("ok");
  });
  it("requires a digest, subject, host, and positive run attempt", () => {
    expect(validateSmokeBinding(binding).isOk()).toBe(true);
    expect(
      validateSmokeBinding({ ...binding, subjectSha: "clean" }).isErr(),
    ).toBe(true);
  });

  it("digests artifact bytes with Bun.CryptoHasher", () => {
    const bytes = new TextEncoder().encode("smoke-artifact");
    expect(artifactDigest(bytes)).toBe(
      new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    );
  });

  it("rejects structured ChildSettlementMissing without log text", async () => {
    const result = await validateLargeOutputSmoke(
      (sentinel) =>
        sentinel.endsWith("SEQUENTIAL_3")
          ? errAsync(makeChildSettlementMissingFailure("child-3"))
          : observation(sentinel),
      4,
    );
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error).toEqual({
      type: "ChildSettlementMissing",
      runIndex: 3,
    });
  });

  it("runs ten sequential and maximum-parallelism children with unique sentinels", async () => {
    const result = await validateLargeOutputSmoke(
      (sentinel) => observation(sentinel),
      6,
    );
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value).toEqual({
      validatedRuns: 16,
      childSettlementMissingCount: 0,
    });
  });

  it("emits only sanitized, bounded report data", async () => {
    const result = await runAutonomousSmoke({
      binding,
      maxParallelism: 2,
      run: observation,
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.assertions).toContain("zero-human-input");
    expect(result.value.sanitizedArtifacts.join(" ")).not.toContain("private");
  });
});
