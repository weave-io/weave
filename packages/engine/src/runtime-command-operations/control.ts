/**
 * Control Operations — engine-owned command operations for abort and advance.
 *
 * Implements two command operations:
 *
 * - `abort-execution` (`abortExecution`): cancels or pauses an active
 *   execution via `handleUserInterrupt` with `signal: "cancel"`. Affects
 *   only the resolved intended active execution — returns typed errors when
 *   the target is missing, already terminal, or ambiguous.
 *
 * - `advance-step` (`advanceStep`): advances or completes a blocked step
 *   via `completeStep` with an explicit completion signal. Requires workflow
 *   instance, lease, step name, and completion signal.
 *
 * ## Design constraints
 *
 * - No OpenCode imports, concrete command names, concrete tool names, or
 *   harness plugin APIs appear in this module.
 * - All fallible operations return `ResultAsync<T, E>` from neverthrow.
 * - Abort affects only the resolved intended active execution — the engine
 *   resolves the active lease through the runtime store.
 * - Advance requires explicit workflow instance, lease, step name, and
 *   completion signal — no implicit state is assumed.
 * - Terminal-state executions return typed errors rather than silently
 *   succeeding or failing.
 *
 * @see docs/specs/30-spec-minimal-runtime-command-lifecycle/30-spec-minimal-runtime-command-lifecycle.md
 * @see docs/adapter-boundary.md
 * @see packages/engine/src/execution-lifecycle/interrupts.ts — handleUserInterrupt
 * @see packages/engine/src/execution-lifecycle/completion.ts — completeStep
 * @see packages/engine/src/runtime-command-operations/types.ts
 */

import type { WorkflowConfig } from "@weaveio/weave-core";
import { errAsync } from "neverthrow";
import { completeStep, handleUserInterrupt } from "../execution-lifecycle.js";
import { logger } from "../logger.js";
import type {
  AbortExecutionInput,
  AdvanceStepInput,
  CommandNotFoundError,
  CommandOperationError,
  ExecutionAbortedData,
  StepAdvancedData,
} from "./types.js";

const log = logger.child({ module: "control-operations" });

// ---------------------------------------------------------------------------
// § 1 — Terminal status guard
// ---------------------------------------------------------------------------

/** Status values that indicate a workflow instance has reached a terminal state. */
const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
] as const);

// ---------------------------------------------------------------------------
// § 2 — abortExecution — command operation entry point
// ---------------------------------------------------------------------------

/**
 * Abort (cancel or pause) an active workflow execution.
 *
 * This is the **engine-owned `abort-execution` command operation**. It
 * validates the workflow instance and lease, checks that the instance is not
 * already in a terminal state, and calls `handleUserInterrupt` with the
 * provided signal. Adapters supply the `signal` field to choose between
 * `"cancel"` (terminal) and `"pause"` (suspends for later resume).
 *
 * The operation affects only the **resolved intended active execution** — the
 * engine resolves the active lease through the runtime store and validates
 * that the provided `leaseId` matches. If the lease does not match or the
 * instance is already terminal, a typed error is returned.
 *
 * ## Validation (in order)
 *
 * 1. `workflowInstanceId` must be a non-empty string.
 * 2. `leaseId` must be a non-empty string.
 * 3. `signal` must be `"cancel"` or `"pause"`.
 * 4. The workflow instance must exist in the store.
 * 5. The instance must not be in a terminal state (`completed`, `failed`,
 *    `cancelled`). Terminal-state instances return `command_not_found`
 *    (entity: `"execution"`) rather than silently succeeding.
 * 6. The active lease must match the provided `leaseId`.
 *
 * @param input - Abort execution operation parameters.
 * @returns `ok(ExecutionAbortedData)` on success, or `err(CommandOperationError)`.
 */
export function abortExecution(
  input: AbortExecutionInput,
): import("neverthrow").ResultAsync<
  ExecutionAbortedData,
  CommandOperationError
> {
  const { workflowInstanceId, leaseId, signal, store } = input;

  if (!workflowInstanceId) {
    return errAsync({
      type: "command_validation" as const,
      message: "workflowInstanceId is required",
      field: "workflowInstanceId",
    });
  }
  if (!leaseId) {
    return errAsync({
      type: "command_validation" as const,
      message: "leaseId is required",
      field: "leaseId",
    });
  }
  if (!signal) {
    return errAsync({
      type: "command_validation" as const,
      message: "signal is required",
      field: "signal",
    });
  }

  log.info(
    { workflowInstanceId, leaseId, signal },
    "abort-execution operation started",
  );

  // Resolve the workflow instance to check for terminal state before calling
  // handleUserInterrupt. This provides a typed error for already-terminal
  // instances rather than delegating to the lifecycle layer.
  return store.instances
    .findById(workflowInstanceId)
    .mapErr(
      (storeError): CommandOperationError => ({
        type: "command_lifecycle",
        operation: "abort-execution",
        cause: {
          type: "persistence",
          message: `Failed to read workflow instance: ${storeError.message}`,
        },
      }),
    )
    .andThen((instance) => {
      if (instance === null) {
        log.warn(
          { workflowInstanceId },
          "abort-execution: workflow instance not found",
        );
        return errAsync({
          type: "command_not_found",
          entity: "execution",
          name: workflowInstanceId as string,
          message: `Workflow instance "${workflowInstanceId}" not found`,
        } satisfies CommandNotFoundError);
      }

      if (
        TERMINAL_STATUSES.has(
          instance.status as "completed" | "failed" | "cancelled",
        )
      ) {
        log.warn(
          { workflowInstanceId, status: instance.status },
          "abort-execution: instance is already in a terminal state",
        );
        return errAsync({
          type: "command_not_found",
          entity: "execution",
          name: workflowInstanceId as string,
          message: `Workflow instance "${workflowInstanceId}" is already in terminal state "${instance.status}"`,
        } satisfies CommandNotFoundError);
      }

      return handleUserInterrupt({ workflowInstanceId, leaseId, signal }, store)
        .mapErr((lifecycleError): CommandOperationError => {
          if (lifecycleError.type === "not_found") {
            log.warn(
              { workflowInstanceId, entity: lifecycleError.entity },
              "abort-execution: not found during interrupt",
            );
            return {
              type: "command_not_found",
              entity: "execution",
              name: workflowInstanceId as string,
              message: lifecycleError.message,
            } satisfies CommandNotFoundError;
          }

          if (lifecycleError.type === "lease_conflict") {
            log.warn(
              { workflowInstanceId, leaseId },
              "abort-execution: lease conflict — provided leaseId does not match active lease",
            );
            return {
              type: "command_not_found",
              entity: "lease",
              name: leaseId as string,
              message: lifecycleError.message,
            } satisfies CommandNotFoundError;
          }

          log.warn(
            { workflowInstanceId, errorType: lifecycleError.type },
            "abort-execution: lifecycle error",
          );
          return {
            type: "command_lifecycle",
            operation: "abort-execution",
            cause: lifecycleError,
          };
        })
        .map(
          ({ effects }): ExecutionAbortedData => ({
            kind: "execution-aborted",
            workflowInstanceId,
            signal,
            effects,
          }),
        );
    });
}

