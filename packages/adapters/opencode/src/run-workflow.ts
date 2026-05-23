/**
 * End-to-end workflow execution loop for the OpenCode adapter.
 *
 * Demonstrates the full lifecycle surface:
 *   1. `startExecution`  — acquire lease, create/update WorkflowInstance
 *   2. `dispatchStep`    — resolve next step, emit DispatchAgentEffect
 *   3. Apply effects     — call `adapter.spawnSubagent` for each DispatchAgentEffect
 *   4. `completeStep`    — record step completion, advance to next step or finish
 *
 * The loop continues until a `complete-execution` or `pause-execution` effect
 * is emitted, or until an error is returned.
 *
 * ## Auto-advance semantics
 *
 * When `completeStep` is called with `context` and `outcome: "success"`, the
 * engine auto-advances and emits one of:
 * - `dispatch-agent` — the next step to execute (non-final step); the engine
 *   also updates `instance.currentStepName` to the next step name.
 * - `complete-execution` — the workflow is done (final step).
 *
 * The loop applies the `dispatch-agent` effect from `completeStep` directly
 * (calling `spawnSubagent`) and then calls `completeStep` again for the next
 * step (resolved from the workflow config). It does NOT call `dispatchStep`
 * again after `completeStep` emits a `dispatch-agent` effect — that would
 * double-dispatch the same step.
 *
 * Boundary rule: this module calls engine lifecycle functions and the adapter
 * interface. It must not import directly from `@opencode-ai/sdk`.
 *
 * @see docs/adapter-boundary.md — Execution Lifecycle Surface section
 */

import type { WeaveConfig, WorkflowConfig } from "@weave/core";
import type { RuntimeStore } from "@weave/engine";
import {
  completeStep,
  createInMemoryRuntimeStore,
  createWorkflowInstanceId,
  type DispatchAgentEffect,
  dispatchStep,
  type ExecutionLeaseId,
  type LifecycleEffect,
  type LifecycleError,
  logger,
  type PlanStateProvider,
  startExecution,
  type WorkflowExecutionContext,
  type WorkflowInstanceId,
} from "@weave/engine";
import { errAsync, okAsync, ResultAsync } from "neverthrow";

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
// Effect application
// ---------------------------------------------------------------------------

/**
 * Apply a single `DispatchAgentEffect` by calling `adapter.spawnSubagent`.
 *
 * The adapter's `spawnSubagent` method translates the descriptor into an
 * OpenCode `AgentConfig` and stores it in `adapter.translatedAgents`.
 */
async function applyDispatchAgentEffect(
  effect: DispatchAgentEffect,
  adapter: OpenCodeAdapter,
): Promise<void> {
  log.info(
    {
      agentName: effect.runAgent.agentName,
      stepType: effect.runAgent.stepType,
      completionMethod: effect.runAgent.completionMethod,
    },
    "Applying DispatchAgentEffect — spawning subagent",
  );
  await adapter.spawnSubagent(effect.runAgent.agentDescriptor);
}

// ---------------------------------------------------------------------------
// Loop state
// ---------------------------------------------------------------------------

interface LoopState {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly leaseId: ExecutionLeaseId;
  readonly context: WorkflowExecutionContext;
  readonly workflowConfig: WorkflowConfig;
  readonly adapter: OpenCodeAdapter;
  readonly planStateProvider: PlanStateProvider | undefined;
  readonly store: RuntimeStore;
  readonly appliedEffects: LifecycleEffect[];
  stepsDispatched: number;
  readonly maxSteps: number;
}

// ---------------------------------------------------------------------------
// resolveNextStepName — find the step after the completed one
// ---------------------------------------------------------------------------

/**
 * Resolve the name of the step that follows `completedStepName` in the
 * workflow config.
 *
 * Returns `undefined` when `completedStepName` is the final step.
 */
