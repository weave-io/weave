/**
 * Stable publication chain contracts.
 *
 * The workflow is only an adapter around this ordered graph. Keeping the graph
 * and the attestation gate in a small, dependency-free module makes the most
 * important safety property testable without GitHub or npm: no proof step may
 * run after a missing, pending, failed, or foreign attestation.
 */
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
  type ResultAsync as ResultAsyncType,
} from "neverthrow";
import { z } from "zod";
import type { PublicPackageName } from "./constants.js";
import { DigestSchema, FullShaSchema, PackageNameSchema } from "./model.js";

export const STABLE_PUBLISH_CHAIN = [
  "route",
  "recompute",
  "build-bind",
  "await-attest",
  "consumer-proof",
  "harness-proof",
  "release-approval",
  "publish",
  "registry-verification",
  "refs-cleanup",
] as const;

export type StablePublishChainStep = (typeof STABLE_PUBLISH_CHAIN)[number];

/** The exact job dependency graph required by Task 25. */
export const STABLE_PUBLISH_CHAIN_NEEDS: Readonly<
  Record<StablePublishChainStep, readonly StablePublishChainStep[]>
> = {
  route: [],
  recompute: ["route"],
  "build-bind": ["recompute"],
  "await-attest": ["build-bind"],
  "consumer-proof": ["await-attest"],
  "harness-proof": ["consumer-proof"],
  "release-approval": ["harness-proof"],
  publish: ["release-approval"],
  "registry-verification": ["publish"],
  "refs-cleanup": ["registry-verification"],
};

export const ATTESTATION_CHECK_NAME = "release-attestation" as const;
export const ATTESTATION_POLL_LIMITS = {
  attempts: 20,
  intervalMs: 5_000,
} as const;

const AttestationSubjectSchema = z
  .object({
    packageName: PackageNameSchema,
    subjectDigest: DigestSchema,
  })
  .strict();

export const AttestationCheckResultSchema = z
  .object({
    checkRunId: z.number().int().positive(),
    name: z.literal(ATTESTATION_CHECK_NAME),
    status: z.enum(["queued", "in_progress", "completed"]),
    conclusion: z
      .enum(["success", "failure", "cancelled", "timed_out", "neutral"])
      .nullable(),
    releasedSha: FullShaSchema,
    planDigest: DigestSchema,
    subjects: z.array(AttestationSubjectSchema).min(1).max(4),
  })
  .strict();

export type AttestationCheckResult = z.infer<
  typeof AttestationCheckResultSchema
>;

export interface AttestationExpectation {
  readonly releasedSha: string;
  readonly planDigest: string;
  readonly tarballDigests: readonly {
    packageName: PublicPackageName;
    sha256: string;
  }[];
}

export type AttestationGateError =
  | { type: "AttestationMissing"; runId: number }
  | { type: "AttestationPending"; runId: number; attempts: number }
  | {
      type: "AttestationFailed";
      runId: number;
      conclusion: string | null;
    }
  | {
      type: "AttestationDigestMismatch";
      packageName?: PublicPackageName;
      expected: string;
      actual: string | null;
    }
  | { type: "InvalidAttestationResult"; issues: readonly string[] }
  | { type: "AttestationDispatchFailed"; reason: string };

export interface AttestationPollPort {
  dispatch(
    request: AttestationExpectation & {
      sourceRunId: number;
      artifactId: number;
    },
  ): ResultAsync<{ runId: number }, AttestationGateError>;
  read(
    runId: number,
  ): ResultAsync<AttestationCheckResult | null, AttestationGateError>;
}

/**
 * Checks one result. It intentionally treats a result with a valid check-run
 * shape but a foreign subject list as a digest mismatch, not as success.
 */
