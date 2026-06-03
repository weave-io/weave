/**
 * Execution Lifecycle — artifact validation, integrity, and persistence helpers.
 *
 * Provides:
 * - Consumption-time integrity verification (SHA-256 digest comparison)
 * - Normative/informational input validation
 * - Consumed artifact record building for retry pinning
 * - Output artifact validation against declared step outputs
 * - Sequential artifact persistence
 * - Approval invalidation detection
 */

import type { WorkflowStep } from "@weave/core";
import type { ResultAsync } from "neverthrow";
import { err, ok, okAsync, type Result } from "neverthrow";
import type { RuntimeStore } from "../runtime/store.js";
import {
  lifecycleNotFoundError,
  lifecyclePolicyDecisionError,
  lifecycleValidationError,
} from "./errors.js";
import { mapStoreError } from "./lease.js";
import type {
  ArtifactInputDecl,
  ArtifactInputSummary,
  ArtifactRef,
  ArtifactRefInput,
  ConsumedArtifactRecord,
  LifecycleError,
  StepAttemptRecord,
  WorkflowInstance,
  WorkflowInstanceId,
} from "./types.js";

// ---------------------------------------------------------------------------
// Artifact lookup helpers
// ---------------------------------------------------------------------------

/**
 * Get the most recent artifact revision for a given name from the instance.
 */
export function latestArtifactByName(
  instance: WorkflowInstance,
  name: string,
): ArtifactRef | undefined {
  let latest: ArtifactRef | undefined;
  for (const a of instance.artifacts) {
    if (a.name === name) latest = a;
  }
  return latest;
}

/**
 * Get the most recent step attempt for a given step name, or undefined.
 */
