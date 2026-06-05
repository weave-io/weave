/**
 * Inspect Status — engine-owned command operation.
 *
 * Implements the `inspect-status` command operation: reads the current
 * execution state of a workflow instance via `inspectExecution` and returns
 * a typed `ExecutionStatusData` result. This is a **read-only** operation —
 * it never creates instances, acquires leases, updates status, or emits
 * lifecycle effects.
 *
 * ## Design constraints
 *
 * - No OpenCode imports, concrete command names, concrete tool names, or
 *   harness plugin APIs appear in this module.
 * - All fallible operations return `ResultAsync<T, E>` from neverthrow.
 * - Status inspection is read-only; it never mutates any state.
 * - Active lease resolution is performed through the runtime store — the
 *   engine does not scan harness-owned directories.
 *
 * @see docs/specs/30-spec-minimal-runtime-command-lifecycle/30-spec-minimal-runtime-command-lifecycle.md
 * @see docs/adapter-boundary.md
 * @see packages/engine/src/execution-lifecycle/inspection.ts — inspectExecution
 * @see packages/engine/src/runtime-command-operations/types.ts
 */

import { errAsync } from "neverthrow";
import { inspectExecution } from "../execution-lifecycle.js";
import { logger } from "../logger.js";
import type {
  CommandNotFoundError,
  CommandOperationError,
  ExecutionStatusData,
  InspectStatusInput,
} from "./types.js";

const log = logger.child({ module: "inspect-status" });

// ---------------------------------------------------------------------------
// § 1 — inspectStatus — command operation entry point
// ---------------------------------------------------------------------------

/**
 * Inspect the current execution state of a workflow instance.
 *
 * This is the **engine-owned `inspect-status` command operation**. It reads
 * the workflow instance state via `inspectExecution` and returns a typed
 * `ExecutionStatusData` result. Active lease resolution is performed through
 * the runtime store — the engine never scans harness-owned directories.
 *
 * This operation is **read-only** — it never creates instances, acquires
 * leases, updates status, or emits lifecycle effects. It is safe to call
 * from any adapter context without risking implicit execution start.
 *
 * ## Validation
 *
 * - `workflowInstanceId` must be a non-empty string.
 *
 * @param input - Inspect status operation parameters.
 * @returns `ok(ExecutionStatusData)` on success, or `err(CommandOperationError)`.
 */
export function inspectStatus(
  input: InspectStatusInput,
): import("neverthrow").ResultAsync<
  ExecutionStatusData,
  CommandOperationError
> {
  const { workflowInstanceId, store } = input;

  if (!workflowInstanceId) {
    return errAsync({
      type: "command_validation" as const,
      message: "workflowInstanceId is required",
      field: "workflowInstanceId",
    });
  }

  log.info({ workflowInstanceId }, "inspect-status operation started");

  return inspectExecution({ workflowInstanceId }, store)
    .mapErr((lifecycleError): CommandOperationError => {
      if (lifecycleError.type === "not_found") {
        log.warn(
          { workflowInstanceId, entity: lifecycleError.entity },
          "inspect-status: workflow instance not found",
        );
        return {
          type: "command_not_found",
          entity: "execution",
          name: workflowInstanceId as string,
          message: lifecycleError.message,
        } satisfies CommandNotFoundError;
      }

      log.warn(
        { workflowInstanceId, errorType: lifecycleError.type },
        "inspect-status: lifecycle error",
      );
      return {
        type: "command_lifecycle",
        operation: "inspect-status",
        cause: lifecycleError,
      };
    })
    .map(
      (output): ExecutionStatusData => ({
        kind: "execution-status",
        workflowInstanceId: output.workflowInstanceId,
        status: output.status,
        workflowName: output.workflowName,
        goal: output.goal,
        slug: output.slug,
        createdAt: output.createdAt,
        updatedAt: output.updatedAt,
        hasActiveLease: output.hasActiveLease,
        ...(output.currentStepName !== undefined
          ? { currentStepName: output.currentStepName }
          : {}),
        ...(output.completedAt !== undefined
          ? { completedAt: output.completedAt }
          : {}),
        ...(output.errorMessage !== undefined
          ? { errorMessage: output.errorMessage }
          : {}),
        raw: output,
      }),
    );
}
