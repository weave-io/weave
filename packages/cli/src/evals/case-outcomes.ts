/**
 * Case outcomes: passed, failed, or errored (Spec 37, task 16.5).
 *
 * A case is **passed** or **failed** only when it was scored, that is, when
 * the model answered and the scorer judged the answer. A case whose run broke
 * before that point is **errored**: the model returned an empty or truncated
 * answer, the request failed, the judge failed, or the rubric was missing.
 * None of those says anything about the model's behaviour, so an errored case
 * is reported on its own and kept out of pass/fail counts and pass rates.
 *
 * Every runner, the bundle writer and the public report count outcomes
 * through `countCaseOutcomes`, so all of them agree on what "failed" means
 * and on when a suite is green.
 */

import { type AttemptOutcome, isErroredAttempt } from "./pass-rates.js";

/**
 * The publishable classification label for each typed error discriminant.
 *
 * These labels are the only error detail that reaches a published file.
 * Provider and scorer message text never does.
 */
const ERROR_CLASSIFICATIONS: Readonly<Record<string, string>> = {
  NetworkError: "model-network-failure",
  HttpError: "model-http-failure",
  ParseError: "model-parse-failure",
  EmptyResponse: "model-empty-response",
  TruncatedResponse: "model-truncated-response",
  NotConfigured: "stub-not-configured",
  RubricNotFound: "scoring-rubric-missing",
  RubricCaseMismatch: "scoring-rubric-mismatch",
  ScorerAdapterError: "scoring-adapter-failure",
};

/**
 * Derive the sanitized classification label for a typed error discriminant.
 * Unknown discriminants map to `"unknown-error"`.
 */
export function classifyErrorType(errorType: string): string {
  return ERROR_CLASSIFICATIONS[errorType] ?? "unknown-error";
}

/**
 * The fields of a case summary that decide its outcome. `errored` is the
 * same flag `pass-rates.ts` reads for repeated attempts.
 */
export interface CaseOutcomeRow extends AttemptOutcome {
  required: boolean;
  dryRun: boolean;
}

export type CaseOutcome = "passed" | "failed" | "errored";

/** The outcome of one case. */
export function caseOutcome(row: CaseOutcomeRow): CaseOutcome {
  if (isErroredAttempt(row)) return "errored";
  if (row.passed) return "passed";
  return "failed";
}

/** Outcome counts over a set of cases, and whether they make a suite green. */
export interface CaseOutcomeCounts {
  /** Every case: `passedCases + failedCases + erroredCases`. */
  totalCases: number;
  passedCases: number;
  /** Scored cases that did not pass. */
  failedCases: number;
  /** Cases that produced no score. */
  erroredCases: number;
  /**
   * No case errored, and every required, non-dry-run case passed. An errored
   * case keeps a suite from being green: it was not measured, so the suite
   * cannot be said to have passed it.
   */
  suiteGreen: boolean;
}

export function countCaseOutcomes(
  rows: readonly CaseOutcomeRow[],
): CaseOutcomeCounts {
  const outcomes = rows.map(caseOutcome);
  const passedCases = outcomes.filter((o) => o === "passed").length;
  const erroredCases = outcomes.filter((o) => o === "errored").length;
  const requiredPassed = rows
    .filter((row) => row.required && !row.dryRun)
    .every((row) => row.passed);
  return {
    totalCases: rows.length,
    passedCases,
    failedCases: rows.length - passedCases - erroredCases,
    erroredCases,
    suiteGreen: erroredCases === 0 && requiredPassed,
  };
}

/**
 * Pass rate over the scored cases only, or `null` when none was scored.
 * Errored cases are not in the denominator: they were never measured.
 */
export function scoredPassRate(
  passedCases: number,
  totalCases: number,
  erroredCases: number,
): number | null {
  const scored = totalCases - erroredCases;
  if (scored <= 0) return null;
  return passedCases / scored;
}

/**
 * `{ erroredCases }` when it is non-zero, `{}` otherwise, for the published
 * records where the field is optional so a run with no errored case writes
 * exactly what it wrote before errored cases existed.
 */
export function erroredCasesField(erroredCases: number): {
  erroredCases?: number;
} {
  if (erroredCases === 0) return {};
  return { erroredCases };
}
