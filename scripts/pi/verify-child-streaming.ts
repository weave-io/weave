import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import {
  EXTENSION_BUILD_IDENTITY_PROOF_ENV,
  EXTENSION_BUILD_MANIFEST_FILENAME,
  EXTENSION_RUNTIME_OUTPUT_NAMES,
  type ExtensionBuildIdentityManifest,
  type ExtensionBuildIdentityProof,
  type ExtensionBuildIdentityState,
  MAX_EXTENSION_BUILD_MANIFEST_BYTES,
  parseExtensionBuildIdentityProof,
  parseExtensionBuildManifestText,
  readArtifactSha256,
} from "../../packages/adapters/pi/src/extension-build-identity.js";
import { piIdentityOutputFiles } from "../build-public-packages.js";
import {
  captureChildEvents,
  type FixtureValidationFailure,
  readFixtureAndManifest,
  replayFixtureThroughAdapter,
  runFixtureRedControls,
  verifyCaptureManifest,
} from "./child-stream-capture.js";
import { runLiveProofCommand } from "./child-stream-live-proof-command.js";
import { LIVE_PROOF_COMMAND } from "./child-stream-live-proof-contract.js";
import {
  DEFAULT_BOUNDED_PROCESS_LIMITS,
  runBoundedProcess,
} from "./child-stream-live-proof-system.js";

const EXTENSION_RELATIVE_PATH =
  "packages/adapters/pi/dist/extension.js" as const;
const MANIFEST_RELATIVE_PATH = join(
  "packages/adapters/pi/dist",
  EXTENSION_BUILD_MANIFEST_FILENAME,
);
const IDENTITY_OUTPUTS = piIdentityOutputFiles();
const PROBE_TIMEOUT_MS = 20_000;
const PROBE_FIRST_OUTPUT_TIMEOUT_MS = 10_000;
const MAX_PROBE_OUTPUT_CHARS = 32 * 1024;
const MAX_IDENTITY_PROBE_ENV_VALUE_CHARS = 4_096;
const IDENTITY_PROBE_CLEANUP_ATTEMPTS = 40;
const IDENTITY_PROBE_CLEANUP_DELAY_MS = 100;
const IDENTITY_PROBE_LOCALE = "C.UTF-8";

/**
 * Environment names that may reach the fresh Pi identity process.
 *
 * This is deliberately a positive list. The child receives no ambient
 * environment, including no user configuration, credentials, loader hooks, or
 * dynamic-library paths. HOME/XDG/Pi paths are replaced with the per-probe
 * temporary paths below; PATH and BUN_INSTALL preserve the requested Pi/Bun
 * executable resolution.
 */
export const IDENTITY_PROBE_ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "BUN_INSTALL",
  "VOLTA_HOME",
  "HOME",
  "USERPROFILE",
  "PI_CODING_AGENT_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  EXTENSION_BUILD_IDENTITY_PROOF_ENV,
] as const);
export type VerifyChildStreamingArgs =
  | {
      readonly command: "identity";
      readonly pi: string;
      readonly requireCurrentBuild: boolean;
    }
  | {
      readonly command: "capture";
      readonly pi: string;
      readonly requireHostVersion: string;
      readonly omitReasoningContent: true;
      readonly sanitize: true;
      readonly verifyBounds: true;
      readonly fixtureDir?: string;
    }
  | {
      readonly command: "replay";
      readonly fixture: string;
      readonly injectControlledReasoningInMemory: true;
      readonly verifyManifest: true;
      readonly runRedControls: true;
    };

export type VerifyChildStreamingFailureType =
  | "invalid-args"
  | "git-mismatch"
  | "source-mismatch"
  | "output-mismatch"
  | "stale-on-disk"
  | "manifest-mismatch"
  | "unverifiable"
  | "probe-failed"
  | "pi-version-mismatch"
  | "pi-ai-unavailable"
  | "workspace-failed"
  | "spawn-failed"
  | "capture-timeout"
  | "bounds-exceeded"
  | "forbidden-content"
  | "sanitization-failed"
  | "fixture-exists"
  | "write-failed"
  | "manifest-corrupt"
  | "fixture-corrupt"
  | "missing-text-delta"
  | "broken-tool-correlation"
  | "malformed-thinking-lifecycle";

