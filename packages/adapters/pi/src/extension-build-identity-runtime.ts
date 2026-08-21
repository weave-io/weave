import { dirname, join } from "node:path";
import { errAsync, okAsync, Result, ResultAsync } from "neverthrow";
import {
  parseExtensionBuildManifestText,
  readArtifactSha256,
} from "./extension-build-identity-manifest.js";
import type {
  ExtensionBuildIdentityError,
  ExtensionBuildIdentityHealth,
  ExtensionBuildIdentityManifest,
  ExtensionBuildIdentityReason,
  ExtensionBuildIdentityState,
  ExtensionBuildOutputDigest,
  ExtensionLoadedIdentity,
  ExtensionRuntimeOutputName,
} from "./extension-build-identity-types.js";
import {
  EXTENSION_BUILD_MANIFEST_FILENAME,
  EXTENSION_RUNTIME_OUTPUT_FILES,
  EXTENSION_RUNTIME_OUTPUT_NAMES,
  MAX_EXTENSION_BUILD_MANIFEST_BYTES,
} from "./extension-build-identity-types.js";
import {
  hasEveryRuntimeOutput,
  isSafeMilliseconds,
  isSha256,
  outputDigest,
  outputDigestFromList,
  parseOutputDigestList,
} from "./extension-build-identity-validation.js";

/**
 * JavaScript outputs evaluated by the Pi extension loader. Declarations and
 * the package's CLI/index entries are not part of this runtime graph.
 *
 * File names stay an internal loader detail. Only the logical names and
 * digests cross the identity/proof boundary.
 */
const RUNTIME_OUTPUT_FILES: readonly {
  readonly name: ExtensionRuntimeOutputName;
  readonly fileName: string;
}[] = EXTENSION_RUNTIME_OUTPUT_NAMES.map((name) => ({
  name,
  fileName: EXTENSION_RUNTIME_OUTPUT_FILES[name],
}));

/** A stable process-start fact captured once when this module is evaluated. */
const PROCESS_START_MS = (() => {
  const origin = performance.timeOrigin;
  if (Number.isFinite(origin) && origin > 0) return Math.trunc(origin);
  const uptime = Result.fromThrowable(
    () => process.uptime(),
    () => undefined,
  )();
  if (uptime.isOk() && Number.isFinite(uptime.value)) {
    return Math.max(0, Math.trunc(Date.now() - uptime.value * 1_000));
  }
  return Date.now();
})();

function manifestFailureReason(
  error: ExtensionBuildIdentityError,
): ExtensionBuildIdentityReason {
  if (error.type === "ManifestReadFailed") return "manifest-read-failed";
  if (error.type === "ManifestMalformed") return "manifest-malformed";
  return "artifact-read-failed";
}

/** Return the immutable process-start fact used by the loader and verifier. */
export function extensionProcessStartMs(): number {
  return PROCESS_START_MS;
}

/** Construct a closed loader fact when the artifact cannot be read. */
export function unverifiableExtensionLoadIdentity(
  reason: ExtensionBuildIdentityReason = "artifact-path-missing",
): ExtensionLoadedIdentity {
  return {
    processStartMs: PROCESS_START_MS,
    loadReason: reason,
  };
}

function readRuntimeOutputDigests(
  artifactPath: string,
): ResultAsync<
  readonly ExtensionBuildOutputDigest[],
  ExtensionBuildIdentityError
> {
  let result = okAsync<
    ExtensionBuildOutputDigest[],
    ExtensionBuildIdentityError
  >([]);
  const artifactDirectory = dirname(artifactPath);
  for (const output of RUNTIME_OUTPUT_FILES) {
    const path =
      output.name === "extension"
        ? artifactPath
        : join(artifactDirectory, output.fileName);
    result = result.andThen((digests) =>
      readArtifactSha256(path).map((sha256) => [
        ...digests,
        { name: output.name, sha256 },
      ]),
    );
  }
  return result;
}

/**
 * Capture the exact bytes the extension loader is about to evaluate. The
 * entry and implementation are both recorded, so an unchanged thin loader
 * cannot hide a stale in-memory implementation.
 */
