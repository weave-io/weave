/**
 * start-plan-execution — adapter-owned helper for the /weave:start delivery path.
 *
 * This module represents the future command-capable `/weave:start` delivery path
 * without making the command name core-owned. The command name constants are
 * adapter-owned and documented here.
 *
 * ## Boundary rule
 *
 * This module is adapter-owned. It must not import from `@weave/core` directly
 * (config types are accepted as parameters, not fetched). It must not reference
 * concrete command names in core packages — command naming is adapter-owned.
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

import type { WeaveConfig } from "@weave/core";
import type { PlanStateProvider, RuntimeStore } from "@weave/engine";
import { logger } from "@weave/engine";
import { errAsync, type ResultAsync } from "neverthrow";

import type { OpenCodeAdapter } from "./adapter.js";
import type { RunWorkflowError, RunWorkflowResult } from "./run-workflow.js";
import { runWorkflow } from "./run-workflow.js";

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
 * - `ProviderUnavailable` — the `PlanStateProvider` could not be queried (I/O
 *   error or the provider was not supplied).
 * - `WorkflowError` — the underlying `runWorkflow` call returned an error.
 */
export type StartPlanExecutionError =
  | { readonly type: "PlanNotFound"; readonly planName: string }
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
   */
  readonly config: WeaveConfig;

  /**
   * Provider for querying plan file state.
   *
   * Used to validate that the plan exists before calling `runWorkflow`.
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
   * Passed through to `runWorkflow` as `goal`. Defaults to
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
   * Passed through to `runWorkflow`. Defaults to a fresh `InMemoryRuntimeStore`
   * when omitted (same default as `runWorkflow`).
   */
  readonly store?: RuntimeStore;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = logger.child({ module: "start-plan-execution" });

// ---------------------------------------------------------------------------
// startPlanExecution — main helper
// ---------------------------------------------------------------------------

/**
 * Adapter-owned helper for the `/weave:start` delivery path.
 *
 * Validates that the named plan exists via `PlanStateProvider.planExists()`
 * before calling `runWorkflow`. Fails without creating a `WorkflowInstance`
 * when the plan is missing or the provider is unavailable.
 *
 * ## Execution flow
 *
 * 1. Guard: if `planStateProvider` is `undefined`, return `ProviderUnavailable`.
 * 2. Call `planStateProvider.planExists(planName)`.
 *    - On provider error → return `ProviderUnavailable`.
 *    - On `false` → return `PlanNotFound`.
 * 3. Call `runWorkflow` with the explicit workflow path (`tapestry-execution`
 *    by default), passing `planStateProvider` through for plan-oriented
 *    completion methods.
 *    - On `runWorkflow` error → return `WorkflowError`.
 * 4. Return `ok(RunWorkflowResult)`.
 *
 * @param input - Execution parameters.
 * @returns `ok(RunWorkflowResult)` on success, or `err(StartPlanExecutionError)`.
 */
export function startPlanExecution(
  input: StartPlanExecutionInput,
): ResultAsync<RunWorkflowResult, StartPlanExecutionError> {
  const {
    planName,
    config,
    planStateProvider,
    adapter,
    workflowName = DEFAULT_EXECUTION_WORKFLOW,
  } = input;

  const goal = input.goal ?? `Execute plan: ${planName}`;

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
    "Checking plan existence before execution",
  );

  // Step 1: validate plan exists — fail before touching the store.
  return planStateProvider
    .planExists(planName)
    .mapErr(
      (cause): StartPlanExecutionError => ({
        type: "ProviderUnavailable" as const,
        cause:
          cause.type === "ProviderUnavailable"
            ? cause.cause
            : { message: `Invalid plan name: ${planName}` },
      }),
    )
    .andThen((exists) => {
      if (!exists) {
        log.warn({ planName }, "Plan does not exist — aborting execution");
        return errAsync<RunWorkflowResult, StartPlanExecutionError>({
          type: "PlanNotFound" as const,
          planName,
        });
      }

      log.info(
        { planName, workflowName },
        "Plan exists — starting workflow execution",
      );

      // Step 2: delegate to runWorkflow with the explicit workflow path.
      return runWorkflow({
        config,
        workflowName,
        goal,
        slug: planName,
        adapter,
        store: input.store,
        planStateProvider,
      }).mapErr(
        (cause): StartPlanExecutionError => ({
          type: "WorkflowError" as const,
          cause,
        }),
      );
    });
}
