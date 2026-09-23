/**
 * Unit tests for `pass-rates.ts`: counting attempts, leaving errored ones
 * out of the pass rate, and grouping a suite's attempts by model and case.
 * The published promise is covered end to end in
 * `tests/evals/repeats.scenario.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import { tallyAttempts, tallyByModelAndCase } from "../pass-rates.js";

describe("tallyAttempts", () => {
  it("rates passes over scored attempts", () => {
    expect(
      tallyAttempts([{ passed: true }, { passed: false }, { passed: true }]),
    ).toEqual({
      attempts: 3,
      passed: 2,
      failed: 1,
      errored: 0,
      passRate: 2 / 3,
    });
  });

  it("leaves errored attempts out of the rate and counts them apart", () => {
    expect(
      tallyAttempts([
        { passed: true },
        { passed: false, errored: true },
        { passed: false },
      ]),
    ).toEqual({ attempts: 3, passed: 1, failed: 1, errored: 1, passRate: 0.5 });
  });

  it("gives no rate when nothing was scored", () => {
    expect(
      tallyAttempts([{ passed: false, errored: true }]).passRate,
    ).toBeNull();
    expect(tallyAttempts([]).passRate).toBeNull();
  });
});

describe("tallyByModelAndCase", () => {
  it("groups by model then case, sorted, whatever order the attempts ran in", () => {
    const tallies = tallyByModelAndCase([
      { modelId: "z/model", caseId: "b-case", passed: true },
      { modelId: "a/model", caseId: "b-case", passed: false },
      { modelId: "a/model", caseId: "a-case", passed: true },
      { modelId: "a/model", caseId: "b-case", passed: true },
    ]);

    expect(tallies.map((t) => t.modelId)).toEqual(["a/model", "z/model"]);
    expect(tallies[0]).toMatchObject({
      attempts: 3,
      passed: 2,
      passRate: 2 / 3,
    });
    expect(
      tallies[0]?.cases.map((c) => [c.caseId, c.passed, c.attempts]),
    ).toEqual([
      ["a-case", 1, 1],
      ["b-case", 1, 2],
    ]);
    expect(tallies[1]?.cases).toEqual([
      {
        caseId: "b-case",
        attempts: 1,
        passed: 1,
        failed: 0,
        errored: 0,
        passRate: 1,
      },
    ]);
  });
});
