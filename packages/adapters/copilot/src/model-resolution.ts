/**
 * GitHub Copilot CLI model resolution context.
 *
 * Provides a static model registry and helper to build `ModelResolutionInput`
 * for the engine's `resolveAdapterModelIntent()`.
 */

import type {
  AgentDescriptor,
  ModelResolutionInput,
} from "@weaveio/weave-engine";

/**
 * Static set of models confirmed to be available through the Copilot CLI's
 * `--model` flag.
 *
 * The Copilot CLI does not expose a `--help`-listed enumeration flag for
 * `--model`, and passing an invalid value returns only an error, not a
 * candidate list (see docs/artifacts/copilot-adapter-research.md §7). The
 * only value confirmed as a real, working `--model` argument is
 * `claude-sonnet-5`, captured from the CLI's own default-model log output
 * and confirmed interactively.
 *
 * Other display names surfaced by GitHub Docs' "Supported AI models" table
 * (e.g. "Claude Opus 4.7", "Gemini 3.5 Flash") are documented product names,
 * not proven `--model` flag values, and are deliberately excluded here to
 * avoid shipping an unverified alias that could silently fail at runtime.
 *
 * Fallback behavior: if this set does not contain a match for the
 * descriptor's preferred models, the engine's `resolveAdapterModelIntent()`
 * falls back to the descriptor's first `models` entry unchanged, so an
 * empty (or minimal) set here is safe — it never blocks resolution, it only
 * disables the "confirm this model is available" optimization.
 */
export const COPILOT_AVAILABLE_MODELS: Set<string> = new Set([
  "claude-sonnet-5",
]);

/**
 * Builds a `ModelResolutionInput` from a Weave agent descriptor using
 * the Copilot CLI's static model context.
 *
 * The adapter does not currently have access to a UI-selected model or
 * system default from the Copilot CLI's runtime, so those fields are
 * omitted.
 */
export function buildCopilotModelInput(
  descriptor: AgentDescriptor,
): ModelResolutionInput {
  return {
    agentName: descriptor.name,
    agentMode: descriptor.mode,
    agentModels: descriptor.models.length > 0 ? descriptor.models : undefined,
    categoryModels: descriptor.category
      ? undefined // Category models are already merged into descriptor.models by the engine
      : undefined,
    availableModels: COPILOT_AVAILABLE_MODELS,
  };
}