function resolveNextStepName(
  workflowConfig: WorkflowConfig,
  completedStepName: string,
): string | undefined {
  const currentIndex = workflowConfig.steps.findIndex(
    (s) => s.name === completedStepName,
  );
  if (currentIndex < 0) return undefined;
  return workflowConfig.steps[currentIndex + 1]?.name;
}

// ---------------------------------------------------------------------------
// completeAndAdvance — complete a step and handle auto-advance effects
// ---------------------------------------------------------------------------

/**
 * Complete a step and recursively handle auto-advance effects.
 *
 * When `completeStep` emits a `dispatch-agent` effect (auto-advance to next
 * step), this function applies it and calls itself recursively for the next
 * step. The next step name is resolved from the workflow config — NOT from
 * the agent name in the effect (which is the agent name, not the step name).
 *
 * When `completeStep` emits `complete-execution` or `pause-execution`, the
 * recursion terminates.
 */
function completeAndAdvance(
  stepName: string,
  state: LoopState,
): ResultAsync<RunWorkflowResult, RunWorkflowError> {
  return completeStep(
    {
      workflowInstanceId: state.workflowInstanceId,
      leaseId: state.leaseId,
      stepName,
      completionSignal: {
        outcome: "success",
        method: "agent_signal",
      },
      context: state.context,
      planStateProvider: state.planStateProvider,
    },
    state.store,
  )
    .mapErr((cause): RunWorkflowError => ({ type: "LifecycleError", cause }))
    .andThen(({ effects: completionEffects }) => {
      for (const effect of completionEffects) {
        state.appliedEffects.push(effect);
      }

      log.info(
        { stepName, completionEffectCount: completionEffects.length },
        "Step completed",
      );

      // Check for terminal effects first.
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
        return okAsync<RunWorkflowResult, RunWorkflowError>({
          workflowInstanceId: state.workflowInstanceId,
          appliedEffects: state.appliedEffects,
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
        return okAsync<RunWorkflowResult, RunWorkflowError>({
          workflowInstanceId: state.workflowInstanceId,
          appliedEffects: state.appliedEffects,
          status: "paused",
          stepsDispatched: state.stepsDispatched,
        });
      }

      // Auto-advance: completeStep emitted a dispatch-agent effect for the next step.
      // Apply it and complete the next step — do NOT call dispatchStep again.
      const nextDispatch = completionEffects.find(
        (e): e is DispatchAgentEffect => e.kind === "dispatch-agent",
      );

      if (nextDispatch !== undefined) {
        if (state.stepsDispatched >= state.maxSteps) {
          return errAsync<RunWorkflowResult, RunWorkflowError>({
            type: "MaxStepsExceeded",
            maxSteps: state.maxSteps,
          });
        }
        state.stepsDispatched += 1;

        // Resolve the next step name from the workflow config.
        // The dispatch-agent effect carries the agent name, not the step name.
        const nextStepName = resolveNextStepName(
          state.workflowConfig,
          stepName,
        );

        if (nextStepName === undefined) {
          // Should not happen — the engine emitted dispatch-agent but there's
          // no next step in the config. Treat as completed.
          log.warn(
            { stepName },
            "dispatch-agent effect emitted but no next step found — treating as completed",
          );
          return okAsync<RunWorkflowResult, RunWorkflowError>({
            workflowInstanceId: state.workflowInstanceId,
            appliedEffects: state.appliedEffects,
            status: "completed",
            stepsDispatched: state.stepsDispatched,
          });
        }

        log.info(
          { nextStepName, stepsDispatched: state.stepsDispatched },
          "Auto-advancing to next step",
        );

        return ResultAsync.fromPromise(
          applyDispatchAgentEffect(nextDispatch, state.adapter),
          (cause): RunWorkflowError => ({
            type: "LifecycleError",
            cause: {
              type: "policy_decision",
              message: `spawnSubagent threw unexpectedly: ${String(cause)}`,
            },
          }),
        ).andThen(() => completeAndAdvance(nextStepName, state));
      }

      // No terminal or auto-advance effect — this should not happen in normal
      // configured dispatch, but handle gracefully by returning completed.
      log.warn(
        { stepName, completionEffects: completionEffects.map((e) => e.kind) },
        "completeStep returned no terminal or advance effect — treating as completed",
      );
      return okAsync<RunWorkflowResult, RunWorkflowError>({
        workflowInstanceId: state.workflowInstanceId,
        appliedEffects: state.appliedEffects,
        status: "completed",
        stepsDispatched: state.stepsDispatched,
      });
    });
}

// ---------------------------------------------------------------------------
// runWorkflow — main execution loop
// ---------------------------------------------------------------------------

/**
 * Run a workflow end-to-end using the engine's lifecycle surface.
 *
 * Execution flow:
 * 1. Validate that the workflow exists in `config.workflows`.
 * 2. Call `startExecution` to acquire a lease and create the instance.
 * 3. Call `dispatchStep` to get the first step's `DispatchAgentEffect`.
 * 4. Apply the `DispatchAgentEffect` by calling `adapter.spawnSubagent`.
 * 5. Call `completeStep` — the engine auto-advances and emits the next
 *    `dispatch-agent` effect (or `complete-execution` for the final step).
 * 6. Apply the auto-advance `dispatch-agent` effect and repeat from step 5
 *    until `complete-execution` or `pause-execution` is emitted.
 *
 * @param input - Workflow execution parameters.
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
    maxSteps = 100,
  } = input;

  const store = input.store ?? createInMemoryRuntimeStore();

  // Validate workflow exists before touching the store.
  const workflowConfig = config.workflows[workflowName];
  if (workflowConfig === undefined) {
    return errAsync({
      type: "WorkflowNotFound" as const,
      workflowName,
    });
  }

  const workflowInstanceId = createWorkflowInstanceId(crypto.randomUUID());

  const context: WorkflowExecutionContext = {
    workflowName,
    goal,
    slug,
    workflows: config.workflows,
  };

  log.info(
    { workflowName, goal, slug, workflowInstanceId },
    "Starting workflow execution",
  );

  // Step 1: startExecution — acquire lease and create instance.
  return startExecution(
    {
      workflowInstanceId,
      ownerId,
      context,
    },
    store,
  )
    .mapErr((cause): RunWorkflowError => ({ type: "LifecycleError", cause }))
    .andThen(({ leaseId }) => {
      log.info({ leaseId }, "Execution started — dispatching first step");

      const appliedEffects: LifecycleEffect[] = [];

      const state: LoopState = {
        workflowInstanceId,
        leaseId,
        context,
        workflowConfig,
        adapter,
        planStateProvider,
        store,
        appliedEffects,
        stepsDispatched: 0,
        maxSteps,
      };

      // Step 2: dispatchStep — resolve the first step and emit DispatchAgentEffect.
      return dispatchStep(
        {
          workflowInstanceId,
          leaseId,
          context,
        },
        store,
      )
        .mapErr(
          (cause): RunWorkflowError => ({ type: "LifecycleError", cause }),
        )
        .andThen(({ stepName, effects }) => {
          state.stepsDispatched += 1;
          log.info(
            { stepName, effectCount: effects.length },
            "First step dispatched",
          );

          for (const effect of effects) {
            appliedEffects.push(effect);
          }

          // Apply all dispatch effects from dispatchStep.
          const dispatchEffects = effects.filter(
            (e): e is DispatchAgentEffect => e.kind === "dispatch-agent",
          );

          return ResultAsync.fromPromise(
            (async () => {
              for (const effect of dispatchEffects) {
                await applyDispatchAgentEffect(effect, adapter);
              }
            })(),
            (cause): RunWorkflowError => ({
              type: "LifecycleError",
              cause: {
                type: "policy_decision",
                message: `spawnSubagent threw unexpectedly: ${String(cause)}`,
              },
            }),
          ).andThen(() =>
            // Step 3+: completeStep with auto-advance handles the rest of the loop.
            completeAndAdvance(stepName, state),
          );
        });
    });
}
