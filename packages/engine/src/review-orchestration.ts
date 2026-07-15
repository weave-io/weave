import type { AgentConfig, WeaveConfig } from "@weaveio/weave-core";
import { err, ok, type Result } from "neverthrow";
import {
  type GeneratedReviewVariant,
  generateReviewVariants,
  type ReviewVariantConflictError,
  reviewVariantName,
} from "./review-variants.js";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type ReviewOrchestrationAgentNotFoundError = {
  type: "ReviewOrchestrationAgentNotFoundError";
  agentName: string;
  message: string;
};

export type ReviewOrchestrationError =
  | ReviewOrchestrationAgentNotFoundError
  | ReviewVariantConflictError
  | CollatedReviewAllFailedError;

// ---------------------------------------------------------------------------
// Execution result types
// ---------------------------------------------------------------------------

/** The result of executing a single review variant. */
export type ReviewExecutionResult = {
  /** The variant agent name (e.g. "weft-review-openai-gpt-5"). */
  variantName: string;
  /** The review model used for this variant. */
  reviewModel: string;
  /** Whether this variant execution succeeded. */
  success: boolean;
  /** The textual output produced by this variant, if successful. */
  output?: string;
  /** An error message if the variant failed. */
  errorMessage?: string;
};

// ---------------------------------------------------------------------------
// Collated review types
// ---------------------------------------------------------------------------

export type PartialFailureWarning = {
  variantName: string;
  reviewModel: string;
  errorMessage: string;
};

/** Collated result from a fan-out review execution. */
export type CollatedReview = {
  /** Indicates overall success (at least one variant succeeded). */
  success: true;
  /** The combined output from all successful variants. */
  collatedOutput: string;
  /** Warnings for any variants that failed. */
  warnings: PartialFailureWarning[];
};

export type CollatedReviewAllFailedError = {
  type: "CollatedReviewAllFailedError";
  /** All variants that failed. */
  failures: PartialFailureWarning[];
  message: string;
};

// ---------------------------------------------------------------------------
// Fan-out plan type
// ---------------------------------------------------------------------------

/** Plan produced by `fanOut` — describes which variants to execute. */
export type ReviewFanOutPlan = {
  /** The source agent name. */
  agentName: string;
  /** The primary agent config (the source agent itself). */
  primary: { name: string; config: AgentConfig; reviewModel: null };
  /** The generated review variants keyed by variant name. */
  variants: Record<string, GeneratedReviewVariant>;
};

// ---------------------------------------------------------------------------
// ReviewOrchestrator
// ---------------------------------------------------------------------------

/**
 * Engine-level orchestrator for review fan-out and result collation.
 *
 * Responsibilities:
 * - `fanOut`: derive the set of review variant descriptors for a named agent.
 * - `collate`: accept per-variant execution results and produce a
 *   deterministic collated review, with partial-failure warnings.
 *
 * This class is harness-agnostic: it plans fan-out and processes supplied
 * outputs without executing adapters or spawning processes.
 */
export class ReviewOrchestrator {
  constructor(private readonly config: WeaveConfig) {}

  /**
   * Derive the fan-out plan for the given agent.
   *
   * Returns a plan containing the primary agent reference and all generated
   * review variant descriptors. If the agent is not found in the config, or
   * if variant generation produces a conflict, an error is returned.
   *
   * @param agentName - The logical name of the agent to fan out (e.g. `"weft"`).
   */
  fanOut(
    agentName: string,
  ): Result<ReviewFanOutPlan, ReviewOrchestrationError> {
    const agent = this.config.agents[agentName];
    if (agent === undefined) {
      return err({
        type: "ReviewOrchestrationAgentNotFoundError",
        agentName,
        message: `Agent "${agentName}" was not found in the config.`,
      } satisfies ReviewOrchestrationAgentNotFoundError);
    }

    const variantsResult = generateReviewVariants(this.config);
    if (variantsResult.isErr()) return err(variantsResult.error);

    // Collect only the variants that belong to this agent.
    const allVariants = variantsResult.value;
    const agentVariants: Record<string, GeneratedReviewVariant> = {};

    for (const [name, variant] of Object.entries(allVariants)) {
      if (variant.sourceAgentName === agentName) {
        agentVariants[name] = variant;
      }
    }

    return ok({
      agentName,
      primary: { name: agentName, config: agent, reviewModel: null },
      variants: agentVariants,
    });
  }

  /**
   * Collate per-variant execution results into a single `CollatedReview`.
   *
   * Rules:
   * - Succeeds if **at least one** variant succeeded.
   * - Adds a `PartialFailureWarning` for every variant that failed.
   * - Returns `err(CollatedReviewAllFailedError)` only if **all** variants failed.
   *
   * This method is stateless and does not use instance config — it is
   * declared as a static method so callers need not construct a
   * `ReviewOrchestrator` instance when they only need collation.
   *
   * @param results - The per-variant execution results.
   */
  static collate(
    results: ReviewExecutionResult[],
  ): Result<CollatedReview, ReviewOrchestrationError> {
    const successes = results.filter((r) => r.success);
    const failures = results.filter((r) => !r.success);

    const warnings: PartialFailureWarning[] = failures.map((f) => ({
      variantName: f.variantName,
      reviewModel: f.reviewModel,
      errorMessage: f.errorMessage ?? "Unknown error",
    }));

    if (successes.length === 0) {
      return err({
        type: "CollatedReviewAllFailedError",
        failures: warnings,
        message:
          `All ${results.length} review variant(s) failed. ` +
          "No successful output is available.",
      });
    }

    const outputParts = successes.map((r) => {
      const header = `### Review: ${r.variantName} (model: ${r.reviewModel})`;
      const body = r.output?.trim() ?? "(no output)";
      return `${header}\n\n${body}`;
    });

    const collatedOutput = outputParts.join("\n\n---\n\n");

    return ok({
      success: true,
      collatedOutput,
      warnings,
    });
  }
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/**
 * Construct a `ReviewOrchestrator` and immediately call `fanOut`.
 *
 * Thin wrapper for callers that do not need to hold an orchestrator instance.
 */
export function fanOut(
  agentName: string,
  config: WeaveConfig,
): Result<ReviewFanOutPlan, ReviewOrchestrationError> {
  return new ReviewOrchestrator(config).fanOut(agentName);
}

/**
 * Pure collation helper — delegates to the static `ReviewOrchestrator.collate`.
 *
 * Thin wrapper for callers that do not need to hold an orchestrator instance.
 */
export function collate(
  results: ReviewExecutionResult[],
): Result<CollatedReview, ReviewOrchestrationError> {
  return ReviewOrchestrator.collate(results);
}
