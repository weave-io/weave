/**
 * Unit tests for `run-report.ts` — the text `weave eval run` prints after a
 * live run. The end-to-end promise (one case, one model, stubbed model and
 * judge) is covered by `tests/evals/diagnosis.scenario.test.ts`; these cover
 * the branches a single scenario does not reach.
 */

import { describe, expect, it } from "bun:test";
import { ThemeManager } from "../../theme/colors.js";
import { EvalRunReport } from "../run-report.js";
import type { CaseReport, EvalRunSummary } from "../runner.js";

const plain = new ThemeManager({ isTty: () => false }).getTheme(false);

function caseReport(overrides: Partial<CaseReport> = {}): CaseReport {
  return {
    suite: "pattern-planning",
    caseId: "pattern-plan-release-checklist",
    modelId: "deepseek/deepseek-v4-flash-0731",
    attempt: null,
    passed: false,
    errored: false,
    required: true,
    errorClassification: null,
    weightedTotal: 0.35,
    dimensionScores: {
      routingCorrectness: { score: 1, applicable: false },
      delegationCorrectness: { score: 1, applicable: false },
      executionCompleteness: { score: 0.5, applicable: true },
      rationaleQuality: { score: 0.9, applicable: true },
    },
    publicExplanation: null,
    rawArtifactPath: null,
    rawArtifactMissing: null,
    ...overrides,
  };
}

function summary(
  caseReports: CaseReport[],
  overrides: Partial<EvalRunSummary> = {},
  metadata: Partial<EvalRunSummary["metadata"]> = {},
): EvalRunSummary {
  const passed = caseReports.filter((c) => c.passed).length;
  const errored = caseReports.filter((c) => c.errored).length;
  return {
    metadata: {
      bunVersion: "1.3.10",
      repoSha: "abc1234",
      workflowRunId: null,
      agentFilter: null,
      modelFilter: null,
      modelSet: "default",
      repeatCount: 1,
      caseFilter: null,
      rawArtifactsEnabled: false,
      publishMode: "local",
      startedAt: "2026-09-23T00:00:00.000Z",
      ...metadata,
    },
    agentRollups: [],
    modelRollups: [],
    totalCases: caseReports.length,
    passedCases: passed,
    failedCases: caseReports.length - passed - errored,
    erroredCases: errored,
    allSuitesGreen: passed === caseReports.length,
    bundleDir: "/work/eval-bundles/runs/abc1234-2026-09-23-001",
    runId: "abc1234-2026-09-23-001",
    filesWritten: [],
    rawArtifactsWritten: [],
    caseReports,
    repeatabilityDiagnostics: null,
    partialFailures: [],
    erroredSuites: [],
    ...overrides,
  };
}

const render = (s: EvalRunSummary) => new EvalRunReport(plain).render(s);

