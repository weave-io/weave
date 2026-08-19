import { dirname, join } from "node:path";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";

/** The sidecar schema is deliberately small and versioned independently. */
export const EXTENSION_BUILD_IDENTITY_SCHEMA_VERSION = 1 as const;
export const EXTENSION_BUILD_MANIFEST_FILENAME =
  "extension-build-identity.json" as const;
export const EXTENSION_BUILD_IDENTITY_PROOF_ENV =
  "WEAVE_PI_BUILD_IDENTITY_PROOF" as const;

/** Keep every identity surface bounded before it reaches a UI or proof line. */
export const MAX_EXTENSION_BUILD_MANIFEST_BYTES = 32 * 1024;
export const MAX_EXTENSION_BUILD_IDENTITY_LINE_LENGTH = 1_024;
export const MAX_EXTENSION_BUILD_INPUTS = 4_096;
export const MAX_EXTENSION_BUILD_OUTPUTS = 64;
export const MAX_EXTENSION_BUILD_SUBJECT_LENGTH = 128;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_OUTPUT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/**
 * JavaScript outputs evaluated by the Pi extension loader. Declarations and
 * the package's CLI/index entries are not part of this runtime graph.
 *
 * File names stay an internal loader detail. Only the logical names and
 * digests cross the identity/proof boundary.
 */
const RUNTIME_OUTPUT_FILES = [
  { name: "extension", fileName: "extension.js" },
  {
    name: "extension-build-identity",
    fileName: "extension-build-identity.js",
  },
  { name: "extension-impl", fileName: "extension-impl.js" },
  { name: "host-module-loader", fileName: "host-module-loader.js" },
] as const;

/** Every runtime-loaded output is required for an exact loader attestation. */
export const EXTENSION_RUNTIME_OUTPUT_NAMES = Object.freeze(
  RUNTIME_OUTPUT_FILES.map((output) => output.name),
);

/** A bounded, path-free digest for one logical build output. */
export interface ExtensionBuildOutputDigest {
  readonly name: string;
  readonly sha256: string;
}

export type ExtensionBuildIdentityState =
  | "current"
  | "stale-on-disk"
  | "manifest-mismatch"
  | "unverifiable";

export type ExtensionBuildIdentityReason =
  | "artifact-path-missing"
  | "artifact-read-failed"
  | "manifest-read-failed"
  | "manifest-malformed"
  | "loaded-artifact-missing"
  | "loaded-time-missing"
  | "process-start-missing"
  | "build-completion-invalid"
  | "build-completion-after-load"
  | "manifest-output-missing"
  | "proof-malformed";

export type ExtensionBuildIdentityError =
  | { readonly type: "ArtifactReadFailed" }
  | { readonly type: "ManifestReadFailed" }
  | { readonly type: "ManifestMalformed" }
  | { readonly type: "DigestFailed" };

export interface ExtensionBuildManifestGit {
  /** The repository subject SHA recorded by the build process. */
  readonly subject: string;
  readonly dirty: boolean;
}

/**
 * A path-free build manifest. Inputs are digest-only because source paths are
 * intentionally not part of an artifact identity record.
 */
export interface ExtensionBuildIdentityManifest {
  readonly schemaVersion: typeof EXTENSION_BUILD_IDENTITY_SCHEMA_VERSION;
  readonly git: ExtensionBuildManifestGit;
  readonly buildInputs: readonly string[];
  readonly outputs: readonly {
    readonly name: string;
    readonly sha256: string;
  }[];
  readonly buildCompletedAt: string;
}

/**
 * Facts captured by the loader before it evaluates the implementation. The
 * artifact path is an internal read capability and is never rendered.
 */
export interface ExtensionLoadedIdentity {
  readonly artifactPath?: string;
  /** The legacy entry digest, retained as the stable top-level fact. */
  readonly artifactSha256?: string;
  /** Digests captured before the loader evaluates the runtime graph. */
  readonly loadedOutputs?: readonly ExtensionBuildOutputDigest[];
  readonly loadTimeMs?: number;
  readonly processStartMs: number;
  readonly loadReason?: ExtensionBuildIdentityReason;
}

