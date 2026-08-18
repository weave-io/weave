import { join, resolve } from "node:path";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import {
  EXTENSION_BUILD_IDENTITY_PROOF_ENV,
  EXTENSION_BUILD_MANIFEST_FILENAME,
  type ExtensionBuildIdentityManifest,
  type ExtensionBuildIdentityProof,
  type ExtensionBuildIdentityState,
  MAX_EXTENSION_BUILD_MANIFEST_BYTES,
  parseExtensionBuildIdentityProof,
  parseExtensionBuildManifestText,
  readArtifactSha256,
} from "../../packages/adapters/pi/src/extension-build-identity.js";
import { piIdentityOutputFiles } from "../build-public-packages.js";

const EXTENSION_RELATIVE_PATH =
  "packages/adapters/pi/dist/extension.js" as const;
const MANIFEST_RELATIVE_PATH = join(
  "packages/adapters/pi/dist",
  EXTENSION_BUILD_MANIFEST_FILENAME,
);
const IDENTITY_OUTPUTS = piIdentityOutputFiles();
const PROBE_TIMEOUT_MS = 20_000;
const PROBE_KILL_WAIT_MS = 1_000;
const MAX_PROBE_OUTPUT_CHARS = 32 * 1024;

export type VerifyChildStreamingArgs = {
  readonly command: "identity";
  readonly pi: string;
  readonly requireCurrentBuild: boolean;
};

export type VerifyChildStreamingFailureType =
  | "invalid-args"
  | "git-mismatch"
  | "source-mismatch"
  | "output-mismatch"
  | "stale-on-disk"
  | "manifest-mismatch"
  | "unverifiable"
  | "probe-failed";

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

function equalStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
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
  if (!equalStrings(input.currentBuildInputs, input.manifest.buildInputs)) {
    return err(blocked("source-mismatch", "manifest-mismatch"));
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
    loaded.loadTimeMs === undefined ||
    loaded.processStartMs === undefined
  ) {
    return err(blocked("unverifiable", "unverifiable"));
  }
  if (loaded.artifactSha256 !== extensionOutput.sha256) {
    return err(blocked("stale-on-disk", "stale-on-disk"));
  }
  const completedAtMs = Date.parse(input.manifest.buildCompletedAt);
  const nowMs = input.nowMs ?? Date.now();
  if (
    !Number.isFinite(completedAtMs) ||
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
  const spawned = Result.fromThrowable(
    () =>
      Bun.spawn({
        cmd: [...command],
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      }),
    () => blocked("probe-failed"),
  )();
  if (spawned.isErr()) return errAsync(spawned.error);
  return ResultAsync.fromPromise(
    Promise.all([
      spawned.value.exited,
      new Response(spawned.value.stdout).text(),
    ]),
    () => blocked("probe-failed"),
  ).map(([exitCode, stdout]) => ({ exitCode, stdout }));
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
      () => new TextDecoder().decode(bytes),
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

function appendProbeOutput(current: string, chunk: string): string {
  const next = `${current}${chunk}`;
  return next.length <= MAX_PROBE_OUTPUT_CHARS
    ? next
    : next.slice(next.length - MAX_PROBE_OUTPUT_CHARS);
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

async function readProofFromProcess(
  process: ReturnType<typeof Bun.spawn>,
): Promise<Result<ExtensionBuildIdentityProof, VerifyChildStreamingFailure>> {
  const stdout = process.stdout;
  const stderr = process.stderr;
  if (
    stdout === undefined ||
    stderr === undefined ||
    typeof stdout === "number" ||
    typeof stderr === "number"
  ) {
    return err(blocked("probe-failed"));
  }
  const decoder = new TextDecoder();
  let output = "";
  const absorb = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = stream.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      output = appendProbeOutput(
        output,
        decoder.decode(chunk.value, { stream: true }),
      );
    }
  };
  void Promise.all([absorb(stdout), absorb(stderr)]);
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const proof = findIdentityProof(output);
    if (proof.isOk()) return proof;
    if (process.exitCode !== null) return err(blocked("probe-failed"));
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return err(blocked("probe-failed"));
}

function probePiIdentity(
  repoRoot: string,
  pi: string,
): ResultAsync<ExtensionBuildIdentityProof, VerifyChildStreamingFailure> {
  return ResultAsync.fromThrowable(
    async () => {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(Bun.env)) {
        if (value !== undefined) env[key] = value;
      }
      env[EXTENSION_BUILD_IDENTITY_PROOF_ENV] = "1";
      const child = Bun.spawn({
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
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        return await readProofFromProcess(child);
      } finally {
        Result.fromThrowable(
          () => child.kill("SIGTERM"),
          () => undefined,
        )();
        await Promise.race([
          child.exited,
          new Promise<void>((resolveDelay) =>
            setTimeout(resolveDelay, PROBE_KILL_WAIT_MS),
          ),
        ]);
        if (child.exitCode === null) {
          Result.fromThrowable(
            () => child.kill("SIGKILL"),
            () => undefined,
          )();
        }
      }
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

export function parseVerifyChildStreamingArgs(
  argv: readonly string[],
): Result<VerifyChildStreamingArgs, VerifyChildStreamingFailure> {
  if (argv[0] !== "identity") return err(blocked("invalid-args"));
  let pi: string | undefined;
  let requireCurrentBuild = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--require-current-build") {
      requireCurrentBuild = true;
      continue;
    }
    if (arg === "--pi") {
      const value = argv[index + 1];
      if (value === undefined || value.length === 0) {
        return err(blocked("invalid-args"));
      }
      pi = value;
      index += 1;
      continue;
    }
    return err(blocked("invalid-args"));
  }
  if (pi === undefined || !requireCurrentBuild) {
    return err(blocked("invalid-args"));
  }
  return ok({ command: "identity", pi, requireCurrentBuild });
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

if (import.meta.main) {
  const parsed = parseVerifyChildStreamingArgs(Bun.argv.slice(2));
  if (parsed.isErr()) {
    writeLine(
      "identity: blocked; evidence=blocked; child-streaming=refused; reason=invalid-args",
    );
    process.exitCode = 1;
  } else {
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
  }
}
