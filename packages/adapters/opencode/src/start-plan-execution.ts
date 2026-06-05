/**
 * start-plan-execution — adapter-owned projection of the engine's start-plan operation.
 *
 * This module is the OpenCode adapter's projection of the reusable `startPlan`
 * engine operation. It supplies the adapter-owned `projectEffect` callback
 * (calling `adapter.spawnSubagent`) and maps the engine's typed
 * `CommandOperationError` result back to the adapter-owned
 * `StartPlanExecutionError` discriminated union.
 *
 * ## Boundary rule
 *
 * This module is adapter-owned. It must not import from `@weave/core` directly
 * (config types are accepted as parameters, not fetched). Command naming is
 * adapter-owned — the engine never references `WEAVE_START_COMMAND` or
 * `WEAVE_START_LEGACY_COMMAND`.
 *
 * ## Command name preference
 *
 * - `/weave:start` — preferred command surface when the harness supports namespaced
 *   commands (e.g. OpenCode's `/namespace:command` syntax).
 * - `/start-work` — legacy compatibility alias; adapters may register this as a
 *   secondary entry point for backwards compatibility.
 *
 * See `WEAVE_START_COMMAND` and `WEAVE_START_LEGACY_COMMAND` constants below.
 */

import type {
  CommandOperationError,
  PlanStateProvider,
  RuntimeStore,
} from "@weave/engine";
import { createInMemoryRuntimeStore, logger, startPlan } from "@weave/engine";
import { errAsync, type ResultAsync } from "neverthrow";

import type { OpenCodeAdapter } from "./adapter.js";
import {
  buildProjectEffect,
  deriveRunWorkflowResult,
} from "./projection-helpers.js";
import type {
  RunWorkflowError,
  RunWorkflowInput,
  RunWorkflowResult,
} from "./run-workflow.js";

// ---------------------------------------------------------------------------
// Command name constants — adapter-owned
// ---------------------------------------------------------------------------

/**
 * Preferred command name for the explicit plan-execution delivery path.
 *
 * When the harness supports namespaced commands (e.g. OpenCode's
 * `/namespace:command` syntax), register this as the primary entry point.
 *
 * This constant is adapter-owned. Core packages must never reference it.
 */
export const WEAVE_START_COMMAND = "/weave:start" as const;

/**
 * Legacy compatibility command name for the explicit plan-execution delivery path.
 *
 * Adapters may register this as a secondary entry point for backwards
 * compatibility with users who have muscle memory for the older command surface.
 *
 * Prefer `WEAVE_START_COMMAND` for new integrations.
 */
export const WEAVE_START_LEGACY_COMMAND = "/start-work" as const;

// ---------------------------------------------------------------------------
// Default workflow name — adapter-owned preference
// ---------------------------------------------------------------------------

/**
 * Default workflow name used by `startPlanExecution` when no explicit
 * `workflowName` is provided.
 *
 * `tapestry-execution` is the builtin workflow for executing an existing named
 * plan end-to-end. It is the correct default for the `/weave:start` delivery
 * path because that path is invoked when a plan already exists.
 */
export const DEFAULT_EXECUTION_WORKFLOW = "tapestry-execution" as const;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Discriminated union of errors that `startPlanExecution` can return.
 *
 * - `PlanNotFound` — the plan does not exist according to the `PlanStateProvider`.
 * - `InvalidPlanName` — the plan name failed the safe-name check in the
 *   `PlanStateProvider` (contains `/`, `..`, `\0`, or other unsafe characters).
 * - `ProviderUnavailable` — the `PlanStateProvider` could not be queried (I/O
 *   error or the provider was not supplied).
 * - `WorkflowError` — the underlying `startPlan` call returned an error.
 */
export type StartPlanExecutionError =
  | { readonly type: "PlanNotFound"; readonly planName: string }
  | { readonly type: "InvalidPlanName"; readonly planName: string }
  | {
      readonly type: "ProviderUnavailable";
      readonly cause: Error | { readonly message: string };
    }
  | { readonly type: "WorkflowError"; readonly cause: RunWorkflowError };

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

/**
 * Input for `startPlanExecution`.
 */
export interface StartPlanExecutionInput {
  /**
   * Name of the plan to execute.
   *
   * Must match a plan file at `.weave/plans/<planName>.md` (or wherever the
   * `PlanStateProvider` implementation resolves plan files).
   */
  readonly planName: string;

  /**
   * Full WeaveConfig containing workflow definitions.
   *
   * Must include the workflow referenced by `workflowName` (defaults to
   * `tapestry-execution`).
   *
   * Typed as `RunWorkflowInput["config"]` to avoid a direct `@weave/core`
   * import — the adapter boundary requires that core types flow through
   * adapter-owned modules, not be imported directly.
   */
  readonly config: RunWorkflowInput["config"];

  /**
   * Provider for querying plan file state.
   *
   * Used to validate that the plan exists before calling `startPlan`.
   * When omitted, `startPlanExecution` returns a `ProviderUnavailable` error
   * without touching the store.
   *
   * Typically `adapter.planStateProvider` (set during `adapter.init()`).
   */
  readonly planStateProvider: PlanStateProvider | undefined;

  /**
   * OpenCode adapter instance — `spawnSubagent` is called for each
   * `DispatchAgentEffect` emitted by the workflow execution loop.
   */
  readonly adapter: OpenCodeAdapter;

