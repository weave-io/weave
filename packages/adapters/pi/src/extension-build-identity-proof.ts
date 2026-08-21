import { err, ok, Result } from "neverthrow";
import type {
  ExtensionBuildIdentityError,
  ExtensionBuildIdentityHealth,
  ExtensionBuildIdentityProof,
  ExtensionBuildIdentityProofLine,
  ExtensionBuildIdentityReason,
  ExtensionBuildOutputDigest,
  ExtensionLoadedIdentity,
} from "./extension-build-identity-types.js";
import {
  EXTENSION_BUILD_IDENTITY_PROOF_ENV,
  EXTENSION_BUILD_IDENTITY_SCHEMA_VERSION,
  MAX_EXTENSION_BUILD_IDENTITY_LINE_LENGTH,
  MAX_EXTENSION_BUILD_INPUTS,
  MAX_EXTENSION_BUILD_OUTPUTS,
} from "./extension-build-identity-types.js";
import {
  isGitSubject,
  isRecord,
  isSafeMilliseconds,
  isSafeTimestamp,
  isSha256,
  parseOutputDigestList,
} from "./extension-build-identity-validation.js";

function boundedHash(value: string | undefined): string {
  return value === undefined || !isSha256(value) ? "unknown" : value;
}

function boundedMilliseconds(value: number | undefined): string {
  return value === undefined || !isSafeMilliseconds(value)
    ? "unknown"
    : String(value);
}

function boundedSubject(value: string | undefined): string {
  return isGitSubject(value) ? value : "unknown";
}

function boundedTimestamp(value: string | undefined): string {
  return value !== undefined && isSafeTimestamp(value) ? value : "unknown";
}

function boundedReason(
  value: ExtensionBuildIdentityReason | undefined,
): string {
  return value !== undefined && /^[a-z0-9-]{1,64}$/u.test(value)
    ? value
    : "unknown";
}

function boundedDirty(value: boolean | undefined): string {
  if (value === true) return "true";
  if (value === false) return "false";
  return "unknown";
}

function boundedOutputDigests(
  value: readonly ExtensionBuildOutputDigest[] | undefined,
): string {
  const outputs = parseOutputDigestList(value);
  if (outputs === undefined) return "unknown";
  return outputs
    .slice(0, MAX_EXTENSION_BUILD_OUTPUTS)
    .map((output) => `${output.name}:${output.sha256}`)
    .join(",");
}

/** Render exact bounded identity facts without any filesystem path. */
export function renderExtensionBuildIdentityHealthLine(
  health: ExtensionBuildIdentityHealth,
): string {
  const inputCount =
    health.sourceInputCount !== undefined &&
    Number.isSafeInteger(health.sourceInputCount) &&
    health.sourceInputCount >= 0
      ? Math.min(health.sourceInputCount, MAX_EXTENSION_BUILD_INPUTS)
      : "unknown";
  const state =
    health.state === "current" ||
    health.state === "stale-on-disk" ||
    health.state === "manifest-mismatch" ||
    health.state === "unverifiable"
      ? health.state
      : "unverifiable";
  const line = [
    `extension identity: ${state}`,
    `loaded=${boundedHash(health.loadedArtifactSha256)}`,
    `disk=${boundedHash(health.diskArtifactSha256)}`,
    `manifest=${boundedHash(health.manifestArtifactSha256)}`,
    `load-ms=${boundedMilliseconds(health.loadTimeMs)}`,
    `process-start-ms=${boundedMilliseconds(health.processStartMs)}`,
    `build-complete=${boundedTimestamp(health.buildCompletedAt)}`,
    `inputs=${inputCount}`,
    `subject=${boundedSubject(health.gitSubject)}`,
    `dirty=${boundedDirty(health.gitDirty)}`,
    `loaded-outputs=${boundedOutputDigests(health.loadedOutputs)}`,
    `disk-outputs=${boundedOutputDigests(health.diskOutputs)}`,
    ...(health.reason === undefined
      ? []
      : [`reason=${boundedReason(health.reason)}`]),
  ].join("; ");
  return line.length <= MAX_EXTENSION_BUILD_IDENTITY_LINE_LENGTH
    ? line
    : line.slice(0, MAX_EXTENSION_BUILD_IDENTITY_LINE_LENGTH);
}