describe("EvalRunReport", () => {
  it("marks a dimension that meets its bar with ✓ and one below it with ✗", () => {
    const text = render(summary([caseReport()]));

    expect(text).toMatch(/✗ executionCompleteness\s+0\.50\s+below 0\.95/);
    expect(text).toMatch(/✓ rationaleQuality\s+0\.90/);
  });

  it("labels an optional case as optional", () => {
    const text = render(summary([caseReport({ required: false })]));

    expect(text).toContain("(pattern-planning, optional)");
  });

  it("prints the public explanation of a failed case when there is one", () => {
    const text = render(
      summary([caseReport({ publicExplanation: "missing acceptance" })]),
    );

    expect(text).toContain("Why: missing acceptance");
  });

  it("says a publish-mode run was sent to the results repository", () => {
    const text = render(
      summary([caseReport()], {}, { publishMode: "publish" }),
    );

    expect(text).toContain("publish mode: sent to the results repository");
    expect(text).not.toContain("nothing was published");
  });

  it("omits the --raw-artifacts hint when raw artifacts were written", () => {
    const text = render(
      summary(
        [caseReport({ rawArtifactPath: "/work/raw/case.json" })],
        {},
        { rawArtifactsEnabled: true },
      ),
    );

    expect(text).toContain("Raw transcript: /work/raw/case.json");
    expect(text).not.toContain("--raw-artifacts");
  });

  it("says why a case has no transcript when --raw-artifacts was given and the write failed", () => {
    const text = render(
      summary(
        [caseReport({ rawArtifactMissing: "RawArtifactWriteError" })],
        {},
        { rawArtifactsEnabled: true },
      ),
    );

    expect(text).toContain(
      "Raw transcript: not written — writing it failed (RawArtifactWriteError)",
    );
  });

  it("says when the runner produced no raw artifact for a case", () => {
    const text = render(
      summary(
        [caseReport({ passed: true, rawArtifactMissing: "NotProduced" })],
        {},
        { rawArtifactsEnabled: true },
      ),
    );

    expect(text).toContain(
      "not written — the runner produced no raw artifact for this case",
    );
  });

  it("prints an errored case as ERROR, with its classification and no scores", () => {
    const text = render(
      summary([
        caseReport({
          errored: true,
          errorClassification: "model-truncated-response",
        }),
      ]),
    );

    expect(text).toContain(
      "ERROR pattern-plan-release-checklist on deepseek/deepseek-v4-flash-0731",
    );
    expect(text).toContain(
      "Not scored: model-truncated-response — the model reached its token cap before answering, each time it was asked",
    );
    expect(text).toContain("1 case, 0 passed, 0 failed, 1 errored");
    expect(text).not.toContain("FAIL");
    expect(text).not.toContain("Weighted total");
    expect(text).not.toContain("executionCompleteness");
  });

  it("describes an unrecognised or trajectory classification in general terms", () => {
    const text = render(
      summary([
        caseReport({
          errored: true,
          errorClassification: "trajectory-TrajectoryRunnerUnavailable",
        }),
        caseReport({
          caseId: "other",
          errored: true,
          errorClassification: null,
        }),
      ]),
    );

    expect(text).toContain("the harness trajectory could not run");
    expect(text).toContain("the case could not be run or scored");
  });

  it("still prints where an errored case's raw diagnostic was written", () => {
    const text = render(
      summary(
        [
          caseReport({
            errored: true,
            errorClassification: "model-empty-response",
            rawArtifactPath: "/work/raw/case.json",
          }),
        ],
        {},
        { rawArtifactsEnabled: true },
      ),
    );

    expect(text).toContain("Raw transcript: /work/raw/case.json");
  });

  it("reports a run that wrote nothing without a bundle line or a hint", () => {
    const text = render(summary([], { runId: null }));

    expect(text).toContain("(no run written): 0 cases, 0 passed, 0 failed");
    expect(text).not.toContain("Bundle:");
    expect(text).not.toContain("--raw-artifacts");
  });
});

describe("EvalRunReport — repeated run", () => {
  function repeated(outcomes: Array<"pass" | "fail" | "errored">): string {
    const reports = outcomes.map((outcome, index) =>
      caseReport({
        attempt: index + 1,
        passed: outcome === "pass",
        errored: outcome === "errored",
      }),
    );
    return new EvalRunReport(plain).render(
      summary(reports, {}, { repeatCount: outcomes.length }),
    );
  }

  it("says FAIL when no scored attempt passed", () => {
    expect(repeated(["fail", "fail"])).toContain("FAIL  0/2 passed");
  });

  it("says FLAKY when some attempts passed and some did not", () => {
    expect(repeated(["pass", "fail", "pass"])).toContain("FLAKY  2/3 passed");
  });

  it("says ERRORED when no attempt could be scored", () => {
    const text = repeated(["errored", "errored"]);
    expect(text).toContain("ERRORED  0/0 passed");
    expect(text).toContain("2 errored attempts left out of the pass rate");
    expect(text).toContain("Attempt 2: ERRORED (no scorable answer)");
  });

  it("leaves errored attempts out of the pass rate", () => {
    const text = repeated(["pass", "errored", "pass"]);
    expect(text).toContain("PASS  2/2 passed");
    expect(text).toContain("1 errored attempt left out of the pass rate");
  });
});

