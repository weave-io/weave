/**
 * Execution Lifecycle — completeStep implementation.
 *
 * Records the completion of a workflow step and advances the workflow state.
 * Handles gate logic, plan checks, artifact persistence, and auto-advance.
 *
 * ## Line count justification (621 lines)
 *
 * `completeStep` is the most complex lifecycle method because it must handle:
 * - Two dispatch paths: configured (with context) and legacy (without context)
 * - Four outcome variants: success, blocked, failed, paused
 * - Gate logic: review_verdict with approve/reject/retry policies
 * - Plan checks: plan_created and plan_complete completion methods
 * - Output artifact validation and sequential persistence
 * - Auto-advance: dispatch next step or complete workflow on final step
 *
 * These concerns cannot be cleanly separated without introducing shared mutable
 * state or deeply nested callbacks. The 621-line count reflects the inherent
 * complexity of the step completion contract, not incidental complexity.
 * All private helpers are co-located here to keep the call graph readable.
 */

import type { WorkflowConfig, WorkflowStep } from "@weaveio/weave-core";
import type { ResultAsync } from "neverthrow";
import { err, errAsync, ok, okAsync, type Result } from "neverthrow";
import type {
  PlanStateError,
  PlanStateProvider,
} from "../plan-state-provider.js";
import type {
  RuntimeStore,
  UpdateWorkflowInstanceInput,
} from "../runtime/store.js";
import {
  addArtifactsSequentially,
  validateOutputArtifacts,
  validateStepInputs,
} from "./artifacts.js";
import { buildConfiguredRunAgentEffect } from "./dispatch.js";
import {
  lifecycleNotFoundError,
  lifecyclePersistenceError,
  lifecyclePolicyDecisionError,
  lifecycleValidationError,
} from "./errors.js";
import { mapStoreError, validateActiveLease } from "./lease.js";
import { sanitizeMetadata } from "./metadata.js";
import {
  buildStepPromptContext,
  renderPlanName,
  renderStepPrompt,
} from "./prompt-context.js";
import type {
  CompleteStepInput,
  CompleteStepOutput,
  ExecutionLease,
  LifecycleEffect,
  LifecycleError,
  StepCompletionSignal,
  WorkflowInstance,
  WorkflowInstanceId,
} from "./types.js";

// ---------------------------------------------------------------------------
// Completion method validation
// ---------------------------------------------------------------------------

/**
 * Validate that the signal's `method` matches the step's declared
 * `completion.method`.
 */
function validateCompletionMethod(
  signal: StepCompletionSignal,
  step: WorkflowStep,
): Result<undefined, LifecycleError> {
  if (signal.method === undefined) return ok(undefined);
  if (signal.method === step.completion.method) return ok(undefined);
  return err(
    lifecycleValidationError(
      `Completion method mismatch: signal has "${signal.method}" but step "${step.name}" declares "${step.completion.method}"`,
      "completion.method",
    ),
  );
}

// ---------------------------------------------------------------------------
// Plan state error mapping
// ---------------------------------------------------------------------------

/**
 * Map a `PlanStateError` from a `PlanStateProvider` to a `LifecycleError`.
 *
 * - `InvalidPlanName` → `validation` error (bad plan name)
 * - `ProviderUnavailable` → `persistence` error (I/O failure)
 */
function mapPlanStateError(
  providerErr: PlanStateError,
  planName: string,
): LifecycleError {
  if (providerErr.type === "InvalidPlanName") {
    return lifecycleValidationError(
      `plan name "${planName}" contains unsafe characters — only alphanumeric characters, hyphens, and underscores are allowed`,
      "plan_name",
    );
  }
  return lifecyclePersistenceError(
    `PlanStateProvider unavailable for plan "${planName}"`,
    { type: "query", message: String(providerErr.cause) },
  );
}

// ---------------------------------------------------------------------------
// Status update helper
// ---------------------------------------------------------------------------

/**
 * Map a step outcome to the corresponding `UpdateWorkflowInstanceInput`.
 */
function buildUpdateInput(
  outcome: StepCompletionSignal["outcome"],
  message: string | undefined,
): UpdateWorkflowInstanceInput {
  if (outcome === "success") return { status: "running" };
  if (outcome === "blocked") return { status: "blocked" };
  if (outcome === "failed") {
    return {
      status: "failed",
      ...(message !== undefined ? { errorMessage: message } : {}),
    };
  }
  return { status: "paused" };
}

// ---------------------------------------------------------------------------
// Gate rejection
// ---------------------------------------------------------------------------

/**
 * Apply the gate rejection policy for a rejected `review_verdict` signal.
 *
 * - `"pause"` — updates instance to `paused`, emits `pause-execution`
 * - `"fail"`  — updates instance to `failed`, releases lease, emits `complete-execution`
 * - `"retry"` — re-dispatches the same gate step with a fresh correlation ID
 */
