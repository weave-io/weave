import { err, errAsync, ok, type Result, type ResultAsync } from "neverthrow";
import { EXTENSION_RUNTIME_OUTPUT_NAMES } from "../../packages/adapters/pi/src/extension-build-identity.js";
import {
  blocked,
  type ChildStreamingEvidenceClass,
  type IdentityVerificationFacts,
  type IdentityVerificationSuccess,
  type VerifyChildStreamingFailure,
} from "./child-stream-verify-types.js";

function equalStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function hasExactLogicalOutputs(
  outputs: readonly { readonly name: string; readonly sha256: string }[],
  expectedNames: readonly string[],
): boolean {
  if (outputs.length !== expectedNames.length) return false;
  const expected = new Set(expectedNames);
  const seen = new Set<string>();
  for (const output of outputs) {
    if (
      !expected.has(output.name) ||
      seen.has(output.name) ||
      !isSha256(output.sha256)
    ) {
      return false;
    }
    seen.add(output.name);
  }
  return seen.size === expected.size;
}

function outputDigest(
  facts: IdentityVerificationFacts,
  name: string,
): string | undefined {
  return facts.manifest.outputs.find((output) => output.name === name)?.sha256;
}

/**
 * Pure identity gate used by the CLI and by later child-streaming checks. It
 * does not trust mtimes, the sidecar alone, or a loaded digest alone.
 */
export function verifyIdentityFacts(
  input: IdentityVerificationFacts,
): Result<IdentityVerificationSuccess, VerifyChildStreamingFailure> {
  if (
    input.currentSubject !== input.manifest.git.subject ||
    input.currentDirty !== input.manifest.git.dirty
  ) {
    return err(blocked("git-mismatch", "manifest-mismatch"));
  }
  if (
    input.manifest.buildBinding === undefined ||
    !/^[0-9a-f]{64}$/u.test(input.manifest.buildBinding)
  ) {
    return err(blocked("unverifiable", "unverifiable"));
  }
  if (
    !equalStrings(input.currentBuildInputs, input.manifest.buildInputs) ||
    input.currentBuildInputs.some((digest) => !isSha256(digest))
  ) {
    return err(blocked("source-mismatch", "manifest-mismatch"));
  }
  if (
    !hasExactLogicalOutputs(
      input.currentOutputs,
      input.manifest.outputs.map((output) => output.name),
    )
  ) {
    return err(blocked("unverifiable", "unverifiable"));
  }

  const extensionOutput = input.currentOutputs.find(
    (output) => output.name === "extension",
  );
  if (extensionOutput === undefined) {
    return err(blocked("unverifiable", "unverifiable"));
  }
  const expectedExtension = outputDigest(input, "extension");
  if (expectedExtension === undefined) {
    return err(blocked("manifest-mismatch", "manifest-mismatch"));
  }
  if (extensionOutput.sha256 !== expectedExtension) {
    return err(blocked("output-mismatch", "manifest-mismatch"));
  }
  for (const expected of input.manifest.outputs) {
    const actual = input.currentOutputs.find(
      (output) => output.name === expected.name,
    );
    if (actual === undefined) {
      return err(blocked("unverifiable", "unverifiable"));
    }
    if (actual.sha256 !== expected.sha256) {
      return err(blocked("output-mismatch", "manifest-mismatch"));
    }
  }

  const loaded = input.loadedProof;
  if (
    loaded === undefined ||
    loaded.artifactSha256 === undefined ||
    !isSha256(loaded.artifactSha256) ||
    loaded.loadedOutputs === undefined ||
    loaded.buildBinding === undefined ||
    loaded.loadTimeMs === undefined ||
    loaded.processStartMs === undefined
  ) {
    return err(blocked("unverifiable", "unverifiable"));
  }
  if (
    !/^[0-9a-f]{64}$/u.test(loaded.buildBinding) ||
    loaded.buildBinding !== input.manifest.buildBinding
  ) {
    return err(blocked("unverifiable", "unverifiable"));
  }
  if (
    loaded.loadedOutputs.length !== EXTENSION_RUNTIME_OUTPUT_NAMES.length ||
    loaded.loadedOutputs.some(
      (output, index) =>
        output.name !== EXTENSION_RUNTIME_OUTPUT_NAMES[index] ||
        !/^[0-9a-f]{64}$/u.test(output.sha256),
    )
  ) {
    return err(blocked("unverifiable", "unverifiable"));
  }
  if (loaded.artifactSha256 !== extensionOutput.sha256) {
    return err(blocked("stale-on-disk", "stale-on-disk"));
  }
  for (const name of EXTENSION_RUNTIME_OUTPUT_NAMES) {
    const current = input.currentOutputs.find((output) => output.name === name);
    const loadedOutput = loaded.loadedOutputs.find(
      (output) => output.name === name,
    );
    const expected = outputDigest(input, name);
    if (current === undefined || loadedOutput === undefined) {
      return err(blocked("unverifiable", "unverifiable"));
    }
    if (loadedOutput.sha256 !== current.sha256) {
      return err(blocked("stale-on-disk", "stale-on-disk"));
    }
    if (expected === undefined || current.sha256 !== expected) {
      return err(blocked("output-mismatch", "manifest-mismatch"));
    }
  }
  const completedAtMs = Date.parse(input.manifest.buildCompletedAt);
  const nowMs = input.nowMs ?? Date.now();
  if (
    !Number.isFinite(completedAtMs) ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !Number.isSafeInteger(loaded.loadTimeMs) ||
    !Number.isSafeInteger(loaded.processStartMs) ||
    loaded.processStartMs > loaded.loadTimeMs ||
    completedAtMs > loaded.loadTimeMs ||
    loaded.loadTimeMs > nowMs + 5_000
  ) {
    return err(blocked("unverifiable", "unverifiable"));
  }

  return ok({
    state: "current",
    evidence: "identity-proven",
    subject: input.manifest.git.subject,
    dirty: input.manifest.git.dirty,
    artifactSha256: extensionOutput.sha256,
    loadTimeMs: loaded.loadTimeMs,
    processStartMs: loaded.processStartMs,
  });
}

/** Refuse all later UI checks until the identity gate has passed. */
export function runAfterIdentity<T, E>(
  identity: Result<IdentityVerificationSuccess, VerifyChildStreamingFailure>,
  check: (proof: IdentityVerificationSuccess) => ResultAsync<T, E>,
): ResultAsync<T, VerifyChildStreamingFailure | E> {
  if (identity.isErr()) return errAsync(identity.error);
  return check(identity.value);
}

/**
 * Distinguishes historical stale-parent screenshots, the current post-build
 * RED reproduction, and a future identity-proven green proof. Identity
 * failure is never a UI result.
 */
export function classifyChildStreamingEvidence(input: {
  readonly identity: Result<
    IdentityVerificationSuccess,
    VerifyChildStreamingFailure
  >;
  readonly uiLanes?: "red" | "green";
}): ChildStreamingEvidenceClass | "blocked" {
  if (input.identity.isErr()) {
    return input.identity.error.state === "stale-on-disk"
      ? "stale-screenshot"
      : "blocked";
  }
  if (input.uiLanes === "red") return "post-build-red-reproduction";
  return "identity-proven";
}
