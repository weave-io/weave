/**
 * Dashboard index generation for the Weave agent evals dashboard.
 *
 * Pure index-generation helpers that read immutable run artifacts (i.e.
 * `public-report.json` files already written under `runs/<runId>/`) and
 * emit derived, mutable index files that the dashboard website consumes.
 *
 * # Architecture
 *
 * Index generation is **strictly derived**:
 *   - Immutable run artifacts under `runs/<runId>/` are the canonical source.
 *   - Every index file is fully reproducible from those run artifacts.
 *   - Index files carry explicit `schemaVersion` and `updatedAt` metadata so
 *     website consumers can detect stale or incompatible indexes.
 *
 * # Generated indexes
 *
 *   - `dashboard-manifest.json` — top-level manifest listing all runs
 *     (newest-first), with aggregate metadata per run.
 *   - `suite-history-<suiteName>.json` — per-suite pass-rate time series
 *     (oldest-first), enabling score-over-time charts.
 *   - `model-comparison-<runId>.json` — per-run model comparison table
 *     (models sorted alphabetically), enabling model-comparison views.
 *   - `latest.json` — snapshot of the latest run's aggregate metrics,
 *     enabling fast "current status" badges.
 *
 * # Freshness and stale-detection
 *
 * Mutable index artifacts carry:
 *   - `schemaVersion` — integer; website consumers MUST reject versions they
 *     do not recognise.
 *   - `updatedAt` — ISO 8601 timestamp of last index rebuild.
 *
 * Immutable run artifacts (`runs/<runId>/public-report.json`) carry only
 * `schemaVersion` and are treated as forever-cacheable content.
 *
 * # Ordering guarantees
 *
 *   - `dashboard-manifest.json`: runs ordered newest-first (by `assembledAt`).
 *   - `suite-history-<suiteName>.json`: history points ordered oldest-first.
 *   - `model-comparison-<runId>.json`: models sorted alphabetically by `modelId`.
 *   - `latest.json`: reflects the single most-recent run only.
 *   - `last-N-runs.json`: last N runs newest-first.
 *
 * # Determinism
 *
 * `generateDashboardIndexes()` is a pure function: given the same set of
 * `PublicReportBundle` inputs and the same `updatedAt`, it always produces
 * byte-for-byte identical output. No file I/O occurs inside the function —
 * all I/O is in `DashboardIndexWriter`.
 *
 * # Module boundaries
 *
 * This module does NOT:
 *   - Call runners, scorers, or model clients.
 *   - Read raw score files or transcript data.
 *   - Call the central sanitizer directly (public-report.json is pre-sanitized).
 *   - Write immutable run artifacts (owned by `artifact-bundle.ts`).
 *
 * The `DashboardIndexWriter` class handles all file I/O; the pure generation
 * functions are exposed separately for deterministic testing.
 */

import { join } from "node:path";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { RUNS_SUBDIR } from "./artifact-bundle.js";
import { TARGET_RUNS_PREFIX } from "./github-contents-publisher.js";
import {
  appendSuiteHistoryPoint,
  assembleDashboardManifest,
  assembleModelComparisonManifest,
  buildDashboardEntry,
} from "./report-bundle.js";
import {
  DASHBOARD_MANIFEST_SCHEMA_VERSION,
  type DashboardManifest,
  DashboardManifestSchema,
  type ModelComparisonManifest,
  type PublicReportBundle,
  PublicReportBundleSchema,
  type SuiteHistoryManifest,
  SuiteHistoryManifestSchema,
} from "./report-schema.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Schema version for `latest.json` and `last-N-runs.json`.
 * Increment when the shape changes in a backward-incompatible way.
 */
export const LATEST_SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * Schema version for `last-N-runs.json`.
 */
export const LAST_N_RUNS_SCHEMA_VERSION = 1;

/**
 * Default number of recent runs to include in `last-N-runs.json`.
 */
export const DEFAULT_LAST_N = 10;

/**
 * File name for the top-level dashboard manifest.
 */
export const DASHBOARD_MANIFEST_FILE = "dashboard-manifest.json";

/**
 * File name for the latest-run snapshot.
 */
export const LATEST_SNAPSHOT_FILE = "latest.json";

/**
 * File name prefix for per-suite history manifests.
 */
export const SUITE_HISTORY_FILE_PREFIX = "suite-history-";