/** Render the opt-in, path-free machine proof emitted by the loader. */
export function renderExtensionBuildIdentityProofLine(
  identity: ExtensionLoadedIdentity,
): string {
  const loadedOutputs = parseOutputDigestList(identity.loadedOutputs);
  const proof: ExtensionBuildIdentityProofLine = {
    weaveExtensionBuildIdentity: {
      schemaVersion: EXTENSION_BUILD_IDENTITY_SCHEMA_VERSION,
      ...(identity.artifactSha256 === undefined
        ? {}
        : { artifactSha256: boundedHash(identity.artifactSha256) }),
      ...(loadedOutputs === undefined ? {} : { loadedOutputs }),
      ...(identity.buildBinding === undefined
        ? {}
        : { buildBinding: boundedHash(identity.buildBinding) }),
      ...(identity.loadTimeMs === undefined
        ? {}
        : {
            loadTimeMs:
              boundedMilliseconds(identity.loadTimeMs) === "unknown"
                ? undefined
                : identity.loadTimeMs,
          }),
      ...(isSafeMilliseconds(identity.processStartMs)
        ? { processStartMs: identity.processStartMs }
        : {}),
    },
  };
  const line = JSON.stringify(proof);
  return line.length <= MAX_EXTENSION_BUILD_IDENTITY_LINE_LENGTH
    ? line
    : JSON.stringify({
        weaveExtensionBuildIdentity: {
          schemaVersion: EXTENSION_BUILD_IDENTITY_SCHEMA_VERSION,
        },
      });
}

/** Parse the proof line independently of the runtime health renderer. */
export function parseExtensionBuildIdentityProof(
  value: unknown,
): Result<ExtensionBuildIdentityProof, ExtensionBuildIdentityError> {
  if (!isRecord(value)) return err({ type: "ManifestMalformed" });
  const raw = value.weaveExtensionBuildIdentity;
  if (!isRecord(raw)) return err({ type: "ManifestMalformed" });
  if (raw.schemaVersion !== EXTENSION_BUILD_IDENTITY_SCHEMA_VERSION) {
    return err({ type: "ManifestMalformed" });
  }
  if (raw.artifactSha256 !== undefined && !isSha256(raw.artifactSha256)) {
    return err({ type: "ManifestMalformed" });
  }
  if (raw.buildBinding !== undefined && !isSha256(raw.buildBinding)) {
    return err({ type: "ManifestMalformed" });
  }
  if (raw.loadTimeMs !== undefined && !isSafeMilliseconds(raw.loadTimeMs)) {
    return err({ type: "ManifestMalformed" });
  }
  if (
    raw.processStartMs !== undefined &&
    !isSafeMilliseconds(raw.processStartMs)
  ) {
    return err({ type: "ManifestMalformed" });
  }
  const loadedOutputs =
    raw.loadedOutputs === undefined
      ? undefined
      : parseOutputDigestList(raw.loadedOutputs);
  if (raw.loadedOutputs !== undefined && loadedOutputs === undefined) {
    return err({ type: "ManifestMalformed" });
  }
  return ok({
    schemaVersion: EXTENSION_BUILD_IDENTITY_SCHEMA_VERSION,
    ...(raw.artifactSha256 === undefined
      ? {}
      : { artifactSha256: raw.artifactSha256 }),
    ...(loadedOutputs === undefined ? {} : { loadedOutputs }),
    ...(raw.buildBinding === undefined
      ? {}
      : { buildBinding: raw.buildBinding }),
    ...(raw.loadTimeMs === undefined ? {} : { loadTimeMs: raw.loadTimeMs }),
    ...(raw.processStartMs === undefined
      ? {}
      : { processStartMs: raw.processStartMs }),
  });
}

function writeProofLineToStderr(line: string): void {
  Result.fromThrowable(
    (): void => {
      const written = Bun.stderr.write(`${line}\n`);
      if (written instanceof Promise) void written;
    },
    () => undefined,
  )();
}

/** Write one proof line only for the explicit verifier opt-in. */
export function maybeWriteExtensionBuildIdentityProofLine(
  identity: ExtensionLoadedIdentity,
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly proofWrite?: (line: string) => void;
  } = {},
): boolean {
  const env = options.env ?? Bun.env;
  if (env[EXTENSION_BUILD_IDENTITY_PROOF_ENV] !== "1") return false;
  (options.proofWrite ?? writeProofLineToStderr)(
    renderExtensionBuildIdentityProofLine(identity),
  );
  return true;
}
