/**
 * Corpus guards for the shipped `pattern-planning` cases (Spec 39 gap G3).
 *
 * The suite mixes three kinds of case:
 * - structural cases, whose required plan signals are disclosed to the model;
 * - `judgment` cases, whose signals are withheld and decide the result
 *   deterministically (no invented commands, a declared verification
 *   command);
 * - `judge-scored` cases, which name one planning behaviour (reuse an existing
 *   helper, order codegen first, keep a constraint, flag an open decision) and
 *   let the judge decide whether the plan shows it, since no structural
 *   signal can tell a well-formed plan that misses it from one that does not.
 *
 * A fixture that drifted from its kind would be scored on something else
 * without anyone noticing. A scenario cannot cover that, because a scenario
 * brings its own corpus.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { loadSuiteCases, loadSuiteRubrics } from "../case-loader.js";
import { JUDGMENT_CASE_TAG } from "../judgment-cases.js";
import {
  buildUserMessage,
  PATTERN_PLANNING_SUITE,
} from "../pattern-planning-runner.js";
import type { EvalCase, EvalRubric } from "../types.js";

const JUDGE_SCORED_TAG = "judge-scored";
const evalsDir = join(import.meta.dir, "../../../../../evals");

async function patternCases(): Promise<EvalCase[]> {
  const loaded = await loadSuiteCases(PATTERN_PLANNING_SUITE, evalsDir);
  if (loaded.isErr()) throw new Error(loaded.error.message);
  return loaded.value.filter(
    (c) => c.expected_outcome.kind !== "harness_trajectory",
  );
}

async function patternRubrics(): Promise<EvalRubric[]> {
  const loaded = await loadSuiteRubrics(PATTERN_PLANNING_SUITE, evalsDir);
  if (loaded.isErr()) throw new Error(loaded.error.message);
  return loaded.value;
}

function requiredArtifacts(evalCase: EvalCase): string[] {
  if (evalCase.expected_outcome.kind !== "task_completion") return [];
  return evalCase.expected_outcome.required_artifacts;
}

function outcomeText(evalCase: EvalCase): string {
  if (evalCase.expected_outcome.kind !== "task_completion") return "";
  return evalCase.expected_outcome.description;
}

describe("pattern-planning cases in the corpus", () => {
  it("holds at least 12 text cases, the Spec 39 publication floor", async () => {
    expect((await patternCases()).length).toBeGreaterThanOrEqual(12);
  });

  it("declares the project's commands in every case, so the judge can tell an invented one", async () => {
    for (const evalCase of await patternCases()) {
      expect(evalCase.description).toContain("Available commands");
    }
  });

  it("never shows the model the expected outcome of a judgment or judge-scored case", async () => {
    const withheld = (await patternCases()).filter(
      (c) =>
        c.tags.includes(JUDGMENT_CASE_TAG) || c.tags.includes(JUDGE_SCORED_TAG),
    );
    expect(withheld.length).toBeGreaterThanOrEqual(9);

    for (const evalCase of withheld) {
      const message = buildUserMessage(evalCase);
      expect(message).not.toContain(outcomeText(evalCase));
      for (const signal of requiredArtifacts(evalCase)) {
        expect(message).not.toContain(signal);
      }
    }
  });
});

describe("judge-scored pattern-planning cases", () => {
  async function judgeScored(): Promise<EvalCase[]> {
    return (await patternCases()).filter((c) =>
      c.tags.includes(JUDGE_SCORED_TAG),
    );
  }

  it("leave the verdict to the judge, which asks about the expected outcome", async () => {
    const cases = await judgeScored();
    expect(cases.length).toBeGreaterThanOrEqual(7);

    for (const evalCase of cases) {
      expect(evalCase.tags).not.toContain(JUDGMENT_CASE_TAG);
      expect(evalCase.expected_outcome.kind).toBe("task_completion");
      expect(requiredArtifacts(evalCase)).toEqual([]);
      expect(outcomeText(evalCase)).toMatch(/^The plan /);
    }
  });

  it("give the judge rubric notes that say what passes and what fails", async () => {
    const rubrics = await patternRubrics();
    for (const evalCase of await judgeScored()) {
      const rubric = rubrics.find((r) => r.case_id === evalCase.id);
      expect(rubric?.scoring.required).toBe(true);
      expect(rubric?.scoring.notes).toContain("Pass a plan");
      expect(rubric?.scoring.notes).toContain("Fail a plan");
    }
  });
});
