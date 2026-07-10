/**
 * Claude Code model resolution context.
 *
 * Provides a static model registry and helper to build `ModelResolutionInput`
 * for the engine's `resolveAdapterModelIntent()`.
 */

import type { AgentDescriptor } from "@weaveio/weave-engine";
import type { ModelResolutionInput } from "@weaveio/weave-engine";

/**
 * Static set of models known to be available through Claude Code.
 *
 * This is a conservative list. Claude Code may support additional models,
 * but the adapter only declares those it can confirm are available without
 * a runtime API call.
 */
export const CLAUDE_CODE_AVAILABLE_MODELS: Set<string> = new Set([
  "claude-sonnet-4-5",
  "claude-opus-4",
  "claude-haiku-3-5",
  "claude-sonnet-4-20250514",
  "claude-opus-4-20250918",
]);

/**
 * Builds a `ModelResolutionInput` from a Weave agent descriptor using
 * Claude Code's static model context.
 *
 * The adapter does not currently have access to a UI-selected model or
 * system default from Claude Code's runtime, so those fields are omitted.
 */
export function buildClaudeCodeModelInput(
  descriptor: AgentDescriptor,
): ModelResolutionInput {
  return {
    agentName: descriptor.name,
    agentMode: descriptor.mode,
    agentModels: descriptor.models.length > 0 ? descriptor.models : undefined,
    categoryModels: descriptor.category
      ? undefined // Category models are already merged into descriptor.models by the engine
      : undefined,
    availableModels: CLAUDE_CODE_AVAILABLE_MODELS,
  };
}
