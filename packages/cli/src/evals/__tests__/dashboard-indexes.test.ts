/**
 * Tests for `dashboard-indexes.ts`.
 *
 * Verifies:
 *   - `generateDashboardIndexes()` is deterministic for fixed inputs.
 *   - `dashboard-manifest.json` runs are in newest-first order.
 *   - `suite-history-<suite>.json` history is in oldest-first order.
 *   - `model-comparison-<runId>.json` models are sorted alphabetically.
 *   - `last-N-runs.json` ordering and capping.
 *   - `latest.json` reflects the most-recent run.
 *   - Rebuild-from-runs produces identical index bytes for identical inputs.
 *   - Stale/schema-mismatch detection rejects incompatible index artifacts.
 *   - `DashboardIndexWriter.rebuildFromRuns()` writes correct file set.
 *   - Empty run list returns `IndexGenerationError`.
 *   - Missing or unreadable `public-report.json` files are silently skipped.
 *
 * Test isolation:
 *   - All I/O goes to `TEMP_DIR` (never the project directory).
 *   - No real git, network, model, or scorer calls.
 *   - All fixtures are constructed inline.
 *   - `updatedAtOverride` is always injected for deterministic timestamps.
 */

import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RUNS_SUBDIR } from "../artifact-bundle.js";
import {
  buildLastNRuns,
  buildLatestSnapshot,
  DASHBOARD_MANIFEST_FILE,
  DashboardIndexWriter,
  DEFAULT_LAST_N,
  generateDashboardIndexes,
  LAST_N_RUNS_FILE,
  LATEST_SNAPSHOT_FILE,
  LATEST_SNAPSHOT_SCHEMA_VERSION,
  MODEL_COMPARISON_FILE_PREFIX,
  type RunDescriptor,
  SUITE_HISTORY_FILE_PREFIX,
  validateDashboardManifestCompatibility,
  validateLatestSnapshotCompatibility,
  validatePublicReportBundleCompatibility,
  validateSuiteHistoryCompatibility,
} from "../dashboard-indexes.js";
import {
  DASHBOARD_MANIFEST_SCHEMA_VERSION,
  type PublicReportBundle,
} from "../report-schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEMP_DIR = tmpdir();

let _counter = 0;
function uid(): string {
  return String(Date.now()) + String(++_counter);
}

const FIXED_UPDATED_AT = "2026-01-20T10:00:00.000Z";
const FIXED_GIT_SHA_1 = "aaaaaaa0000000000000000000000000000000001";
const FIXED_GIT_SHA_2 = "bbbbbbb0000000000000000000000000000000002";
const FIXED_GIT_SHA_3 = "ccccccc0000000000000000000000000000000003";

/**
 * Build a minimal valid `PublicReportBundle` for testing.
 */
function makeBundle(
  overrides: {
    assembledAt?: string;
    gitSha?: string;
    dryRun?: boolean;
    allSuitesGreen?: boolean;
    totalCases?: number;
    passedCases?: number;
    failedCases?: number;
    suites?: string[];
    suiteSummaries?: PublicReportBundle["suiteSummaries"];
  } = {},
): PublicReportBundle {
  const totalCases = overrides.totalCases ?? 2;
  const passedCases = overrides.passedCases ?? 2;
  const failedCases = overrides.failedCases ?? 0;
  const suites = overrides.suites ?? ["loom-routing"];

  const suiteSummaries: PublicReportBundle["suiteSummaries"] =
    overrides.suiteSummaries ??
    suites.map((suite) => ({
      schemaVersion: 1 as const,
      suite,
      assembledAt: overrides.assembledAt ?? "2026-01-15T12:00:00.000Z",
      gitSha: overrides.gitSha ?? FIXED_GIT_SHA_1,
      totalCases: Math.floor(totalCases / suites.length),
      passedCases: Math.floor(passedCases / suites.length),
      failedCases: Math.floor(failedCases / suites.length),
      suiteGreen: overrides.allSuitesGreen ?? true,
      cases: [
        {
          caseId: "route-to-shuttle",
          modelId: "anthropic/claude-sonnet-4.5",
          suite,
          scoreBucket: "pass" as const,
          passed: true,
          required: true,
          dryRun: overrides.dryRun ?? false,
          scoredAt: overrides.assembledAt ?? "2026-01-15T12:00:00.000Z",
        },
        {
          caseId: "route-to-warp",
          modelId: "openai/gpt-4o",
          suite,
          scoreBucket: "pass" as const,
          passed: true,
          required: true,
          dryRun: overrides.dryRun ?? false,
          scoredAt: overrides.assembledAt ?? "2026-01-15T12:00:00.000Z",
        },
      ],
    }));

  return {
    schemaVersion: 1,
    assembledAt: overrides.assembledAt ?? "2026-01-15T12:00:00.000Z",
    gitSha: overrides.gitSha ?? FIXED_GIT_SHA_1,
    dryRun: overrides.dryRun ?? false,
    runSummary: {
      totalCases,
      passedCases,
      failedCases,
      allSuitesGreen: overrides.allSuitesGreen ?? true,
      suites,
    },
    suiteSummaries,
  };
}

/**
 * Build a set of run descriptors in newest-first order.
 */
function makeRuns(
  configs: Array<{
    runId: string;
    assembledAt: string;
    gitSha?: string;
    suites?: string[];
    allSuitesGreen?: boolean;
  }>,
): RunDescriptor[] {
  // Sort newest-first by assembledAt before returning
  const sorted = [...configs].sort((a, b) =>
    b.assembledAt.localeCompare(a.assembledAt),
  );
  return sorted.map(
    ({ runId, assembledAt, gitSha, suites, allSuitesGreen }) => ({
      runId,
      bundle: makeBundle({ assembledAt, gitSha, suites, allSuitesGreen }),
    }),
  );
}

// ---------------------------------------------------------------------------
// generateDashboardIndexes — empty input
// ---------------------------------------------------------------------------

