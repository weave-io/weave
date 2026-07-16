/**
 * Review variant fan-out executor for the OpenCode adapter.
 *
 * Executes a set of review variant agents in parallel via the
 * `OpenCodeClientFacade` session API and returns results compatible with
 * `ReviewOrchestrator.collate()`.
 *
 * Design notes:
 * - All variants run in parallel via `Promise.allSettled`.
 * - Individual variant failures are captured as `success: false` entries and
 *   do NOT propagate to the top-level `ResultAsync` error channel.
 * - Session cleanup (`deleteSession`) is best-effort: a cleanup failure is
 *   logged but does not cause the variant to be marked as failed.
 * - Only a catastrophic infrastructure failure that prevents all variants from
 *   even starting should return `err(ReviewFanOutAdapterError)`. If at least
 *   one variant ran (even if it failed), `ok(results)` is returned.
 */

import type {
  ReviewExecutionResult,
  ReviewFanOutAdapterError,
  ReviewVariantDescriptor,
} from "@weaveio/weave-engine";
import { logger } from "@weaveio/weave-engine";
import { errAsync, ResultAsync } from "neverthrow";

import type { OpenCodeClientFacade } from "./opencode-client.js";

const log = logger.child({ module: "execute-review-variants" });

// ---------------------------------------------------------------------------
// Core execution
// ---------------------------------------------------------------------------

/**
 * Executes a single review variant against a new OpenCode session.
 *
 * 1. Creates a session via `client.createReviewSession(variantName)`.
 * 2. Prompts the session with the review prompt.
 * 3. Deletes the session (best-effort cleanup).
 * 4. Returns a `ReviewExecutionResult` with success or failure information.
 *
 * This function never rejects — all error paths produce a `success: false`
 * result entry.
 */
async function executeOneVariant(
  variant: ReviewVariantDescriptor,
  client: OpenCodeClientFacade,
  reviewPrompt: string,
): Promise<ReviewExecutionResult> {
  const { variantName, reviewModel } = variant;
  log.info({ variantName, reviewModel }, "Starting review variant execution");

  // Step 1: Create session
  const sessionResult = await client.createReviewSession(variantName);

  if (sessionResult.isErr()) {
    const error = sessionResult.error;
    log.warn(
      { variantName, reviewModel, errorType: error.type },
      "Failed to create review session for variant",
    );
    return {
      variantName,
      reviewModel,
      success: false,
      errorMessage: "Session creation failed",
    };
  }

  const { sessionId } = sessionResult.value;
  log.info({ variantName, reviewModel }, "Created review session");

  let promptResult: Awaited<ReturnType<typeof client.promptSession>>;
  try {
    // Step 2: Prompt session — wrapped in try/catch so any unexpected
    // throw (e.g. from a defective mock or SDK regression) becomes a
    // per-variant failure rather than propagating out of executeOneVariant.
    promptResult = await client.promptSession(
      sessionId,
      reviewPrompt,
      variantName,
    );
  } catch (_thrown) {
    log.warn(
      { variantName, reviewModel, errorType: "UnexpectedThrow" },
      "Unexpected throw during promptSession — treating as variant failure",
    );
    // Best-effort cleanup
    await client.deleteSession(sessionId).then(undefined, () => undefined);
    return {
      variantName,
      reviewModel,
      success: false,
      errorMessage: "Unexpected error during review prompt",
    };
  }

  // Step 3: Cleanup (best-effort)
  const cleanupResult = await client.deleteSession(sessionId);
  if (cleanupResult.isErr()) {
    log.warn(
      {
        variantName,
        reviewModel,
        errorType: cleanupResult.error.type,
      },
      "Failed to delete review session (best-effort cleanup failure, ignoring)",
    );
  } else {
    log.debug({ variantName, reviewModel }, "Deleted review session");
  }

  // Step 4: Map prompt result
  if (promptResult.isErr()) {
    const error = promptResult.error;
    log.warn(
      { variantName, reviewModel, errorType: error.type },
      "Review variant prompt failed",
    );
    return {
      variantName,
      reviewModel,
      success: false,
      errorMessage: "Review prompt failed",
    };
  }

  const { output } = promptResult.value;
  log.info(
    { variantName, reviewModel, outputLength: output.length },
    "Review variant completed successfully",
  );
  return { variantName, reviewModel, success: true, output };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Executes review variant agents in parallel via the OpenCode session API.
 *
 * All variants run concurrently via `Promise.allSettled`. Individual variant
 * failures are captured as `success: false` entries and do not propagate to
 * the top-level error channel. Only an infrastructure failure that prevents
 * any variants from running returns `err(ReviewFanOutAdapterError)`.
 *
 * @param variants - Normalized variant descriptors produced by the engine.
 * @param client - The `OpenCodeClientFacade` to use for session operations.
 * @param reviewPrompt - The composed review prompt text to send to each variant.
 * @returns A `ResultAsync` resolving to an array of per-variant results.
 */
export function executeReviewVariants(
  variants: ReviewVariantDescriptor[],
  client: OpenCodeClientFacade,
  reviewPrompt: string,
): ResultAsync<ReviewExecutionResult[], ReviewFanOutAdapterError> {
  if (!reviewPrompt.trim()) {
    log.error(
      { variantCount: variants.length },
      "Review prompt is empty — cannot execute review variants",
    );
    return errAsync({
      type: "ReviewFanOutSpawnError",
      variantName: "(all)",
      message: "Review prompt is empty or blank",
      cause: "reviewPrompt must be non-empty",
    });
  }

  log.info(
    { variantCount: variants.length },
    "Executing review variants in parallel",
  );

  return ResultAsync.fromPromise(
    Promise.allSettled(
      variants.map((variant) =>
        executeOneVariant(variant, client, reviewPrompt),
      ),
    ),
    (_cause): ReviewFanOutAdapterError => ({
      type: "ReviewFanOutSpawnError",
      variantName: "(all)",
      message: "Catastrophic failure: Promise.allSettled itself rejected",
      cause: "Promise.allSettled rejected unexpectedly",
    }),
  ).map((settled) => {
    const results: ReviewExecutionResult[] = settled.map((outcome, index) => {
      if (outcome.status === "fulfilled") {
        return outcome.value;
      }
      // Promise.allSettled should not produce rejections since executeOneVariant
      // never throws, but handle defensively.
      const variant = variants[index];
      const variantName = variant?.variantName ?? `variant[${index}]`;
      const reviewModel = variant?.reviewModel ?? "unknown";
      log.error(
        {
          variantName,
          reviewModel,
          errorType: "UnexpectedVariantRejection",
        },
        "Unexpected rejection from executeOneVariant (should never happen)",
      );
      return {
        variantName,
        reviewModel,
        success: false as const,
        errorMessage: "Unexpected review variant failure",
      };
    });

    log.info(
      {
        total: results.length,
        succeeded: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
      },
      "Review variant fan-out complete",
    );

    return results;
  });
}
