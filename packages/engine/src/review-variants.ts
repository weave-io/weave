import type { AgentConfig, WeaveConfig } from "@weaveio/weave-core";
import { err, ok, type Result } from "neverthrow";

/** Error raised when an explicit agent collides with a generated review variant. */
export type ReviewVariantConflictError = {
  type: "ReviewVariantConflictError";
  /** The conflicting agent name, e.g. "weft-review-openai-gpt-5". */
  variantName: string;
  /** The source agent name, e.g. "weft". */
  agentName: string;
  /** The review model that produced this variant. */
  reviewModel: string;
  /** Human-readable remediation guidance. */
  message: string;
};

export interface GeneratedReviewVariant {
  config: AgentConfig;
  /** The source agent name this variant was generated from. */
  sourceAgentName: string;
  /** The single review model assigned to this variant. */
  reviewModel: string;
}

/**
 * Derive a deterministic variant agent name from an agent name and a review model.
 *
 * Any character that is not a valid `.weave` identifier character (`[a-zA-Z0-9_-]`)
 * is replaced with a hyphen so the result is safe for use as an agent key.
 * This covers slashes, dots, colons, and any other separator a model identifier
 * may contain (e.g. `openai/gpt-5` → `openai-gpt-5`, `org.model:v2` → `org-model-v2`).
 *
 * @example
 * reviewVariantName("weft", "openai/gpt-5")      // → "weft-review-openai-gpt-5"
 * reviewVariantName("weft", "org.model:v2")       // → "weft-review-org-model-v2"
 */
export function reviewVariantName(agentName: string, model: string): string {
  const safeModel = model.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `${agentName}-review-${safeModel}`;
}

/**
 * Generate review variant agent descriptors from the merged WeaveConfig.
 *
 * For each agent that declares `review_models`, one variant descriptor is
 * produced per model. Each variant:
 * - inherits prompt, temperature, and tool_policy from the source agent
 * - has `models` set to the single review model
 * - has `mode` forced to `"subagent"`
 * - has `tool_policy` coerced to read-only (`read: "allow"`, all others `"deny"`)
 *
 * Returns `err(ReviewVariantConflictError)` when a would-be variant name
 * collides with an explicitly declared agent in the config. Callers must handle
 * this error before materialising agents through an adapter.
 */
export function generateReviewVariants(
  config: WeaveConfig,
): Result<Record<string, GeneratedReviewVariant>, ReviewVariantConflictError> {
  const result: Record<string, GeneratedReviewVariant> = {};

  for (const [agentName, agent] of Object.entries(config.agents)) {
    if (!agent.review_models || agent.review_models.length === 0) continue;
    if (config.disabled.agents.includes(agentName)) continue;

    for (const reviewModel of agent.review_models) {
      const variantName = reviewVariantName(agentName, reviewModel);

      if (config.agents[variantName] !== undefined) {
        return err({
          type: "ReviewVariantConflictError",
          variantName,
          agentName,
          reviewModel,
          message:
            `Agent "${variantName}" is explicitly declared and would also be ` +
            `generated as a review variant of "${agentName}" for model "${reviewModel}". ` +
            "Remove the explicit agent declaration or rename the agent.",
        });
      }

      if (result[variantName] !== undefined) {
        return err({
          type: "ReviewVariantConflictError",
          variantName,
          agentName,
          reviewModel,
          message:
            `Review variant name "${variantName}" would be generated more than once. ` +
            `Two agents produce the same variant name for model "${reviewModel}". ` +
            "Ensure no two agents produce the same variant name.",
        });
      }

      if (config.disabled.agents.includes(variantName)) continue;

      const readOnlyPolicy = {
        read: "allow" as const,
        write: "deny" as const,
        execute: "deny" as const,
        delegate: "deny" as const,
        network: "deny" as const,
      };

      result[variantName] = {
        config: {
          ...agent,
          name: variantName,
          mode: "subagent",
          models: [reviewModel],
          tool_policy: readOnlyPolicy,
          // Strip review_models from the variant — it should not recurse.
          review_models: undefined,
        },
        sourceAgentName: agentName,
        reviewModel,
      };
    }
  }

  return ok(result);
}
