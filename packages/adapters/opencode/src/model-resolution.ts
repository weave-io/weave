/**
 * Adapter-local model resolution for the OpenCode adapter.
 *
 * This module gathers OpenCode model context (available models, UI-selected
 * model, system default) and calls `resolveAdapterModelIntent()` from
 * `@weaveio/weave-engine` to produce a validated model selection for each agent.
 *
 * ## Design
 *
 * - Model discovery is adapter-owned: this module is the only place that
 *   queries OpenCode for available models.
 * - `resolveAdapterModelIntent()` is engine-owned: it applies the priority
 *   chain (override → ui-selected → category → agent → system-default →
 *   constant-fallback) without querying harness state itself.
 * - Pi's `openai-codex` provider ID is translated to OpenCode's `openai`
 *   provider ID before availability checks and model selection.
 * - Explicit subagent model intent fails fast when the translated model is not
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
 * Boundary rule: this module imports engine types only through `@weaveio/weave-engine`
 * and SDK types only through `./sdk-types`. It must not import directly from
 * `@opencode-ai/sdk`.
 */

import type {
  AgentDescriptor,
  ModelResolutionInput,
  ThinkingLevelDecl,
} from "@weaveio/weave-engine";
import {
  parseModelIntentEntry,
  resolveAdapterModelIntent,
} from "@weaveio/weave-engine";
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
export interface OpenCodeModelResolution {
  model: string;
  thinkingLevel?: ThinkingLevelDecl;
}

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

const PI_OPENAI_CODEX_PREFIX = "openai-codex/";
const OPENCODE_OPENAI_PREFIX = "openai/";

function normalizeModelForOpenCode(model: string): string {
  if (!model.startsWith(PI_OPENAI_CODEX_PREFIX)) return model;
  return `${OPENCODE_OPENAI_PREFIX}${model.slice(PI_OPENAI_CODEX_PREFIX.length)}`;
}

/**
 * Re-encode literal hashes before passing a normalized entry to the engine.
 *
 * Core validation only lets through entries successfully parsed by
 * `parseModelIntentEntry()`. That parser can produce a literal hash only
 * after an odd backslash run, then removes one slash while unescaping it;
 * therefore every literal hash in the parsed base has an even backslash run
 * immediately before it. Adding one slash makes that run odd again, so the
 * engine parser recognizes the hash as literal and removes the added slash.
 *
 * This invariant is for validated model intent. Descriptors constructed
 * without schema validation still use the defensive fallback above and are
 * covered separately by the adapter tests.
 */
function escapeLiteralHashes(model: string): string {
  return model.replace(/#/g, "\\#");
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
 * @returns `ok({ model, thinkingLevel })` on success, or
 *   `err(ModelResolutionError)` when explicit subagent model intent cannot be
 *   satisfied.
 */
export function resolveModelForAgent(
  descriptor: AgentDescriptor,
  context: OpenCodeModelContext,
): Result<OpenCodeModelResolution, ModelResolutionError> {
  const normalizedAgentCandidates = descriptor.models.map((entry) => {
    const parsed = parseModelIntentEntry(entry);
    if (parsed.isErr()) {
      // Schema validation rejects this path; keep resolution defensive for
      // callers that construct descriptors without loading config first.
      const rawModel = normalizeModelForOpenCode(entry);
      return { baseModel: rawModel, engineEntry: rawModel };
    }

    const baseModel = normalizeModelForOpenCode(parsed.value.baseModel);
    return {
      baseModel,
      engineEntry: escapeLiteralHashes(baseModel),
      thinkingLevel: parsed.value.thinkingLevel,
    };
  });
  const normalizedAgentModels = normalizedAgentCandidates.map(
    (candidate) => candidate.engineEntry,
  );
  const input: ModelResolutionInput = {
    agentName: descriptor.name,
    agentMode: descriptor.mode,
    agentModels:
      normalizedAgentModels.length > 0 ? normalizedAgentModels : undefined,
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
    // Fail-fast must inspect the normalized base model, not the raw suffix.
    const firstNormalized = normalizedAgentCandidates[0]?.baseModel;
    if (
      firstDeclared !== undefined &&
      firstNormalized !== undefined &&
      !context.availableModels.has(firstNormalized)
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
  if (resolved.source !== "agent-preference") {
    return ok({
      model: resolved.model,
      thinkingLevel: resolved.thinkingLevel,
    });
  }

  // The engine receives base-only preferences so availability matching cannot
  // see a suffix. Reattach the level from the same ordered candidate that won.
  const winningCandidate = normalizedAgentCandidates.find(
    (candidate) => candidate.baseModel === resolved.model,
  );
  return ok({
    model: resolved.model,
    thinkingLevel: resolved.thinkingLevel ?? winningCandidate?.thinkingLevel,
  });
}
