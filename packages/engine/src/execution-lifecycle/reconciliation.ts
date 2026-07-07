/**
 * Execution Lifecycle — reconcileExecution implementation.
 *
 * Triggers reconciliation for a workflow instance. Enforces the closed
 * reconciliation reason set, validates the authorization source, routes to
 * the nearest explicitly declared upstream handler step, and fails closed
 * by pausing the instance when no handler exists.
 *
 * @see docs/specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md Unit 3
 */

import type {
  ReconciliationReason,
  WorkflowConfig,
  WorkflowStep,
} from "@weaveio/weave-core";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type { PlanStateProvider } from "../plan-state-provider.js";
import type { RuntimeStore } from "../runtime/store.js";
import { validateReconciliationSource } from "./authorization.js";
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
  LifecycleEffect,
  LifecycleError,
  ReconcileExecutionInput,
  ReconcileExecutionOutput,
  ReconcileExecutionResult,
  ReconciliationAuthorizationSource,
  WorkflowInstance,
  WorkflowInstanceId,
} from "./types.js";

// ---------------------------------------------------------------------------
// Before-plan exclusion set
// ---------------------------------------------------------------------------

/**
 * Compute the set of step names that are `before-plan` steps in a workflow.
 *
 * A step is a `before-plan` step when the workflow publishes the `before-plan`
 * extension point (`extension_points.before_plan === true`) AND the step
 * appears before the canonical planning step (`role === "planning"`) in the
 * step list.
 *
 * **v1 rule**: `before-plan` steps do not participate in reconciliation
 * semantics.
 */
function computeBeforePlanExclusionSet(
  workflowConfig: WorkflowConfig,
): ReadonlySet<string> {
  if (!workflowConfig.extension_points?.before_plan) return new Set();

  const planningIndex = workflowConfig.steps.findIndex(
    (s) => s.role === "planning",
  );
  if (planningIndex < 0) return new Set();

  const excluded = new Set<string>();
  for (let i = 0; i < planningIndex; i++) {
    const step = workflowConfig.steps[i];
    if (step !== undefined) excluded.add(step.name);
  }
  return excluded;
}

// ---------------------------------------------------------------------------
// Handler resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the nearest explicitly declared upstream handler step for a
 * reconciliation reason, searching backwards from the triggering step.
 *
 * **Algorithm**:
 * 1. Find the index of `triggeringStepName` in the workflow step list.
 * 2. Walk backwards from that index (exclusive) toward the start.
 * 3. Skip any step in the `beforePlanExclusions` set.
 * 4. Return the first step whose `reconciliation_handlers` list contains
 *    an entry with `reason === reconciliationReason`.
 * 5. If no handler is found, return `undefined` (fail-closed path).
 */
