import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { err, ok, type Result } from "neverthrow";
import { runBoundedCommand } from "./command-runner.js";
import {
  type CleanupVerification,
  EXACT_PI_VERSION,
  type FixtureControlFacts,
  failure,
  type HealthFacts,
  type InstalledAdapterProvenance,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  type PackedArtifact,
  type ScenarioObservation,
  type ScenarioPaths,
  type SmokeCase,
  type SmokeFailure,
  type SmokeProvenance,
  safeDiagnostic,
} from "./contract.js";
import { parseHealthFacts, visibleEventCount } from "./health-observation.js";
import {
  assembleSnapshots,
  mergeNativeSessionObservations,
  readNativeSessionSnapshots,
} from "./native-observation.js";
import {
  inspectPiCliProvenance,
  validateLoadedAdapterProvenance,
  validatePiVersion,
  verifyArtifactFileUnchanged,
  verifyInstalledAdapterPackage,
} from "./provenance.js";
import { readCaptureSnapshots } from "./provider-observation.js";
import { runPty } from "./pty-runner.js";
import { setupScenario } from "./scenario-setup.js";
import { cleanupRoot } from "./verified-cleanup.js";

async function verifyScenarioProvenance(input: {
  readonly paths: ScenarioPaths;
  readonly artifact: PackedArtifact;
  readonly installed: InstalledAdapterProvenance;
  readonly controls: readonly FixtureControlFacts[];
}): Promise<Result<SmokeProvenance, SmokeFailure>> {
  const pi = await inspectPiCliProvenance(input.paths.piCli, {
    expectedVersion: EXACT_PI_VERSION,
    forbiddenPaths: [resolve(".")],
  });
  if (pi.isErr()) return err(pi.error);
  if (
    pi.value.packageRoot !== input.paths.piCliPackageRoot ||
    pi.value.packageVersion !== input.paths.piCliPackageVersion
  )
    return err(
      failure(
        "StrictProvenanceViolation",
        "Pi CLI did not load from the isolated package",
      ),
    );
  const installed = await verifyInstalledAdapterPackage({
    packageRoot: input.paths.packagePath,
    expectedPackageRoot: input.paths.packagePath,
    expectedPackageName: PACKAGE_NAME,
    expectedPackageVersion: PACKAGE_VERSION,
    expectedExtensionSha256: input.artifact.extensionSha256,
  });
  if (installed.isErr()) return err(installed.error);
  if (
    !installed.value.packageRootMatched ||
    !installed.value.extensionHashMatched ||
    installed.value.packageVersion !== input.installed.packageVersion ||
    installed.value.extensionSha256 !== input.installed.extensionSha256
  )
    return err(
      failure(
        "StrictProvenanceViolation",
        "installed adapter changed after startup",
      ),
    );
  const artifact = await verifyArtifactFileUnchanged(
    input.artifact.path,
    input.artifact.sha256,
  );
  if (artifact.isErr()) return err(artifact.error);
  const loaded = validateLoadedAdapterProvenance({
    controls: input.controls,
    expectedPackageVersion: PACKAGE_VERSION,
    expectedExtensionSha256: input.artifact.extensionSha256,
  });
  if (loaded.isErr()) return err(loaded.error);
  if (
    !loaded.value.packageSourceProven ||
    !loaded.value.packageRootMatched ||
    !loaded.value.extensionHashMatched
  )
    return err(
      failure(
        "StrictProvenanceViolation",
        "loaded adapter source is not the isolated package",
      ),
    );
  return ok({
    artifactUnchanged: artifact.value === input.artifact.sha256,
    installedPackageVersion: installed.value.packageVersion,
    installedExtensionSha256: installed.value.extensionSha256,
    loadedAdapterPackageVersion: loaded.value.packageVersion,
    loadedAdapterExtensionSha256: loaded.value.extensionSha256,
    packageSourceProven: loaded.value.packageSourceProven,
    packageRootMatched:
      installed.value.packageRootMatched && loaded.value.packageRootMatched,
    loadedExtensionHashMatched:
      installed.value.extensionHashMatched && loaded.value.extensionHashMatched,
    piPackageVersion: pi.value.packageVersion,
  });
}

