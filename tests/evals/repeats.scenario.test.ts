/**
 * Eval scenarios — repeating a case to measure how often it passes
 * (Spec 37, task 18.1).
 *
 * Bucket: evals. `weave eval run --repeat N` runs every selected case N times
 * per model. One run of a suite with two to five cases cannot tell a real
 * change from one flipped verdict; a pass rate over repeats can. The promises:
 *
 * - each case runs N times on each model, and every attempt is published as
 *   its own entry, numbered;
 * - the report gives a pass rate per case × model and per suite × model;
 * - an errored attempt (no scorable answer) is left out of the pass rate and
 *   counted on its own;
 * - a run without `--repeat` publishes exactly what it did before.
 *
 * Only the model and the judge are stubbed. The model answers in call order,
 * so a scenario scripts which repeat passes and which fails.
 */

import { describe, expect, it } from "bun:test";
import { ArtifactBundleWriter } from "../../packages/cli/src/evals/artifact-bundle.js";
import type { PublicReportBundle } from "../../packages/cli/src/evals/report-schema.js";
import {
  caseResult,
  EVAL_MODEL,
  FIXED_GIT_SHA,
  FIXED_TIMESTAMP,
  type FixtureSpec,
  filesUnder,
  provenanceManifest,
  runEvalSuite,
  runnerResult,
  type SuiteRunObservation,
  withBundleRoot,
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

const RIGHT_ROUTE = "RIGHT-ROUTE-ANSWER: → shuttle for the implementation.";
const WRONG_ROUTE = "WRONG-ROUTE-ANSWER: → pattern should plan this first.";

/** Four repeats: the second misses, the other three pass. */
const THREE_OF_FOUR = [RIGHT_ROUTE, WRONG_ROUTE, RIGHT_ROUTE, RIGHT_ROUTE];

function repeatRun(
  answers: string[],
  options: { repeat?: number; rawArtifacts?: boolean } = {},
): Promise<SuiteRunObservation> {
  return withEvalFixtures([CASE], (evalsRoot) =>
    runEvalSuite({
      evalsRoot,
      agent: "loom-routing",
      caseFilter: CASE.id,
      model: EVAL_MODEL,
      answers,
      rawArtifacts: options.rawArtifacts ?? false,
      ...(options.repeat !== undefined ? { repeat: options.repeat } : {}),
    }),
  );
}

function suiteOf(report: PublicReportBundle | null) {
  const suite = report?.suiteSummaries[0];
  if (suite === undefined) throw new Error("no suite summary was published");
  return suite;
}

describe("a maintainer repeats a case four times on one model", () => {
  it("asks the model four times", async () => {
    const run = await repeatRun(THREE_OF_FOUR, { repeat: 4 });

    expect(run.exitCode).toBe(0);
    expect(run.modelCalls.length).toBe(4);
  });

  it("publishes the case's pass rate on that model", async () => {
    const run = await repeatRun(THREE_OF_FOUR, { repeat: 4 });
    const suite = suiteOf(run.publicReport);

    expect(suite.repeats?.repeatCount).toBe(4);
    expect(suite.repeats?.models).toEqual([
      {
        modelId: EVAL_MODEL,
        attempts: 4,
        passed: 3,
        failed: 1,
        errored: 0,
        passRate: 0.75,
        cases: [
          {
            caseId: CASE.id,
            attempts: 4,
            passed: 3,
            failed: 1,
            errored: 0,
            passRate: 0.75,
          },
        ],
      },
    ]);
  });

  it("publishes every attempt as its own numbered entry, in the order it ran", async () => {
    const run = await repeatRun(THREE_OF_FOUR, { repeat: 4 });
    const suite = suiteOf(run.publicReport);

    expect(suite.cases.map((entry) => [entry.attempt, entry.passed])).toEqual([
      [1, true],
      [2, false],
      [3, true],
      [4, true],
    ]);
    expect(run.cases.map((row) => row.attempt)).toEqual([1, 2, 3, 4]);
  });

  it("says in the report that its counts are attempts", async () => {
    const run = await repeatRun(THREE_OF_FOUR, { repeat: 4 });

    expect(run.publicReport?.runSummary).toMatchObject({
      totalCases: 4,
      passedCases: 3,
      failedCases: 1,
      repeatCount: 4,
    });
    expect(run.scoreFile?.repeatCount).toBe(4);
  });

  it("shows the pass rates and the attempt that missed in the Markdown report", async () => {
    const run = await repeatRun(THREE_OF_FOUR, { repeat: 4 });

    expect(run.markdown).toContain("each case ran 4 times per model");
    expect(run.markdown).toContain(`| ${EVAL_MODEL} | 3/4 (75%) | 0 |`);
    expect(run.markdown).toContain(
      `| ${CASE.id} | ${EVAL_MODEL} | 3/4 (75%) | 0 |`,
    );
    expect(run.markdown).toContain("Attempts that did not pass:");
    expect(run.markdown).toMatch(
      new RegExp(`\\| ${CASE.id} \\| [^|]+ \\| 2 \\| ❌ fail \\|`),
    );
  });

  it("marks the dashboard indexes as repeated, so their counts read as attempts", async () => {
    const run = await repeatRun(THREE_OF_FOUR, { repeat: 4 });
    const manifest = run.indexes["dashboard-manifest.json"] as {
      runs: Array<{ repeatCount?: number; totalCases: number }>;
    };
    const history = run.indexes["suite-history-loom-routing.json"] as {
      history: Array<{ repeatCount?: number; passRate: number | null }>;
    };
    const latest = run.indexes["latest.json"] as { repeatCount?: number };

    expect(manifest.runs[0]).toMatchObject({ repeatCount: 4, totalCases: 4 });
    expect(history.history[0]).toMatchObject({
      repeatCount: 4,
      passRate: 0.75,
    });
    expect(latest.repeatCount).toBe(4);
  });

  it("counts the case once per model in the scenario history, as failed while any repeat fails", async () => {
    const run = await repeatRun(THREE_OF_FOUR, { repeat: 4 });
    const scenarios = run.indexes["scenario-history-loom-routing.json"] as {
      scenarios: Array<{ lastRuns: Array<Record<string, unknown>> }>;
    };

    expect(scenarios.scenarios[0]?.lastRuns[0]).toMatchObject({
      totalModels: 1,
      passedModels: 0,
      failedModels: 1,
      status: "fail",
    });
  });

  it("prints the pass rate and the breakdown of the attempt that missed", async () => {
    const run = await repeatRun(THREE_OF_FOUR, { repeat: 4 });

    expect(run.stdout).toContain(
      "4 attempts (each case 4 times per model), 3 passed, 1 failed",
    );
    expect(run.stdout).toContain(
      `FLAKY  3/4 passed  ${CASE.id} on ${EVAL_MODEL}`,
    );
    expect(run.stdout).toMatch(/Attempt 2: FAIL {2}weighted total/);
    expect(run.stdout).toMatch(/✗ routingCorrectness\s+0\.00/);
    expect(run.stdout).not.toContain("Attempt 1:");
  });

  it("keeps a raw transcript for every attempt, none overwriting another", async () => {
    const run = await repeatRun(THREE_OF_FOUR, {
      repeat: 4,
      rawArtifacts: true,
    });
    const rawFiles = run.files.filter((file) => file.includes("/raw/case-"));

    expect(rawFiles.length).toBe(4);
    for (const attempt of [1, 2, 3, 4]) {
      expect(
        rawFiles.some((file) => file.includes(`-attempt${attempt}-`)),
      ).toBe(true);
    }
    const byAttempt = [...run.rawArtifacts].sort(
      (a, b) => (a.attempt ?? 0) - (b.attempt ?? 0),
    );
    expect(byAttempt.map((artifact) => artifact.rawContent)).toEqual(
      THREE_OF_FOUR,
    );
  });

  it("publishes nothing the model said", async () => {
    const run = await repeatRun(THREE_OF_FOUR, { repeat: 4 });

    // Positive first: the attempts were scored and published.
    expect(run.publicReport?.runSummary.totalCases).toBe(4);
    expect(run.publishedText).not.toContain("RIGHT-ROUTE-ANSWER");
    expect(run.publishedText).not.toContain("WRONG-ROUTE-ANSWER");
    expect(run.stdout).not.toContain("WRONG-ROUTE-ANSWER");
  });
});

describe("a maintainer repeats a case that passes every time", () => {
  it("prints PASS with the full count and no attempt breakdown", async () => {
    const run = await repeatRun([RIGHT_ROUTE], { repeat: 3 });

    expect(run.stdout).toContain(
      `PASS  3/3 passed  ${CASE.id} on ${EVAL_MODEL}`,
    );
    expect(run.stdout).not.toContain("Attempt ");
    expect(run.markdown).not.toContain("Attempts that did not pass:");
  });
});

describe("a maintainer runs without --repeat", () => {
  it("publishes no repeat fields, exactly as before repeats existed", async () => {
    const run = await repeatRun([RIGHT_ROUTE]);
    const suite = suiteOf(run.publicReport);

    expect(run.modelCalls.length).toBe(1);
    expect(run.publicReport?.runSummary).not.toHaveProperty("repeatCount");
    expect(suite).not.toHaveProperty("repeats");
    expect(suite.cases[0]).not.toHaveProperty("attempt");
    expect(run.scoreFile).not.toHaveProperty("repeatCount");
    expect(run.firstCase).not.toHaveProperty("attempt");
    expect(run.publishedText).not.toContain("repeatCount");
  });

  it("prints the single-run report unchanged", async () => {
    const run = await repeatRun([RIGHT_ROUTE]);

    expect(run.stdout).toContain("1 case, 1 passed, 0 failed");
    expect(run.stdout).toContain(`PASS  ${CASE.id} on ${EVAL_MODEL}`);
  });

  it("names raw transcripts without an attempt number", async () => {
    const run = await repeatRun([RIGHT_ROUTE], { rawArtifacts: true });
    const rawFiles = run.files.filter((file) => file.includes("/raw/case-"));

    expect(rawFiles.length).toBe(1);
    expect(rawFiles[0]).not.toContain("attempt");
  });
});

describe("a repeated case errors on some attempts", () => {
  /** Writes one repeated suite whose attempts are `outcomes`, in order. */
  async function writeRepeated(
    outcomes: Array<"pass" | "fail" | "errored">,
  ): Promise<PublicReportBundle> {
    return withBundleRoot(async (root) => {
      const caseResults = outcomes.map((outcome, index) =>
        caseResult({
          passed: outcome === "pass",
          attempt: index + 1,
          ...(outcome === "errored" ? { errored: true } : {}),
        }),
      );
      const result = await new ArtifactBundleWriter(root).writeBundle({
        runnerResults: [runnerResult({ caseResults })],
        provenanceManifest: provenanceManifest(),
        gitSha: FIXED_GIT_SHA,
        assembledAt: FIXED_TIMESTAMP,
        repeatCount: outcomes.length,
      });
      const written = result._unsafeUnwrap();
      const reportPath = (await filesUnder(written.bundleDir)).find((path) =>
        path.endsWith("/public-report.json"),
      );
      return (await Bun.file(reportPath ?? "").json()) as PublicReportBundle;
    });
  }

  it("leaves the errored attempts out of the pass rate and counts them apart", async () => {
    const report = await writeRepeated(["pass", "errored", "fail", "errored"]);
    const model = report.suiteSummaries[0]?.repeats?.models[0];

    expect(model).toMatchObject({
      attempts: 4,
      passed: 1,
      failed: 1,
      errored: 2,
      passRate: 0.5,
    });
  });

  it("publishes which attempts errored", async () => {
    const report = await writeRepeated(["pass", "errored", "fail"]);
    const cases = report.suiteSummaries[0]?.cases ?? [];

    expect(cases.map((entry) => entry.errored === true)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("gives no pass rate, rather than 0%, when every attempt errored", async () => {
    const report = await writeRepeated(["errored", "errored", "errored"]);
    const model = report.suiteSummaries[0]?.repeats?.models[0];

    expect(model?.passRate).toBeNull();
    expect(model?.errored).toBe(3);
  });
});