export type VerifyChildStreamingFailure = {
  readonly type: VerifyChildStreamingFailureType;
  readonly state?: Exclude<ExtensionBuildIdentityState, "current">;
  readonly evidence: "blocked";
};

export interface IdentityVerificationSuccess {
  readonly state: "current";
  readonly evidence: "identity-proven";
  readonly subject: string;
  readonly dirty: boolean;
  readonly artifactSha256: string;
  readonly loadTimeMs: number;
  readonly processStartMs: number;
}

export interface IdentityVerificationFacts {
  readonly manifest: ExtensionBuildIdentityManifest;
  readonly currentBuildInputs: readonly string[];
  readonly currentOutputs: readonly {
    readonly name: string;
    readonly sha256: string;
  }[];
  readonly currentSubject: string;
  readonly currentDirty: boolean;
  readonly loadedProof?: ExtensionBuildIdentityProof;
  readonly nowMs?: number;
}

export interface VerifyCurrentBuildIdentityInput {
  readonly repoRoot: string;
  readonly pi: string;
  readonly requireCurrentBuild?: boolean;
  readonly nowMs?: number;
  /** Test seam. Production starts the requested Pi executable. */
  readonly probe?: () => ResultAsync<
    ExtensionBuildIdentityProof,
    VerifyChildStreamingFailure
  >;
}

function blocked(
  type: VerifyChildStreamingFailureType,
  state?: Exclude<ExtensionBuildIdentityState, "current">,
): VerifyChildStreamingFailure {
  return {
    type,
    ...(state === undefined ? {} : { state }),
    evidence: "blocked",
  };
}

function boundedIdentityProbeEnvironmentValue(
  value: unknown,
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTITY_PROBE_ENV_VALUE_CHARS
  ) {
    return undefined;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return undefined;
  }
  return value;
}

function readIdentityProbeEnvironmentValue(
  source: Readonly<Record<string, unknown>>,
  name: string,
  required: boolean,
): Result<string | undefined, VerifyChildStreamingFailure> {
  const descriptor = Result.fromThrowable(
    () => Object.getOwnPropertyDescriptor(source, name),
    () => blocked("probe-failed"),
  )();
  if (descriptor.isErr()) return err(descriptor.error);
  if (descriptor.value === undefined) {
    return required ? err(blocked("probe-failed")) : ok(undefined);
  }
  if (!("value" in descriptor.value)) return err(blocked("probe-failed"));
  const value = boundedIdentityProbeEnvironmentValue(descriptor.value.value);
  if (value === undefined) return err(blocked("probe-failed"));
  return ok(value);
}

export interface IdentityProbeIsolationPaths {
  readonly root: string;
  readonly home: string;
  readonly agent: string;
  readonly config: string;
  readonly data: string;
  readonly cache: string;
  readonly temporary: string;
}

function identityProbeIsolationPaths(
  root: string,
): Result<IdentityProbeIsolationPaths, VerifyChildStreamingFailure> {
  const boundedRoot = boundedIdentityProbeEnvironmentValue(root);
  if (boundedRoot === undefined || !isAbsolute(boundedRoot)) {
    return err(blocked("probe-failed"));
  }
  const paths = {
    root: boundedRoot,
    home: join(boundedRoot, "home"),
    agent: join(boundedRoot, "pi-agent"),
    config: join(boundedRoot, "xdg-config"),
    data: join(boundedRoot, "xdg-data"),
    cache: join(boundedRoot, "xdg-cache"),
    temporary: join(boundedRoot, "tmp"),
  };
  if (
    Object.values(paths).some(
      (path) => boundedIdentityProbeEnvironmentValue(path) === undefined,
    )
  ) {
    return err(blocked("probe-failed"));
  }
  return ok(paths);
}

/**
 * Build the identity child environment without enumerating or copying the
 * caller's environment. The parent runtime values are read through own data
 * descriptors, so accessors and hostile proxies fail closed without running.
 */
