import type { ResultAsync } from "neverthrow";
import type { AgentDescriptor } from "./compose.js";
import type { ReviewExecutionResult } from "./review-orchestration.js";
import type { SkillInfo } from "./skill-resolution.js";

// ---------------------------------------------------------------------------
// Review fan-out types
// ---------------------------------------------------------------------------

/**
 * A single variant descriptor passed to `spawnReviewVariants`.
 *
 * Carries the normalized agent name, the full agent descriptor (prompt,
 * model, tool-policy, etc.), and the review model resolved for this variant.
 * Adapters use these fields to materialise and execute the variant agent in
 * the target harness.
 */
export type ReviewVariantDescriptor = {
  /** Logical variant name (e.g. `"weft-review-openai-gpt-5"`). */
  variantName: string;
  /** Full normalized agent descriptor produced by the engine. */
  descriptor: AgentDescriptor;
  /** The concrete model this variant should use for review. */
  reviewModel: string;
};

/**
 * Typed error returned by `spawnReviewVariants`.
 *
 * Adapters must not throw — all failure paths must be captured in the
 * returned `ResultAsync` using one of these variants.
 */
export type ReviewFanOutAdapterError =
  | {
      type: "ReviewFanOutSpawnError";
      variantName: string;
      message: string;
      cause?: string;
    }
  | {
      type: "ReviewFanOutUnsupportedError";
      message: string;
    };

/**
 * The `HarnessAdapter` interface abstracts harness-specific materialisation
 * behind a uniform contract. Each supported agent harness (OpenCode, Pi,
 * Claude Code, …) ships its own implementation of this interface.
 *
 * Boundary rule: the engine may pass normalized Weave intent through this
 * interface, but it must not make harness-specific assumptions such as where
 * skills live, how lifecycle hooks are registered, or how selected model state
 * is queried. Adapters own those details and provide explicit context to engine
 * composition helpers.
 */
export interface HarnessAdapter {
  /**
   * Perform any one-time initialisation required by the harness before
   * normalized Weave intent can be materialised. Called exactly once by the
   * bootstrap entry point before any other adapter method (see
   * `docs/adapter-bootstrap.md`).
   */
  init(): Promise<void>;

  /**
   * Materialise a new sub-agent from the provided normalized descriptor.
   *
   * The adapter owns concrete harness translation (display names, prompt/model
   * fields, tool names, and feature-gap emulation).
   *
   * Returns `ok(undefined)` on success or `err(error)` on failure. Adapters
   * must not throw — all failure paths must be captured in the returned
   * `ResultAsync`.
   *
   * @param descriptor - Full normalized agent descriptor to materialise.
   */
  spawnSubagent(descriptor: AgentDescriptor): ResultAsync<void, Error>;

  /**
   * Return the list of skills available in this harness instance.
   *
   * The engine calls this once during the bootstrap sequence — after `init()`
   * and before agent materialisation (see `docs/adapter-bootstrap.md`) — to
   * obtain the adapter-provided skill context used for skill resolution. The
   * engine matches each agent's declared
   * `skills [...]` entries against `SkillInfo.name` values in the returned
   * list.
   *
   * Adapters own all discovery: filesystem scanning, scope resolution, content
   * loading, and harness-specific mounting details. The engine only uses
   * `SkillInfo.name` for matching; all other fields are adapter-owned
   * pass-through metadata preserved in `ResolvedSkill.skillInfo`.
   *
   * Return an empty array when no skills are available or when the harness does
   * not support skills.
   */
  loadAvailableSkills(): Promise<SkillInfo[]>;

  /**
   * Execute a parallel fan-out of review variant agents and return one
   * `ReviewExecutionResult` per variant.
   *
   * This method is **optional**. Adapters that do not support parallel review
   * execution may omit it; callers should check for its presence before
   * invoking it and degrade gracefully (e.g. fall back to sequential
   * execution or skip multi-model review).
   *
   * Adapters are responsible for spawning or dispatching each variant agent
   * in the target harness, collecting its output, and returning a result
   * record for every variant — including failed ones. A partial-failure
   * (some variants succeed, some fail) must still return `ok(results)` so
   * that `ReviewOrchestrator.collate()` can produce per-variant warnings.
   * Only a fatal infrastructure error that prevents _all_ variants from being
   * attempted should return `err(ReviewFanOutAdapterError)`.
   *
   * Adapters must not throw — all failure paths must be captured in the
   * returned `ResultAsync`.
   *
   * @param variants - One descriptor per review variant to spawn.
   * @param reviewPrompt - The rendered review prompt text to send to each variant agent.
   */
  spawnReviewVariants?(
    variants: ReviewVariantDescriptor[],
    reviewPrompt: string,
  ): ResultAsync<ReviewExecutionResult[], ReviewFanOutAdapterError>;
}
