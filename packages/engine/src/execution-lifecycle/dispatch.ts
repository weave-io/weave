/**
 * Execution Lifecycle — dispatchStep implementation.
 *
 * Dispatches the next (or a specific) workflow step. Resolves the step from
 * the workflow config, validates declared inputs, renders the step prompt,
 * and emits a `DispatchAgentEffect` wrapping a `RunAgentEffect`.
 */

import type { WorkflowStep } from "@weaveio/weave-core";
import type { ResultAsync } from "neverthrow";
import { err, errAsync, ok, okAsync, type Result } from "neverthrow";
import type { RunAgentEffect } from "../run-agent-effects.js";
import type { RuntimeStore } from "../runtime/store.js";
import {
  ABSTRACT_CAPABILITIES,
  evaluateEffectiveToolPolicy,
} from "../tool-policy.js";
import {
  buildConsumedArtifacts,
  latestAttemptForStep,
  validateStepInputs,
} from "./artifacts.js";
import { lifecycleNotFoundError, lifecycleValidationError } from "./errors.js";
import { mapStoreError, validateActiveLease } from "./lease.js";
import { sanitizeMetadata } from "./metadata.js";
import { buildStepPromptContext, renderStepPrompt } from "./prompt-context.js";
import type {
  ConsumedArtifactRecord,
  DispatchStepInput,
  DispatchStepOutput,
  LifecycleError,
  WorkflowInstance,
} from "./types.js";

// ---------------------------------------------------------------------------
// RunAgentEffect builders
// ---------------------------------------------------------------------------

/**
 * Build a legacy (no-context) `RunAgentEffect` using the step name as agent
 * name and a minimal allow-all policy.
 */
function buildLegacyRunAgentEffect(stepName: string): RunAgentEffect {
  const minimalPolicy = evaluateEffectiveToolPolicy({
    read: "allow",
    write: "allow",
    execute: "allow",
    delegate: "deny",
    network: "ask",
  });
  return {
    kind: "run-agent",
    agentName: stepName,
    agentDescriptor: {
      name: stepName,
      composedPrompt: "",
      models: [],
      mode: "subagent",
      effectiveToolPolicy: minimalPolicy,
      rawToolPolicy: undefined,
      delegationTargets: [],
      skills: [],
    },
    effectiveToolPolicy: minimalPolicy,
    rawToolPolicy: undefined,
    resolvedSkills: [],
  };
}

/**
 * Build a configured `RunAgentEffect` from a resolved `WorkflowStep`.
 *
 * Uses `step.agent` as the agent name, emits `completionMethod`, `stepType`,
 * `correlationId`, and `promptMetadata`. `composedPrompt` is always `""` —
 * the security invariant is preserved.
 */
export function buildConfiguredRunAgentEffect(
  step: WorkflowStep,
  promptMetadata: { byteLength: number },
): RunAgentEffect {
  const effectivePolicy = evaluateEffectiveToolPolicy(undefined);
  return {
    kind: "run-agent",
    agentName: step.agent,
    agentDescriptor: {
      name: step.agent,
      composedPrompt: "",
      models: [],
      mode: "subagent",
      effectiveToolPolicy: effectivePolicy,
      rawToolPolicy: undefined,
      delegationTargets: [],
      skills: [],
    },
    effectiveToolPolicy: effectivePolicy,
    rawToolPolicy: undefined,
    resolvedSkills: [],
    completionMethod: step.completion.method,
    stepType: step.type,
    correlationId: crypto.randomUUID(),
    promptMetadata,
  };
}

// ---------------------------------------------------------------------------
// Step resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a `WorkflowStep` from a workflow config by step name.
 */
export function resolveWorkflowStep(
  workflowConfig: { steps: WorkflowStep[] },
  stepName: string,
): Result<WorkflowStep, LifecycleError> {
  const step = workflowConfig.steps.find((s) => s.name === stepName);
  if (step === undefined) {
    return err(
      lifecycleNotFoundError(
        "WorkflowStep",
        stepName,
        `Step "${stepName}" not found in workflow`,
      ),
    );
  }
  return ok(step);
}

