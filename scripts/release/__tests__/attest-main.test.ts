import { describe, expect, it } from "bun:test";
import {
  buildAttestationCheck,
  validateAttestMainRequest,
  verifyAttestationIdentity,
} from "../attest-main.js";

const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const request = {
  schemaVersion: 1,
  sourceRunId: 10,
  artifactId: 20,
  releasedSha: SHA,
  planDigest: DIGEST,
  tarballDigests: [{ packageName: "@weaveio/weave-cli", sha256: DIGEST }],
};
const observed = {
  sourceSha: SHA,
  planDigest: DIGEST,
  tarballDigests: [{ packageName: "@weaveio/weave-cli", sha256: DIGEST }],
};

describe("independent attestation controller", () => {
  it("accepts bounded nonsecret identifiers and independently matching bytes", () => {
    expect(validateAttestMainRequest(request).isOk()).toBe(true);
    const verified = verifyAttestationIdentity(request, observed);
    expect(verified.isOk()).toBe(true);
    if (verified.isOk()) {
      const check = buildAttestationCheck(
        request,
        verified.value,
        { "@weaveio/weave-cli": "cli.tgz" },
        99,
      );
      expect(check._unsafeUnwrap()).toMatchObject({
        check: {
          checkRunId: 99,
          releasedSha: SHA,
          planDigest: DIGEST,
        },
        subjects: [{ subjectPath: "cli.tgz" }],
      });
    }
  });

  it.each([
    [
      "source",
      { ...observed, sourceSha: "c".repeat(40) },
      "AttestationSourceMismatch",
    ],
    [
      "plan",
      { ...observed, planDigest: `sha256:${"c".repeat(64)}` },
      "AttestationPlanMismatch",
    ],
    [
      "tarball",
      {
        ...observed,
        tarballDigests: [
          {
            packageName: "@weaveio/weave-cli",
            sha256: `sha256:${"c".repeat(64)}`,
          },
        ],
      },
      "AttestationTarballMismatch",
    ],
  ] as const)("rejects independent %s identity mismatch", (_name, candidate, type) => {
    const result = verifyAttestationIdentity(request, candidate);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe(type);
  });

  it("rejects malformed and oversized carriers", () => {
    expect(
      validateAttestMainRequest({ ...request, artifactId: 0 }).isErr(),
    ).toBe(true);
    expect(
      validateAttestMainRequest("x".repeat(200_000))._unsafeUnwrapErr().type,
    ).toBe("AttestationInputTooLarge");
  });
});
