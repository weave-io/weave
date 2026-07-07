/**
 * Start Plan — engine-owned command operation.
 *
 * Implements the `start-plan` command operation: validates the plan name via
 * `PlanStateProvider`, validates the workflow name, drives execution through
 * `runWorkflowLifecycle`, and returns a typed `ExecutionStartedData` result.
 * Adapter-supplied effect projection is required — the engine never applies
 * harness-specific behavior.
 *
 * ## Design constraints
 *
 * - No OpenCode imports, concrete command names, concrete tool names, or
 *   harness plugin APIs appear in this module.
 * - All fallible operations return `ResultAsync<T, E>` from neverthrow.
 * - Plan execution is **explicitly separate** from named workflow execution
 *   (see `run-named-workflow.ts` for the named-workflow path).
 * - The engine validates the plan via `PlanStateProvider` before creating
 *   any `WorkflowInstance`. If `planStateProvider` is absent, the operation
 *   returns a `command_validation` error without touching the store.
 * - `/start-work` is out of scope for this operation.
 *
 * @see docs/specs/30-spec-minimal-runtime-command-lifecycle/30-spec-minimal-runtime-command-lifecycle.md
 * @see docs/adapter-boundary.md
 * @see packages/engine/src/runtime-command-operations/workflow-runner.ts
 * @see packages/engine/src/runtime-command-operations/types.ts
 * @see packages/engine/src/plan-state-provider.ts
 */

import type { WorkflowConfig } from "@weaveio/weave-core";
import { errAsync, type ResultAsync } from "neverthrow";
import type { DispatchAgentEffect } from "../execution-lifecycle.js";
import { logger } from "../logger.js";
import type {
  CommandNotFoundError,
  CommandOperationError,
  CommandValidationError,
  ExecutionStartedData,
  StartPlanInput,
} from "./types.js";
import {
  mapRunnerErrorToCommandError,
  runWorkflowLifecycle,
  type WorkflowRunnerError,
} from "./workflow-runner.js";

const log = logger.child({ module: "start-plan" });

// ---------------------------------------------------------------------------
// § 1 — startPlan — command operation entry point
// ---------------------------------------------------------------------------

/**
 * Start execution of a named plan as a reusable command operation.
 *
 * This is the **engine-owned `start-plan` command operation**. It validates
 * the plan name via `PlanStateProvider`, validates the workflow name, drives
 * execution through `runWorkflowLifecycle`, and returns a typed
 * `ExecutionStartedData` result. Adapters supply the `projectEffect` callback
 * to apply `DispatchAgentEffect` values through their own harness-specific
 * projection behavior.
 *
 * Plan execution is **explicitly separate** from named workflow execution.
 * This operation validates that the named plan exists before creating any
 * `WorkflowInstance`. It is never wired to idle hooks, session events, or
 * continuation hooks.
 *
 * ## Validation (in order — all fail before touching the store)
 *
 * 1. `planStateProvider` must be present — absence returns `command_validation`.
 * 2. `planName` must be a non-empty string.
 * 3. `workflowName` must be a non-empty string.
 * 4. `goal` must be a non-empty string.
 * 5. `slug` must be a non-empty string.
 * 6. `ownerId` must be a non-empty string.
 * 7. `planStateProvider.planExists(planName)` must return `ok(true)`.
 *    - `InvalidPlanName` error → `command_validation` (field: "planName").
 *    - `ProviderUnavailable` error → `command_validation` (field: "planStateProvider").
 *    - `ok(false)` → `command_not_found` (entity: "plan").
 * 8. `workflows` must contain an entry for `workflowName`.
 *
 * All validation failures return typed `CommandOperationError` values without
 * creating a `WorkflowInstance` or acquiring a lease.
 *
 * @param input - Plan start operation parameters.
 * @param projectEffect - Adapter-supplied callback for projecting dispatch effects.
 * @returns `ok(ExecutionStartedData)` on success, or `err(CommandOperationError)`.
 */