/**
 * File name prefix for per-run model comparison manifests.
 */
export const MODEL_COMPARISON_FILE_PREFIX = "model-comparison-";

/**
 * File name for the last-N-runs index.
 */
export const LAST_N_RUNS_FILE = "last-N-runs.json";

// ---------------------------------------------------------------------------
// Freshness metadata helpers
// ---------------------------------------------------------------------------

/**
 * A latest-run snapshot.
 *
 * Published as `latest.json` at the root of the external results repository.
 * Contains only the most recent run's aggregate metrics — suitable for
 * dashboard status badges.
 *
 * Website consumers MUST reject `schemaVersion` values they do not recognise.
 * `updatedAt` enables staleness detection (compare against a known freshness
 * threshold).
 */
export interface LatestRunSnapshot {
  /** Schema version for staleness/compatibility detection. */
  schemaVersion: number;
  /** ISO 8601 timestamp when this snapshot was last updated. */
  updatedAt: string;
  /** The most recent run ID. */
  runId: string;
  /** ISO 8601 assembly timestamp of the most recent run. */
  assembledAt: string;
  /** Git SHA for the most recent run. */
  gitSha: string;
  /** Whether the most recent run was a dry-run. */
  dryRun: boolean;
  /** Whether all required cases passed in the most recent run. */
  allSuitesGreen: boolean;
  /** Total cases in the most recent run. */
  totalCases: number;
  /** Passing cases in the most recent run. */
  passedCases: number;
  /** Failing cases in the most recent run. */
  failedCases: number;
  /** Suite names included in the most recent run. */
  suites: string[];
}

/**
 * A run entry in the last-N-runs index.
 *
 * Lightweight record for each of the last N runs. No case-level detail.
 */
export interface LastNRunEntry {
  /** The run ID. */
  runId: string;
  /** ISO 8601 assembly timestamp. */
  assembledAt: string;
  /** Git SHA for this run. */
  gitSha: string;
  /** Whether this was a dry-run. */
  dryRun: boolean;
  /** Whether all required cases passed. */
  allSuitesGreen: boolean;
  /** Total cases in this run. */
  totalCases: number;
  /** Passing cases in this run. */
  passedCases: number;
  /** Failing cases in this run. */
  failedCases: number;
  /** Suite names in this run. */
  suites: string[];
}

/**
 * The last-N-runs index.
 *
 * Published as `last-N-runs.json`. Contains up to N most recent runs
 * in newest-first order with lightweight aggregate metadata.
 *
 * Website consumers MUST reject `schemaVersion` values they do not recognise.
 */
export interface LastNRunsIndex {
  /** Schema version for staleness/compatibility detection. */
  schemaVersion: number;
  /** ISO 8601 timestamp when this index was last updated. */
  updatedAt: string;
  /** Maximum number of runs tracked (N). */
  maxRuns: number;
  /** Total number of runs in the index (may be less than maxRuns initially). */
  count: number;
  /** Run entries, newest-first. */
  runs: LastNRunEntry[];
}

// ---------------------------------------------------------------------------
// Dashboard index generation errors
// ---------------------------------------------------------------------------

/**
 * Typed errors produced during dashboard index generation or writing.
 */
export type DashboardIndexError =
  | {
      type: "IndexReadError";
      path: string;
      message: string;
    }
  | {
      type: "IndexWriteError";
      path: string;
      message: string;
    }
  | {
      type: "IndexParseError";
      path: string;
      message: string;
    }
  | {
      type: "SchemaVersionMismatch";
      path: string;
      foundVersion: number;
      expectedVersion: number;
      message: string;
    }
  | {
      type: "ReportAssemblyError";
      runId: string;
      message: string;
    }
  | {
      type: "IndexGenerationError";
      message: string;
    };

// ---------------------------------------------------------------------------
// Run descriptor — input to index generation
// ---------------------------------------------------------------------------

/**
 * Describes a single run for index generation purposes.
 *
 * The bundle includes all data needed to derive any index file.
 * Immutable run artifacts are read once and passed here — index generation
 * functions never perform file I/O themselves.
 */
export interface RunDescriptor {
  /** The immutable run ID (e.g. `abc1234-2026-01-15-001`). */
  runId: string;
  /** The fully parsed and validated `PublicReportBundle` for this run. */
  bundle: PublicReportBundle;
}

