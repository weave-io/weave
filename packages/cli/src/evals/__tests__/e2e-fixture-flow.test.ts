/**
 * End-to-end fixture flow test.
 *
 * Exercises the full publish-then-index-then-render pipeline in a single
 * isolated temp directory, simulating what happens when the CI eval job:
 *
 *   1. Writes immutable run artifacts for two sequential runs.
 *   2. Regenerates derived dashboard indexes from those run artifacts.
 *   3. Validates all generated index files against schema compatibility
 *      validators (same checks the website JS loader performs at runtime).
 *   4. Simulates website ENDPOINT pattern checks: verifies that every URL
 *      the website would construct is either an exact allowlisted path or
 *      a suiteId/runId from the manifest allowlist, validated with isSafeId.
 *   5. Verifies immutable-run identity: public-report.json content is
 *      byte-for-byte stable across a second index rebuild.
 *   6. Verifies mutable-index freshness: a second rebuild with a later
 *      updatedAt timestamp changes updatedAt in all index files but does
 *      NOT change the immutable run artifact.
 *   7. Verifies stale-index rejection: an artificially old index with a
 *      wrong schemaVersion is rejected by the compatibility validators.
 *   8. Verifies XSS/leakage invariants: a malicious explanation injected
 *      into a RunnerResult is sanitized away before reaching public-report.json.
 *
 * Test isolation:
 *   - All file I/O goes to TEMP_DIR (never the project directory).
 *   - No real git, network, model, scorer, or runner calls.
 *   - No EVAL_RESULTS_REPO_TOKEN required (mode: "local" throughout).
 *   - All fixtures are constructed inline.
 *   - `updatedAtOverride` is always injected for deterministic timestamps.
 */

import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ArtifactBundleWriter,
  EVAL_RESULTS_REPO_TOKEN_ENV_VAR,
} from "../artifact-bundle.js";
import {
  DASHBOARD_MANIFEST_FILE,
  DashboardIndexWriter,
  LAST_N_RUNS_FILE,
  LATEST_SNAPSHOT_FILE,
  LATEST_SNAPSHOT_SCHEMA_VERSION,
  MODEL_COMPARISON_FILE_PREFIX,
  SUITE_HISTORY_FILE_PREFIX,
  validateDashboardManifestCompatibility,
  validateLatestSnapshotCompatibility,
  validatePublicReportBundleCompatibility,
  validateSuiteHistoryCompatibility,
} from "../dashboard-indexes.js";
import { DASHBOARD_MANIFEST_SCHEMA_VERSION } from "../report-schema.js";
import { assertJsonPublishSafe } from "../sanitizer.js";
import type {
  CaseResult,
  CaseResultSummary,
  RunnerResult,
  ScoringDimension,
} from "../types.js";

// ---------------------------------------------------------------------------
// Test directory helpers
// ---------------------------------------------------------------------------

