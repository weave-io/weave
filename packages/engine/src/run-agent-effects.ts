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
import type { AgentDescriptor } from "./compose.js";
import type { EffectiveToolPolicy } from "./tool-policy.js";

// ---------------------------------------------------------------------------
// RunAgentEffect discriminated union
// ---------------------------------------------------------------------------

/**
 * Sanitized metadata about the rendered step prompt.
 *
 * Carries only structural information — never the raw prompt text.
 * Adapters may use `byteLength` for telemetry or size-limit enforcement.
 *
 * Security invariant: raw prompt content is never stored in effects.
 */
export interface PromptMetadata {
  /** Byte length of the rendered prompt (UTF-8). */
  readonly byteLength: number;
}

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
 * - `agentDescriptor` — the fully composed descriptor passed to the adapter.
 * - `resolvedSkills` — the ordered list of skill names resolved for this agent
 *   from adapter-provided available skills, after disabled-skill filtering.
 *   Contains only skill names — no adapter-owned paths, content, or metadata.
 *   Empty array when the agent declares no skills or all declared skills are
 *   disabled.
 * - `completionMethod` — the expected completion method for this step (from
 *   `WorkflowStep.completion.method`). Present when dispatched from a
 *   configured workflow step; absent for legacy/fallback dispatch.
 * - `stepType` — the interaction intent of the step (`"autonomous"`,
 *   `"interactive"`, or `"gate"`). Present when dispatched from a configured
 *   workflow step; absent for legacy/fallback dispatch.
 * - `correlationId` — a UUID generated at dispatch time for correlating this
 *   effect with downstream events (session observations, step completions).
 *   Present when dispatched from a configured workflow step.
 * - `promptMetadata` — sanitized structural metadata about the rendered prompt.
 *   Never contains raw prompt text. Present when a step prompt was rendered.
 */
export type RunAgentEffect = {
  readonly kind: "run-agent";
  readonly agentName: string;
  readonly agentDescriptor: AgentDescriptor;
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
  /**
   * Expected completion method for this step.
   * Present when dispatched from a configured workflow step.
   */
  readonly completionMethod?: string;
  /**
   * Interaction intent of the step.
   * Present when dispatched from a configured workflow step.
   */
  readonly stepType?: "autonomous" | "interactive" | "gate";
  /**
   * Correlation ID (UUID) generated at dispatch time.
   * Present when dispatched from a configured workflow step.
   */
  readonly correlationId?: string;
  /**
   * Sanitized structural metadata about the rendered step prompt.
   * Never contains raw prompt text.
   * Present when a step prompt was rendered.
   */
  readonly promptMetadata?: PromptMetadata;
};