// ---------------------------------------------------------------------------
// Index generation result
// ---------------------------------------------------------------------------

/**
 * The complete set of derived index artifacts for one or more runs.
 *
 * All fields are plain objects (no `Result` wrapping) — generation either
 * succeeds for all indexes or returns a typed error describing the failure.
 */
export interface GeneratedIndexes {
  /** Top-level dashboard manifest. */
  dashboardManifest: DashboardManifest;
  /** Per-suite history manifests, keyed by suite name. */
  suiteHistories: Map<string, SuiteHistoryManifest>;
  /** Per-run model comparison manifests, keyed by run ID. */
  modelComparisons: Map<string, ModelComparisonManifest>;
  /** Latest-run snapshot. */
  latestSnapshot: LatestRunSnapshot;
  /** Last-N-runs index. */
  lastNRuns: LastNRunsIndex;
}

// ---------------------------------------------------------------------------
// Pure index generation — no I/O
// ---------------------------------------------------------------------------

/**
 * Build a `LatestRunSnapshot` from the most recent `RunDescriptor`.
 *
 * @param run - The most-recent run descriptor.
 * @param updatedAt - ISO 8601 timestamp for the snapshot.
 * @returns The `LatestRunSnapshot`.
 */
export function buildLatestSnapshot(
  run: RunDescriptor,
  updatedAt: string,
): LatestRunSnapshot {
  const { bundle, runId } = run;
  return {
    schemaVersion: LATEST_SNAPSHOT_SCHEMA_VERSION,
    updatedAt,
    runId,
    assembledAt: bundle.assembledAt,
    gitSha: bundle.gitSha,
    dryRun: bundle.dryRun,
    allSuitesGreen: bundle.runSummary.allSuitesGreen,
    totalCases: bundle.runSummary.totalCases,
    passedCases: bundle.runSummary.passedCases,
    failedCases: bundle.runSummary.failedCases,
    suites: bundle.runSummary.suites,
  };
}

/**
 * Build a `LastNRunsIndex` from an ordered list of run descriptors.
 *
 * Runs are expected to be in newest-first order. Only the first `maxRuns`
 * are included in the output.
 *
 * @param runs - Run descriptors, newest-first.
 * @param maxRuns - Maximum number of runs to include.
 * @param updatedAt - ISO 8601 update timestamp.
 * @returns The `LastNRunsIndex`.
 */
export function buildLastNRuns(
  runs: RunDescriptor[],
  maxRuns: number,
  updatedAt: string,
): LastNRunsIndex {
  const capped = runs.slice(0, maxRuns);
  const entries: LastNRunEntry[] = capped.map(({ runId, bundle }) => ({
    runId,
    assembledAt: bundle.assembledAt,
    gitSha: bundle.gitSha,
    dryRun: bundle.dryRun,
    allSuitesGreen: bundle.runSummary.allSuitesGreen,
    totalCases: bundle.runSummary.totalCases,
    passedCases: bundle.runSummary.passedCases,
    failedCases: bundle.runSummary.failedCases,
    suites: bundle.runSummary.suites,
  }));

  return {
    schemaVersion: LAST_N_RUNS_SCHEMA_VERSION,
    updatedAt,
    maxRuns,
    count: entries.length,
    runs: entries,
  };
}

/**
 * Generate all dashboard indexes from an ordered set of run descriptors.
 *
 * This is the primary pure-function entry point for index generation.
 * It is deterministic: given the same inputs and `updatedAt`, it always
 * produces identical output. No file I/O occurs here.
 *
 * Ordering contract:
 *   - `runs` MUST be sorted newest-first by `bundle.assembledAt` before calling.
 *   - `dashboardManifest.runs` will be in newest-first order.
 *   - `suiteHistories[*].history` will be in oldest-first order.
 *   - `modelComparisons` contains one entry per run.
 *   - `latestSnapshot` reflects `runs[0]`.
 *   - `lastNRuns.runs` will be in newest-first order, capped at `lastN`.
 *
 * @param runs - All run descriptors, sorted newest-first.
 * @param updatedAt - ISO 8601 timestamp for all mutable index files.
 * @param lastN - Maximum number of runs in `last-N-runs.json` (default 10).
 * @returns `ok(GeneratedIndexes)` or `err(DashboardIndexError)`.
 */