function resolveReconciliationHandler(
  workflowConfig: WorkflowConfig,
  triggeringStepName: string,
  reconciliationReason: ReconciliationReason,
  beforePlanExclusions: ReadonlySet<string>,
): WorkflowStep | undefined {
  const steps = workflowConfig.steps;
  const triggeringIndex = steps.findIndex((s) => s.name === triggeringStepName);

  const searchFrom =
    triggeringIndex >= 0 ? triggeringIndex - 1 : steps.length - 1;

  for (let i = searchFrom; i >= 0; i--) {
    const step = steps[i];
    if (step === undefined) continue;
    if (beforePlanExclusions.has(step.name)) continue;
    if (!step.reconciliation_handlers) continue;
    const hasHandler = step.reconciliation_handlers.some(
      (h) => h.reason === reconciliationReason,
    );
    if (hasHandler) return step;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Immutable completed plan check
// ---------------------------------------------------------------------------

/**
 * Check whether the plan associated with the triggering step is already
 * complete, and if so, return a `policy_decision` error.
 *
 * **Immutability rule** (Spec 22 Unit 3):
 * Completed `Plan Markdown` tasks are immutable. Reconciliation must not
 * revise them in place. Corrective work must be expressed as follow-up tasks.
 */
function checkCompletedPlanImmutability(
  triggeringStep: WorkflowStep,
  instance: WorkflowInstance,
  planStateProvider: PlanStateProvider,
): ResultAsync<undefined, LifecycleError> {
  const method = triggeringStep.completion.method;

  if (method !== "plan_complete" && method !== "plan_created") {
    return okAsync(undefined);
  }

  const planNameResult = renderPlanName(
    triggeringStep.completion.plan_name,
    instance,
  );
  if (planNameResult.isErr()) return errAsync(planNameResult.error);
  const planName = planNameResult.value;

  return planStateProvider
    .isPlanComplete(planName)
    .mapErr((providerErr): LifecycleError => {
      if (providerErr.type === "InvalidPlanName") {
        return lifecycleValidationError(
          `plan name "${planName}" contains unsafe characters`,
          "plan_name",
        );
      }
      return lifecyclePersistenceError(
        `PlanStateProvider unavailable for plan "${planName}"`,
        { type: "query", message: String(providerErr.cause) },
      );
    })
    .andThen((complete) => {
      if (!complete) return okAsync(undefined);
      const planPath = `.weave/plans/${planName}.md`;
      return errAsync(
        lifecyclePolicyDecisionError(
          `Reconciliation rejected: plan "${planPath}" has all tasks completed. ` +
            `Completed Plan Markdown tasks are immutable — corrective work must be expressed as follow-up tasks, not in-place revisions. ` +
            `See docs/specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md Unit 3.`,
          "completed_plan_immutability",
        ),
      );
    });
}

// ---------------------------------------------------------------------------
// Handler dispatch or pause
// ---------------------------------------------------------------------------

/**
 * Resolve the nearest upstream handler step and either dispatch it or pause.
 *
 * - When a handler step is found: updates `currentStepName` to the handler,
 *   renders its prompt, and returns a `dispatch-agent` effect.
 * - When no handler is found: updates instance to `paused` and returns a
 *   `pause-execution` effect (fail-closed).
 */
function dispatchHandlerOrPause(
  store: RuntimeStore,
  workflowInstanceId: WorkflowInstanceId,
  workflowConfig: WorkflowConfig,
  triggeringStepName: string | undefined,
  reconciliationReason: ReconciliationReason,
  beforePlanExclusions: ReadonlySet<string>,
  gateReRunStepName: string | undefined,
): ResultAsync<ReconcileExecutionOutput, LifecycleError> {
  const handlerStep = resolveReconciliationHandler(
    workflowConfig,
    triggeringStepName ?? "",
    reconciliationReason,
    beforePlanExclusions,
  );

  if (handlerStep === undefined) {
    return store.instances
      .update(workflowInstanceId, { status: "paused" })
      .mapErr((storeError): LifecycleError => mapStoreError(storeError))
      .map(
        (): ReconcileExecutionOutput => ({
          handlerFound: false,
          ...(gateReRunStepName !== undefined ? { gateReRunStepName } : {}),
          effects: [
            {
              kind: "pause-execution",
              workflowInstanceId,
              reason: `Reconciliation (${reconciliationReason}): no upstream handler declared — failing closed`,
            },
          ],
        }),
      );
  }

  return store.instances
    .update(workflowInstanceId, {
      currentStepName: handlerStep.name,
      status: "running",
    })
    .mapErr((storeError): LifecycleError => mapStoreError(storeError))
    .andThen((updatedInstance) => {
      const artifactNames = updatedInstance.artifacts.map((a) => a.name);
      const promptContext = buildStepPromptContext(
        updatedInstance,
        handlerStep,
      );
      const promptResult = renderStepPrompt(
        handlerStep.prompt,
        promptContext,
        artifactNames,
      );
      if (promptResult.isErr()) return errAsync(promptResult.error);
      const promptMetadata = promptResult.value;
      const runAgent = buildConfiguredRunAgentEffect(
        handlerStep,
        promptMetadata,
      );
      return okAsync<ReconcileExecutionOutput, LifecycleError>({
        handlerStepName: handlerStep.name,
        handlerFound: true,
        ...(gateReRunStepName !== undefined ? { gateReRunStepName } : {}),
        effects: [{ kind: "dispatch-agent", runAgent }],
      });
    });
}

// ---------------------------------------------------------------------------
// reconcileExecution — implementation
// ---------------------------------------------------------------------------

/**
 * Trigger reconciliation for a workflow instance.
 *
 * Enforces the closed reconciliation reason set, validates the authorization
 * source, routes to the nearest explicitly declared upstream handler step,
 * and fails closed by pausing the instance when no handler exists.
 *
 * @param input - Reconciliation parameters from the adapter.
 * @param store - Runtime Store instance.
 * @returns `ok(ReconcileExecutionOutput)` on success, or a typed `LifecycleError`.
 */
export function reconcileExecution(
  input: ReconcileExecutionInput,
  store: RuntimeStore,
): ReconcileExecutionResult {
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
  if (!input.reason) {
    return errAsync(lifecycleValidationError("reason is required", "reason"));
  }
  if (!input.authorizationSource) {
    return errAsync(
      lifecycleValidationError(
        "authorizationSource is required",
        "authorizationSource",
      ),
    );
  }

  const sourceCheck = validateReconciliationSource(
    input.reason,
    input.authorizationSource,
  );
  if (sourceCheck.isErr()) return errAsync(sourceCheck.error);

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
      return okAsync(undefined);
    })
    .andThen(() =>
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

          const triggeringStepName =
            input.triggeringStepName ?? existing.currentStepName;

          const gateReRunStepName =
            input.reason === "review-rejection" ||
            input.reason === "security-rejection"
              ? (triggeringStepName ?? undefined)
              : undefined;

          if (input.context === undefined) {
            return store.instances
              .update(input.workflowInstanceId, { status: "paused" })
              .mapErr((storeError): LifecycleError => mapStoreError(storeError))
              .map(
                (): ReconcileExecutionOutput => ({
                  handlerFound: false,
                  ...(gateReRunStepName !== undefined
                    ? { gateReRunStepName }
                    : {}),
                  effects: [
                    {
                      kind: "pause-execution",
                      workflowInstanceId: input.workflowInstanceId,
                      reason: `Reconciliation (${input.reason}): no workflow context provided — failing closed`,
                    },
                  ],
                }),
              );
          }

          const workflowConfig = input.context.workflows[existing.workflowName];
          if (workflowConfig === undefined) {
            return errAsync(
              lifecycleNotFoundError(
                "WorkflowConfig",
                existing.workflowName,
                `Workflow "${existing.workflowName}" not found in provided workflow map`,
              ),
            );
          }

          const beforePlanExclusions =
            computeBeforePlanExclusionSet(workflowConfig);

          const triggeringStepConfig =
            triggeringStepName !== undefined
              ? workflowConfig.steps.find((s) => s.name === triggeringStepName)
              : undefined;

          if (
            input.planStateProvider !== undefined &&
            triggeringStepConfig !== undefined
          ) {
            return checkCompletedPlanImmutability(
              triggeringStepConfig,
              existing,
              input.planStateProvider,
            ).andThen(() =>
              dispatchHandlerOrPause(
                store,
                input.workflowInstanceId,
                workflowConfig,
                triggeringStepName,
                input.reason,
                beforePlanExclusions,
                gateReRunStepName,
              ),
            );
          }

          return dispatchHandlerOrPause(
            store,
            input.workflowInstanceId,
            workflowConfig,
            triggeringStepName,
            input.reason,
            beforePlanExclusions,
            gateReRunStepName,
          );
        }),
    );
}
