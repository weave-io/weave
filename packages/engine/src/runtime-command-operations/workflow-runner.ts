/**
 * Workflow Runner — reusable lifecycle-driven execution loop.
 *
 * Provides the engine-owned `runWorkflowLifecycle` function that drives a
 * named workflow through the execution lifecycle without applying any
 * harness-specific behavior. Effect projection (e.g. spawning subagents) is
 * delegated to an adapter-supplied callback so the engine never imports
 * OpenCode or any concrete harness API.
 *
 * ## Lifecycle sequence
 *
 *   1. `startExecution`  — acquire lease, create/update WorkflowInstance
 *   2. `dispatchStep`    — resolve next step, emit DispatchAgentEffect
 *   3. Project effects   — call `projectEffect` for each DispatchAgentEffect
 *   4. `completeStep`    — record step completion, advance to next step or finish
 *   5. Repeat from 3 until `complete-execution` or `pause-execution` is emitted
 *
 * ## Design constraints
 *
 * - No OpenCode imports, concrete command names, concrete tool names, or
 *   harness plugin APIs appear in this module.
 * - All fallible operations return `ResultAsync<T, E>` from neverthrow.
 * - Effect projection is adapter-supplied via `WorkflowRunnerInput.projectEffect`.
 * - The engine never reads `.weave/plans/**`; plan state stays behind
 *   `PlanStateProvider` (not used here — plan validation is caller-owned).
 *
 * @see docs/specs/30-spec-minimal-runtime-command-lifecycle/30-spec-minimal-runtime-command-lifecycle.md
 * @see docs/adapter-boundary.md
 * @see packages/engine/src/execution-lifecycle/start.ts — startExecution
 * @see packages/engine/src/execution-lifecycle/dispatch.ts — dispatchStep
 * @see packages/engine/src/execution-lifecycle/completion.ts — completeStep
 */

import type { WorkflowConfig, WorkflowStep } from "@weaveio/weave-core";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import {
  completeStep,
  type DispatchAgentEffect,
  dispatchStep,
  type LifecycleEffect,
  type LifecycleError,
  startExecution,
  type WorkflowExecutionContext,
} from "../execution-lifecycle.js";
import { logger } from "../logger.js";
import type { PlanStateProvider } from "../plan-state-provider.js";
import type { RuntimeStore } from "../runtime/store.js";
import type { ExecutionLeaseId, WorkflowInstanceId } from "../runtime/types.js";
import type {
  CommandLifecycleError,
  CommandNotFoundError,
  CommandOperationError,
  CommandValidationError,
} from "./types.js";

const log = logger.child({ module: "workflow-runner" });

// ---------------------------------------------------------------------------
// § 1 — WorkflowRunnerError
// ---------------------------------------------------------------------------

/**
 * Discriminated union of errors that `runWorkflowLifecycle` can return.
 *
 * - `workflow_not_found`  — the named workflow does not exist in the registry.
 * - `max_steps_exceeded`  — the safety cap on dispatched steps was reached.
 * - `lifecycle_error`     — a lifecycle method returned a typed `LifecycleError`.
 * - `projection_error`    — the adapter-supplied `projectEffect` callback failed.
 */
export type WorkflowRunnerError =
  | { readonly type: "workflow_not_found"; readonly workflowName: string }
  | { readonly type: "max_steps_exceeded"; readonly maxSteps: number }
  | { readonly type: "lifecycle_error"; readonly cause: LifecycleError }
  | {
      readonly type: "projection_error";
      readonly message: string;
      readonly cause?: unknown;
    };

// ---------------------------------------------------------------------------
// § 2 — WorkflowRunnerInput / WorkflowRunnerOutput
// ---------------------------------------------------------------------------

/**
 * Input for `runWorkflowLifecycle`.
 *
 * The caller supplies all execution parameters and an adapter-owned
 * `projectEffect` callback. The engine never calls harness APIs directly.
 */
