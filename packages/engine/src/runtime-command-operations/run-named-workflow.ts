/**
 * Run Named Workflow — engine-owned command operation.
 *
 * Implements the `run-named-workflow` command operation: validates the
 * workflow name, drives execution through `runWorkflowLifecycle`, and
 * returns a typed `ExecutionStartedData` result. Adapter-supplied effect
 * projection is required — the engine never applies harness-specific behavior.
 *
 * ## Design constraints
 *
 * - No OpenCode imports, concrete command names, concrete tool names, or
 *   harness plugin APIs appear in this module.
 * - All fallible operations return `ResultAsync<T, E>` from neverthrow.
 * - Named workflow execution is explicitly separate from ordinary plan
 *   execution (see `start-plan.ts` for the plan-first path).
 * - `/start-work` is out of scope for this operation.
 *
 * @see docs/specs/30-spec-minimal-runtime-command-lifecycle/30-spec-minimal-runtime-command-lifecycle.md
 * @see docs/adapter-boundary.md
 * @see packages/engine/src/runtime-command-operations/workflow-runner.ts
 * @see packages/engine/src/runtime-command-operations/types.ts
 */

import type { WorkflowConfig } from "@weave/core";
import { errAsync, type ResultAsync } from "neverthrow";
import type { DispatchAgentEffect } from "../execution-lifecycle.js";
import { logger } from "../logger.js";
import type {
  CommandNotFoundError,
  CommandOperationError,
  CommandValidationError,
  ExecutionStartedData,
  RunNamedWorkflowInput,
} from "./types.js";
import {
  runWorkflowLifecycle,
  type WorkflowRunnerError,
} from "./workflow-runner.js";

const log = logger.child({ module: "run-named-workflow" });

// ---------------------------------------------------------------------------
// § 1 — mapRunnerError — convert WorkflowRunnerError to CommandOperationError
// ---------------------------------------------------------------------------

/**
 * Map a `WorkflowRunnerError` to a typed `CommandOperationError`.
 *
 * - `workflow_not_found` → `CommandNotFoundError`
 * - `max_steps_exceeded` → `CommandValidationError`
 * - `lifecycle_error`    → `CommandLifecycleError`
 * - `projection_error`   → `CommandLifecycleError` (policy_decision cause)
 */
function mapRunnerError(error: WorkflowRunnerError): CommandOperationError {
  if (error.type === "workflow_not_found") {
    return {
      type: "command_not_found",
      entity: "workflow",
      name: error.workflowName,
      message: `Workflow "${error.workflowName}" not found in the provided workflow registry`,
    } satisfies CommandNotFoundError;
  }

  if (error.type === "max_steps_exceeded") {
    return {
      type: "command_validation",
      message: `Workflow execution exceeded the maximum step limit of ${error.maxSteps}`,
      field: "maxSteps",
    } satisfies CommandValidationError;
  }

  if (error.type === "lifecycle_error") {
    return {
      type: "command_lifecycle",
      operation: "run-named-workflow",
      cause: error.cause,
    };
  }

  // projection_error
  return {
    type: "command_lifecycle",
    operation: "run-named-workflow",
    cause: {
      type: "policy_decision",
      message: error.message,
    },
  };
}

// ---------------------------------------------------------------------------
// § 2 — runNamedWorkflow — command operation entry point
// ---------------------------------------------------------------------------

/**
 * Execute a named workflow as a reusable command operation.
 *
 * This is the **engine-owned `run-named-workflow` command operation**. It
 * validates the workflow name, drives execution through `runWorkflowLifecycle`,
 * and returns a typed `ExecutionStartedData` result. Adapters supply the
 * `projectEffect` callback to apply `DispatchAgentEffect` values through
 * their own harness-specific projection behavior.
 *
 * Named workflow execution is **explicitly separate** from ordinary plan
 * execution. This operation requires the caller to name a specific workflow
 * declared in the workflow registry. It is never wired to idle hooks, session
 * events, or continuation hooks.
 *
 * ## Validation
 *
 * - `workflowName` must be a non-empty string.
 * - `goal` must be a non-empty string.
 * - `slug` must be a non-empty string.
 * - `ownerId` must be a non-empty string.
 * - `workflows` must contain an entry for `workflowName`.
 *
 * All validation failures return typed `CommandOperationError` values without
 * creating a `WorkflowInstance` or acquiring a lease.
 *
 * @param input - Named workflow operation parameters.
 * @param projectEffect - Adapter-supplied callback for projecting dispatch effects.
 * @returns `ok(ExecutionStartedData)` on success, or `err(CommandOperationError)`.
 */
export function runNamedWorkflow(
  input: RunNamedWorkflowInput,
  projectEffect: (
    effect: DispatchAgentEffect,
  ) => ResultAsync<void, WorkflowRunnerError>,
): ResultAsync<ExecutionStartedData, CommandOperationError> {
  const { workflowName, goal, slug, ownerId, store, workflows, planStateProvider, now } = input;

  // Validate required fields before touching the store.
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
    { workflowName, goal, slug, ownerId },
    "run-named-workflow operation started",
  );

  // Cast workflows from the opaque `Record<string, unknown>` declared in
  // RunNamedWorkflowInput to the concrete `Record<string, WorkflowConfig>`
  // required by runWorkflowLifecycle. The runner validates workflow existence
  // before accessing any config fields, so an invalid entry produces a typed
  // `workflow_not_found` error rather than a runtime crash.
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
    .mapErr(mapRunnerError)
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
}
