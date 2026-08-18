import { err, ok, type Result } from "neverthrow";
import {
  type ArtifactBindingRecord,
  ArtifactBindingRecordSchema,
  type ArtifactManifest,
  ArtifactManifestSchema,
} from "./model.js";
import {
  firstDivergentPath,
  type ReleasePlan,
  type ReleasePlanArtifact,
  type ReleasePlanError,
  validateReleasePlanArtifact,
} from "./release-plan.js";

export type ArtifactManifestError = {
  type: "InvalidArtifactManifest";
  issues: readonly string[];
};

/** Binds a validated payload shape to GitHub artifact identity and attestation. */
export function validateArtifactManifest(
  input: unknown,
): Result<ArtifactManifest, ArtifactManifestError> {
  const parsed = ArtifactManifestSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidArtifactManifest",
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  return ok(parsed.data);
}

/** Validates a server-bound, content-addressed manifest. */
export function validateArtifactBindingRecord(
  input: unknown,
): Result<ArtifactBindingRecord, ArtifactManifestError> {
  const parsed = ArtifactBindingRecordSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidArtifactManifest",
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  return ok(parsed.data);
}

/** Why a workflow artifact does not serve the plan it claims to serve. */
export type PlanArtifactError =
  | ReleasePlanError
  | {
      type: "PlanManifestMismatch";
      path: string;
      expected: unknown;
      actual: unknown;
    };

/**
 * Validates the plan envelope a workflow artifact carries.
 *
 * Workflow artifacts are cache and nothing else: this proves the envelope is
 * well formed and self-consistent, never that the plan is authoritative. A
 * consumer must still recompute the plan before acting on it.
 */
export function validatePlanArtifact(
  input: unknown,
): Result<ReleasePlanArtifact, PlanArtifactError> {
  return validateReleasePlanArtifact(input);
}

/**
 * Cross-checks a cached artifact manifest against the recomputed plan.
 *
 * The manifest describes bytes; the plan decides which bytes a release is. A
 * manifest that names another channel, other packages, other versions, or a
 * SHA other than the released one is refused with the field that disagreed.
 */
export function verifyManifestAgainstPlan(
  manifest: ArtifactManifest,
  plan: ReleasePlan,
): Result<ArtifactManifest, PlanArtifactError> {
  if (plan.releasedSha === null) return err({ type: "PlanNotReleased" });
  const expected = {
    channel: plan.channel,
    releaseSubjectSha: plan.releasedSha,
    packages: plan.versions.map((entry) => entry.packageName),
    versions: Object.fromEntries(
      plan.versions.map((entry) => [entry.packageName, entry.version]),
    ),
  };
  const divergence = firstDivergentPath(
    expected,
    {
      channel: manifest.channel,
      releaseSubjectSha: manifest.releaseSubjectSha,
      packages: manifest.packages,
      versions: manifest.versions,
    },
    "manifest",
  );
  if (divergence !== null)
    return err({ type: "PlanManifestMismatch", ...divergence });
  return ok(manifest);
}