export function latestAttemptForStep(
  instance: WorkflowInstance,
  stepName: string,
): StepAttemptRecord | undefined {
  let latest: StepAttemptRecord | undefined;
  for (const attempt of instance.stepAttempts) {
    if (attempt.stepName === stepName) latest = attempt;
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Approval invalidation
// ---------------------------------------------------------------------------

/**
 * Check whether a normative artifact's approval has been invalidated.
 *
 * Approval invalidation occurs when:
 * - The artifact has multiple revisions (revision > 1), AND
 * - The latest revision has `approvalState !== "approved"`, AND
 * - A prior revision exists with `approvalState === "approved"`.
 */
export function isApprovalInvalidated(
  instance: WorkflowInstance,
  artifactName: string,
): boolean {
  const revisions = instance.artifacts.filter((a) => a.name === artifactName);
  if (revisions.length <= 1) return false;

  const latest = revisions[revisions.length - 1];
  if (latest.approvalState === "approved") return false;

  const hasPriorApproval = revisions
    .slice(0, -1)
    .some((a) => a.approvalState === "approved");
  return hasPriorApproval;
}

// ---------------------------------------------------------------------------
// Integrity verification
// ---------------------------------------------------------------------------

/** Lowercase hex SHA-256 digest pattern (exactly 64 hex characters). */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Validate the format of a caller-supplied SHA-256 digest.
 */
function validateDigestFormat(
  artifactName: string,
  digest: string,
): Result<string, LifecycleError> {
  if (SHA256_HEX_RE.test(digest)) return ok(digest);
  return err(
    lifecycleValidationError(
      `artifactDigests["${artifactName}"] is not a valid SHA-256 hex digest — expected 64 lowercase hex characters`,
      `artifactDigests.${artifactName}`,
    ),
  );
}

/**
 * Verify consumption-time integrity for a single artifact.
 *
 * Compares the caller-supplied digest against the stored `integrity.digest`
 * on the artifact. Fails closed on mismatch: returns a `policy_decision`
 * error when the digests differ.
 */
export function verifyArtifactIntegrity(
  artifact: ArtifactRef,
  suppliedDigest: string | undefined,
): Result<undefined, LifecycleError> {
  if (artifact.integrity === undefined) return ok(undefined);
  if (suppliedDigest === undefined) return ok(undefined);

  const formatCheck = validateDigestFormat(artifact.name, suppliedDigest);
  if (formatCheck.isErr()) return err(formatCheck.error);

  if (suppliedDigest !== artifact.integrity.digest) {
    return err(
      lifecyclePolicyDecisionError(
        `Integrity verification failed for artifact "${artifact.name}" (revision ${artifact.revision}): ` +
          `supplied digest does not match stored digest. ` +
          `The artifact may have been tampered with or replaced since it was approved. ` +
          `Dispatch is blocked to prevent consumption of a modified artifact.`,
        "artifact_integrity",
      ),
    );
  }

  return ok(undefined);
}

// ---------------------------------------------------------------------------
// Input role classification
// ---------------------------------------------------------------------------

/**
 * Classify a declared step input as normative or informational.
 */
export function inputRole(input: {
  name: string;
  description: string;
  role?: string;
}): "normative" | "informational" {
  if (input.role === "informational") return "informational";
  return "normative";
}

// ---------------------------------------------------------------------------
// Step input validation
// ---------------------------------------------------------------------------

/**
 * Validate declared `step.inputs` artifacts against the instance's persisted
 * artifacts, distinguishing normative (blocking) from informational (advisory)
 * inputs.
 *
 * **Normative inputs** (role: `"normative"` or role absent):
 * - Must be present in the instance's artifact set.
 * - If a prior revision was approved and a new revision has been added
 *   (resetting approvalState to "pending"), dispatch is blocked with a
 *   `policy_decision` error (approval invalidation) — **unless** the artifact
 *   name is in `pinnedNames`, in which case the approval check is skipped.
 * - Returns a typed `not_found` error for the first missing normative input.
 *
 * **Informational inputs** (role: `"informational"`):
 * - Advisory only — dispatch proceeds even if absent or unapproved.
 *
 * **Integrity verification** (when `artifactDigests` is provided):
 * - For each artifact with a stored `integrity.digest`, the supplied digest
 *   is compared. A mismatch returns a `policy_decision` error (fail closed).
 */
export function validateStepInputs(
  step: WorkflowStep,
  instance: WorkflowInstance,
  artifactDigests?: Readonly<Record<string, string>>,
  pinnedNames?: ReadonlySet<string>,
): Result<ArtifactInputSummary, LifecycleError> {
  const emptyResult: ArtifactInputSummary = {
    normativeSatisfied: [],
    informationalPresent: [],
    informationalAbsent: [],
  };

  if (!step.inputs || step.inputs.length === 0) return ok(emptyResult);

  const normativeSatisfied: string[] = [];
  const informationalPresent: string[] = [];
  const informationalAbsent: string[] = [];

  for (const input of step.inputs) {
    const role = inputRole(input as ArtifactInputDecl);
    const isPinned = pinnedNames?.has(input.name) ?? false;
    const latest = latestArtifactByName(instance, input.name);

    if (latest !== undefined) {
      const integrityCheck = verifyArtifactIntegrity(
        latest,
        artifactDigests?.[input.name],
      );
      if (integrityCheck.isErr()) return err(integrityCheck.error);
    }

    if (isPinned) {
      if (role === "normative") {
        normativeSatisfied.push(input.name);
      } else {
        informationalPresent.push(input.name);
      }
      continue;
    }

    if (role === "normative") {
      if (latest === undefined) {
        return err(
          lifecycleNotFoundError(
            "artifact",
            input.name,
            `Required normative input artifact "${input.name}" is missing from workflow instance`,
          ),
        );
      }
      if (isApprovalInvalidated(instance, input.name)) {
        return err(
          lifecyclePolicyDecisionError(
            `Normative input artifact "${input.name}" (revision ${latest.revision}) has approvalState "${latest.approvalState}" — a new revision invalidated the prior approval. Dispatch is blocked until the new revision is approved.`,
            "artifact_approval",
          ),
        );
      }
      normativeSatisfied.push(input.name);
      continue;
    }

    // informational
    if (latest !== undefined) {
      informationalPresent.push(input.name);
    } else {
      informationalAbsent.push(input.name);
    }
  }

  return ok({ normativeSatisfied, informationalPresent, informationalAbsent });
}

// ---------------------------------------------------------------------------
// Consumed artifact record building
// ---------------------------------------------------------------------------

/**
 * Build the consumed artifact records for a step dispatch.
 *
 * When `pinnedRevisions` is provided, those are used directly.
 * Otherwise, the current latest revision of each declared input artifact
 * is recorded.
 */
export function buildConsumedArtifacts(
  step: WorkflowStep,
  instance: WorkflowInstance,
  pinnedRevisions: readonly ConsumedArtifactRecord[] | undefined,
): readonly ConsumedArtifactRecord[] {
  if (pinnedRevisions !== undefined) return pinnedRevisions;

  if (!step.inputs || step.inputs.length === 0) return [];

  const consumed: ConsumedArtifactRecord[] = [];
  for (const input of step.inputs) {
    const latest = latestArtifactByName(instance, input.name);
    if (latest !== undefined) {
      consumed.push({
        artifactId: latest.id,
        name: latest.name,
        revision: latest.revision,
      });
    }
  }
  return consumed;
}

// ---------------------------------------------------------------------------
// Output artifact validation
// ---------------------------------------------------------------------------

/**
 * Validate output artifacts against the step's declared `outputs`.
 *
 * Rules:
 * - When `step.outputs` is empty or undefined: no restriction.
 * - When `step.outputs` is non-empty: every declared output name MUST be
 *   present in `artifacts`. Missing declared outputs return a `validation`
 *   error. Undeclared artifact names also return a `validation` error.
 */
export function validateOutputArtifacts(
  step: WorkflowStep,
  artifacts: readonly ArtifactRefInput[] | undefined,
): Result<undefined, LifecycleError> {
  if (!step.outputs || step.outputs.length === 0) return ok(undefined);

  const providedNames = new Set((artifacts ?? []).map((a) => a.name));

  for (const declared of step.outputs) {
    if (!providedNames.has(declared.name)) {
      return err(
        lifecycleValidationError(
          `Declared output "${declared.name}" is missing from completionSignal.artifacts for step "${step.name}"`,
          "completionSignal.artifacts",
        ),
      );
    }
  }

  const declaredNames = new Set(step.outputs.map((o) => o.name));
  for (const artifact of artifacts ?? []) {
    if (!declaredNames.has(artifact.name)) {
      return err(
        lifecycleValidationError(
          `Artifact "${artifact.name}" is not declared in step "${step.name}" outputs`,
          "completionSignal.artifacts",
        ),
      );
    }
  }

  return ok(undefined);
}

// ---------------------------------------------------------------------------
// Sequential artifact persistence
// ---------------------------------------------------------------------------

/**
 * Persist a list of artifact references sequentially.
 * Returns `ok(undefined)` when all artifacts are stored, or the first
 * persistence error encountered.
 */
export function addArtifactsSequentially(
  store: RuntimeStore,
  workflowInstanceId: WorkflowInstanceId,
  artifacts: readonly ArtifactRefInput[],
): ResultAsync<undefined, LifecycleError> {
  const first = artifacts[0];
  if (!first) return okAsync(undefined);

  return store.instances
    .addArtifact(workflowInstanceId, {
      name: first.name,
      path: first.path,
      ...(first.mimeType ? { mimeType: first.mimeType } : {}),
      ...(first.description ? { description: first.description } : {}),
      ...(first.integrity ? { integrity: first.integrity } : {}),
    })
    .mapErr((storeError): LifecycleError => mapStoreError(storeError))
    .andThen(() =>
      addArtifactsSequentially(store, workflowInstanceId, artifacts.slice(1)),
    );
}
