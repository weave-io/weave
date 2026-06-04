/**
 * Execution Lifecycle — approveArtifact implementation.
 *
 * Handles artifact approval/rejection with self-approval prohibition and
 * lease enforcement.
 */

import { errAsync, okAsync } from "neverthrow";
import type { RuntimeStore } from "../runtime/store.js";
import {
  lifecycleNotFoundError,
  lifecyclePolicyDecisionError,
  lifecycleValidationError,
} from "./errors.js";
import { mapStoreError, validateActiveLease } from "./lease.js";
import { sanitizeMetadata } from "./metadata.js";
import type {
  ApproveArtifactInput,
  ApproveArtifactOutput,
  ApproveArtifactResult,
  ArtifactRef,
  LifecycleError,
} from "./types.js";

/**
 * Approve or reject an artifact produced by a prior workflow step.
 *
 * Enforces two security invariants:
 *
 * 1. **Lease enforcement**: `leaseId` is validated against the active lease
 *    for the workflow instance. A fabricated, stale, or non-matching lease ID
 *    returns a `lease_conflict` error — the engine fails closed.
 *
 * 2. **Self-approval prohibition**: `approverAgent` is required. When it
 *    matches the `producerAgent` recorded on the artifact, the engine returns
 *    a `policy_decision` error. Omitting `approverAgent` returns a `validation`
 *    error — the engine fails closed rather than silently skipping the check.
 *
 * @param input - Approval parameters from the adapter.
 * @param store - Runtime Store instance.
 * @returns `ok({ instance })` on success, or a typed `LifecycleError`.
 */
export function approveArtifact(
  input: ApproveArtifactInput,
  store: RuntimeStore,
): ApproveArtifactResult {
  if (!input.workflowInstanceId) {
    return errAsync(
      lifecycleValidationError(
        "workflowInstanceId is required",
        "workflowInstanceId",
      ),
    );
  }
  if (!input.leaseId) {
    return errAsync(lifecycleValidationError("leaseId is required", "leaseId"));
  }
  if (!input.artifactId) {
    return errAsync(
      lifecycleValidationError("artifactId is required", "artifactId"),
    );
  }
  if (!input.approvalState) {
    return errAsync(
      lifecycleValidationError("approvalState is required", "approvalState"),
    );
  }
  if (!input.approverAgent) {
    return errAsync(
      lifecycleValidationError(
        "approverAgent is required — omitting it would bypass the self-approval prohibition",
        "approverAgent",
      ),
    );
  }

  if (input.metadata !== undefined && input.metadata !== null) {
    const metaCheck = sanitizeMetadata(input.metadata);
    if (metaCheck.isErr()) return errAsync(metaCheck.error);
  }

  return store.leases
    .findActive()
    .mapErr((storeError): LifecycleError => mapStoreError(storeError))
    .andThen((activeLease) => {
      const leaseCheck = validateActiveLease(
        activeLease,
        input.workflowInstanceId,
        input.leaseId,
      );
      if (leaseCheck.isErr()) return errAsync(leaseCheck.error);
      return okAsync(undefined);
    })
    .andThen(() =>
      store.instances
        .findById(input.workflowInstanceId)
        .mapErr((storeError): LifecycleError => mapStoreError(storeError))
        .andThen((existing) => {
          if (existing === null) {
            return errAsync(
              lifecycleNotFoundError(
                "WorkflowInstance",
                input.workflowInstanceId as string,
              ),
            );
          }

          let artifact: ArtifactRef | undefined;
          for (let i = existing.artifacts.length - 1; i >= 0; i--) {
            if (existing.artifacts[i].id === input.artifactId) {
              artifact = existing.artifacts[i];
              break;
            }
          }

          if (artifact === undefined) {
            return errAsync(
              lifecycleNotFoundError(
                "ArtifactRef",
                input.artifactId as string,
                `Artifact '${input.artifactId}' not found in workflow instance`,
              ),
            );
          }

          if (
            artifact.producerAgent !== undefined &&
            input.approverAgent === artifact.producerAgent
          ) {
            return errAsync(
              lifecyclePolicyDecisionError(
                `Agent "${input.approverAgent}" cannot approve artifact "${artifact.name}" (revision ${artifact.revision}) because it produced that artifact. Self-approval is prohibited.`,
                "self_approval",
              ),
            );
          }

          return store.instances
            .updateArtifactApproval(
              input.workflowInstanceId,
              input.artifactId,
              input.approvalState,
            )
            .mapErr((storeError): LifecycleError => mapStoreError(storeError))
            .map((instance): ApproveArtifactOutput => ({ instance }));
        }),
    );
}
