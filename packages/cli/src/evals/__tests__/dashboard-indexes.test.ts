/**
 * Unit tests for the parts of `dashboard-indexes.ts` nothing reaches from
 * outside Weave.
 *
 * Everything this file used to cover — newest-first manifests, oldest-first
 * suite histories, last-N capping, scenario aggregation, model-comparison
 * ordering, rebuild determinism and the silent skipping of unreadable run
 * reports — is now asserted against the index **files** in
 * `tests/evals/reporting.scenario.test.ts`, which drives `ArtifactBundleWriter`
 * and `DashboardIndexWriter` and reads what a dashboard would fetch. Those
 * cases were deleted here rather than duplicated; see `docs/testing-strategy.md`.
 *
 * What stays, and why:
 *
 * | Kept | Why |
 * | --- | --- |
 * | `validateDashboardManifestCompatibility` | Consumer-side guards with **no production caller** — `weave` writes these files but never reads one back, so no written artifact reveals their behaviour. They exist for a future reader (the website, or a rebuild that merges instead of regenerating). |
 * | `validateSuiteHistoryCompatibility` | As above. |
 * | `validateLatestSnapshotCompatibility` | As above. |
 * | `validateScenarioHistoryCompatibility` | As above. |
 * | `generateDashboardIndexes([])` | `rebuildFromRuns()` returns early on an empty run set, so this error branch is unreachable from outside; it guards a future caller. |
 *
 * `validatePublicReportBundleCompatibility` is the one validator with a
 * production caller — `loadPublicReport()` — and its whole user-visible effect
 * is that an unreadable or wrong-version run is left out of the indexes. The
 * scenarios assert exactly that, so its cases went with the rest.
 *
 * Test isolation: no I/O, no git, no network, no model calls; every fixture is
 * built inline.
 */

import { describe, expect, it } from "bun:test";
import {
  generateDashboardIndexes,
  LATEST_SNAPSHOT_SCHEMA_VERSION,
  validateDashboardManifestCompatibility,
  validateLatestSnapshotCompatibility,
  validateScenarioHistoryCompatibility,
  validateSuiteHistoryCompatibility,
} from "../dashboard-indexes.js";
import {
  DASHBOARD_MANIFEST_SCHEMA_VERSION,
  SCENARIO_HISTORY_SCHEMA_VERSION,
} from "../report-schema.js";

const FIXED_UPDATED_AT = "2026-01-20T10:00:00.000Z";
const FIXED_GIT_SHA_1 = "aaaaaaa0000000000000000000000000000000001";

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

describe("validateScenarioHistoryCompatibility", () => {
  it("returns ok for a valid scenario history index", () => {
    const valid = {
      schemaVersion: SCENARIO_HISTORY_SCHEMA_VERSION,
      suite: "loom-routing",
      updatedAt: FIXED_UPDATED_AT,
      scenarios: [],
    };
    const result = validateScenarioHistoryCompatibility(valid, "loom-routing");
    expect(result.isOk()).toBe(true);
  });

  it("returns SchemaVersionMismatch for wrong version", () => {
    const raw = {
      schemaVersion: 999,
      suite: "loom-routing",
      updatedAt: FIXED_UPDATED_AT,
      scenarios: [],
    };
    const result = validateScenarioHistoryCompatibility(raw, "loom-routing");
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("SchemaVersionMismatch");
    if (error.type === "SchemaVersionMismatch") {
      expect(error.foundVersion).toBe(999);
      expect(error.expectedVersion).toBe(SCENARIO_HISTORY_SCHEMA_VERSION);
    }
  });

  it("returns SchemaVersionMismatch when schemaVersion is missing", () => {
    const result = validateScenarioHistoryCompatibility(
      { suite: "loom-routing", updatedAt: FIXED_UPDATED_AT, scenarios: [] },
      "loom-routing",
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("SchemaVersionMismatch");
  });

  it("returns SchemaVersionMismatch for null input", () => {
    const result = validateScenarioHistoryCompatibility(null, "loom-routing");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("SchemaVersionMismatch");
  });

  it("returns IndexParseError when schema validation fails despite correct version", () => {
    const raw = {
      schemaVersion: SCENARIO_HISTORY_SCHEMA_VERSION,
      // Missing suite, updatedAt, scenarios
    };
    const result = validateScenarioHistoryCompatibility(raw, "loom-routing");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("IndexParseError");
  });

  it("includes suite name in error path", () => {
    const raw = {
      schemaVersion: 999,
      suite: "loom-routing",
      updatedAt: FIXED_UPDATED_AT,
      scenarios: [],
    };
    const result = validateScenarioHistoryCompatibility(raw, "loom-routing");
    const error = result._unsafeUnwrapErr();
    if (error.type === "SchemaVersionMismatch") {
      expect(error.path).toContain("loom-routing");
    }
  });
});
