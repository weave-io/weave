/**
 * Claude Code model resolution context.
 *
 * Provides a static model registry and helper to build `ModelResolutionInput`
 * for the engine's `resolveAdapterModelIntent()`.
 */

import type {
  AgentDescriptor,
  ModelResolutionInput,
  ProviderFastActivationStatus,
} from "@weaveio/weave-engine";
import {
  PROVIDER_FAST_ACTIVATION_ID,
  parseModelIntentEntry,
  providerFastActivationState,
} from "@weaveio/weave-engine";

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
 * Thinking-level intent is validated by core and stripped here because the
 * current Claude Code adapter has no host-controllable activation surface.
 */
export function buildClaudeCodeModelInput(
  descriptor: AgentDescriptor,
): ModelResolutionInput {
  return {
    agentName: descriptor.name,
    agentMode: descriptor.mode,
    agentModels:
      descriptor.models.length > 0
        ? descriptor.models.map((entry) => {
            const parsed = parseModelIntentEntry(entry);
            if (parsed.isErr()) return entry;

            // Claude Code has no host-controlled thinking-level activation;
            // intentionally ignore the extracted level after stripping it.
            return parsed.value.baseModel;
          })
        : undefined,
    categoryModels: descriptor.category
      ? undefined // Category models are already merged into descriptor.models by the engine
      : undefined,
    availableModels: CLAUDE_CODE_AVAILABLE_MODELS,
  };
}

/**
 * Fixed reason code for Claude Code provider acceleration.
 *
 * Claude Code's native fast controls (`/fast`, Agent SDK `settings.fastMode`)
 * live outside this adapter's static file-materialization surface. Subagent
 * frontmatter has no acceleration field, and no materialized artifact can
 * observe the provider's `usage.speed` response proof for one attempt.
 */
export const CLAUDE_CODE_FAST_UNSUPPORTED_REASON =
  "harness-seam-unavailable" as const;

/** Bounded, sanitized acceleration diagnostic for one descriptor. */
export interface ClaudeCodeFastActivationDiagnostic {
  readonly capabilityId: typeof PROVIDER_FAST_ACTIVATION_ID;
  readonly adapterId: "claude-code";
  readonly state: ProviderFastActivationStatus;
  readonly evidenceKind: "none";
  readonly evidenceOutcome: "inaccessible";
  readonly reason: typeof CLAUDE_CODE_FAST_UNSUPPORTED_REASON;
}

/**
 * Resolves the acceleration state for a descriptor under static materialization.
 *
 * Returns `undefined` when the descriptor carries no acceleration intent, so
 * absence of `fast true` emits no state at all. A declared intent always
 * resolves to `unsupported`: this adapter owns no request-mutation seam and no
 * per-attempt response-evidence seam, so it must never report `requested` or
 * `applied`. The returned record carries only bounded enum tokens — no model
 * text, provider text, prompt, path, or harness object.
 *
 * This mirrors the `model-thinking-activation` precedent: the validated intent
 * is honestly dropped, the capability contract declares the gap, and agent
 * materialization continues unchanged.
 */
export function describeClaudeCodeFastActivation(descriptor: {
  readonly fast?: true;
}): ClaudeCodeFastActivationDiagnostic | undefined {
  const state = providerFastActivationState({
    fast: descriptor.fast === true ? true : undefined,
    status: "unsupported",
  });
  if (state === undefined) return undefined;

  return Object.freeze({
    capabilityId: PROVIDER_FAST_ACTIVATION_ID,
    adapterId: "claude-code",
    state,
    evidenceKind: "none",
    evidenceOutcome: "inaccessible",
    reason: CLAUDE_CODE_FAST_UNSUPPORTED_REASON,
  });
}
