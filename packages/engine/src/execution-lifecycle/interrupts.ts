/**
 * Execution Lifecycle — handleUserInterrupt implementation.
 *
 * Handles user-initiated interrupts (pause or cancel) of in-progress
 * workflow executions.
 */

import type { ResultAsync } from "neverthrow";
import { errAsync, okAsync } from "neverthrow";
import type { RuntimeStore } from "../runtime/store.js";
import { lifecycleNotFoundError, lifecycleValidationError } from "./errors.js";
import { mapStoreError, validateActiveLease } from "./lease.js";
import { sanitizeMetadata } from "./metadata.js";
import type {
  HandleUserInterruptInput,
  HandleUserInterruptOutput,
  LifecycleError,
} from "./types.js";

/**
 * Handle a user-initiated interrupt of an in-progress execution.
 *
 * - `pause` signal: updates instance to `paused` status, returns `PauseExecutionEffect`.
 *   Does NOT set `completedAt` — the instance remains resumable.
 * - `cancel` signal: updates instance to `cancelled` status (terminal), returns
 *   `CompleteExecutionEffect`. The store automatically sets `completedAt` for
 *   terminal statuses.
 *
 * @param input - Interrupt parameters from the adapter.
 * @param store - Runtime Store instance.
 * @returns `ok({ effects })` on success, or a typed `LifecycleError`.
 */
export function handleUserInterrupt(
  input: HandleUserInterruptInput,
  store: RuntimeStore,
): ResultAsync<HandleUserInterruptOutput, LifecycleError> {
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
  if (!input.signal) {
    return errAsync(lifecycleValidationError("signal is required", "signal"));
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

          if (input.signal === "pause") {
            return store.instances
              .update(input.workflowInstanceId, { status: "paused" })
              .mapErr((storeError): LifecycleError => mapStoreError(storeError))
              .map(
                (): HandleUserInterruptOutput => ({
                  effects: [
                    {
                      kind: "pause-execution",
                      workflowInstanceId: input.workflowInstanceId,
                    },
                  ],
                }),
              );
          }

          // signal === "cancel" — terminal status
          return store.instances
            .update(input.workflowInstanceId, { status: "cancelled" })
            .mapErr((storeError): LifecycleError => mapStoreError(storeError))
            .map(
              (): HandleUserInterruptOutput => ({
                effects: [
                  {
                    kind: "complete-execution",
                    workflowInstanceId: input.workflowInstanceId,
                  },
                ],
              }),
            );
        }),
    );
}
