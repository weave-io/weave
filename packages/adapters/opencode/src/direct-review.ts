/**
 * Direct review execution path for the OpenCode adapter.
 *
 * When a reviewer agent with `review_models` is invoked directly (outside a
 * workflow gate), this module fans out to one variant per review model, runs
 * them in parallel, collates the results, and returns the combined review.
 *
 * ## Flow
 *
 * 1. `ReviewOrchestrator.fanOut(agentName)` — derive variant descriptors
 * 2. Map `GeneratedReviewVariant` entries to `ReviewVariantDescriptor[]`
 * 3. `executeReviewVariants(variants, client, reviewPrompt)` — parallel execution
 * 4. `ReviewOrchestrator.collate(results)` — aggregate into `CollatedReview`
 *
 * @see packages/adapters/opencode/src/execute-review-variants.ts
 * @see packages/engine/src/review-orchestration.ts
 * @see docs/adapter-boundary.md
 */

import type { WeaveConfig } from "@weaveio/weave-core";
import type {
  CollatedReview,
  ReviewVariantDescriptor,
} from "@weaveio/weave-engine";
import {
  evaluateEffectiveToolPolicy,
  logger,
  ReviewOrchestrator,
} from "@weaveio/weave-engine";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";

import { executeReviewVariants } from "./execute-review-variants.js";
import type { OpenCodeClientFacade } from "./opencode-client.js";
import { formatReviewSummary } from "./projection-helpers.js";

const log = logger.child({ module: "direct-review" });

// ---------------------------------------------------------------------------
// DirectReviewResult
// ---------------------------------------------------------------------------

/**
 * The successful result of `executeDirectReview`.
 *
 * The formatted summary is returned to the caller. In the OpenCode plugin,
 * the caller can inject it into the session via the agent's response, or
 * display it via a toast/log. The adapter does not own session I/O for
 * direct review results; the plugin entry point or command handler does.
 */
export interface DirectReviewResult {
  readonly collatedReview: CollatedReview;
  readonly formattedSummary: string;
}

// ---------------------------------------------------------------------------
// DirectReviewError
// ---------------------------------------------------------------------------

/**
 * Discriminated union of errors that `executeDirectReview` can return.
 *
 * - `FanOutPlanError` — `ReviewOrchestrator.fanOut` failed (agent not found,
 *   conflict, or no `review_models` declared).
 * - `ExecutionError` — `executeReviewVariants` returned an infrastructure
 *   error during parallel session execution.
 * - `CollationError` — all variants failed; `ReviewOrchestrator.collate`
 *   returned an error (typically `CollatedReviewAllFailedError`).
 */
export type DirectReviewError =
  | { type: "FanOutPlanError"; message: string }
  | { type: "ExecutionError"; message: string }
  | { type: "CollationError"; message: string };

// ---------------------------------------------------------------------------
// executeDirectReview
// ---------------------------------------------------------------------------

/**
 * Execute a direct review for the named agent.
 *
 * Fans out to one variant per `review_models` entry, runs them in parallel via
 * the provided `OpenCodeClientFacade`, collates the results, and returns the
 * combined `CollatedReview`.
 *
 * This is a separate entry point from the workflow gate path. It does not
 * replace `spawnSubagent`; adapters and plugins call it when a reviewer agent
 * is invoked directly rather than through a workflow step.
 *
 * @param agentName - Logical name of the reviewer agent (must declare `review_models`).
 * @param config - The resolved `WeaveConfig` containing the agent definition.
 * @param client - Live `OpenCodeClientFacade` used to spawn parallel sessions.
 * @param reviewPrompt - The rendered review prompt text sent to each variant.
 * @returns `ok(DirectReviewResult)` on success, `err(DirectReviewError)` on failure.
 */
export function executeDirectReview(
  agentName: string,
  config: WeaveConfig,
  client: OpenCodeClientFacade,
  reviewPrompt: string,
): ResultAsync<DirectReviewResult, DirectReviewError> {
  // Step 1: fan out to get variant plan
  const planResult = new ReviewOrchestrator(config).fanOut(agentName);

  if (planResult.isErr()) {
    const fanOutErr = planResult.error;
    const message =
      "message" in fanOutErr
        ? fanOutErr.message
        : `ReviewOrchestrator.fanOut failed for agent "${agentName}"`;
    log.error(
      { agentName, err: fanOutErr },
      "Direct review fan-out plan generation failed",
    );
    return errAsync({ type: "FanOutPlanError", message });
  }

  const plan = planResult.value;

  // Step 2: map GeneratedReviewVariant entries to ReviewVariantDescriptor[]
  const variants: ReviewVariantDescriptor[] = Object.entries(plan.variants).map(
    ([key, v]) => ({
      variantName: v.config.name ?? key,
      descriptor: {
        name: v.config.name ?? key,
        description: v.config.description,
        displayName: v.config.display_name,
        composedPrompt: v.config.prompt ?? "",
        models: v.config.models ?? [],
        mode: v.config.mode ?? "subagent",
        temperature: v.config.temperature,
        effectiveToolPolicy: evaluateEffectiveToolPolicy(v.config.tool_policy),
        rawToolPolicy: v.config.tool_policy,
        delegationTargets: [],
        skills: v.config.skills ?? [],
      },
      reviewModel: v.reviewModel,
    }),
  );

  log.info(
    { agentName, variantCount: variants.length },
    "Direct review — starting parallel variant execution",
  );

  // Step 3: run variants in parallel
  return executeReviewVariants(variants, client, reviewPrompt)
    .mapErr((execErr): DirectReviewError => {
      const message = `executeReviewVariants failed for agent "${agentName}": ${execErr.message}`;
      log.error({ agentName, errorType: execErr.type }, message);
      return { type: "ExecutionError", message };
    })
    .andThen((results) => {
      // Step 4: collate results
      const collated = ReviewOrchestrator.collate(results);

      if (collated.isErr()) {
        const collationErr = collated.error;
        const message =
          "message" in collationErr
            ? collationErr.message
            : `All review variants failed for agent "${agentName}"`;
        log.error(
          { agentName, err: collationErr },
          "Direct review collation failed",
        );
        return errAsync({ type: "CollationError" as const, message });
      }

      const review = collated.value;
      log.info(
        {
          agentName,
          variantCount: review.perVariantVerdicts.length,
          gateDecision: review.gateDecision.passed,
        },
        "Direct review completed",
      );

      const formattedSummary = formatReviewSummary(review);
      return okAsync({ collatedReview: review, formattedSummary });
    });
}
