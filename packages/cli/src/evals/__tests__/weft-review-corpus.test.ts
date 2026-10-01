/**
 * Guards the `weft-review` case corpus itself (Spec 39 task 0.3, gap G3).
 *
 * The suite mixes two kinds of case. A `judgment` case is scored on
 * deterministic review signals that the runner withholds from the model; a
 * judged case has no required signals, so the judge decides whether the
 * review reaches the case's expected outcome (the right verdict for the
 * right reason). A fixture edit that moved a case from one kind to the other,
 * or let a rejecting review satisfy an approval case, would change what the
 * suite measures without any scenario noticing: a scenario brings its own
 * corpus.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { isJudgmentCase } from "../judgment-cases.js";
import type { EvalCase } from "../types.js";
import {
  buildUserMessage,
  extractReviewSignals,
} from "../weft-review-runner.js";

const evalsDir = join(import.meta.dir, "../../../../../evals");

async function weftCases(): Promise<EvalCase[]> {
  const cases: EvalCase[] = [];
  for (const name of new Bun.Glob("*.json").scanSync(
    `${evalsDir}/cases/weft-review`,
  )) {
    cases.push(await Bun.file(`${evalsDir}/cases/weft-review/${name}`).json());
  }
  return cases;
}

function requiredSignals(evalCase: EvalCase): string[] {
  const outcome = evalCase.expected_outcome;
  return outcome.kind === "task_completion" ? outcome.required_artifacts : [];
}

async function rubricNotes(caseId: string): Promise<string> {
  const rubric = await Bun.file(
    `${evalsDir}/rubrics/weft-review/${caseId}.json`,
  ).json();
  expect(rubric.scoring.required).toBe(true);
  return rubric.scoring.notes ?? "";
}

describe("the weft-review corpus", () => {
  it("holds at least 12 text cases, the Spec 39 publication bar", async () => {
    expect((await weftCases()).length).toBeGreaterThanOrEqual(12);
  });

  it("gives each judged case the change itself, no required signals and rubric notes saying what fails", async () => {
    const judged = (await weftCases()).filter(
      (c) => requiredSignals(c).length === 0,
    );
    expect(judged.length).toBeGreaterThanOrEqual(5);

    for (const evalCase of judged) {
      expect(isJudgmentCase(evalCase)).toBe(false);
      expect(evalCase.description).toStartWith("Change under review. Task:");
      expect(evalCase.description).toContain("```");
      expect(await rubricNotes(evalCase.id)).toContain("Fail the review if");
    }
  });

  it("never shows the model a judged case's expected outcome", async () => {
    for (const evalCase of await weftCases()) {
      const outcome = evalCase.expected_outcome;
      if (outcome.kind !== "task_completion") continue;
      if (outcome.required_artifacts.length > 0) continue;
      const message = buildUserMessage(evalCase);

      expect(message).toContain(evalCase.description);
      expect(message).not.toContain(outcome.description);
      expect(message).toContain("Required structural signals: none");
    }
  });

  it("passes an approval case only for an approval with no blocker", async () => {
    const approvals = (await weftCases()).filter(
      (c) =>
        isJudgmentCase(c) &&
        requiredSignals(c).includes("review_verdict_approve"),
    );
    expect(approvals.length).toBeGreaterThanOrEqual(4);

    const approve =
      "[APPROVE] Meets the task.\nReviewed files: `src/a.ts`\nNon-blocking: a follow-up for later.";
    const reject =
      "[REJECT] Not yet.\nReviewed files: `src/a.ts`\nBLOCKER: `src/a.ts` fix the style of line 3.";

    for (const evalCase of approvals) {
      const signals = (text: string) =>
        extractReviewSignals(text, evalCase.description).producedArtifacts;
      const meets = (text: string) =>
        requiredSignals(evalCase).every((s) => signals(text).includes(s));

      expect(meets(approve)).toBe(true);
      expect(meets(reject)).toBe(false);
      expect(await rubricNotes(evalCase.id)).toContain("[APPROVE]");
    }
  });
});