export interface ExtensionBuildIdentityHealth {
  readonly state: ExtensionBuildIdentityState;
  readonly loadedArtifactSha256?: string;
  readonly loadedOutputs?: readonly ExtensionBuildOutputDigest[];
  readonly diskArtifactSha256?: string;
  readonly diskOutputs?: readonly ExtensionBuildOutputDigest[];
  readonly manifestArtifactSha256?: string;
  readonly loadTimeMs?: number;
  readonly processStartMs?: number;
  readonly buildCompletedAt?: string;
  readonly sourceInputCount?: number;
  readonly gitSubject?: string;
  readonly gitDirty?: boolean;
  readonly reason?: ExtensionBuildIdentityReason;
}

export interface ExtensionBuildIdentityProof {
  readonly schemaVersion: typeof EXTENSION_BUILD_IDENTITY_SCHEMA_VERSION;
  readonly artifactSha256?: string;
  readonly loadedOutputs?: readonly ExtensionBuildOutputDigest[];
  readonly loadTimeMs?: number;
  readonly processStartMs?: number;
}

export type ExtensionBuildIdentityProofLine = {
  readonly weaveExtensionBuildIdentity: ExtensionBuildIdentityProof;
};

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return false;
    }
  }
  return true;
}

function isSafeTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isSafeMilliseconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSortedUnique(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (
      previous === undefined ||
      current === undefined ||
      previous >= current
    ) {
      return false;
    }
  }
  return true;
}

function isSafeOutputName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isBoundedString(value, 64) &&
    SAFE_OUTPUT_NAME_PATTERN.test(value)
  );
}

/** Parse a bounded output digest list without allowing path-shaped names. */
function parseOutputDigestList(
  value: unknown,
): readonly ExtensionBuildOutputDigest[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_EXTENSION_BUILD_OUTPUTS
  ) {
    return undefined;
  }
  const outputs: ExtensionBuildOutputDigest[] = [];
  const names: string[] = [];
  for (const rawOutput of value) {
    if (
      !isRecord(rawOutput) ||
      !isSafeOutputName(rawOutput.name) ||
      typeof rawOutput.sha256 !== "string" ||
      !SHA256_PATTERN.test(rawOutput.sha256)
    ) {
      return undefined;
    }
    outputs.push({ name: rawOutput.name, sha256: rawOutput.sha256 });
    names.push(rawOutput.name);
  }
  return isSortedUnique(names) ? outputs : undefined;
}

function outputDigestFromList(
  outputs: readonly ExtensionBuildOutputDigest[] | undefined,
  name: string,
): string | undefined {
  return outputs?.find((output) => output.name === name)?.sha256;
}

function outputDigest(
  manifest: ExtensionBuildIdentityManifest,
  name: string,
): string | undefined {
  return manifest.outputs.find((output) => output.name === name)?.sha256;
}

function hasEveryRuntimeOutput(
  outputs: readonly ExtensionBuildOutputDigest[] | undefined,
): outputs is readonly ExtensionBuildOutputDigest[] {
  return (
    outputs !== undefined &&
    EXTENSION_RUNTIME_OUTPUT_NAMES.every(
      (name) => outputDigestFromList(outputs, name) !== undefined,
    )
  );
}

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
  if (value.isErr() || !SHA256_PATTERN.test(value.value)) {
    return err({ type: "DigestFailed" });
  }
  return ok(value.value);
}

