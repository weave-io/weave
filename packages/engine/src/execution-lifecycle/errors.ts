/**
 * Execution Lifecycle — error factory helpers.
 *
 * All lifecycle error constructors live here. Import from this module
 * rather than constructing error objects inline.
 *
 * @see packages/engine/src/execution-lifecycle/types.ts — error type definitions
 */

import type {
  ExecutionLeaseId,
  LifecycleLeaseConflictError,
  LifecycleNotFoundError,
  LifecyclePersistenceError,
  LifecyclePolicyDecisionError,
  LifecycleValidationError,
  WorkflowInstanceId,
} from "./types.js";

/** Create a LifecycleValidationError. */
export function lifecycleValidationError(
  message: string,
  field?: string,
): LifecycleValidationError {
  return { type: "validation", message, field };
}

/** Create a LifecycleNotFoundError. */
export function lifecycleNotFoundError(
  entity: string,
  id: string,
  message?: string,
): LifecycleNotFoundError {
  return {
    type: "not_found",
    entity,
    id,
    message: message ?? `${entity} '${id}' not found`,
  };
}

/** Create a LifecycleLeaseConflictError. */
export function lifecycleLeaseConflictError(
  workflowInstanceId: WorkflowInstanceId,
  conflictingLeaseId: ExecutionLeaseId,
  message: string,
): LifecycleLeaseConflictError {
  return {
    type: "lease_conflict",
    workflowInstanceId,
    conflictingLeaseId,
    message,
  };
}

/** Create a LifecyclePersistenceError. */
export function lifecyclePersistenceError(
  message: string,
  cause?: { readonly type: string; readonly message: string },
): LifecyclePersistenceError {
  return { type: "persistence", message, cause };
}

/** Create a LifecyclePolicyDecisionError. */
export function lifecyclePolicyDecisionError(
  message: string,
  rule?: string,
): LifecyclePolicyDecisionError {
  return { type: "policy_decision", message, rule };
}
