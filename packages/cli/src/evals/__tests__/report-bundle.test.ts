/**
 * Unit tests for `report-bundle.ts` — the assembly steps no run directory shows.
 *
 * `assembleCaseEntry`, `assembleSuiteSummary` and `assemblePublicReportBundle`
 * are the projection behind `public-report.json`, so everything they promise is
 * readable in that file and is asserted in
 * [`tests/evals/bundle-writing.scenario.test.ts`](../../../../../tests/evals/bundle-writing.scenario.test.ts):
 * score buckets per band, the trajectory summary, a red suite, an empty suite,
 * and the XSS / injection policy of `docs/eval-xss-policy.md` — a hostile or
 * mis-sourced explanation is dropped while its case keeps its score.
 *
 * What stays here, and why: the **dashboard index manifests**
 * (`assembleDashboardManifest`, `buildDashboardEntry`,
 * `assembleModelComparisonManifest`, `appendSuiteHistoryPoint`). Those are
 * assembled for `dashboard-indexes.ts`, not for a run directory, and their
 * inputs (an existing manifest, an earlier history series) are state a single
 * bundle write never produces.
 *
 * Isolation: pure functions, inline fixtures, no I/O.
 */

import { describe, expect, it } from "bun:test";
import {
  appendSuiteHistoryPoint,
  assembleDashboardManifest,
  assembleModelComparisonManifest,
  assemblePublicReportBundle,
  buildDashboardEntry,
} from "../report-bundle.js";
import type { BundleScoreFile, EvalBundle } from "../types.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const FIXED_GIT_SHA = "abc123def456abc123def456abc123def456abc1";
const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

type ScoreRow = BundleScoreFile["results"][number];

function makeScoreRow(overrides: Partial<ScoreRow> = {}): ScoreRow {
  return {
    caseId: "route-to-shuttle",
    modelId: "anthropic/claude-sonnet-4.5",
    passed: true,
    required: true,
    weightedTotal: 0.95,
    dimensionScores: {
      routingCorrectness: { score: 1.0, applicable: true },
      delegationCorrectness: { score: 1.0, applicable: false },
      executionCompleteness: { score: 1.0, applicable: false },
      rationaleQuality: { score: 0.8, applicable: true },
    },
    scoredAt: FIXED_TIMESTAMP,
    dryRun: false,
    ...overrides,
  };
}

function makeBundleScoreFile(
  overrides: Partial<BundleScoreFile> = {},
): BundleScoreFile {
  return {
    suite: "loom-routing",
    gitSha: FIXED_GIT_SHA,
    assembledAt: FIXED_TIMESTAMP,
    dryRun: false,
    results: [makeScoreRow()],
    totals: {
      totalCases: 1,
      passedCases: 1,
      failedCases: 0,
      suiteGreen: true,
    },
    ...overrides,
  };
}