// ---------------------------------------------------------------------------
// dispatchStep — implementation
// ---------------------------------------------------------------------------

/**
 * Dispatch the next (or a specific) workflow step.
 *
 * **With `input.context`** (configured dispatch):
 * 1. Resolves the step from `context.workflows[instance.workflowName].steps`
 * 2. Returns `not_found` if the step doesn't exist in the workflow config.
 * 3. Validates declared `step.inputs` artifacts are present in the instance.
 * 4. Renders `step.prompt` with instance context and artifact references.
 * 5. Emits a `DispatchAgentEffect` with `step.agent` as agent name.
 *
 * **Without `input.context`** (legacy dispatch):
 * - Uses step name as agent name with a minimal allow-all policy.
 *
 * @param input - Dispatch parameters from the adapter.
 * @param store - Runtime Store instance.
 * @returns `ok({ stepName, effects })` on success, or a typed `LifecycleError`.
 */
export function dispatchStep(
  input: DispatchStepInput,
  store: RuntimeStore,
): ResultAsync<DispatchStepOutput, LifecycleError> {
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

          const stepName =
            input.stepName ?? existing.currentStepName ?? "default";

          if (input.context === undefined) {
            return store.instances
              .update(input.workflowInstanceId, { currentStepName: stepName })
              .mapErr((storeError): LifecycleError => mapStoreError(storeError))
              .map(
                (): DispatchStepOutput => ({
                  stepName,
                  effects: [
                    {
                      kind: "dispatch-agent",
                      runAgent: buildLegacyRunAgentEffect(stepName),
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

          const resolvedStepName =
            input.stepName ??
            existing.currentStepName ??
            workflowConfig.steps[0]?.name ??
            "default";

          const stepResult = resolveWorkflowStep(
            workflowConfig,
            resolvedStepName,
          );
          if (stepResult.isErr()) return errAsync(stepResult.error);
          const step = stepResult.value;

          // Determine pinned revisions for retry reuse.
          let effectivePins: readonly ConsumedArtifactRecord[] | undefined =
            input.pinnedArtifactRevisions;
          if (effectivePins === undefined) {
            const priorAttempt = latestAttemptForStep(
              existing,
              resolvedStepName,
            );
            if (
              priorAttempt !== undefined &&
              priorAttempt.consumedArtifacts.length > 0
            ) {
              effectivePins = priorAttempt.consumedArtifacts;
            }
          }

          const pinnedNames =
            effectivePins !== undefined && effectivePins.length > 0
              ? new Set(effectivePins.map((p) => p.name))
              : undefined;
          const inputsCheck = validateStepInputs(
            step,
            existing,
            input.artifactDigests,
            pinnedNames,
          );
          if (inputsCheck.isErr()) return errAsync(inputsCheck.error);
          const artifactInputSummary = inputsCheck.value;

          const consumedArtifacts = buildConsumedArtifacts(
            step,
            existing,
            effectivePins,
          );

          const promptContext = buildStepPromptContext(existing, step);
          const artifactNames = existing.artifacts.map((a) => a.name);
          const promptResult = renderStepPrompt(
            step.prompt,
            promptContext,
            artifactNames,
          );
          if (promptResult.isErr()) return errAsync(promptResult.error);
          const promptMetadata = promptResult.value;

          const hasInputs = step.inputs && step.inputs.length > 0;

          return store.instances
            .update(input.workflowInstanceId, {
              currentStepName: resolvedStepName,
            })
            .mapErr((storeError): LifecycleError => mapStoreError(storeError))
            .andThen(() =>
              store.instances
                .recordStepAttempt(
                  input.workflowInstanceId,
                  resolvedStepName,
                  consumedArtifacts,
                )
                .mapErr(
                  (storeError): LifecycleError => mapStoreError(storeError),
                ),
            )
            .map(
              (): DispatchStepOutput => ({
                stepName: resolvedStepName,
                effects: [
                  {
                    kind: "dispatch-agent",
                    runAgent: buildConfiguredRunAgentEffect(
                      step,
                      promptMetadata,
                    ),
                  },
                ],
                ...(hasInputs ? { artifactInputSummary } : {}),
              }),
            );
        }),
    );
}
