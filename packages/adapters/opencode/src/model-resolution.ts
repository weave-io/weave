/**
 * Adapter-local model resolution for the OpenCode adapter.
 *
 * This module gathers OpenCode model context (available models, UI-selected
 * model, system default) and calls `resolveAdapterModelIntent()` from
 * `@weave/engine` to produce a validated model selection for each agent.
 *
 * ## Design
 *
 * - Model discovery is adapter-owned: this module is the only place that
 *   queries OpenCode for available models.
 * - `resolveAdapterModelIntent()` is engine-owned: it applies the priority
 *   chain (override → ui-selected → category → agent → system-default →
 *   constant-fallback) without querying harness state itself.
 * - Explicit subagent model intent fails fast when the requested model is not
 *   in the available set. This prevents silent fallback to an unintended model
 *   when the user has declared a specific model preference.
 *
 * ## Fail-fast rule for explicit subagent models
 *
 * When an agent's `mode` is `"subagent"` and `agentModels` is non-empty, the
 * first declared model must be available. If it is not, `resolveModelForAgent`
 * returns `err(ModelNotAvailableError)` rather than falling back silently.
 *
 * This rule is intentionally strict: subagents are typically invoked
 * programmatically with a specific model in mind, and silent fallback would
 * produce unexpected behavior that is hard to debug.
 *
 * Boundary rule: this module imports engine types only through `@weave/engine`
 * and SDK types only through `./sdk-types`. It must not import directly from
 * `@opencode-ai/sdk`.
 */

import type { AgentDescriptor, ModelResolutionInput } from "@weave/engine";
import { resolveAdapterModelIntent } from "@weave/engine";
import { err, ok, type Result } from "neverthrow";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Discriminated union of errors that model resolution can return.
 */
export type ModelResolutionError =
  | {
      /**
       * The agent declared an explicit model preference but none of the
       * declared models are available in the current OpenCode instance.
       *
       * This is a hard error for subagent mode — silent fallback is not
       * permitted when the user has declared explicit model intent.
       */
      type: "ModelNotAvailableError";
      agentName: string;
      requestedModels: string[];
      availableModels: string[];
      message: string;
    }
  | {
      /**
       * The model resolution input was structurally invalid.
       */
      type: "ModelResolutionInputError";
      agentName: string;
      message: string;
    };

// ---------------------------------------------------------------------------
// OpenCode model context
// ---------------------------------------------------------------------------

/**
 * Adapter-provided OpenCode model context.
 *
 * Adapters gather this context from the OpenCode runtime (e.g. via
 * `client.app.providers()`) and pass it to `resolveModelForAgent()`.
 * The engine never queries harness state directly.
 */
export interface OpenCodeModelContext {
  /**
   * Set of model IDs available in the current OpenCode instance.
   *
   * Gathered from the OpenCode provider/model list. When `undefined`, model
   * availability filtering is skipped and any declared model is accepted.
   */
  availableModels?: Set<string>;

  /**
   * The model currently selected in the OpenCode UI, if the adapter can
   * supply one.
   *
   * Passed as `uiSelectedModel` to `resolveAdapterModelIntent()`. Ignored for
   * `subagent` mode agents (per engine resolution rules).
   */
  uiSelectedModel?: string;

  /**
   * The harness/system default model.
   *
   * Passed as `systemDefault` to `resolveAdapterModelIntent()`. Used when no
   * agent preference, category preference, or UI selection is available.
   */
  systemDefault?: string;
}

// ---------------------------------------------------------------------------
// Primary export
// ---------------------------------------------------------------------------

/**
 * Resolve the model for a single agent descriptor using OpenCode model context.
 *
 * Calls `resolveAdapterModelIntent()` with the adapter-provided context and
 * applies the fail-fast rule for explicit subagent model intent.
 *
 * ## Fail-fast rule
 *
 * When `descriptor.mode === "subagent"` and `descriptor.models` is non-empty,
 * the first declared model must be present in `context.availableModels`. If it
 * is not, this function returns `err(ModelNotAvailableError)`.
 *
 * This rule only applies when `context.availableModels` is defined. When the
 * available model set is unknown (undefined), the declared model is accepted
 * without availability filtering.
 *
 * @param descriptor - The normalized agent descriptor from the engine.
 * @param context - Adapter-provided OpenCode model context.
 * @returns `ok(resolvedModel)` on success, or `err(ModelResolutionError)` when
 *   explicit subagent model intent cannot be satisfied.
 */
export function resolveModelForAgent(
  descriptor: AgentDescriptor,
  context: OpenCodeModelContext,
): Result<string, ModelResolutionError> {
  const input: ModelResolutionInput = {
    agentName: descriptor.name,
    agentMode: descriptor.mode,
    agentModels: descriptor.models.length > 0 ? descriptor.models : undefined,
    uiSelectedModel: context.uiSelectedModel,
    systemDefault: context.systemDefault,
    availableModels: context.availableModels,
  };

  // Apply fail-fast rule: explicit subagent model intent must be satisfiable.
  if (
    descriptor.mode === "subagent" &&
    descriptor.models.length > 0 &&
    context.availableModels !== undefined
  ) {
    const firstDeclared = descriptor.models[0];
    if (
      firstDeclared !== undefined &&
      !context.availableModels.has(firstDeclared)
    ) {
      return err({
        type: "ModelNotAvailableError",
        agentName: descriptor.name,
        requestedModels: descriptor.models,
        availableModels: [...context.availableModels],
        message:
          `Agent "${descriptor.name}" declares model "${firstDeclared}" but it is not ` +
          `available in the current OpenCode instance. ` +
          `Available models: ${[...context.availableModels].join(", ") || "(none)"}. ` +
          `Update the agent's model preference or ensure the model is enabled in OpenCode.`,
      });
    }
  }

  const resolved = resolveAdapterModelIntent(input);
  return ok(resolved.model);
}