function makeEvalBundle(overrides: Partial<EvalBundle> = {}): EvalBundle {
  return {
    version: 1,
    gitSha: FIXED_GIT_SHA,
    assembledAt: FIXED_TIMESTAMP,
    dryRun: false,
    runSummary: {
      totalCases: 1,
      passedCases: 1,
      failedCases: 0,
      allSuitesGreen: true,
      suites: ["loom-routing"],
    },
    scoreFiles: [makeBundleScoreFile()],
    promptHashRecords: [],
    provenanceRef: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// assembleDashboardManifest — clean inputs
// ---------------------------------------------------------------------------

describe("assembleDashboardManifest (clean inputs)", () => {
  const newEntry = {
    runId: "abc1234-2026-01-01-001",
    assembledAt: FIXED_TIMESTAMP,
    gitSha: FIXED_GIT_SHA,
    dryRun: false,
    allSuitesGreen: true,
    totalCases: 5,
    passedCases: 5,
    failedCases: 0,
    suites: ["loom-routing"],
    bundleReportPath: "runs/v1/abc1234-2026-01-01-001/public-report.json",
  };

  it("returns ok for a valid manifest assembly", () => {
    const result = assembleDashboardManifest([], newEntry, FIXED_TIMESTAMP);
    expect(result.isOk()).toBe(true);
  });

  it("prepends new entry to the existing list", () => {
    const existing = [
      {
        ...newEntry,
        runId: "abc1234-2025-12-31-001",
        assembledAt: "2025-12-31T00:00:00.000Z",
        bundleReportPath: "runs/v1/abc1234-2025-12-31-001/public-report.json",
      },
    ];
    const result = assembleDashboardManifest(
      existing,
      newEntry,
      FIXED_TIMESTAMP,
    );
    const manifest = result._unsafeUnwrap();
    expect(manifest.runs.at(0)?.runId).toBe("abc1234-2026-01-01-001");
    expect(manifest.runs.at(1)?.runId).toBe("abc1234-2025-12-31-001");
  });

  it("recomputes totalRuns from the runs array length", () => {
    const result = assembleDashboardManifest(
      [
        {
          ...newEntry,
          runId: "old-001",
          bundleReportPath: "runs/v1/old-001/public-report.json",
        },
      ],
      newEntry,
      FIXED_TIMESTAMP,
    );
    expect(result._unsafeUnwrap().totalRuns).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// buildDashboardEntry
// ---------------------------------------------------------------------------

describe("buildDashboardEntry", () => {
  it("maps bundle fields to dashboard entry correctly", () => {
    const bundle = makeEvalBundle();
    const reportResult = assemblePublicReportBundle(
      bundle,
      "abc123d-2026-01-01-001",
    );
    const report = reportResult._unsafeUnwrap();
    const entry = buildDashboardEntry(
      report,
      "abc123d-2026-01-01-001",
      "runs/v1/abc123d-2026-01-01-001/public-report.json",
    );
    expect(entry.runId).toBe("abc123d-2026-01-01-001");
    expect(entry.gitSha).toBe(bundle.gitSha);
    expect(entry.dryRun).toBe(false);
    expect(entry.bundleReportPath).toBe(
      "runs/v1/abc123d-2026-01-01-001/public-report.json",
    );
  });
});

// ---------------------------------------------------------------------------
// assembleModelComparisonManifest — clean inputs
// ---------------------------------------------------------------------------

describe("assembleModelComparisonManifest (clean inputs)", () => {
  it("returns ok for a valid bundle", () => {
    const bundle = makeEvalBundle();
    const reportResult = assemblePublicReportBundle(
      bundle,
      "abc123d-2026-01-01-001",
    );
    const result = assembleModelComparisonManifest(
      reportResult._unsafeUnwrap(),
      "abc123d-2026-01-01-001",
    );
    expect(result.isOk()).toBe(true);
  });

  it("groups cases by modelId", () => {
    const bundle = makeEvalBundle({
      scoreFiles: [
        makeBundleScoreFile({
          results: [
            makeScoreRow({ modelId: "model-a", caseId: "c1", passed: true }),
            makeScoreRow({ modelId: "model-a", caseId: "c2", passed: false }),
            makeScoreRow({ modelId: "model-b", caseId: "c1", passed: true }),
          ],
          totals: {
            totalCases: 3,
            passedCases: 2,
            failedCases: 1,
            suiteGreen: false,
          },
        }),
      ],
      runSummary: {
        totalCases: 3,
        passedCases: 2,
        failedCases: 1,
        allSuitesGreen: false,
        suites: ["loom-routing"],
      },
    });
    const reportResult = assemblePublicReportBundle(
      bundle,
      "abc123d-2026-01-01-001",
    );
    const result = assembleModelComparisonManifest(
      reportResult._unsafeUnwrap(),
      "abc123d-2026-01-01-001",
    );
    const manifest = result._unsafeUnwrap();
    expect(manifest.models).toHaveLength(2);
    const modelA = manifest.models.find((m) => m.modelId === "model-a");
    expect(modelA?.totalCases).toBe(2);
    expect(modelA?.passedCases).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// appendSuiteHistoryPoint
// ---------------------------------------------------------------------------

describe("appendSuiteHistoryPoint", () => {
  const point = {
    assembledAt: FIXED_TIMESTAMP,
    gitSha: FIXED_GIT_SHA,
    runId: "abc123d-2026-01-01-001",
    totalCases: 5,
    passedCases: 4,
    suiteGreen: false,
    passRate: 0.8 as number | null,
  };

  it("creates a new history manifest when existing is null", () => {
    const result = appendSuiteHistoryPoint(
      null,
      "loom-routing",
      point,
      FIXED_TIMESTAMP,
    );
    expect(result.isOk()).toBe(true);
    const manifest = result._unsafeUnwrap();
    expect(manifest.history).toHaveLength(1);
    expect(manifest.suite).toBe("loom-routing");
  });

  it("appends to existing history", () => {
    const firstResult = appendSuiteHistoryPoint(
      null,
      "loom-routing",
      point,
      FIXED_TIMESTAMP,
    );
    const secondPoint = {
      ...point,
      runId: "abc123d-2026-01-02-001",
      assembledAt: "2026-01-02T00:00:00.000Z",
    };
    const result = appendSuiteHistoryPoint(
      firstResult._unsafeUnwrap(),
      "loom-routing",
      secondPoint,
      "2026-01-02T00:00:00.000Z",
    );
    expect(result._unsafeUnwrap().history).toHaveLength(2);
  });

  it("accepts null passRate for zero-case suites", () => {
    const result = appendSuiteHistoryPoint(
      null,
      "loom-routing",
      { ...point, totalCases: 0, passedCases: 0, passRate: null },
      FIXED_TIMESTAMP,
    );
    expect(result.isOk()).toBe(true);
  });
});
