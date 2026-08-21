import {
  err,
  errAsync,
  ok,
  okAsync,
  Result,
  type ResultAsync,
} from "neverthrow";
import { sha256Hex } from "./extension-build-identity-binding.js";
import type {
  ExtensionBuildIdentityError,
  ExtensionBuildIdentityManifest,
} from "./extension-build-identity-types.js";
import {
  EXTENSION_BUILD_IDENTITY_SCHEMA_VERSION,
  MAX_EXTENSION_BUILD_MANIFEST_BYTES,
  MAX_EXTENSION_BUILD_OUTPUT_BYTES,
} from "./extension-build-identity-types.js";
import {
  isGitSubject,
  isRecord,
  isSafeTimestamp,
  isSha256,
  parseOutputDigestList,
  parseSha256List,
} from "./extension-build-identity-validation.js";
import { readAbsoluteFileBounded } from "./path-containment.js";

/** Parse and validate a bounded path-free manifest. */
export function parseExtensionBuildManifest(
  value: unknown,
): Result<ExtensionBuildIdentityManifest, ExtensionBuildIdentityError> {
  if (
    !isRecord(value) ||
    value.schemaVersion !== EXTENSION_BUILD_IDENTITY_SCHEMA_VERSION
  ) {
    return err({ type: "ManifestMalformed" });
  }
  const record = value;
  const git = record.git;
  if (!isRecord(git)) {
    return err({ type: "ManifestMalformed" });
  }
  const gitRecord = git;
  if (
    !isGitSubject(gitRecord.subject) ||
    typeof gitRecord.dirty !== "boolean"
  ) {
    return err({ type: "ManifestMalformed" });
  }

  const buildInputs = parseSha256List(record.buildInputs);
  if (buildInputs === undefined) {
    return err({ type: "ManifestMalformed" });
  }
  const outputs = parseOutputDigestList(record.outputs);
  if (outputs === undefined) {
    return err({ type: "ManifestMalformed" });
  }
  if (!isSafeTimestamp(record.buildCompletedAt)) {
    return err({ type: "ManifestMalformed" });
  }
  if (!isSha256(record.buildBinding)) {
    return err({ type: "ManifestMalformed" });
  }

  return ok({
    schemaVersion: EXTENSION_BUILD_IDENTITY_SCHEMA_VERSION,
    buildBinding: record.buildBinding,
    git: { subject: gitRecord.subject, dirty: gitRecord.dirty },
    buildInputs,
    outputs,
    buildCompletedAt: record.buildCompletedAt,
  });
}

/** Render a manifest and enforce its byte/field bounds before writing it. */
export function renderExtensionBuildManifest(
  manifest: ExtensionBuildIdentityManifest,
): Result<string, ExtensionBuildIdentityError> {
  const parsed = parseExtensionBuildManifest(manifest);
  if (parsed.isErr()) return err(parsed.error);
  const rendered = Result.fromThrowable(
    () => `${JSON.stringify(parsed.value)}\n`,
    (): ExtensionBuildIdentityError => ({ type: "ManifestMalformed" }),
  )();
  if (rendered.isErr()) return err(rendered.error);
  if (
    new TextEncoder().encode(rendered.value).byteLength >
    MAX_EXTENSION_BUILD_MANIFEST_BYTES
  ) {
    return err({ type: "ManifestMalformed" });
  }
  return ok(rendered.value);
}

/**
 * Build a canonical manifest from hash values. Output names are logical names,
 * not file paths, and both collections are sorted before they are retained.
 */
export function createExtensionBuildManifest(input: {
  readonly subject: string;
  readonly dirty: boolean;
  readonly buildBinding: string;
  readonly buildInputs: readonly string[];
  readonly outputs: readonly {
    readonly name: string;
    readonly sha256: string;
  }[];
  readonly buildCompletedAt?: string;
}): Result<ExtensionBuildIdentityManifest, ExtensionBuildIdentityError> {
  const buildCompletedAt = input.buildCompletedAt ?? new Date().toISOString();
  const outputs = [...input.outputs].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const manifest = {
    schemaVersion: EXTENSION_BUILD_IDENTITY_SCHEMA_VERSION,
    buildBinding: input.buildBinding,
    git: { subject: input.subject, dirty: input.dirty },
    buildInputs: [...input.buildInputs].sort(),
    outputs,
    buildCompletedAt,
  } satisfies ExtensionBuildIdentityManifest;
  return parseExtensionBuildManifest(manifest);
}

/**
 * Read one identity file with a closed failure and a hard byte ceiling.
 *
 * The no-follow descriptor reader performs stat-before-allocation and requests
 * exactly `maxBytes + 1` bytes from the bounded slice. Callers choose the
 * closed identity error because manifests and artifacts classify failures
 * differently at their public boundary.
 */
export function readBoundedIdentityBytes(
  path: string,
  maxBytes: number,
  failure: "ArtifactReadFailed" | "ManifestReadFailed" = "ArtifactReadFailed",
  expectedCanonicalRoot?: string,
): ResultAsync<Uint8Array, ExtensionBuildIdentityError> {
  return readAbsoluteFileBounded(path, maxBytes, expectedCanonicalRoot).mapErr(
    (): ExtensionBuildIdentityError => ({ type: failure }),
  );
}

/** Read one artifact digest without allowing an exception to escape. */
export function readArtifactSha256(
  path: string,
  expectedCanonicalRoot?: string,
): ResultAsync<string, ExtensionBuildIdentityError> {
  return readBoundedIdentityBytes(
    path,
    MAX_EXTENSION_BUILD_OUTPUT_BYTES,
    "ArtifactReadFailed",
    expectedCanonicalRoot,
  ).andThen((bytes) => {
    const digest = sha256Hex(bytes);
    return digest.isOk() ? okAsync(digest.value) : errAsync(digest.error);
  });
}

/** Parse a manifest text value with a bounded UTF-8 size check. */
export function parseExtensionBuildManifestText(
  text: string,
): Result<ExtensionBuildIdentityManifest, ExtensionBuildIdentityError> {
  if (
    new TextEncoder().encode(text).byteLength >
    MAX_EXTENSION_BUILD_MANIFEST_BYTES
  ) {
    return err({ type: "ManifestMalformed" });
  }
  const parsed = Result.fromThrowable(
    () => JSON.parse(text) as unknown,
    (): ExtensionBuildIdentityError => ({ type: "ManifestMalformed" }),
  )();
  return parsed.andThen(parseExtensionBuildManifest);
}
