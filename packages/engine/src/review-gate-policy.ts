import type { ReviewVerdict } from "./review-verdict-parser.js";

/**
 * A single variant's parsed verdict, keyed by its name.
 */
export interface VariantVerdictInput {
  readonly variantName: string;
  readonly verdict: ReviewVerdict;
}

/**
 * The result of evaluating a gate decision across all review variants.
 *
 * - `passed` — `true` only when every variant returned `approve`
 * - `blockers` — the subset of variants whose verdicts prevented approval
 */
export interface GateDecision {
  readonly passed: boolean;
  readonly blockers: ReadonlyArray<{
    readonly variantName: string;
    readonly verdict: ReviewVerdict;
  }>;
}

/**
 * Evaluate a gate decision from a set of per-variant review verdicts.
 *
 * Policy v1 — **strict**: the gate passes only when **all** variants
 * returned `approve`. Any `reject`, `block`, or `malformed` verdict blocks
 * the gate. An empty `verdicts` array also blocks (fail-closed: no reviews
 * means no approval).
 *
 * This is a pure function with no side effects and no failure path.
 *
 * @param verdicts - Parsed verdict for every review variant that ran.
 * @returns A {@link GateDecision} describing whether the gate passed and
 *          which variants (if any) acted as blockers.
 */
export function evaluateGateDecision(
  verdicts: readonly VariantVerdictInput[],
): GateDecision {
  if (verdicts.length === 0) {
    return { passed: false, blockers: [] };
  }

  const blockers = verdicts.filter((v) => v.verdict.verdict !== "approve");

  if (blockers.length === 0) {
    return { passed: true, blockers: [] };
  }

  return { passed: false, blockers };
}