export interface WorkflowRunnerInput {
  /** Name of the workflow to run (must exist in `workflows`). */
  readonly workflowName: string;
  /** Human-readable goal for this execution instance. */
  readonly goal: string;
  /** URL-safe slug for this execution instance. */
  readonly slug: string;
  /** Owner identifier for the execution lease. */
  readonly ownerId: string;
  /** Runtime store for persisting the workflow instance and lease. */
  readonly store: RuntimeStore;
  /**
   * Workflow registry — maps workflow names to workflow configs.
   * Required for validating that `workflowName` exists and resolving steps.
   */
  readonly workflows: Record<string, WorkflowConfig>;
  /**
   * Adapter-supplied effect projection callback.
   *
   * Called once per `DispatchAgentEffect` emitted by the lifecycle. The
   * engine does not apply effects directly — the adapter owns projection.
   * Return `ok(undefined)` to continue; return `err(...)` to abort the loop.
   */
  readonly projectEffect: (
    effect: DispatchAgentEffect,
  ) => ResultAsync<void, WorkflowRunnerError>;
  /**
   * Optional plan state provider for `plan_created` / `plan_complete`
   * completion methods.
   */
  readonly planStateProvider?: PlanStateProvider;
  /**
   * Safety cap on the number of steps dispatched.
   * Defaults to 100. Must be ≥ 1.
   */
  readonly maxSteps?: number;
  /** Optional ISO-8601 timestamp override (for testing). */
  readonly now?: string;
  /** Pre-assigned workflow instance ID (for testing or idempotency). */
  readonly workflowInstanceId?: WorkflowInstanceId;
}

/**
 * Output from `runWorkflowLifecycle`.
 *
 * Reports the final execution status and all lifecycle effects that were
 * emitted during the run. Adapters use this to render success/failure
 * messages and to build `ExecutionStartedData` for command results.
 */
export interface WorkflowRunnerOutput {
  /** The workflow instance ID that was created or driven. */
  readonly workflowInstanceId: WorkflowInstanceId;
  /** The execution lease ID acquired during `startExecution`. */
  readonly leaseId: ExecutionLeaseId;
  /** All lifecycle effects emitted during the run (in emission order). */
  readonly effects: readonly LifecycleEffect[];
  /** Final execution status. */
  readonly status: "completed" | "paused";
  /** Number of steps that were dispatched. */
  readonly stepsDispatched: number;
}

// ---------------------------------------------------------------------------
// § 3 — Internal loop state
// ---------------------------------------------------------------------------

interface LoopState {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly leaseId: ExecutionLeaseId;
  readonly context: WorkflowExecutionContext;
  readonly workflowConfig: WorkflowConfig;
  readonly planStateProvider: PlanStateProvider | undefined;
  readonly store: RuntimeStore;
  readonly effects: LifecycleEffect[];
  stepsDispatched: number;
  readonly maxSteps: number;
  readonly projectEffect: (
    effect: DispatchAgentEffect,
  ) => ResultAsync<void, WorkflowRunnerError>;
}

// ---------------------------------------------------------------------------
// § 4 — Step resolution helper
// ---------------------------------------------------------------------------

/**
 * Resolve the name of the step that follows `completedStepName` in the
 * workflow config. Returns `undefined` when `completedStepName` is the
 * final step.
 */
function resolveNextStepName(
  workflowConfig: WorkflowConfig,
  completedStepName: string,
): string | undefined {
  const currentIndex = workflowConfig.steps.findIndex(
    (s: WorkflowStep) => s.name === completedStepName,
  );
  if (currentIndex < 0) return undefined;
  return workflowConfig.steps[currentIndex + 1]?.name;
}

// ---------------------------------------------------------------------------
// § 5 — completeAndAdvance — recursive step completion loop
// ---------------------------------------------------------------------------

/**
 * Complete a step and recursively handle auto-advance effects.
 *
 * When `completeStep` emits a `dispatch-agent` effect (auto-advance to next
 * step), this function applies it via `projectEffect` and calls itself
 * recursively for the next step. The next step name is resolved from the
 * workflow config — NOT from the agent name in the effect.
 *
 * Recursion terminates when `complete-execution` or `pause-execution` is
 * emitted, or when an error is returned.
 */
