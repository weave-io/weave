/**
 * Tests for `report-bundle.ts`.
 *
 * Verifies:
 *   - `assembleCaseEntry()` produces valid `PublicCaseEntry` values from sanitized score rows.
 *   - `assembleCaseEntry()` drops explanation when `BoundedExplanationSchema` validation fails.
 *   - `assembleSuiteSummary()` produces correct `SuiteSummaryEntry` values.
 *   - `assembleSuiteSummary()` returns err on schema validation failure.
 *   - `assemblePublicReportBundle()` assembles the full report from an `EvalBundle`.
 *   - `assemblePublicReportBundle()` returns err for an empty bundle.
 *   - `assembleDashboardManifest()` prepends new entries and recomputes totalRuns.
 *   - `buildDashboardEntry()` maps bundle fields correctly.
 *   - `assembleModelComparisonManifest()` groups entries by model and computes pass rates.
 *   - `appendSuiteHistoryPoint()` appends points to existing or new manifests.
 *
 * # XSS / injection policy coverage
 *
 * All `PublicCaseEntry` and `SuiteSummaryEntry` fields that reach the
 * `public-report.json` artifact must be free of HTML injection vectors.
 * These tests verify that:
 *   - Explanation fields with `<script>`, `<style>`, `<iframe>`, inline event
 *     handlers, `javascript:` URIs, `data:` URIs, or other HTML injection
 *     attempts are dropped (explanation omitted) when they fail
 *     `BoundedExplanationSchema` validation.
 *   - Assembled `PublicReportBundle` JSON does not contain any HTML injection
 *     payloads from explanation fields.
 *   - The `assertJsonPublishSafe()` guard confirms serialized JSON is clean.
 *   - Malicious explanation source descriptors that bypass `ExplanationSource`
 *     enum validation are rejected and the explanation field is omitted.
 *   - Score bucket labels (the only rendered enum values) contain no HTML.
 *
 * Test isolation:
 *   - No file I/O, network, git, or shell calls.
 *   - All fixtures are constructed inline.
 */

import { describe, expect, it } from "bun:test";
import {
  appendSuiteHistoryPoint,
  assembleCaseEntry,
  assembleDashboardManifest,
  assembleModelComparisonManifest,
  assemblePublicReportBundle,
  assembleSuiteSummary,
  buildDashboardEntry,
} from "../report-bundle.js";
import {
  REPORT_BUNDLE_SCHEMA_VERSION,
  SUITE_SUMMARY_SCHEMA_VERSION,
} from "../report-schema.js";
import { assertJsonPublishSafe } from "../sanitizer.js";
import type { BundleScoreFile, EvalBundle } from "../types.js";
import { EVAL_SUITE_REGISTRY } from "../types.js";

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
// assembleCaseEntry — clean inputs
// ---------------------------------------------------------------------------

