/**
 * Execution Lifecycle — lease validation helpers.
 *
 * Centralises the three-check active-lease validation block used by
 * handleUserInterrupt, dispatchStep, completeStep, approveArtifact, and
 * reconcileExecution. Also provides the store-error mapping helpers.
 *
 * @see packages/engine/src/execution-lifecycle/types.ts — error types
 */

import { err, ok, type Result } from "neverthrow";
import type { RuntimeStoreConflictError } from "../runtime/errors.js";
import {
  lifecycleLeaseConflictError,
  lifecyclePersistenceError,
} from "./errors.js";
import type {
  ExecutionLease,
  ExecutionLeaseId,
  LifecycleError,
  LifecycleLeaseConflictError,
  LifecyclePersistenceError,
  WorkflowInstanceId,
} from "./types.js";

/**
 * Map any store error to a `LifecyclePersistenceError`.
 *
 * Centralises the inline `lifecyclePersistenceError(storeError.message, {
 * type: storeError.type, message: storeError.message })` patterns.
 * The cause preserves the discriminant and message only — raw store internals
 * (SQL, file paths, stack traces) are never leaked.
 */
export function mapStoreError(storeError: {
  readonly type: string;
  readonly message: string;
}): LifecyclePersistenceError {
  return lifecyclePersistenceError(storeError.message, {
    type: storeError.type,
    message: storeError.message,
  });
}

/**
 * Map a `RuntimeStoreConflictError` to a `LifecycleLeaseConflictError`.
 *
 * The conflicting lease ID is extracted from `conflictingId` when present.
 */
export function mapConflictToLeaseConflict(
  workflowInstanceId: WorkflowInstanceId,
  storeError: RuntimeStoreConflictError,
): LifecycleLeaseConflictError {
  const conflictingLeaseId = storeError.conflictingId
    ? (storeError.conflictingId as ExecutionLeaseId)
    : ("unknown" as ExecutionLeaseId);
  return lifecycleLeaseConflictError(
    workflowInstanceId,
    conflictingLeaseId,
    storeError.message,
  );
}

/**
 * Validate the active lease against the caller-supplied `workflowInstanceId`
 * and `leaseId`.
 *
 * Checks:
 *   1. No active lease → `lease_conflict("none")`
 *   2. Lease ID mismatch → `lease_conflict(activeLease.id)`
 *   3. Instance ID mismatch → `lease_conflict(activeLease.id)`
 *
 * Returns `ok(activeLease)` when all checks pass.
 */
export function validateActiveLease(
  activeLease: ExecutionLease | null,
  workflowInstanceId: WorkflowInstanceId,
  leaseId: ExecutionLeaseId,
): Result<ExecutionLease, LifecycleError> {
  if (activeLease === null) {
    return err(
      lifecycleLeaseConflictError(
        workflowInstanceId,
        "none" as ExecutionLeaseId,
        "No active lease for this workflow instance",
      ),
    );
  }
  if (activeLease.id !== leaseId) {
    return err(
      lifecycleLeaseConflictError(
        workflowInstanceId,
        activeLease.id,
        "Provided lease ID does not match the active lease",
      ),
    );
  }
  if (activeLease.workflowInstanceId !== workflowInstanceId) {
    return err(
      lifecycleLeaseConflictError(
        workflowInstanceId,
        activeLease.id,
        `Lease ${leaseId} belongs to workflow ${activeLease.workflowInstanceId}, not ${workflowInstanceId}`,
      ),
    );
  }
  return ok(activeLease);
}

// Re-export ExecutionLease for consumers of this module
export type { ExecutionLease };