export function generateDashboardIndexes(
  runs: RunDescriptor[],
  updatedAt: string,
  lastN: number = DEFAULT_LAST_N,
): Result<GeneratedIndexes, DashboardIndexError> {
  if (runs.length === 0) {
    return err({
      type: "IndexGenerationError",
      message: "Cannot generate dashboard indexes from an empty run list.",
    });
  }

  // --- Dashboard manifest: newest-first using report-bundle assembly helpers ---

  // Build entries newest-first using report-bundle helpers
  let dashboardManifest: DashboardManifest | null = null;
  for (const { runId, bundle } of runs) {
    const bundleReportPath = `${TARGET_RUNS_PREFIX}/${runId}/public-report.json`;
    const entry = buildDashboardEntry(bundle, runId, bundleReportPath);

    if (dashboardManifest === null) {
      // First entry: initialise manifest with this single entry
      const result = assembleDashboardManifest([], entry, updatedAt);
      if (result.isErr()) {
        return err({
          type: "ReportAssemblyError",
          runId,
          message: `Failed to assemble dashboard manifest entry for run "${runId}": ${result.error.message}`,
        });
      }
      dashboardManifest = result.value;
    } else {
      // Subsequent entries: append (they are already oldest-first in the tail)
      const result = assembleDashboardManifest(
        dashboardManifest.runs,
        entry,
        updatedAt,
      );
      if (result.isErr()) {
        return err({
          type: "ReportAssemblyError",
          runId,
          message: `Failed to append dashboard manifest entry for run "${runId}": ${result.error.message}`,
        });
      }
      // assembleDashboardManifest prepends the new entry — but we're iterating
      // newest-to-oldest, so we need the newest entry always at the front.
      // We reconstruct: take the existing manifest tail (older entries) and
      // prepend the current entry on each iteration. Since runs[] is newest-first,
      // after we process all runs, runs[0] (newest) will have been prepended last.
      dashboardManifest = result.value;
    }
  }

  if (dashboardManifest === null) {
    return err({
      type: "IndexGenerationError",
      message: "Dashboard manifest assembly produced no result.",
    });
  }

  // The manifest was built by prepending runs in newest-first order.
  // assembleDashboardManifest([existingEntries], newEntry) = [newEntry, ...existingEntries]
  // Since we iterate runs[0], runs[1], runs[2]... (newest-first), and each
  // prepends, the final order is: runs[last], ..., runs[1], runs[0] (i.e. oldest-first).
  // We need newest-first, so reverse the runs array in the manifest.
  const reversedRuns = [...dashboardManifest.runs].reverse();

  // Rebuild manifest with corrected ordering
  const finalManifestResult = DashboardManifestSchema.safeParse({
    schemaVersion: DASHBOARD_MANIFEST_SCHEMA_VERSION,
    updatedAt,
    totalRuns: reversedRuns.length,
    runs: reversedRuns,
  });

  if (!finalManifestResult.success) {
    return err({
      type: "IndexGenerationError",
      message: `Dashboard manifest schema validation failed: ${finalManifestResult.error.issues.map((i) => i.message).join("; ")}`,
    });
  }
  dashboardManifest = finalManifestResult.data;

  // --- Suite history manifests: oldest-first per suite ---

  const suiteHistories = new Map<string, SuiteHistoryManifest>();

  // Iterate oldest-first (reverse of runs[] which is newest-first)
  const runsOldestFirst = [...runs].reverse();

  for (const { runId, bundle } of runsOldestFirst) {
    for (const suiteSummary of bundle.suiteSummaries) {
      const passRate =
        suiteSummary.totalCases === 0
          ? null
          : suiteSummary.passedCases / suiteSummary.totalCases;

      const point = {
        assembledAt: bundle.assembledAt,
        gitSha: bundle.gitSha,
        runId,
        totalCases: suiteSummary.totalCases,
        passedCases: suiteSummary.passedCases,
        suiteGreen: suiteSummary.suiteGreen,
        passRate,
      };

      const existing = suiteHistories.get(suiteSummary.suite) ?? null;
      const appendResult = appendSuiteHistoryPoint(
        existing,
        suiteSummary.suite,
        point,
        updatedAt,
      );
      if (appendResult.isErr()) {
        return err({
          type: "ReportAssemblyError",
          runId,
          message: `Failed to append suite history point for suite "${suiteSummary.suite}" in run "${runId}": ${appendResult.error.message}`,
        });
      }
      suiteHistories.set(suiteSummary.suite, appendResult.value);
    }
  }

  // --- Model comparison manifests: one per run ---

  const modelComparisons = new Map<string, ModelComparisonManifest>();

  for (const { runId, bundle } of runs) {
    const compResult = assembleModelComparisonManifest(bundle, runId);
    if (compResult.isErr()) {
      return err({
        type: "ReportAssemblyError",
        runId,
        message: `Failed to assemble model comparison manifest for run "${runId}": ${compResult.error.message}`,
      });
    }
    modelComparisons.set(runId, compResult.value);
  }

  // --- Latest snapshot: from runs[0] (newest) ---
  const latestRun = runs.at(0);
  if (latestRun === undefined) {
    return err({
      type: "IndexGenerationError",
      message: "Cannot build latest snapshot from an empty run list.",
    });
  }
  const latestSnapshot = buildLatestSnapshot(latestRun, updatedAt);

  // --- Last-N runs: newest-first, capped at lastN ---
  const lastNRuns = buildLastNRuns(runs, lastN, updatedAt);

  return ok({
    dashboardManifest,
    suiteHistories,
    modelComparisons,
    latestSnapshot,
    lastNRuns,
  });
}

