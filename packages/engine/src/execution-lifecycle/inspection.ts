/**
 * Execution Lifecycle — inspectExecution implementation.
 *
 * Read-only query of workflow instance execution state. Never creates
 * instances, acquires leases, updates status, or emits lifecycle effects.
 */

import { errAsync } from "neverthrow";
import type { RuntimeStore } from "../runtime/store.js";
import { lifecycleNotFoundError, lifecycleValidationError } from "./errors.js";
import { mapStoreError } from "./lease.js";
import { sanitizeMetadata } from "./metadata.js";
import type {
  InspectExecutionInput,
  InspectExecutionOutput,
  InspectExecutionResult,
  LifecycleError,
} from "./types.js";

/**
 * Inspect the current execution state of a workflow instance.
 *
 * This is a **read-only** operation — it never creates instances, acquires
 * leases, updates status, or emits lifecycle effects. It is the engine-owned
 * "inspect" operation in the `ExecutionOperationKind` vocabulary.
 *
 * **Boundary invariant**: `inspectExecution` does NOT call `startExecution`,
 * `resumeExecution`, `dispatchStep`, or `completeStep`. It is safe to call
 * from any adapter context — including idle hooks, continuation hooks, and
 * session observations — without risking implicit execution start.
 *
 * @param input - Inspect parameters from the adapter.
 * @param store - Runtime Store instance.
 * @returns `ok(InspectExecutionOutput)` on success, or a typed `LifecycleError`.
 */
export function inspectExecution(
  input: InspectExecutionInput,
  store: RuntimeStore,
): InspectExecutionResult {
  if (!input.workflowInstanceId) {
    return errAsync(
      lifecycleValidationError(
        "workflowInstanceId is required",
        "workflowInstanceId",
      ),
    );
  }

  if (input.metadata !== undefined && input.metadata !== null) {
    const metaCheck = sanitizeMetadata(input.metadata);
    if (metaCheck.isErr()) return errAsync(metaCheck.error);
  }

  return store.instances
    .findById(input.workflowInstanceId)
    .mapErr((storeError): LifecycleError => mapStoreError(storeError))
    .andThen((instance) => {
      if (instance === null) {
        return errAsync(
          lifecycleNotFoundError(
            "WorkflowInstance",
            input.workflowInstanceId as string,
          ),
        );
      }

      return store.leases
        .findActive()
        .mapErr((storeError): LifecycleError => mapStoreError(storeError))
        .map((activeLease): InspectExecutionOutput => {
          const hasActiveLease =
            activeLease !== null &&
            activeLease.workflowInstanceId === instance.id;

          const output: InspectExecutionOutput = {
            workflowInstanceId: instance.id,
            status: instance.status,
            workflowName: instance.workflowName,
            goal: instance.goal,
            slug: instance.slug,
            createdAt: instance.createdAt,
            updatedAt: instance.updatedAt,
            artifacts: instance.artifacts,
            hasActiveLease,
            ...(instance.currentStepName !== undefined
              ? { currentStepName: instance.currentStepName }
              : {}),
            ...(instance.completedAt !== undefined
              ? { completedAt: instance.completedAt }
              : {}),
            ...(instance.errorMessage !== undefined
              ? { errorMessage: instance.errorMessage }
              : {}),
          };

          return output;
        });
    });
}