export async function runScenario(
  artifact: PackedArtifact,
  smokeCase: Exclude<SmokeCase, "all">,
  timeoutMs: number,
): Promise<
  Result<ScenarioObservation & { readonly paths: ScenarioPaths }, SmokeFailure>
> {
  const setup = await setupScenario(artifact, smokeCase, timeoutMs);
  if (setup.isErr()) return err(setup.error);
  const { paths, env, tracker, runtimeStatusCommand, installed } = setup.value;
  let signalCleanup:
    | Promise<Result<CleanupVerification, SmokeFailure>>
    | undefined;
  const requestSignalCleanup = (): void => {
    signalCleanup ??= cleanupRoot(paths.root, tmpdir(), env, timeoutMs, {
      tracker,
      runtimeStatusCommand,
    });
  };
  const signalHandler = (): void => {
    requestSignalCleanup();
  };
  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);
  let scenarioResult: Result<
    ScenarioObservation & { readonly paths: ScenarioPaths },
    SmokeFailure
  >;
  try {
    const version = await runBoundedCommand(
      [paths.bunCli, paths.piCli, "--version"],
      { cwd: paths.project, env, timeoutMs, resources: tracker },
    );
    if (version.isErr()) {
      scenarioResult = err(version.error);
    } else {
      const parsedVersion = validatePiVersion(version.value.stdout);
      if (parsedVersion.isErr()) {
        scenarioResult = err(parsedVersion.error);
      } else {
        const pty = await runPty(paths, env, smokeCase, timeoutMs, tracker);
        if (pty.isErr()) {
          scenarioResult = err(pty.error);
        } else {
          const captures = await readCaptureSnapshots(paths.capture);
          if (captures.isErr()) {
            scenarioResult = err(captures.error);
          } else {
            // Read the native source twice. Stability is accepted only after
            // the two independently observed bounded reads compare equal.
            const nativeBefore = await readNativeSessionSnapshots(
              paths,
              tracker,
            );
            if (nativeBefore.isErr()) {
              scenarioResult = err(nativeBefore.error);
            } else {
              const nativeAfter = await readNativeSessionSnapshots(
                paths,
                tracker,
              );
              if (nativeAfter.isErr()) {
                scenarioResult = err(nativeAfter.error);
              } else {
                const nativeSessions = mergeNativeSessionObservations(
                  nativeBefore.value,
                  nativeAfter.value,
                );
                if (nativeSessions.isErr()) {
                  scenarioResult = err(nativeSessions.error);
                } else {
                  const snapshots = assembleSnapshots(
                    captures.value,
                    nativeSessions.value,
                  );
                  const output = `${pty.value.stdout}\n${pty.value.stderr}`;
                  const health =
                    smokeCase === "rollback"
                      ? parseHealthFacts(output)
                      : ok<HealthFacts | undefined, SmokeFailure>(undefined);
                  const provenance = await verifyScenarioProvenance({
                    paths,
                    artifact,
                    installed,
                    controls: captures.value.controls,
                  });
                  if (health.isErr()) {
                    scenarioResult = err(health.error);
                  } else if (snapshots.isErr()) {
                    scenarioResult = err(snapshots.error);
                  } else if (provenance.isErr()) {
                    scenarioResult = err(provenance.error);
                  } else {
                    scenarioResult = ok({
                      output,
                      provenance: provenance.value,
                      health: health.value,
                      visibleEventCount: visibleEventCount(output),
                      captures: snapshots.value,
                      providerCaptures: captures.value.providers,
                      nativeSessions: nativeSessions.value,
                      controls: captures.value.controls,
                      shims: captures.value.shims,
                      temporaryRootRemoved: false,
                      paths,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch (caught) {
    scenarioResult = err(failure("UnexpectedFailure", safeDiagnostic(caught)));
  }
  process.off("SIGINT", signalHandler);
  process.off("SIGTERM", signalHandler);
  const cleaned =
    signalCleanup ??
    cleanupRoot(paths.root, tmpdir(), env, timeoutMs, {
      tracker,
      runtimeStatusCommand,
    });
  const cleanupResult = await cleaned;
  if (cleanupResult.isErr()) return err(cleanupResult.error);
  return scenarioResult.map((value) => ({
    ...value,
    cleanup: cleanupResult.value,
    temporaryRootRemoved: cleanupResult.value.temporaryRootRemoved,
  }));
}