export function startPlan(
  input: StartPlanInput,
  projectEffect: (
    effect: DispatchAgentEffect,
  ) => ResultAsync<void, WorkflowRunnerError>,
): ResultAsync<ExecutionStartedData, CommandOperationError> {
  const {
    planName,
    workflowName,
    goal,
    slug,
    ownerId,
    store,
    workflows,
    planStateProvider,
    now,
  } = input;

  // Validate planStateProvider presence before any other check.
  if (planStateProvider === undefined) {
    return errAsync({
      type: "command_validation" as const,
      message: "planStateProvider is required for start-plan",
      field: "planStateProvider",
    });
  }

  // Validate required scalar fields before touching the store or provider.
  if (!planName) {
    return errAsync({
      type: "command_validation" as const,
      message: "planName is required",
      field: "planName",
    });
  }
  if (!workflowName) {
    return errAsync({
      type: "command_validation" as const,
      message: "workflowName is required",
      field: "workflowName",
    });
  }
  if (!goal) {
    return errAsync({
      type: "command_validation" as const,
      message: "goal is required",
      field: "goal",
    });
  }
  if (!slug) {
    return errAsync({
      type: "command_validation" as const,
      message: "slug is required",
      field: "slug",
    });
  }
  if (!ownerId) {
    return errAsync({
      type: "command_validation" as const,
      message: "ownerId is required",
      field: "ownerId",
    });
  }

  log.info(
    { planName, workflowName, goal, slug, ownerId },
    "start-plan operation started — validating plan existence",
  );

  // Validate plan existence via PlanStateProvider before touching the store.
  return planStateProvider
    .planExists(planName)
    .mapErr((providerError): CommandOperationError => {
      if (providerError.type === "InvalidPlanName") {
        log.warn(
          { planName },
          "start-plan: plan name rejected by provider (InvalidPlanName)",
        );
        return {
          type: "command_validation",
          message: `Plan name "${planName}" is invalid: contains unsafe characters`,
          field: "planName",
        } satisfies CommandValidationError;
      }

      // ProviderUnavailable
      log.warn(
        { planName, cause: providerError.cause },
        "start-plan: PlanStateProvider unavailable",
      );
      return {
        type: "command_validation",
        message: `PlanStateProvider is unavailable: ${providerError.cause.message}`,
        field: "planStateProvider",
      } satisfies CommandValidationError;
    })
    .andThen(
      (exists): ResultAsync<ExecutionStartedData, CommandOperationError> => {
        if (!exists) {
          log.warn({ planName }, "start-plan: plan does not exist — aborting");
          return errAsync({
            type: "command_not_found",
            entity: "plan",
            name: planName,
            message: `Plan "${planName}" does not exist`,
          } satisfies CommandNotFoundError);
        }

        log.info(
          { planName, workflowName },
          "start-plan: plan exists — starting workflow lifecycle",
        );

        // Cast workflows from the opaque `Record<string, unknown>` declared in
        // StartPlanInput to the concrete `Record<string, WorkflowConfig>`
        // required by runWorkflowLifecycle. The runner validates workflow
        // existence before accessing any config fields, so an invalid entry
        // produces a typed `workflow_not_found` error rather than a runtime crash.
        const typedWorkflows = workflows as Record<string, WorkflowConfig>;

        return runWorkflowLifecycle({
          workflowName,
          goal,
          slug,
          ownerId,
          store,
          workflows: typedWorkflows,
          projectEffect,
          planStateProvider,
          now,
        })
          .mapErr((error) => mapRunnerErrorToCommandError(error, "start-plan"))
          .map(
            (output): ExecutionStartedData => ({
              kind: "execution-started",
              workflowInstanceId: output.workflowInstanceId,
              leaseId: output.leaseId,
              workflowName,
              goal,
              slug,
              effects: output.effects,
            }),
          );
      },
    );
}
