/**
 * Pass rates over repeated attempts (Spec 37, task 18.1).
 *
 * `weave eval run --repeat N` runs every selected case N times per model. Each
 * run of a case is an **attempt**. This module turns a set of attempts into a
 * pass rate, the one number the report, the dashboard indexes and
 * `weave eval compare` all read.
 *
 * # Errored attempts
 *
 * An attempt is **errored** when it produced no scorable answer — an empty or
 * truncated answer, a provider failure — rather than a wrong one. It carries
 * `errored: true` (and, like every attempt that did not pass, `passed: false`).
 * An errored attempt says nothing about whether the prompt works, so a pass
 * rate leaves it out of its denominator and reports it separately:
 *
 *   passRate = passed / (passed + failed)      errored attempts excluded
 *
 * A set with no scored attempt has `passRate: null`, never 0 or 1.
 *
 * The aggregate counts (`totalCases`, `passedCases`, `failedCases`,
 * `erroredCases`) are not derived here but agree with it: since Spec 37 task
 * 16.5 `failedCases` counts scored attempts only and errored ones are
 * counted in `erroredCases` (see `case-outcomes.ts`).
 *
 * Pure functions only; no I/O.
 */

/** The fields of one attempt a pass rate reads. */
export interface AttemptOutcome {
  passed: boolean;
  errored?: boolean;
}

/** Outcome counts for a set of attempts. */
export interface AttemptTally {
  /** Every attempt, errored ones included. */
  attempts: number;
  /** Scored attempts that passed. */
  passed: number;
  /** Scored attempts that did not pass. Errored attempts are not here. */
  failed: number;
  /** Attempts that produced no scorable answer. */
  errored: number;
  /** `passed / (passed + failed)`, or `null` when no attempt was scored. */
  passRate: number | null;
}

/** A case × model tally, as the suite summary publishes it. */
export interface CaseAttemptTally extends AttemptTally {
  caseId: string;
}

/** A model's tally over one suite, with its per-case tallies. */
export interface ModelAttemptTally extends AttemptTally {
  modelId: string;
  /** One entry per case the model ran, sorted by `caseId`. */
  cases: CaseAttemptTally[];
}

/** The fields of one attempt `tallyByModelAndCase` groups on. */
export interface KeyedAttemptOutcome extends AttemptOutcome {
  caseId: string;
  modelId: string;
}

/** Whether an attempt produced no scorable answer. */
export function isErroredAttempt(outcome: AttemptOutcome): boolean {
  return outcome.errored === true;
}

/** Count a set of attempts. */
export function tallyAttempts(
  outcomes: readonly AttemptOutcome[],
): AttemptTally {
  let passed = 0;
  let failed = 0;
  let errored = 0;
  for (const outcome of outcomes) {
    if (isErroredAttempt(outcome)) {
      errored += 1;
      continue;
    }
    if (outcome.passed) {
      passed += 1;
      continue;
    }
    failed += 1;
  }
  const scored = passed + failed;
  return {
    attempts: outcomes.length,
    passed,
    failed,
    errored,
    passRate: scored === 0 ? null : passed / scored,
  };
}

/**
 * Group one suite's attempts by model, then by case, and tally each group.
 *
 * Models are sorted by `modelId` and cases by `caseId`, so the output is
 * deterministic whatever order the attempts ran in.
 */
export function tallyByModelAndCase(
  outcomes: readonly KeyedAttemptOutcome[],
): ModelAttemptTally[] {
  const byModel = new Map<string, Map<string, KeyedAttemptOutcome[]>>();
  for (const outcome of outcomes) {
    const byCase =
      byModel.get(outcome.modelId) ?? new Map<string, KeyedAttemptOutcome[]>();
    const group = byCase.get(outcome.caseId) ?? [];
    group.push(outcome);
    byCase.set(outcome.caseId, group);
    byModel.set(outcome.modelId, byCase);
  }

  return [...byModel.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([modelId, byCase]) => {
      const cases = [...byCase.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([caseId, group]) => ({ caseId, ...tallyAttempts(group) }));
      const all = [...byCase.values()].flat();
      return { modelId, ...tallyAttempts(all), cases };
    });
}