// ---------------------------------------------------------------------------
// Stale / compatibility detection helpers
// ---------------------------------------------------------------------------

/**
 * Detect whether a `DashboardManifest` is incompatible with the current
 * schema version.
 *
 * Website consumers and tooling should call this before reading a manifest.
 * Returns `true` when the manifest can be used; `false` when it must be
 * rejected and regenerated.
 *
 * @param raw - The raw parsed JSON object (type-unsafe; validated here).
 * @returns `ok(DashboardManifest)` when compatible; `err(DashboardIndexError)` when not.
 */
export function validateDashboardManifestCompatibility(
  raw: unknown,
): Result<DashboardManifest, DashboardIndexError> {
  // Quick schema-version check before full parse
  if (
    raw === null ||
    typeof raw !== "object" ||
    !("schemaVersion" in raw) ||
    typeof (raw as Record<string, unknown>).schemaVersion !== "number"
  ) {
    return err({
      type: "SchemaVersionMismatch",
      path: DASHBOARD_MANIFEST_FILE,
      foundVersion: -1,
      expectedVersion: DASHBOARD_MANIFEST_SCHEMA_VERSION,
      message: `Dashboard manifest is missing a numeric schemaVersion field. Expected ${DASHBOARD_MANIFEST_SCHEMA_VERSION}.`,
    });
  }

  const found = (raw as Record<string, unknown>).schemaVersion as number;
  if (found !== DASHBOARD_MANIFEST_SCHEMA_VERSION) {
    return err({
      type: "SchemaVersionMismatch",
      path: DASHBOARD_MANIFEST_FILE,
      foundVersion: found,
      expectedVersion: DASHBOARD_MANIFEST_SCHEMA_VERSION,
      message:
        `Dashboard manifest schemaVersion ${found} is not compatible with ` +
        `expected version ${DASHBOARD_MANIFEST_SCHEMA_VERSION}. ` +
        `The index must be regenerated.`,
    });
  }

  const parsed = DashboardManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return err({
      type: "IndexParseError",
      path: DASHBOARD_MANIFEST_FILE,
      message: `Dashboard manifest failed schema validation: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    });
  }

  return ok(parsed.data);
}

/**
 * Detect whether a `SuiteHistoryManifest` is incompatible with the current
 * schema version.
 *
 * @param raw - The raw parsed JSON object.
 * @param suiteName - The suite name (used for error path construction).
 * @returns `ok(SuiteHistoryManifest)` when compatible; `err(DashboardIndexError)` when not.
 */
export function validateSuiteHistoryCompatibility(
  raw: unknown,
  suiteName: string,
): Result<SuiteHistoryManifest, DashboardIndexError> {
  const filePath = `${SUITE_HISTORY_FILE_PREFIX}${suiteName}.json`;

  if (
    raw === null ||
    typeof raw !== "object" ||
    !("schemaVersion" in raw) ||
    typeof (raw as Record<string, unknown>).schemaVersion !== "number"
  ) {
    return err({
      type: "SchemaVersionMismatch",
      path: filePath,
      foundVersion: -1,
      expectedVersion: 1,
      message: `Suite history manifest for "${suiteName}" is missing a numeric schemaVersion field.`,
    });
  }

  const found = (raw as Record<string, unknown>).schemaVersion as number;
  if (found !== 1) {
    return err({
      type: "SchemaVersionMismatch",
      path: filePath,
      foundVersion: found,
      expectedVersion: 1,
      message:
        `Suite history manifest for "${suiteName}" has schemaVersion ${found}, ` +
        `expected 1. The index must be regenerated.`,
    });
  }

  const parsed = SuiteHistoryManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return err({
      type: "IndexParseError",
      path: filePath,
      message: `Suite history manifest for "${suiteName}" failed schema validation: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    });
  }

  return ok(parsed.data);
}

