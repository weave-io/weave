/**
 * Execution Lifecycle — resumeExecution implementation.
 *
 * Resumes a paused or blocked workflow execution. Acquires a new lease
 * (replacing any expired lease) and transitions the instance to `running`.
 *
 * @see docs/adr/0004-workflow-first-execution-contract.md
 */

import type { ResultAsync } from "neverthrow";
import { errAsync } from "neverthrow";
import type { RuntimeStore } from "../runtime/store.js";
import { createOwnerId } from "../runtime/types.js";
import { validateAuthorizationSource } from "./authorization.js";
import { lifecycleNotFoundError, lifecycleValidationError } from "./errors.js";
import { mapConflictToLeaseConflict, mapStoreError } from "./lease.js";
import { sanitizeMetadata } from "./metadata.js";
import type {
  ExecutionAuthorizationSource,
  LifecycleEffect,
  LifecycleError,
  ResumeExecutionInput,
  ResumeExecutionOutput,
} from "./types.js";

/**
 * Resume a paused or blocked workflow execution.
 *
 * Verifies the workflow instance exists, acquires a new lease (the store
 * replaces expired leases atomically), and updates the instance to `running`.
 * Returns a typed `lease_conflict` error when an unexpired foreign lease blocks
 * the operation.
 *
 * @param input - Resume parameters from the adapter.
 * @param store - Runtime Store instance.
 * @returns `ok({ leaseId, effects: [] })` on success, or a typed `LifecycleError`.
 */
export function resumeExecution(
  input: ResumeExecutionInput,
  store: RuntimeStore,
): ResultAsync<ResumeExecutionOutput, LifecycleError> {
  if (!input.workflowInstanceId) {
    return errAsync(
      lifecycleValidationError(
        "workflowInstanceId is required",
        "workflowInstanceId",
      ),
    );
  }
  if (!input.ownerId) {
    return errAsync(lifecycleValidationError("ownerId is required", "ownerId"));
  }

  const authSource: ExecutionAuthorizationSource =
    input.authorizationSource ?? "user";
  const authCheck = validateAuthorizationSource(authSource, "resumeExecution");
  if (authCheck.isErr()) return errAsync(authCheck.error);

  if (input.metadata !== undefined && input.metadata !== null) {
    const metaCheck = sanitizeMetadata(input.metadata);
    if (metaCheck.isErr()) return errAsync(metaCheck.error);
  }

  const ownerId = createOwnerId(input.ownerId);

  return store.instances
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
      return store.leases
        .acquire({
          workflowInstanceId: input.workflowInstanceId,
          ownerId,
          ttlMs: 3_600_000,
        })
        .mapErr((storeError): LifecycleError => {
          if (storeError.type === "conflict") {
            return mapConflictToLeaseConflict(
              input.workflowInstanceId,
              storeError,
            );
          }
          return mapStoreError(storeError);
        })
        .andThen((lease) =>
          store.instances
            .update(input.workflowInstanceId, { status: "running" })
            .mapErr((storeError): LifecycleError => mapStoreError(storeError))
            .map(() => lease),
        );
    })
    .map((lease) => ({
      leaseId: lease.id,
      effects: [] as LifecycleEffect[],
    }));
}
