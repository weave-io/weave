import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import {
  ATTESTATION_CHECK_NAME,
  type AttestationCheckResult,
  type AttestationExpectation,
  type AttestationGateError,
  type AttestationPollPort,
  assertStableChainOrder,
  awaitAttestation,
  STABLE_PUBLISH_CHAIN,
  STABLE_PUBLISH_CHAIN_NEEDS,
  verifyAttestationResult,
} from "../publish-chain.js";

const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const EXPECTATION: AttestationExpectation = {
  releasedSha: SHA,
  planDigest: DIGEST,
  tarballDigests: [{ packageName: "@weaveio/weave-cli", sha256: DIGEST }],
};
const REQUEST = { ...EXPECTATION, sourceRunId: 10, artifactId: 20 };

function result(
  overrides: Partial<AttestationCheckResult> = {},
): AttestationCheckResult {
  return {
    checkRunId: 42,
    name: ATTESTATION_CHECK_NAME,
    status: "completed",
    conclusion: "success",
    releasedSha: SHA,
    planDigest: DIGEST,
    subjects: [{ packageName: "@weaveio/weave-cli", subjectDigest: DIGEST }],
    ...overrides,
  };
}

function port(
  reads: readonly (AttestationCheckResult | null)[],
): AttestationPollPort {
  let index = 0;
  return {
    dispatch: () => okAsync({ runId: 42 }),
    read: () => okAsync(reads[Math.min(index++, reads.length - 1)] ?? null),
  };
}

describe("stable publish chain", () => {
  it("keeps the exact ordered graph", () => {
    expect(STABLE_PUBLISH_CHAIN).toEqual([
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
    ]);
    expect(assertStableChainOrder(STABLE_PUBLISH_CHAIN_NEEDS).isOk()).toBe(
      true,
    );
  });

  const blockedCases: readonly [
    string,
    readonly (AttestationCheckResult | null)[],
    AttestationGateError["type"],
  ][] = [
    ["missing", [null], "AttestationMissing"],
    [
      "pending",
      [
        {
          ...result(),
          status: "in_progress",
          conclusion: null,
        } as AttestationCheckResult,
      ],
      "AttestationPending",
    ],
    [
      "failed",
      [{ ...result(), conclusion: "failure" } as AttestationCheckResult],
      "AttestationFailed",
    ],
    [
      "source mismatch",
      [{ ...result(), releasedSha: "c".repeat(40) } as AttestationCheckResult],
      "AttestationDigestMismatch",
    ],
    [
      "plan mismatch",
      [
        {
          ...result(),
          planDigest: `sha256:${"c".repeat(64)}`,
        } as AttestationCheckResult,
      ],
      "AttestationDigestMismatch",
    ],
    [
      "tarball mismatch",
      [
        {
          ...result(),
          subjects: [
            {
              packageName: "@weaveio/weave-cli",
              subjectDigest: `sha256:${"c".repeat(64)}`,
            },
          ],
        } as AttestationCheckResult,
      ],
      "AttestationDigestMismatch",
    ],
  ];
  for (const [name, reads, type] of blockedCases)
    it(`blocks before downstream proof on ${name}`, async () => {
      const outcome = await awaitAttestation(REQUEST, port(reads), {
        attempts: 1,
        intervalMs: 0,
      });
      expect(outcome.isErr()).toBe(true);
      if (outcome.isErr()) expect(outcome.error.type).toBe(type);
    });

  it("accepts only the exact completed digest-bound check", async () => {
    const outcome = await awaitAttestation(REQUEST, port([result()]), {
      attempts: 1,
      intervalMs: 0,
    });
    expect(outcome.isOk()).toBe(true);
    expect(verifyAttestationResult(result(), EXPECTATION).isOk()).toBe(true);
  });

  it("does not hide a dispatch failure", async () => {
    const failing: AttestationPollPort = {
      dispatch: () =>
        errAsync({
          type: "AttestationDispatchFailed" as const,
          reason: "network",
        }),
      read: () => okAsync(null),
    };
    const outcome = await awaitAttestation(REQUEST, failing, {
      attempts: 1,
      intervalMs: 0,
    });
    expect(outcome._unsafeUnwrapErr()).toEqual({
      type: "AttestationDispatchFailed",
      reason: "network",
    });
  });
});
