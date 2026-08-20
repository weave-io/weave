import { dirname, join, resolve } from "node:path";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { runBoundedCommand } from "./command-runner.js";
import {
  ADAPTER_SOURCE_PROVEN_ENV,
  type CleanupResourceTracker,
  EXACT_PI_VERSION,
  EXPECTED_EXTENSION_SHA_ENV,
  EXPECTED_PACKAGE_ROOT_ENV,
  EXPECTED_PACKAGE_VERSION_ENV,
  FIXTURE_PACKAGE_NAME,
  FIXTURE_PACKAGE_VERSION,
  failure,
  isRecord,
  PACKAGE_NAME,
  type PackedArtifact,
  PI_AGENT_DIR_ENV,
  PI_SESSION_DIR_ENV,
  ROLLBACK_SHIM_FILENAME,
  SAFE_SYSTEM_PATH,
  type ScenarioPaths,
  type SmokeFailure,
  XDG_CACHE_ENV,
  XDG_CONFIG_ENV,
  XDG_DATA_ENV,
  XDG_STATE_ENV,
} from "./contract.js";
import { validateStrictProvenanceEnvironment } from "./environment.js";
import {
  rollbackShimSource,
  validateRollbackShimSource,
} from "./fixture-sources.js";
export function shellSafePath(path: string): string {
  return path.replaceAll("'", "'\\''");
}

export async function commandOk(
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  resources?: CleanupResourceTracker,
): Promise<Result<void, SmokeFailure>> {
  const result = await runBoundedCommand(args, {
    cwd,
    env,
    timeoutMs,
    resources,
  });
  return result.map(() => undefined);
}

export async function makeDirectory(
  path: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  resources?: CleanupResourceTracker,
): Promise<Result<void, SmokeFailure>> {
  const made = await commandOk(
    ["mkdir", "-m", "700", "-p", path],
    cwd,
    env,
    timeoutMs,
    resources,
  );
  if (made.isErr()) return err(made.error);
  return commandOk(["chmod", "700", path], cwd, env, timeoutMs, resources);
}
export function fixturePackageJson(): string {
  return `${JSON.stringify(
    {
      name: FIXTURE_PACKAGE_NAME,
      version: FIXTURE_PACKAGE_VERSION,
      private: true,
      type: "module",
      pi: { extensions: ["./provider.js", "./control-observer.js"] },
    },
    null,
    2,
  )}\n`;
}

export function weaveSmokeConfig(): string {
  return `agent loom {
  prompt "Run the deterministic model fallback smoke task."
  models ["smoke/first", "smoke/second"]
  mode primary
  tool_policy {
    read allow
    write deny
    execute deny
    network deny
    delegate allow
  }
}

agent shuttle {
  prompt "Run the deterministic model fallback child task."
  models ["smoke/first", "smoke/second"]
  mode subagent
  tool_policy {
    read allow
    write deny
    execute deny
    network deny
    delegate deny
  }
}

settings {
  log_level ERROR
}
`;
}

export function settingsJson(): string {
  return `${JSON.stringify(
    {
      packages: [`npm:${FIXTURE_PACKAGE_NAME}`, `npm:${PACKAGE_NAME}`],
    },
    null,
    2,
  )}\n`;
}

export function trustJson(project: string): string {
  return `${JSON.stringify({ [resolve(project)]: true }, null, 2)}\n`;
}

export function runtimePackageJson(): string {
  return `${JSON.stringify(
    {
      name: "weave-pi-model-fallback-runtime",
      private: true,
      type: "module",
      dependencies: {
        "@earendil-works/pi-ai": EXACT_PI_VERSION,
        "@earendil-works/pi-coding-agent": EXACT_PI_VERSION,
        "@earendil-works/pi-tui": EXACT_PI_VERSION,
        kysely: "0.27.6",
        mustache: "4.2.0",
        neverthrow: "8.2.0",
        pino: "9.14.0",
        typebox: "1.1.38",
        zod: "4.4.3",
      },
    },
    null,
    2,
  )}\n`;
}

