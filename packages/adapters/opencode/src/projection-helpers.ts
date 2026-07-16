/**
 * Projection Helpers — adapter-internal shared utilities.
 *
 * Provides the helpers shared across the OpenCode adapter's projection modules:
 *
 * - `buildProjectEffect` — builds the adapter-owned `projectEffect` callback
 *   that calls `adapter.spawnSubagent` for each `DispatchAgentEffect`.
 * - `translateReviewOutcome` — maps a `ReviewOrchestrator.collate` result to
 *   a gate pass (`ok(void)`) or gate block (`err(WorkflowRunnerError)`).
 * - `deriveRunWorkflowResult` — maps `ExecutionStartedData`-shaped data to
 *   the adapter-owned `RunWorkflowResult` discriminated union.
 *
 * ## Boundary rule
 *
 * This module is adapter-internal. It must not be imported by engine packages.
 * It exists solely to eliminate duplication across `run-workflow.ts`,
 * `start-plan-execution.ts`, and `runtime-command-projection.ts`.
 *
 * @see packages/adapters/opencode/src/run-workflow.ts
 * @see packages/adapters/opencode/src/start-plan-execution.ts
 * @see packages/adapters/opencode/src/runtime-command-projection.ts
 * @see docs/adapter-boundary.md
 */

import type { WeaveConfig } from "@weaveio/weave-core";
import type {
  CollatedReview,
  DispatchAgentEffect,
  GateDecision,
  ReviewOrchestrationError,
  ReviewVariantDescriptor,
  WorkflowRunnerError,
} from "@weaveio/weave-engine";
import {
  evaluateEffectiveToolPolicy,
  logger,
  ReviewOrchestrator,
} from "@weaveio/weave-engine";
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from "neverthrow";

import type { OpenCodeAdapter } from "./adapter.js";
import type { RunWorkflowResult } from "./run-workflow.js";

const log = logger.child({ module: "projection-helpers" });

// ---------------------------------------------------------------------------
// translateReviewOutcome — map collation result to gate pass/fail
// ---------------------------------------------------------------------------

/**
 * Translate a `ReviewOrchestrator.collate` result into a gate pass or block.
 *
 * - `err(ReviewOrchestrationError)` → all variants failed; log at error level,
 *   return `err(WorkflowRunnerError)` (gate blocks)
 * - `ok(CollatedReview)` with `gateDecision.passed === true` → log approval at
 *   info level, return `ok(void)` (gate passes)
 * - `ok(CollatedReview)` with `gateDecision.passed === false` → build a
 *   descriptive error message listing which variant(s) blocked and their
 *   verdict type, log at error level, return `err(WorkflowRunnerError)` (gate
 *   blocks)
 *
 * @param collateResult - The result from `ReviewOrchestrator.collate`.
 * @returns `Result<void, WorkflowRunnerError>` — gate pass or gate block.
 */
export function translateReviewOutcome(
  collateResult: Result<CollatedReview, ReviewOrchestrationError>,
): Result<void, WorkflowRunnerError> {
  if (collateResult.isErr()) {
    const collationErr = collateResult.error;
    const message =
      "message" in collationErr
        ? collationErr.message
        : "All review variants failed";
    const failureCount =
      "failures" in collationErr ? collationErr.failures.length : 0;
    log.error({ failureCount }, message);
    return err({
      type: "projection_error" as const,
      message,
      cause: new Error(message),
    });
  }

  const review = collateResult.value;

  for (const warning of review.warnings) {
    log.warn(
      { variantName: warning.variantName, reviewModel: warning.reviewModel },
      `Review variant partial failure: ${warning.errorMessage}`,
    );
  }

  const gateDecision: GateDecision = review.gateDecision;

  if (gateDecision.passed) {
    log.info(
      {
        variantCount: review.perVariantVerdicts.length,
        collatedOutputLength: review.collatedOutput.length,
      },
      "Review gate approved — all variants passed",
    );
    return ok(undefined);
  }

  const blockerSummary = gateDecision.blockers
    .map(
      (b) =>
        `variant '${b.variantName}' returned [${b.verdict.verdict.toUpperCase()}]`,
    )
    .join(", ");
  const message = `Review gate blocked: ${blockerSummary}`;

  log.error(
    {
      blockers: gateDecision.blockers.map((b) => ({
        variantName: b.variantName,
        verdict: b.verdict.verdict,
      })),
    },
    message,
  );

  return err({
    type: "projection_error" as const,
    message,
    cause: new Error(message),
  });
}

// ---------------------------------------------------------------------------
// formatReviewSummary — human-readable Markdown summary of a CollatedReview
// ---------------------------------------------------------------------------

