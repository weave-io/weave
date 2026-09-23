/**
 * Small-sample statistics for comparing eval pass rates (Spec 37, task 18.2).
 *
 * `weave eval compare` asks one question per suite × model: did the pass
 * rate change by more than chance allows? Each side is a handful of
 * pass/fail attempts — often under 20 — so large-sample approximations (the
 * normal-approximation z-test, the Wald interval) are wrong exactly where
 * they are needed. This module uses methods that are exact or well behaved
 * at small n:
 *
 * - **Fisher's exact test** (two-sided) for the 2 × 2 table
 *   `[passed, failed]` baseline vs candidate. It makes no large-sample
 *   assumption. Two-sided p sums every table, with the same margins, that
 *   is no more likely than the one observed.
 * - **Wilson score interval** (95%) for one pass rate, for display. Unlike
 *   the Wald interval it never leaves [0, 1] and does not collapse to zero
 *   width at 0/n or n/n.
 * - **Holm's step-down adjustment** of a family of p-values, so running one
 *   test per suite × model does not inflate the chance of a false "changed".
 *
 * Pure functions, no I/O. See the "Measure a change" section of
 * `docs/agent-evals.md` for how `eval compare` applies them and their limits.
 */

/** The significance level `eval compare` uses: a 5% family-wise error rate. */
export const SIGNIFICANCE_LEVEL = 0.05;

/** The two-sided 97.5% normal quantile, for a 95% Wilson interval. */
const Z_95 = 1.959963984540054;

/**
 * Relative tolerance when comparing table probabilities in Fisher's test.
 * Tables that are equally likely in exact arithmetic can differ in the last
 * bits in floating point; without this they would be left out of the tail.
 */
const FISHER_TOLERANCE = 1e-7;

/** A closed interval on a proportion. */
export interface ProportionInterval {
  low: number;
  high: number;
}

/**
 * The 95% Wilson score interval for `successes` out of `trials`, or `null`
 * when `trials` is 0.
 */
export function wilsonInterval(
  successes: number,
  trials: number,
): ProportionInterval | null {
  if (trials <= 0) return null;
  const p = successes / trials;
  const z2 = Z_95 * Z_95;
  const denominator = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denominator;
  const margin =
    (Z_95 / denominator) *
    Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return {
    low: Math.max(0, centre - margin),
    high: Math.min(1, centre + margin),
  };
}

/** `log(k!)` for k = 0..n, built once per test. */
function logFactorials(n: number): number[] {
  const table = [0];
  for (let k = 1; k <= n; k += 1) {
    table.push((table[k - 1] ?? 0) + Math.log(k));
  }
  return table;
}

/**
 * Two-sided p-value of Fisher's exact test for the table
 *
 * ```
 *              passed  failed
 *   baseline     a       b
 *   candidate    c       d
 * ```
 *
 * Returns 1 when either row or either column is empty: such a table carries
 * no evidence of a difference.
 */
export function fisherExactTwoSided(
  a: number,
  b: number,
  c: number,
  d: number,
): number {
  const rowA = a + b;
  const rowC = c + d;
  const passedTotal = a + c;
  const total = rowA + rowC;
  if (rowA === 0 || rowC === 0) return 1;
  if (passedTotal === 0 || passedTotal === total) return 1;

  const lf = logFactorials(total);
  const at = (k: number): number => lf[k] ?? 0;
  // log P(X = x): x passes in the baseline row, margins fixed.
  const logProbability = (x: number): number =>
    at(passedTotal) +
    at(total - passedTotal) +
    at(rowA) +
    at(rowC) -
    at(total) -
    at(x) -
    at(passedTotal - x) -
    at(rowA - x) -
    at(rowC - passedTotal + x);

  const observed = logProbability(a);
  const threshold = observed + Math.log1p(FISHER_TOLERANCE);
  const low = Math.max(0, passedTotal - rowC);
  const high = Math.min(passedTotal, rowA);
  let p = 0;
  for (let x = low; x <= high; x += 1) {
    const logP = logProbability(x);
    if (logP <= threshold) p += Math.exp(logP);
  }
  return Math.min(1, p);
}

/**
 * The smallest two-sided p-value Fisher's test can reach with `n1` scored
 * attempts on one side and `n2` on the other: every attempt passing on one
 * side and failing on the other.
 *
 * When this is not below the significance level, **no** outcome could show
 * a change, however large; `eval compare` then says there are too few
 * attempts rather than "no change". With equal sides this needs at least 4
 * scored attempts each (2 × 2 gives 0.33, 3 × 3 gives 0.10, 4 × 4 gives 0.029).
 */
export function bestPossibleP(n1: number, n2: number): number {
  return fisherExactTwoSided(n1, 0, 0, n2);
}

/**
 * Holm's step-down adjustment. Returns adjusted p-values in the input order.
 *
 * Sort ascending; the i-th smallest (0-based) is multiplied by `m - i`, then
 * made monotone. Rejecting where the adjusted p is below α controls the
 * probability of any false rejection in the family at α, with no assumption
 * about how the tests depend on each other.
 */
export function holmAdjust(pValues: readonly number[]): number[] {
  const m = pValues.length;
  const order = pValues
    .map((p, index) => ({ p, index }))
    .sort((x, y) => x.p - y.p);
  const adjusted = new Array<number>(m).fill(1);
  let running = 0;
  order.forEach(({ p, index }, rank) => {
    running = Math.max(running, Math.min(1, (m - rank) * p));
    adjusted[index] = running;
  });
  return adjusted;
}