export function buildIdentityProbeEnvironment(
  source: Readonly<Record<string, unknown>>,
  isolationRoot: string,
): Result<Record<string, string>, VerifyChildStreamingFailure> {
  const path = readIdentityProbeEnvironmentValue(source, "PATH", true);
  if (path.isErr()) return err(path.error);
  if (path.value === undefined) return err(blocked("probe-failed"));
  const bunInstall = readIdentityProbeEnvironmentValue(
    source,
    "BUN_INSTALL",
    true,
  );
  if (bunInstall.isErr()) return err(bunInstall.error);
  if (bunInstall.value === undefined) return err(blocked("probe-failed"));
  const voltaHome = readIdentityProbeEnvironmentValue(
    source,
    "VOLTA_HOME",
    false,
  );
  if (voltaHome.isErr()) return err(voltaHome.error);
  const isolated = identityProbeIsolationPaths(isolationRoot);
  if (isolated.isErr()) return err(isolated.error);

  const env: Record<string, string> = {
    PATH: path.value,
    BUN_INSTALL: bunInstall.value,
    HOME: isolated.value.home,
    USERPROFILE: isolated.value.home,
    PI_CODING_AGENT_DIR: isolated.value.agent,
    XDG_CONFIG_HOME: isolated.value.config,
    XDG_DATA_HOME: isolated.value.data,
    XDG_CACHE_HOME: isolated.value.cache,
    TMPDIR: isolated.value.temporary,
    TMP: isolated.value.temporary,
    TEMP: isolated.value.temporary,
    LANG: IDENTITY_PROBE_LOCALE,
    LC_ALL: IDENTITY_PROBE_LOCALE,
    [EXTENSION_BUILD_IDENTITY_PROOF_ENV]: "1",
  };
  if (voltaHome.value !== undefined) env.VOLTA_HOME = voltaHome.value;
  return ok(env);
}

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
  manifest: ExtensionBuildIdentityManifest,
  name: string,
): string | undefined {
  return manifest.outputs.find((output) => output.name === name)?.sha256;
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
  const expectedExtension = outputDigest(input.manifest, "extension");
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
    const expected = outputDigest(input.manifest, name);
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
export type ChildStreamingEvidenceClass =
  | "stale-screenshot"
  | "post-build-red-reproduction"
  | "identity-proven";

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

function runCommand(
  command: readonly string[],
  cwd: string,
): ResultAsync<
  { readonly exitCode: number; readonly stdout: string },
  VerifyChildStreamingFailure
> {
  return runBoundedProcess({
    cmd: command,
    cwd,
    env: {
      PATH: typeof Bun.env.PATH === "string" ? Bun.env.PATH : "/usr/bin:/bin",
    },
    limits: DEFAULT_BOUNDED_PROCESS_LIMITS,
  })
    .mapErr(() => blocked("probe-failed"))
    .map(({ exitCode, stdout }) => ({ exitCode, stdout }));
}

function readGitIdentity(
  repoRoot: string,
): ResultAsync<
  { readonly subject: string; readonly dirty: boolean },
  VerifyChildStreamingFailure
> {
  return runCommand(["git", "rev-parse", "HEAD"], repoRoot).andThen((head) => {
    if (head.exitCode !== 0 || !/^[0-9a-f]{40}$/u.test(head.stdout.trim())) {
      return errAsync(blocked("git-mismatch", "manifest-mismatch"));
    }
    return runCommand(
      ["git", "status", "--porcelain", "--untracked-files=all"],
      repoRoot,
    ).andThen((status) => {
      if (status.exitCode !== 0) {
        return errAsync(blocked("git-mismatch", "manifest-mismatch"));
      }
      return okAsync({
        subject: head.stdout.trim(),
        dirty: status.stdout.trim().length > 0,
      });
    });
  });
}

function readManifest(
  repoRoot: string,
): ResultAsync<ExtensionBuildIdentityManifest, VerifyChildStreamingFailure> {
  return ResultAsync.fromPromise(
    Bun.file(join(repoRoot, MANIFEST_RELATIVE_PATH)).arrayBuffer(),
    () => blocked("unverifiable", "unverifiable"),
  ).andThen((bytes) => {
    if (bytes.byteLength > MAX_EXTENSION_BUILD_MANIFEST_BYTES) {
      return errAsync(blocked("unverifiable", "unverifiable"));
    }
    const text = Result.fromThrowable(
      () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      () => blocked("unverifiable", "unverifiable"),
    )();
    if (text.isErr()) return errAsync(text.error);
    const parsed = parseExtensionBuildManifestText(text.value);
    return parsed.isOk()
      ? okAsync(parsed.value)
      : errAsync(blocked("unverifiable", "unverifiable"));
  });
}

function collectBuildInputs(
  repoRoot: string,
): ResultAsync<readonly string[], VerifyChildStreamingFailure> {
  return ResultAsync.fromPromise(
    (async () => {
      const paths: string[] = [];
      for await (const path of new Bun.Glob(
        "packages/adapters/pi/src/**/*.ts",
      ).scan({ cwd: repoRoot, onlyFiles: true })) {
        if (
          path.includes("/__tests__/") ||
          path.includes("/__fixtures__/") ||
          path.endsWith(".test.ts") ||
          path.endsWith(".spec.ts")
        ) {
          continue;
        }
        paths.push(path);
      }
      return [...new Set(paths)].sort();
    })(),
    () => blocked("unverifiable", "unverifiable"),
  ).andThen((paths) => {
    if (paths.length === 0)
      return errAsync(blocked("unverifiable", "unverifiable"));
    let result = okAsync<string[], VerifyChildStreamingFailure>([]);
    for (const path of paths) {
      result = result.andThen((digests) =>
        readArtifactSha256(join(repoRoot, path))
          .mapErr(() => blocked("unverifiable", "unverifiable"))
          .map((digest) => [...digests, digest]),
      );
    }
    return result.map((digests) => [...digests].sort());
  });
}

function collectOutputs(
  repoRoot: string,
): ResultAsync<
  readonly { readonly name: string; readonly sha256: string }[],
  VerifyChildStreamingFailure
> {
  let result = okAsync<
    { readonly name: string; readonly sha256: string }[],
    VerifyChildStreamingFailure
  >([]);
  for (const output of IDENTITY_OUTPUTS) {
    result = result.andThen((outputs) =>
      readArtifactSha256(join(repoRoot, output.relativePath))
        .mapErr(() => blocked("unverifiable", "unverifiable"))
        .map((sha256) => [...outputs, { name: output.name, sha256 }]),
    );
  }
  return result;
}

function findIdentityProof(
  output: string,
): Result<ExtensionBuildIdentityProof, VerifyChildStreamingFailure> {
  for (const line of output.split(/\r?\n/u)) {
    if (!line.includes("weaveExtensionBuildIdentity")) continue;
    const parsed = Result.fromThrowable(
      () => JSON.parse(line) as unknown,
      () => blocked("probe-failed"),
    )();
    if (parsed.isErr()) continue;
    const proof = parseExtensionBuildIdentityProof(parsed.value);
    if (proof.isOk()) return ok(proof.value);
  }
  return err(blocked("probe-failed"));
}

function createIdentityProbeIsolationPaths(): Result<
  IdentityProbeIsolationPaths,
  VerifyChildStreamingFailure
> {
  const root = join(tmpdir(), `weave-pi-identity-probe-${crypto.randomUUID()}`);
  return identityProbeIsolationPaths(root);
}

function runIdentityProbeFilesystemCommand(
  command: readonly string[],
): ResultAsync<void, VerifyChildStreamingFailure> {
  const path =
    typeof Bun.env.PATH === "string" ? Bun.env.PATH : "/usr/bin:/bin";
  return runBoundedProcess({
    cmd: command,
    cwd: ".",
    env: { PATH: path },
    limits: {
      ...DEFAULT_BOUNDED_PROCESS_LIMITS,
      firstOutputMs: 1_000,
      totalReadMs: 5_000,
      maxCaptureBytes: 4 * 1024,
    },
  })
    .mapErr(() => blocked("probe-failed"))
    .andThen(({ exitCode }) =>
      exitCode === 0
        ? okAsync<void, VerifyChildStreamingFailure>(undefined)
        : errAsync(blocked("probe-failed")),
    );
}

function prepareIdentityProbeIsolation(
  paths: IdentityProbeIsolationPaths,
): ResultAsync<void, VerifyChildStreamingFailure> {
  return runIdentityProbeFilesystemCommand([
    "mkdir",
    "-p",
    paths.home,
    paths.agent,
    paths.config,
    paths.data,
    paths.cache,
    paths.temporary,
  ]);
}

async function removeIdentityProbeIsolation(
  paths: IdentityProbeIsolationPaths,
): Promise<Result<void, VerifyChildStreamingFailure>> {
  let lastFailure = blocked("probe-failed");
  for (
    let attempt = 0;
    attempt < IDENTITY_PROBE_CLEANUP_ATTEMPTS;
    attempt += 1
  ) {
    const removed = await runIdentityProbeFilesystemCommand([
      "rm",
      "-rf",
      paths.root,
    ]);
    if (removed.isOk()) {
      await new Promise<void>((resolveDelay) =>
        setTimeout(resolveDelay, IDENTITY_PROBE_CLEANUP_DELAY_MS),
      );
      const stable = await runIdentityProbeFilesystemCommand([
        "rm",
        "-rf",
        paths.root,
      ]);
      if (stable.isOk()) return stable;
      lastFailure = stable.error;
    } else {
      lastFailure = removed.error;
    }
    if (attempt + 1 < IDENTITY_PROBE_CLEANUP_ATTEMPTS) {
      await new Promise<void>((resolveDelay) =>
        setTimeout(resolveDelay, IDENTITY_PROBE_CLEANUP_DELAY_MS),
      );
    }
  }
  return err(lastFailure);
}

/** Run one fresh Pi identity load with no ambient user environment. */
export function probePiIdentity(
  repoRoot: string,
  pi: string,
  environmentSource: Readonly<Record<string, unknown>> = Bun.env,
): ResultAsync<ExtensionBuildIdentityProof, VerifyChildStreamingFailure> {
  return ResultAsync.fromThrowable(
    async () => {
      const createdIsolation = createIdentityProbeIsolationPaths();
      if (createdIsolation.isErr()) return err(createdIsolation.error);
      const isolation = createdIsolation.value;
      const prepared = await prepareIdentityProbeIsolation(isolation);
      if (prepared.isErr()) {
        await removeIdentityProbeIsolation(isolation);
        return err(prepared.error);
      }

      let result: Result<
        ExtensionBuildIdentityProof,
        VerifyChildStreamingFailure
      > = err(blocked("probe-failed"));
      try {
        const environment = buildIdentityProbeEnvironment(
          environmentSource,
          isolation.root,
        );
        if (environment.isErr()) {
          result = err(environment.error);
        } else {
          let proof: ExtensionBuildIdentityProof | undefined;
          const ran = await runBoundedProcess({
            // Keep the caller's exact executable and Bun/PATH lookup. No shell
            // or alternate Pi resolution is allowed at this boundary.
            cmd: [
              pi,
              "--mode",
              "rpc",
              "--no-session",
              "--no-extensions",
              "-e",
              resolve(repoRoot, EXTENSION_RELATIVE_PATH),
            ],
            cwd: repoRoot,
            env: environment.value,
            stdin: "pipe",
            limits: {
              ...DEFAULT_BOUNDED_PROCESS_LIMITS,
              firstOutputMs: PROBE_FIRST_OUTPUT_TIMEOUT_MS,
              totalReadMs: PROBE_TIMEOUT_MS,
              maxCaptureBytes: MAX_PROBE_OUTPUT_CHARS,
            },
            onLine: (_stream, line) => {
              const parsed = findIdentityProof(line);
              if (parsed.isErr()) return undefined;
              proof = parsed.value;
              return true;
            },
          });
          if (ran.isOk() && proof !== undefined) {
            result = ok(proof);
          } else {
            result = err(blocked("probe-failed"));
          }
        }
      } finally {
        const removed = await removeIdentityProbeIsolation(isolation);
        if (removed.isErr()) result = err(removed.error);
      }
      return result;
    },
    () => blocked("probe-failed"),
  )().andThen((result) =>
    result.isOk() ? okAsync(result.value) : errAsync(result.error),
  );
}

/** Independently hash source/output identity and prove one fresh Pi load. */
export function verifyCurrentBuildIdentity(
  input: VerifyCurrentBuildIdentityInput,
): ResultAsync<IdentityVerificationSuccess, VerifyChildStreamingFailure> {
  if (input.requireCurrentBuild === false) {
    return errAsync(blocked("invalid-args"));
  }
  return readManifest(input.repoRoot)
    .andThen((manifest) =>
      readGitIdentity(input.repoRoot).map((git) => ({ manifest, git })),
    )
    .andThen(({ manifest, git }) =>
      collectBuildInputs(input.repoRoot).map((currentBuildInputs) => ({
        manifest,
        git,
        currentBuildInputs,
      })),
    )
    .andThen(({ manifest, git, currentBuildInputs }) =>
      collectOutputs(input.repoRoot).map((currentOutputs) => ({
        manifest,
        git,
        currentBuildInputs,
        currentOutputs,
      })),
    )
    .andThen(({ manifest, git, currentBuildInputs, currentOutputs }) => {
      const probe =
        input.probe?.() ?? probePiIdentity(input.repoRoot, input.pi);
      return probe.andThen((loadedProof) => {
        const identity = verifyIdentityFacts({
          manifest,
          currentBuildInputs,
          currentOutputs,
          currentSubject: git.subject,
          currentDirty: git.dirty,
          loadedProof,
          nowMs: input.nowMs,
        });
        return identity.isOk()
          ? okAsync(identity.value)
          : errAsync(identity.error);
      });
    });
}

function requiredValue(
  argv: readonly string[],
  index: number,
): string | undefined {
  const value = argv[index + 1];
  return value === undefined || value.length === 0 ? undefined : value;
}

function parseIdentityArgs(
  argv: readonly string[],
): Result<VerifyChildStreamingArgs, VerifyChildStreamingFailure> {
  let pi: string | undefined;
  let requireCurrentBuild = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--require-current-build") {
      requireCurrentBuild = true;
      continue;
    }
    if (arg === "--pi") {
      const value = requiredValue(argv, index);
      if (value === undefined) return err(blocked("invalid-args"));
      pi = value;
      index += 1;
      continue;
    }
    return err(blocked("invalid-args"));
  }
  if (pi === undefined || !requireCurrentBuild)
    return err(blocked("invalid-args"));
  return ok({ command: "identity", pi, requireCurrentBuild });
}