  /**
   * Human-readable goal for this execution instance.
   *
   * Passed through to `startPlan` as `goal`. Defaults to
   * `"Execute plan: <planName>"` when omitted.
   */
  readonly goal?: string;

  /**
   * Workflow name to execute.
   *
   * Defaults to `DEFAULT_EXECUTION_WORKFLOW` (`"tapestry-execution"`).
   */
  readonly workflowName?: string;

  /**
   * Runtime Store instance.
   *
   * Passed through to `startPlan`. Callers that need status/control to inspect
   * the execution later must supply a shared store instance here. Defaults to
   * a fresh `InMemoryRuntimeStore` when omitted.
   */
  readonly store?: RuntimeStore;
}

// ---------------------------------------------------------------------------
// mapCommandError — convert CommandOperationError to StartPlanExecutionError
// ---------------------------------------------------------------------------

/**
 * Map a `CommandOperationError` from the engine's `startPlan` operation to
 * the adapter-owned `StartPlanExecutionError` discriminated union.
 *
 * - `command_not_found` (entity: "plan") → `PlanNotFound`
 * - `command_validation` (field: "planName") → `InvalidPlanName`
 * - `command_validation` (field: "planStateProvider") → `ProviderUnavailable`
 * - all other errors → `WorkflowError` (wrapping a `RunWorkflowError`)
 */
function mapCommandError(
  planName: string,
  error: CommandOperationError,
): StartPlanExecutionError {
  if (error.type === "command_not_found" && error.entity === "plan") {
    return { type: "PlanNotFound" as const, planName };
  }

  if (error.type === "command_validation" && error.field === "planName") {
    return { type: "InvalidPlanName" as const, planName };
  }

  if (
    error.type === "command_validation" &&
    error.field === "planStateProvider"
  ) {
    return {
      type: "ProviderUnavailable" as const,
      cause: { message: error.message },
    };
  }

  // All other engine errors map to WorkflowError with a RunWorkflowError cause.
  if (error.type === "command_not_found") {
    const cause: RunWorkflowError = {
      type: "WorkflowNotFound" as const,
      workflowName: error.name,
    };
    return { type: "WorkflowError" as const, cause };
  }

  // command_validation (other fields), command_unsupported, command_degraded,
  // command_lifecycle — extract a human-readable message safely.
  let message = "Unknown command operation error";
  if ("message" in error && typeof error.message === "string") {
    message = error.message;
  } else if ("reason" in error && typeof error.reason === "string") {
    message = error.reason;
  }

  const cause: RunWorkflowError = {
    type: "LifecycleError" as const,
    cause: {
      type: "policy_decision" as const,
      message,
    },
  };

  return { type: "WorkflowError" as const, cause };
}

// ---------------------------------------------------------------------------
// startPlanExecution — main helper
// ---------------------------------------------------------------------------

/**
 * Adapter-owned projection of the engine's `startPlan` command operation.
 *
 * Validates that the named plan exists via `PlanStateProvider.planExists()`
 * before delegating to the engine's `startPlan` operation. Fails without
 * creating a `WorkflowInstance` when the plan is missing or the provider is
 * unavailable.
 *
 * ## Execution flow
 *
 * 1. Guard: if `planStateProvider` is `undefined`, return `ProviderUnavailable`.
 * 2. Delegate to `startPlan` (engine-owned) with:
 *    - `planStateProvider` for plan existence validation (engine validates before
 *      touching the store).
 *    - `projectEffect` callback that calls `adapter.spawnSubagent` for each
 *      `DispatchAgentEffect` emitted by the workflow runner.
 * 3. Map `CommandOperationError` → `StartPlanExecutionError`.
 * 4. Map `ExecutionStartedData` → `RunWorkflowResult`.
 *
 * @param input - Execution parameters.
 * @returns `ok(RunWorkflowResult)` on success, or `err(StartPlanExecutionError)`.
 */
export function startPlanExecution(
  input: StartPlanExecutionInput,
): ResultAsync<RunWorkflowResult, StartPlanExecutionError> {
  const log = logger.child({ module: "start-plan-execution" });

  const {
    planName,
    config,
    planStateProvider,
    adapter,
    workflowName = DEFAULT_EXECUTION_WORKFLOW,
  } = input;

  const goal = input.goal ?? `Execute plan: ${planName}`;
  const store = input.store ?? createInMemoryRuntimeStore();

  // Guard: provider must be supplied before any store access.
  if (planStateProvider === undefined) {
    log.warn(
      { planName, workflowName },
      "startPlanExecution called without a PlanStateProvider — returning ProviderUnavailable",
    );
    return errAsync({
      type: "ProviderUnavailable" as const,
      cause: {
        message: "No PlanStateProvider was supplied to startPlanExecution",
      },
    });
  }

  log.info(
    { planName, workflowName, goal },
    "Delegating to engine startPlan operation",
  );

  const projectEffect = buildProjectEffect(adapter);

  return startPlan(
    {
      planName,
      workflowName,
      goal,
      slug: planName,
      ownerId: "start-plan-execution",
      store,
      workflows: config.workflows,
      planStateProvider,
    },
    projectEffect,
  )
    .mapErr(
      (error): StartPlanExecutionError => mapCommandError(planName, error),
    )
    .map(deriveRunWorkflowResult);
}