export function verifyAttestationResult(
  input: unknown,
  expected: AttestationExpectation,
): Result<AttestationCheckResult, AttestationGateError> {
  const parsed = AttestationCheckResultSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidAttestationResult",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
      ),
    });
  const result = parsed.data;
  if (result.releasedSha !== expected.releasedSha)
    return err({
      type: "AttestationDigestMismatch",
      expected: expected.releasedSha,
      actual: result.releasedSha,
    });
  if (result.planDigest !== expected.planDigest)
    return err({
      type: "AttestationDigestMismatch",
      expected: expected.planDigest,
      actual: result.planDigest,
    });
  if (result.status !== "completed" || result.conclusion !== "success")
    return err({
      type: "AttestationFailed",
      runId: result.checkRunId,
      conclusion: result.conclusion,
    });

  const expectedByPackage = new Map(
    expected.tarballDigests.map((entry) => [entry.packageName, entry.sha256]),
  );
  const actualByPackage = new Map(
    result.subjects.map((entry) => [entry.packageName, entry.subjectDigest]),
  );
  if (
    actualByPackage.size !== expectedByPackage.size ||
    result.subjects.length !== expected.tarballDigests.length
  )
    return err({
      type: "AttestationDigestMismatch",
      expected: expected.tarballDigests.length.toString(),
      actual: result.subjects.length.toString(),
    });
  for (const [packageName, digest] of expectedByPackage) {
    const actual = actualByPackage.get(packageName) ?? null;
    if (actual !== digest)
      return err({
        type: "AttestationDigestMismatch",
        packageName,
        expected: digest,
        actual,
      });
  }
  return ok(result);
}

/**
 * Dispatches the independent top-level workflow and waits for its exact
 * digest-bound check result. The consumer and harness jobs call this helper
 * before they do any work.
 */
export function awaitAttestation(
  request: AttestationExpectation & {
    sourceRunId: number;
    artifactId: number;
  },
  port: AttestationPollPort,
  options: { attempts?: number; intervalMs?: number } = {},
): ResultAsync<AttestationCheckResult, AttestationGateError> {
  const attempts = options.attempts ?? ATTESTATION_POLL_LIMITS.attempts;
  const intervalMs = options.intervalMs ?? ATTESTATION_POLL_LIMITS.intervalMs;
  if (attempts < 1)
    return errAsync({
      type: "AttestationPending",
      runId: 0,
      attempts: 0,
    });
  return port
    .dispatch(request)
    .andThen(({ runId }) =>
      pollAttestation(runId, request, port, attempts, intervalMs, 0),
    );
}

function pollAttestation(
  runId: number,
  expected: AttestationExpectation,
  port: AttestationPollPort,
  attempts: number,
  intervalMs: number,
  attempt: number,
): ResultAsync<AttestationCheckResult, AttestationGateError> {
  return port.read(runId).andThen((result) => {
    if (result === null) {
      if (attempt + 1 >= attempts)
        return errAsync({ type: "AttestationMissing" as const, runId });
      return delay(intervalMs).andThen(() =>
        pollAttestation(
          runId,
          expected,
          port,
          attempts,
          intervalMs,
          attempt + 1,
        ),
      );
    }
    if (result.status !== "completed") {
      if (attempt + 1 >= attempts)
        return errAsync({
          type: "AttestationPending" as const,
          runId,
          attempts,
        });
      return delay(intervalMs).andThen(() =>
        pollAttestation(
          runId,
          expected,
          port,
          attempts,
          intervalMs,
          attempt + 1,
        ),
      );
    }
    return verifyAttestationResult(result, expected).asyncAndThen((value) =>
      okAsync(value),
    );
  });
}

function delay(
  milliseconds: number,
): ResultAsyncType<void, AttestationGateError> {
  return ResultAsync.fromPromise(
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
    (cause): AttestationGateError => ({
      type: "AttestationDispatchFailed",
      reason: String(cause),
    }),
  );
}

export function assertStableChainOrder(
  needs: Readonly<
    Partial<Record<StablePublishChainStep, readonly StablePublishChainStep[]>>
  >,
): Result<void, { type: "InvalidStableChainOrder"; reason: string }> {
  for (const [step, expected] of Object.entries(STABLE_PUBLISH_CHAIN_NEEDS) as [
    StablePublishChainStep,
    readonly StablePublishChainStep[],
  ][]) {
    const actual = needs[step];
    if (actual === undefined)
      return err({
        type: "InvalidStableChainOrder",
        reason: `${step} is missing`,
      });
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      return err({
        type: "InvalidStableChainOrder",
        reason: `${step} must need ${expected.join(",") || "nothing"}`,
      });
  }
  return ok(undefined);
}

/** A small helper used by workflow entry tests and by dry-run orchestration. */
export function publishMayRun(input: {
  readonly rolloutMode: "disabled" | "dry-run" | "enabled";
  readonly attestation: unknown;
  readonly expectation: AttestationExpectation;
}): Result<boolean, AttestationGateError | { type: "RolloutDisabled" }> {
  if (input.rolloutMode === "disabled") return err({ type: "RolloutDisabled" });
  const verified = verifyAttestationResult(
    input.attestation,
    input.expectation,
  );
  return verified.map(() => input.rolloutMode === "enabled");
}