function applyGateRejection(
  store: RuntimeStore,
  workflowInstanceId: WorkflowInstanceId,
  activeLease: ExecutionLease,
  step: WorkflowStep,
  message: string | undefined,
): ResultAsync<readonly LifecycleEffect[], LifecycleError> {
  const policy = step.on_reject ?? "pause";

  if (policy === "pause") {
    return store.instances
      .update(workflowInstanceId, { status: "paused" })
      .mapErr((storeError): LifecycleError => mapStoreError(storeError))
      .map((): readonly LifecycleEffect[] => [
        { kind: "pause-execution", workflowInstanceId },
      ]);
  }

  if (policy === "fail") {
    return store.instances
      .update(workflowInstanceId, {
        status: "failed",
        ...(message !== undefined ? { errorMessage: message } : {}),
      })
      .mapErr((storeError): LifecycleError => mapStoreError(storeError))
      .andThen(() =>
        store.leases
          .release(activeLease.id, activeLease.ownerId)
          .mapErr((storeError): LifecycleError => mapStoreError(storeError)),
      )
      .map((): readonly LifecycleEffect[] => [
        { kind: "complete-execution", workflowInstanceId },
      ]);
  }

  // policy === "retry" — re-dispatch the same gate step with a fresh correlation ID.
  return store.instances
    .getById(workflowInstanceId)
    .mapErr((storeError): LifecycleError => mapStoreError(storeError))
    .andThen((instance) => {
      const artifactNames = instance.artifacts.map((a) => a.name);
      const promptContext = buildStepPromptContext(instance, step);
      const promptResult = renderStepPrompt(
        step.prompt,
        promptContext,
        artifactNames,
      );
      if (promptResult.isErr()) return errAsync(promptResult.error);
      const promptMetadata = promptResult.value;
      const runAgent = buildConfiguredRunAgentEffect(step, promptMetadata);
      return okAsync([
        { kind: "dispatch-agent" as const, runAgent },
      ] as readonly LifecycleEffect[]);
    });
}

// ---------------------------------------------------------------------------
// Auto-advance effects
// ---------------------------------------------------------------------------

/**
 * Build the auto-advance effects for a successful configured step completion.
 *
 * - If a next step exists: updates `currentStepName`, renders the next step's
 *   prompt with the updated instance (including newly persisted artifacts),
 *   and returns a `dispatch-agent` effect.
 * - If this is the final step: updates status to `completed`, releases the
 *   active lease, and returns a `complete-execution` effect.
 */
function buildAutoAdvanceEffects(
  store: RuntimeStore,
  workflowInstanceId: WorkflowInstanceId,
  activeLease: ExecutionLease,
  workflowConfig: WorkflowConfig,
  completedStepName: string,
): ResultAsync<readonly LifecycleEffect[], LifecycleError> {
  const currentIndex = workflowConfig.steps.findIndex(
    (s) => s.name === completedStepName,
  );
  const nextStep =
    currentIndex >= 0 ? workflowConfig.steps[currentIndex + 1] : undefined;

  if (nextStep === undefined) {
    return store.instances
      .update(workflowInstanceId, { status: "completed" })
      .mapErr((storeError): LifecycleError => mapStoreError(storeError))
      .andThen(() =>
        store.leases
          .release(activeLease.id, activeLease.ownerId)
          .mapErr((storeError): LifecycleError => mapStoreError(storeError)),
      )
      .map((): readonly LifecycleEffect[] => [
        { kind: "complete-execution", workflowInstanceId },
      ]);
  }

  return store.instances
    .getById(workflowInstanceId)
    .mapErr((storeError): LifecycleError => mapStoreError(storeError))
    .andThen((currentInstance) => {
      const inputsCheck = validateStepInputs(nextStep, currentInstance);
      if (inputsCheck.isErr()) return errAsync(inputsCheck.error);
      return okAsync(currentInstance);
    })
    .andThen((currentInstance) =>
      store.instances
        .update(workflowInstanceId, { currentStepName: nextStep.name })
        .mapErr((storeError): LifecycleError => mapStoreError(storeError))
        .map(() => currentInstance),
    )
    .andThen((currentInstance) => {
      const artifactNames = currentInstance.artifacts.map((a) => a.name);
      const promptContext = buildStepPromptContext(currentInstance, nextStep);
      const promptResult = renderStepPrompt(
        nextStep.prompt,
        promptContext,
        artifactNames,
      );
      if (promptResult.isErr()) return errAsync(promptResult.error);
      const promptMetadata = promptResult.value;

      const runAgent = buildConfiguredRunAgentEffect(nextStep, promptMetadata);
      return okAsync([
        { kind: "dispatch-agent" as const, runAgent },
      ] as readonly LifecycleEffect[]);
    });
}