function completeAndAdvance(
  stepName: string,
  state: LoopState,
): ResultAsync<WorkflowRunnerOutput, WorkflowRunnerError> {
  const stepConfig = state.workflowConfig.steps.find(
    (s) => s.name === stepName,
  );
  const completionMethod = stepConfig?.completion.method ?? "agent_signal";

  return completeStep(
    {
      workflowInstanceId: state.workflowInstanceId,
      leaseId: state.leaseId,
      stepName,
      completionSignal: {
        outcome: "success",
        method: completionMethod,
      },
      context: state.context,
      planStateProvider: state.planStateProvider,
    },
    state.store,
  )
    .mapErr(
      (cause): WorkflowRunnerError => ({ type: "lifecycle_error", cause }),
    )
    .andThen(({ effects: completionEffects }) => {
      for (const effect of completionEffects) {
        state.effects.push(effect);
      }

      log.info(
        { stepName, completionEffectCount: completionEffects.length },
        "Step completed",
      );

      const completeEffect = completionEffects.find(
        (e) => e.kind === "complete-execution",
      );
      if (completeEffect !== undefined) {
        log.info(
          {
            workflowName: state.context.workflowName,
            stepsDispatched: state.stepsDispatched,
          },
          "Workflow completed",
        );
        return okAsync<WorkflowRunnerOutput, WorkflowRunnerError>({
          workflowInstanceId: state.workflowInstanceId,
          leaseId: state.leaseId,
          effects: state.effects,
          status: "completed",
          stepsDispatched: state.stepsDispatched,
        });
      }

      const pauseEffect = completionEffects.find(
        (e) => e.kind === "pause-execution",
      );
      if (pauseEffect !== undefined) {
        log.info(
          {
            workflowName: state.context.workflowName,
            stepsDispatched: state.stepsDispatched,
          },
          "Workflow paused",
        );
        return okAsync<WorkflowRunnerOutput, WorkflowRunnerError>({
          workflowInstanceId: state.workflowInstanceId,
          leaseId: state.leaseId,
          effects: state.effects,
          status: "paused",
          stepsDispatched: state.stepsDispatched,
        });
      }

      // Auto-advance: completeStep emitted a dispatch-agent effect for the next step.
      const nextDispatch = completionEffects.find(
        (e): e is DispatchAgentEffect => e.kind === "dispatch-agent",
      );

      if (nextDispatch !== undefined) {
        if (state.stepsDispatched >= state.maxSteps) {
          return errAsync<WorkflowRunnerOutput, WorkflowRunnerError>({
            type: "max_steps_exceeded",
            maxSteps: state.maxSteps,
          });
        }
        state.stepsDispatched += 1;

        const nextStepName = resolveNextStepName(
          state.workflowConfig,
          stepName,
        );

        if (nextStepName === undefined) {
          log.warn(
            { stepName },
            "dispatch-agent effect emitted but no next step found — treating as completed",
          );
          return okAsync<WorkflowRunnerOutput, WorkflowRunnerError>({
            workflowInstanceId: state.workflowInstanceId,
            leaseId: state.leaseId,
            effects: state.effects,
            status: "completed",
            stepsDispatched: state.stepsDispatched,
          });
        }

        log.info(
          { nextStepName, stepsDispatched: state.stepsDispatched },
          "Auto-advancing to next step",
        );

        return state
          .projectEffect(nextDispatch)
          .andThen(() => completeAndAdvance(nextStepName, state));
      }

      // No terminal or auto-advance effect — handle gracefully.
      log.warn(
        { stepName, effectKinds: completionEffects.map((e) => e.kind) },
        "completeStep returned no terminal or advance effect — treating as completed",
      );
      return okAsync<WorkflowRunnerOutput, WorkflowRunnerError>({
        workflowInstanceId: state.workflowInstanceId,
        leaseId: state.leaseId,
        effects: state.effects,
        status: "completed",
        stepsDispatched: state.stepsDispatched,
      });
    });
}

// ---------------------------------------------------------------------------
// § 6 — runWorkflowLifecycle — main entry point
// ---------------------------------------------------------------------------

/**
 * Drive a named workflow through the engine lifecycle.
 *
 * This is the **engine-owned reusable execution loop**. It validates the
 * workflow exists, calls lifecycle methods in order, and delegates effect
 * projection to the adapter-supplied `projectEffect` callback. No harness
 * APIs, OpenCode imports, or concrete command names appear here.
 *
 * ## Execution flow
 *
 * 1. Validate `maxSteps ≥ 1` and that `workflowName` exists in `workflows`.
 * 2. Call `startExecution` to acquire a lease and create the instance.
 * 3. Call `dispatchStep` to get the first step's `DispatchAgentEffect`.
 * 4. Call `projectEffect` for each `DispatchAgentEffect` from `dispatchStep`.
 * 5. Call `completeStep` — the engine auto-advances and emits the next
 *    `dispatch-agent` effect (or `complete-execution` for the final step).
 * 6. Project the auto-advance `dispatch-agent` effect and repeat from 5
 *    until `complete-execution` or `pause-execution` is emitted.
 *
 * @param input - Workflow runner parameters including adapter-supplied projection.
 * @returns `ok(WorkflowRunnerOutput)` on success, or `err(WorkflowRunnerError)`.
 */