function parseCaptureArgs(
  argv: readonly string[],
): Result<VerifyChildStreamingArgs, VerifyChildStreamingFailure> {
  let pi: string | undefined;
  let requireHostVersion: string | undefined;
  let omitReasoningContent = false;
  let sanitize = false;
  let verifyBounds = false;
  let fixtureDir: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--pi") {
      const value = requiredValue(argv, index);
      if (value === undefined) return err(blocked("invalid-args"));
      pi = value;
      index += 1;
      continue;
    }
    if (arg === "--require-host-version") {
      const value = requiredValue(argv, index);
      if (value === undefined) return err(blocked("invalid-args"));
      requireHostVersion = value;
      index += 1;
      continue;
    }
    if (arg === "--omit-reasoning-content") {
      omitReasoningContent = true;
      continue;
    }
    if (arg === "--sanitize") {
      sanitize = true;
      continue;
    }
    if (arg === "--verify-bounds") {
      verifyBounds = true;
      continue;
    }
    if (arg === "--fixture-dir") {
      const value = requiredValue(argv, index);
      if (value === undefined) return err(blocked("invalid-args"));
      fixtureDir = value;
      index += 1;
      continue;
    }
    return err(blocked("invalid-args"));
  }
  if (
    pi === undefined ||
    requireHostVersion === undefined ||
    !omitReasoningContent ||
    !sanitize ||
    !verifyBounds
  ) {
    return err(blocked("invalid-args"));
  }
  return ok({
    command: "capture",
    pi,
    requireHostVersion,
    omitReasoningContent: true,
    sanitize: true,
    verifyBounds: true,
    ...(fixtureDir === undefined ? {} : { fixtureDir }),
  });
}

