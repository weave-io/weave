/**
 * Tests for `report-schema.ts`.
 *
 * Verifies:
 *   - All public schema types require `schemaVersion`.
 *   - Schemas reject incorrect or missing `schemaVersion` values.
 *   - `BoundedExplanationSchema` rejects raw text inputs (rationale markers,
 *     transcript role markers, chain-of-thought markers, prompt delimiters,
 *     secret patterns, justification markers, score markers).
 *   - `BoundedExplanationSchema` rejects overlong explanations.
 *   - `BoundedExplanationSchema` rejects empty explanations.
 *   - `BoundedExplanationSchema` accepts valid, sanitized explanations.
 *   - `BoundedExplanationSchema` rejects all forbidden `ExplanationSource`
 *     values (only allowlisted enum members pass).
 *   - `PublicCaseEntrySchema` rejects sensitive fields and raw text.
 *   - `SuiteSummaryEntrySchema` validates aggregate fields and nested cases.
 *   - `PublicReportBundleSchema` validates the full bundle shape.
 *   - `DashboardManifestSchema` validates entry manifest with run index.
 *   - `SuiteHistoryManifestSchema` validates history time series.
 *   - `ModelComparisonManifestSchema` validates per-model comparison entries.
 *   - `computeScoreBucket()` maps score values to correct buckets.
 *   - `FORBIDDEN_EXPLANATION_PATTERNS` covers all required forbidden pattern types.
 *
 * Test isolation:
 *   - No file I/O, network, git, or shell calls.
 *   - All fixtures are constructed inline.
 *   - All schema validations use `safeParse()` to avoid thrown exceptions.
 */