describe("generateDashboardIndexes — empty input", () => {
  it("returns IndexGenerationError when runs is empty", () => {
    const result = generateDashboardIndexes([], FIXED_UPDATED_AT);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("IndexGenerationError");
  });
});

// ---------------------------------------------------------------------------
// generateDashboardIndexes — single run
// ---------------------------------------------------------------------------

describe("generateDashboardIndexes — single run", () => {
  const RUN_ID = "abc123d-2026-01-15-001";
  const ASSEMBLED_AT = "2026-01-15T12:00:00.000Z";

  function singleRun(): RunDescriptor[] {
    return [
      {
        runId: RUN_ID,
        bundle: makeBundle({
          assembledAt: ASSEMBLED_AT,
          gitSha: FIXED_GIT_SHA_1,
        }),
      },
    ];
  }

  it("returns ok(GeneratedIndexes) for a single run", () => {
    const result = generateDashboardIndexes(singleRun(), FIXED_UPDATED_AT);
    expect(result.isOk()).toBe(true);
  });

  it("dashboardManifest has totalRuns=1", () => {
    const indexes = generateDashboardIndexes(
      singleRun(),
      FIXED_UPDATED_AT,
    )._unsafeUnwrap();
    expect(indexes.dashboardManifest.totalRuns).toBe(1);
  });

  it("dashboardManifest.runs[0] has correct runId", () => {
    const indexes = generateDashboardIndexes(
      singleRun(),
      FIXED_UPDATED_AT,
    )._unsafeUnwrap();
    expect(indexes.dashboardManifest.runs[0]?.runId).toBe(RUN_ID);
  });

  it("dashboardManifest.updatedAt matches input", () => {
    const indexes = generateDashboardIndexes(
      singleRun(),
      FIXED_UPDATED_AT,
    )._unsafeUnwrap();
    expect(indexes.dashboardManifest.updatedAt).toBe(FIXED_UPDATED_AT);
  });

  it("dashboardManifest.schemaVersion is correct", () => {
    const indexes = generateDashboardIndexes(
      singleRun(),
      FIXED_UPDATED_AT,
    )._unsafeUnwrap();
    expect(indexes.dashboardManifest.schemaVersion).toBe(
      DASHBOARD_MANIFEST_SCHEMA_VERSION,
    );
  });

  it("dashboardManifest run entries use runs/v1/<runId>/ in bundleReportPath (versioned remote layout)", () => {
    const indexes = generateDashboardIndexes(
      singleRun(),
      FIXED_UPDATED_AT,
    )._unsafeUnwrap();
    const entry = indexes.dashboardManifest.runs[0]!;
    // Public consumer paths MUST include the remote layout version segment v1
    expect(entry.bundleReportPath).toBe(`runs/v1/${RUN_ID}/public-report.json`);
    expect(entry.bundleReportPath).toMatch(/^runs\/v1\//);
    // Must NOT be the bare runs/<runId>/ local path
    expect(entry.bundleReportPath).not.toBe(
      `runs/${RUN_ID}/public-report.json`,
    );
  });

  it("suiteHistories has one entry for the loom-routing suite", () => {
    const indexes = generateDashboardIndexes(
      singleRun(),
      FIXED_UPDATED_AT,
    )._unsafeUnwrap();
    expect(indexes.suiteHistories.has("loom-routing")).toBe(true);
    const history = indexes.suiteHistories.get("loom-routing")!;
    expect(history.history).toHaveLength(1);
  });

  it("suite history point has correct runId and assembledAt", () => {
    const indexes = generateDashboardIndexes(
      singleRun(),
      FIXED_UPDATED_AT,
    )._unsafeUnwrap();
    const history = indexes.suiteHistories.get("loom-routing")!;
    const point = history.history[0]!;
    expect(point.runId).toBe(RUN_ID);
    expect(point.assembledAt).toBe(ASSEMBLED_AT);
  });

  it("modelComparisons has one entry for the run", () => {
    const indexes = generateDashboardIndexes(
      singleRun(),
      FIXED_UPDATED_AT,
    )._unsafeUnwrap();
    expect(indexes.modelComparisons.has(RUN_ID)).toBe(true);
  });

  it("model comparison manifest has models sorted alphabetically", () => {
    const indexes = generateDashboardIndexes(
      singleRun(),
      FIXED_UPDATED_AT,
    )._unsafeUnwrap();
    const comparison = indexes.modelComparisons.get(RUN_ID)!;
    const modelIds = comparison.models.map((m) => m.modelId);
    const sorted = [...modelIds].sort();
    expect(modelIds).toEqual(sorted);
  });

  it("latestSnapshot reflects the single run", () => {
    const indexes = generateDashboardIndexes(
      singleRun(),
      FIXED_UPDATED_AT,
    )._unsafeUnwrap();
    expect(indexes.latestSnapshot.runId).toBe(RUN_ID);
    expect(indexes.latestSnapshot.assembledAt).toBe(ASSEMBLED_AT);
    expect(indexes.latestSnapshot.gitSha).toBe(FIXED_GIT_SHA_1);
    expect(indexes.latestSnapshot.schemaVersion).toBe(
      LATEST_SNAPSHOT_SCHEMA_VERSION,
    );
    expect(indexes.latestSnapshot.updatedAt).toBe(FIXED_UPDATED_AT);
  });

  it("lastNRuns has one entry for the single run", () => {
    const indexes = generateDashboardIndexes(
      singleRun(),
      FIXED_UPDATED_AT,
    )._unsafeUnwrap();
    expect(indexes.lastNRuns.count).toBe(1);
    expect(indexes.lastNRuns.runs[0]?.runId).toBe(RUN_ID);
  });
});

// ---------------------------------------------------------------------------
// generateDashboardIndexes — multiple runs, ordering
// ---------------------------------------------------------------------------

describe("generateDashboardIndexes — multiple runs ordering", () => {
  function threeRuns(): RunDescriptor[] {
    return makeRuns([
      {
        runId: "abc1234-2026-01-17-001",
        assembledAt: "2026-01-17T12:00:00.000Z",
        gitSha: FIXED_GIT_SHA_3,
      },
      {
        runId: "abc1234-2026-01-15-001",
        assembledAt: "2026-01-15T12:00:00.000Z",
        gitSha: FIXED_GIT_SHA_1,
      },
      {
        runId: "abc1234-2026-01-16-001",
        assembledAt: "2026-01-16T12:00:00.000Z",
        gitSha: FIXED_GIT_SHA_2,
      },
    ]);
  }

  it("dashboardManifest.runs is in newest-first order", () => {
    const indexes = generateDashboardIndexes(
      threeRuns(),
      FIXED_UPDATED_AT,
    )._unsafeUnwrap();
    const assembledAts = indexes.dashboardManifest.runs.map(
      (r) => r.assembledAt,
    );
    // Each entry must be >= the next (newest-first)
    for (let i = 0; i < assembledAts.length - 1; i++) {
      expect(assembledAts[i]! >= assembledAts[i + 1]!).toBe(true);
    }
  });

  it("dashboardManifest.runs[0] is the most recent run", () => {
    const indexes = generateDashboardIndexes(
      threeRuns(),
      FIXED_UPDATED_AT,
    )._unsafeUnwrap();
    expect(indexes.dashboardManifest.runs[0]?.runId).toBe(
      "abc1234-2026-01-17-001",
    );
  });

  it("dashboardManifest.totalRuns equals number of runs", () => {
    const indexes = generateDashboardIndexes(
      threeRuns(),
      FIXED_UPDATED_AT,
    )._unsafeUnwrap();
    expect(indexes.dashboardManifest.totalRuns).toBe(3);
  });

  it("suite history is in oldest-first order", () => {
    const indexes = generateDashboardIndexes(
      threeRuns(),
      FIXED_UPDATED_AT,
    )._unsafeUnwrap();
    const history = indexes.suiteHistories.get("loom-routing")!;
    const assembledAts = history.history.map((p) => p.assembledAt);
    // Each entry must be <= the next (oldest-first)
    for (let i = 0; i < assembledAts.length - 1; i++) {
      expect(assembledAts[i]! <= assembledAts[i + 1]!).toBe(true);
    }
  });

  it("suite history has one point per run", () => {
    const indexes = generateDashboardIndexes(
      threeRuns(),
      FIXED_UPDATED_AT,
    )._unsafeUnwrap();
    const history = indexes.suiteHistories.get("loom-routing")!;
    expect(history.history).toHaveLength(3);
  });

  it("latestSnapshot reflects the most-recent run", () => {
    const indexes = generateDashboardIndexes(
      threeRuns(),
      FIXED_UPDATED_AT,
    )._unsafeUnwrap();
    expect(indexes.latestSnapshot.runId).toBe("abc1234-2026-01-17-001");
    expect(indexes.latestSnapshot.assembledAt).toBe("2026-01-17T12:00:00.000Z");
  });

  it("lastNRuns.runs is in newest-first order", () => {
    const indexes = generateDashboardIndexes(
      threeRuns(),
      FIXED_UPDATED_AT,
    )._unsafeUnwrap();
    const assembledAts = indexes.lastNRuns.runs.map((r) => r.assembledAt);
    for (let i = 0; i < assembledAts.length - 1; i++) {
      expect(assembledAts[i]! >= assembledAts[i + 1]!).toBe(true);
    }
  });

  it("modelComparisons has one entry per run ID", () => {
    const indexes = generateDashboardIndexes(
      threeRuns(),
      FIXED_UPDATED_AT,
    )._unsafeUnwrap();
    expect(indexes.modelComparisons.size).toBe(3);
    expect(indexes.modelComparisons.has("abc1234-2026-01-17-001")).toBe(true);
    expect(indexes.modelComparisons.has("abc1234-2026-01-16-001")).toBe(true);
    expect(indexes.modelComparisons.has("abc1234-2026-01-15-001")).toBe(true);
  });

  it("each model comparison manifest has models sorted alphabetically", () => {
    const indexes = generateDashboardIndexes(
      threeRuns(),
      FIXED_UPDATED_AT,
    )._unsafeUnwrap();
    for (const [, comparison] of indexes.modelComparisons) {
      const modelIds = comparison.models.map((m) => m.modelId);
      const sorted = [...modelIds].sort();
      expect(modelIds).toEqual(sorted);
    }
  });
});

// ---------------------------------------------------------------------------
// generateDashboardIndexes — multi-suite runs
// ---------------------------------------------------------------------------

describe("generateDashboardIndexes — multi-suite runs", () => {
  function multiSuiteRuns(): RunDescriptor[] {
    return [
      {
        runId: "abc1234-2026-01-15-001",
        bundle: makeBundle({
          assembledAt: "2026-01-15T12:00:00.000Z",
          suites: ["loom-routing", "tapestry-execution"],
          suiteSummaries: [
            {
              schemaVersion: 1 as const,
              suite: "loom-routing",
              assembledAt: "2026-01-15T12:00:00.000Z",
              gitSha: FIXED_GIT_SHA_1,
              totalCases: 2,
              passedCases: 2,
              failedCases: 0,
              suiteGreen: true,
              cases: [
                {
                  caseId: "route-to-shuttle",
                  modelId: "anthropic/claude-sonnet-4.5",
                  suite: "loom-routing",
                  scoreBucket: "pass" as const,
                  passed: true,
                  required: true,
                  dryRun: false,
                  scoredAt: "2026-01-15T12:00:00.000Z",
                },
                {
                  caseId: "route-to-shuttle",
                  modelId: "openai/gpt-4o",
                  suite: "loom-routing",
                  scoreBucket: "pass" as const,
                  passed: true,
                  required: true,
                  dryRun: false,
                  scoredAt: "2026-01-15T12:00:00.000Z",
                },
              ],
            },
            {
              schemaVersion: 1 as const,
              suite: "tapestry-execution",
              assembledAt: "2026-01-15T12:00:00.000Z",
              gitSha: FIXED_GIT_SHA_1,
              totalCases: 2,
              passedCases: 1,
              failedCases: 1,
              suiteGreen: false,
              cases: [
                {
                  caseId: "exec-backend",
                  modelId: "anthropic/claude-sonnet-4.5",
                  suite: "tapestry-execution",
                  scoreBucket: "pass" as const,
                  passed: true,
                  required: true,
                  dryRun: false,
                  scoredAt: "2026-01-15T12:00:00.000Z",
                },
                {
                  caseId: "exec-backend",
                  modelId: "openai/gpt-4o",
                  suite: "tapestry-execution",
                  scoreBucket: "fail" as const,
                  passed: false,
                  required: true,
                  dryRun: false,
                  scoredAt: "2026-01-15T12:00:00.000Z",
                },
              ],
            },
          ],
        }),
      },
    ];
  }

  it("suiteHistories has entries for all suites", () => {
    const indexes = generateDashboardIndexes(
      multiSuiteRuns(),
      FIXED_UPDATED_AT,
    )._unsafeUnwrap();
    expect(indexes.suiteHistories.has("loom-routing")).toBe(true);
    expect(indexes.suiteHistories.has("tapestry-execution")).toBe(true);
  });

  it("model comparison manifest aligns per-suite pass rates", () => {
    const indexes = generateDashboardIndexes(
      multiSuiteRuns(),
      FIXED_UPDATED_AT,
    )._unsafeUnwrap();
    const comparison = indexes.modelComparisons.get("abc1234-2026-01-15-001")!;
    const claudeEntry = comparison.models.find(
      (m) => m.modelId === "anthropic/claude-sonnet-4.5",
    );
    const gptEntry = comparison.models.find(
      (m) => m.modelId === "openai/gpt-4o",
    );
    expect(claudeEntry).toBeDefined();
    expect(gptEntry).toBeDefined();
    // Claude passed in both suites
    expect(claudeEntry?.passedCases).toBe(2);
    // GPT passed in loom-routing but failed in tapestry-execution
    expect(gptEntry?.passedCases).toBe(1);
    // Per-suite rates
    expect(claudeEntry?.perSuitePassRates["loom-routing"]).toBe(1.0);
    expect(claudeEntry?.perSuitePassRates["tapestry-execution"]).toBe(1.0);
    expect(gptEntry?.perSuitePassRates["loom-routing"]).toBe(1.0);
    expect(gptEntry?.perSuitePassRates["tapestry-execution"]).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// generateDashboardIndexes — last-N ordering and capping
// ---------------------------------------------------------------------------

describe("generateDashboardIndexes — last-N ordering and capping", () => {
  function nineRuns(): RunDescriptor[] {
    return makeRuns(
      Array.from({ length: 9 }, (_, i) => ({
        runId: `abc1234-2026-01-${String(i + 1).padStart(2, "0")}-001`,
        assembledAt: `2026-01-${String(i + 1).padStart(2, "0")}T12:00:00.000Z`,
      })),
    );
  }

  it("lastNRuns.count is 9 when 9 runs and lastN=10", () => {
    const indexes = generateDashboardIndexes(
      nineRuns(),
      FIXED_UPDATED_AT,
      10,
    )._unsafeUnwrap();
    expect(indexes.lastNRuns.count).toBe(9);
  });

  it("lastNRuns.count is capped at lastN when runs exceed lastN", () => {
    const indexes = generateDashboardIndexes(
      nineRuns(),
      FIXED_UPDATED_AT,
      5,
    )._unsafeUnwrap();
    expect(indexes.lastNRuns.count).toBe(5);
    expect(indexes.lastNRuns.runs).toHaveLength(5);
  });

  it("lastNRuns.runs[0] is the most recent run (newest-first)", () => {
    const indexes = generateDashboardIndexes(
      nineRuns(),
      FIXED_UPDATED_AT,
      5,
    )._unsafeUnwrap();
    expect(indexes.lastNRuns.runs[0]?.assembledAt).toBe(
      "2026-01-09T12:00:00.000Z",
    );
  });

  it("lastNRuns.maxRuns reflects the lastN parameter", () => {
    const indexes = generateDashboardIndexes(
      nineRuns(),
      FIXED_UPDATED_AT,
      7,
    )._unsafeUnwrap();
    expect(indexes.lastNRuns.maxRuns).toBe(7);
  });

  it("dashboardManifest still contains all runs even when lastN is small", () => {
    const indexes = generateDashboardIndexes(
      nineRuns(),
      FIXED_UPDATED_AT,
      3,
    )._unsafeUnwrap();
    expect(indexes.dashboardManifest.totalRuns).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// generateDashboardIndexes — determinism
// ---------------------------------------------------------------------------

describe("generateDashboardIndexes — determinism", () => {
  it("is deterministic for identical inputs (identical JSON bytes)", () => {
    const runs = makeRuns([
      {
        runId: "abc1234-2026-01-17-001",
        assembledAt: "2026-01-17T12:00:00.000Z",
      },
      {
        runId: "abc1234-2026-01-15-001",
        assembledAt: "2026-01-15T12:00:00.000Z",
      },
    ]);

    const r1 = generateDashboardIndexes(runs, FIXED_UPDATED_AT);
    const r2 = generateDashboardIndexes(runs, FIXED_UPDATED_AT);

    const j1 = JSON.stringify(r1._unsafeUnwrap().dashboardManifest);
    const j2 = JSON.stringify(r2._unsafeUnwrap().dashboardManifest);
    expect(j1).toBe(j2);
  });

  it("suite history is deterministic for identical inputs", () => {
    const runs = makeRuns([
      {
        runId: "abc1234-2026-01-17-001",
        assembledAt: "2026-01-17T12:00:00.000Z",
      },
      {
        runId: "abc1234-2026-01-15-001",
        assembledAt: "2026-01-15T12:00:00.000Z",
      },
    ]);

    const r1 = generateDashboardIndexes(runs, FIXED_UPDATED_AT);
    const r2 = generateDashboardIndexes(runs, FIXED_UPDATED_AT);

    const h1 = JSON.stringify([...r1._unsafeUnwrap().suiteHistories]);
    const h2 = JSON.stringify([...r2._unsafeUnwrap().suiteHistories]);
    expect(h1).toBe(h2);
  });

  it("model comparisons are deterministic for identical inputs", () => {
    const runs = makeRuns([
      {
        runId: "abc1234-2026-01-17-001",
        assembledAt: "2026-01-17T12:00:00.000Z",
      },
    ]);

    const r1 = generateDashboardIndexes(runs, FIXED_UPDATED_AT);
    const r2 = generateDashboardIndexes(runs, FIXED_UPDATED_AT);

    const c1 = JSON.stringify([...r1._unsafeUnwrap().modelComparisons]);
    const c2 = JSON.stringify([...r2._unsafeUnwrap().modelComparisons]);
    expect(c1).toBe(c2);
  });
});

// ---------------------------------------------------------------------------
// buildLatestSnapshot
// ---------------------------------------------------------------------------

describe("buildLatestSnapshot", () => {
  const RUN_ID = "abc1234-2026-01-15-001";
  const ASSEMBLED_AT = "2026-01-15T12:00:00.000Z";

  it("produces correct schemaVersion", () => {
    const run: RunDescriptor = {
      runId: RUN_ID,
      bundle: makeBundle({ assembledAt: ASSEMBLED_AT }),
    };
    const snapshot = buildLatestSnapshot(run, FIXED_UPDATED_AT);
    expect(snapshot.schemaVersion).toBe(LATEST_SNAPSHOT_SCHEMA_VERSION);
  });

  it("embeds the correct runId", () => {
    const run: RunDescriptor = {
      runId: RUN_ID,
      bundle: makeBundle({ assembledAt: ASSEMBLED_AT }),
    };
    const snapshot = buildLatestSnapshot(run, FIXED_UPDATED_AT);
    expect(snapshot.runId).toBe(RUN_ID);
  });

  it("embeds updatedAt", () => {
    const run: RunDescriptor = {
      runId: RUN_ID,
      bundle: makeBundle({ assembledAt: ASSEMBLED_AT }),
    };
    const snapshot = buildLatestSnapshot(run, FIXED_UPDATED_AT);
    expect(snapshot.updatedAt).toBe(FIXED_UPDATED_AT);
  });
});

// ---------------------------------------------------------------------------
// buildLastNRuns
// ---------------------------------------------------------------------------

describe("buildLastNRuns", () => {
  it("returns schemaVersion 1", () => {
    const runs = makeRuns([
      { runId: "r1", assembledAt: "2026-01-15T12:00:00.000Z" },
    ]);
    const index = buildLastNRuns(runs, 10, FIXED_UPDATED_AT);
    expect(index.schemaVersion).toBe(1);
  });

  it("caps at maxRuns when more runs are provided", () => {
    const runs = makeRuns(
      Array.from({ length: 15 }, (_, i) => ({
        runId: `r${i}`,
        assembledAt: `2026-01-${String(i + 1).padStart(2, "0")}T12:00:00.000Z`,
      })),
    );
    const index = buildLastNRuns(runs, 10, FIXED_UPDATED_AT);
    expect(index.runs).toHaveLength(10);
    expect(index.count).toBe(10);
    expect(index.maxRuns).toBe(10);
  });

  it("does not cap when fewer runs than maxRuns", () => {
    const runs = makeRuns([
      { runId: "r1", assembledAt: "2026-01-15T12:00:00.000Z" },
      { runId: "r2", assembledAt: "2026-01-14T12:00:00.000Z" },
    ]);
    const index = buildLastNRuns(runs, 10, FIXED_UPDATED_AT);
    expect(index.runs).toHaveLength(2);
    expect(index.count).toBe(2);
  });

  it("preserves newest-first order from input", () => {
    const runs = makeRuns([
      { runId: "r-jan17", assembledAt: "2026-01-17T12:00:00.000Z" },
      { runId: "r-jan15", assembledAt: "2026-01-15T12:00:00.000Z" },
      { runId: "r-jan16", assembledAt: "2026-01-16T12:00:00.000Z" },
    ]);
    // After makeRuns sort: newest-first [jan17, jan16, jan15]
    const index = buildLastNRuns(runs, 10, FIXED_UPDATED_AT);
    expect(index.runs[0]?.assembledAt).toBe("2026-01-17T12:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Stale / schema-version detection
// ---------------------------------------------------------------------------

describe("validateDashboardManifestCompatibility", () => {
  it("returns ok for a valid manifest with correct schemaVersion", () => {
    const validManifest = {
      schemaVersion: DASHBOARD_MANIFEST_SCHEMA_VERSION,
      updatedAt: FIXED_UPDATED_AT,
      totalRuns: 0,
      runs: [],
    };
    const result = validateDashboardManifestCompatibility(validManifest);
    expect(result.isOk()).toBe(true);
  });

  it("returns SchemaVersionMismatch when schemaVersion is wrong", () => {
    const raw = {
      schemaVersion: 999,
      updatedAt: FIXED_UPDATED_AT,
      totalRuns: 0,
      runs: [],
    };
    const result = validateDashboardManifestCompatibility(raw);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("SchemaVersionMismatch");
    if (error.type === "SchemaVersionMismatch") {
      expect(error.foundVersion).toBe(999);
      expect(error.expectedVersion).toBe(DASHBOARD_MANIFEST_SCHEMA_VERSION);
    }
  });

  it("returns SchemaVersionMismatch when schemaVersion is missing", () => {
    const raw = { updatedAt: FIXED_UPDATED_AT, totalRuns: 0, runs: [] };
    const result = validateDashboardManifestCompatibility(raw);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("SchemaVersionMismatch");
  });

  it("returns SchemaVersionMismatch for null input", () => {
    const result = validateDashboardManifestCompatibility(null);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("SchemaVersionMismatch");
  });

  it("returns IndexParseError when schema validation fails despite correct version", () => {
    const raw = {
      schemaVersion: DASHBOARD_MANIFEST_SCHEMA_VERSION,
      // Missing required fields
    };
    const result = validateDashboardManifestCompatibility(raw);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("IndexParseError");
  });
});

describe("validateSuiteHistoryCompatibility", () => {
  it("returns ok for a valid suite history manifest", () => {
    const validHistory = {
      schemaVersion: 1,
      suite: "loom-routing",
      updatedAt: FIXED_UPDATED_AT,
      history: [],
    };
    const result = validateSuiteHistoryCompatibility(
      validHistory,
      "loom-routing",
    );
    expect(result.isOk()).toBe(true);
  });

  it("returns SchemaVersionMismatch for wrong version", () => {
    const raw = {
      schemaVersion: 42,
      suite: "loom-routing",
      updatedAt: FIXED_UPDATED_AT,
      history: [],
    };
    const result = validateSuiteHistoryCompatibility(raw, "loom-routing");
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("SchemaVersionMismatch");
    if (error.type === "SchemaVersionMismatch") {
      expect(error.foundVersion).toBe(42);
    }
  });

  it("returns SchemaVersionMismatch when schemaVersion is missing", () => {
    const result = validateSuiteHistoryCompatibility(
      { suite: "loom-routing" },
      "loom-routing",
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("SchemaVersionMismatch");
  });
});

describe("validateLatestSnapshotCompatibility", () => {
  it("returns ok for a valid latest snapshot", () => {
    const validSnapshot = {
      schemaVersion: LATEST_SNAPSHOT_SCHEMA_VERSION,
      updatedAt: FIXED_UPDATED_AT,
      runId: "abc1234-2026-01-15-001",
      assembledAt: "2026-01-15T12:00:00.000Z",
      gitSha: FIXED_GIT_SHA_1,
      dryRun: false,
      allSuitesGreen: true,
      totalCases: 2,
      passedCases: 2,
      failedCases: 0,
      suites: ["loom-routing"],
    };
    const result = validateLatestSnapshotCompatibility(validSnapshot);
    expect(result.isOk()).toBe(true);
  });

  it("returns SchemaVersionMismatch for wrong version", () => {
    const raw = { schemaVersion: 999, updatedAt: FIXED_UPDATED_AT };
    const result = validateLatestSnapshotCompatibility(raw);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("SchemaVersionMismatch");
    if (error.type === "SchemaVersionMismatch") {
      expect(error.foundVersion).toBe(999);
    }
  });

  it("returns SchemaVersionMismatch when schemaVersion is missing", () => {
    const result = validateLatestSnapshotCompatibility({
      updatedAt: FIXED_UPDATED_AT,
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("SchemaVersionMismatch");
  });

  it("returns IndexParseError when required fields are missing", () => {
    const raw = {
      schemaVersion: LATEST_SNAPSHOT_SCHEMA_VERSION,
      updatedAt: FIXED_UPDATED_AT,
      // Missing all data fields
    };
    const result = validateLatestSnapshotCompatibility(raw);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("IndexParseError");
  });
});

describe("validatePublicReportBundleCompatibility", () => {
  it("returns ok for a valid public report bundle", () => {
    const bundle = makeBundle({ assembledAt: "2026-01-15T12:00:00.000Z" });
    const result = validatePublicReportBundleCompatibility(
      bundle,
      "abc1234-2026-01-15-001",
    );
    expect(result.isOk()).toBe(true);
  });

  it("returns SchemaVersionMismatch for wrong version", () => {
    const raw = { schemaVersion: 42 };
    const result = validatePublicReportBundleCompatibility(
      raw,
      "abc1234-2026-01-15-001",
    );
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("SchemaVersionMismatch");
    if (error.type === "SchemaVersionMismatch") {
      expect(error.foundVersion).toBe(42);
    }
  });

  it("returns SchemaVersionMismatch when schemaVersion is missing", () => {
    const result = validatePublicReportBundleCompatibility(
      {},
      "abc1234-2026-01-15-001",
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("SchemaVersionMismatch");
  });

  it("returns IndexParseError when schema validation fails", () => {
    const raw = {
      schemaVersion: 1,
      assembledAt: "bad",
      gitSha: "",
      dryRun: false,
    };
    const result = validatePublicReportBundleCompatibility(raw, "run1");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("IndexParseError");
  });
});

// ---------------------------------------------------------------------------
// DashboardIndexWriter — file I/O
// ---------------------------------------------------------------------------

describe("DashboardIndexWriter.rebuildFromRuns", () => {
  it("returns empty filesWritten when runs/ does not exist", async () => {
    const bundleRoot = resolve(TEMP_DIR, `idx-writer-nodir-${uid()}`);
    const writer = new DashboardIndexWriter(bundleRoot, FIXED_UPDATED_AT);
    const result = await writer.rebuildFromRuns();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().filesWritten).toHaveLength(0);
  });

  it("returns empty filesWritten when runs/ has no public-report.json files", async () => {
    const bundleRoot = resolve(TEMP_DIR, `idx-writer-empty-${uid()}`);
    // Create a runs dir with no report files
    await Bun.write(join(bundleRoot, RUNS_SUBDIR, "some-run-001", ".keep"), "");
    const writer = new DashboardIndexWriter(bundleRoot, FIXED_UPDATED_AT);
    const result = await writer.rebuildFromRuns();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().filesWritten).toHaveLength(0);
  });

  it("writes dashboard-manifest.json for a single run", async () => {
    const bundleRoot = resolve(TEMP_DIR, `idx-writer-single-${uid()}`);
    const runId = "abc123d-2026-01-15-001";
    const runDir = join(bundleRoot, RUNS_SUBDIR, runId);

    // Write a minimal valid public-report.json
    const bundle = makeBundle({ assembledAt: "2026-01-15T12:00:00.000Z" });
    await Bun.write(
      join(runDir, "public-report.json"),
      JSON.stringify(bundle, null, 2),
    );

    const writer = new DashboardIndexWriter(bundleRoot, FIXED_UPDATED_AT);
    const result = await writer.rebuildFromRuns();
    expect(result.isOk()).toBe(true);
    const { filesWritten } = result._unsafeUnwrap();
    expect(filesWritten).toContain(DASHBOARD_MANIFEST_FILE);
    expect(filesWritten).toContain(LATEST_SNAPSHOT_FILE);
    expect(filesWritten).toContain(LAST_N_RUNS_FILE);
    expect(
      filesWritten.some((f) => f.startsWith(SUITE_HISTORY_FILE_PREFIX)),
    ).toBe(true);
    expect(
      filesWritten.some((f) => f.startsWith(MODEL_COMPARISON_FILE_PREFIX)),
    ).toBe(true);
  });

  it("dashboard-manifest.json content is valid JSON with correct schemaVersion", async () => {
    const bundleRoot = resolve(TEMP_DIR, `idx-writer-manifest-${uid()}`);
    const runId = "abc123d-2026-01-15-001";
    const runDir = join(bundleRoot, RUNS_SUBDIR, runId);

    const bundle = makeBundle({ assembledAt: "2026-01-15T12:00:00.000Z" });
    await Bun.write(
      join(runDir, "public-report.json"),
      JSON.stringify(bundle, null, 2),
    );

    const writer = new DashboardIndexWriter(bundleRoot, FIXED_UPDATED_AT);
    await writer.rebuildFromRuns();

    const manifestPath = join(bundleRoot, DASHBOARD_MANIFEST_FILE);
    const content = await Bun.file(manifestPath).json();
    expect(content.schemaVersion).toBe(DASHBOARD_MANIFEST_SCHEMA_VERSION);
    expect(content.totalRuns).toBe(1);
    expect(content.runs[0]?.runId).toBe(runId);
  });

  it("dashboard-manifest.json run entries use runs/v1/<runId>/ in bundleReportPath (not runs/<runId>/)", async () => {
    const bundleRoot = resolve(TEMP_DIR, `idx-writer-runpath-${uid()}`);
    const runId = "abc123d-2026-01-15-001";
    const runDir = join(bundleRoot, RUNS_SUBDIR, runId);

    const bundle = makeBundle({ assembledAt: "2026-01-15T12:00:00.000Z" });
    await Bun.write(
      join(runDir, "public-report.json"),
      JSON.stringify(bundle, null, 2),
    );

    const writer = new DashboardIndexWriter(bundleRoot, FIXED_UPDATED_AT);
    await writer.rebuildFromRuns();

    const manifestPath = join(bundleRoot, DASHBOARD_MANIFEST_FILE);
    const content = await Bun.file(manifestPath).json();
    const runEntry = content.runs[0];

    // Public consumer paths in dashboard-manifest.json MUST use runs/v1/<runId>/...
    // NOT the bare runs/<runId>/ local filesystem path.
    expect(runEntry?.bundleReportPath).toBe(
      `runs/v1/${runId}/public-report.json`,
    );
    expect(runEntry?.bundleReportPath).not.toContain("runs/abc123d");
    // Verify the v1 layout version prefix is present
    expect(runEntry?.bundleReportPath).toMatch(/^runs\/v1\//);
  });

  it("writes one model-comparison file per run", async () => {
    const bundleRoot = resolve(TEMP_DIR, `idx-writer-mc-${uid()}`);
    const runId1 = "abc123d-2026-01-15-001";
    const runId2 = "abc123d-2026-01-16-001";

    for (const [runId, date] of [
      [runId1, "2026-01-15"],
      [runId2, "2026-01-16"],
    ] as const) {
      const runDir = join(bundleRoot, RUNS_SUBDIR, runId);
      const bundle = makeBundle({ assembledAt: `${date}T12:00:00.000Z` });
      await Bun.write(
        join(runDir, "public-report.json"),
        JSON.stringify(bundle, null, 2),
      );
    }

    const writer = new DashboardIndexWriter(bundleRoot, FIXED_UPDATED_AT);
    const result = await writer.rebuildFromRuns();
    expect(result.isOk()).toBe(true);
    const { filesWritten } = result._unsafeUnwrap();
    const mcFiles = filesWritten.filter((f) =>
      f.startsWith(MODEL_COMPARISON_FILE_PREFIX),
    );
    expect(mcFiles).toHaveLength(2);
  });

  it("silently skips run directories with invalid public-report.json", async () => {
    const bundleRoot = resolve(TEMP_DIR, `idx-writer-skip-${uid()}`);
    const goodRunId = "abc123d-2026-01-15-001";
    const badRunId = "abc123d-2026-01-14-001";

    // Good run: valid public-report.json
    const goodBundle = makeBundle({ assembledAt: "2026-01-15T12:00:00.000Z" });
    await Bun.write(
      join(bundleRoot, RUNS_SUBDIR, goodRunId, "public-report.json"),
      JSON.stringify(goodBundle, null, 2),
    );

    // Bad run: invalid JSON
    await Bun.write(
      join(bundleRoot, RUNS_SUBDIR, badRunId, "public-report.json"),
      "not-valid-json",
    );

    const writer = new DashboardIndexWriter(bundleRoot, FIXED_UPDATED_AT);
    const result = await writer.rebuildFromRuns();
    // Must succeed (bad run silently skipped)
    expect(result.isOk()).toBe(true);
    const manifestPath = join(bundleRoot, DASHBOARD_MANIFEST_FILE);
    const manifest = await Bun.file(manifestPath).json();
    // Only the good run is indexed
    expect(manifest.totalRuns).toBe(1);
    expect(manifest.runs[0]?.runId).toBe(goodRunId);
  });

  it("silently skips run directories with wrong schemaVersion in public-report.json", async () => {
    const bundleRoot = resolve(TEMP_DIR, `idx-writer-skipver-${uid()}`);
    const goodRunId = "abc123d-2026-01-15-001";
    const badRunId = "abc123d-2026-01-14-001";

    const goodBundle = makeBundle({ assembledAt: "2026-01-15T12:00:00.000Z" });
    await Bun.write(
      join(bundleRoot, RUNS_SUBDIR, goodRunId, "public-report.json"),
      JSON.stringify(goodBundle, null, 2),
    );

    // Bad run: wrong schemaVersion
    const badBundle = { ...goodBundle, schemaVersion: 999 };
    await Bun.write(
      join(bundleRoot, RUNS_SUBDIR, badRunId, "public-report.json"),
      JSON.stringify(badBundle, null, 2),
    );

    const writer = new DashboardIndexWriter(bundleRoot, FIXED_UPDATED_AT);
    const result = await writer.rebuildFromRuns();
    expect(result.isOk()).toBe(true);
    const manifestPath = join(bundleRoot, DASHBOARD_MANIFEST_FILE);
    const manifest = await Bun.file(manifestPath).json();
    expect(manifest.totalRuns).toBe(1);
    expect(manifest.runs[0]?.runId).toBe(goodRunId);
  });

  it("rebuild-from-runs produces identical index bytes for identical run artifacts", async () => {
    const bundleRoot = resolve(TEMP_DIR, `idx-writer-repro-${uid()}`);
    const runId = "abc123d-2026-01-15-001";
    const bundle = makeBundle({ assembledAt: "2026-01-15T12:00:00.000Z" });
    await Bun.write(
      join(bundleRoot, RUNS_SUBDIR, runId, "public-report.json"),
      JSON.stringify(bundle, null, 2),
    );

    // Write indexes twice (same updatedAt)
    const writer = new DashboardIndexWriter(bundleRoot, FIXED_UPDATED_AT);
    await writer.rebuildFromRuns();
    const manifest1 = await Bun.file(
      join(bundleRoot, DASHBOARD_MANIFEST_FILE),
    ).text();

    // Write again — must produce identical output
    await writer.rebuildFromRuns();
    const manifest2 = await Bun.file(
      join(bundleRoot, DASHBOARD_MANIFEST_FILE),
    ).text();

    expect(manifest1).toBe(manifest2);
  });

  it("latest.json has correct schemaVersion and updatedAt", async () => {
    const bundleRoot = resolve(TEMP_DIR, `idx-writer-latest-${uid()}`);
    const runId = "abc123d-2026-01-15-001";
    const bundle = makeBundle({ assembledAt: "2026-01-15T12:00:00.000Z" });
    await Bun.write(
      join(bundleRoot, RUNS_SUBDIR, runId, "public-report.json"),
      JSON.stringify(bundle, null, 2),
    );

    const writer = new DashboardIndexWriter(bundleRoot, FIXED_UPDATED_AT);
    await writer.rebuildFromRuns();

    const latestPath = join(bundleRoot, LATEST_SNAPSHOT_FILE);
    const content = await Bun.file(latestPath).json();
    expect(content.schemaVersion).toBe(LATEST_SNAPSHOT_SCHEMA_VERSION);
    expect(content.updatedAt).toBe(FIXED_UPDATED_AT);
    expect(content.runId).toBe(runId);
  });

  it("latest.json reflects the most-recent run when multiple runs exist", async () => {
    const bundleRoot = resolve(TEMP_DIR, `idx-writer-latest-multi-${uid()}`);
    const runs = [
      { runId: "abc123d-2026-01-17-001", date: "2026-01-17" },
      { runId: "abc123d-2026-01-15-001", date: "2026-01-15" },
    ];

    for (const { runId, date } of runs) {
      const bundle = makeBundle({ assembledAt: `${date}T12:00:00.000Z` });
      await Bun.write(
        join(bundleRoot, RUNS_SUBDIR, runId, "public-report.json"),
        JSON.stringify(bundle, null, 2),
      );
    }

    const writer = new DashboardIndexWriter(bundleRoot, FIXED_UPDATED_AT);
    await writer.rebuildFromRuns();

    const latestPath = join(bundleRoot, LATEST_SNAPSHOT_FILE);
    const content = await Bun.file(latestPath).json();
    // Most recent is jan17
    expect(content.runId).toBe("abc123d-2026-01-17-001");
    expect(content.assembledAt).toBe("2026-01-17T12:00:00.000Z");
  });

  it("suite-history file has oldest-first ordering", async () => {
    const bundleRoot = resolve(TEMP_DIR, `idx-writer-hist-order-${uid()}`);
    const runs = [
      { runId: "abc123d-2026-01-15-001", date: "2026-01-15" },
      { runId: "abc123d-2026-01-17-001", date: "2026-01-17" },
      { runId: "abc123d-2026-01-16-001", date: "2026-01-16" },
    ];

    for (const { runId, date } of runs) {
      const bundle = makeBundle({ assembledAt: `${date}T12:00:00.000Z` });
      await Bun.write(
        join(bundleRoot, RUNS_SUBDIR, runId, "public-report.json"),
        JSON.stringify(bundle, null, 2),
      );
    }

    const writer = new DashboardIndexWriter(bundleRoot, FIXED_UPDATED_AT);
    await writer.rebuildFromRuns();

    const histPath = join(
      bundleRoot,
      `${SUITE_HISTORY_FILE_PREFIX}loom-routing.json`,
    );
    const content = await Bun.file(histPath).json();
    const assembledAts: string[] = content.history.map(
      (p: { assembledAt: string }) => p.assembledAt,
    );
    // Must be oldest-first
    for (let i = 0; i < assembledAts.length - 1; i++) {
      expect(assembledAts[i]! <= assembledAts[i + 1]!).toBe(true);
    }
  });
});
