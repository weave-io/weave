import { err, ok, type Result } from "neverthrow";
import {
  CHECKLIST_VERSION,
  EXACT_PI_VERSION,
  type FallbackScenarioFacts,
  type FixtureSnapshot,
  failure,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  type RollbackScenarioFacts,
  type SmokeCliArgs,
  type SmokeFailure,
  type SmokeProvenance,
  type SmokeReport,
} from "./contract.js";
import { validateFallbackFacts } from "./fallback-validation.js";
import { inspectPackedArtifact } from "./provenance.js";
import { validateRollbackFacts } from "./rollback-validation.js";
import { runScenario } from "./scenario-runner.js";

function findSnapshot(
  snapshots: readonly FixtureSnapshot[],
  role: FixtureSnapshot["role"],
): FixtureSnapshot | undefined {
  return snapshots.find((snapshot) => snapshot.role === role);
}

function sameSmokeProvenance(
  left: SmokeProvenance,
  right: SmokeProvenance,
): boolean {
  return (
    left.artifactUnchanged === right.artifactUnchanged &&
    left.installedPackageVersion === right.installedPackageVersion &&
    left.installedExtensionSha256 === right.installedExtensionSha256 &&
    left.loadedAdapterPackageVersion === right.loadedAdapterPackageVersion &&
    left.loadedAdapterExtensionSha256 === right.loadedAdapterExtensionSha256 &&
    left.packageSourceProven === right.packageSourceProven &&
    left.packageRootMatched === right.packageRootMatched &&
    left.loadedExtensionHashMatched === right.loadedExtensionHashMatched &&
    left.piPackageVersion === right.piPackageVersion
  );
}

export async function runReleaseSmoke(
  args: SmokeCliArgs,
): Promise<Result<SmokeReport, SmokeFailure>> {
  const artifact = await inspectPackedArtifact(
    args.artifact,
    args.expectedArtifactSha256,
  );
  if (artifact.isErr()) return err(artifact.error);
  if (artifact.value.packageVersion !== PACKAGE_VERSION)
    return err(
      failure(
        "ArtifactMalformed",
        "adapter package version is not the release version",
      ),
    );
  let provenance: SmokeProvenance | undefined;
  const recordProvenance = (
    candidate: SmokeProvenance | undefined,
  ): Result<void, SmokeFailure> => {
    if (candidate === undefined)
      return err(
        failure(
          "StrictProvenanceViolation",
          "scenario omitted package provenance",
        ),
      );
    if (provenance !== undefined && !sameSmokeProvenance(provenance, candidate))
      return err(
        failure(
          "StrictProvenanceViolation",
          "scenario package provenance disagrees",
        ),
      );
    provenance = candidate;
    return ok(undefined);
  };
  let fallback: FallbackScenarioFacts | undefined;
  let rollback: RollbackScenarioFacts | undefined;
  if (args.smokeCase === "fallback" || args.smokeCase === "all") {
    const run = await runScenario(artifact.value, "fallback", args.timeoutMs);
    if (run.isErr()) return err(run.error);
    const provenanceResult = recordProvenance(run.value.provenance);
    if (provenanceResult.isErr()) return err(provenanceResult.error);
    const child = findSnapshot(run.value.captures, "child");
    const parent = findSnapshot(run.value.captures, "parent");
    if (child === undefined || parent === undefined)
      return err(
        failure(
          "CaptureMalformed",
          "fallback fixture did not capture parent and child",
        ),
      );
    const facts = validateFallbackFacts({
      observation: run.value,
      child,
      parent,
    });
    if (facts.isErr()) return err(facts.error);
    fallback = facts.value;
  }
  if (args.smokeCase === "rollback" || args.smokeCase === "all") {
    const run = await runScenario(artifact.value, "rollback", args.timeoutMs);
    if (run.isErr()) return err(run.error);
    const provenanceResult = recordProvenance(run.value.provenance);
    if (provenanceResult.isErr()) return err(provenanceResult.error);
    const parent = findSnapshot(run.value.captures, "parent");
    if (parent === undefined)
      return err(
        failure("CaptureMalformed", "rollback fixture did not capture parent"),
      );
    const facts = validateRollbackFacts({ observation: run.value, parent });
    if (facts.isErr()) return err(facts.error);
    rollback = facts.value;
  }
  if (provenance === undefined)
    return err(
      failure(
        "StrictProvenanceViolation",
        "no scenario produced package provenance",
      ),
    );
  return ok({
    schemaVersion: 1,
    checklistVersion: CHECKLIST_VERSION,
    artifact: {
      packageName: PACKAGE_NAME,
      packageVersion: artifact.value.packageVersion,
      sha256: artifact.value.sha256,
    },
    pi: {
      expectedVersion: EXACT_PI_VERSION,
      observedVersion: provenance.piPackageVersion,
    },
    provenance,
    ...(fallback === undefined ? {} : { fallback }),
    ...(rollback === undefined ? {} : { rollback }),
    diagnostics: [
      "real-pi-tui",
      "isolated-home",
      "strict-npm-provenance",
      "packed-artifact",
      "bounded-timeout",
      "ephemeral-report",
    ],
  });
}