/** Parse and validate a bounded path-free manifest. */
export function parseExtensionBuildManifest(
  value: unknown,
): Result<ExtensionBuildIdentityManifest, ExtensionBuildIdentityError> {
  if (!isRecord(value)) return err({ type: "ManifestMalformed" });
  if (value.schemaVersion !== EXTENSION_BUILD_IDENTITY_SCHEMA_VERSION) {
    return err({ type: "ManifestMalformed" });
  }

  const git = value.git;
  if (!isRecord(git)) return err({ type: "ManifestMalformed" });
  if (!isBoundedString(git.subject, MAX_EXTENSION_BUILD_SUBJECT_LENGTH)) {
    return err({ type: "ManifestMalformed" });
  }
  if (typeof git.dirty !== "boolean") {
    return err({ type: "ManifestMalformed" });
  }

  const rawInputs = value.buildInputs;
  if (
    !Array.isArray(rawInputs) ||
    rawInputs.length === 0 ||
    rawInputs.length > MAX_EXTENSION_BUILD_INPUTS ||
    rawInputs.some(
      (digest) => typeof digest !== "string" || !SHA256_PATTERN.test(digest),
    ) ||
    !isSortedUnique(rawInputs)
  ) {
    return err({ type: "ManifestMalformed" });
  }

  const rawOutputs = value.outputs;
  if (
    !Array.isArray(rawOutputs) ||
    rawOutputs.length === 0 ||
    rawOutputs.length > MAX_EXTENSION_BUILD_OUTPUTS
  ) {
    return err({ type: "ManifestMalformed" });
  }
  const outputs: { name: string; sha256: string }[] = [];
  const outputNames = new Set<string>();
  for (const rawOutput of rawOutputs) {
    if (!isRecord(rawOutput)) return err({ type: "ManifestMalformed" });
    if (
      !isBoundedString(rawOutput.name, 64) ||
      !SAFE_OUTPUT_NAME_PATTERN.test(rawOutput.name) ||
      outputNames.has(rawOutput.name) ||
      typeof rawOutput.sha256 !== "string" ||
      !SHA256_PATTERN.test(rawOutput.sha256)
    ) {
      return err({ type: "ManifestMalformed" });
    }
    outputNames.add(rawOutput.name);
    outputs.push({ name: rawOutput.name, sha256: rawOutput.sha256 });
  }
  if (
    outputs.some(
      (output, index) =>
        index > 0 && output.name <= (outputs[index - 1]?.name ?? ""),
    )
  ) {
    return err({ type: "ManifestMalformed" });
  }
  if (!isSafeTimestamp(value.buildCompletedAt)) {
    return err({ type: "ManifestMalformed" });
  }

  return ok({
    schemaVersion: EXTENSION_BUILD_IDENTITY_SCHEMA_VERSION,
    git: { subject: git.subject, dirty: git.dirty },
    buildInputs: [...rawInputs],
    outputs,
    buildCompletedAt: value.buildCompletedAt,
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
    git: { subject: input.subject, dirty: input.dirty },
    buildInputs: [...input.buildInputs].sort(),
    outputs,
    buildCompletedAt,
  } satisfies ExtensionBuildIdentityManifest;
  return parseExtensionBuildManifest(manifest);
}

/** Read one artifact digest without allowing an exception to escape. */
export function readArtifactSha256(
  path: string,
): ResultAsync<string, ExtensionBuildIdentityError> {
  return ResultAsync.fromPromise(Bun.file(path).arrayBuffer(), () => ({
    type: "ArtifactReadFailed" as const,
  })).andThen((bytes) => {
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

/** Read every JavaScript output evaluated by the Pi adapter loader. */
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
    !SHA256_PATTERN.test(diskArtifactSha256) ||
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
    Bun.file(manifestPath).text(),
    (): ExtensionBuildIdentityError => ({ type: "ManifestReadFailed" }),
  )
    .andThen((text) => {
      const parsed = parseExtensionBuildManifestText(text);
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

function boundedHash(value: string | undefined): string {
  return value === undefined || !SHA256_PATTERN.test(value) ? "unknown" : value;
}

function boundedMilliseconds(value: number | undefined): string {
  return value === undefined || !isSafeMilliseconds(value)
    ? "unknown"
    : String(value);
}

function boundedSubject(value: string | undefined): string {
  if (value === undefined || value.length === 0) return "unknown";
  return value.slice(0, MAX_EXTENSION_BUILD_SUBJECT_LENGTH);
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
  const line = [
    `extension identity: ${health.state}`,
    `loaded=${boundedHash(health.loadedArtifactSha256)}`,
    `disk=${boundedHash(health.diskArtifactSha256)}`,
    `manifest=${boundedHash(health.manifestArtifactSha256)}`,
    `load-ms=${boundedMilliseconds(health.loadTimeMs)}`,
    `process-start-ms=${boundedMilliseconds(health.processStartMs)}`,
    `build-complete=${health.buildCompletedAt ?? "unknown"}`,
    `inputs=${health.sourceInputCount === undefined ? "unknown" : Math.min(health.sourceInputCount, MAX_EXTENSION_BUILD_INPUTS)}`,
    `subject=${boundedSubject(health.gitSubject)}`,
    `dirty=${health.gitDirty === undefined ? "unknown" : String(health.gitDirty)}`,
    `loaded-outputs=${boundedOutputDigests(health.loadedOutputs)}`,
    `disk-outputs=${boundedOutputDigests(health.diskOutputs)}`,
    ...(health.reason === undefined ? [] : [`reason=${health.reason}`]),
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
  if (
    raw.artifactSha256 !== undefined &&
    (typeof raw.artifactSha256 !== "string" ||
      !SHA256_PATTERN.test(raw.artifactSha256))
  ) {
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
