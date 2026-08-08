/**
 * Execution Lifecycle — step prompt context building and rendering.
 *
 * Provides helpers for building Mustache template contexts from workflow
 * instance state and rendering step prompts with security invariants.
 *
 * Security invariant: rendered prompt text is NEVER stored in
 * `LifecycleEffect`/`RunAgentEffect` — only its byte length is carried there
 * as `PromptMetadata`. The rendered text itself is returned separately (see
 * `renderStepPrompt`'s return value) and may only be threaded into the
 * *ephemeral* `stepPromptText` field of `DispatchStepOutput`,
 * `CompleteStepOutput`, or `ReconcileExecutionOutput` — never persisted,
 * never logged, and never copied into an effect.
 */

import type { WorkflowStep } from "@weaveio/weave-core";
import { err, ok, type Result } from "neverthrow";
import {
  type RendererError,
  renderTemplate,
  type TemplateContext,
} from "../template-renderer.js";
import { lifecycleValidationError } from "./errors.js";
import type { LifecycleError, WorkflowInstance } from "./types.js";

/**
 * Allowed template paths for workflow step prompt rendering.
 *
 * These paths are the only ones the engine exposes to step prompts.
 * Adapters may not inject additional paths — the set is engine-owned.
 */
const STEP_PROMPT_ALLOWED_PATHS: ReadonlySet<string> = new Set([
  "instance.goal",
  "instance.slug",
  "instance.workflowName",
  "instance.currentStepName",
  "step.name",
  "step.type",
  "step.agent",
  "artifacts",
]);

/**
 * Build the Mustache template context for a workflow step prompt.
 *
 * Exposes instance fields and artifact references under the allowed paths.
 * Never exposes raw prompt content, credentials, or harness-private data.
 */
export function buildStepPromptContext(
  instance: WorkflowInstance,
  step: WorkflowStep,
): TemplateContext {
  const artifactsMap: TemplateContext = {};
  for (const artifact of instance.artifacts) {
    artifactsMap[artifact.name] = artifact.path;
  }

  return {
    instance: {
      goal: instance.goal,
      slug: instance.slug,
      workflowName: instance.workflowName,
      currentStepName: instance.currentStepName ?? "",
    },
    step: {
      name: step.name,
      type: step.type,
      agent: step.agent,
    },
    artifacts: artifactsMap,
  };
}

/**
 * Render a step prompt template and return both the rendered text and
 * sanitized prompt metadata.
 *
 * Callers MUST observe the split security contract on the return value:
 * - `byteLength` is persisted-safe — it is the only piece derived from
 *   rendering that may be placed on a `RunAgentEffect.promptMetadata`
 *   (which travels inside a `LifecycleEffect` and may be logged/observed).
 * - `text` is the actual rendered prompt. It is EPHEMERAL — callers may only
 *   surface it via the top-level `stepPromptText` field of
 *   `DispatchStepOutput`, `CompleteStepOutput`, or `ReconcileExecutionOutput`
 *   (never inside an effect, never persisted to the Runtime Store, never
 *   logged). Adapters read it once, compose it with their own
 *   `AgentDescriptor.composedPrompt`, and discard it.
 *
 * Artifact names from the instance are added to the allowed paths set as
 * `artifacts.<name>` so that templates like `{{artifacts.plan_path}}` resolve
 * correctly without requiring a static allowlist of artifact names.
 *
 * Maps `RendererError` to a `LifecycleError` with type `validation`.
 */
export function renderStepPrompt(
  promptTemplate: string,
  context: TemplateContext,
  artifactNames: readonly string[],
): Result<{ text: string; byteLength: number }, LifecycleError> {
  const allowedPaths = new Set(STEP_PROMPT_ALLOWED_PATHS);
  for (const name of artifactNames) {
    allowedPaths.add(`artifacts.${name}`);
  }

  const renderResult = renderTemplate(promptTemplate, context, {
    allowedPaths,
  });
  if (renderResult.isErr()) {
    const re: RendererError = renderResult.error;
    return err(
      lifecycleValidationError(
        `Step prompt template error: ${re.message}`,
        "step.prompt",
      ),
    );
  }
  const rendered = renderResult.value;
  const byteLength = new TextEncoder().encode(rendered).byteLength;
  return ok({ text: rendered, byteLength });
}

/**
 * Render the `plan_name` template from a step's completion config.
 *
 * The `plan_name` field may contain Mustache placeholders (e.g.
 * `{{instance.slug}}`). This function renders it with the instance context
 * and returns the resolved plan name string.
 */
export function renderPlanName(
  planNameTemplate: string,
  instance: WorkflowInstance,
): Result<string, LifecycleError> {
  const context: TemplateContext = {
    instance: {
      goal: instance.goal,
      slug: instance.slug,
      workflowName: instance.workflowName,
      currentStepName: instance.currentStepName ?? "",
    },
  };
  const allowedPaths = new Set([
    "instance.goal",
    "instance.slug",
    "instance.workflowName",
    "instance.currentStepName",
  ]);
  const renderResult = renderTemplate(planNameTemplate, context, {
    allowedPaths,
  });
  if (renderResult.isErr()) {
    return err(
      lifecycleValidationError(
        `plan_name template error: ${renderResult.error.message}`,
        "completion.plan_name",
      ),
    );
  }
  return ok(renderResult.value);
}
