/**
 * Unit tests for `report-schema.ts` — the parts a user cannot observe.
 *
 * The explanation surface moved out of this file. What an explanation may
 * contain, where it may come from, how long it may be, and which score bucket
 * a weighted total lands in are all visible in the files a run publishes, and
 * are asserted there in
 * [`tests/evals/publish-safety.scenario.test.ts`](../../../../../tests/evals/publish-safety.scenario.test.ts)
 * as a table of hostile inputs fed through the real bundle writer:
 * `FORBIDDEN_EXPLANATION_PATTERNS`, `ExplanationSourceSchema`,
 * `BoundedExplanationSchema`, `ScoreBucketSchema` and `computeScoreBucket()`
 * were covered here by enumeration and are covered there by behaviour. Every
 * one of those scenarios was watched fail against an assembler that skipped
 * explanation validation before the deletion.
 *
 * What is left is unreachable from outside:
 *
 *   - **`schemaVersion` rejection branches.** The writer always stamps the
 *     version constant, so a wrong or missing version cannot be produced by
 *     anything a user does. These branches guard a future producer, and the
 *     website's own rejection of a bad version depends on them holding.
 *   - **Strict-mode rejection of sensitive field names.** Layer on top of the
 *     sanitizer: the scenarios prove no sensitive field reaches a published
 *     file, these prove the schema would refuse one that did.
 *   - **Dashboard, suite-history, model-comparison and scenario-history
 *     validation.** The scenarios assert the published index files carry the
 *     right version and shape; the rejection branches here cover inputs the
 *     writer never constructs.
 *
 * Test isolation:
 *   - No file I/O, no network, no spawned process.
 *   - All fixtures are constructed inline.
 *   - All schema validations use `safeParse()` to avoid thrown exceptions.
 */

import { describe, expect, it } from "bun:test";
import {
  BoundedExplanationSchema,
  CaseAttemptTallySchema,
  DASHBOARD_MANIFEST_SCHEMA_VERSION,
  DashboardEntrySchema,
  DashboardManifestSchema,
  EXPLANATION_MAX_CHARS,
  JudgeIdentitySchema,
  MODEL_COMPARISON_SCHEMA_VERSION,
  ModelAttemptTallySchema,
  ModelComparisonEntrySchema,
  ModelComparisonManifestSchema,
  PublicCaseEntrySchema,
  PublicReportBundleSchema,
  REPORT_BUNDLE_SCHEMA_VERSION,
  SCENARIO_HISTORY_MAX_RUNS,
  SCENARIO_HISTORY_SCHEMA_VERSION,
  ScenarioHistoryEntrySchema,
  ScenarioHistoryIndexSchema,
  ScenarioRunHistoryEntrySchema,
  SUITE_HISTORY_SCHEMA_VERSION,
  SUITE_SUMMARY_SCHEMA_VERSION,
  SuiteHistoryManifestSchema,
  SuiteSummaryEntrySchema,
} from "../report-schema.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeValidBoundedExplanation(overrides: Record<string, unknown> = {}) {
  return {
    text: "Routing matched the expected agent.",
    source: "score_bucket_label",
    ...overrides,
  };
}

function makeValidPublicCaseEntry(overrides: Record<string, unknown> = {}) {
  return {
    caseId: "route-to-shuttle",
    modelId: "anthropic/claude-sonnet-4.5",
    suite: "loom-routing",
    scoreBucket: "pass",
    passed: true,
    required: true,
    dryRun: false,
    scoredAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeValidSuiteSummaryEntry(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: SUITE_SUMMARY_SCHEMA_VERSION,
    suite: "loom-routing",
    assembledAt: "2026-01-01T00:00:00.000Z",
    gitSha: "abc123def456abc123def456abc123def456abc1",
    totalCases: 10,
    passedCases: 8,
    failedCases: 2,
    suiteGreen: false,
    hasRuntimeVerifiedCases: false,
    cases: [makeValidPublicCaseEntry()],
    ...overrides,
  };
}

function makeValidPublicReportBundle(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: REPORT_BUNDLE_SCHEMA_VERSION,
    assembledAt: "2026-01-01T00:00:00.000Z",
    gitSha: "abc123def456abc123def456abc123def456abc1",
    dryRun: false,
    runSummary: {
      totalCases: 10,
      passedCases: 8,
      failedCases: 2,
      allSuitesGreen: false,
      suites: ["loom-routing"],
    },
    suiteSummaries: [makeValidSuiteSummaryEntry()],
    ...overrides,
  };
}

function makeValidDashboardEntry(overrides: Record<string, unknown> = {}) {
  return {
    runId: "abc1234-2026-01-01",
    assembledAt: "2026-01-01T00:00:00.000Z",
    gitSha: "abc123def456abc123def456abc123def456abc1",
    dryRun: false,
    allSuitesGreen: true,
    totalCases: 10,
    passedCases: 10,
    failedCases: 0,
    suites: ["loom-routing"],
    bundleReportPath: "runs/v1/abc1234-2026-01-01-001/public-report.json",
    ...overrides,
  };
}

function makeValidDashboardManifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: DASHBOARD_MANIFEST_SCHEMA_VERSION,
    updatedAt: "2026-01-01T00:00:00.000Z",
    totalRuns: 1,
    runs: [makeValidDashboardEntry()],
    ...overrides,
  };
}

function makeValidSuiteHistoryManifest(
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: SUITE_HISTORY_SCHEMA_VERSION,
    suite: "loom-routing",
    updatedAt: "2026-01-01T00:00:00.000Z",
    history: [
      {
        assembledAt: "2026-01-01T00:00:00.000Z",
        gitSha: "abc123def456abc123def456abc123def456abc1",
        runId: "abc1234-2026-01-01",
        totalCases: 10,
        passedCases: 9,
        suiteGreen: true,
        passRate: 0.9,
      },
    ],
    ...overrides,
  };
}

