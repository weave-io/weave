import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { err, ok, type Result } from "neverthrow";
import {
  createCleanupResourceTracker,
  runBoundedCommand,
} from "./command-runner.js";
import {
  type CleanupResourceTracker,
  type CleanupRootOptions,
  type CleanupVerification,
  EXACT_PI_VERSION,
  FIXTURE_PACKAGE_NAME,
  failure,
  type InstalledAdapterProvenance,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  type PackedArtifact,
  PI_AGENT_DIR_ENV,
  PI_SESSION_DIR_ENV,
  type ScenarioPaths,
  type SmokeCase,
  type SmokeFailure,
} from "./contract.js";
import {
  pathIsSymlink,
  safeAbsolutePath,
  validateCreatedIsolatedPathPolicy,
  validateIsolatedPathPolicy,
} from "./environment.js";
import {
  commandOk,
  fixturePackageJson,
  installRollbackShim,
  isolatedEnvironment,
  makeDirectory,
  runtimePackageJson,
  settingsJson,
  shellSafePath,
  trustJson,
  weaveSmokeConfig,
  writeText,
} from "./fixture-files.js";
import {
  controlObserverSource,
  fixtureSource,
  validateControlObserverSource,
  validateFixtureSourceBoundary,
} from "./fixture-sources.js";
import {
  inspectPiCliProvenance,
  verifyArtifactFileUnchanged,
  verifyInstalledAdapterPackage,
} from "./provenance.js";
import { cleanupRoot } from "./verified-cleanup.js";

function resolveBunCliPath(): string {
  const requested = Bun.env.BUN_CLI;
  if (requested !== undefined) {
    return isAbsolute(requested)
      ? resolve(requested)
      : (Bun.which(requested) ?? "");
  }
  const voltaHome = Bun.env.VOLTA_HOME ?? join(Bun.env.HOME ?? "", ".volta");
  const candidates = [
    join(
      voltaHome,
      "tools/image/packages/bun/lib/node_modules/bun/bin/bun.exe",
    ),
    process.execPath,
    Bun.argv[0] ?? "",
    Bun.which("bun") ?? "",
  ];
  return (
    candidates.find(
      (candidate) =>
        isAbsolute(candidate) &&
        !candidate.endsWith("/volta-shim") &&
        !candidate.includes("/volta/bin/"),
    ) ?? ""
  );
}

export async function setupScenario(
  artifact: PackedArtifact,
  smokeCase: Exclude<SmokeCase, "all">,
  timeoutMs: number,
): Promise<
  Result<
    {
      readonly paths: ScenarioPaths;
      readonly env: Record<string, string>;
      readonly tracker: CleanupResourceTracker;
      readonly runtimeStatusCommand: CleanupRootOptions["runtimeStatusCommand"];
      readonly installed: InstalledAdapterProvenance;
    },
    SmokeFailure
  >
