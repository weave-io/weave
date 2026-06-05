/**
 * Explicit named-workflow execution loop for the OpenCode adapter.
 *
 * `runWorkflow` is the adapter-owned helper for **explicit named-workflow
 * execution** — the path where a caller (command handler, script, or
 * user-authorized trigger) names a specific workflow declared in
 * `.weave/config.weave` and requests that it run end-to-end.
 *
 * This is distinct from ordinary Loom-led usage (the `/weave:start` path),
 * which is plan-first and does not require the caller to name a workflow.
 * `runWorkflow` is never called from idle hooks, session events, or
 * continuation hooks — it requires explicit, user-authorized invocation.
 *
 * ## Delegation to shared engine operation
 *
 * `runWorkflow` delegates lifecycle semantics to the engine's reusable
 * `runNamedWorkflow` command operation. The adapter supplies a `projectEffect`
 * callback that calls `adapter.spawnSubagent` for each `DispatchAgentEffect`
 * emitted by the engine. The engine never applies harness-specific behavior.
 *
 * ## Execution lifecycle (engine-owned)
 *
 *   1. `startExecution`  — acquire lease, create/update WorkflowInstance
 *   2. `dispatchStep`    — resolve next step, emit DispatchAgentEffect
 *   3. Project effects   — call `projectEffect` (→ `adapter.spawnSubagent`)
 *   4. `completeStep`    — record step completion, advance to next step or finish
 *
 * The loop continues until a `complete-execution` or `pause-execution` effect
 * is emitted, or until an error is returned.
 *
 * Boundary rule: this module calls the engine's `runNamedWorkflow` operation
 * and the adapter interface. It must not import directly from `@opencode-ai/sdk`.
 *
 * @see docs/adapter-boundary.md — Execution Lifecycle Surface section
 * @see start-plan-execution.ts — the `/weave:start` ordinary-usage path
 * @see packages/engine/src/runtime-command-operations/run-named-workflow.ts
 */

import type { WeaveConfig } from "@weave/core";
import type {
  CommandOperationError,
  DispatchAgentEffect,
  LifecycleEffect,
  LifecycleError,
  PlanStateProvider,
  RuntimeStore,
  WorkflowRunnerError,
} from "@weave/engine";
import {
  createInMemoryRuntimeStore,
  logger,
  runNamedWorkflow,
} from "@weave/engine";
import { type ResultAsync } from "neverthrow";

import type { OpenCodeAdapter } from "./index.js";

const log = logger.child({ module: "run-workflow" });

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Discriminated union of errors that `runWorkflow` can return.
 */
export type RunWorkflowError =
  | { readonly type: "LifecycleError"; readonly cause: LifecycleError }
  | { readonly type: "WorkflowNotFound"; readonly workflowName: string }
  | { readonly type: "MaxStepsExceeded"; readonly maxSteps: number };

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

/**
 * Input for `runWorkflow`.
 *
 * Provides everything the execution loop needs:
 * - `config`        — the full WeaveConfig containing workflow definitions
 * - `workflowName`  — the name of the workflow to execute
 * - `goal`          — human-readable goal for this execution instance
 * - `slug`          — URL-safe slug derived from the goal
 * - `adapter`       — the OpenCode adapter instance (for `spawnSubagent`)
 * - `store`         — the Runtime Store (defaults to a fresh InMemoryRuntimeStore)
 * - `planStateProvider` — optional plan state provider for plan_created/plan_complete steps
 * - `ownerId`       — owner identifier for the execution lease (defaults to "run-workflow")
 * - `maxSteps`      — safety cap on the number of steps dispatched (default: 100)
 */
export interface RunWorkflowInput {
  /** Full WeaveConfig containing workflow definitions. */
  readonly config: WeaveConfig;
  /** Name of the workflow to execute (must exist in `config.workflows`). */
  readonly workflowName: string;
  /** Human-readable goal for this execution instance. */
  readonly goal: string;
  /** URL-safe slug for this execution instance. */
  readonly slug: string;
  /** OpenCode adapter instance — `spawnSubagent` is called for each DispatchAgentEffect. */
  readonly adapter: OpenCodeAdapter;
  /** Runtime Store instance. Defaults to a fresh InMemoryRuntimeStore when omitted. */
  readonly store?: RuntimeStore;
  /** Optional plan state provider for plan_created/plan_complete completion methods. */
  readonly planStateProvider?: PlanStateProvider;
  /** Owner identifier for the execution lease. Defaults to "run-workflow". */
  readonly ownerId?: string;
  /** Safety cap on the number of steps dispatched. Defaults to 100. */
  readonly maxSteps?: number;
}

/**
 * Output from `runWorkflow`.
 *
 * Reports the final status of the execution and the effects that were applied.
 */
export interface RunWorkflowResult {
  /** The workflow instance ID that was created. */
  readonly workflowInstanceId: string;
  /** All lifecycle effects that were applied during the execution. */
  readonly appliedEffects: readonly LifecycleEffect[];
  /** Final execution status. */
  readonly status: "completed" | "paused";
  /** Number of steps that were dispatched. */
  readonly stepsDispatched: number;
}

// ---------------------------------------------------------------------------
// buildProjectEffect — adapter-owned effect projection callback
// ---------------------------------------------------------------------------

/**
 * Build the adapter-owned `projectEffect` callback for `runNamedWorkflow`.
 *
 * The callback calls `adapter.spawnSubagent` for each `DispatchAgentEffect`
 * emitted by the engine's workflow runner. On failure, maps
 * `OpenCodeAdapterError` to `WorkflowRunnerError` so the engine can propagate
 * it as a typed `projection_error`.
 */
