/**
 * Shared fixtures for the eval runner tests.
 *
 * Each agent suite's runner test built its own copy of the same dry-run
 * summary — seven near-identical definitions differing only in whether
 * `scoredAt` was a fixed string or `new Date()`. One definition with overrides
 * covers every caller.
 */

import type {
  CaseResultSummary,
  EvalCase,
  ScoringDimension,
} from "../types.js";

/** Fixed timestamp, so a summary is comparable across runs. */
export const SCORED_AT = "2026-01-01T00:00:00.000Z";

/** Every scoring dimension, present but not applicable. */
export function inapplicableDimensionScores(): Record<
  ScoringDimension,
  { score: number; applicable: boolean }
> {
  return {
    routingCorrectness: { score: 0, applicable: false },
    delegationCorrectness: { score: 0, applicable: false },
    executionCompleteness: { score: 0, applicable: false },
    rationaleQuality: { score: 0, applicable: false },
  };
}

/**
 * The summary a runner emits for a case it did not actually execute.
 *
 * `scoredAt` defaults to the fixed `SCORED_AT`; pass an override where a test
 * needs a distinct or current timestamp.
 */
export function makeDryRunSummary(
  evalCase: EvalCase,
  modelId: string,
  overrides: Partial<CaseResultSummary> = {},
): CaseResultSummary {
  return {
    caseId: evalCase.id,
    modelId,
    suite: evalCase.suite,
    passed: false,
    required: true,
    weightedTotal: 0,
    dimensionScores: inapplicableDimensionScores(),
    scoredAt: SCORED_AT,
    dryRun: true,
    ...overrides,
  };
}