> {
  const root = join(tmpdir(), `weave-pi-model-failover-${crypto.randomUUID()}`);
  const repoRoot = resolve(".");
  const artifactParent = resolve(dirname(artifact.path));
  const tempRoot = resolve(tmpdir());
  const privateArtifactParent =
    artifactParent === tempRoot || artifactParent === "/private/tmp"
      ? undefined
      : artifactParent;
  const forbiddenPaths = [
    Bun.env.HOME,
    Bun.env[PI_AGENT_DIR_ENV],
    Bun.env[PI_SESSION_DIR_ENV],
    Bun.env.PI_SESSION_FILE === undefined
      ? undefined
      : dirname(Bun.env.PI_SESSION_FILE),
    repoRoot,
    privateArtifactParent,
  ].filter((path): path is string => path !== undefined);
  const bunCli = resolveBunCliPath();
  const expectCli = Bun.which("expect") ?? "";
  if (!safeAbsolutePath(bunCli) || !safeAbsolutePath(expectCli))
    return err(
      failure(
        "StrictProvenanceViolation",
        "the isolated smoke requires absolute Bun and expect executables",
      ),
    );
  const paths: ScenarioPaths = {
    root,
    home: join(root, "home"),
    piHome: join(root, "pi"),
    configHome: join(root, "xdg-config"),
    dataHome: join(root, "xdg-data"),
    cacheHome: join(root, "xdg-cache"),
    stateHome: join(root, "xdg-state"),
    sessionDir: join(root, "pi/sessions"),
    project: join(root, "project"),
    capture: join(root, "capture"),
    packagePath: join(root, "pi/npm/node_modules/@weaveio/weave-adapter-pi"),
    fixturePath: join(root, "pi/npm/node_modules", FIXTURE_PACKAGE_NAME),
    piCli: join(
      root,
      "pi/npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    ),
    piCliPackageRoot: join(
      root,
      "pi/npm/node_modules/@earendil-works/pi-coding-agent",
    ),
    piCliPackageVersion: EXACT_PI_VERSION,
    bunCli,
    expectCli,
  };
  const completePaths = paths;
  const pathPolicy = validateIsolatedPathPolicy({
    root,
    paths: {
      home: paths.home,
      piHome: paths.piHome,
      configHome: paths.configHome,
      dataHome: paths.dataHome,
      cacheHome: paths.cacheHome,
      stateHome: paths.stateHome,
      sessionDir: paths.sessionDir,
      project: paths.project,
      capture: paths.capture,
      packagePath: paths.packagePath,
      fixturePath: paths.fixturePath,
      piCli: paths.piCli,
      piCliPackageRoot: paths.piCliPackageRoot,
    },
    forbiddenPaths,
  });
  if (pathPolicy.isErr()) return err(pathPolicy.error);
  const existingRootSymlink = await pathIsSymlink(root);
  if (existingRootSymlink.isErr())
    return err(
      failure("PathIsolationViolation", "smoke root could not be inspected"),
    );
  if (existingRootSymlink.value || (await Bun.file(root).exists()))
    return err(failure("PathIsolationViolation", "smoke root already exists"));
  const runtimeStatusCommand = {
    args: [
      paths.bunCli,
      resolve("packages/cli/src/main.ts"),
      "runtime",
      "status",
    ] as const,
    cwd: repoRoot,
  };
  const envResult = isolatedEnvironment(paths, artifact);
  if (envResult.isErr()) return err(envResult.error);
  const env = { ...envResult.value, PI_MODEL_SMOKE_CASE: smokeCase };
  const tracker = createCleanupResourceTracker(root);
  const rootMade = await commandOk(
    ["mkdir", "-m", "700", paths.root],
    tmpdir(),
    env,
    timeoutMs,
    tracker,
  );
  if (rootMade.isErr()) return err(failure("CleanupFailed", "root-not-owned"));
  let setupSignalCleanup:
    | Promise<Result<CleanupVerification, SmokeFailure>>
    | undefined;
  let setupSignalsRegistered = true;
  const currentSetupSignalCleanup = ():
    | Promise<Result<CleanupVerification, SmokeFailure>>
    | undefined => setupSignalCleanup;
  const unregisterSetupSignals = (): void => {
    if (!setupSignalsRegistered) return;
    setupSignalsRegistered = false;
    process.off("SIGINT", setupSignalHandler);
    process.off("SIGTERM", setupSignalHandler);
  };
  const requestSetupSignalCleanup = (): void => {
    setupSignalCleanup ??= cleanupRoot(root, tmpdir(), env, timeoutMs, {
      tracker,
      runtimeStatusCommand,
    });
  };
  const setupSignalHandler = (): void => {
    requestSetupSignalCleanup();
  };
  process.on("SIGINT", setupSignalHandler);
  process.on("SIGTERM", setupSignalHandler);
  const failSetup = async (
    error: SmokeFailure,
  ): Promise<
    Result<
      {
        readonly paths: ScenarioPaths;
        readonly env: Record<string, string>;
        readonly tracker: CleanupResourceTracker;
        readonly runtimeStatusCommand: CleanupRootOptions["runtimeStatusCommand"];
        readonly installed: InstalledAdapterProvenance;
      },
      SmokeFailure
    >
  > => {
    unregisterSetupSignals();
    const cleaned =
      setupSignalCleanup ??
      cleanupRoot(root, tmpdir(), env, timeoutMs, {
        tracker,
        runtimeStatusCommand,
      });
    const cleanupResult = await cleaned;
    return cleanupResult.isErr() ? err(cleanupResult.error) : err(error);
  };
  const directories = [
    completePaths.home,
    completePaths.piHome,
    completePaths.configHome,
    completePaths.dataHome,
    completePaths.cacheHome,
    completePaths.stateHome,
    completePaths.sessionDir,
    completePaths.project,
    join(completePaths.project, ".weave"),
    completePaths.capture,
    join(completePaths.piHome, "npm"),
    join(completePaths.piHome, "npm/node_modules"),
    join(completePaths.piHome, "npm/node_modules/@weaveio"),
    completePaths.packagePath,
    completePaths.fixturePath,
    join(completePaths.root, "bin"),
  ];
  for (const directory of directories) {
    if (setupSignalCleanup !== undefined)
      return failSetup(failure("UnexpectedFailure", "setup interrupted"));
    tracker.registerOwnedPath(directory);
    const made = await makeDirectory(
      directory,
      tmpdir(),
      env,
      timeoutMs,
      tracker,
    );
    if (made.isErr()) return failSetup(made.error);
  }
  const createdPathPolicy = await validateCreatedIsolatedPathPolicy({
    root,
    paths: {
      home: paths.home,
      piHome: paths.piHome,
      configHome: paths.configHome,
      dataHome: paths.dataHome,
      cacheHome: paths.cacheHome,
      stateHome: paths.stateHome,
      sessionDir: paths.sessionDir,
      project: paths.project,
      capture: paths.capture,
      packagePath: paths.packagePath,
      fixturePath: paths.fixturePath,
    },
    forbiddenPaths,
  });
  if (createdPathPolicy.isErr()) return failSetup(createdPathPolicy.error);
  const providerSource = validateFixtureSourceBoundary(fixtureSource());
  if (providerSource.isErr()) return failSetup(providerSource.error);
  const controlSource = validateControlObserverSource(controlObserverSource());
  if (controlSource.isErr()) return failSetup(controlSource.error);
  const writes: Array<Promise<Result<void, SmokeFailure>>> = [
    writeText(
      join(completePaths.project, ".weave/config.weave"),
      weaveSmokeConfig(),
    ),
    writeText(
      join(completePaths.piHome, "npm/package.json"),
      runtimePackageJson(),
    ),
    writeText(join(completePaths.piHome, "settings.json"), settingsJson()),
    writeText(
      join(completePaths.piHome, "trust.json"),
      trustJson(completePaths.project),
    ),
    writeText(
      join(completePaths.fixturePath, "package.json"),
      fixturePackageJson(),
    ),
    writeText(
      join(completePaths.fixturePath, "provider.js"),
      providerSource.value,
    ),
    writeText(
      join(completePaths.fixturePath, "control-observer.js"),
      controlSource.value,
    ),
  ];
  for (const result of await Promise.all(writes))
    if (result.isErr()) return failSetup(result.error);
  if (setupSignalCleanup !== undefined)
    return failSetup(failure("UnexpectedFailure", "setup interrupted"));
  const bunWrapper = `#!/bin/sh\nexec '${shellSafePath(completePaths.bunCli)}' '${shellSafePath(completePaths.piCli)}' "$@"\n`;
  const wrapper = await writeText(
    join(completePaths.root, "bin/pi"),
    bunWrapper,
  );
  if (wrapper.isErr()) return failSetup(wrapper.error);
  if (setupSignalCleanup !== undefined)
    return failSetup(failure("UnexpectedFailure", "setup interrupted"));
  const chmod = await commandOk(
    ["chmod", "700", join(completePaths.root, "bin/pi")],
    completePaths.project,
    env,
    timeoutMs,
    tracker,
  );
  if (chmod.isErr()) return failSetup(chmod.error);

  const installEnv = {
    ...env,
    ...(Bun.env.BUN_INSTALL !== undefined &&
    safeAbsolutePath(Bun.env.BUN_INSTALL)
      ? { BUN_INSTALL: resolve(Bun.env.BUN_INSTALL) }
      : {}),
  };
  const bunInstall = await runBoundedCommand(
    [
      completePaths.bunCli,
      "install",
      "--production",
      "--offline",
      "--ignore-scripts",
      "--backend=copyfile",
    ],
    {
      cwd: join(completePaths.piHome, "npm"),
      env: installEnv,
      timeoutMs,
      resources: tracker,
    },
  );
  if (bunInstall.isErr())
    return failSetup(
      failure(
        "StrictProvenanceViolation",
        "isolated Pi package installation failed",
      ),
    );
  const piProvenance = await inspectPiCliProvenance(completePaths.piCli, {
    expectedVersion: EXACT_PI_VERSION,
    forbiddenPaths,
  });
  if (piProvenance.isErr()) return failSetup(piProvenance.error);
  if (piProvenance.value.packageRoot !== completePaths.piCliPackageRoot)
    return failSetup(
      failure(
        "StrictProvenanceViolation",
        "Pi CLI package root is not isolated",
      ),
    );

  if (setupSignalCleanup !== undefined)
    return failSetup(failure("UnexpectedFailure", "setup interrupted"));
  const extract = await commandOk(
    [
      "tar",
      "-xzf",
      artifact.path,
      "-C",
      completePaths.packagePath,
      "--strip-components=1",
    ],
    completePaths.project,
    env,
    timeoutMs,
    tracker,
  );
  if (extract.isErr())
    return failSetup(
      failure("ArtifactMalformed", "packed adapter could not be unpacked"),
    );
  const populatedPathPolicy = await validateCreatedIsolatedPathPolicy({
    root,
    paths: {
      home: paths.home,
      piHome: paths.piHome,
      configHome: paths.configHome,
      dataHome: paths.dataHome,
      cacheHome: paths.cacheHome,
      stateHome: paths.stateHome,
      sessionDir: paths.sessionDir,
      project: paths.project,
      capture: paths.capture,
      packagePath: paths.packagePath,
      fixturePath: paths.fixturePath,
      piCli: paths.piCli,
      piCliPackageRoot: paths.piCliPackageRoot,
    },
    forbiddenPaths,
  });
  if (populatedPathPolicy.isErr()) return failSetup(populatedPathPolicy.error);
  const artifactUnchanged = await verifyArtifactFileUnchanged(
    artifact.path,
    artifact.sha256,
  );
  if (artifactUnchanged.isErr()) return failSetup(artifactUnchanged.error);
  const installed = await verifyInstalledAdapterPackage({
    packageRoot: completePaths.packagePath,
    expectedPackageRoot: completePaths.packagePath,
    expectedPackageName: PACKAGE_NAME,
    expectedPackageVersion: PACKAGE_VERSION,
    expectedExtensionSha256: artifact.extensionSha256,
  });
  if (installed.isErr()) return failSetup(installed.error);
  if (
    !installed.value.packageRootMatched ||
    !installed.value.extensionHashMatched
  )
    return failSetup(
      failure(
        "StrictProvenanceViolation",
        "installed adapter provenance does not match the packed artifact",
      ),
    );
  if (smokeCase === "rollback") {
    const shim = await installRollbackShim(completePaths.packagePath, tracker);
    if (shim.isErr()) return failSetup(shim.error);
  }
  unregisterSetupSignals();
  const pendingSetupCleanup = currentSetupSignalCleanup();
  if (pendingSetupCleanup !== undefined) {
    const cleanupResult = await pendingSetupCleanup;
    return cleanupResult.isErr()
      ? err(cleanupResult.error)
      : err(failure("UnexpectedFailure", "setup interrupted"));
  }
  return ok({
    paths: completePaths,
    env,
    tracker,
    runtimeStatusCommand,
    installed: installed.value,
  });
}