export function loadExtensionBuildIdentity(
  artifactPath: unknown,
): ResultAsync<ExtensionLoadedIdentity, never> {
  const loadTimeMs = Date.now();
  if (
    typeof artifactPath !== "string" ||
    artifactPath.length === 0 ||
    !artifactPath.startsWith("/")
  ) {
    return okAsync(unverifiableExtensionLoadIdentity("artifact-path-missing"));
  }
  return readRuntimeOutputDigests(artifactPath)
    .map((loadedOutputs) => ({
      artifactPath,
      artifactSha256: outputDigestFromList(loadedOutputs, "extension"),
      loadedOutputs,
      loadTimeMs,
      processStartMs: PROCESS_START_MS,
    }))
    .orElse(() =>
      okAsync({
        artifactPath,
        loadTimeMs,
        processStartMs: PROCESS_START_MS,
        loadReason: "artifact-read-failed" as const,
      }),
    );
}

function healthFromLoaded(
  loaded: ExtensionLoadedIdentity,
  state: ExtensionBuildIdentityState,
  extra: Partial<ExtensionBuildIdentityHealth> = {},
): ExtensionBuildIdentityHealth {
  const loadedOutputs = parseOutputDigestList(loaded.loadedOutputs);
  return {
    state,
    ...(loaded.artifactSha256 === undefined
      ? {}
      : { loadedArtifactSha256: loaded.artifactSha256 }),
    ...(loadedOutputs === undefined ? {} : { loadedOutputs }),
    ...(loaded.loadTimeMs === undefined
      ? {}
      : { loadTimeMs: loaded.loadTimeMs }),
    processStartMs: loaded.processStartMs,
    ...(loaded.loadReason === undefined ? {} : { reason: loaded.loadReason }),
    ...extra,
  };
}

/**
 * Classify all runtime identity states. The ordering is intentional: a disk
 * replacement is reported as stale before a sidecar disagreement, while a
 * missing fact is always unverifiable.
 */
export function evaluateExtensionBuildIdentity(input: {
  readonly loaded: ExtensionLoadedIdentity;
  readonly diskArtifactSha256?: string;
  readonly diskOutputs?: readonly ExtensionBuildOutputDigest[];
  readonly manifest?: ExtensionBuildIdentityManifest;
  readonly manifestReason?: ExtensionBuildIdentityReason;
}): ExtensionBuildIdentityHealth {
  const { loaded, diskArtifactSha256, manifest } = input;
  const loadedOutputs = parseOutputDigestList(loaded.loadedOutputs);
  if (
    loaded.artifactSha256 === undefined ||
    loaded.loadTimeMs === undefined ||
    !isSafeMilliseconds(loaded.loadTimeMs) ||
    !isSafeMilliseconds(loaded.processStartMs) ||
    !hasEveryRuntimeOutput(loadedOutputs)
  ) {
    return healthFromLoaded(loaded, "unverifiable", {
      reason:
        input.manifestReason ?? loaded.loadReason ?? "loaded-artifact-missing",
    });
  }

  const diskOutputDigests = parseOutputDigestList(input.diskOutputs);
  if (
    diskArtifactSha256 === undefined ||
    !isSha256(diskArtifactSha256) ||
    !hasEveryRuntimeOutput(diskOutputDigests)
  ) {
    return healthFromLoaded(loaded, "unverifiable", {
      reason: input.manifestReason ?? "artifact-read-failed",
    });
  }
  if (manifest === undefined) {
    return healthFromLoaded(loaded, "unverifiable", {
      diskArtifactSha256,
      diskOutputs: diskOutputDigests,
      reason: input.manifestReason ?? "manifest-malformed",
    });
  }

  if (loaded.buildBinding === undefined || !isSha256(loaded.buildBinding)) {
    return healthFromLoaded(loaded, "unverifiable", {
      diskArtifactSha256,
      diskOutputs: diskOutputDigests,
      reason: "build-binding-missing",
    });
  }
  if (manifest.buildBinding !== loaded.buildBinding) {
    return healthFromLoaded(loaded, "unverifiable", {
      diskArtifactSha256,
      diskOutputs: diskOutputDigests,
      reason: "build-binding-mismatch",
    });
  }

  const loadedEntrySha256 = outputDigestFromList(loadedOutputs, "extension");
  const diskEntrySha256 = outputDigestFromList(diskOutputDigests, "extension");
  const manifestArtifactSha256 = outputDigest(manifest, "extension");
  const buildCompletedAtMs = Date.parse(manifest.buildCompletedAt);
  const base = {
    diskArtifactSha256,
    loadedOutputs,
    diskOutputs: diskOutputDigests,
    ...(manifestArtifactSha256 === undefined ? {} : { manifestArtifactSha256 }),
    buildCompletedAt: manifest.buildCompletedAt,
    sourceInputCount: manifest.buildInputs.length,
    gitSubject: manifest.git.subject,
    gitDirty: manifest.git.dirty,
  };

  if (
    loaded.artifactSha256 !== loadedEntrySha256 ||
    diskArtifactSha256 !== diskEntrySha256
  ) {
    return healthFromLoaded(loaded, "unverifiable", {
      ...base,
      reason:
        loaded.artifactSha256 !== loadedEntrySha256
          ? "loaded-artifact-missing"
          : "artifact-read-failed",
    });
  }

  for (const name of EXTENSION_RUNTIME_OUTPUT_NAMES) {
    const loadedSha256 = outputDigestFromList(loadedOutputs, name);
    const diskSha256 = outputDigestFromList(diskOutputDigests, name);
    const manifestSha256 = outputDigest(manifest, name);
    if (
      loadedSha256 === undefined ||
      diskSha256 === undefined ||
      manifestSha256 === undefined
    ) {
      return healthFromLoaded(loaded, "manifest-mismatch", {
        ...base,
        reason: "manifest-output-missing",
      });
    }
    if (loadedSha256 !== diskSha256) {
      return healthFromLoaded(loaded, "stale-on-disk", base);
    }
    if (diskSha256 !== manifestSha256) {
      return healthFromLoaded(loaded, "manifest-mismatch", base);
    }
  }

  if (!Number.isFinite(buildCompletedAtMs)) {
    return healthFromLoaded(loaded, "unverifiable", {
      ...base,
      reason: "build-completion-invalid",
    });
  }
  if (buildCompletedAtMs > loaded.loadTimeMs) {
    return healthFromLoaded(loaded, "unverifiable", {
      ...base,
      reason: "build-completion-after-load",
    });
  }
  return healthFromLoaded(loaded, "current", base);
}

