import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import {
  EXTENSION_BUILD_MANIFEST_FILENAME,
  type ExtensionBuildIdentityManifest,
  type ExtensionBuildIdentityProof,
  MAX_EXTENSION_BUILD_MANIFEST_BYTES,
  parseExtensionBuildIdentityProof,
  parseExtensionBuildManifestText,
  readArtifactSha256,
  readBoundedIdentityBytes,
} from "../../packages/adapters/pi/src/extension-build-identity.js";
import { piIdentityOutputFiles } from "../build-public-packages.js";
import {
  buildIdentityProbeEnvironment,
  identityProbeIsolationPaths,
} from "./child-stream-identity-environment.js";
import { verifyIdentityFacts } from "./child-stream-identity-evaluation.js";
import { DEFAULT_BOUNDED_PROCESS_LIMITS } from "./child-stream-live-proof-system.js";
import {
  runIdentityProbeFilesystemCommand,
  runVerifierCommand,
  runVerifierProcess,
} from "./child-stream-verify-process.js";
import {
  blocked,
  type IdentityProbeIsolationPaths,
  type IdentityVerificationSuccess,
  type VerifyChildStreamingFailure,
  type VerifyCurrentBuildIdentityInput,
} from "./child-stream-verify-types.js";

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
const IDENTITY_PROBE_CLEANUP_ATTEMPTS = 40;
const IDENTITY_PROBE_CLEANUP_DELAY_MS = 100;

function readGitIdentity(
  repoRoot: string,
): ResultAsync<
  { readonly subject: string; readonly dirty: boolean },
  VerifyChildStreamingFailure
> {
  return runVerifierCommand(["git", "rev-parse", "HEAD"], repoRoot).andThen(
    (head) => {
      if (head.exitCode !== 0 || !/^[0-9a-f]{40}$/u.test(head.stdout.trim())) {
        return errAsync(blocked("git-mismatch", "manifest-mismatch"));
      }
      return runVerifierCommand(
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
    },
  );
}

function readManifest(
  repoRoot: string,
): ResultAsync<ExtensionBuildIdentityManifest, VerifyChildStreamingFailure> {
  return readBoundedIdentityBytes(
    join(repoRoot, MANIFEST_RELATIVE_PATH),
    MAX_EXTENSION_BUILD_MANIFEST_BYTES,
    "ManifestReadFailed",
    repoRoot,
  )
    .mapErr(() => blocked("unverifiable", "unverifiable"))
    .andThen((bytes) => {
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
    if (paths.length === 0) {
      return errAsync(blocked("unverifiable", "unverifiable"));
    }
    let result = okAsync<string[], VerifyChildStreamingFailure>([]);
    for (const path of paths) {
      result = result.andThen((digests) =>
        readArtifactSha256(join(repoRoot, path), repoRoot)
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
      readArtifactSha256(join(repoRoot, output.relativePath), repoRoot)
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
          const ran = await runVerifierProcess({
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
