/**
 * Guards the `tapestry-execution` case corpus itself (Spec 39 task 0.3, gap
 * G3).
 *
 * The cases added for G3 are mostly `own-envelope` cases: each carries an
 * active plan file and what happened in the last step (a specialist's
 * report, a delegation error, a continuation), and tests one plan-execution
 * behaviour from Tapestry's prompt. The judge reads that behaviour from the
 * case's expected outcome and rubric notes, so the model must never see
 * either, and must not be handed the completion cue the older synthetic
 * cases use. A fixture edit that leaked the expected decision into the
 * message, or turned a judged case into a deterministic one, would change
 * what the suite measures without any scenario noticing: a scenario brings
 * its own corpus.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { selectCasesForTrack } from "../eval-track.js";
import { carriesOwnEnvelope, isJudgmentCase } from "../judgment-cases.js";
import {
  buildUserMessage,
  OWN_ENVELOPE_CONTINUE_LINE,
} from "../tapestry-execution-runner.js";
import type { EvalCase } from "../types.js";

const evalsDir = join(import.meta.dir, "../../../../../evals");
const SUITE = "tapestry-execution";

async function tapestryCases(): Promise<EvalCase[]> {
  const cases: EvalCase[] = [];
  for (const name of new Bun.Glob("*.json").scanSync(
    `${evalsDir}/cases/${SUITE}`,
  )) {
    cases.push(await Bun.file(`${evalsDir}/cases/${SUITE}/${name}`).json());
  }
  return cases;
}

async function rubricNotes(caseId: string): Promise<string> {
  const rubric = await Bun.file(
    `${evalsDir}/rubrics/${SUITE}/${caseId}.json`,
  ).json();
  expect(rubric.case_id).toBe(caseId);
  expect(rubric.scoring.required).toBe(true);
  return rubric.scoring.notes ?? "";
}

async function ownEnvelopeCases(): Promise<EvalCase[]> {
  return (await tapestryCases()).filter(carriesOwnEnvelope);
}

describe("the tapestry-execution corpus", () => {
  it("holds at least 12 text cases, the Spec 39 publication bar", async () => {
    const text = selectCasesForTrack(await tapestryCases(), "text");
    expect(text.length).toBeGreaterThanOrEqual(12);
  });

  it("leaves every own-envelope case to the judge, with rubric notes saying what fails", async () => {
    const cases = await ownEnvelopeCases();
    expect(cases.length).toBeGreaterThanOrEqual(8);

    for (const evalCase of cases) {
      const outcome = evalCase.expected_outcome;
      expect(evalCase.id).toStartWith("tapestry-");
      expect(isJudgmentCase(evalCase)).toBe(false);
      expect(outcome.kind).toBe("task_completion");
      if (outcome.kind !== "task_completion") continue;
      expect(outcome.required_artifacts).toEqual([]);
      expect(evalCase.description).toContain("```md");
      expect(await rubricNotes(evalCase.id)).toContain("Fail the response if");
    }
  });

  it("shows the model the plan and the last step, but never the expected decision or a completion cue", async () => {
    for (const evalCase of await ownEnvelopeCases()) {
      const outcome = evalCase.expected_outcome;
      if (outcome.kind !== "task_completion") continue;
      const message = buildUserMessage(evalCase);

      expect(message).toBe(
        `${evalCase.description}\n\n${OWN_ENVELOPE_CONTINUE_LINE}`,
      );
      expect(message).not.toContain(outcome.description);
      expect(message).not.toContain(await rubricNotes(evalCase.id));
      expect(message).not.toContain("task complete");
      expect(message).not.toContain("Synthetic eval plan context");
    }
  });
});