function parseReplayArgs(
  argv: readonly string[],
): Result<VerifyChildStreamingArgs, VerifyChildStreamingFailure> {
  let fixture: string | undefined;
  let injectControlledReasoningInMemory = false;
  let verifyManifest = false;
  let runRedControls = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--fixture") {
      const value = requiredValue(argv, index);
      if (value === undefined) return err(blocked("invalid-args"));
      fixture = value;
      index += 1;
      continue;
    }
    if (arg === "--inject-controlled-reasoning-in-memory") {
      injectControlledReasoningInMemory = true;
      continue;
    }
    if (arg === "--verify-manifest") {
      verifyManifest = true;
      continue;
    }
    if (arg === "--run-red-controls") {
      runRedControls = true;
      continue;
    }
    return err(blocked("invalid-args"));
  }
  if (
    !fixture ||
    !injectControlledReasoningInMemory ||
    !verifyManifest ||
    !runRedControls
  ) {
    return err(blocked("invalid-args"));
  }
  return ok({
    command: "replay",
    fixture,
    injectControlledReasoningInMemory: true,
    verifyManifest: true,
    runRedControls: true,
  });
}

export function parseVerifyChildStreamingArgs(
  argv: readonly string[],
): Result<VerifyChildStreamingArgs, VerifyChildStreamingFailure> {
  if (argv[0] === "identity") return parseIdentityArgs(argv);
  if (argv[0] === "capture") return parseCaptureArgs(argv);
  if (argv[0] === "replay") return parseReplayArgs(argv);
  return err(blocked("invalid-args"));
}