// ---------------------------------------------------------------------------
// Plan checks
// ---------------------------------------------------------------------------

/**
 * Run plan-state checks for `plan_created` and `plan_complete` completion methods.
 */
function runPlanCheck(
  stepConfig: WorkflowStep,
  existing: WorkflowInstance,
  planStateProvider: PlanStateProvider | undefined,
): ResultAsync<undefined, LifecycleError> {
  if (stepConfig.completion.method === "plan_created") {
    if (!planStateProvider) {
      return errAsync(
        lifecyclePolicyDecisionError(
          "plan completion method requires a planStateProvider",
          "plan_state_provider",
        ),
      );
    }
    const planNameResult = renderPlanName(
      stepConfig.completion.plan_name,
      existing,
    );
    if (planNameResult.isErr()) return errAsync(planNameResult.error);
    return planStateProvider
      .planExists(planNameResult.value)
      .mapErr(
        (providerErr): LifecycleError =>
          mapPlanStateError(providerErr, planNameResult.value),
      )
      .andThen((exists) => {
        if (!exists) {
          const planPath = `.weave/plans/${planNameResult.value}.md`;
          return errAsync(
            lifecycleNotFoundError(
              "plan_file",
              planPath,
              `Plan file "${planPath}" does not exist`,
            ),
          );
        }
        return okAsync(undefined);
      });
  }

  if (stepConfig.completion.method === "plan_complete") {
    if (!planStateProvider) {
      return errAsync(
        lifecyclePolicyDecisionError(
          "plan completion method requires a planStateProvider",
          "plan_state_provider",
        ),
      );
    }
    const planNameResult = renderPlanName(
      stepConfig.completion.plan_name,
      existing,
    );
    if (planNameResult.isErr()) return errAsync(planNameResult.error);
    return planStateProvider
      .isPlanComplete(planNameResult.value)
      .mapErr(
        (providerErr): LifecycleError =>
          mapPlanStateError(providerErr, planNameResult.value),
      )
      .andThen((complete) => {
        if (!complete) {
          const planPath = `.weave/plans/${planNameResult.value}.md`;
          return errAsync(
            lifecycleValidationError(
              `Plan "${planPath}" has incomplete checkbox(es) — all tasks must be checked off`,
              "plan_complete",
            ),
          );
        }
        return okAsync(undefined);
      });
  }

  return okAsync(undefined);
}

// ---------------------------------------------------------------------------
// completeStep — implementation
// ---------------------------------------------------------------------------

/**
 * Record the completion of a workflow step and advance the workflow state.
 *
 * **With `input.context`** and `outcome === "success"`:
 * 1. Validates output artifacts against `step.outputs` (all-or-nothing).
 * 2. Persists validated artifacts via `store.instances.addArtifact()`.
 * 3. Auto-advances:
 *    - Non-final step: updates `currentStepName`, emits `dispatch-agent` for next step.
 *    - Final step: transitions to `completed`, releases lease, emits `complete-execution`.
 *
 * **Without `input.context`** (legacy):
 * - Maps `outcome` to status, persists any provided artifacts, returns legacy effects.
 *
 * @param input - Step completion parameters from the adapter.
 * @param store - Runtime Store instance.
 * @returns `ok({ effects })` on success, or a typed `LifecycleError`.
 */