const TEMP_DIR = tmpdir();
let _counter = 0;
function uid(): string {
  return String(Date.now()) + String(++_counter);
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const FIXED_GIT_SHA_1 = "aaa111bbb222ccc333ddd444eee555fff666aaa1";
const FIXED_GIT_SHA_2 = "bbb222ccc333ddd444eee555fff666aaa111bbb2";

const ASSEMBLED_AT_RUN1 = "2026-06-10T10:00:00.000Z";
const ASSEMBLED_AT_RUN2 = "2026-06-11T10:00:00.000Z";

const UPDATED_AT_FIRST_BUILD = "2026-06-11T12:00:00.000Z";
const UPDATED_AT_SECOND_BUILD = "2026-06-11T13:00:00.000Z";

// Allowlisted suite names that appear in the fixture
const KNOWN_SUITES = [
  "loom-routing",
  "tapestry-execution",
  "shuttle-execution",
  "spindle-tools",
  "pattern-planning",
  "weft-review",
  "warp-security",
] as const;

// Expected GitHub Raw base for ENDPOINTS check
const EXPECTED_ENDPOINT_BASE =
  "https://raw.githubusercontent.com/weave-io/weave-agent-evals/main";
const LEGACY_REPO = "pgermishuys/opencode-weave";

// ---------------------------------------------------------------------------
// Fixture builders (inline — no real runners, no model calls)
// ---------------------------------------------------------------------------

function makeDimensionScores(): Record<
  ScoringDimension,
  { score: number; applicable: boolean }
> {
  return {
    routingCorrectness: { score: 1.0, applicable: true },
    delegationCorrectness: { score: 1.0, applicable: false },
    executionCompleteness: { score: 1.0, applicable: false },
    rationaleQuality: { score: 0.8, applicable: true },
  };
}

function makeCaseResultSummary(
  caseId: string,
  modelId: string,
  suite: string,
  passed = true,
  scoredAt = ASSEMBLED_AT_RUN1,
): CaseResultSummary {
  return {
    caseId,
    modelId,
    suite,
    passed,
    required: true,
    weightedTotal: passed ? 0.9 : 0.1,
    dimensionScores: makeDimensionScores(),
    scoredAt,
    dryRun: false,
  };
}

function makeCaseResult(
  caseId: string,
  modelId: string,
  suite: string,
  passed = true,
  scoredAt = ASSEMBLED_AT_RUN1,
): CaseResult {
  return {
    summary: makeCaseResultSummary(caseId, modelId, suite, passed, scoredAt),
  };
}

function makeRunnerResult(
  suite: string,
  caseResults: CaseResult[],
  scoredAt = ASSEMBLED_AT_RUN1,
): RunnerResult {
  const passedCases = caseResults.filter((c) => c.summary.passed).length;
  const failedCases = caseResults.length - passedCases;
  return {
    suite,
    suiteGreen: failedCases === 0,
    caseResults,
    totalCases: caseResults.length,
    passedCases,
    failedCases,
    completedAt: scoredAt,
  };
}

/**
 * Build runner results for a two-suite, two-model evaluation run.
 * loom-routing: claude passes, gpt passes
 * tapestry-execution: claude passes, gpt fails
 */
function makeRun1Results(): RunnerResult[] {
  return [
    makeRunnerResult("loom-routing", [
      makeCaseResult(
        "route-to-shuttle",
        "anthropic/claude-sonnet-4.5",
        "loom-routing",
        true,
        ASSEMBLED_AT_RUN1,
      ),
      makeCaseResult(
        "route-to-warp",
        "anthropic/claude-sonnet-4.5",
        "loom-routing",
        true,
        ASSEMBLED_AT_RUN1,
      ),
      makeCaseResult(
        "route-to-shuttle",
        "openai/gpt-4o",
        "loom-routing",
        true,
        ASSEMBLED_AT_RUN1,
      ),
      makeCaseResult(
        "route-to-warp",
        "openai/gpt-4o",
        "loom-routing",
        true,
        ASSEMBLED_AT_RUN1,
      ),
    ]),
    makeRunnerResult("tapestry-execution", [
      makeCaseResult(
        "exec-backend",
        "anthropic/claude-sonnet-4.5",
        "tapestry-execution",
        true,
        ASSEMBLED_AT_RUN1,
      ),
      makeCaseResult(
        "exec-backend",
        "openai/gpt-4o",
        "tapestry-execution",
        false, // gpt fails tapestry
        ASSEMBLED_AT_RUN1,
      ),
    ]),
    makeRunnerResult("shuttle-execution", [
      makeCaseResult(
        "shuttle-report-structured",
        "anthropic/claude-sonnet-4.5",
        "shuttle-execution",
        true,
        ASSEMBLED_AT_RUN1,
      ),
      makeCaseResult(
        "shuttle-report-structured",
        "openai/gpt-4o",
        "shuttle-execution",
        true,
        ASSEMBLED_AT_RUN1,
      ),
    ]),
    makeRunnerResult("spindle-tools", [
      makeCaseResult(
        "spindle-citations-confidence",
        "anthropic/claude-sonnet-4.5",
        "spindle-tools",
        true,
        ASSEMBLED_AT_RUN1,
      ),
      makeCaseResult(
        "spindle-citations-confidence",
        "openai/gpt-4o",
        "spindle-tools",
        true,
        ASSEMBLED_AT_RUN1,
      ),
    ]),
    makeRunnerResult("pattern-planning", [
      makeCaseResult(
        "pattern-plan-release",
        "anthropic/claude-sonnet-4.5",
        "pattern-planning",
        true,
        ASSEMBLED_AT_RUN1,
      ),
      makeCaseResult(
        "pattern-plan-release",
        "openai/gpt-4o",
        "pattern-planning",
        false,
        ASSEMBLED_AT_RUN1,
      ),
    ]),
    makeRunnerResult("weft-review", [
      makeCaseResult(
        "weft-approve-clean",
        "anthropic/claude-sonnet-4.5",
        "weft-review",
        true,
        ASSEMBLED_AT_RUN1,
      ),
      makeCaseResult(
        "weft-approve-clean",
        "openai/gpt-4o",
        "weft-review",
        true,
        ASSEMBLED_AT_RUN1,
      ),
    ]),
    makeRunnerResult("warp-security", [
      makeCaseResult(
        "warp-fast-approve",
        "anthropic/claude-sonnet-4.5",
        "warp-security",
        true,
        ASSEMBLED_AT_RUN1,
      ),
      makeCaseResult(
        "warp-fast-approve",
        "openai/gpt-4o",
        "warp-security",
        true,
        ASSEMBLED_AT_RUN1,
      ),
    ]),
  ];
}

/**
 * Build runner results for the second run (same cases, all passing).
 */
function makeRun2Results(): RunnerResult[] {
  return [
    makeRunnerResult("loom-routing", [
      makeCaseResult(
        "route-to-shuttle",
        "anthropic/claude-sonnet-4.5",
        "loom-routing",
        true,
        ASSEMBLED_AT_RUN2,
      ),
      makeCaseResult(
        "route-to-warp",
        "anthropic/claude-sonnet-4.5",
        "loom-routing",
        true,
        ASSEMBLED_AT_RUN2,
      ),
      makeCaseResult(
        "route-to-shuttle",
        "openai/gpt-4o",
        "loom-routing",
        true,
        ASSEMBLED_AT_RUN2,
      ),
      makeCaseResult(
        "route-to-warp",
        "openai/gpt-4o",
        "loom-routing",
        true,
        ASSEMBLED_AT_RUN2,
      ),
    ]),
    makeRunnerResult("tapestry-execution", [
      makeCaseResult(
        "exec-backend",
        "anthropic/claude-sonnet-4.5",
        "tapestry-execution",
        true,
        ASSEMBLED_AT_RUN2,
      ),
      makeCaseResult(
        "exec-backend",
        "openai/gpt-4o",
        "tapestry-execution",
        true, // gpt now passes
        ASSEMBLED_AT_RUN2,
      ),
    ]),
    makeRunnerResult("shuttle-execution", [
      makeCaseResult(
        "shuttle-report-structured",
        "anthropic/claude-sonnet-4.5",
        "shuttle-execution",
        true,
        ASSEMBLED_AT_RUN2,
      ),
      makeCaseResult(
        "shuttle-report-structured",
        "openai/gpt-4o",
        "shuttle-execution",
        true,
        ASSEMBLED_AT_RUN2,
      ),
    ]),
    makeRunnerResult("spindle-tools", [
      makeCaseResult(
        "spindle-citations-confidence",
        "anthropic/claude-sonnet-4.5",
        "spindle-tools",
        true,
        ASSEMBLED_AT_RUN2,
      ),
      makeCaseResult(
        "spindle-citations-confidence",
        "openai/gpt-4o",
        "spindle-tools",
        true,
        ASSEMBLED_AT_RUN2,
      ),
    ]),
    makeRunnerResult("pattern-planning", [
      makeCaseResult(
        "pattern-plan-release",
        "anthropic/claude-sonnet-4.5",
        "pattern-planning",
        true,
        ASSEMBLED_AT_RUN2,
      ),
      makeCaseResult(
        "pattern-plan-release",
        "openai/gpt-4o",
        "pattern-planning",
        true,
        ASSEMBLED_AT_RUN2,
      ),
    ]),
    makeRunnerResult("weft-review", [
      makeCaseResult(
        "weft-approve-clean",
        "anthropic/claude-sonnet-4.5",
        "weft-review",
        true,
        ASSEMBLED_AT_RUN2,
      ),
      makeCaseResult(
        "weft-approve-clean",
        "openai/gpt-4o",
        "weft-review",
        true,
        ASSEMBLED_AT_RUN2,
      ),
    ]),
    makeRunnerResult("warp-security", [
      makeCaseResult(
        "warp-fast-approve",
        "anthropic/claude-sonnet-4.5",
        "warp-security",
        true,
        ASSEMBLED_AT_RUN2,
      ),
      makeCaseResult(
        "warp-fast-approve",
        "openai/gpt-4o",
        "warp-security",
        true,
        ASSEMBLED_AT_RUN2,
      ),
    ]),
  ];
}

// ---------------------------------------------------------------------------
// Helper: isSafeId (mirrors dashboard-data.js website implementation)
// ---------------------------------------------------------------------------

function isSafeId(id: unknown): boolean {
  return typeof id === "string" && /^[a-zA-Z0-9_-]+$/.test(id);
}

// ---------------------------------------------------------------------------
// Helper: simulate website ENDPOINTS construction from a manifest
// ---------------------------------------------------------------------------

/**
 * Given a dashboard manifest, returns the list of URLs the website would
 * fetch when loading the full dashboard. Mirrors the URL-construction logic
 * in dashboard-data.js ENDPOINTS.
 *
 * Used to verify:
 *   - All URLs start with the expected GITHUB_RAW_BASE.
 *   - No legacy pgermishuys/opencode-weave repo appears.
 *   - All suiteId/runId segments pass isSafeId().
 *   - Every URL ends with an allowlisted filename.
 */
function simulateDashboardEndpointFetches(manifest: {
  runs: Array<{
    runId: string;
    suites: string[];
  }>;
}): string[] {
  const urls: string[] = [];

  // Fixed endpoints
  urls.push(`${EXPECTED_ENDPOINT_BASE}/indexes/v1/dashboard-manifest.json`);
  urls.push(`${EXPECTED_ENDPOINT_BASE}/indexes/v1/latest.json`);
  urls.push(`${EXPECTED_ENDPOINT_BASE}/indexes/v1/last-N-runs.json`);

  // Per-suite history endpoints (deduplicated from manifest suites)
  const suites = new Set<string>();
  for (const run of manifest.runs) {
    for (const suite of run.suites) suites.add(suite);
  }
  for (const suite of suites) {
    urls.push(
      `${EXPECTED_ENDPOINT_BASE}/indexes/v1/suite-history-${encodeURIComponent(suite)}.json`,
    );
  }

  // Per-run model comparison endpoints
  for (const run of manifest.runs) {
    urls.push(
      `${EXPECTED_ENDPOINT_BASE}/indexes/v1/model-comparison-${encodeURIComponent(run.runId)}.json`,
    );
  }

  // Artifact links for the most recent run only (immutable)
  const latestRunId = manifest.runs[0]?.runId;
  if (latestRunId) {
    const encoded = encodeURIComponent(latestRunId);
    urls.push(
      `${EXPECTED_ENDPOINT_BASE}/runs/v1/${encoded}/public-report.json`,
    );
    urls.push(`${EXPECTED_ENDPOINT_BASE}/runs/v1/${encoded}/public-report.md`);
  }

  return urls;
}

// ---------------------------------------------------------------------------
// Helper: allowlisted artifact filenames (mirrors website artifact link policy)
// ---------------------------------------------------------------------------

const ARTIFACT_ALLOWLIST = ["public-report.json", "public-report.md"] as const;

// ---------------------------------------------------------------------------
// E2E fixture flow test suite
// ---------------------------------------------------------------------------

describe("E2E fixture flow: publish two runs → rebuild indexes → validate website load", () => {
  /**
   * This large test exercises the full pipeline in sequence, sharing a single
   * temp directory between all assertions to simulate the real CI flow.
   *
   * We cannot use beforeAll in bun:test without a shared closure, so we run
   * all steps inside one `it` block to maintain sequential ordering and share
   * the mutable `ctx` object.
   */
  it("full pipeline: write runs, rebuild indexes, validate schema, simulate website fetches", async () => {
    const bundleRoot = resolve(TEMP_DIR, `e2e-fixture-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 1: Write two immutable run bundles
    // ─────────────────────────────────────────────────────────────────────────

    const result1 = await writer.writeBundle({
      runnerResults: makeRun1Results(),
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA_1,
      assembledAt: ASSEMBLED_AT_RUN1,
      mode: "local",
      dryRun: false,
      writeMarkdown: true,
      generateIndexes: false, // We'll rebuild manually below
    });
    expect(result1.isOk()).toBe(true);
    const run1 = result1._unsafeUnwrap();

    const result2 = await writer.writeBundle({
      runnerResults: makeRun2Results(),
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA_2,
      assembledAt: ASSEMBLED_AT_RUN2,
      mode: "local",
      dryRun: false,
      writeMarkdown: true,
      generateIndexes: false,
    });
    expect(result2.isOk()).toBe(true);
    const run2 = result2._unsafeUnwrap();

    // Immutable run IDs must be distinct
    expect(run1.runId).not.toBe(run2.runId);
    // Both run IDs must pass isSafeId (website relies on this)
    expect(isSafeId(run1.runId)).toBe(true);
    expect(isSafeId(run2.runId)).toBe(true);

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 2: Snapshot immutable run artifact BEFORE index rebuild
    // ─────────────────────────────────────────────────────────────────────────

    const run1PublicReportPath = join(run1.bundleDir, "public-report.json");
    const run2PublicReportPath = join(run2.bundleDir, "public-report.json");

    const run1ReportBefore = await Bun.file(run1PublicReportPath).text();
    const run2ReportBefore = await Bun.file(run2PublicReportPath).text();

    // public-report.json must be valid JSON
    expect(() => JSON.parse(run1ReportBefore)).not.toThrow();
    expect(() => JSON.parse(run2ReportBefore)).not.toThrow();

    // public-report.json must pass publish-safe check (no forbidden fields)
    const safeCheck1 = assertJsonPublishSafe(
      run1ReportBefore,
      "public-report-run1",
    );
    const safeCheck2 = assertJsonPublishSafe(
      run2ReportBefore,
      "public-report-run2",
    );
    expect(safeCheck1.isOk()).toBe(true);
    expect(safeCheck2.isOk()).toBe(true);

    // public-report.json must have schemaVersion 1
    const parsed1 = JSON.parse(run1ReportBefore);
    const parsed2 = JSON.parse(run2ReportBefore);
    expect(parsed1.schemaVersion).toBe(1);
    expect(parsed2.schemaVersion).toBe(1);

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 3: First index rebuild
    // ─────────────────────────────────────────────────────────────────────────

    const indexWriter1 = new DashboardIndexWriter(
      bundleRoot,
      UPDATED_AT_FIRST_BUILD,
    );
    const rebuildResult1 = await indexWriter1.rebuildFromRuns();
    expect(rebuildResult1.isOk()).toBe(true);
    const { filesWritten: filesWritten1 } = rebuildResult1._unsafeUnwrap();

    // Must have written the expected set of index files
    expect(filesWritten1).toContain(DASHBOARD_MANIFEST_FILE);
    expect(filesWritten1).toContain(LATEST_SNAPSHOT_FILE);
    expect(filesWritten1).toContain(LAST_N_RUNS_FILE);
    expect(
      filesWritten1.some(
        (f) =>
          f.startsWith(SUITE_HISTORY_FILE_PREFIX) && f.includes("loom-routing"),
      ),
    ).toBe(true);
    expect(
      filesWritten1.some(
        (f) =>
          f.startsWith(SUITE_HISTORY_FILE_PREFIX) &&
          f.includes("tapestry-execution"),
      ),
    ).toBe(true);
    expect(
      filesWritten1.some(
        (f) =>
          f.startsWith(SUITE_HISTORY_FILE_PREFIX) &&
          f.includes("shuttle-execution"),
      ),
    ).toBe(true);
    expect(
      filesWritten1.some(
        (f) =>
          f.startsWith(SUITE_HISTORY_FILE_PREFIX) &&
          f.includes("spindle-tools"),
      ),
    ).toBe(true);
    expect(
      filesWritten1.some(
        (f) =>
          f.startsWith(SUITE_HISTORY_FILE_PREFIX) &&
          f.includes("pattern-planning"),
      ),
    ).toBe(true);
    expect(
      filesWritten1.some(
        (f) =>
          f.startsWith(SUITE_HISTORY_FILE_PREFIX) && f.includes("weft-review"),
      ),
    ).toBe(true);
    expect(
      filesWritten1.some((f) => f.startsWith(MODEL_COMPARISON_FILE_PREFIX)),
    ).toBe(true);

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 4: Validate all generated index files against schema compatibility
    //         validators (mirrors website JS loader checks)
    // ─────────────────────────────────────────────────────────────────────────

    // dashboard-manifest.json
    const manifestPath = join(bundleRoot, DASHBOARD_MANIFEST_FILE);
    const manifestRaw = await Bun.file(manifestPath).json();
    const manifestCompat = validateDashboardManifestCompatibility(manifestRaw);
    expect(manifestCompat.isOk()).toBe(true);
    const manifest = manifestCompat._unsafeUnwrap();

    // Must have 2 runs (both bundles published)
    expect(manifest.totalRuns).toBe(2);
    expect(manifest.runs).toHaveLength(2);

    // Runs must be newest-first
    const firstManifestRun = manifest.runs.at(0);
    const secondManifestRun = manifest.runs.at(1);
    expect(firstManifestRun).toBeDefined();
    expect(secondManifestRun).toBeDefined();
    if (firstManifestRun === undefined || secondManifestRun === undefined)
      return;
    expect(firstManifestRun.assembledAt >= secondManifestRun.assembledAt).toBe(
      true,
    );

    // updatedAt must be the first build timestamp
    expect(manifest.updatedAt).toBe(UPDATED_AT_FIRST_BUILD);

    // schemaVersion must be correct
    expect(manifest.schemaVersion).toBe(DASHBOARD_MANIFEST_SCHEMA_VERSION);

    // All run IDs must be isSafeId-clean
    for (const run of manifest.runs) {
      expect(isSafeId(run.runId)).toBe(true);
    }

    // All suite names in runs must be isSafeId-clean
    for (const run of manifest.runs) {
      for (const suite of run.suites) {
        expect(isSafeId(suite)).toBe(true);
      }
    }

    // latest.json
    const latestPath = join(bundleRoot, LATEST_SNAPSHOT_FILE);
    const latestRaw = await Bun.file(latestPath).json();
    const latestCompat = validateLatestSnapshotCompatibility(latestRaw);
    expect(latestCompat.isOk()).toBe(true);
    const latest = latestCompat._unsafeUnwrap();

    // Must reflect the most recent run (run2 is newer)
    expect(latest.runId).toBe(run2.runId);
    expect(latest.assembledAt).toBe(ASSEMBLED_AT_RUN2);
    expect(latest.schemaVersion).toBe(LATEST_SNAPSHOT_SCHEMA_VERSION);
    expect(latest.updatedAt).toBe(UPDATED_AT_FIRST_BUILD);

    // suite history files for all known suites
    for (const suite of KNOWN_SUITES) {
      const histPath = join(
        bundleRoot,
        `${SUITE_HISTORY_FILE_PREFIX}${suite}.json`,
      );
      const histRaw = await Bun.file(histPath).json();
      const histCompat = validateSuiteHistoryCompatibility(histRaw, suite);
      expect(histCompat.isOk()).toBe(true);
      const hist = histCompat._unsafeUnwrap();
      // Must have oldest-first history
      expect(hist.history).toHaveLength(2);
      const firstHistoryPoint = hist.history.at(0);
      const secondHistoryPoint = hist.history.at(1);
      expect(firstHistoryPoint).toBeDefined();
      expect(secondHistoryPoint).toBeDefined();
      if (firstHistoryPoint === undefined || secondHistoryPoint === undefined)
        return;
      expect(
        firstHistoryPoint.assembledAt <= secondHistoryPoint.assembledAt,
      ).toBe(true);
      // suite field must match
      expect(hist.suite).toBe(suite);
      // All history runIds must pass isSafeId
      for (const point of hist.history) {
        expect(isSafeId(point.runId)).toBe(true);
      }
    }

    // public-report.json compatibility for both runs
    const run1BundleCompat = validatePublicReportBundleCompatibility(
      parsed1,
      run1.runId,
    );
    expect(run1BundleCompat.isOk()).toBe(true);

    const run2BundleCompat = validatePublicReportBundleCompatibility(
      parsed2,
      run2.runId,
    );
    expect(run2BundleCompat.isOk()).toBe(true);

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 5: Simulate website ENDPOINT fetches from the generated manifest
    // ─────────────────────────────────────────────────────────────────────────

    const simulatedUrls = simulateDashboardEndpointFetches({
      runs: manifest.runs.map((r) => ({
        runId: r.runId,
        suites: r.suites,
      })),
    });

    // All simulated URLs must start with the correct base
    for (const url of simulatedUrls) {
      expect(url.startsWith(EXPECTED_ENDPOINT_BASE)).toBe(true);
    }

    // None must reference the legacy repo
    for (const url of simulatedUrls) {
      expect(url.includes(LEGACY_REPO)).toBe(false);
    }

    // All index-layer URLs must end with an allowlisted path
    const indexUrls = simulatedUrls.filter((u) => u.includes("/indexes/v1/"));
    expect(indexUrls.length).toBeGreaterThan(0);
    for (const url of indexUrls) {
      const allowlisted =
        url.endsWith("dashboard-manifest.json") ||
        url.endsWith("latest.json") ||
        url.endsWith("last-N-runs.json") ||
        KNOWN_SUITES.some((s) =>
          url.endsWith(`suite-history-${encodeURIComponent(s)}.json`),
        ) ||
        manifest.runs.some((r) =>
          url.endsWith(`model-comparison-${encodeURIComponent(r.runId)}.json`),
        );
      expect(allowlisted).toBe(true);
    }

    // Artifact URLs must end with an allowlisted filename
    const artifactUrls = simulatedUrls.filter((u) => u.includes("/runs/v1/"));
    expect(artifactUrls.length).toBeGreaterThan(0);
    for (const url of artifactUrls) {
      const allowlisted = ARTIFACT_ALLOWLIST.some((f) => url.endsWith(f));
      expect(allowlisted).toBe(true);
    }

    // No javascript: scheme anywhere
    for (const url of simulatedUrls) {
      expect(url.toLowerCase().includes("javascript:")).toBe(false);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 6: Immutable-run identity — public-report.json unchanged after
    //         index rebuild
    // ─────────────────────────────────────────────────────────────────────────

    const run1ReportAfterRebuild = await Bun.file(run1PublicReportPath).text();
    const run2ReportAfterRebuild = await Bun.file(run2PublicReportPath).text();

    // Immutable run artifacts must be byte-for-byte unchanged
    expect(run1ReportAfterRebuild).toBe(run1ReportBefore);
    expect(run2ReportAfterRebuild).toBe(run2ReportBefore);

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 7: Mutable-index freshness — second rebuild with later updatedAt
    //         changes index timestamps but NOT immutable run artifacts
    // ─────────────────────────────────────────────────────────────────────────

    const indexWriter2 = new DashboardIndexWriter(
      bundleRoot,
      UPDATED_AT_SECOND_BUILD,
    );
    const rebuildResult2 = await indexWriter2.rebuildFromRuns();
    expect(rebuildResult2.isOk()).toBe(true);

    // dashboard-manifest.json updatedAt must reflect the new timestamp
    const manifestAfterRaw = await Bun.file(manifestPath).json();
    expect(manifestAfterRaw.updatedAt).toBe(UPDATED_AT_SECOND_BUILD);
    // But run count and run IDs must be unchanged
    expect(manifestAfterRaw.totalRuns).toBe(2);
    expect(manifestAfterRaw.runs.at(0)?.runId).toBe(manifest.runs.at(0)?.runId);
    expect(manifestAfterRaw.runs.at(1)?.runId).toBe(manifest.runs.at(1)?.runId);

    // latest.json updatedAt must change
    const latestAfterRaw = await Bun.file(latestPath).json();
    expect(latestAfterRaw.updatedAt).toBe(UPDATED_AT_SECOND_BUILD);
    expect(latestAfterRaw.runId).toBe(run2.runId); // runId unchanged

    // Immutable run artifact MUST still be unchanged
    const run1ReportAfterSecondRebuild =
      await Bun.file(run1PublicReportPath).text();
    const run2ReportAfterSecondRebuild =
      await Bun.file(run2PublicReportPath).text();
    expect(run1ReportAfterSecondRebuild).toBe(run1ReportBefore);
    expect(run2ReportAfterSecondRebuild).toBe(run2ReportBefore);

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 8: Stale-index rejection — incompatible schemaVersion is rejected
    //         by all compatibility validators
    // ─────────────────────────────────────────────────────────────────────────

    // Manifest: wrong schemaVersion must be rejected
    const staleManifest = { ...manifestAfterRaw, schemaVersion: 999 };
    const staleManifestCompat =
      validateDashboardManifestCompatibility(staleManifest);
    expect(staleManifestCompat.isErr()).toBe(true);
    expect(staleManifestCompat._unsafeUnwrapErr().type).toBe(
      "SchemaVersionMismatch",
    );

    // latest.json: wrong schemaVersion must be rejected
    const staleLatest = { ...latestAfterRaw, schemaVersion: 0 };
    const staleLatestCompat = validateLatestSnapshotCompatibility(staleLatest);
    expect(staleLatestCompat.isErr()).toBe(true);
    expect(staleLatestCompat._unsafeUnwrapErr().type).toBe(
      "SchemaVersionMismatch",
    );

    // suite history: wrong schemaVersion must be rejected
    const histPath = join(
      bundleRoot,
      `${SUITE_HISTORY_FILE_PREFIX}loom-routing.json`,
    );
    const histRaw = await Bun.file(histPath).json();
    const staleHist = { ...histRaw, schemaVersion: 42 };
    const staleHistCompat = validateSuiteHistoryCompatibility(
      staleHist,
      "loom-routing",
    );
    expect(staleHistCompat.isErr()).toBe(true);
    expect(staleHistCompat._unsafeUnwrapErr().type).toBe(
      "SchemaVersionMismatch",
    );

    // public-report.json: wrong schemaVersion must be rejected
    const staleBundle = { ...parsed1, schemaVersion: 999 };
    const staleBundleCompat = validatePublicReportBundleCompatibility(
      staleBundle,
      run1.runId,
    );
    expect(staleBundleCompat.isErr()).toBe(true);
    expect(staleBundleCompat._unsafeUnwrapErr().type).toBe(
      "SchemaVersionMismatch",
    );

    // Missing schemaVersion must also be rejected
    const noVersionManifest = { ...manifestAfterRaw };
    delete (noVersionManifest as Record<string, unknown>).schemaVersion;
    const noVersionCompat =
      validateDashboardManifestCompatibility(noVersionManifest);
    expect(noVersionCompat.isErr()).toBe(true);
    expect(noVersionCompat._unsafeUnwrapErr().type).toBe(
      "SchemaVersionMismatch",
    );
  });
});

// ---------------------------------------------------------------------------
// XSS / leakage isolation tests
// ---------------------------------------------------------------------------

describe("E2E fixture flow: XSS and leakage invariants", () => {
  it("malicious explanation in RunnerResult is sanitized out of public-report.json", async () => {
    const bundleRoot = resolve(TEMP_DIR, `e2e-xss-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    // Inject a XSS payload into the explanation field of a CaseResultSummary
    const maliciousExplanation = '<script>alert("xss")</script>';
    const caseResult: CaseResult = {
      summary: {
        ...makeCaseResultSummary(
          "xss-case",
          "anthropic/claude-sonnet-4.5",
          "loom-routing",
        ),
        publicExplanation: {
          // This is an invalid explanation — BoundedExplanationSchema will reject it
          text: maliciousExplanation,
          source: "score_bucket_label",
        },
      },
    };

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult("loom-routing", [caseResult])],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA_1,
      assembledAt: ASSEMBLED_AT_RUN1,
      mode: "local",
      dryRun: false,
    });

    expect(result.isOk()).toBe(true);
    const { bundleDir } = result._unsafeUnwrap();

    const publicReportPath = join(bundleDir, "public-report.json");
    const publicReportText = await Bun.file(publicReportPath).text();

    // The raw <script tag must NOT appear in the serialized public-report.json
    expect(publicReportText.includes("<script")).toBe(false);
    expect(publicReportText.includes("alert(")).toBe(false);

    // The public-report.json must still pass assertJsonPublishSafe
    const safeCheck = assertJsonPublishSafe(publicReportText, "xss-check");
    expect(safeCheck.isOk()).toBe(true);
  });

  it("composedPrompt and transcript fields from rawArtifact do not appear in public-report.json", async () => {
    const bundleRoot = resolve(TEMP_DIR, `e2e-leakage-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    // Inject a raw artifact (simulating a case with rawArtifact set) —
    // even though the writer strips rawArtifact, we verify the output.
    const caseResult: CaseResult = {
      summary: makeCaseResultSummary(
        "leakage-case",
        "anthropic/claude-sonnet-4.5",
        "loom-routing",
      ),
      rawArtifact: {
        caseId: "leakage-case",
        modelId: "anthropic/claude-sonnet-4.5",
        composedPrompt: "SECRET_PROMPT_TEXT_DO_NOT_PUBLISH",
        transcript: [
          { role: "system", content: "System prompt" },
          { role: "user", content: "User message" },
          { role: "assistant", content: "Assistant response" },
        ],
        rawContent: "LEAKED_MODEL_OUTPUT",
        dimensionRationales: {
          routingCorrectness: "LEAKED_RATIONALE",
        },
      },
    };

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult("loom-routing", [caseResult])],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA_1,
      assembledAt: ASSEMBLED_AT_RUN1,
      mode: "local",
      dryRun: false,
    });

    expect(result.isOk()).toBe(true);
    const { bundleDir } = result._unsafeUnwrap();

    const publicReportPath = join(bundleDir, "public-report.json");
    const publicReportText = await Bun.file(publicReportPath).text();

    // Forbidden strings must not appear anywhere in the public artifact
    expect(publicReportText.includes("SECRET_PROMPT_TEXT_DO_NOT_PUBLISH")).toBe(
      false,
    );
    expect(publicReportText.includes("LEAKED_MODEL_OUTPUT")).toBe(false);
    expect(publicReportText.includes("LEAKED_RATIONALE")).toBe(false);
    expect(publicReportText.includes("composedPrompt")).toBe(false);
    expect(publicReportText.includes("transcript")).toBe(false);
    expect(publicReportText.includes("rawContent")).toBe(false);
    expect(publicReportText.includes("dimensionRationales")).toBe(false);

    // assertJsonPublishSafe must pass
    const safeCheck = assertJsonPublishSafe(publicReportText, "leakage-check");
    expect(safeCheck.isOk()).toBe(true);
  });

  it("dry-run bundles are never published (mode: publish is ignored for dry-run)", async () => {
    const bundleRoot = resolve(TEMP_DIR, `e2e-dryrun-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    // Even with mode: "publish", dry-run bundles should be treated as local-only.
    // Since we have no token, a real publish would fail with TokenMissing.
    // But the write itself (the local artifact part) should succeed because
    // dry-run blocks the publish path.
    const result = await writer.writeBundle({
      runnerResults: [
        makeRunnerResult("loom-routing", [
          makeCaseResult(
            "dry-case",
            "anthropic/claude-sonnet-4.5",
            "loom-routing",
          ),
        ]),
      ],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA_1,
      assembledAt: ASSEMBLED_AT_RUN1,
      mode: "publish", // mode is publish, but dryRun overrides it
      dryRun: true,
      env: {}, // no token — would fail if publish mode reached
    });

    // Dry-run bundles in publish mode succeed locally (dry-run suppresses token gate)
    expect(result.isOk()).toBe(true);
    const { bundleDir } = result._unsafeUnwrap();

    // Bundle must be written locally
    const bundleIndexPath = join(bundleDir, "bundle-index.json");
    const bundleIndexExists = await Bun.file(bundleIndexPath)
      .text()
      .then(() => true)
      .catch(() => false);
    expect(bundleIndexExists).toBe(true);

    // The bundle index must record dryRun: true
    const bundleIndex = await Bun.file(bundleIndexPath).json();
    expect(bundleIndex.dryRun).toBe(true);
  });

  it("publish mode without token returns TokenMissing (not a leakage path)", async () => {
    const bundleRoot = resolve(TEMP_DIR, `e2e-notoken-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    const result = await writer.writeBundle({
      runnerResults: [
        makeRunnerResult("loom-routing", [
          makeCaseResult(
            "token-case",
            "anthropic/claude-sonnet-4.5",
            "loom-routing",
          ),
        ]),
      ],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA_1,
      assembledAt: ASSEMBLED_AT_RUN1,
      mode: "publish",
      dryRun: false,
      env: {}, // no token
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("PublishTokenMissing");
    // Error message must reference the env var name, not any secret
    expect(error.message).toContain(EVAL_RESULTS_REPO_TOKEN_ENV_VAR);
    // Must not contain any filesystem path or secret content
    expect(error.message).not.toContain(bundleRoot);
  });
});

// ---------------------------------------------------------------------------
// Stale-path grep checks: verify no legacy path references survive
// ---------------------------------------------------------------------------

describe("E2E fixture flow: stale-path integrity checks", () => {
  it("generated indexes do not reference pgermishuys/opencode-weave", async () => {
    const bundleRoot = resolve(TEMP_DIR, `e2e-stale-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    await writer.writeBundle({
      runnerResults: makeRun1Results(),
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA_1,
      assembledAt: ASSEMBLED_AT_RUN1,
      mode: "local",
      dryRun: false,
    });

    const indexWriter = new DashboardIndexWriter(
      bundleRoot,
      UPDATED_AT_FIRST_BUILD,
    );
    await indexWriter.rebuildFromRuns();

    // Read all generated index files and verify no legacy repo reference
    const indexFiles = [
      join(bundleRoot, DASHBOARD_MANIFEST_FILE),
      join(bundleRoot, LATEST_SNAPSHOT_FILE),
      join(bundleRoot, LAST_N_RUNS_FILE),
      join(bundleRoot, `${SUITE_HISTORY_FILE_PREFIX}loom-routing.json`),
    ];

    for (const filePath of indexFiles) {
      const content = await Bun.file(filePath)
        .text()
        .catch(() => null);
      if (content === null) continue; // file not present — skip
      expect(content.includes(LEGACY_REPO)).toBe(false);
    }
  });

  it("generated public-report.json does not contain raw-score internal fields", async () => {
    const bundleRoot = resolve(TEMP_DIR, `e2e-internal-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    const result = await writer.writeBundle({
      runnerResults: makeRun1Results(),
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA_1,
      assembledAt: ASSEMBLED_AT_RUN1,
      mode: "local",
      dryRun: false,
    });

    expect(result.isOk()).toBe(true);
    const { bundleDir } = result._unsafeUnwrap();
    const publicReportText = await Bun.file(
      join(bundleDir, "public-report.json"),
    ).text();

    // Internal-only fields must not appear in the public artifact
    const forbiddenFields = [
      "composedPrompt",
      "transcript",
      "rawContent",
      "dimensionRationales",
      "rationale",
    ];
    for (const field of forbiddenFields) {
      expect(publicReportText.includes(field)).toBe(false);
    }
  });

  it("all run IDs in the generated manifest survive a double round-trip through JSON", async () => {
    const bundleRoot = resolve(TEMP_DIR, `e2e-roundtrip-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    await writer.writeBundle({
      runnerResults: makeRun1Results(),
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA_1,
      assembledAt: ASSEMBLED_AT_RUN1,
      mode: "local",
      dryRun: false,
    });
    await writer.writeBundle({
      runnerResults: makeRun2Results(),
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA_2,
      assembledAt: ASSEMBLED_AT_RUN2,
      mode: "local",
      dryRun: false,
    });

    const indexWriter = new DashboardIndexWriter(
      bundleRoot,
      UPDATED_AT_FIRST_BUILD,
    );
    await indexWriter.rebuildFromRuns();

    const manifestRaw = await Bun.file(
      join(bundleRoot, DASHBOARD_MANIFEST_FILE),
    ).json();

    // Round-trip: serialize then re-parse the manifest
    const roundTripped = JSON.parse(JSON.stringify(manifestRaw));

    // All run IDs must survive round-trip unchanged and still be isSafeId-clean
    for (const run of roundTripped.runs) {
      expect(isSafeId(run.runId)).toBe(true);
      expect(run.runId).toBe(
        manifestRaw.runs.find((r: { runId: string }) => r.runId === run.runId)
          ?.runId,
      );
    }
  });
});