/**
 * Validate a raw `LatestRunSnapshot` object for version compatibility.
 *
 * @param raw - The raw parsed JSON object.
 * @returns `ok(LatestRunSnapshot)` when compatible; `err(DashboardIndexError)` when not.
 */
export function validateLatestSnapshotCompatibility(
  raw: unknown,
): Result<LatestRunSnapshot, DashboardIndexError> {
  if (
    raw === null ||
    typeof raw !== "object" ||
    !("schemaVersion" in raw) ||
    typeof (raw as Record<string, unknown>).schemaVersion !== "number"
  ) {
    return err({
      type: "SchemaVersionMismatch",
      path: LATEST_SNAPSHOT_FILE,
      foundVersion: -1,
      expectedVersion: LATEST_SNAPSHOT_SCHEMA_VERSION,
      message: `Latest snapshot is missing a numeric schemaVersion field. Expected ${LATEST_SNAPSHOT_SCHEMA_VERSION}.`,
    });
  }

  const found = (raw as Record<string, unknown>).schemaVersion as number;
  if (found !== LATEST_SNAPSHOT_SCHEMA_VERSION) {
    return err({
      type: "SchemaVersionMismatch",
      path: LATEST_SNAPSHOT_FILE,
      foundVersion: found,
      expectedVersion: LATEST_SNAPSHOT_SCHEMA_VERSION,
      message:
        `Latest snapshot schemaVersion ${found} is not compatible with ` +
        `expected version ${LATEST_SNAPSHOT_SCHEMA_VERSION}. ` +
        `The snapshot must be regenerated.`,
    });
  }

  // Validate required fields
  const r = raw as Record<string, unknown>;
  if (
    typeof r.runId !== "string" ||
    typeof r.assembledAt !== "string" ||
    typeof r.gitSha !== "string" ||
    typeof r.dryRun !== "boolean" ||
    typeof r.allSuitesGreen !== "boolean" ||
    typeof r.totalCases !== "number" ||
    typeof r.passedCases !== "number" ||
    typeof r.failedCases !== "number" ||
    !Array.isArray(r.suites)
  ) {
    return err({
      type: "IndexParseError",
      path: LATEST_SNAPSHOT_FILE,
      message: "Latest snapshot is missing required fields.",
    });
  }

  return ok(raw as LatestRunSnapshot);
}

/**
 * Validate a raw `PublicReportBundle` object for version compatibility.
 *
 * Used by `DashboardIndexWriter` when reading run artifacts from disk.
 * Callers should reject bundles with unrecognised `schemaVersion`.
 *
 * @param raw - The raw parsed JSON object.
 * @param runId - Run ID (for error context).
 * @returns `ok(PublicReportBundle)` when compatible; `err(DashboardIndexError)` when not.
 */