/** Read the sidecar and disk artifact for the current loader generation. */
export function readExtensionBuildIdentityHealth(
  loaded: ExtensionLoadedIdentity,
): ResultAsync<ExtensionBuildIdentityHealth, never> {
  if (loaded.artifactPath === undefined) {
    return okAsync(
      evaluateExtensionBuildIdentity({
        loaded,
        manifestReason: loaded.loadReason ?? "artifact-path-missing",
      }),
    );
  }
  const manifestPath = join(
    dirname(loaded.artifactPath),
    EXTENSION_BUILD_MANIFEST_FILENAME,
  );
  const disk = readRuntimeOutputDigests(loaded.artifactPath)
    .map((diskOutputs) => ({
      diskOutputs,
      diskArtifactSha256: outputDigestFromList(diskOutputs, "extension"),
    }))
    .orElse(() =>
      okAsync<{
        readonly diskArtifactSha256?: string;
        readonly diskOutputs?: readonly ExtensionBuildOutputDigest[];
      }>({}),
    );
  const manifest = ResultAsync.fromPromise(
    Bun.file(manifestPath).arrayBuffer(),
    (): ExtensionBuildIdentityError => ({ type: "ManifestReadFailed" }),
  )
    .andThen((bytes) => {
      if (bytes.byteLength > MAX_EXTENSION_BUILD_MANIFEST_BYTES) {
        return errAsync<
          { readonly manifest: ExtensionBuildIdentityManifest },
          ExtensionBuildIdentityError
        >({ type: "ManifestMalformed" });
      }
      const decoded = Result.fromThrowable(
        () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        (): ExtensionBuildIdentityError => ({ type: "ManifestMalformed" }),
      )();
      if (decoded.isErr()) return errAsync(decoded.error);
      const parsed = parseExtensionBuildManifestText(decoded.value);
      return parsed.isOk()
        ? okAsync({ manifest: parsed.value })
        : errAsync(parsed.error);
    })
    .map((value) => ({ ...value, reason: undefined }))
    .orElse((error) =>
      okAsync({
        manifest: undefined,
        reason: manifestFailureReason(error),
      }),
    );
  return disk.andThen((diskValue) =>
    manifest.map((manifestValue) =>
      evaluateExtensionBuildIdentity({
        loaded,
        diskArtifactSha256: diskValue.diskArtifactSha256,
        diskOutputs: diskValue.diskOutputs,
        manifest: manifestValue.manifest,
        manifestReason:
          diskValue.diskArtifactSha256 === undefined
            ? "artifact-read-failed"
            : manifestValue.reason,
      }),
    ),
  );
}
