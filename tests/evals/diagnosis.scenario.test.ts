/**
 * Eval scenarios — diagnosing one case on one model (Spec 37, task 17.2).
 *
 * Bucket: evals. The recipe is
 *
 *   weave eval run --agent <suite> --case <id> --model <id> --raw-artifacts
 *
 * and the promise is what it prints: the verdict, the scoring dimensions that
 * fell short with their scores, and where the raw transcript was written —
 * with nothing published and nothing from the transcript on the terminal.
 *
 * Only the model and the judge are stubbed; `stdout` is what the run reporter
 * `commands/eval.ts` hands to `buildEvalRunner` wrote to a buffer terminal.
 */

import { describe, expect, it } from "bun:test";
import { relative } from "node:path";
import {
  EVAL_MODEL,
  type FixtureSpec,
  runEvalSuite,
  type SuiteRunObservation,
  withEvalFixtures,
} from "../support/evals.js";

const CASE: FixtureSpec = {
  id: "loom-route-shuttle",
  suite: "loom-routing",
  description: "Route this backend API task.",
  allowedAgents: ["loom", "shuttle", "pattern", "thread"],
  expectedOutcome: { kind: "agent_routing", target_agent: "shuttle", via: [] },
  tags: ["routing"],
};

const WRONG_ROUTE = "WRONG-ROUTE-ANSWER: → pattern should plan this first.";
const RIGHT_ROUTE = "→ shuttle for the implementation.";
const JUDGE_RATIONALE = "JUDGE-RATIONALE-should-stay-in-the-raw-file";
const SYSTEM_PROMPT = "SYSTEM-PROMPT-should-stay-in-the-raw-file";

function diagnose(
  answer: string,
  options: { rawArtifacts: boolean },
): Promise<SuiteRunObservation> {
  return withEvalFixtures([CASE], (evalsRoot) =>
    runEvalSuite({
      evalsRoot,
      agent: "loom-routing",
      caseFilter: CASE.id,
      model: EVAL_MODEL,
      answers: [answer],
      systemPrompt: SYSTEM_PROMPT,
      judgeOutput: { score: 0.4, rationale: JUDGE_RATIONALE },
      rawArtifacts: options.rawArtifacts,
    }),
  );
}

describe("a maintainer diagnoses a failing case on one model", () => {
  it("prints the verdict for that case on that model", async () => {
    const run = await diagnose(WRONG_ROUTE, { rawArtifacts: true });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`FAIL  ${CASE.id} on ${EVAL_MODEL}`);
    expect(run.stdout).toContain("1 case, 0 passed, 1 failed");
  });

  it("names each dimension that fell short, with its score and its bar", async () => {
    const run = await diagnose(WRONG_ROUTE, { rawArtifacts: true });

    expect(run.stdout).toMatch(/✗ routingCorrectness\s+0\.00\s+below 0\.95/);
    expect(run.stdout).toMatch(/✗ rationaleQuality\s+0\.40\s+below 0\.70/);
    expect(run.stdout).toMatch(/Weighted total 0\.\d\d \(pass mark 0\.50\)/);
  });

  it("leaves out the dimensions that do not apply to the case", async () => {
    const run = await diagnose(WRONG_ROUTE, { rawArtifacts: true });

    expect(run.stdout).not.toContain("delegationCorrectness");
    expect(run.stdout).not.toContain("executionCompleteness");
  });

  it("prints where the raw transcript was written, and that file exists", async () => {
    const run = await diagnose(WRONG_ROUTE, { rawArtifacts: true });
    const printed = run.stdout.match(/Raw transcript: (\S+)/)?.[1];

    expect(printed).toBeDefined();
    const writtenTo = relative(run.bundleRoot, printed ?? "");
    expect(run.files).toContain(writtenTo);
    expect(writtenTo).toMatch(/\/raw\/case-loom-route-shuttle-/);
    expect(run.rawArtifacts[0]?.rawContent).toBe(WRONG_ROUTE);
  });

  it("says nothing was published", async () => {
    const run = await diagnose(WRONG_ROUTE, { rawArtifacts: true });

    expect(run.stdout).toContain("local only; nothing was published");
  });

  it("keeps the answer, the prompt and the judge's rationale off the terminal", async () => {
    const run = await diagnose(WRONG_ROUTE, { rawArtifacts: true });

    // Positive first: the run did score and report the case.
    expect(run.stdout).toContain(`FAIL  ${CASE.id}`);
    expect(run.stdout).not.toContain("WRONG-ROUTE-ANSWER");
    expect(run.stdout).not.toContain(SYSTEM_PROMPT);
    expect(run.stdout).not.toContain(JUDGE_RATIONALE);
  });
});

describe("a maintainer diagnoses a case without --raw-artifacts", () => {
  it("still prints the verdict and the dimensions that fell short", async () => {
    const run = await diagnose(WRONG_ROUTE, { rawArtifacts: false });

    expect(run.stdout).toContain(`FAIL  ${CASE.id} on ${EVAL_MODEL}`);
    expect(run.stdout).toMatch(/✗ routingCorrectness\s+0\.00/);
  });

  it("writes no raw transcript, and says how to keep one", async () => {
    const run = await diagnose(WRONG_ROUTE, { rawArtifacts: false });

    expect(run.rawArtifacts).toEqual([]);
    expect(run.stdout).not.toContain("Raw transcript:");
    expect(run.stdout).toContain("Re-run with --raw-artifacts");
  });
});

describe("a maintainer checks a case that passes", () => {
  it("prints PASS with the transcript path, and no dimension breakdown", async () => {
    const run = await diagnose(RIGHT_ROUTE, { rawArtifacts: true });

    expect(run.stdout).toContain(`PASS  ${CASE.id} on ${EVAL_MODEL}`);
    expect(run.stdout).toContain("Raw transcript: ");
    expect(run.stdout).not.toContain("✗");
    expect(run.stdout).not.toContain("✓");
  });
});

describe("a maintainer dry-runs the diagnosis first", () => {
  it("prints no run report, because nothing was scored", async () => {
    const run = await withEvalFixtures([CASE], (evalsRoot) =>
      runEvalSuite({
        evalsRoot,
        agent: "loom-routing",
        caseFilter: CASE.id,
        answers: [WRONG_ROUTE],
        dryRun: true,
        env: {},
      }),
    );

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
  });
});
