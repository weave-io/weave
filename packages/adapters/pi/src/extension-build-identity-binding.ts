import { err, ok, Result } from "neverthrow";
import type {
  ExtensionBuildIdentityError,
  ExtensionBuildOutputDigest,
} from "./extension-build-identity-types.js";
import {
  EXTENSION_BUILD_IDENTITY_SCHEMA_VERSION,
  EXTENSION_RUNTIME_OUTPUT_NAMES,
  MAX_EXTENSION_BUILD_INPUTS,
} from "./extension-build-identity-types.js";
import {
  isCanonicalRuntimeOutputList,
  isGitSubject,
  isSafeTimestamp,
  isSha256,
  parseSha256List,
} from "./extension-build-identity-validation.js";

function canonicalBuildBindingInput(input: {
  readonly buildCompletedAt: string;
  readonly buildInputs: readonly string[];
  readonly dirty: boolean;
  readonly runtimeOutputs: readonly ExtensionBuildOutputDigest[];
  readonly subject: string;
}): string {
  return JSON.stringify({
    schemaVersion: EXTENSION_BUILD_IDENTITY_SCHEMA_VERSION,
    git: { subject: input.subject, dirty: input.dirty },
    buildInputs: [...input.buildInputs],
    buildCompletedAt: input.buildCompletedAt,
    runtimeOutputs: EXTENSION_RUNTIME_OUTPUT_NAMES.map((name) => ({
      name,
      sha256: input.runtimeOutputs.find((candidate) => candidate.name === name)
        ?.sha256,
    })),
  });
}

/**
 * Compute the build binding over the placeholder-normalized runtime graph.
 * The entry is normalized by the trusted preloader before it calls this same
 * canonicalization rule; the build pipeline calls it before replacing the
 * placeholder with the resulting digest.
 */
export function computeExtensionBuildBinding(input: {
  readonly buildCompletedAt: string;
  readonly buildInputs: readonly string[];
  readonly dirty: boolean;
  readonly runtimeOutputs: readonly ExtensionBuildOutputDigest[];
  readonly subject: string;
}): Result<string, ExtensionBuildIdentityError> {
  if (
    !isSafeTimestamp(input.buildCompletedAt) ||
    !isGitSubject(input.subject) ||
    parseSha256List(input.buildInputs, MAX_EXTENSION_BUILD_INPUTS) ===
      undefined ||
    !isCanonicalRuntimeOutputList(input.runtimeOutputs)
  ) {
    return err({ type: "ManifestMalformed" });
  }
  const canonical = canonicalBuildBindingInput(input);
  const encoded = Result.fromThrowable(
    () => new TextEncoder().encode(canonical),
    (): ExtensionBuildIdentityError => ({ type: "DigestFailed" }),
  )();
  return encoded.andThen(sha256Hex);
}

/** Hash bytes with the one algorithm allowed by the identity contract. */
export function sha256Hex(
  bytes: Uint8Array | ArrayBuffer,
): Result<string, ExtensionBuildIdentityError> {
  const value = Result.fromThrowable(
    () =>
      new Bun.CryptoHasher("sha256")
        .update(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes)
        .digest("hex"),
    (): ExtensionBuildIdentityError => ({ type: "DigestFailed" }),
  )();
  if (value.isErr() || !isSha256(value.value)) {
    return err({ type: "DigestFailed" });
  }
  return ok(value.value);
}