export function isolatedEnvironment(
  paths: ScenarioPaths,
  artifact: PackedArtifact,
): Result<Record<string, string>, SmokeFailure> {
  const env = {
    PATH: `${dirname(paths.expectCli)}:${dirname(paths.bunCli)}:${SAFE_SYSTEM_PATH}`,
    HOME: paths.home,
    [XDG_CONFIG_ENV]: paths.configHome,
    [XDG_DATA_ENV]: paths.dataHome,
    [XDG_CACHE_ENV]: paths.cacheHome,
    [XDG_STATE_ENV]: paths.stateHome,
    [PI_AGENT_DIR_ENV]: paths.piHome,
    [PI_SESSION_DIR_ENV]: paths.sessionDir,
    PI_OFFLINE: "1",
    PI_MODEL_SMOKE_CAPTURE_DIR: paths.capture,
    [EXPECTED_PACKAGE_ROOT_ENV]: paths.packagePath,
    [EXPECTED_EXTENSION_SHA_ENV]: artifact.extensionSha256,
    [EXPECTED_PACKAGE_VERSION_ENV]: artifact.packageVersion,
    [ADAPTER_SOURCE_PROVEN_ENV]: "1",
  };
  return validateStrictProvenanceEnvironment(env).map((value) => ({
    ...value,
  }));
}

export async function writeText(
  path: string,
  value: string,
): Promise<Result<void, SmokeFailure>> {
  const written = await ResultAsync.fromThrowable(
    async () => {
      await Bun.write(path, value);
      const chmod = Bun.spawn(
        [Bun.which("chmod") ?? "/bin/chmod", "600", path],
        {
          cwd: dirname(path),
          env: { PATH: SAFE_SYSTEM_PATH },
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      if ((await chmod.exited) !== 0) throw new Error("chmod failed");
    },
    () => failure("UnexpectedFailure", "could not write ephemeral fixture"),
  )();
  return written.map(() => undefined);
}

export async function installRollbackShim(
  packageRoot: string,
  tracker: CleanupResourceTracker,
): Promise<Result<void, SmokeFailure>> {
  const source = validateRollbackShimSource(rollbackShimSource());
  if (source.isErr()) return err(source.error);
  const manifestPath = join(packageRoot, "package.json");
  const manifest = await ResultAsync.fromThrowable(
    () => Bun.file(manifestPath).json() as Promise<unknown>,
    () =>
      failure("StrictProvenanceViolation", "adapter manifest is unreadable"),
  )();
  if (manifest.isErr()) return err(manifest.error);
  if (!isRecord(manifest.value) || !isRecord(manifest.value.pi))
    return err(
      failure(
        "StrictProvenanceViolation",
        "packed adapter has no extension manifest",
      ),
    );
  const extensions = manifest.value.pi.extensions;
  if (
    !Array.isArray(extensions) ||
    extensions.some((entry) => typeof entry !== "string")
  )
    return err(
      failure(
        "StrictProvenanceViolation",
        "packed adapter extension manifest is invalid",
      ),
    );
  const shimPath = join(packageRoot, "dist", ROLLBACK_SHIM_FILENAME);
  if (!tracker.registerOwnedPath(shimPath))
    return err(failure("PathIsolationViolation", "rollback shim is not owned"));
  const shim = await writeText(shimPath, source.value);
  if (shim.isErr()) return err(shim.error);
  const rewrittenManifest = {
    ...manifest.value,
    pi: {
      ...manifest.value.pi,
      extensions: [`./dist/${ROLLBACK_SHIM_FILENAME}`],
    },
  };
  return writeText(
    manifestPath,
    `${JSON.stringify(rewrittenManifest, null, 2)}\n`,
  );
}

export async function pathExists(
  path: string,
): Promise<Result<boolean, SmokeFailure>> {
  return ResultAsync.fromThrowable(
    () => Bun.file(path).exists(),
    () => failure("CleanupFailed", "root-still-present"),
  )();
}

export async function removeOwnedFile(
  path: string,
): Promise<Result<void, SmokeFailure>> {
  const removed = await ResultAsync.fromThrowable(
    () => Bun.file(path).delete(),
    () => failure("CleanupFailed", "resource-dispose-failed"),
  )();
  if (removed.isErr()) return err(removed.error);
  const exists = await pathExists(path);
  if (exists.isErr()) return err(exists.error);
  return exists.value
    ? err(failure("CleanupFailed", "resource-still-open"))
    : ok(undefined);
}
