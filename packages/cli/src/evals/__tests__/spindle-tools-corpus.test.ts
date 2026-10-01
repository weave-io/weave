/**
 * Guards the `spindle-tools` case corpus itself (Spec 39 task 0.3, gap G3).
 *
 * Every case asks for the same report format (`Source facts`,
 * `Interpretation`, `Sources:`, `Confidence:`) through the four required
 * signals: dropping those sections is the difference the suite caught between
 * GPT 6 Sol and Luna on 29 Sep. The cases added for G3 also test one research
 * behaviour each (saying "not found", flagging a stale source, keeping a
 * caveat). The judge reads that behaviour from the case's expected outcome
 * and rubric notes, so the model must never see either. A fixture edit that
 * dropped a signal, leaked the expected behaviour into the brief or turned a
 * case into a deterministic `judgment` case would change what the suite
 * measures without any scenario noticing: a scenario brings its own corpus.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { isJudgmentCase } from "../judgment-cases.js";
import { buildUserMessage } from "../spindle-tools-runner.js";
import type { EvalCase } from "../types.js";

const evalsDir = join(import.meta.dir, "../../../../../evals");

const REPORT_SIGNALS = [
  "spindle_inline_citations_present",
  "spindle_source_facts_separated",
  "spindle_confidence_reported",
  "spindle_sources_list_present",
];

/** The two cases that test the report format alone, from before G3. */
const FORMAT_ONLY_CASES = [
  "spindle-tools-citations-facts-confidence",
  "spindle-tools-source-boundary-network-claims",
];

async function spindleCases(): Promise<EvalCase[]> {
  const cases: EvalCase[] = [];
  for (const name of new Bun.Glob("*.json").scanSync(
    `${evalsDir}/cases/spindle-tools`,
  )) {
    cases.push(
      await Bun.file(`${evalsDir}/cases/spindle-tools/${name}`).json(),
    );
  }
  return cases;
}

function requiredSignals(evalCase: EvalCase): string[] {
  const outcome = evalCase.expected_outcome;
  return outcome.kind === "task_completion" ? outcome.required_artifacts : [];
}

async function rubricNotes(caseId: string): Promise<string> {
  const rubric = await Bun.file(
    `${evalsDir}/rubrics/spindle-tools/${caseId}.json`,
  ).json();
  expect(rubric.case_id).toBe(caseId);
  expect(rubric.scoring.required).toBe(true);
  return rubric.scoring.notes ?? "";
}

describe("the spindle-tools corpus", () => {
  it("holds at least 12 text cases, the Spec 39 publication bar", async () => {
    expect((await spindleCases()).length).toBeGreaterThanOrEqual(12);
  });

  it("asks every case for the full report format, and leaves the verdict to the judge", async () => {
    for (const evalCase of await spindleCases()) {
      expect(evalCase.id).toStartWith("spindle-tools-");
      expect(requiredSignals(evalCase)).toEqual(REPORT_SIGNALS);
      expect(isJudgmentCase(evalCase)).toBe(false);
    }
  });

  it("gives each behaviour case numbered sources, and rubric notes saying what fails", async () => {
    const behaviourCases = (await spindleCases()).filter(
      (c) => !FORMAT_ONLY_CASES.includes(c.id),
    );
    expect(behaviourCases.length).toBeGreaterThanOrEqual(10);

    for (const evalCase of behaviourCases) {
      expect(evalCase.description).toStartWith("Research question");
      expect(evalCase.description).toContain("[1]");
      expect(await rubricNotes(evalCase.id)).toContain("Fail the answer if");
    }
  });

  it("never shows the model a case's expected outcome or rubric notes", async () => {
    for (const evalCase of await spindleCases()) {
      const outcome = evalCase.expected_outcome;
      if (outcome.kind !== "task_completion") continue;
      const message = buildUserMessage(evalCase);

      expect(message).toContain(evalCase.description);
      expect(message).not.toContain(outcome.description);
      expect(message).not.toContain(await rubricNotes(evalCase.id));
    }
  });
});
