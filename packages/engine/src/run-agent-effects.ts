/**
 * Observable effects emitted by the Weave engine during agent materialisation.
 *
 * Effects are pure data records — they carry no side effects themselves.
 * Callers receive them via the `onEffect` callback supplied to the bootstrap
 * entry point (see `docs/adapter-bootstrap.md`) and may use them for logging,
 * telemetry, testing, or adapter-side policy enforcement.
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

import type { CompletionMethod, ToolPolicy } from "@weaveio/weave-core";
import type { AgentDescriptor } from "./compose.js";
import type { EffectiveToolPolicy } from "./tool-policy.js";

// ---------------------------------------------------------------------------
// ReviewFanOutIntent: engine-level fan-out routing hint
// ---------------------------------------------------------------------------

/**
 * Engine-level intent record attached to a `RunAgentEffect` when the
 * dispatched step is a `gate` with `review_verdict` completion and the
 * named agent declares `review_models`.
 *
 * ## V1 gate policy
 *
 * Weave v1 uses an **"any-reject wins"** collation policy for gate steps.
 * The engine's role is limited to expressing fan-out intent; it does **not**
 * track per-review approve/reject verdicts — those are execution outputs
 * produced by variant agents and owned by the adapter layer.
 *
 * The v1 collation contract is:
 * - The engine emits `reviewFanOutIntent` to signal that fan-out is required.
 * - The adapter spawns each variant via `HarnessAdapter.spawnReviewVariants`
 *   (or equivalent) and collects their execution outputs.
 * - The adapter calls `ReviewOrchestrator.collate(results)` to aggregate
 *   outputs and warnings into a `CollatedReview`.
 * - The adapter translates the `CollatedReview` into a `StepCompletionSignal`
 *   using the v1 policy: a gate passes only when the collated outcome is
 *   successful; any failed or rejected execution causes the gate to block.
 *
 * The engine makes no claim about which specific variants approved or rejected
 * because `ReviewExecutionResult` tracks execution success/failure, not
 * typed approve/reject verdicts. Verdict semantics are adapter-owned.
 *
 * Adapters receive this intent via `RunAgentEffect.reviewFanOutIntent` and
 * are responsible for:
 * 1. Calling `ReviewOrchestrator.fanOut(agentName)` to derive variant descriptors.
 * 2. Spawning each variant via `HarnessAdapter.spawnReviewVariants` (or
 *    equivalent harness-specific mechanism).
 * 3. Calling `ReviewOrchestrator.collate(results)` and translating the
 *    collated outcome into a `StepCompletionSignal` using the v1 policy above.
 *
 * The engine does **not** execute variant spawning. It only expresses intent.
 */
export interface ReviewFanOutIntent {
  /**
   * The logical agent name to fan out (key from `WeaveConfig.agents`).
   * Adapters use this to call `ReviewOrchestrator.fanOut(agentName)`.
   */
  readonly agentName: string;
  /**
   * The `review_models` declared on the agent config.
   * Provided here as a convenience so adapters do not need to re-read the config.
   */
  readonly reviewModels: readonly string[];
}

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
  readonly completionMethod?: CompletionMethod["method"];
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
  /**
   * Review fan-out intent for gate steps with `review_verdict` completion.
   *
   * Present when ALL of the following are true:
   * - `stepType === "gate"`
   * - `completionMethod === "review_verdict"`
   * - The named agent declares `review_models` in the WeaveConfig
   *
   * When present, the adapter MUST route this step through
   * `ReviewOrchestrator.fanOut` and apply the v1 any-reject gate policy.
   * When absent, single-agent execution is used for the gate step.
   *
   * @see ReviewFanOutIntent: v1 gate policy documentation
   */
  readonly reviewFanOutIntent?: ReviewFanOutIntent;
};