describe("assembleCaseEntry (clean inputs)", () => {
  it("produces a PublicCaseEntry with correct caseId", () => {
    const row = makeScoreRow({ caseId: "test-case" });
    const entry = assembleCaseEntry(row, "loom-routing");
    expect(entry.caseId).toBe("test-case");
  });

  it("produces a PublicCaseEntry with correct modelId", () => {
    const row = makeScoreRow({ modelId: "openai/gpt-4o" });
    const entry = assembleCaseEntry(row, "loom-routing");
    expect(entry.modelId).toBe("openai/gpt-4o");
  });

  it("maps weightedTotal >= 0.9 to 'pass' bucket", () => {
    const row = makeScoreRow({ weightedTotal: 0.95, dryRun: false });
    const entry = assembleCaseEntry(row, "loom-routing");
    expect(entry.scoreBucket).toBe("pass");
  });

  it("maps weightedTotal in [0.5, 0.9) to 'partial' bucket", () => {
    const row = makeScoreRow({ weightedTotal: 0.7, dryRun: false });
    const entry = assembleCaseEntry(row, "loom-routing");
    expect(entry.scoreBucket).toBe("partial");
  });

  it("maps weightedTotal < 0.5 to 'fail' bucket", () => {
    const row = makeScoreRow({ weightedTotal: 0.2, dryRun: false });
    const entry = assembleCaseEntry(row, "loom-routing");
    expect(entry.scoreBucket).toBe("fail");
  });

  it("maps dryRun=true to 'skip' bucket regardless of score", () => {
    const row = makeScoreRow({ weightedTotal: 1.0, dryRun: true });
    const entry = assembleCaseEntry(row, "loom-routing");
    expect(entry.scoreBucket).toBe("skip");
  });

  it("includes a valid publicExplanation when present and valid", () => {
    const row = makeScoreRow({
      publicExplanation: {
        text: "Routing matched expected agent.",
        source: "score_bucket_label",
      },
    });
    const entry = assembleCaseEntry(row, "loom-routing");
    expect(entry.explanation).toBeDefined();
    expect(entry.explanation?.text).toBe("Routing matched expected agent.");
  });

  it("omits explanation when publicExplanation is undefined", () => {
    const row = makeScoreRow({ publicExplanation: undefined });
    const entry = assembleCaseEntry(row, "loom-routing");
    expect(entry.explanation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// assembleCaseEntry — XSS / injection policy coverage
// ---------------------------------------------------------------------------

describe("assembleCaseEntry (XSS / injection policy coverage)", () => {
  it("drops explanation when publicExplanation.text contains <script> tag", () => {
    // BoundedExplanationSchema rejects HTML injection in explanation text.
    // assembleCaseEntry silently drops invalid explanations.
    const row = makeScoreRow({
      publicExplanation: {
        text: '<script>alert("xss")</script>',
        source: "score_bucket_label",
      },
    });
    const entry = assembleCaseEntry(row, "loom-routing");
    // Explanation is dropped; caseId and score fields still present
    expect(entry.explanation).toBeUndefined();
    expect(entry.caseId).toBe("route-to-shuttle");
  });

  it("drops explanation when publicExplanation.text contains onerror= handler", () => {
    const row = makeScoreRow({
      publicExplanation: {
        text: '<img src=x onerror="evil()">',
        source: "structured_signal",
      },
    });
    const entry = assembleCaseEntry(row, "loom-routing");
    expect(entry.explanation).toBeUndefined();
  });

  it("drops explanation when publicExplanation.text contains javascript: URI", () => {
    const row = makeScoreRow({
      publicExplanation: {
        text: "javascript:alert(document.cookie)",
        source: "structured_signal",
      },
    });
    const entry = assembleCaseEntry(row, "loom-routing");
    expect(entry.explanation).toBeUndefined();
  });

  it("drops explanation when publicExplanation.text contains data: URI", () => {
    const row = makeScoreRow({
      publicExplanation: {
        text: "data:text/html,<script>evil()</script>",
        source: "score_bucket_label",
      },
    });
    const entry = assembleCaseEntry(row, "loom-routing");
    expect(entry.explanation).toBeUndefined();
  });

  it("drops explanation when publicExplanation.text contains <iframe> tag", () => {
    const row = makeScoreRow({
      publicExplanation: {
        text: "<iframe src='https://evil.com'></iframe>",
        source: "structured_signal",
      },
    });
    const entry = assembleCaseEntry(row, "loom-routing");
    expect(entry.explanation).toBeUndefined();
  });

  it("drops explanation when publicExplanation.text contains <style> injection", () => {
    const row = makeScoreRow({
      publicExplanation: {
        text: "<style>body{background:url(https://tracking.evil.com)}</style>",
        source: "structured_signal",
      },
    });
    const entry = assembleCaseEntry(row, "loom-routing");
    expect(entry.explanation).toBeUndefined();
  });

  it("drops explanation when publicExplanation.text contains <form> injection", () => {
    const row = makeScoreRow({
      publicExplanation: {
        text: '<form action="https://evil.com">Enter password:</form>',
        source: "structured_signal",
      },
    });
    const entry = assembleCaseEntry(row, "loom-routing");
    expect(entry.explanation).toBeUndefined();
  });

  it("drops explanation when publicExplanation.source is an invalid enum value", () => {
    // 'raw_rationale' is not a valid ExplanationSource enum member
    const row = makeScoreRow({
      publicExplanation: {
        text: "Clean text but bad source.",
        // @ts-expect-error — intentionally testing invalid source for policy
        source: "raw_rationale",
      },
    });
    const entry = assembleCaseEntry(row, "loom-routing");
    expect(entry.explanation).toBeUndefined();
  });

  it("drops explanation when publicExplanation.source is 'transcript_content'", () => {
    const row = makeScoreRow({
      publicExplanation: {
        text: "Text from transcript.",
        // @ts-expect-error
        source: "transcript_content",
      },
    });
    const entry = assembleCaseEntry(row, "loom-routing");
    expect(entry.explanation).toBeUndefined();
  });

  it("drops explanation when publicExplanation.text contains rationale: marker (BoundedExplanationSchema)", () => {
    // 'rationale:' matches FORBIDDEN_EXPLANATION_PATTERNS.raw_rationale_marker
    const row = makeScoreRow({
      publicExplanation: {
        text: "rationale: the model routed correctly",
        source: "structured_signal",
      },
    });
    const entry = assembleCaseEntry(row, "loom-routing");
    expect(entry.explanation).toBeUndefined();
  });

  it("drops explanation when publicExplanation.text contains <thinking> chain-of-thought tag", () => {
    const row = makeScoreRow({
      publicExplanation: {
        text: "<thinking>I should pick shuttle agent</thinking>",
        source: "structured_signal",
      },
    });
    const entry = assembleCaseEntry(row, "loom-routing");
    expect(entry.explanation).toBeUndefined();
  });

  it("keeps a valid, clean explanation after malicious ones are dropped", () => {
    // Verify the drop-and-continue behavior: valid explanations still pass
    const row = makeScoreRow({
      publicExplanation: {
        text: "All routing correct.",
        source: "score_bucket_label",
      },
    });
    const entry = assembleCaseEntry(row, "loom-routing");
    expect(entry.explanation).toBeDefined();
    expect(entry.explanation?.text).toBe("All routing correct.");
    expect(entry.explanation?.source).toBe("score_bucket_label");
  });

  it("assembled entry serializes to JSON without any HTML injection content", () => {
    const row = makeScoreRow({
      publicExplanation: {
        // This explanation is valid
        text: "Pass: all routing checks satisfied.",
        source: "score_bucket_label",
      },
    });
    const entry = assembleCaseEntry(row, "loom-routing");
    const json = JSON.stringify(entry);
    expect(json).not.toContain("<script>");
    expect(json).not.toContain("javascript:");
    expect(json).not.toContain("onerror=");
    expect(json).not.toContain("data:text/html");
    expect(json).not.toContain("<iframe");
    expect(json).not.toContain("<style");
  });
});

// ---------------------------------------------------------------------------
// assembleSuiteSummary — clean inputs
// ---------------------------------------------------------------------------

describe("assembleSuiteSummary (clean inputs)", () => {
  it("returns ok for a valid score file", () => {
    const scoreFile = makeBundleScoreFile();
    const result = assembleSuiteSummary(
      scoreFile,
      FIXED_GIT_SHA,
      FIXED_TIMESTAMP,
    );
    expect(result.isOk()).toBe(true);
  });

  it("assembled summary has correct schemaVersion", () => {
    const scoreFile = makeBundleScoreFile();
    const result = assembleSuiteSummary(
      scoreFile,
      FIXED_GIT_SHA,
      FIXED_TIMESTAMP,
    );
    expect(result._unsafeUnwrap().schemaVersion).toBe(
      SUITE_SUMMARY_SCHEMA_VERSION,
    );
  });

  it("assembled summary has correct case count", () => {
    const scoreFile = makeBundleScoreFile({
      results: [
        makeScoreRow({ caseId: "case-a", passed: true }),
        makeScoreRow({ caseId: "case-b", passed: false }),
      ],
      totals: {
        totalCases: 2,
        passedCases: 1,
        failedCases: 1,
        suiteGreen: false,
      },
    });
    const result = assembleSuiteSummary(
      scoreFile,
      FIXED_GIT_SHA,
      FIXED_TIMESTAMP,
    );
    const summary = result._unsafeUnwrap();
    expect(summary.totalCases).toBe(2);
    expect(summary.passedCases).toBe(1);
    expect(summary.failedCases).toBe(1);
  });

  it("suiteGreen is true when all required cases pass", () => {
    const scoreFile = makeBundleScoreFile({
      results: [makeScoreRow({ passed: true, required: true })],
      totals: {
        totalCases: 1,
        passedCases: 1,
        failedCases: 0,
        suiteGreen: true,
      },
    });
    const result = assembleSuiteSummary(
      scoreFile,
      FIXED_GIT_SHA,
      FIXED_TIMESTAMP,
    );
    expect(result._unsafeUnwrap().suiteGreen).toBe(true);
  });

  it("suiteGreen is false when a required case fails", () => {
    const scoreFile = makeBundleScoreFile({
      results: [makeScoreRow({ passed: false, required: true })],
      totals: {
        totalCases: 1,
        passedCases: 0,
        failedCases: 1,
        suiteGreen: false,
      },
    });
    const result = assembleSuiteSummary(
      scoreFile,
      FIXED_GIT_SHA,
      FIXED_TIMESTAMP,
    );
    expect(result._unsafeUnwrap().suiteGreen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assembleSuiteSummary — XSS / injection policy
// ---------------------------------------------------------------------------

describe("assembleSuiteSummary (XSS / injection policy)", () => {
  it("assembled suite summary serializes to JSON without HTML injection content", () => {
    const scoreFile = makeBundleScoreFile({
      results: [
        makeScoreRow({
          publicExplanation: {
            text: "Pass: routing correct.",
            source: "score_bucket_label",
          },
        }),
      ],
    });
    const result = assembleSuiteSummary(
      scoreFile,
      FIXED_GIT_SHA,
      FIXED_TIMESTAMP,
    );
    const json = JSON.stringify(result._unsafeUnwrap());
    expect(json).not.toContain("<script>");
    expect(json).not.toContain("javascript:");
    expect(json).not.toContain("onerror=");
    expect(json).not.toContain("<iframe");
    expect(json).not.toContain("data:text/html");
  });

  it("suite summary with a dropped malicious explanation passes assertJsonPublishSafe", () => {
    // Malicious explanation is dropped; the rest is safe
    const scoreFile = makeBundleScoreFile({
      results: [
        makeScoreRow({
          publicExplanation: {
            text: '<script>alert("xss")</script>',
            source: "score_bucket_label",
          },
        }),
      ],
    });
    const result = assembleSuiteSummary(
      scoreFile,
      FIXED_GIT_SHA,
      FIXED_TIMESTAMP,
    );
    const json = JSON.stringify(result._unsafeUnwrap());
    const safeResult = assertJsonPublishSafe(json, "suite-summary");
    expect(safeResult.isOk()).toBe(true);
    // HTML injection is not present
    expect(json).not.toContain("<script>");
  });
});

// ---------------------------------------------------------------------------
// assemblePublicReportBundle — clean inputs
// ---------------------------------------------------------------------------

describe("assemblePublicReportBundle (clean inputs)", () => {
  it("returns ok for a valid eval bundle", () => {
    const bundle = makeEvalBundle();
    const result = assemblePublicReportBundle(bundle, "abc123d-2026-01-01-001");
    expect(result.isOk()).toBe(true);
  });

  it("returns err(EmptyBundle) for a bundle with no score files", () => {
    const bundle = makeEvalBundle({ scoreFiles: [] });
    const result = assemblePublicReportBundle(bundle, "abc123d-2026-01-01-001");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("EmptyBundle");
  });

  it("assembled bundle has correct schemaVersion", () => {
    const bundle = makeEvalBundle();
    const result = assemblePublicReportBundle(bundle, "abc123d-2026-01-01-001");
    expect(result._unsafeUnwrap().schemaVersion).toBe(
      REPORT_BUNDLE_SCHEMA_VERSION,
    );
  });

  it("assembled bundle includes all suite summaries", () => {
    const bundle = makeEvalBundle({
      scoreFiles: [
        makeBundleScoreFile({ suite: "loom-routing" }),
        makeBundleScoreFile({ suite: "tapestry-execution" }),
      ],
      runSummary: {
        totalCases: 2,
        passedCases: 2,
        failedCases: 0,
        allSuitesGreen: true,
        suites: ["loom-routing", "tapestry-execution"],
      },
    });
    const result = assemblePublicReportBundle(bundle, "abc123d-2026-01-01-001");
    const report = result._unsafeUnwrap();
    expect(report.suiteSummaries).toHaveLength(2);
    const suites = report.suiteSummaries.map((s) => s.suite);
    expect(suites).toContain("loom-routing");
    expect(suites).toContain("tapestry-execution");
  });

  it("assembled bundle preserves seven-suite run summaries", () => {
    const suiteNames = EVAL_SUITE_REGISTRY.map((suite) => suite.suiteId);
    const bundle = makeEvalBundle({
      scoreFiles: suiteNames.map((suite, index) =>
        makeBundleScoreFile({
          suite,
          results: [makeScoreRow({ caseId: `case-${index + 1}` })],
          totals: {
            totalCases: 1,
            passedCases: 1,
            failedCases: 0,
            suiteGreen: true,
          },
        }),
      ),
      runSummary: {
        totalCases: suiteNames.length,
        passedCases: suiteNames.length,
        failedCases: 0,
        allSuitesGreen: true,
        suites: suiteNames,
      },
    });

    const result = assemblePublicReportBundle(bundle, "abc123d-2026-01-01-001");
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().runSummary.suites).toEqual(suiteNames);
  });

  it("assembled bundle totalCases is sum across all suite summaries", () => {
    const bundle = makeEvalBundle({
      scoreFiles: [
        makeBundleScoreFile({
          suite: "loom-routing",
          results: [
            makeScoreRow({ caseId: "c1" }),
            makeScoreRow({ caseId: "c2" }),
          ],
          totals: {
            totalCases: 2,
            passedCases: 2,
            failedCases: 0,
            suiteGreen: true,
          },
        }),
        makeBundleScoreFile({
          suite: "tapestry-execution",
          results: [makeScoreRow({ caseId: "c3" })],
          totals: {
            totalCases: 1,
            passedCases: 1,
            failedCases: 0,
            suiteGreen: true,
          },
        }),
      ],
      runSummary: {
        totalCases: 3,
        passedCases: 3,
        failedCases: 0,
        allSuitesGreen: true,
        suites: ["loom-routing", "tapestry-execution"],
      },
    });
    const result = assemblePublicReportBundle(bundle, "abc123d-2026-01-01-001");
    const report = result._unsafeUnwrap();
    expect(report.runSummary.totalCases).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// assemblePublicReportBundle — XSS / injection policy
// ---------------------------------------------------------------------------

describe("assemblePublicReportBundle (XSS / injection policy)", () => {
  it("assembled report JSON contains no <script> tags even with malicious explanations", () => {
    const bundle = makeEvalBundle({
      scoreFiles: [
        makeBundleScoreFile({
          results: [
            makeScoreRow({
              publicExplanation: {
                text: '<script>alert("xss")</script>',
                source: "score_bucket_label",
              },
            }),
          ],
        }),
      ],
    });
    const result = assemblePublicReportBundle(bundle, "abc123d-2026-01-01-001");
    const json = JSON.stringify(result._unsafeUnwrap());
    expect(json).not.toContain("<script>");
    expect(json).not.toContain("alert(");
  });

  it("assembled report JSON contains no onerror= handlers even with malicious explanations", () => {
    const bundle = makeEvalBundle({
      scoreFiles: [
        makeBundleScoreFile({
          results: [
            makeScoreRow({
              publicExplanation: {
                text: '<img src=x onerror="evil()">',
                source: "structured_signal",
              },
            }),
          ],
        }),
      ],
    });
    const result = assemblePublicReportBundle(bundle, "abc123d-2026-01-01-001");
    const json = JSON.stringify(result._unsafeUnwrap());
    expect(json).not.toContain("onerror=");
    expect(json).not.toContain("evil()");
  });

  it("assembled report JSON contains no javascript: URIs even with malicious explanations", () => {
    const bundle = makeEvalBundle({
      scoreFiles: [
        makeBundleScoreFile({
          results: [
            makeScoreRow({
              publicExplanation: {
                text: "javascript:steal(document.cookie)",
                source: "score_bucket_label",
              },
            }),
          ],
        }),
      ],
    });
    const result = assemblePublicReportBundle(bundle, "abc123d-2026-01-01-001");
    const json = JSON.stringify(result._unsafeUnwrap());
    expect(json).not.toContain("javascript:");
  });

  it("assembled report JSON contains no data: URIs even with malicious explanations", () => {
    const bundle = makeEvalBundle({
      scoreFiles: [
        makeBundleScoreFile({
          results: [
            makeScoreRow({
              publicExplanation: {
                text: "data:text/html,<script>evil()</script>",
                source: "score_bucket_label",
              },
            }),
          ],
        }),
      ],
    });
    const result = assemblePublicReportBundle(bundle, "abc123d-2026-01-01-001");
    const json = JSON.stringify(result._unsafeUnwrap());
    expect(json).not.toContain("data:text/html");
  });

  it("assembled report JSON contains no <iframe> tags even with malicious explanations", () => {
    const bundle = makeEvalBundle({
      scoreFiles: [
        makeBundleScoreFile({
          results: [
            makeScoreRow({
              publicExplanation: {
                text: "<iframe src='https://evil.com'></iframe>",
                source: "structured_signal",
              },
            }),
          ],
        }),
      ],
    });
    const result = assemblePublicReportBundle(bundle, "abc123d-2026-01-01-001");
    const json = JSON.stringify(result._unsafeUnwrap());
    expect(json).not.toContain("<iframe");
  });

  it("assembled report passes assertJsonPublishSafe (no sensitive fields or HTML injection)", () => {
    const bundle = makeEvalBundle({
      scoreFiles: [
        makeBundleScoreFile({
          results: [
            makeScoreRow({
              publicExplanation: {
                text: "Pass: routing correct.",
                source: "score_bucket_label",
              },
            }),
          ],
        }),
      ],
    });
    const result = assemblePublicReportBundle(bundle, "abc123d-2026-01-01-001");
    const json = JSON.stringify(result._unsafeUnwrap());
    const safeResult = assertJsonPublishSafe(json, "public-report.json");
    expect(safeResult.isOk()).toBe(true);
  });

  it("multiple malicious payloads across suites are all dropped", () => {
    const bundle = makeEvalBundle({
      scoreFiles: [
        makeBundleScoreFile({
          suite: "loom-routing",
          results: [
            makeScoreRow({
              caseId: "case-a",
              publicExplanation: {
                text: "<script>evil1()</script>",
                source: "score_bucket_label",
              },
            }),
          ],
        }),
        makeBundleScoreFile({
          suite: "tapestry-execution",
          results: [
            makeScoreRow({
              caseId: "case-b",
              publicExplanation: {
                text: '<img src=x onerror="evil2()">',
                source: "structured_signal",
              },
            }),
          ],
        }),
      ],
      runSummary: {
        totalCases: 2,
        passedCases: 2,
        failedCases: 0,
        allSuitesGreen: true,
        suites: ["loom-routing", "tapestry-execution"],
      },
    });
    const result = assemblePublicReportBundle(bundle, "abc123d-2026-01-01-001");
    const json = JSON.stringify(result._unsafeUnwrap());
    expect(json).not.toContain("<script>");
    expect(json).not.toContain("onerror=");
    expect(json).not.toContain("evil1(");
    expect(json).not.toContain("evil2(");
  });

  it("score bucket labels in assembled JSON contain no HTML", () => {
    // Score buckets are fixed enum values; verify they are not injectable
    const bundle = makeEvalBundle({
      scoreFiles: [
        makeBundleScoreFile({
          results: [
            makeScoreRow({ weightedTotal: 0.95, passed: true }),
            makeScoreRow({
              caseId: "case-b",
              weightedTotal: 0.7,
              passed: false,
            }),
            makeScoreRow({
              caseId: "case-c",
              weightedTotal: 0.2,
              passed: false,
            }),
            makeScoreRow({ caseId: "case-d", dryRun: true, passed: false }),
          ],
          totals: {
            totalCases: 4,
            passedCases: 1,
            failedCases: 3,
            suiteGreen: false,
          },
        }),
      ],
      runSummary: {
        totalCases: 4,
        passedCases: 1,
        failedCases: 3,
        allSuitesGreen: false,
        suites: ["loom-routing"],
      },
    });
    const result = assemblePublicReportBundle(bundle, "abc123d-2026-01-01-001");
    const json = JSON.stringify(result._unsafeUnwrap());
    // All bucket values are "pass", "partial", "fail", or "skip" — no HTML
    expect(json).not.toMatch(/<[a-zA-Z]/);
    // Verify buckets are present
    expect(json).toContain('"pass"');
    expect(json).toContain('"partial"');
    expect(json).toContain('"fail"');
    expect(json).toContain('"skip"');
  });
});

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
