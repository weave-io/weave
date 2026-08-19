import { describe, expect, test } from "bun:test";
import {
  parseValidationReport,
  proofChainFromValidationReport,
  RELEASE_ATTESTATION_CONTRACT,
  RELEASE_ATTESTATION_PERMISSION_MAP,
  renderValidationSummary,
  serializeValidationReport,
  type ValidationReport,
  validateAttestationWorkflowContract,
  validateReleaseAttestationRequest,
  validateValidationReport,
} from "../validation-report.js";

const CLI = "@weaveio/weave-cli" as const;
const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const URL = "https://github.com/weave-io/weave/attestations/123";

function report(): ValidationReport {
  return {
    schemaVersion: 1,
    releasedSha: SHA,
    planDigest: DIGEST,
    attestation: {
      sourceRunId: 42,
      artifactId: 1234,
      checkRunId: 5678,
      sourceSha: SHA,
      planDigest: DIGEST,
      subjects: [
        { packageName: CLI, subjectDigest: DIGEST, id: "att-1", url: URL },
      ],
    },
    publication: {
      schemaVersion: 1,
      channel: "stable",
      tag: "latest",
      releasedSha: SHA,
      members: [
        {
          packageName: CLI,
          version: "0.1.0",
          tarballSha256: DIGEST,
          status: "published",
          verification: "digest-verified",
        },
      ],
    },
    packages: [
      {
        packageName: CLI,
        version: "0.1.0",
        tarballSha256: DIGEST,
        npmProvenanceUrl:
          "https://www.npmjs.com/package/@weaveio%2Fweave-cli/provenance",
        attestation: { id: "att-1", subjectDigest: DIGEST, url: URL },
        cleanConsumer: {
          status: "passed",
          digest: DIGEST,
          summary: "clean consumer passed",
        },
        harnessProof: {
          status: "not-required",
          summary: "CLI has no adapter harness",
        },
        proofMarkers: {
          attestation: { status: "recorded", digest: DIGEST },
          cleanConsumer: { status: "recorded", digest: DIGEST },
          harnessProof: { status: "not-required" },
        },
      },
    ],
  };
}

const unwrap = <T>(result: {
  isOk(): boolean;
  value?: T;
  error?: unknown;
}): T => {
  if (!result.isOk()) throw result.error;
  return result.value as T;
};

describe("validation report", () => {
  test("round trips strict canonical data and renders a deterministic summary", () => {
    const serialized = unwrap(serializeValidationReport(report()));
    expect(unwrap(parseValidationReport(serialized))).toEqual(report());
    expect(unwrap(serializeValidationReport(JSON.parse(serialized)))).toBe(
      serialized,
    );
    expect(unwrap(renderValidationSummary(report()))).toMatchInlineSnapshot(`
      "Release validation report
      releasedSha: ${SHA}
      attestation: artifact 1234, check 5678
      packages:
      - @weaveio/weave-cli@0.1.0: ${DIGEST}; publication=published; attestation=passed; consumer=passed; harness=not-required
      "
    `);
  });

  test("rejects foreign digests, duplicate subjects, and extra fields", () => {
    const foreign = report();
    foreign.packages[0].cleanConsumer.digest = `sha256:${"c".repeat(64)}`;
    expect(validateValidationReport(foreign).isErr()).toBe(true);
    const duplicate = report();
    duplicate.attestation.subjects.push({
      ...duplicate.attestation.subjects[0],
      id: "att-2",
    });
    expect(validateValidationReport(duplicate).isErr()).toBe(true);
    expect(validateValidationReport({ ...report(), extra: true }).isErr()).toBe(
      true,
    );
  });

  test("converts exact proof markers to Task 11's refusal contract", () => {
    const chain = unwrap(proofChainFromValidationReport(report()));
    expect(chain.markers[0]).toMatchObject({
      packageName: CLI,
      tarballSha256: DIGEST,
    });
    const missing = report();
    missing.packages[0].proofMarkers.cleanConsumer = {
      status: "pending",
    } as never;
    expect(validateValidationReport(missing).isErr()).toBe(true);
  });

  test("defines the independent attestation contract and exact permissions", () => {
    expect(RELEASE_ATTESTATION_CONTRACT.reusable).toBe(false);
    expect(RELEASE_ATTESTATION_CONTRACT.workflowPath).toBe(
      ".github/workflows/release-attest.yml",
    );
    expect(RELEASE_ATTESTATION_PERMISSION_MAP.workflow).toEqual({});
    expect(RELEASE_ATTESTATION_PERMISSION_MAP.job).toEqual({
      contents: "read",
      actions: "read",
      checks: "write",
      "id-token": "write",
      attestations: "write",
    });
    expect(
      validateAttestationWorkflowContract(RELEASE_ATTESTATION_CONTRACT).isOk(),
    ).toBe(true);
    expect(
      validateReleaseAttestationRequest({
        schemaVersion: 1,
        sourceRunId: 1,
        artifactId: 100,
        releasedSha: SHA,
        planDigest: DIGEST,
        tarballDigests: [{ packageName: CLI, sha256: DIGEST }],
      }).isOk(),
    ).toBe(true);
    expect(
      validateReleaseAttestationRequest({
        schemaVersion: 1,
        sourceRunId: 1,
        artifactId: "100",
        releasedSha: SHA,
        planDigest: DIGEST,
        tarballDigests: [{ packageName: CLI, sha256: DIGEST }],
      }).isErr(),
    ).toBe(true);
  });

  test("rejects malformed URLs and bounded input", () => {
    const malformed = report();
    malformed.packages[0].npmProvenanceUrl = "http://example.com/provenance";
    expect(validateValidationReport(malformed).isErr()).toBe(true);
    const oversized = report();
    oversized.packages[0].cleanConsumer.summary = "x".repeat(513);
    expect(validateValidationReport(oversized).isErr()).toBe(true);
    expect(parseValidationReport("x".repeat(128 * 1024 + 1)).isErr()).toBe(
      true,
    );
  });
});
