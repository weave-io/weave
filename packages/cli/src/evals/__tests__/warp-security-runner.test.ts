/**
 * Corpus guards for the shipped `warp-security` cases (Spec 39 gap G3).
 *
 * The suite mixes three kinds of case:
 * - structural cases, whose descriptions state the expected verdict and whose
 *   required signals are disclosed to the model;
 * - `judgment` cases, whose verdict is withheld and whose deterministic
 *   signals decide the result;
 * - `judge-scored` cases, whose verdict is withheld and which the judge
 *   scores against the expected outcome (the specific vulnerability the
 *   review must find), since a BLOCK for the wrong reason must not pass.
 *
 * A fixture that drifted from its kind would be scored on something else
 * without anyone noticing. A scenario cannot cover that, because a scenario
 * brings its own corpus.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { redactSecrets } from "@weaveio/weave-engine";
import { loadSuiteCases, loadSuiteRubrics } from "../case-loader.js";
import { JUDGMENT_CASE_TAG } from "../judgment-cases.js";
import type { EvalCase, EvalRubric } from "../types.js";
import {
  buildUserMessage,
  WARP_SECURITY_SUITE,
} from "../warp-security-runner.js";

const JUDGE_SCORED_TAG = "judge-scored";
const evalsDir = join(import.meta.dir, "../../../../../evals");

/** The suite's text cases, loaded and validated as a run loads them. */
async function warpTextCases(): Promise<EvalCase[]> {
  const loaded = await loadSuiteCases(WARP_SECURITY_SUITE, evalsDir);
  if (loaded.isErr()) throw new Error(loaded.error.message);
  return loaded.value.filter(
    (c) => c.expected_outcome.kind !== "harness_trajectory",
  );
}

async function warpRubrics(): Promise<EvalRubric[]> {
  const loaded = await loadSuiteRubrics(WARP_SECURITY_SUITE, evalsDir);
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

describe("warp-security cases in the corpus", () => {
  it("holds at least 12 text cases, the Spec 39 publication floor", async () => {
    expect((await warpTextCases()).length).toBeGreaterThanOrEqual(12);
  });

  it("keeps every case synthetic: nothing in it looks like a secret", async () => {
    for (const evalCase of await warpTextCases()) {
      expect(redactSecrets(evalCase.description)).toBe(evalCase.description);
    }
  });

  it("withholds the verdict from the model on judgment and judge-scored cases", async () => {
    const withheld = (await warpTextCases()).filter(
      (c) =>
        c.tags.includes(JUDGMENT_CASE_TAG) || c.tags.includes(JUDGE_SCORED_TAG),
    );
    expect(withheld.length).toBeGreaterThanOrEqual(10);

    for (const evalCase of withheld) {
      const message = buildUserMessage(evalCase);
      expect(evalCase.description).not.toMatch(/\b(?:APPROVE|BLOCK)\b/);
      expect(message).not.toContain(outcomeText(evalCase));
      expect(message).not.toMatch(/security_verdict_(?:approve|block)/);
    }
  });
});

describe("judge-scored warp-security cases", () => {
  async function judgeScored(): Promise<EvalCase[]> {
    return (await warpTextCases()).filter((c) =>
      c.tags.includes(JUDGE_SCORED_TAG),
    );
  }

  it("asks for a block on each, naming the vulnerability the review must find", async () => {
    const cases = await judgeScored();
    expect(cases.length).toBeGreaterThanOrEqual(6);

    for (const evalCase of cases) {
      expect(evalCase.tags).not.toContain(JUDGMENT_CASE_TAG);
      expect(evalCase.expected_outcome.kind).toBe("task_completion");
      expect(requiredArtifacts(evalCase)).toEqual([]);
      expect(outcomeText(evalCase)).toMatch(/^Block the change: /);
      expect(outcomeText(evalCase)).toContain(
        "A blocking finding must identify",
      );
    }
  });

  it("gives the judge rubric notes that fail an approval and a block for the wrong reason", async () => {
    const rubrics = await warpRubrics();
    for (const evalCase of await judgeScored()) {
      const rubric = rubrics.find((r) => r.case_id === evalCase.id);
      expect(rubric?.scoring.required).toBe(true);
      expect(rubric?.scoring.notes).toContain("Fail an APPROVE");
      expect(rubric?.scoring.notes).toContain("Fail a BLOCK");
    }
  });
});

describe("judgment approvals in warp-security", () => {
  it("require an approval with no blockers, which a BLOCK answer cannot produce", async () => {
    const approvals = (await warpTextCases()).filter(
      (c) =>
        c.tags.includes(JUDGMENT_CASE_TAG) &&
        requiredArtifacts(c).includes("security_verdict_approve"),
    );
    expect(approvals.length).toBeGreaterThanOrEqual(3);

    for (const evalCase of approvals) {
      expect(requiredArtifacts(evalCase)).toContain(
        "security_blocker_count_capped",
      );
    }
  });
});