function makeValidModelComparisonManifest(
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: MODEL_COMPARISON_SCHEMA_VERSION,
    runId: "abc1234-2026-01-01",
    assembledAt: "2026-01-01T00:00:00.000Z",
    gitSha: "abc123def456abc123def456abc123def456abc1",
    dryRun: false,
    models: [
      {
        modelId: "anthropic/claude-sonnet-4.5",
        displayName: "Claude Sonnet 4.5",
        totalCases: 10,
        passedCases: 9,
        failedCases: 1,
        passRate: 0.9,
        perSuitePassRates: { "loom-routing": 0.9 },
        overallBucket: "pass",
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PublicCaseEntrySchema
// ---------------------------------------------------------------------------

describe("PublicCaseEntrySchema", () => {
  it("accepts a valid case entry", () => {
    const result = PublicCaseEntrySchema.safeParse(makeValidPublicCaseEntry());
    expect(result.success).toBe(true);
  });

  it("accepts a case entry with a valid bounded explanation", () => {
    const result = PublicCaseEntrySchema.safeParse(
      makeValidPublicCaseEntry({
        explanation: makeValidBoundedExplanation({
          text: "Agent routed to shuttle as expected.",
          source: "score_bucket_label",
        }),
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects case entry with empty caseId", () => {
    const result = PublicCaseEntrySchema.safeParse(
      makeValidPublicCaseEntry({ caseId: "" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects case entry with empty modelId", () => {
    const result = PublicCaseEntrySchema.safeParse(
      makeValidPublicCaseEntry({ modelId: "" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects case entry with invalid scoreBucket", () => {
    const result = PublicCaseEntrySchema.safeParse(
      makeValidPublicCaseEntry({ scoreBucket: "unknown" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects case entry with raw rationale in explanation", () => {
    const result = PublicCaseEntrySchema.safeParse(
      makeValidPublicCaseEntry({
        explanation: {
          text: "rationale: the model correctly selected shuttle",
          source: "operator_note",
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects case entry with chain-of-thought in explanation", () => {
    const result = PublicCaseEntrySchema.safeParse(
      makeValidPublicCaseEntry({
        explanation: {
          text: "<thinking>I should pick shuttle</thinking>",
          source: "operator_note",
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects case entry with overlong explanation", () => {
    const result = PublicCaseEntrySchema.safeParse(
      makeValidPublicCaseEntry({
        explanation: {
          text: "A".repeat(EXPLANATION_MAX_CHARS + 1),
          source: "operator_note",
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("case entry without explanation field is valid", () => {
    const entry = makeValidPublicCaseEntry();
    delete (entry as Record<string, unknown>).explanation;
    expect(PublicCaseEntrySchema.safeParse(entry).success).toBe(true);
  });

  it("accepts a case entry with a valid trajectorySummary", () => {
    const result = PublicCaseEntrySchema.safeParse(
      makeValidPublicCaseEntry({
        trajectorySummary: {
          harnessDelegatedCorrectly: true,
          observedSpawns: ["shuttle"],
          observedToolCalls: 3,
          harnessCompletedWithoutError: true,
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  it("case entry without trajectorySummary field is valid (text-only cases)", () => {
    const entry = makeValidPublicCaseEntry();
    delete (entry as Record<string, unknown>).trajectorySummary;
    expect(PublicCaseEntrySchema.safeParse(entry).success).toBe(true);
  });

  it("rejects a trajectorySummary missing a required field", () => {
    const result = PublicCaseEntrySchema.safeParse(
      makeValidPublicCaseEntry({
        trajectorySummary: {
          harnessDelegatedCorrectly: true,
          observedSpawns: ["shuttle"],
          harnessCompletedWithoutError: true,
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a trajectorySummary with an unknown extra field (closed allowlist)", () => {
    const result = PublicCaseEntrySchema.safeParse(
      makeValidPublicCaseEntry({
        trajectorySummary: {
          harnessDelegatedCorrectly: true,
          observedSpawns: ["shuttle"],
          observedToolCalls: 3,
          harnessCompletedWithoutError: true,
          rawEvents: [{ type: "tool_call", args: { secret: "x" } }],
        },
      }),
    );
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SuiteSummaryEntrySchema — schemaVersion enforcement
// ---------------------------------------------------------------------------

describe("SuiteSummaryEntrySchema", () => {
  it("accepts a valid suite summary", () => {
    const result = SuiteSummaryEntrySchema.safeParse(
      makeValidSuiteSummaryEntry(),
    );
    expect(result.success).toBe(true);
  });

  it("requires schemaVersion field", () => {
    const entry = makeValidSuiteSummaryEntry();
    delete (entry as Record<string, unknown>).schemaVersion;
    const result = SuiteSummaryEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it("rejects incorrect schemaVersion", () => {
    const result = SuiteSummaryEntrySchema.safeParse(
      makeValidSuiteSummaryEntry({ schemaVersion: 99 }),
    );
    expect(result.success).toBe(false);
    const issue = result.error!.issues[0];
    expect(issue?.message).toContain(String(SUITE_SUMMARY_SCHEMA_VERSION));
  });

  it("rejects schemaVersion of 0", () => {
    const result = SuiteSummaryEntrySchema.safeParse(
      makeValidSuiteSummaryEntry({ schemaVersion: 0 }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects negative schemaVersion", () => {
    const result = SuiteSummaryEntrySchema.safeParse(
      makeValidSuiteSummaryEntry({ schemaVersion: -1 }),
    );
    expect(result.success).toBe(false);
  });

  it("requires hasRuntimeVerifiedCases field", () => {
    const entry = makeValidSuiteSummaryEntry();
    delete (entry as Record<string, unknown>).hasRuntimeVerifiedCases;
    const result = SuiteSummaryEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it("accepts hasRuntimeVerifiedCases true when a trajectory case is present", () => {
    const result = SuiteSummaryEntrySchema.safeParse(
      makeValidSuiteSummaryEntry({
        hasRuntimeVerifiedCases: true,
        cases: [
          makeValidPublicCaseEntry({
            trajectorySummary: {
              harnessDelegatedCorrectly: true,
              observedSpawns: ["shuttle"],
              observedToolCalls: 1,
              harnessCompletedWithoutError: true,
            },
          }),
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects empty suite name", () => {
    const result = SuiteSummaryEntrySchema.safeParse(
      makeValidSuiteSummaryEntry({ suite: "" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects cases with raw explanation content", () => {
    const result = SuiteSummaryEntrySchema.safeParse(
      makeValidSuiteSummaryEntry({
        cases: [
          makeValidPublicCaseEntry({
            explanation: {
              text: "rationale: model scored well",
              source: "operator_note",
            },
          }),
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts empty cases array", () => {
    const result = SuiteSummaryEntrySchema.safeParse(
      makeValidSuiteSummaryEntry({ cases: [] }),
    );
    expect(result.success).toBe(true);
  });

  // --- Suite-level explanation field (new in task 2) ---

  it("accepts a SuiteSummaryEntry with a valid bounded explanation", () => {
    const result = SuiteSummaryEntrySchema.safeParse(
      makeValidSuiteSummaryEntry({
        explanation: makeValidBoundedExplanation({
          text: "suite green; all 10 case(s) passed",
          source: "structured_signal",
        }),
      }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts a SuiteSummaryEntry without an explanation field (field is optional)", () => {
    const entry = makeValidSuiteSummaryEntry();
    delete (entry as Record<string, unknown>).explanation;
    expect(SuiteSummaryEntrySchema.safeParse(entry).success).toBe(true);
  });

  it("rejects a SuiteSummaryEntry whose explanation contains a rationale marker", () => {
    const result = SuiteSummaryEntrySchema.safeParse(
      makeValidSuiteSummaryEntry({
        explanation: {
          text: "rationale: all required cases passed",
          source: "structured_signal",
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a SuiteSummaryEntry whose explanation contains chain-of-thought", () => {
    const result = SuiteSummaryEntrySchema.safeParse(
      makeValidSuiteSummaryEntry({
        explanation: {
          text: "<thinking>10 of 10 cases passed</thinking>",
          source: "structured_signal",
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a SuiteSummaryEntry whose explanation exceeds EXPLANATION_MAX_CHARS", () => {
    const result = SuiteSummaryEntrySchema.safeParse(
      makeValidSuiteSummaryEntry({
        explanation: {
          text: "A".repeat(EXPLANATION_MAX_CHARS + 1),
          source: "structured_signal",
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a SuiteSummaryEntry whose explanation has a forbidden source (raw_rationale)", () => {
    const result = SuiteSummaryEntrySchema.safeParse(
      makeValidSuiteSummaryEntry({
        explanation: {
          text: "Suite passed all cases.",
          source: "raw_rationale",
        },
      }),
    );
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PublicReportBundleSchema — schemaVersion enforcement
// ---------------------------------------------------------------------------

describe("PublicReportBundleSchema", () => {
  it("accepts a valid report bundle", () => {
    const result = PublicReportBundleSchema.safeParse(
      makeValidPublicReportBundle(),
    );
    expect(result.success).toBe(true);
  });

  it("requires schemaVersion field", () => {
    const bundle = makeValidPublicReportBundle();
    delete (bundle as Record<string, unknown>).schemaVersion;
    const result = PublicReportBundleSchema.safeParse(bundle);
    expect(result.success).toBe(false);
  });

  it("rejects incorrect schemaVersion", () => {
    const result = PublicReportBundleSchema.safeParse(
      makeValidPublicReportBundle({ schemaVersion: 42 }),
    );
    expect(result.success).toBe(false);
    const issue = result.error!.issues[0];
    expect(issue?.message).toContain(String(REPORT_BUNDLE_SCHEMA_VERSION));
  });

  it("rejects bundle with no assembledAt", () => {
    const result = PublicReportBundleSchema.safeParse(
      makeValidPublicReportBundle({ assembledAt: "" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects bundle with no gitSha", () => {
    const result = PublicReportBundleSchema.safeParse(
      makeValidPublicReportBundle({ gitSha: "" }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts empty suiteSummaries array", () => {
    const result = PublicReportBundleSchema.safeParse(
      makeValidPublicReportBundle({ suiteSummaries: [] }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects bundle whose nested suite summary has wrong schemaVersion", () => {
    const result = PublicReportBundleSchema.safeParse(
      makeValidPublicReportBundle({
        suiteSummaries: [makeValidSuiteSummaryEntry({ schemaVersion: 99 })],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects bundle with chain-of-thought in a nested explanation", () => {
    const result = PublicReportBundleSchema.safeParse(
      makeValidPublicReportBundle({
        suiteSummaries: [
          makeValidSuiteSummaryEntry({
            cases: [
              makeValidPublicCaseEntry({
                explanation: {
                  text: "<thinking>Deep reasoning here</thinking>",
                  source: "operator_note",
                },
              }),
            ],
          }),
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("serialized valid bundle contains no raw content markers", () => {
    const parsed = PublicReportBundleSchema.safeParse(
      makeValidPublicReportBundle(),
    );
    expect(parsed.success).toBe(true);
    const json = JSON.stringify(parsed.data);
    expect(json).not.toContain('"rationale"');
    expect(json).not.toContain('"composedPrompt"');
    expect(json).not.toContain('"rawContent"');
    expect(json).not.toContain('"transcript"');
    expect(json).not.toContain('"dimensionRationales"');
  });
});

// ---------------------------------------------------------------------------
// The recorded judge (Spec 37, task 16.4)
// ---------------------------------------------------------------------------

describe("PublicReportBundleSchema.judge", () => {
  const JEV = {
    id: "typesafe/jev-1.13",
    version: "typesafe/jev-1.13-20260917",
  };

  it("accepts a report that records the judge", () => {
    const result = PublicReportBundleSchema.safeParse(
      makeValidPublicReportBundle({ judge: JEV }),
    );
    expect(result.success).toBe(true);
  });

  it("still accepts a report with no judge, as every run before 16.4 wrote", () => {
    const bundle = makeValidPublicReportBundle();
    expect("judge" in bundle).toBe(false);
    expect(PublicReportBundleSchema.safeParse(bundle).success).toBe(true);
  });

  it("rejects a judge with no version", () => {
    const result = PublicReportBundleSchema.safeParse(
      makeValidPublicReportBundle({ judge: { id: JEV.id } }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["judge", "version"]);
  });

  it("rejects any key besides id and version, so nothing else rides along", () => {
    const result = PublicReportBundleSchema.safeParse(
      makeValidPublicReportBundle({
        judge: { ...JEV, rationale: "the answer looked fine" },
      }),
    );
    expect(result.success).toBe(false);
  });
});

describe("JudgeIdentitySchema", () => {
  it.each([
    ["typesafe/jev-1.13", "typesafe/jev-1.13-20260917"],
    ["anthropic/claude-sonnet-4.5", "2025-09-29"],
  ])("accepts the model slug %s at %s", (id, version) => {
    expect(JudgeIdentitySchema.safeParse({ id, version }).success).toBe(true);
  });

  it.each([
    ["free text", "the judge thought this was fine"],
    ["markup", "<script>alert(1)</script>"],
    ["a Markdown link", "[x](https://example.com)"],
    ["an empty string", ""],
    ["an over-long slug", `a/${"b".repeat(200)}`],
  ])("rejects %s as a version, with a readable message", (_label, version) => {
    const result = JudgeIdentitySchema.safeParse({
      id: "typesafe/jev-1.13",
      version,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/judge fields must/);
  });
});

// ---------------------------------------------------------------------------
// DashboardManifestSchema — schemaVersion enforcement
// ---------------------------------------------------------------------------

describe("DashboardManifestSchema", () => {
  it("accepts a valid dashboard manifest", () => {
    const result = DashboardManifestSchema.safeParse(
      makeValidDashboardManifest(),
    );
    expect(result.success).toBe(true);
  });

  it("requires schemaVersion field", () => {
    const manifest = makeValidDashboardManifest();
    delete (manifest as Record<string, unknown>).schemaVersion;
    const result = DashboardManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it("rejects incorrect schemaVersion", () => {
    const result = DashboardManifestSchema.safeParse(
      makeValidDashboardManifest({ schemaVersion: 99 }),
    );
    expect(result.success).toBe(false);
    const issue = result.error!.issues[0];
    expect(issue?.message).toContain(String(DASHBOARD_MANIFEST_SCHEMA_VERSION));
  });

  it("rejects empty runs array (zero totalRuns is ok)", () => {
    // empty runs array is structurally valid; totalRuns mismatch is business logic
    const result = DashboardManifestSchema.safeParse(
      makeValidDashboardManifest({ runs: [], totalRuns: 0 }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects run entry with invalid runId (contains whitespace)", () => {
    const result = DashboardManifestSchema.safeParse(
      makeValidDashboardManifest({
        runs: [makeValidDashboardEntry({ runId: "has spaces here" })],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects run entry with empty bundleReportPath", () => {
    const result = DashboardManifestSchema.safeParse(
      makeValidDashboardManifest({
        runs: [makeValidDashboardEntry({ bundleReportPath: "" })],
      }),
    );
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DashboardEntrySchema — standalone
// ---------------------------------------------------------------------------

describe("DashboardEntrySchema", () => {
  it("accepts a valid entry", () => {
    expect(
      DashboardEntrySchema.safeParse(makeValidDashboardEntry()).success,
    ).toBe(true);
  });

  it("rejects entry with path separator in runId", () => {
    const result = DashboardEntrySchema.safeParse(
      makeValidDashboardEntry({ runId: "runs/abc1234" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects entry with empty gitSha", () => {
    const result = DashboardEntrySchema.safeParse(
      makeValidDashboardEntry({ gitSha: "" }),
    );
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SuiteHistoryManifestSchema — schemaVersion enforcement
// ---------------------------------------------------------------------------

describe("SuiteHistoryManifestSchema", () => {
  it("accepts a valid suite history manifest", () => {
    const result = SuiteHistoryManifestSchema.safeParse(
      makeValidSuiteHistoryManifest(),
    );
    expect(result.success).toBe(true);
  });

  it("requires schemaVersion field", () => {
    const manifest = makeValidSuiteHistoryManifest();
    delete (manifest as Record<string, unknown>).schemaVersion;
    const result = SuiteHistoryManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it("rejects incorrect schemaVersion", () => {
    const result = SuiteHistoryManifestSchema.safeParse(
      makeValidSuiteHistoryManifest({ schemaVersion: 99 }),
    );
    expect(result.success).toBe(false);
    const issue = result.error!.issues[0];
    expect(issue?.message).toContain(String(SUITE_HISTORY_SCHEMA_VERSION));
  });

  it("accepts null passRate for zero-case runs", () => {
    const result = SuiteHistoryManifestSchema.safeParse(
      makeValidSuiteHistoryManifest({
        history: [
          {
            assembledAt: "2026-01-01T00:00:00.000Z",
            gitSha: "abc123def456abc123def456abc123def456abc1",
            runId: "abc1234-2026-01-01",
            totalCases: 0,
            passedCases: 0,
            suiteGreen: false,
            passRate: null,
          },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects passRate > 1", () => {
    const result = SuiteHistoryManifestSchema.safeParse(
      makeValidSuiteHistoryManifest({
        history: [
          {
            assembledAt: "2026-01-01T00:00:00.000Z",
            gitSha: "abc123def456abc123def456abc123def456abc1",
            runId: "abc1234-2026-01-01",
            totalCases: 10,
            passedCases: 10,
            suiteGreen: true,
            passRate: 1.5,
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts empty history array", () => {
    const result = SuiteHistoryManifestSchema.safeParse(
      makeValidSuiteHistoryManifest({ history: [] }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects history point with invalid runId", () => {
    const result = SuiteHistoryManifestSchema.safeParse(
      makeValidSuiteHistoryManifest({
        history: [
          {
            assembledAt: "2026-01-01T00:00:00.000Z",
            gitSha: "abc123def456abc123def456abc123def456abc1",
            runId: "has/slash",
            totalCases: 10,
            passedCases: 9,
            suiteGreen: true,
            passRate: 0.9,
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ModelComparisonManifestSchema — schemaVersion enforcement
// ---------------------------------------------------------------------------

describe("ModelComparisonManifestSchema", () => {
  it("accepts a valid model comparison manifest", () => {
    const result = ModelComparisonManifestSchema.safeParse(
      makeValidModelComparisonManifest(),
    );
    expect(result.success).toBe(true);
  });

  it("requires schemaVersion field", () => {
    const manifest = makeValidModelComparisonManifest();
    delete (manifest as Record<string, unknown>).schemaVersion;
    const result = ModelComparisonManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it("rejects incorrect schemaVersion", () => {
    const result = ModelComparisonManifestSchema.safeParse(
      makeValidModelComparisonManifest({ schemaVersion: 99 }),
    );
    expect(result.success).toBe(false);
    const issue = result.error!.issues[0];
    expect(issue?.message).toContain(String(MODEL_COMPARISON_SCHEMA_VERSION));
  });

  it("rejects model entry with empty modelId", () => {
    const result = ModelComparisonManifestSchema.safeParse(
      makeValidModelComparisonManifest({
        models: [
          {
            modelId: "",
            displayName: "Model",
            totalCases: 5,
            passedCases: 4,
            failedCases: 1,
            passRate: 0.8,
            perSuitePassRates: {},
            overallBucket: "pass",
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts null passRate for zero-case models", () => {
    const result = ModelComparisonManifestSchema.safeParse(
      makeValidModelComparisonManifest({
        models: [
          {
            modelId: "anthropic/claude-sonnet-4.5",
            displayName: "Claude Sonnet 4.5",
            totalCases: 0,
            passedCases: 0,
            failedCases: 0,
            passRate: null,
            perSuitePassRates: {},
            overallBucket: "skip",
          },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects invalid overallBucket", () => {
    const result = ModelComparisonManifestSchema.safeParse(
      makeValidModelComparisonManifest({
        models: [
          {
            modelId: "anthropic/claude-sonnet-4.5",
            displayName: "Claude Sonnet 4.5",
            totalCases: 10,
            passedCases: 9,
            failedCases: 1,
            passRate: 0.9,
            perSuitePassRates: {},
            overallBucket: "excellent", // invalid
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts empty models array", () => {
    const result = ModelComparisonManifestSchema.safeParse(
      makeValidModelComparisonManifest({ models: [] }),
    );
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ModelComparisonEntrySchema — standalone
// ---------------------------------------------------------------------------

describe("ModelComparisonEntrySchema", () => {
  it("accepts a valid entry", () => {
    const result = ModelComparisonEntrySchema.safeParse({
      modelId: "openai/gpt-4o",
      displayName: "GPT-4o",
      totalCases: 10,
      passedCases: 8,
      failedCases: 2,
      passRate: 0.8,
      perSuitePassRates: { "loom-routing": 0.8, "tapestry-execution": 0.8 },
      overallBucket: "partial",
    });
    expect(result.success).toBe(true);
  });

  it("rejects passRate outside [0, 1]", () => {
    const result = ModelComparisonEntrySchema.safeParse({
      modelId: "openai/gpt-4o",
      displayName: "GPT-4o",
      totalCases: 10,
      passedCases: 8,
      failedCases: 2,
      passRate: 1.5,
      perSuitePassRates: {},
      overallBucket: "pass",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty displayName", () => {
    const result = ModelComparisonEntrySchema.safeParse({
      modelId: "openai/gpt-4o",
      displayName: "",
      totalCases: 10,
      passedCases: 8,
      failedCases: 2,
      passRate: 0.8,
      perSuitePassRates: {},
      overallBucket: "partial",
    });
    expect(result.success).toBe(false);
  });

  // --- Model-level explanation field (new in task 2) ---

  it("accepts a ModelComparisonEntry with a valid bounded explanation", () => {
    const result = ModelComparisonEntrySchema.safeParse({
      modelId: "openai/gpt-4o",
      displayName: "GPT-4o",
      totalCases: 10,
      passedCases: 8,
      failedCases: 2,
      passRate: 0.8,
      perSuitePassRates: { "loom-routing": 0.8 },
      overallBucket: "partial",
      explanation: makeValidBoundedExplanation({
        text: "model bucket: partial; 8/10 passed, 2 failed",
        source: "score_bucket_label",
      }),
    });
    expect(result.success).toBe(true);
  });

  it("accepts a ModelComparisonEntry without an explanation field (field is optional)", () => {
    const entry = {
      modelId: "openai/gpt-4o",
      displayName: "GPT-4o",
      totalCases: 10,
      passedCases: 8,
      failedCases: 2,
      passRate: 0.8,
      perSuitePassRates: {},
      overallBucket: "partial",
    };
    expect(ModelComparisonEntrySchema.safeParse(entry).success).toBe(true);
  });

  it("rejects a ModelComparisonEntry whose explanation contains a rationale marker", () => {
    const result = ModelComparisonEntrySchema.safeParse({
      modelId: "openai/gpt-4o",
      displayName: "GPT-4o",
      totalCases: 10,
      passedCases: 8,
      failedCases: 2,
      passRate: 0.8,
      perSuitePassRates: {},
      overallBucket: "partial",
      explanation: {
        text: "rationale: model performed well overall",
        source: "score_bucket_label",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a ModelComparisonEntry whose explanation contains chain-of-thought", () => {
    const result = ModelComparisonEntrySchema.safeParse({
      modelId: "openai/gpt-4o",
      displayName: "GPT-4o",
      totalCases: 10,
      passedCases: 8,
      failedCases: 2,
      passRate: 0.8,
      perSuitePassRates: {},
      overallBucket: "partial",
      explanation: {
        text: "<thinking>8 of 10 cases passed so partial</thinking>",
        source: "score_bucket_label",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a ModelComparisonEntry whose explanation exceeds EXPLANATION_MAX_CHARS", () => {
    const result = ModelComparisonEntrySchema.safeParse({
      modelId: "openai/gpt-4o",
      displayName: "GPT-4o",
      totalCases: 10,
      passedCases: 8,
      failedCases: 2,
      passRate: 0.8,
      perSuitePassRates: {},
      overallBucket: "partial",
      explanation: {
        text: "A".repeat(EXPLANATION_MAX_CHARS + 1),
        source: "score_bucket_label",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a ModelComparisonEntry whose explanation has a forbidden source", () => {
    const result = ModelComparisonEntrySchema.safeParse({
      modelId: "openai/gpt-4o",
      displayName: "GPT-4o",
      totalCases: 10,
      passedCases: 8,
      failedCases: 2,
      passRate: 0.8,
      perSuitePassRates: {},
      overallBucket: "partial",
      explanation: {
        text: "Model performed well.",
        source: "transcript_content",
      },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-schema: sensitive field rejection at schema level
//
// All public schemas use strict mode (.strict() in Zod). Unknown keys —
// including all sensitive fields — cause parse FAILURE rather than silent
// stripping. This ensures callers must sanitize before passing data to a
// public schema.
// ---------------------------------------------------------------------------

describe("Public schemas reject sensitive field names", () => {
  it("PublicCaseEntrySchema rejects an object with a 'rationale' field", () => {
    const entry = {
      ...makeValidPublicCaseEntry(),
      rationale: "This should never be here",
    };
    // Strict mode: unknown key 'rationale' causes a parse failure.
    const result = PublicCaseEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it("PublicCaseEntrySchema rejects an object with a 'composedPrompt' field", () => {
    const entry = {
      ...makeValidPublicCaseEntry(),
      composedPrompt: "You are Loom...",
    };
    // Strict mode: unknown key 'composedPrompt' causes a parse failure.
    const result = PublicCaseEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it("PublicCaseEntrySchema rejects an object with a 'transcript' field", () => {
    const entry = {
      ...makeValidPublicCaseEntry(),
      transcript: [{ role: "user", content: "hello" }],
    };
    // Strict mode: unknown key 'transcript' causes a parse failure.
    const result = PublicCaseEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it("PublicCaseEntrySchema rejects an object with a 'rawContent' field", () => {
    const entry = {
      ...makeValidPublicCaseEntry(),
      rawContent: "The assistant said...",
    };
    const result = PublicCaseEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it("PublicCaseEntrySchema rejects an object with a 'prompt' field", () => {
    const entry = {
      ...makeValidPublicCaseEntry(),
      prompt: "You are an agent.",
    };
    const result = PublicCaseEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it("PublicCaseEntrySchema rejects an object with a 'toolArgs' field", () => {
    const entry = {
      ...makeValidPublicCaseEntry(),
      toolArgs: { filePath: "/secret/path" },
    };
    const result = PublicCaseEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it("PublicCaseEntrySchema rejects an object with an 'env' field", () => {
    const entry = {
      ...makeValidPublicCaseEntry(),
      env: { API_KEY: "secret-value" },
    };
    const result = PublicCaseEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it("PublicCaseEntrySchema rejects an object with a 'dimensionRationales' field", () => {
    const entry = {
      ...makeValidPublicCaseEntry(),
      dimensionRationales: { routingCorrectness: "routing was correct" },
    };
    const result = PublicCaseEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it("SuiteSummaryEntrySchema rejects an object with a 'rationale' field", () => {
    const entry = {
      ...makeValidSuiteSummaryEntry(),
      rationale: "Should not be here",
    };
    const result = SuiteSummaryEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it("SuiteSummaryEntrySchema rejects an object with a 'composedPrompt' field", () => {
    const entry = {
      ...makeValidSuiteSummaryEntry(),
      composedPrompt: "You are Loom...",
    };
    const result = SuiteSummaryEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it("PublicReportBundleSchema rejects an object with a 'dimensionRationales' field", () => {
    const bundle = {
      ...makeValidPublicReportBundle(),
      dimensionRationales: { routingCorrectness: "Great!" },
    };
    // Strict mode: unknown key 'dimensionRationales' causes a parse failure.
    const result = PublicReportBundleSchema.safeParse(bundle);
    expect(result.success).toBe(false);
  });

  it("PublicReportBundleSchema rejects an object with a 'rawContent' field", () => {
    const bundle = {
      ...makeValidPublicReportBundle(),
      rawContent: "Model output text",
    };
    const result = PublicReportBundleSchema.safeParse(bundle);
    expect(result.success).toBe(false);
  });

  it("PublicReportBundleSchema rejects an object with a 'transcript' field", () => {
    const bundle = {
      ...makeValidPublicReportBundle(),
      transcript: [{ role: "assistant", content: "hello" }],
    };
    const result = PublicReportBundleSchema.safeParse(bundle);
    expect(result.success).toBe(false);
  });

  it("DashboardManifestSchema rejects an object with a 'rationale' field", () => {
    const manifest = {
      ...makeValidDashboardManifest(),
      rationale: "should be rejected",
    };
    const result = DashboardManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it("DashboardManifestSchema rejects an object with a 'composedPrompt' field", () => {
    const manifest = {
      ...makeValidDashboardManifest(),
      composedPrompt: "You are Loom...",
    };
    const result = DashboardManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it("valid PublicCaseEntry with no extra fields parses successfully (strict confirms clean shape)", () => {
    // Confirm the strict schema still accepts correctly-shaped clean data.
    const entry = makeValidPublicCaseEntry();
    const result = PublicCaseEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it("valid PublicReportBundle with no extra fields parses successfully (strict confirms clean shape)", () => {
    const bundle = makeValidPublicReportBundle();
    const result = PublicReportBundleSchema.safeParse(bundle);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ScenarioRunHistoryEntrySchema
// ---------------------------------------------------------------------------

describe("ScenarioRunHistoryEntrySchema", () => {
  function makeValidRunHistoryEntry(overrides: Record<string, unknown> = {}) {
    return {
      runId: "abc1234-2026-01-15-001",
      assembledAt: "2026-01-15T12:00:00.000Z",
      status: "pass",
      passed: true,
      totalModels: 3,
      passedModels: 3,
      failedModels: 0,
      skippedModels: 0,
      ...overrides,
    };
  }

  it("accepts a valid run history entry", () => {
    const result = ScenarioRunHistoryEntrySchema.safeParse(
      makeValidRunHistoryEntry(),
    );
    expect(result.success).toBe(true);
  });

  it("rejects when runId is empty", () => {
    const result = ScenarioRunHistoryEntrySchema.safeParse(
      makeValidRunHistoryEntry({ runId: "" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects when runId contains path separators", () => {
    const result = ScenarioRunHistoryEntrySchema.safeParse(
      makeValidRunHistoryEntry({ runId: "abc/def" }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts status 'pass'", () => {
    const result = ScenarioRunHistoryEntrySchema.safeParse(
      makeValidRunHistoryEntry({ status: "pass", passed: true }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts status 'fail'", () => {
    const result = ScenarioRunHistoryEntrySchema.safeParse(
      makeValidRunHistoryEntry({ status: "fail", passed: false }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts status 'partial'", () => {
    const result = ScenarioRunHistoryEntrySchema.safeParse(
      makeValidRunHistoryEntry({ status: "partial", passed: false }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts status 'skip'", () => {
    const result = ScenarioRunHistoryEntrySchema.safeParse(
      makeValidRunHistoryEntry({
        status: "skip",
        passed: false,
        totalModels: 0,
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects invalid status value", () => {
    const result = ScenarioRunHistoryEntrySchema.safeParse(
      makeValidRunHistoryEntry({ status: "unknown" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects negative model counts", () => {
    const result = ScenarioRunHistoryEntrySchema.safeParse(
      makeValidRunHistoryEntry({ passedModels: -1 }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys (strict mode)", () => {
    const result = ScenarioRunHistoryEntrySchema.safeParse(
      makeValidRunHistoryEntry({ extraField: "bad" }),
    );
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ScenarioHistoryEntrySchema
// ---------------------------------------------------------------------------

describe("ScenarioHistoryEntrySchema", () => {
  function makeValidHistoryEntry(overrides: Record<string, unknown> = {}) {
    return {
      caseId: "route-to-shuttle",
      title: "route-to-shuttle",
      lastRuns: [
        {
          runId: "abc1234-2026-01-15-001",
          assembledAt: "2026-01-15T12:00:00.000Z",
          status: "pass",
          passed: true,
          totalModels: 2,
          passedModels: 2,
          failedModels: 0,
          skippedModels: 0,
        },
      ],
      ...overrides,
    };
  }

  it("accepts a valid scenario history entry", () => {
    const result = ScenarioHistoryEntrySchema.safeParse(
      makeValidHistoryEntry(),
    );
    expect(result.success).toBe(true);
  });

  it("accepts an entry with an optional description", () => {
    const result = ScenarioHistoryEntrySchema.safeParse(
      makeValidHistoryEntry({
        description: "Routes requests to the shuttle agent.",
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects when description exceeds EXPLANATION_MAX_CHARS", () => {
    const result = ScenarioHistoryEntrySchema.safeParse(
      makeValidHistoryEntry({
        description: "x".repeat(EXPLANATION_MAX_CHARS + 1),
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects empty caseId", () => {
    const result = ScenarioHistoryEntrySchema.safeParse(
      makeValidHistoryEntry({ caseId: "" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects empty title", () => {
    const result = ScenarioHistoryEntrySchema.safeParse(
      makeValidHistoryEntry({ title: "" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys (strict mode)", () => {
    const result = ScenarioHistoryEntrySchema.safeParse(
      makeValidHistoryEntry({ sensitiveField: "bad" }),
    );
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ScenarioHistoryIndexSchema
// ---------------------------------------------------------------------------

describe("ScenarioHistoryIndexSchema", () => {
  function makeValidScenarioIndex(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: SCENARIO_HISTORY_SCHEMA_VERSION,
      suite: "loom-routing",
      updatedAt: "2026-01-20T10:00:00.000Z",
      scenarios: [],
      ...overrides,
    };
  }

  it("accepts a valid empty scenario history index", () => {
    const result = ScenarioHistoryIndexSchema.safeParse(
      makeValidScenarioIndex(),
    );
    expect(result.success).toBe(true);
  });

  it("accepts a valid index with scenarios", () => {
    const result = ScenarioHistoryIndexSchema.safeParse(
      makeValidScenarioIndex({
        scenarios: [
          {
            caseId: "route-to-shuttle",
            title: "route-to-shuttle",
            lastRuns: [
              {
                runId: "abc1234-2026-01-15-001",
                assembledAt: "2026-01-15T12:00:00.000Z",
                status: "pass",
                passed: true,
                totalModels: 2,
                passedModels: 2,
                failedModels: 0,
                skippedModels: 0,
              },
            ],
          },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects wrong schemaVersion", () => {
    const result = ScenarioHistoryIndexSchema.safeParse(
      makeValidScenarioIndex({ schemaVersion: 999 }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects missing schemaVersion", () => {
    const { schemaVersion: _, ...rest } = makeValidScenarioIndex() as Record<
      string,
      unknown
    >;
    const result = ScenarioHistoryIndexSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects empty suite name", () => {
    const result = ScenarioHistoryIndexSchema.safeParse(
      makeValidScenarioIndex({ suite: "" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects empty updatedAt", () => {
    const result = ScenarioHistoryIndexSchema.safeParse(
      makeValidScenarioIndex({ updatedAt: "" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys (strict mode)", () => {
    const result = ScenarioHistoryIndexSchema.safeParse(
      makeValidScenarioIndex({ unexpectedKey: "bad" }),
    );
    expect(result.success).toBe(false);
  });

  it("SCENARIO_HISTORY_SCHEMA_VERSION constant is 1", () => {
    expect(SCENARIO_HISTORY_SCHEMA_VERSION).toBe(1);
  });

  it("SCENARIO_HISTORY_MAX_RUNS constant is 10", () => {
    expect(SCENARIO_HISTORY_MAX_RUNS).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Repeats (Spec 37, task 18.1)
// ---------------------------------------------------------------------------

function makeCaseTally(overrides: Record<string, unknown> = {}) {
  return {
    caseId: "route-to-shuttle",
    attempts: 4,
    passed: 2,
    failed: 1,
    errored: 1,
    passRate: 2 / 3,
    ...overrides,
  };
}

function makeModelTally(overrides: Record<string, unknown> = {}) {
  return {
    modelId: "anthropic/claude-sonnet-4.5",
    attempts: 4,
    passed: 2,
    failed: 1,
    errored: 1,
    passRate: 2 / 3,
    cases: [makeCaseTally()],
    ...overrides,
  };
}

function makeRepeatedSuite(overrides: Record<string, unknown> = {}) {
  return makeValidSuiteSummaryEntry({
    totalCases: 2,
    passedCases: 1,
    failedCases: 1,
    repeats: {
      repeatCount: 2,
      models: [
        makeModelTally({
          attempts: 2,
          passed: 1,
          failed: 1,
          errored: 0,
          passRate: 0.5,
          cases: [
            makeCaseTally({
              attempts: 2,
              passed: 1,
              failed: 1,
              errored: 0,
              passRate: 0.5,
            }),
          ],
        }),
      ],
    },
    cases: [
      makeValidPublicCaseEntry({ attempt: 1 }),
      makeValidPublicCaseEntry({
        attempt: 2,
        passed: false,
        scoreBucket: "fail",
      }),
    ],
    ...overrides,
  });
}

describe("CaseAttemptTallySchema", () => {
  it("accepts counts that add up, with the pass rate leaving errored attempts out", () => {
    expect(CaseAttemptTallySchema.safeParse(makeCaseTally()).success).toBe(
      true,
    );
  });

  it("rejects counts that do not add up to the attempts", () => {
    const result = CaseAttemptTallySchema.safeParse(
      makeCaseTally({ attempts: 5 }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
      "passed + failed + errored must equal attempts",
    );
  });

  it("rejects a pass rate that counts errored attempts as failures", () => {
    const result = CaseAttemptTallySchema.safeParse(
      makeCaseTally({ passRate: 0.5 }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["passRate"]);
  });

  it("requires a null pass rate when every attempt errored", () => {
    const allErrored = makeCaseTally({
      attempts: 2,
      passed: 0,
      failed: 0,
      errored: 2,
      passRate: null,
    });
    expect(CaseAttemptTallySchema.safeParse(allErrored).success).toBe(true);
    const zero = { ...allErrored, passRate: 0 };
    expect(CaseAttemptTallySchema.safeParse(zero).success).toBe(false);
  });

  it("rejects a null pass rate when attempts were scored", () => {
    const result = CaseAttemptTallySchema.safeParse(
      makeCaseTally({ passRate: null }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys", () => {
    const result = CaseAttemptTallySchema.safeParse(
      makeCaseTally({ rationale: "no" }),
    );
    expect(result.success).toBe(false);
  });
});

describe("ModelAttemptTallySchema", () => {
  it("accepts a model tally with its per-case tallies", () => {
    expect(ModelAttemptTallySchema.safeParse(makeModelTally()).success).toBe(
      true,
    );
  });

  it("rejects a model tally whose rate is not its counts", () => {
    const result = ModelAttemptTallySchema.safeParse(
      makeModelTally({ passRate: 1 }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a malformed per-case tally", () => {
    const result = ModelAttemptTallySchema.safeParse(
      makeModelTally({ cases: [makeCaseTally({ attempts: 0 })] }),
    );
    expect(result.success).toBe(false);
  });
});

describe("PublicCaseEntrySchema — attempt and errored", () => {
  it("accepts an attempt index and an errored flag", () => {
    const result = PublicCaseEntrySchema.safeParse(
      makeValidPublicCaseEntry({ attempt: 3, errored: true, passed: false }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects an attempt index below 1", () => {
    const result = PublicCaseEntrySchema.safeParse(
      makeValidPublicCaseEntry({ attempt: 0 }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a fractional attempt index", () => {
    const result = PublicCaseEntrySchema.safeParse(
      makeValidPublicCaseEntry({ attempt: 1.5 }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a non-boolean errored flag", () => {
    const result = PublicCaseEntrySchema.safeParse(
      makeValidPublicCaseEntry({ errored: "yes" }),
    );
    expect(result.success).toBe(false);
  });
});

describe("SuiteSummaryEntrySchema — repeats", () => {
  it("accepts a repeated suite whose entries carry their attempts", () => {
    const result = SuiteSummaryEntrySchema.safeParse(makeRepeatedSuite());
    expect(result.success).toBe(true);
  });

  it("still accepts a suite that ran each case once, with no repeat fields", () => {
    const result = SuiteSummaryEntrySchema.safeParse(
      makeValidSuiteSummaryEntry(),
    );
    expect(result.success).toBe(true);
  });

  it("rejects a repeat count of 1, which is written as no repeats at all", () => {
    const suite = makeRepeatedSuite();
    const result = SuiteSummaryEntrySchema.safeParse({
      ...suite,
      repeats: { ...(suite as { repeats?: object }).repeats, repeatCount: 1 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an attempt on a suite without repeats", () => {
    const result = SuiteSummaryEntrySchema.safeParse(
      makeValidSuiteSummaryEntry({
        cases: [makeValidPublicCaseEntry({ attempt: 1 })],
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["cases", 0, "attempt"]);
  });

  it("rejects a repeated suite with an entry missing its attempt", () => {
    const result = SuiteSummaryEntrySchema.safeParse(
      makeRepeatedSuite({ cases: [makeValidPublicCaseEntry()] }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects an attempt beyond the repeat count", () => {
    const result = SuiteSummaryEntrySchema.safeParse(
      makeRepeatedSuite({ cases: [makeValidPublicCaseEntry({ attempt: 3 })] }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys in the repeats block", () => {
    const suite = makeRepeatedSuite();
    const result = SuiteSummaryEntrySchema.safeParse({
      ...suite,
      repeats: {
        ...(suite as { repeats?: object }).repeats,
        transcript: "leak",
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("repeatCount on the report and the indexes", () => {
  it("accepts repeatCount on the run summary", () => {
    const bundle = makeValidPublicReportBundle();
    const result = PublicReportBundleSchema.safeParse({
      ...bundle,
      runSummary: { ...bundle.runSummary, repeatCount: 3 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects repeatCount 1 on the run summary", () => {
    const bundle = makeValidPublicReportBundle();
    const result = PublicReportBundleSchema.safeParse({
      ...bundle,
      runSummary: { ...bundle.runSummary, repeatCount: 1 },
    });
    expect(result.success).toBe(false);
  });

  it("accepts repeatCount on a dashboard entry, and rejects a fraction", () => {
    expect(
      DashboardEntrySchema.safeParse(
        makeValidDashboardEntry({ repeatCount: 5 }),
      ).success,
    ).toBe(true);
    expect(
      DashboardEntrySchema.safeParse(
        makeValidDashboardEntry({ repeatCount: 2.5 }),
      ).success,
    ).toBe(false);
  });

  it("accepts repeatCount on a suite history point, and rejects 0", () => {
    const manifest = makeValidSuiteHistoryManifest();
    const point = (manifest.history as Array<Record<string, unknown>>)[0];
    expect(
      SuiteHistoryManifestSchema.safeParse({
        ...manifest,
        history: [{ ...point, repeatCount: 3 }],
      }).success,
    ).toBe(true);
    expect(
      SuiteHistoryManifestSchema.safeParse({
        ...manifest,
        history: [{ ...point, repeatCount: 0 }],
      }).success,
    ).toBe(false);
  });

  it("accepts repeatCount on a model-comparison manifest, and rejects a string", () => {
    expect(
      ModelComparisonManifestSchema.safeParse(
        makeValidModelComparisonManifest({ repeatCount: 3 }),
      ).success,
    ).toBe(true);
    expect(
      ModelComparisonManifestSchema.safeParse(
        makeValidModelComparisonManifest({ repeatCount: "3" }),
      ).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Errored cases (Spec 37, 16.5)
// ---------------------------------------------------------------------------

describe("errored cases in public schemas", () => {
  const ERRORED_ENTRY = makeValidPublicCaseEntry({
    caseId: "route-errored",
    scoreBucket: "skip",
    passed: false,
    errored: true,
    errorClassification: "model-empty-response",
  });

  describe("PublicCaseEntrySchema.errorClassification", () => {
    it("accepts an errored entry with its classification", () => {
      expect(PublicCaseEntrySchema.safeParse(ERRORED_ENTRY).success).toBe(true);
    });

    it("accepts a trajectory classification label", () => {
      const result = PublicCaseEntrySchema.safeParse({
        ...ERRORED_ENTRY,
        errorClassification: "trajectory-TrajectoryRunnerUnavailable",
      });
      expect(result.success).toBe(true);
    });

    it("rejects an errored entry that claims to have passed", () => {
      const result = PublicCaseEntrySchema.safeParse({
        ...ERRORED_ENTRY,
        passed: true,
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["passed"]);
      expect(result.error?.issues[0]?.message).toContain("never scored");
    });

    it("rejects a classification on an entry that did not error", () => {
      const result = PublicCaseEntrySchema.safeParse(
        makeValidPublicCaseEntry({
          errorClassification: "model-empty-response",
        }),
      );
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["errorClassification"]);
    });

    it("rejects a classification carrying message text", () => {
      const result = PublicCaseEntrySchema.safeParse({
        ...ERRORED_ENTRY,
        errorClassification: "connect ECONNREFUSED sk-or-v1-abc",
      });
      expect(result.success).toBe(false);
    });

    it("rejects an empty or overlong classification", () => {
      for (const errorClassification of ["", "a".repeat(81)]) {
        expect(
          PublicCaseEntrySchema.safeParse({
            ...ERRORED_ENTRY,
            errorClassification,
          }).success,
        ).toBe(false);
      }
    });
  });

  describe("SuiteSummaryEntrySchema.erroredCases", () => {
    it("accepts a count that matches the errored entries", () => {
      const result = SuiteSummaryEntrySchema.safeParse(
        makeValidSuiteSummaryEntry({
          totalCases: 2,
          passedCases: 1,
          failedCases: 0,
          erroredCases: 1,
          cases: [makeValidPublicCaseEntry(), ERRORED_ENTRY],
        }),
      );
      expect(result.success).toBe(true);
    });

    it("still accepts a summary without the field when no case errored", () => {
      const result = SuiteSummaryEntrySchema.safeParse(
        makeValidSuiteSummaryEntry(),
      );
      expect(result.success).toBe(true);
    });

    it("rejects an errored entry the count leaves out", () => {
      const result = SuiteSummaryEntrySchema.safeParse(
        makeValidSuiteSummaryEntry({
          cases: [makeValidPublicCaseEntry(), ERRORED_ENTRY],
        }),
      );
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["erroredCases"]);
    });

    it("rejects a count with no errored entry behind it", () => {
      const result = SuiteSummaryEntrySchema.safeParse(
        makeValidSuiteSummaryEntry({ erroredCases: 1 }),
      );
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain("may not be dropped");
    });

    it("rejects a negative or fractional count", () => {
      for (const erroredCases of [-1, 0.5]) {
        expect(
          SuiteSummaryEntrySchema.safeParse(
            makeValidSuiteSummaryEntry({ erroredCases }),
          ).success,
        ).toBe(false);
      }
    });
  });

  describe("aggregate records accept an optional erroredCases", () => {
    it("PublicReportBundleSchema.runSummary", () => {
      const bundle = makeValidPublicReportBundle();
      const accepted = PublicReportBundleSchema.safeParse({
        ...bundle,
        runSummary: { ...bundle.runSummary, erroredCases: 1 },
      });
      const rejected = PublicReportBundleSchema.safeParse({
        ...bundle,
        runSummary: { ...bundle.runSummary, erroredCases: -1 },
      });
      expect(accepted.success).toBe(true);
      expect(rejected.success).toBe(false);
    });

    it("DashboardEntrySchema", () => {
      expect(
        DashboardEntrySchema.safeParse(
          makeValidDashboardEntry({ erroredCases: 2 }),
        ).success,
      ).toBe(true);
      expect(
        DashboardEntrySchema.safeParse(
          makeValidDashboardEntry({ erroredCases: "2" }),
        ).success,
      ).toBe(false);
    });

    it("SuiteHistoryManifestSchema history points", () => {
      const manifest = makeValidSuiteHistoryManifest();
      const point = { ...manifest.history[0], erroredCases: 1, passRate: 1 };
      expect(
        SuiteHistoryManifestSchema.safeParse({ ...manifest, history: [point] })
          .success,
      ).toBe(true);
      expect(
        SuiteHistoryManifestSchema.safeParse({
          ...manifest,
          history: [{ ...point, erroredCases: -3 }],
        }).success,
      ).toBe(false);
    });

    it("ModelComparisonEntrySchema", () => {
      const entry = {
        modelId: "deepseek/deepseek-v4-flash-0731",
        displayName: "DeepSeek V4 Flash",
        totalCases: 3,
        passedCases: 0,
        failedCases: 0,
        erroredCases: 3,
        passRate: null,
        perSuitePassRates: { "loom-routing": null },
        overallBucket: "skip",
      };
      expect(ModelComparisonEntrySchema.safeParse(entry).success).toBe(true);
      expect(
        ModelComparisonEntrySchema.safeParse({ ...entry, erroredCases: 1.5 })
          .success,
      ).toBe(false);
    });

    it("ScenarioRunHistoryEntrySchema.erroredModels", () => {
      const entry = {
        runId: "abc1234-2026-01-15-001",
        assembledAt: "2026-01-15T12:00:00.000Z",
        status: "skip",
        passed: false,
        totalModels: 0,
        passedModels: 0,
        failedModels: 0,
        skippedModels: 1,
        erroredModels: 1,
      };
      expect(ScenarioRunHistoryEntrySchema.safeParse(entry).success).toBe(true);
      expect(
        ScenarioRunHistoryEntrySchema.safeParse({ ...entry, erroredModels: -1 })
          .success,
      ).toBe(false);
    });
  });
});
