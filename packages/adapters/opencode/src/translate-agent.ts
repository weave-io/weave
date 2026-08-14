/**
 * Translates a Weave `AgentDescriptor` into an OpenCode `AgentConfig`.
 *
 * This module is the single place where normalized Weave agent intent is
 * converted to the concrete shape expected by the OpenCode SDK. All
 * harness-specific field names and structural decisions live here.
 *
 * Boundary rule: this module imports SDK types only through `./sdk-types` and
 * tool-policy mapping only through `./tool-policy-mapping`. It must not import
 * directly from `@opencode-ai/sdk`.
 */

import {
  type AgentDescriptor,
  providerFastActivationState,
} from "@weaveio/weave-engine";
import { ok, type Result } from "neverthrow";

import type { OpenCodeAgentConfig } from "./sdk-types.js";
import { mapToolPolicy } from "./tool-policy-mapping.js";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Discriminated union of errors that `translateAgent` can return.
 *
 * Currently only one variant exists; the union is defined as a type alias so
 * future variants can be added without breaking callers.
 */
export type TranslateAgentError = {
  type: "TranslateAgentError";
  agentName: string;
  message: string;
};

// ---------------------------------------------------------------------------
// Provider acceleration (`fast true`) intent
// ---------------------------------------------------------------------------

/**
 * Bounded, sanitized report for the optional `provider-fast-activation`
 * capability in the OpenCode adapter.
 *
 * The report carries only neutral enum tokens. It never carries provider
 * names, model text, payload fragments, headers, or credentials.
 */
export type OpenCodeFastActivationReport = {
  readonly capability: "provider-fast-activation";
  /** Neutral acceleration state. OpenCode can only reach `unsupported`. */
  readonly state: "unsupported";
  /** Fixed reason code from the acceleration contract's bounded list. */
  readonly reason: "response-proof-unavailable";
  /** No official response-evidence field is readable through this harness. */
  readonly evidenceKind: "none";
  /** The evidence the provider contract requires cannot be reached. */
  readonly evidenceOutcome: "inaccessible";
};

const FAST_ACTIVATION_UNSUPPORTED: OpenCodeFastActivationReport = Object.freeze(
  {
    capability: "provider-fast-activation",
    state: "unsupported",
    reason: "response-proof-unavailable",
    evidenceKind: "none",
    evidenceOutcome: "inaccessible",
  } as const,
);

/**
 * Report the truthful acceleration state for one descriptor.
 *
 * OpenCode's public plugin contract exposes request mutation (`chat.params`
 * and `chat.headers`) but no correlated official response-body evidence
 * (`service_tier` for OpenAI, `usage.speed` for Anthropic). The acceleration
 * contract therefore forbids `requested` or `applied` here: the adapter sends
 * no provider acceleration control at all and reports `unsupported`.
 *
 * @param descriptor - Source of the neutral `fast` intent. Only the literal
 *   `true` counts as a declaration.
 * @returns `undefined` when there is no `fast true` intent — absence must emit
 *   no acceleration state — or the frozen unsupported report.
 *
 * @see docs/specs/fast-provider-acceleration-contract.md
 */
export function describeFastActivation(descriptor: {
  readonly fast?: true;
}): OpenCodeFastActivationReport | undefined {
  const state = providerFastActivationState({
    fast: descriptor.fast === true ? true : undefined,
    status: "unsupported",
  });

  return state === undefined ? undefined : FAST_ACTIVATION_UNSUPPORTED;
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/**
 * Translates a normalized Weave `AgentDescriptor` into an OpenCode
 * `AgentConfig` object suitable for writing into an OpenCode configuration
 * file or passing to the SDK client.
 *
 * Translation rules:
 * - `composedPrompt` → `prompt`
 * - `resolvedModel` → `model` (pre-validated by `resolveModelForAgent()`; when
 *   `undefined` the model field is omitted and OpenCode uses its own default)
 * - `temperature` → `temperature` (passed through when defined)
 * - `description` → `description` (passed through when defined)
 * - `mode` → `mode`
 * - `effectiveToolPolicy` → `permission` + optional `tools` patch via
 *   `mapToolPolicy`
 *
 * Neutral `fast true` intent is deliberately NOT translated. OpenCode has no
 * documented agent-config acceleration field, and a materialized config is not
 * proof of per-request acceleration. Callers read the truthful state through
 * `describeFastActivation()` instead.
 *
 * @param descriptor - The fully composed agent descriptor from the engine.
 * @param resolvedModel - The pre-validated model string from
 *   `resolveModelForAgent()`. Pass `undefined` to omit the model field.
 * @returns `ok(OpenCodeAgentConfig)` on success, or
 *   `err(TranslateAgentError)` when the descriptor cannot be translated.
 */
export function translateAgent(
  descriptor: AgentDescriptor,
  resolvedModel?: string,
): Result<OpenCodeAgentConfig, TranslateAgentError> {
  const { permission, tools: toolsPatch } = mapToolPolicy(
    descriptor.effectiveToolPolicy,
  );

  const config: OpenCodeAgentConfig = {
    prompt: descriptor.composedPrompt,
    mode: descriptor.mode,
    permission,
  };

  // model: use the pre-validated resolved model when provided
  if (resolvedModel !== undefined) {
    config.model = resolvedModel;
  }

  // temperature: pass through when declared
  if (descriptor.temperature !== undefined) {
    config.temperature = descriptor.temperature;
  }

  // description: pass through when declared
  if (descriptor.description !== undefined) {
    config.description = descriptor.description;
  }

  // tools: merge read-class tool overrides when the read capability is denied
  if (toolsPatch !== undefined) {
    config.tools = toolsPatch;
  }

  return ok(config);
}
