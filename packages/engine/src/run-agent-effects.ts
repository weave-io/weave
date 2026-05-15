/**
 * Observable effects emitted by the Weave engine during agent materialisation.
 *
 * Effects are pure data records — they carry no side effects themselves.
 * Callers receive them via the optional `onEffect` callback on
 * `WeaveRunnerOptions` and may use them for logging, telemetry, testing, or
 * adapter-side policy enforcement.
 *
 * No harness-specific tool names appear here. The `effectiveToolPolicy` field
 * is engine-computed from the abstract capability vocabulary; adapters receive
 * the raw `tool_policy` unchanged via `spawnSubagent`.
 *
 * Security invariant: serialized effects must not expose adapter-owned skill
 * paths, skill contents, API keys, tokens, or `.env` values. The engine only
 * emits `ResolvedSkill.name` values — all adapter-owned metadata is excluded
 * from the effect payload.
 */

import type { ToolPolicy } from "@weave/core";
import type { EffectiveToolPolicy } from "./tool-policy.js";

// ---------------------------------------------------------------------------
// RunAgentEffect discriminated union
// ---------------------------------------------------------------------------

/**
 * Emitted once per agent immediately before the adapter's `spawnSubagent` call.
 *
 * Fields:
 * - `agentName` — the logical agent name (key from `WeaveConfig.agents` or a
 *   generated `shuttle-{category}` name).
 * - `effectiveToolPolicy` — the fully-resolved policy computed by
 *   `evaluateEffectiveToolPolicy`. Every capability is present; missing
 *   declarations default to `DEFAULT_PERMISSION` (`"ask"`).
 * - `rawToolPolicy` — the raw `tool_policy` from the agent's config, or
 *   `undefined` when no `tool_policy` block was declared. Passed through to
 *   the adapter unchanged so adapters can apply harness-specific translation.
 * - `resolvedSkills` — the ordered list of skill names resolved for this agent
 *   from adapter-provided available skills, after disabled-skill filtering.
 *   Contains only skill names — no adapter-owned paths, content, or metadata.
 *   Empty array when the agent declares no skills or all declared skills are
 *   disabled.
 */
export type RunAgentEffect = {
  readonly kind: "run-agent";
  readonly agentName: string;
  readonly effectiveToolPolicy: EffectiveToolPolicy;
  readonly rawToolPolicy: ToolPolicy | undefined;
  /**
   * Ordered list of resolved skill names for this agent.
   *
   * Security invariant: only skill names are included. Adapter-owned metadata
   * (file paths, content, API keys, tokens, harness-specific mounting details)
   * is never emitted in this field.
   */
  readonly resolvedSkills: readonly string[];
};
