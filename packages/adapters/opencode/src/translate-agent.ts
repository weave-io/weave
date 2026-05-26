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

import type { AgentDescriptor } from "@weave/engine";
import { err, ok, type Result } from "neverthrow";

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
// Translation
// ---------------------------------------------------------------------------

/**
 * Translates a normalized Weave `AgentDescriptor` into an OpenCode
 * `AgentConfig` object suitable for writing into an OpenCode configuration
 * file or passing to the SDK client.
 *
 * Translation rules:
 * - `composedPrompt` → `prompt`
 * - `models[0]` → `model` (first preference; OpenCode accepts a single model
 *   string per agent config entry)
 * - `temperature` → `temperature` (passed through when defined)
 * - `description` → `description` (passed through when defined)
 * - `mode` → `mode`
 * - `effectiveToolPolicy` → `permission` + optional `tools` patch via
 *   `mapToolPolicy`
 *
 * @param descriptor - The fully composed agent descriptor from the engine.
 * @returns `ok(OpenCodeAgentConfig)` on success, or
 *   `err(TranslateAgentError)` when the descriptor cannot be translated.
 */
export function translateAgent(
  descriptor: AgentDescriptor,
): Result<OpenCodeAgentConfig, TranslateAgentError> {
  const { permission, tools: toolsPatch } = mapToolPolicy(
    descriptor.effectiveToolPolicy,
  );

  const config: OpenCodeAgentConfig = {
    prompt: descriptor.composedPrompt,
    mode: descriptor.mode,
    permission,
  };

  // model: use first preference when available
  const primaryModel = descriptor.models[0];
  if (primaryModel !== undefined) {
    config.model = primaryModel;
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