import { describe, expect, it } from "bun:test";
import {
  BoundedExplanationSchema,
  computeScoreBucket,
  DASHBOARD_MANIFEST_SCHEMA_VERSION,
  DashboardEntrySchema,
  DashboardManifestSchema,
  EXPLANATION_MAX_CHARS,
  ExplanationSourceSchema,
  FORBIDDEN_EXPLANATION_PATTERNS,
  MODEL_COMPARISON_SCHEMA_VERSION,
  ModelComparisonEntrySchema,
  ModelComparisonManifestSchema,
  PublicCaseEntrySchema,
  PublicReportBundleSchema,
  REPORT_BUNDLE_SCHEMA_VERSION,
  ScoreBucketSchema,
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
// FORBIDDEN_EXPLANATION_PATTERNS — pattern coverage
// ---------------------------------------------------------------------------

describe("FORBIDDEN_EXPLANATION_PATTERNS", () => {
  it("includes a pattern for chain_of_thought_xml", () => {
    const names = FORBIDDEN_EXPLANATION_PATTERNS.map((p) => p.name);
    expect(names).toContain("chain_of_thought_xml");
  });

  it("includes a pattern for transcript_role_marker", () => {
    const names = FORBIDDEN_EXPLANATION_PATTERNS.map((p) => p.name);
    expect(names).toContain("transcript_role_marker");
  });

  it("includes a pattern for prompt_delimiter", () => {
    const names = FORBIDDEN_EXPLANATION_PATTERNS.map((p) => p.name);
    expect(names).toContain("prompt_delimiter");
  });

  it("includes a pattern for raw_rationale_marker", () => {
    const names = FORBIDDEN_EXPLANATION_PATTERNS.map((p) => p.name);
    expect(names).toContain("raw_rationale_marker");
  });

  it("includes a pattern for raw_score_marker", () => {
    const names = FORBIDDEN_EXPLANATION_PATTERNS.map((p) => p.name);
    expect(names).toContain("raw_score_marker");
  });

  it("includes a pattern for justification_marker", () => {
    const names = FORBIDDEN_EXPLANATION_PATTERNS.map((p) => p.name);
    expect(names).toContain("justification_marker");
  });

  it("includes a pattern for secret_token_pattern", () => {
    const names = FORBIDDEN_EXPLANATION_PATTERNS.map((p) => p.name);
    expect(names).toContain("secret_token_pattern");
  });

  it("chain_of_thought_xml matches <thinking>", () => {
    const entry = FORBIDDEN_EXPLANATION_PATTERNS.find(
      (p) => p.name === "chain_of_thought_xml",
    );
    expect(entry).toBeDefined();
    expect(entry!.pattern.test("<thinking>")).toBe(true);
  });

  it("chain_of_thought_xml matches <cot>", () => {
    const entry = FORBIDDEN_EXPLANATION_PATTERNS.find(
      (p) => p.name === "chain_of_thought_xml",
    );
    expect(entry!.pattern.test("<cot>")).toBe(true);
  });

  it("chain_of_thought_xml matches <reasoning>", () => {
    const entry = FORBIDDEN_EXPLANATION_PATTERNS.find(
      (p) => p.name === "chain_of_thought_xml",
    );
    expect(entry!.pattern.test("<reasoning>")).toBe(true);
  });

  it("chain_of_thought_xml matches <scratchpad>", () => {
    const entry = FORBIDDEN_EXPLANATION_PATTERNS.find(
      (p) => p.name === "chain_of_thought_xml",
    );
    expect(entry!.pattern.test("<scratchpad>")).toBe(true);
  });

  it("transcript_role_marker matches 'User:'", () => {
    const entry = FORBIDDEN_EXPLANATION_PATTERNS.find(
      (p) => p.name === "transcript_role_marker",
    );
    expect(entry!.pattern.test("\nUser: some input")).toBe(true);
  });

  it("transcript_role_marker matches 'Assistant:'", () => {
    const entry = FORBIDDEN_EXPLANATION_PATTERNS.find(
      (p) => p.name === "transcript_role_marker",
    );
    expect(entry!.pattern.test("\nAssistant: response")).toBe(true);
  });

  it("transcript_role_marker matches 'Human:'", () => {
    const entry = FORBIDDEN_EXPLANATION_PATTERNS.find(
      (p) => p.name === "transcript_role_marker",
    );
    expect(entry!.pattern.test("\nHuman: some message")).toBe(true);
  });

  it("transcript_role_marker matches 'System:'", () => {
    const entry = FORBIDDEN_EXPLANATION_PATTERNS.find(
      (p) => p.name === "transcript_role_marker",
    );
    expect(entry!.pattern.test("\nSystem: prompt")).toBe(true);
  });

  it("prompt_delimiter matches <system>", () => {
    const entry = FORBIDDEN_EXPLANATION_PATTERNS.find(
      (p) => p.name === "prompt_delimiter",
    );
    expect(entry!.pattern.test("<system>")).toBe(true);
  });

  it("prompt_delimiter matches <prompt>", () => {
    const entry = FORBIDDEN_EXPLANATION_PATTERNS.find(
      (p) => p.name === "prompt_delimiter",
    );
    expect(entry!.pattern.test("<prompt>")).toBe(true);
  });

  it("raw_rationale_marker matches 'rationale:'", () => {
    const entry = FORBIDDEN_EXPLANATION_PATTERNS.find(
      (p) => p.name === "raw_rationale_marker",
    );
    expect(entry!.pattern.test("rationale: the model did X")).toBe(true);
  });

  it("raw_score_marker matches 'score: 0.8'", () => {
    const entry = FORBIDDEN_EXPLANATION_PATTERNS.find(
      (p) => p.name === "raw_score_marker",
    );
    expect(entry!.pattern.test("score: 0.8")).toBe(true);
  });

  it("justification_marker matches 'justification:'", () => {
    const entry = FORBIDDEN_EXPLANATION_PATTERNS.find(
      (p) => p.name === "justification_marker",
    );
    expect(entry!.pattern.test("justification: because...")).toBe(true);
  });

  it("justification_marker matches 'explanation:'", () => {
    const entry = FORBIDDEN_EXPLANATION_PATTERNS.find(
      (p) => p.name === "justification_marker",
    );
    expect(entry!.pattern.test("explanation: the thing")).toBe(true);
  });

  it("secret_token_pattern matches 'sk-xxxxxxxxxxxx'", () => {
    const entry = FORBIDDEN_EXPLANATION_PATTERNS.find(
      (p) => p.name === "secret_token_pattern",
    );
    expect(entry!.pattern.test("key: sk-abcdefghijklmno")).toBe(true);
  });

  it("secret_token_pattern matches 'Bearer xxxxxxxxxxxxx'", () => {
    const entry = FORBIDDEN_EXPLANATION_PATTERNS.find(
      (p) => p.name === "secret_token_pattern",
    );
    expect(entry!.pattern.test("Authorization: Bearer abcdefghijk1234")).toBe(
      true,
    );
  });

  it("secret_token_pattern matches 'ghp_xxxxxxxxxxxxx'", () => {
    const entry = FORBIDDEN_EXPLANATION_PATTERNS.find(
      (p) => p.name === "secret_token_pattern",
    );
    expect(entry!.pattern.test("token: ghp_abcdefghijklmno")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ExplanationSource enum
// ---------------------------------------------------------------------------

describe("ExplanationSourceSchema", () => {
  it("accepts rubric_template", () => {
    expect(ExplanationSourceSchema.safeParse("rubric_template").success).toBe(
      true,
    );
  });

  it("accepts score_bucket_label", () => {
    expect(
      ExplanationSourceSchema.safeParse("score_bucket_label").success,
    ).toBe(true);
  });

  it("accepts structured_signal", () => {
    expect(ExplanationSourceSchema.safeParse("structured_signal").success).toBe(
      true,
    );
  });

  it("accepts operator_note", () => {
    expect(ExplanationSourceSchema.safeParse("operator_note").success).toBe(
      true,
    );
  });

  it("rejects raw_rationale (not an allowlisted enum value)", () => {
    expect(ExplanationSourceSchema.safeParse("raw_rationale").success).toBe(
      false,
    );
  });

  it("rejects transcript_content", () => {
    expect(
      ExplanationSourceSchema.safeParse("transcript_content").success,
    ).toBe(false);
  });

  it("rejects llm_freeform_summary", () => {
    expect(
      ExplanationSourceSchema.safeParse("llm_freeform_summary").success,
    ).toBe(false);
  });

  it("rejects empty string", () => {
    expect(ExplanationSourceSchema.safeParse("").success).toBe(false);
  });

  it("rejects arbitrary unknown string", () => {
    expect(ExplanationSourceSchema.safeParse("unknown_source").success).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// BoundedExplanationSchema
// ---------------------------------------------------------------------------

describe("BoundedExplanationSchema", () => {
  // --- Happy path ---

  it("accepts a valid rubric_template explanation", () => {
    const result = BoundedExplanationSchema.safeParse(
      makeValidBoundedExplanation({
        source: "rubric_template",
        text: "Agent routed correctly per rubric definition.",
      }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts a valid score_bucket_label explanation", () => {
    const result = BoundedExplanationSchema.safeParse(
      makeValidBoundedExplanation({ source: "score_bucket_label" }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts a valid structured_signal explanation", () => {
    const result = BoundedExplanationSchema.safeParse(
      makeValidBoundedExplanation({
        source: "structured_signal",
        text: "routing_matched: true",
      }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts a valid operator_note explanation", () => {
    const result = BoundedExplanationSchema.safeParse(
      makeValidBoundedExplanation({
        source: "operator_note",
        text: "Reviewed by team lead on 2026-01-01.",
      }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts explanation at exactly EXPLANATION_MAX_CHARS length", () => {
    const text = "A".repeat(EXPLANATION_MAX_CHARS);
    const result = BoundedExplanationSchema.safeParse(
      makeValidBoundedExplanation({ text }),
    );
    expect(result.success).toBe(true);
  });

  // --- Overlong rejection ---

  it("rejects explanation exceeding EXPLANATION_MAX_CHARS", () => {
    const text = "A".repeat(EXPLANATION_MAX_CHARS + 1);
    const result = BoundedExplanationSchema.safeParse(
      makeValidBoundedExplanation({ text }),
    );
    expect(result.success).toBe(false);
    const error = result.error!.issues[0];
    expect(error?.message).toContain(String(EXPLANATION_MAX_CHARS));
  });

  // --- Empty text rejection ---

  it("rejects empty explanation text", () => {
    const result = BoundedExplanationSchema.safeParse(
      makeValidBoundedExplanation({ text: "" }),
    );
    expect(result.success).toBe(false);
  });

  // --- Forbidden source rejection ---

  it("rejects raw_rationale as source (not an allowlisted enum)", () => {
    const result = BoundedExplanationSchema.safeParse({
      text: "Correct routing.",
      source: "raw_rationale",
    });
    expect(result.success).toBe(false);
  });

  it("rejects transcript_content as source", () => {
    const result = BoundedExplanationSchema.safeParse({
      text: "Some text.",
      source: "transcript_content",
    });
    expect(result.success).toBe(false);
  });

  it("rejects llm_freeform_summary as source", () => {
    const result = BoundedExplanationSchema.safeParse({
      text: "The model performed well.",
      source: "llm_freeform_summary",
    });
    expect(result.success).toBe(false);
  });

  it("rejects raw_content as source", () => {
    const result = BoundedExplanationSchema.safeParse({
      text: "Some content.",
      source: "raw_content",
    });
    expect(result.success).toBe(false);
  });

  // --- Forbidden pattern rejection ---

  it("rejects explanation text containing <thinking> (chain-of-thought)", () => {
    const result = BoundedExplanationSchema.safeParse(
      makeValidBoundedExplanation({
        text: "<thinking>Internal reasoning goes here</thinking>",
        source: "operator_note",
      }),
    );
    expect(result.success).toBe(false);
    const issue = result.error!.issues.find((i) =>
      i.message.includes("chain_of_thought_xml"),
    );
    expect(issue).toBeDefined();
  });

  it("rejects explanation text containing <cot>", () => {
    const result = BoundedExplanationSchema.safeParse(
      makeValidBoundedExplanation({
        text: "<cot>step by step...</cot>",
        source: "operator_note",
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects explanation text containing <reasoning>", () => {
    const result = BoundedExplanationSchema.safeParse(
      makeValidBoundedExplanation({
        text: "<reasoning>Therefore...</reasoning>",
        source: "operator_note",
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects explanation text containing transcript role marker (\\nUser:)", () => {
    const result = BoundedExplanationSchema.safeParse(
      makeValidBoundedExplanation({
        text: "Start\nUser: some message\nAssistant: reply",
        source: "operator_note",
      }),
    );
    expect(result.success).toBe(false);
    const issue = result.error!.issues.find((i) =>
      i.message.includes("transcript_role_marker"),
    );
    expect(issue).toBeDefined();
  });

  it("rejects explanation text containing 'rationale:' (raw rationale marker)", () => {
    const result = BoundedExplanationSchema.safeParse(
      makeValidBoundedExplanation({
        text: "rationale: the model correctly routed",
        source: "operator_note",
      }),
    );
    expect(result.success).toBe(false);
    const issue = result.error!.issues.find((i) =>
      i.message.includes("raw_rationale_marker"),
    );
    expect(issue).toBeDefined();
  });

  it("rejects explanation text containing 'score: 0.9' (raw score marker)", () => {
    const result = BoundedExplanationSchema.safeParse(
      makeValidBoundedExplanation({
        text: "score: 0.9 for this case",
        source: "operator_note",
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects explanation text containing 'justification:' marker", () => {
    const result = BoundedExplanationSchema.safeParse(
      makeValidBoundedExplanation({
        text: "justification: because the agent did X",
        source: "operator_note",
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects explanation text containing 'explanation:' marker", () => {
    const result = BoundedExplanationSchema.safeParse(
      makeValidBoundedExplanation({
        text: "explanation: model selected shuttle correctly",
        source: "operator_note",
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects explanation text containing <system> (prompt delimiter)", () => {
    const result = BoundedExplanationSchema.safeParse(
      makeValidBoundedExplanation({
        text: "<system>You are an agent.</system>",
        source: "operator_note",
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects explanation text containing a Bearer token pattern", () => {
    const result = BoundedExplanationSchema.safeParse(
      makeValidBoundedExplanation({
        text: "Authorization: Bearer sk-abc123xyz456pqr",
        source: "operator_note",
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects explanation text containing a secret key pattern (sk-)", () => {
    const result = BoundedExplanationSchema.safeParse(
      makeValidBoundedExplanation({
        text: "key used: sk-abcdefghijklmnop",
        source: "operator_note",
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects explanation text containing a GitHub token pattern (ghp_)", () => {
    const result = BoundedExplanationSchema.safeParse(
      makeValidBoundedExplanation({
        text: "token: ghp_abcdefghijklmnop",
        source: "operator_note",
      }),
    );
    expect(result.success).toBe(false);
  });

  // --- Missing fields ---

  it("rejects explanation without text field", () => {
    const result = BoundedExplanationSchema.safeParse({
      source: "score_bucket_label",
    });
    expect(result.success).toBe(false);
  });

  it("rejects explanation without source field", () => {
    const result = BoundedExplanationSchema.safeParse({
      text: "Valid explanation.",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ScoreBucketSchema
// ---------------------------------------------------------------------------

describe("ScoreBucketSchema", () => {
  it("accepts 'pass'", () => {
    expect(ScoreBucketSchema.safeParse("pass").success).toBe(true);
  });

  it("accepts 'partial'", () => {
    expect(ScoreBucketSchema.safeParse("partial").success).toBe(true);
  });

  it("accepts 'fail'", () => {
    expect(ScoreBucketSchema.safeParse("fail").success).toBe(true);
  });

  it("accepts 'skip'", () => {
    expect(ScoreBucketSchema.safeParse("skip").success).toBe(true);
  });

  it("rejects 'unknown'", () => {
    expect(ScoreBucketSchema.safeParse("unknown").success).toBe(false);
  });

  it("rejects '1.0'", () => {
    expect(ScoreBucketSchema.safeParse("1.0").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeScoreBucket
// ---------------------------------------------------------------------------

describe("computeScoreBucket", () => {
  it("returns 'skip' for dryRun=true regardless of score", () => {
    expect(computeScoreBucket(1.0, true)).toBe("skip");
    expect(computeScoreBucket(0.0, true)).toBe("skip");
    expect(computeScoreBucket(0.5, true)).toBe("skip");
  });

  it("returns 'skip' when weightedTotal is undefined", () => {
    expect(computeScoreBucket(undefined, false)).toBe("skip");
  });

  it("returns 'pass' for score >= 0.9", () => {
    expect(computeScoreBucket(0.9, false)).toBe("pass");
    expect(computeScoreBucket(1.0, false)).toBe("pass");
    expect(computeScoreBucket(0.95, false)).toBe("pass");
  });

  it("returns 'partial' for score in [0.5, 0.9)", () => {
    expect(computeScoreBucket(0.5, false)).toBe("partial");
    expect(computeScoreBucket(0.7, false)).toBe("partial");
    expect(computeScoreBucket(0.89, false)).toBe("partial");
  });

  it("returns 'fail' for score < 0.5", () => {
    expect(computeScoreBucket(0.0, false)).toBe("fail");
    expect(computeScoreBucket(0.3, false)).toBe("fail");
    expect(computeScoreBucket(0.49, false)).toBe("fail");
  });
});

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
// Explanation: raw text input rejection (explicit LLM/rationale channels)
// ---------------------------------------------------------------------------

describe("BoundedExplanation rejects raw text explanation inputs", () => {
  it("rejects a string that looks like a full rationale paragraph", () => {
    // Simulates what a scorer might produce as rationale text
    const rationaleText =
      "The model correctly routed the request to the shuttle agent. " +
      "rationale: it identified the backend keyword and selected shuttle-backend.";
    const result = BoundedExplanationSchema.safeParse({
      text: rationaleText,
      source: "operator_note",
    });
    expect(result.success).toBe(false);
  });

  it("rejects text sourced from a transcript excerpt", () => {
    const transcriptExcerpt =
      "The following was observed:\nUser: Route this to backend.\nAssistant: I'll route it.";
    const result = BoundedExplanationSchema.safeParse({
      text: transcriptExcerpt,
      source: "operator_note",
    });
    expect(result.success).toBe(false);
  });

  it("rejects text that is a chain-of-thought dump", () => {
    const cot =
      "<thinking>Step 1: analyse the request. Step 2: pick shuttle. Done.</thinking>";
    const result = BoundedExplanationSchema.safeParse({
      text: cot,
      source: "operator_note",
    });
    expect(result.success).toBe(false);
  });

  it("rejects text sourced from a prompt template (system tag)", () => {
    const promptText = "<system>You are Loom, the orchestrator.</system>";
    const result = BoundedExplanationSchema.safeParse({
      text: promptText,
      source: "operator_note",
    });
    expect(result.success).toBe(false);
  });

  it("rejects score assignment text that mimics LLM freeform output", () => {
    const freeform = "score: 1.0 — the model performed perfectly on this case.";
    const result = BoundedExplanationSchema.safeParse({
      text: freeform,
      source: "operator_note",
    });
    expect(result.success).toBe(false);
  });

  it("accepts short, human-written, clean operator note", () => {
    const note = "Verified manually by team lead.";
    const result = BoundedExplanationSchema.safeParse({
      text: note,
      source: "operator_note",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a score-bucket-derived label with no forbidden patterns", () => {
    const label = "Correctly routed to shuttle (pass bucket).";
    const result = BoundedExplanationSchema.safeParse({
      text: label,
      source: "score_bucket_label",
    });
    expect(result.success).toBe(true);
  });
});