export function runWorkflowLifecycle(
  input: WorkflowRunnerInput,
): ResultAsync<WorkflowRunnerOutput, WorkflowRunnerError> {
  const {
    workflowName,
    goal,
    slug,
    ownerId,
    store,
    workflows,
    projectEffect,
    planStateProvider,
    maxSteps = 100,
  } = input;

  if (maxSteps < 1) {
    return errAsync({ type: "max_steps_exceeded" as const, maxSteps });
  }

  const workflowConfig = workflows[workflowName];
  if (workflowConfig === undefined) {
    return errAsync({ type: "workflow_not_found" as const, workflowName });
  }

  const workflowInstanceId =
    input.workflowInstanceId ?? (crypto.randomUUID() as WorkflowInstanceId);

  const context: WorkflowExecutionContext = {
    workflowName,
    goal,
    slug,
    workflows,
  };

  log.info(
    { workflowName, goal, slug, workflowInstanceId },
    "Starting workflow lifecycle",
  );

  return startExecution(
    {
      workflowInstanceId,
      ownerId,
      context,
      now: input.now,
    },
    store,
  )
    .mapErr(
      (cause): WorkflowRunnerError => ({ type: "lifecycle_error", cause }),
    )
    .andThen(({ leaseId }) => {
      log.info({ leaseId }, "Execution started — dispatching first step");

      const effects: LifecycleEffect[] = [];

      const state: LoopState = {
        workflowInstanceId,
        leaseId,
        context,
        workflowConfig,
        planStateProvider,
        store,
        effects,
        stepsDispatched: 0,
        maxSteps,
        projectEffect,
      };

      return dispatchStep(
        {
          workflowInstanceId,
          leaseId,
          context,
        },
        store,
      )
        .mapErr(
          (cause): WorkflowRunnerError => ({ type: "lifecycle_error", cause }),
        )
        .andThen(({ stepName, effects: dispatchEffects }) => {
          state.stepsDispatched += 1;
          log.info(
            { stepName, effectCount: dispatchEffects.length },
            "First step dispatched",
          );

          for (const effect of dispatchEffects) {
            effects.push(effect);
          }

          const dispatchAgentEffects = dispatchEffects.filter(
            (e): e is DispatchAgentEffect => e.kind === "dispatch-agent",
          );

          // Apply all dispatch effects sequentially, short-circuiting on error.
          const applyAll = dispatchAgentEffects.reduce(
            (chain, effect) => chain.andThen(() => projectEffect(effect)),
            okAsync<void, WorkflowRunnerError>(undefined),
          );

          return applyAll.andThen(() => completeAndAdvance(stepName, state));
        });
    });
}

// ---------------------------------------------------------------------------
// § 7 — mapWorkflowRunnerError — convert to CommandLifecycleError
// ---------------------------------------------------------------------------

/**
 * Map a `WorkflowRunnerError` to a `CommandLifecycleError` for use in
 * command operation result types.
 *
 * Only `lifecycle_error` variants map to `CommandLifecycleError`; other
 * variants should be handled by the caller before calling this helper.
 */
export function mapWorkflowRunnerErrorToLifecycle(
  error: WorkflowRunnerError & { type: "lifecycle_error" },
): CommandLifecycleError {
  return {
    type: "command_lifecycle",
    operation: "run-named-workflow",
    cause: error.cause,
  };
}

// ---------------------------------------------------------------------------
// § 8 — mapRunnerErrorToCommandError — shared parameterized mapper
// ---------------------------------------------------------------------------

/**
 * Map a `WorkflowRunnerError` to a typed `CommandOperationError`.
 *
 * Shared by `runNamedWorkflow` and `startPlan` — the only difference between
 * the two callers is the `operation` label on `CommandLifecycleError`.
 *
 * - `workflow_not_found` → `CommandNotFoundError`
 * - `max_steps_exceeded` → `CommandValidationError`
 * - `lifecycle_error`    → `CommandLifecycleError`
 * - `projection_error`   → `CommandLifecycleError` (policy_decision cause)
 */
export function mapRunnerErrorToCommandError(
  error: WorkflowRunnerError,
  operation: CommandLifecycleError["operation"],
): CommandOperationError {
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
      maxSteps: error.maxSteps,
    } satisfies CommandValidationError;
  }

  if (error.type === "lifecycle_error") {
    return {
      type: "command_lifecycle",
      operation,
      cause: error.cause,
    };
  }

  // projection_error
  return {
    type: "command_lifecycle",
    operation,
    cause: {
      type: "policy_decision",
      message: error.message,
    },
  };
}