export function completeStep(
  input: CompleteStepInput,
  store: RuntimeStore,
): ResultAsync<CompleteStepOutput, LifecycleError> {
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
  if (!input.stepName) {
    return errAsync(
      lifecycleValidationError("stepName is required", "stepName"),
    );
  }
  if (!input.completionSignal) {
    return errAsync(
      lifecycleValidationError(
        "completionSignal is required",
        "completionSignal",
      ),
    );
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
      return okAsync(leaseCheck.value);
    })
    .andThen((activeLease) =>
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

          const { outcome, message, artifacts } = input.completionSignal;

          if (input.context !== undefined) {
            const workflowConfig =
              input.context.workflows[existing.workflowName];

            if (workflowConfig === undefined) {
              return errAsync(
                lifecycleNotFoundError(
                  "WorkflowConfig",
                  existing.workflowName,
                  `Workflow "${existing.workflowName}" not found in provided workflow map`,
                ),
              );
            }

            const stepConfig = workflowConfig.steps.find(
              (s) => s.name === input.stepName,
            );
            if (stepConfig === undefined) {
              return errAsync(
                lifecycleNotFoundError(
                  "WorkflowStep",
                  input.stepName,
                  `Step "${input.stepName}" not found in workflow`,
                ),
              );
            }

            if (
              existing.currentStepName !== undefined &&
              existing.currentStepName !== input.stepName
            ) {
              return errAsync(
                lifecycleValidationError(
                  `Out-of-order completion: step "${input.stepName}" cannot be completed while instance is on step "${existing.currentStepName}"`,
                  "stepName",
                ),
              );
            }

            const methodCheckResult = validateCompletionMethod(
              input.completionSignal,
              stepConfig,
            );
            if (methodCheckResult.isErr())
              return errAsync(methodCheckResult.error);

            if (stepConfig.completion.method === "review_verdict") {
              if (input.completionSignal.approved === undefined) {
                return errAsync(
                  lifecycleValidationError(
                    `Step "${stepConfig.name}" uses review_verdict completion — completionSignal.approved must be true or false`,
                    "completionSignal.approved",
                  ),
                );
              }
              if (input.completionSignal.approved === false) {
                return applyGateRejection(
                  store,
                  input.workflowInstanceId,
                  activeLease,
                  stepConfig,
                  message,
                ).map((effects): CompleteStepOutput => ({ effects }));
              }
            }

            if (outcome !== "success") {
              const updateInput = buildUpdateInput(outcome, message);
              return store.instances
                .update(input.workflowInstanceId, updateInput)
                .mapErr(
                  (storeError): LifecycleError => mapStoreError(storeError),
                )
                .andThen(() => {
                  if (!artifacts || artifacts.length === 0) {
                    return okAsync(undefined);
                  }
                  return addArtifactsSequentially(
                    store,
                    input.workflowInstanceId,
                    artifacts,
                  );
                })
                .andThen(
                  (): ResultAsync<
                    readonly LifecycleEffect[],
                    LifecycleError
                  > => {
                    if (outcome === "paused") {
                      return okAsync([
                        {
                          kind: "pause-execution" as const,
                          workflowInstanceId: input.workflowInstanceId,
                        },
                      ]);
                    }
                    return store.leases
                      .release(activeLease.id, activeLease.ownerId)
                      .mapErr(
                        (storeError): LifecycleError =>
                          mapStoreError(storeError),
                      )
                      .map((): readonly LifecycleEffect[] => [
                        {
                          kind: "complete-execution",
                          workflowInstanceId: input.workflowInstanceId,
                        },
                      ]);
                  },
                )
                .map((effects): CompleteStepOutput => ({ effects }));
            }

            return runPlanCheck(stepConfig, existing, input.planStateProvider)
              .andThen(() => {
                const outputCheck = validateOutputArtifacts(
                  stepConfig,
                  artifacts,
                );
                if (outputCheck.isErr()) return errAsync(outputCheck.error);
                return okAsync(undefined);
              })
              .andThen(() =>
                store.instances
                  .update(input.workflowInstanceId, { status: "running" })
                  .mapErr(
                    (storeError): LifecycleError => mapStoreError(storeError),
                  ),
              )
              .andThen(() => {
                if (!artifacts || artifacts.length === 0) {
                  return okAsync(undefined);
                }
                return addArtifactsSequentially(
                  store,
                  input.workflowInstanceId,
                  artifacts,
                );
              })
              .andThen(() =>
                buildAutoAdvanceEffects(
                  store,
                  input.workflowInstanceId,
                  activeLease,
                  workflowConfig,
                  input.stepName,
                ),
              )
              .map((effects): CompleteStepOutput => ({ effects }));
          }

          // Legacy path (no context)
          const updateInput = buildUpdateInput(outcome, message);

          return store.instances
            .update(input.workflowInstanceId, updateInput)
            .mapErr((storeError): LifecycleError => mapStoreError(storeError))
            .andThen(() => {
              if (!artifacts || artifacts.length === 0) {
                return okAsync(undefined);
              }
              return addArtifactsSequentially(
                store,
                input.workflowInstanceId,
                artifacts,
              );
            })
            .andThen(
              (): ResultAsync<readonly LifecycleEffect[], LifecycleError> => {
                if (outcome === "paused") {
                  return okAsync([
                    {
                      kind: "pause-execution" as const,
                      workflowInstanceId: input.workflowInstanceId,
                    },
                  ]);
                }
                if (outcome === "success") {
                  return okAsync([]);
                }
                return store.leases
                  .release(activeLease.id, activeLease.ownerId)
                  .mapErr(
                    (storeError): LifecycleError => mapStoreError(storeError),
                  )
                  .map((): readonly LifecycleEffect[] => [
                    {
                      kind: "complete-execution",
                      workflowInstanceId: input.workflowInstanceId,
                    },
                  ]);
              },
            )
            .map((effects): CompleteStepOutput => ({ effects }));
        }),
    );
}
