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
    passed: false,
    required: true,
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
  return {
    metadata: {
      bunVersion: "1.3.10",
      repoSha: "abc1234",
      workflowRunId: null,
      agentFilter: null,
      modelFilter: null,
      modelSet: "default",
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
    failedCases: caseReports.length - passed,
    allSuitesGreen: passed === caseReports.length,
    bundleDir: "/work/eval-bundles/runs/abc1234-2026-09-23-001",
    runId: "abc1234-2026-09-23-001",
    filesWritten: [],
    rawArtifactsWritten: [],
    caseReports,
    repeatabilityDiagnostics: null,
    partialFailures: [],
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

  it("reports a run that wrote nothing without a bundle line or a hint", () => {
    const text = render(summary([], { runId: null }));

    expect(text).toContain("(no run written): 0 cases, 0 passed, 0 failed");
    expect(text).not.toContain("Bundle:");
    expect(text).not.toContain("--raw-artifacts");
  });
});