// ---------------------------------------------------------------------------
// § 3 — advanceStep — command operation entry point
// ---------------------------------------------------------------------------

/**
 * Advance or complete a blocked workflow step.
 *
 * This is the **engine-owned `advance-step` command operation**. It calls
 * `completeStep` with the provided completion signal to advance a blocked
 * step when no automatic completion signal is available. Adapters supply
 * the workflow instance, lease, step name, and completion signal explicitly.
 *
 * ## Validation (in order)
 *
 * 1. `workflowInstanceId` must be a non-empty string.
 * 2. `leaseId` must be a non-empty string.
 * 3. `stepName` must be a non-empty string.
 * 4. `completionSignal` must be present.
 * 5. `completionSignal.outcome` must be present.
 *
 * @param input - Advance step operation parameters.
 * @returns `ok(StepAdvancedData)` on success, or `err(CommandOperationError)`.
 */
export function advanceStep(
  input: AdvanceStepInput,
): import("neverthrow").ResultAsync<StepAdvancedData, CommandOperationError> {
  const {
    workflowInstanceId,
    leaseId,
    stepName,
    completionSignal,
    store,
    planStateProvider,
    context,
  } = input;

  if (!workflowInstanceId) {
    return errAsync({
      type: "command_validation" as const,
      message: "workflowInstanceId is required",
      field: "workflowInstanceId",
    });
  }
  if (!leaseId) {
    return errAsync({
      type: "command_validation" as const,
      message: "leaseId is required",
      field: "leaseId",
    });
  }
  if (!stepName) {
    return errAsync({
      type: "command_validation" as const,
      message: "stepName is required",
      field: "stepName",
    });
  }
  if (!completionSignal) {
    return errAsync({
      type: "command_validation" as const,
      message: "completionSignal is required",
      field: "completionSignal",
    });
  }
  if (!completionSignal.outcome) {
    return errAsync({
      type: "command_validation" as const,
      message: "completionSignal.outcome is required",
      field: "completionSignal.outcome",
    });
  }

  log.info(
    {
      workflowInstanceId,
      leaseId,
      stepName,
      outcome: completionSignal.outcome,
    },
    "advance-step operation started",
  );

  // Build the completeStep context from the optional advance-step context.
  // Cast workflows from the opaque `Record<string, unknown>` declared in
  // AdvanceStepInput to the concrete `Record<string, WorkflowConfig>`
  // required by completeStep. The lifecycle validates step existence before
  // accessing any config fields, so an invalid entry produces a typed
  // `not_found` error rather than a runtime crash.
  const completeStepContext =
    context !== undefined
      ? {
          workflowName: context.workflowName,
          goal: context.goal,
          slug: context.slug,
          workflows: context.workflows as Record<string, WorkflowConfig>,
        }
      : undefined;

  return completeStep(
    {
      workflowInstanceId,
      leaseId,
      stepName,
      completionSignal,
      context: completeStepContext,
      planStateProvider,
    },
    store,
  )
    .mapErr((lifecycleError): CommandOperationError => {
      if (lifecycleError.type === "not_found") {
        log.warn(
          { workflowInstanceId, stepName, entity: lifecycleError.entity },
          "advance-step: not found",
        );
        return {
          type: "command_not_found",
          entity: "execution",
          name: workflowInstanceId as string,
          message: lifecycleError.message,
        } satisfies CommandNotFoundError;
      }

      if (lifecycleError.type === "lease_conflict") {
        log.warn(
          { workflowInstanceId, leaseId },
          "advance-step: lease conflict — provided leaseId does not match active lease",
        );
        return {
          type: "command_not_found",
          entity: "lease",
          name: leaseId as string,
          message: lifecycleError.message,
        } satisfies CommandNotFoundError;
      }

      log.warn(
        { workflowInstanceId, stepName, errorType: lifecycleError.type },
        "advance-step: lifecycle error",
      );
      return {
        type: "command_lifecycle",
        operation: "advance-step",
        cause: lifecycleError,
      };
    })
    .map(
      ({ effects }): StepAdvancedData => ({
        kind: "step-advanced",
        workflowInstanceId,
        stepName,
        completionSignal,
        effects,
      }),
    );
}