function buildProjectEffect(
  adapter: OpenCodeAdapter,
): (effect: DispatchAgentEffect) => ResultAsync<void, WorkflowRunnerError> {
  return (effect: DispatchAgentEffect) => {
    log.info(
      {
        agentName: effect.runAgent.agentName,
        stepType: effect.runAgent.stepType,
        completionMethod: effect.runAgent.completionMethod,
      },
      "Applying DispatchAgentEffect — spawning subagent",
    );
    return adapter.spawnSubagent(effect.runAgent.agentDescriptor).mapErr(
      (cause): WorkflowRunnerError => ({
        type: "projection_error" as const,
        message: `spawnSubagent failed for agent "${effect.runAgent.agentName}": ${cause.message}`,
        cause,
      }),
    );
  };
}

// ---------------------------------------------------------------------------
// mapCommandError — convert CommandOperationError to RunWorkflowError
// ---------------------------------------------------------------------------

/**
 * Map a `CommandOperationError` from the engine's `runNamedWorkflow` operation
 * to the adapter-owned `RunWorkflowError` discriminated union.
 *
 * - `command_not_found` (entity: "workflow") → `WorkflowNotFound`
 * - `command_validation` (field: "maxSteps") → `MaxStepsExceeded`
 * - all other errors → `LifecycleError`
 */
function mapCommandError(error: CommandOperationError): RunWorkflowError {
  if (error.type === "command_not_found" && error.entity === "workflow") {
    return { type: "WorkflowNotFound" as const, workflowName: error.name };
  }

  if (error.type === "command_validation" && error.field === "maxSteps") {
    const match = /(\d+)/.exec(error.message);
    const maxSteps = match ? parseInt(match[1] ?? "0", 10) : 0;
    return { type: "MaxStepsExceeded" as const, maxSteps };
  }

  if (error.type === "command_lifecycle") {
    return { type: "LifecycleError" as const, cause: error.cause };
  }

  // command_validation (other fields), command_unsupported, command_degraded —
  // wrap as a LifecycleError with a policy_decision cause.
  const message =
    "message" in error && typeof error.message === "string"
      ? error.message
      : "reason" in error && typeof error.reason === "string"
        ? error.reason
        : "Unknown command operation error";

  return {
    type: "LifecycleError" as const,
    cause: {
      type: "policy_decision" as const,
      message,
    },
  };
}

// ---------------------------------------------------------------------------
// deriveRunWorkflowResult — map ExecutionStartedData to RunWorkflowResult
// ---------------------------------------------------------------------------

/**
 * Derive a `RunWorkflowResult` from the engine's `ExecutionStartedData`.
 *
 * `ExecutionStartedData.effects` carries all lifecycle effects emitted during
 * the run. We derive:
 * - `status`: "paused" if a `pause-execution` effect is present, else "completed".
 * - `stepsDispatched`: count of `dispatch-agent` effects.
 * - `appliedEffects`: all effects (forwarded as-is).
 */
function deriveRunWorkflowResult(data: {
  readonly workflowInstanceId: string;
  readonly effects: readonly { readonly kind: string }[];
}): RunWorkflowResult {
  const hasPause = data.effects.some((e) => e.kind === "pause-execution");
  const stepsDispatched = data.effects.filter(
    (e) => e.kind === "dispatch-agent",
  ).length;

  return {
    workflowInstanceId: data.workflowInstanceId,
    appliedEffects: data.effects as RunWorkflowResult["appliedEffects"],
    status: hasPause ? "paused" : "completed",
    stepsDispatched,
  };
}

// ---------------------------------------------------------------------------
// runWorkflow — main execution entry point
// ---------------------------------------------------------------------------

/**
 * Execute a named workflow end-to-end using the engine's lifecycle surface.
 *
 * This is the **explicit named-workflow execution** entry point. The caller
 * must supply the name of a workflow declared in `config.workflows`. This
 * function is not the ordinary Loom-led path — for that, see
 * `startPlanExecution` (the `/weave:start` delivery path).
 *
 * `runWorkflow` must be called by a user-authorized trigger (command handler,
 * script, or UI action). It is never wired to idle hooks, session events, or
 * continuation hooks.
 *
 * ## Delegation
 *
 * Lifecycle semantics are delegated to the engine's `runNamedWorkflow`
 * command operation. The adapter supplies a `projectEffect` callback that
 * calls `adapter.spawnSubagent` for each `DispatchAgentEffect`. The engine
 * never applies harness-specific behavior.
 *
 * @param input - Named-workflow execution parameters.
 * @returns `ok(RunWorkflowResult)` on success, or `err(RunWorkflowError)`.
 */
export function runWorkflow(
  input: RunWorkflowInput,
): ResultAsync<RunWorkflowResult, RunWorkflowError> {
  const {
    config,
    workflowName,
    goal,
    slug,
    adapter,
    planStateProvider,
    ownerId = "run-workflow",
  } = input;

  const store = input.store ?? createInMemoryRuntimeStore();

  log.info(
    { workflowName, goal, slug },
    "runWorkflow — delegating to engine runNamedWorkflow operation",
  );

  const projectEffect = buildProjectEffect(adapter);

  return runNamedWorkflow(
    {
      workflowName,
      goal,
      slug,
      ownerId,
      store,
      workflows: config.workflows,
      planStateProvider,
      now: undefined,
    },
    projectEffect,
  )
    .mapErr(mapCommandError)
    .map(deriveRunWorkflowResult);
}