/**
 * Format a `CollatedReview` as human-readable Markdown suitable for session output.
 *
 * The output includes:
 * - Gate decision header (PASSED or BLOCKED)
 * - Per-variant results table
 * - Blocker details with truncated reasoning (when gate is blocked)
 * - Full collated output
 *
 * @param collated - The collated review from `ReviewOrchestrator.collate`.
 * @returns A Markdown string summarising the review findings.
 */
export function formatReviewSummary(collated: CollatedReview): string {
  const gateLabel = collated.gateDecision.passed ? "PASSED" : "BLOCKED";

  const rows = collated.perVariantVerdicts
    .map(
      (v) =>
        `| ${v.variantName} | ${v.reviewModel} | ${v.verdict.verdict.toUpperCase()} |`,
    )
    .join("\n");

  const variantTable = [
    "### Per-Variant Results",
    "",
    "| Variant | Model | Verdict |",
    "|---------|-------|---------|",
    rows,
  ].join("\n");

  const blockerLines = collated.gateDecision.passed
    ? "(none)"
    : collated.gateDecision.blockers
        .map((b) => {
          const matched = collated.perVariantVerdicts.find(
            (v) => v.variantName === b.variantName,
          );
          const reviewModel = matched?.reviewModel ?? "unknown";
          let raw: string;
          if (b.verdict.verdict === "reject" || b.verdict.verdict === "block") {
            raw = b.verdict.reasoning;
          } else if (b.verdict.verdict === "malformed") {
            raw = "Review did not produce a valid verdict signal.";
          } else {
            raw = "";
          }
          const truncated = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
          return `- **${b.variantName}** (${reviewModel}): [${b.verdict.verdict.toUpperCase()}]\n  > ${truncated}`;
        })
        .join("\n");

  const blockersSection = ["### Blockers", "", blockerLines].join("\n");

  const collatedSection = [
    "### Collated Output",
    "",
    collated.collatedOutput,
  ].join("\n");

  return [
    `## Review Gate: ${gateLabel}`,
    "",
    variantTable,
    "",
    blockersSection,
    "",
    collatedSection,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// buildProjectEffect — adapter-owned effect projection callback
// ---------------------------------------------------------------------------

/**
 * Build the adapter-owned `projectEffect` callback for engine operations.
 *
 * The callback calls `adapter.spawnSubagent` for each `DispatchAgentEffect`
 * emitted by the engine's workflow runner. On failure, maps
 * `OpenCodeAdapterError` to `WorkflowRunnerError` so the engine can propagate
 * it as a typed `projection_error`.
 *
 * This is adapter-owned — the engine never calls `spawnSubagent` directly.
 *
 * @param adapter - The OpenCode adapter instance.
 * @returns A `projectEffect` callback suitable for engine operation calls.
 */
export function buildProjectEffect(
  adapter: OpenCodeAdapter,
  config?: WeaveConfig,
): (
  effect: DispatchAgentEffect,
  renderedPrompt?: string,
) => ResultAsync<void, WorkflowRunnerError> {
  return (effect: DispatchAgentEffect, renderedPrompt?: string) => {
    const intent = effect.runAgent.reviewFanOutIntent;

    if (intent === undefined) {
      log.info(
        {
          agentName: effect.runAgent.agentName,
          stepType: effect.runAgent.stepType,
          completionMethod: effect.runAgent.completionMethod,
        },
        "Applying DispatchAgentEffect — spawning subagent",
      );
      return adapter.spawnSubagent(effect.runAgent.agentDescriptor).mapErr(
        (cause): WorkflowRunnerError => ({
          type: "projection_error" as const,
          message: `spawnSubagent failed for agent "${effect.runAgent.agentName}": ${cause.message}`,
          cause,
        }),
      );
    }

    // Review fan-out path
    if (config === undefined) {
      log.warn(
        { agentName: intent.agentName },
        "reviewFanOutIntent present but no WeaveConfig supplied — cannot fan out",
      );
      return errAsync({
        type: "projection_error" as const,
        message: `reviewFanOutIntent present for agent "${intent.agentName}" but no WeaveConfig was supplied to buildProjectEffect`,
        cause: new Error("Missing WeaveConfig for review fan-out"),
      });
    }

    if (adapter.spawnReviewVariants === undefined) {
      log.warn(
        { agentName: intent.agentName },
        "reviewFanOutIntent present but adapter does not support spawnReviewVariants",
      );
      return errAsync({
        type: "projection_error" as const,
        message: `Adapter does not support spawnReviewVariants for agent "${intent.agentName}"`,
        cause: new Error("spawnReviewVariants not implemented by adapter"),
      });
    }

    log.info(
      { agentName: intent.agentName },
      "Applying DispatchAgentEffect — review fan-out path",
    );

    // Validate rendered prompt before fan-out — an empty prompt is a
    // configuration or wiring error and must fail closed rather than sending
    // a blank review to each variant.
    if (!renderedPrompt?.trim()) {
      const message = `Review fan-out aborted for agent "${intent.agentName}": renderedPrompt is absent or blank`;
      log.error({ agentName: intent.agentName }, message);
      return errAsync({
        type: "projection_error" as const,
        message,
        cause: new Error(message),
      });
    }

    const planResult = new ReviewOrchestrator(config).fanOut(intent.agentName);
    if (planResult.isErr()) {
      const fanOutErr = planResult.error;
      const message =
        "message" in fanOutErr
          ? fanOutErr.message
          : `ReviewOrchestrator.fanOut failed for agent "${intent.agentName}"`;
      log.error(
        { agentName: intent.agentName, err: fanOutErr },
        "Fan-out plan generation failed",
      );
      return errAsync({
        type: "projection_error" as const,
        message,
        cause: new Error(message),
      });
    }

    const plan = planResult.value;

    // Use intent.reviewModels as the authoritative set of models to fan out to.
    // The intent is populated from the dispatched step's agent config at emission
    // time and represents the canonical list for this gate invocation. Filtering
    // plan.variants through the intent set ensures that config divergence between
    // emission and execution time cannot cause extra models to run.
    const authorizedModels = new Set(intent.reviewModels);
    const variants: ReviewVariantDescriptor[] = Object.entries(plan.variants)
      .filter(([, v]) => authorizedModels.has(v.reviewModel))
      .map(([key, v]) => ({
        variantName: v.config.name ?? key,
        descriptor: {
          name: v.config.name ?? key,
          description: v.config.description,
          displayName: v.config.display_name,
          composedPrompt: v.config.prompt ?? "",
          models: v.config.models ?? [],
          mode: v.config.mode ?? "subagent",
          temperature: v.config.temperature,
          effectiveToolPolicy: evaluateEffectiveToolPolicy(
            v.config.tool_policy,
          ),
          rawToolPolicy: v.config.tool_policy,
          delegationTargets: [],
          skills: v.config.skills ?? [],
        },
        reviewModel: v.reviewModel,
      }));

    const spawnReviewVariants = adapter.spawnReviewVariants.bind(adapter);

    return spawnReviewVariants(variants, renderedPrompt)
      .mapErr(
        (adapterErr): WorkflowRunnerError => ({
          type: "projection_error" as const,
          message: `spawnReviewVariants failed for agent "${intent.agentName}": ${adapterErr.message}`,
          cause: new Error(adapterErr.message),
        }),
      )
      .andThen((results) => {
        const collated = ReviewOrchestrator.collate(results);
        const outcome = translateReviewOutcome(collated);
        if (collated.isOk()) {
          const review = collated.value;
          const summary = formatReviewSummary(review);
          void summary; // formattedSummary is returned by executeDirectReview for direct-review callers
          log.info(
            {
              gateDecision: review.gateDecision.passed ? "PASSED" : "BLOCKED",
              variantCount: results.length,
            },
            "Review fan-out summary",
          );
        }
        if (outcome.isErr()) return errAsync(outcome.error);
        return okAsync(undefined as undefined);
      });
  };
}

// ---------------------------------------------------------------------------
// deriveRunWorkflowResult — map ExecutionStartedData to RunWorkflowResult
// ---------------------------------------------------------------------------

/**
 * Derive a `RunWorkflowResult` from the engine's `ExecutionStartedData`.
 *
 * `ExecutionStartedData.effects` carries all lifecycle effects emitted during
 * the run. We derive:
 * - `status`: "paused" if a `pause-execution` effect is present, else "completed".
 * - `stepsDispatched`: count of `dispatch-agent` effects.
 * - `appliedEffects`: all effects (forwarded as-is).
 *
 * @param data - Execution data with a `workflowInstanceId` and `effects` array.
 * @returns A normalized `RunWorkflowResult`.
 */
export function deriveRunWorkflowResult(data: {
  readonly workflowInstanceId: string;
  readonly effects: readonly { readonly kind: string }[];
}): RunWorkflowResult {
  const hasPause = data.effects.some((e) => e.kind === "pause-execution");
  const stepsDispatched = data.effects.filter(
    (e) => e.kind === "dispatch-agent",
  ).length;

  return {
    workflowInstanceId: data.workflowInstanceId,
    appliedEffects: data.effects as RunWorkflowResult["appliedEffects"],
    status: hasPause ? "paused" : "completed",
    stepsDispatched,
  };
}