function fixtureFailure(
  failure: FixtureValidationFailure,
): VerifyChildStreamingFailure {
  return blocked(failure.type);
}

function writeLine(line: string): Result<void, undefined> {
  return Result.fromThrowable(
    () => {
      const written = Bun.stdout.write(`${line}\n`);
      if (written instanceof Promise) void written;
    },
    () => undefined,
  )();
}

/** Run the live command. It is the only command that owns real resources. */
async function runLiveCommandLine(argv: readonly string[]): Promise<void> {
  const outcome = await runLiveProofCommand({
    argv,
    repoRoot: resolve(import.meta.dir, "../.."),
  });
  outcome.match(
    (value) => {
      writeLine(value.line);
      if (value.exitCode !== 0) process.exitCode = value.exitCode;
    },
    () => undefined,
  );
}

async function runCommandLine(argv: readonly string[]): Promise<void> {
  if (argv[0] === LIVE_PROOF_COMMAND) {
    await runLiveCommandLine(argv);
    return;
  }
  const parsed = parseVerifyChildStreamingArgs(argv);
  if (parsed.isErr()) {
    writeLine(
      "child-streaming: blocked; evidence=blocked; reason=invalid-args",
    );
    process.exitCode = 1;
  } else if (parsed.value.command === "identity") {
    const repoRoot = resolve(import.meta.dir, "../..");
    const result = await verifyCurrentBuildIdentity({
      repoRoot,
      pi: parsed.value.pi,
      requireCurrentBuild: parsed.value.requireCurrentBuild,
    });
    if (result.isOk()) {
      writeLine(
        `identity: current; evidence=${result.value.evidence}; child-streaming=permitted`,
      );
    } else {
      writeLine(
        `identity: blocked; state=${result.error.state ?? "unverifiable"}; evidence=${result.error.evidence}; child-streaming=refused; reason=${result.error.type}`,
      );
      process.exitCode = 1;
    }
  } else if (parsed.value.command === "capture") {
    const repoRoot = resolve(import.meta.dir, "../..");
    const result = await captureChildEvents({
      pi: parsed.value.pi,
      requireHostVersion: parsed.value.requireHostVersion,
      fixtureDir:
        parsed.value.fixtureDir ??
        join(repoRoot, "packages/adapters/pi/src/__fixtures__"),
    });
    if (result.isErr()) {
      writeLine(
        `capture: blocked; evidence=${result.error.evidence}; reason=${result.error.type}`,
      );
      process.exitCode = 1;
    } else {
      writeLine(
        `capture: verified; evidence=content-free; event-count=${result.value.eventCount}; manifest=independent`,
      );
    }
  } else {
    const replayArgs = parsed.value as Extract<
      VerifyChildStreamingArgs,
      { readonly command: "replay" }
    >;
    const loaded = await readFixtureAndManifest(replayArgs.fixture);
    const verified = loaded.andThen(({ fixtureText, manifestText }) => {
      const result = verifyCaptureManifest(fixtureText, manifestText);
      return result.isOk()
        ? ok({ fixtureText, manifestText, fixture: result.value.fixture })
        : err(fixtureFailure(result.error));
    });
    const result = await verified.andThen(
      ({ fixtureText, manifestText, fixture }) => {
        const red = runFixtureRedControls(fixtureText, manifestText);
        if (red.isErr()) return err(blocked(red.error.mutation));
        const replay = replayFixtureThroughAdapter(fixture, {
          injectControlledReasoningInMemory:
            replayArgs.injectControlledReasoningInMemory,
        });
        if (replay.isErr()) return err(fixtureFailure(replay.error));
        return ok({
          redControls: Object.keys(red.value).length,
          replay,
        });
      },
    );
    if (result.isErr()) {
      writeLine(
        `replay: blocked; evidence=content-free; reason=${result.error.type}`,
      );
      process.exitCode = 1;
    } else {
      writeLine(
        `replay: verified; evidence=content-free; red-controls=${result.value.redControls}; lanes=4`,
      );
    }
  }
}

if (import.meta.main) {
  await runCommandLine(Bun.argv.slice(2));
}