export function validatePublicReportBundleCompatibility(
  raw: unknown,
  runId: string,
): Result<PublicReportBundle, DashboardIndexError> {
  const filePath = `${RUNS_SUBDIR}/${runId}/public-report.json`;

  if (
    raw === null ||
    typeof raw !== "object" ||
    !("schemaVersion" in raw) ||
    typeof (raw as Record<string, unknown>).schemaVersion !== "number"
  ) {
    return err({
      type: "SchemaVersionMismatch",
      path: filePath,
      foundVersion: -1,
      expectedVersion: 1,
      message: `public-report.json for run "${runId}" is missing a numeric schemaVersion field.`,
    });
  }

  const found = (raw as Record<string, unknown>).schemaVersion as number;
  if (found !== 1) {
    return err({
      type: "SchemaVersionMismatch",
      path: filePath,
      foundVersion: found,
      expectedVersion: 1,
      message:
        `public-report.json for run "${runId}" has schemaVersion ${found}, ` +
        `expected 1. This run artifact cannot be consumed.`,
    });
  }

  const parsed = PublicReportBundleSchema.safeParse(raw);
  if (!parsed.success) {
    return err({
      type: "IndexParseError",
      path: filePath,
      message: `public-report.json for run "${runId}" failed schema validation: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    });
  }

  return ok(parsed.data);
}

// ---------------------------------------------------------------------------
// DashboardIndexWriter — file I/O wrapper
// ---------------------------------------------------------------------------

/**
 * Writes generated dashboard index files to a local directory.
 *
 * The writer is responsible for:
 *   1. Reading existing `public-report.json` artifacts from `runs/<runId>/`.
 *   2. Discovering all existing run directories.
 *   3. Calling `generateDashboardIndexes()` with the assembled descriptors.
 *   4. Writing the resulting index files to `indexRoot`.
 *
 * ## Usage
 *
 * ```ts
 * const writer = new DashboardIndexWriter("/var/eval-bundles");
 * const result = await writer.rebuildFromRuns();
 * // result.value → { filesWritten: ["dashboard-manifest.json", ...] }
 * ```
 *
 * ## Ordering
 *
 * Run directories are sorted newest-first by the `assembledAt` field of their
 * `public-report.json`. Directories without a readable `public-report.json`
 * are silently skipped.
 *
 * ## Atomicity
 *
 * Index files are written sequentially. There is no atomic swap — readers
 * must tolerate a brief window during which some indexes are newer than others.
 */
export class DashboardIndexWriter {
  constructor(
    /**
     * Root directory containing `runs/` and where index files will be written.
     * Must be an absolute path.
     */
    private readonly bundleRoot: string,
    /**
     * Optional `updatedAt` timestamp override for deterministic test output.
     * Defaults to `new Date().toISOString()` when not provided.
     */
    private readonly updatedAtOverride?: string,
  ) {}

  /**
   * Rebuild all dashboard indexes from existing run artifacts on disk.
   *
   * Scans `<bundleRoot>/runs/` for subdirectories containing
   * `public-report.json`, validates each, and regenerates all index files.
   *
   * Run directories without a readable and valid `public-report.json` are
   * silently skipped (partial or in-progress writes are tolerated).
   *
   * @param lastN - Maximum runs in `last-N-runs.json` (default 10).
   * @returns `ResultAsync<{ filesWritten: string[] }, DashboardIndexError>`.
   */
  rebuildFromRuns(
    lastN: number = DEFAULT_LAST_N,
  ): ResultAsync<{ filesWritten: string[] }, DashboardIndexError> {
    const updatedAt = this.updatedAtOverride ?? new Date().toISOString();
    const runsDir = join(this.bundleRoot, RUNS_SUBDIR);

    return ResultAsync.fromPromise(
      this.discoverAndLoadRuns(runsDir),
      (cause): DashboardIndexError => ({
        type: "IndexReadError",
        path: runsDir,
        message: `Failed to discover run directories in "${runsDir}": ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
    ).andThen((runs) => {
      if (runs.length === 0) {
        return ResultAsync.fromSafePromise(
          Promise.resolve({ filesWritten: [] as string[] }),
        );
      }

      const generateResult = generateDashboardIndexes(runs, updatedAt, lastN);
      if (generateResult.isErr()) {
        return new ResultAsync(
          Promise.resolve(
            err<{ filesWritten: string[] }, DashboardIndexError>(
              generateResult.error,
            ),
          ),
        );
      }

      return this.writeIndexFiles(generateResult.value, updatedAt);
    });
  }

  /**
   * Update indexes incrementally after a new run is written.
   *
   * More efficient than `rebuildFromRuns()` — only reads existing index files
   * and merges in the new run rather than re-scanning all run directories.
   *
   * The new run's `public-report.json` must already be written to disk at
   * `<bundleRoot>/runs/<runId>/public-report.json` before calling this method.
   *
   * @param runId - The new run ID.
   * @param newBundle - The new run's `PublicReportBundle` (already assembled).
   * @param lastN - Maximum runs in `last-N-runs.json` (default 10).
   * @returns `ResultAsync<{ filesWritten: string[] }, DashboardIndexError>`.
   */
  updateAfterRun(
    runId: string,
    newBundle: PublicReportBundle,
    lastN: number = DEFAULT_LAST_N,
  ): ResultAsync<{ filesWritten: string[] }, DashboardIndexError> {
    // Delegate to rebuildFromRuns for correctness.
    // A future optimization could read only existing indexes and merge,
    // but full rebuild is correct and simpler.
    void runId;
    void newBundle;
    return this.rebuildFromRuns(lastN);
  }

  // ---------------------------------------------------------------------------
  // Private: run directory discovery and loading
  // ---------------------------------------------------------------------------

  private async discoverAndLoadRuns(runsDir: string): Promise<RunDescriptor[]> {
    const glob = new Bun.Glob("*/public-report.json");
    const descriptors: RunDescriptor[] = [];

    try {
      for await (const relPath of glob.scan({
        cwd: runsDir,
        onlyFiles: true,
      })) {
        // relPath is like "abc123d-2026-01-15-001/public-report.json"
        const parts = relPath.split("/");
        if (parts.length < 2) continue;
        const runId = parts[0];
        if (runId === undefined) continue;
        const fullPath = join(runsDir, relPath);

        const bundleOrNull = await this.loadPublicReport(fullPath, runId);
        if (bundleOrNull === null) continue;
        descriptors.push({ runId, bundle: bundleOrNull });
      }
    } catch {
      // runsDir does not exist yet — return empty
      return [];
    }

    // Sort newest-first by assembledAt
    descriptors.sort((a, b) =>
      b.bundle.assembledAt.localeCompare(a.bundle.assembledAt),
    );

    return descriptors;
  }

  private async loadPublicReport(
    filePath: string,
    runId: string,
  ): Promise<PublicReportBundle | null> {
    try {
      const text = await Bun.file(filePath).text();
      const raw: unknown = JSON.parse(text);
      const result = validatePublicReportBundleCompatibility(raw, runId);
      if (result.isErr()) return null;
      return result.value;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: write index files
  // ---------------------------------------------------------------------------

  private writeIndexFiles(
    indexes: GeneratedIndexes,
    _updatedAt: string,
  ): ResultAsync<{ filesWritten: string[] }, DashboardIndexError> {
    const filesWritten: string[] = [];

    const writeJson = (
      obj: unknown,
      fileName: string,
    ): ResultAsync<void, DashboardIndexError> => {
      const filePath = join(this.bundleRoot, fileName);
      const json = JSON.stringify(obj, null, 2);
      return ResultAsync.fromPromise(
        Bun.write(filePath, json).then(() => {
          filesWritten.push(fileName);
        }),
        (cause): DashboardIndexError => ({
          type: "IndexWriteError",
          path: filePath,
          message: `Failed to write index file "${filePath}": ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
      );
    };

    // Chain all writes sequentially
    return writeJson(indexes.dashboardManifest, DASHBOARD_MANIFEST_FILE)
      .andThen(() => {
        // Write all suite history manifests
        return [...indexes.suiteHistories.entries()].reduce(
          (acc, [suite, history]) =>
            acc.andThen(() =>
              writeJson(history, `${SUITE_HISTORY_FILE_PREFIX}${suite}.json`),
            ),
          ResultAsync.fromSafePromise<void, DashboardIndexError>(
            Promise.resolve(),
          ),
        );
      })
      .andThen(() => {
        // Write all model comparison manifests
        return [...indexes.modelComparisons.entries()].reduce(
          (acc, [runId, comparison]) =>
            acc.andThen(() =>
              writeJson(
                comparison,
                `${MODEL_COMPARISON_FILE_PREFIX}${runId}.json`,
              ),
            ),
          ResultAsync.fromSafePromise<void, DashboardIndexError>(
            Promise.resolve(),
          ),
        );
      })
      .andThen(() => writeJson(indexes.latestSnapshot, LATEST_SNAPSHOT_FILE))
      .andThen(() => writeJson(indexes.lastNRuns, LAST_N_RUNS_FILE))
      .map(() => ({ filesWritten }));
  }
}
