/**
 * Unit tests for `case-outcomes.ts` — how passed, failed and errored cases
 * are counted (Spec 37, 16.5). The end-to-end promises are in
 * `tests/evals/errored-cases.scenario.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import {
  type CaseOutcomeRow,
  caseOutcome,
  classifyErrorType,
  countCaseOutcomes,
  erroredCasesField,
  scoredPassRate,
} from "../case-outcomes.js";

const PASSED: CaseOutcomeRow = { passed: true, required: true, dryRun: false };
const FAILED: CaseOutcomeRow = { passed: false, required: true, dryRun: false };
const ERRORED: CaseOutcomeRow = {
  passed: false,
  required: true,
  dryRun: false,
  errored: true,
};

describe("classifyErrorType", () => {
  it.each([
    ["EmptyResponse", "model-empty-response"],
    ["TruncatedResponse", "model-truncated-response"],
    ["NetworkError", "model-network-failure"],
    ["ScorerAdapterError", "scoring-adapter-failure"],
    ["RubricNotFound", "scoring-rubric-missing"],
    ["JudgeHttpError", "judge-http-failure"],
    ["JudgeResponseInvalid", "judge-response-invalid"],
    ["JudgeInputTooLong", "judge-input-too-long"],
    ["JudgeInputInvalid", "judge-input-invalid"],
  ])("maps %s to %s", (errorType, label) => {
    expect(classifyErrorType(errorType)).toBe(label);
  });

  it("maps an unknown discriminant to unknown-error", () => {
    expect(classifyErrorType("SomethingElse")).toBe("unknown-error");
  });
});

describe("caseOutcome", () => {
  it("reads an errored row as errored even though passed is false", () => {
    expect(caseOutcome(ERRORED)).toBe("errored");
    expect(caseOutcome(FAILED)).toBe("failed");
    expect(caseOutcome(PASSED)).toBe("passed");
  });
});

describe("countCaseOutcomes", () => {
  it("counts errored cases apart from failures", () => {
    expect(countCaseOutcomes([PASSED, FAILED, ERRORED])).toEqual({
      totalCases: 3,
      passedCases: 1,
      failedCases: 1,
      erroredCases: 1,
      suiteGreen: false,
    });
  });

  it("is green only when every required case passed and none errored", () => {
    expect(countCaseOutcomes([PASSED]).suiteGreen).toBe(true);
    expect(
      countCaseOutcomes([PASSED, { ...ERRORED, required: false }]).suiteGreen,
    ).toBe(false);
  });

  it("is never green when every case errored", () => {
    expect(countCaseOutcomes([ERRORED, ERRORED])).toMatchObject({
      passedCases: 0,
      failedCases: 0,
      erroredCases: 2,
      suiteGreen: false,
    });
  });

  it("keeps the old rule for runs with no errored case", () => {
    expect(
      countCaseOutcomes([PASSED, { ...FAILED, required: false }]),
    ).toMatchObject({ failedCases: 1, erroredCases: 0, suiteGreen: true });
  });
});

describe("scoredPassRate", () => {
  it("leaves errored cases out of the denominator", () => {
    expect(scoredPassRate(1, 3, 1)).toBe(0.5);
  });

  it("is null when nothing was scored", () => {
    expect(scoredPassRate(0, 2, 2)).toBeNull();
    expect(scoredPassRate(0, 0, 0)).toBeNull();
  });
});

describe("erroredCasesField", () => {
  it("omits the field at zero so unaffected records are unchanged", () => {
    expect(erroredCasesField(0)).toEqual({});
    expect(erroredCasesField(2)).toEqual({ erroredCases: 2 });
  });
});
