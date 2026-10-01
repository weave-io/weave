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
import { JUDGMENT_CASE_TAG } from "../judgment-cases.js";
import { buildUserMessage } from "../warp-security-runner.js";

const JUDGE_SCORED_TAG = "judge-scored";
const evalsDir = join(import.meta.dir, "../../../../../evals");

interface WarpCaseFile {
  id: string;
  description: string;
  tags: string[];
  expected_outcome: {
    kind: string;
    description: string;
    required_artifacts: string[];
  };
}

async function warpCases(): Promise<WarpCaseFile[]> {
  const glob = new Bun.Glob("*.json");
  const cases: WarpCaseFile[] = [];
  for (const name of glob.scanSync(`${evalsDir}/cases/warp-security`)) {
    cases.push(
      await Bun.file(`${evalsDir}/cases/warp-security/${name}`).json(),
    );
  }
  return cases;
}

function messageFor(evalCase: WarpCaseFile): string {
  return buildUserMessage(
    evalCase as unknown as Parameters<typeof buildUserMessage>[0],
  );
}

describe("warp-security cases in the corpus", () => {
  it("holds at least 12 text cases, the Spec 39 publication floor", async () => {
    expect((await warpCases()).length).toBeGreaterThanOrEqual(12);
  });

  it("keeps every case synthetic: nothing in it looks like a secret", async () => {
    for (const evalCase of await warpCases()) {
      expect(redactSecrets(evalCase.description)).toBe(evalCase.description);
    }
  });

  it("withholds the verdict from the model on judgment and judge-scored cases", async () => {
    const withheld = (await warpCases()).filter(
      (c) =>
        c.tags.includes(JUDGMENT_CASE_TAG) || c.tags.includes(JUDGE_SCORED_TAG),
    );
    expect(withheld.length).toBeGreaterThanOrEqual(10);

    for (const evalCase of withheld) {
      const message = messageFor(evalCase);
      expect(evalCase.description).not.toMatch(/\b(?:APPROVE|BLOCK)\b/);
      expect(message).not.toContain(evalCase.expected_outcome.description);
      expect(message).not.toMatch(/security_verdict_(?:approve|block)/);
    }
  });
});

describe("judge-scored warp-security cases", () => {
  async function judgeScored(): Promise<WarpCaseFile[]> {
    return (await warpCases()).filter((c) => c.tags.includes(JUDGE_SCORED_TAG));
  }

  it("asks for a block on each, naming the vulnerability the review must find", async () => {
    const cases = await judgeScored();
    expect(cases.length).toBeGreaterThanOrEqual(6);

    for (const evalCase of cases) {
      expect(evalCase.tags).not.toContain(JUDGMENT_CASE_TAG);
      expect(evalCase.expected_outcome.kind).toBe("task_completion");
      expect(evalCase.expected_outcome.required_artifacts).toEqual([]);
      expect(evalCase.expected_outcome.description).toMatch(
        /^Block the change: /,
      );
      expect(evalCase.expected_outcome.description).toContain(
        "A blocking finding must identify",
      );
    }
  });

  it("gives the judge rubric notes that fail an approval and a block for the wrong reason", async () => {
    for (const evalCase of await judgeScored()) {
      const rubric = await Bun.file(
        `${evalsDir}/rubrics/warp-security/${evalCase.id}.json`,
      ).json();
      expect(rubric.scoring.required).toBe(true);
      expect(rubric.scoring.notes).toContain("Fail an APPROVE");
      expect(rubric.scoring.notes).toMatch(
        /Fail a BLOCK|Fail an APPROVE, including/,
      );
    }
  });
});

describe("judgment approvals in warp-security", () => {
  it("require an approval with no blockers, which a BLOCK answer cannot produce", async () => {
    const approvals = (await warpCases()).filter(
      (c) =>
        c.tags.includes(JUDGMENT_CASE_TAG) &&
        c.expected_outcome.required_artifacts.includes(
          "security_verdict_approve",
        ),
    );
    expect(approvals.length).toBeGreaterThanOrEqual(3);

    for (const evalCase of approvals) {
      expect(evalCase.expected_outcome.required_artifacts).toContain(
        "security_blocker_count_capped",
      );
    }
  });
});