describe("EvalRunReport — cost per attempt (Spec 39 task 0.6)", () => {
  const rollup = (
    modelId: string,
    cost: EvalRunSummary["modelRollups"][number]["cost"],
  ): EvalRunSummary["modelRollups"][number] => ({
    modelId,
    totalCases: 4,
    passedCases: 4,
    failedCases: 0,
    erroredCases: 0,
    passRate: 1,
    cost,
  });

  it("prints each model's mean cost per attempt, model and judge calls separately", () => {
    const text = render(
      summary([caseReport()], {
        modelRollups: [
          rollup("openai/gpt-6-luna", {
            model: {
              attempts: 4,
              costed: 4,
              meanUsd: 0.00041,
              source: "provider",
            },
            judge: {
              attempts: 4,
              costed: 4,
              meanUsd: 0.00004,
              source: "provider",
            },
          }),
        ],
      }),
    );

    expect(text).toContain("Cost per attempt (mean):");
    expect(text).toContain("    openai/gpt-6-luna");
    expect(text).toContain("model calls  $0.000410 (reported by OpenRouter)");
    expect(text).toContain("judge calls  $0.0000400 (reported by OpenRouter)");
  });

  it("marks a mean that leaves out attempts without a recorded cost", () => {
    const text = render(
      summary([caseReport()], {
        modelRollups: [
          rollup("openai/gpt-6-luna", {
            model: { attempts: 4, costed: 3, meanUsd: 0.002, source: "prices" },
            judge: { attempts: 4, costed: 0, meanUsd: null, source: null },
          }),
        ],
      }),
    );

    expect(text).toContain(
      "model calls  $0.00200 (at matrix prices)  (no recorded cost for 1 of 4 attempts, left out of the mean)",
    );
    expect(text).toContain("judge calls  not recorded");
  });

  it("prints no cost section for a run that wrote no case reports", () => {
    const text = render(
      summary([], {
        modelRollups: [
          rollup("openai/gpt-6-luna", {
            model: { attempts: 0, costed: 0, meanUsd: null, source: null },
            judge: { attempts: 0, costed: 0, meanUsd: null, source: null },
          }),
        ],
      }),
    );

    expect(text).not.toContain("Cost per attempt");
  });
});

describe("EvalRunReport — cases that produced no score", () => {
  const NO_COST = {
    model: { attempts: 0, costed: 0, meanUsd: null, source: null },
    judge: { attempts: 0, costed: 0, meanUsd: null, source: null },
  } as const;
  const rollup = (
    modelId: string,
    erroredCases: number,
  ): EvalRunSummary["modelRollups"][number] => ({
    modelId,
    totalCases: 98,
    passedCases: 98 - erroredCases,
    failedCases: 0,
    erroredCases,
    passRate: 1,
    cost: NO_COST,
  });
  const WARNING = {
    suite: "warp-security",
    erroredCases: 1,
    message:
      '1 case in suite "warp-security" errored and was not scored (model-truncated-response ×1).',
  };

  it("names each suite with unscored cases and how many each model left unscored", () => {
    const text = render(
      summary([caseReport()], {
        erroredSuites: [WARNING],
        modelRollups: [
          rollup("deepseek/deepseek-v4-flash-0731", 1),
          rollup("openai/gpt-6-luna", 0),
        ],
      }),
    );

    expect(text).toContain("Not scored:");
    expect(text).toContain(`! ${WARNING.message}`);
    expect(text).toContain(
      "deepseek/deepseek-v4-flash-0731: 1 of 98 cases not scored",
    );
    expect(text).not.toContain("openai/gpt-6-luna: 0 of");
  });

  it("counts attempts, not cases, in a repeated run", () => {
    const text = render(
      summary(
        [caseReport()],
        {
          erroredSuites: [WARNING],
          modelRollups: [rollup("deepseek/deepseek-v4-flash-0731", 1)],
        },
        { repeatCount: 3 },
      ),
    );

    expect(text).toContain(
      "deepseek/deepseek-v4-flash-0731: 1 of 98 attempts not scored",
    );
  });

  it("prints no such section when every case was scored", () => {
    const text = render(summary([caseReport()]));

    expect(text).not.toContain("Not scored:");
  });
});
