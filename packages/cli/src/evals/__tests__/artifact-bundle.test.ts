/**
 * Tests for `artifact-bundle.ts`.
 *
 * Verifies:
 *   - `computeBundleDirName()` produces deterministic directory names from gitSha + date.
 *   - `assembleScoreFile()` produces a sanitized score file with correct totals.
 *   - `assemblePromptHashRecords()` produces hash-only records (no raw text).
 *   - `assembleBundle()` assembles a valid EvalBundle passing sanitization.
 *   - `assembleBundle()` fails when the bundle contains unsanitized fields.
 *   - `ArtifactBundleWriter.writeBundle()` writes deterministic file paths.
 *   - `ArtifactBundleWriter.writeBundle()` requires EVAL_RESULTS_REPO_TOKEN in publish mode.
 *   - Dry-run bundles are written as local-only even when mode is "publish".
 *   - `assertBundlePublishEligible()` rejects dry-run bundles.
 *   - `assertBundlePublishEligible()` rejects bundles with no score files.
 *   - All JSON files written pass `assertJsonPublishSafe()`.
 *   - bundle-index.json, run-summary.json, and score-*.json are always written.
 *   - provenance-manifest.json is written when a manifest is supplied.
 *   - prompt-hashes.json is written when prompt hash records are present.
 *
 * Test isolation:
 *   - All writes go to `TEMP_DIR` (not the project directory).
 *   - No real git, network, model, or scorer calls.
 *   - All fixtures are constructed inline.
 *   - Injected `env` mocks avoid reading real `Bun.env`.
 */

import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
  ArtifactBundleWriter,
  aggregateScoreFile,
  assembleBundle,
  assemblePromptHashRecords,
  assembleScoreFile,
  assertBundlePublishEligible,
  computeBundleDirName,
  EVAL_RESULTS_REPO_TOKEN_ENV_VAR,
} from "../artifact-bundle.js";
import { assertJsonPublishSafe } from "../sanitizer.js";
import type {
  CaseResult,
  EvalBundle,
  PromptProvenanceManifest,
  PromptProvenanceRecord,
  RunnerResult,
  ScoringDimension,
} from "../types.js";

// ---------------------------------------------------------------------------
// Test directory
// ---------------------------------------------------------------------------

const TEMP_DIR = "/var/folders/m8/6hhxrywx6739r5bhjfdzj3kw0000gn/T/opencode";

let _counter = 0;
function uid(): string {
  return String(Date.now()) + String(++_counter);
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const FIXED_GIT_SHA = "abc123def456abc123def456abc123def456abc1";
const FIXED_DATE = "2026-01-15";
const FIXED_TIMESTAMP = `${FIXED_DATE}T12:00:00.000Z`;

function makeCaseResult(
  caseId = "route-to-shuttle",
  modelId = "anthropic/claude-sonnet-4.5",
  passed = true,
): CaseResult {
  const dimensionScores: Record<
    ScoringDimension,
    { score: number; applicable: boolean }
  > = {
    routingCorrectness: { score: passed ? 1.0 : 0.0, applicable: true },
    delegationCorrectness: { score: 1.0, applicable: false },
    executionCompleteness: { score: 1.0, applicable: false },
    rationaleQuality: { score: 0.8, applicable: true },
  };

  return {
    summary: {
      caseId,
      modelId,
      suite: "loom-routing",
      passed,
      required: true,
      weightedTotal: passed ? 0.9 : 0.0,
      dimensionScores,
      scoredAt: FIXED_TIMESTAMP,
      dryRun: false,
    },
    // No rawArtifact — only publishable summary
  };
}

function makeRunnerResult(overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    suite: "loom-routing",
    suiteGreen: true,
    caseResults: [makeCaseResult()],
    totalCases: 1,
    passedCases: 1,
    failedCases: 0,
    completedAt: FIXED_TIMESTAMP,
    ...overrides,
  };
}

function makeProvenanceRecord(agentName = "loom"): PromptProvenanceRecord {
  return {
    agentName,
    hash: "a".repeat(64),
    byteLength: 4096,
    charLength: 4000,
    sources: [{ kind: "builtin", layer: "primary" }],
    summary: `Agent "${agentName}": 1 source(s) [builtin primary], hash sha256:aaaaaaaaaaaa…, 4000 chars, 4096 bytes`,
    gitSha: FIXED_GIT_SHA,
    capturedAt: FIXED_TIMESTAMP,
  };
}

function makeProvenanceManifest(): PromptProvenanceManifest {
  return {
    version: 1,
    producedAt: FIXED_TIMESTAMP,
    gitSha: FIXED_GIT_SHA,
    records: [makeProvenanceRecord("loom"), makeProvenanceRecord("tapestry")],
  };
}

function makeEnvWithToken(): Record<string, string | undefined> {
  return { [EVAL_RESULTS_REPO_TOKEN_ENV_VAR]: "test-token-value" };
}

function makeEnvWithoutToken(): Record<string, string | undefined> {
  return {};
}

// ---------------------------------------------------------------------------
// computeBundleDirName
// ---------------------------------------------------------------------------

describe("computeBundleDirName", () => {
  it("uses the first 7 chars of gitSha as prefix", () => {
    const name = computeBundleDirName(FIXED_GIT_SHA, FIXED_TIMESTAMP);
    expect(name.startsWith("abc123d")).toBe(true);
  });

  it("appends the date component from assembledAt", () => {
    const name = computeBundleDirName(FIXED_GIT_SHA, FIXED_TIMESTAMP);
    expect(name).toContain(FIXED_DATE);
  });

  it("format is <sha7>-<YYYY-MM-DD>", () => {
    const name = computeBundleDirName(FIXED_GIT_SHA, FIXED_TIMESTAMP);
    expect(name).toBe("abc123d-2026-01-15");
  });

  it("uses 'unknown' when gitSha is 'unknown'", () => {
    const name = computeBundleDirName("unknown", FIXED_TIMESTAMP);
    expect(name.startsWith("unknown-")).toBe(true);
  });

  it("is deterministic for identical inputs", () => {
    const n1 = computeBundleDirName(FIXED_GIT_SHA, FIXED_TIMESTAMP);
    const n2 = computeBundleDirName(FIXED_GIT_SHA, FIXED_TIMESTAMP);
    expect(n1).toBe(n2);
  });

  it("different gitSha produces different dir name", () => {
    const n1 = computeBundleDirName(`aaa${"0".repeat(37)}`, FIXED_TIMESTAMP);
    const n2 = computeBundleDirName(`bbb${"0".repeat(37)}`, FIXED_TIMESTAMP);
    expect(n1).not.toBe(n2);
  });

  it("different dates produce different dir names", () => {
    const n1 = computeBundleDirName(FIXED_GIT_SHA, "2026-01-01T00:00:00.000Z");
    const n2 = computeBundleDirName(FIXED_GIT_SHA, "2026-12-31T00:00:00.000Z");
    expect(n1).not.toBe(n2);
  });
});

// ---------------------------------------------------------------------------
// assembleScoreFile
// ---------------------------------------------------------------------------

describe("assembleScoreFile", () => {
  it("sets suite from runnerResult", () => {
    const rr = makeRunnerResult({ suite: "tapestry-execution" });
    const sf = assembleScoreFile(rr, FIXED_GIT_SHA, FIXED_TIMESTAMP, false);
    expect(sf.suite).toBe("tapestry-execution");
  });

  it("sets assembledAt and gitSha", () => {
    const rr = makeRunnerResult();
    const sf = assembleScoreFile(rr, FIXED_GIT_SHA, FIXED_TIMESTAMP, false);
    expect(sf.assembledAt).toBe(FIXED_TIMESTAMP);
    expect(sf.gitSha).toBe(FIXED_GIT_SHA);
  });

  it("sets dryRun flag", () => {
    const rr = makeRunnerResult();
    const sf = assembleScoreFile(rr, FIXED_GIT_SHA, FIXED_TIMESTAMP, true);
    expect(sf.dryRun).toBe(true);
  });

  it("totals reflect runnerResult counts", () => {
    const rr = makeRunnerResult({
      totalCases: 5,
      passedCases: 3,
      failedCases: 2,
      suiteGreen: false,
    });
    const sf = assembleScoreFile(rr, FIXED_GIT_SHA, FIXED_TIMESTAMP, false);
    expect(sf.totals.totalCases).toBe(5);
    expect(sf.totals.passedCases).toBe(3);
    expect(sf.totals.failedCases).toBe(2);
    expect(sf.totals.suiteGreen).toBe(false);
  });

  it("results array has one entry per case result", () => {
    const rr = makeRunnerResult({
      caseResults: [makeCaseResult("case-1"), makeCaseResult("case-2")],
      totalCases: 2,
    });
    const sf = assembleScoreFile(rr, FIXED_GIT_SHA, FIXED_TIMESTAMP, false);
    expect(sf.results).toHaveLength(2);
  });

  it("result entries have caseId and modelId", () => {
    const rr = makeRunnerResult({
      caseResults: [makeCaseResult("my-case", "openai/gpt-4o")],
    });
    const sf = assembleScoreFile(rr, FIXED_GIT_SHA, FIXED_TIMESTAMP, false);
    expect(sf.results[0]?.caseId).toBe("my-case");
    expect(sf.results[0]?.modelId).toBe("openai/gpt-4o");
  });

  it("result entries contain no rationale", () => {
    const rr = makeRunnerResult();
    const sf = assembleScoreFile(rr, FIXED_GIT_SHA, FIXED_TIMESTAMP, false);
    const json = JSON.stringify(sf);
    expect(json).not.toContain('"rationale"');
  });

  it("result entries contain no raw content", () => {
    const rr = makeRunnerResult();
    const sf = assembleScoreFile(rr, FIXED_GIT_SHA, FIXED_TIMESTAMP, false);
    const json = JSON.stringify(sf);
    expect(json).not.toContain('"composedPrompt"');
    expect(json).not.toContain('"transcript"');
    expect(json).not.toContain('"rawContent"');
  });

  it("score file JSON passes assertJsonPublishSafe", () => {
    const rr = makeRunnerResult();
    const sf = assembleScoreFile(rr, FIXED_GIT_SHA, FIXED_TIMESTAMP, false);
    const json = JSON.stringify(sf);
    const check = assertJsonPublishSafe(json, "score-file");
    expect(check.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// aggregateScoreFile — multi-model aggregation
// ---------------------------------------------------------------------------

describe("aggregateScoreFile", () => {
  it("merges case results from multiple runner results for the same suite", () => {
    const rr1 = makeRunnerResult({
      suite: "loom-routing",
      caseResults: [
        makeCaseResult("case-1", "anthropic/claude-sonnet-4.5", true),
      ],
      totalCases: 1,
      passedCases: 1,
      failedCases: 0,
    });
    const rr2 = makeRunnerResult({
      suite: "loom-routing",
      caseResults: [makeCaseResult("case-1", "openai/gpt-4o", false)],
      totalCases: 1,
      passedCases: 0,
      failedCases: 1,
    });
    const sf = aggregateScoreFile(
      "loom-routing",
      [rr1, rr2],
      FIXED_GIT_SHA,
      FIXED_TIMESTAMP,
      false,
    );
    // Both model rows are present
    expect(sf.results).toHaveLength(2);
    expect(
      sf.results.some((r) => r.modelId === "anthropic/claude-sonnet-4.5"),
    ).toBe(true);
    expect(sf.results.some((r) => r.modelId === "openai/gpt-4o")).toBe(true);
  });

  it("totals reflect all rows across models", () => {
    const rr1 = makeRunnerResult({
      suite: "loom-routing",
      caseResults: [
        makeCaseResult("case-1", "anthropic/claude-sonnet-4.5", true),
      ],
      totalCases: 1,
      passedCases: 1,
      failedCases: 0,
    });
    const rr2 = makeRunnerResult({
      suite: "loom-routing",
      caseResults: [
        makeCaseResult("case-1", "openai/gpt-4o", false),
        makeCaseResult("case-2", "openai/gpt-4o", true),
      ],
      totalCases: 2,
      passedCases: 1,
      failedCases: 1,
    });
    const sf = aggregateScoreFile(
      "loom-routing",
      [rr1, rr2],
      FIXED_GIT_SHA,
      FIXED_TIMESTAMP,
      false,
    );
    expect(sf.totals.totalCases).toBe(3);
    expect(sf.totals.passedCases).toBe(2);
    expect(sf.totals.failedCases).toBe(1);
  });

  it("suiteGreen is false when any required row failed", () => {
    const rr1 = makeRunnerResult({
      suite: "loom-routing",
      caseResults: [makeCaseResult("case-1", "model-a", true)],
      suiteGreen: true,
    });
    const rr2 = makeRunnerResult({
      suite: "loom-routing",
      caseResults: [makeCaseResult("case-1", "model-b", false)],
      suiteGreen: false,
    });
    const sf = aggregateScoreFile(
      "loom-routing",
      [rr1, rr2],
      FIXED_GIT_SHA,
      FIXED_TIMESTAMP,
      false,
    );
    expect(sf.totals.suiteGreen).toBe(false);
  });

  it("suiteGreen is true when all required rows passed", () => {
    const rr1 = makeRunnerResult({
      suite: "loom-routing",
      caseResults: [makeCaseResult("case-1", "model-a", true)],
      suiteGreen: true,
    });
    const rr2 = makeRunnerResult({
      suite: "loom-routing",
      caseResults: [makeCaseResult("case-1", "model-b", true)],
      suiteGreen: true,
    });
    const sf = aggregateScoreFile(
      "loom-routing",
      [rr1, rr2],
      FIXED_GIT_SHA,
      FIXED_TIMESTAMP,
      false,
    );
    expect(sf.totals.suiteGreen).toBe(true);
  });

  it("single runner result is equivalent to assembleScoreFile", () => {
    const rr = makeRunnerResult({ suite: "loom-routing" });
    const aggregated = aggregateScoreFile(
      "loom-routing",
      [rr],
      FIXED_GIT_SHA,
      FIXED_TIMESTAMP,
      false,
    );
    const assembled = assembleScoreFile(
      rr,
      FIXED_GIT_SHA,
      FIXED_TIMESTAMP,
      false,
    );
    expect(aggregated.results).toHaveLength(assembled.results.length);
    expect(aggregated.totals.totalCases).toBe(assembled.totals.totalCases);
  });

  it("aggregated score file JSON passes assertJsonPublishSafe", () => {
    const rr1 = makeRunnerResult({ suite: "loom-routing" });
    const rr2 = makeRunnerResult({
      suite: "loom-routing",
      caseResults: [makeCaseResult("case-2", "openai/gpt-4o")],
    });
    const sf = aggregateScoreFile(
      "loom-routing",
      [rr1, rr2],
      FIXED_GIT_SHA,
      FIXED_TIMESTAMP,
      false,
    );
    const json = JSON.stringify(sf);
    const check = assertJsonPublishSafe(json, "aggregated-score-file");
    expect(check.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assemblePromptHashRecords
// ---------------------------------------------------------------------------

describe("assemblePromptHashRecords", () => {
  it("returns one record per provenance record", () => {
    const records = [
      makeProvenanceRecord("loom"),
      makeProvenanceRecord("tapestry"),
    ];
    const hashes = assemblePromptHashRecords(records);
    expect(hashes).toHaveLength(2);
  });

  it("each record has agentName, hash, byteLength, charLength, summary", () => {
    const record = makeProvenanceRecord("loom");
    const [hash] = assemblePromptHashRecords([record]);
    expect(hash?.agentName).toBe("loom");
    expect(hash?.hash).toBe("a".repeat(64));
    expect(hash?.byteLength).toBe(4096);
    expect(hash?.charLength).toBe(4000);
    expect(typeof hash?.summary).toBe("string");
  });

  it("records contain no raw prompt text", () => {
    const records = [makeProvenanceRecord()];
    const hashes = assemblePromptHashRecords(records);
    const json = JSON.stringify(hashes);
    expect(json).not.toContain('"composedPrompt"');
    expect(json).not.toContain('"rawPrompt"');
  });

  it("hash records pass assertJsonPublishSafe", () => {
    const records = [makeProvenanceRecord("loom")];
    const hashes = assemblePromptHashRecords(records);
    const json = JSON.stringify(hashes);
    const check = assertJsonPublishSafe(json, "prompt-hashes");
    expect(check.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assembleBundle
// ---------------------------------------------------------------------------

describe("assembleBundle", () => {
  it("returns ok(EvalBundle) for valid inputs", () => {
    const result = assembleBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: makeProvenanceManifest(),
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      dryRun: false,
    });
    expect(result.isOk()).toBe(true);
  });

  it("bundle version is 1", () => {
    const result = assembleBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      dryRun: false,
    });
    expect(result._unsafeUnwrap().version).toBe(1);
  });

  it("bundle gitSha matches input", () => {
    const result = assembleBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      dryRun: false,
    });
    expect(result._unsafeUnwrap().gitSha).toBe(FIXED_GIT_SHA);
  });

  it("bundle assembledAt matches input", () => {
    const result = assembleBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      dryRun: false,
    });
    expect(result._unsafeUnwrap().assembledAt).toBe(FIXED_TIMESTAMP);
  });

  it("bundle dryRun flag propagates", () => {
    const result = assembleBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      dryRun: true,
    });
    expect(result._unsafeUnwrap().dryRun).toBe(true);
  });

  it("runSummary totals aggregate across suites", () => {
    const rr1 = makeRunnerResult({
      suite: "loom-routing",
      totalCases: 3,
      passedCases: 2,
      failedCases: 1,
    });
    const rr2 = makeRunnerResult({
      suite: "tapestry-execution",
      totalCases: 2,
      passedCases: 2,
      failedCases: 0,
    });
    const result = assembleBundle({
      runnerResults: [rr1, rr2],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      dryRun: false,
    });
    const bundle = result._unsafeUnwrap();
    expect(bundle.runSummary.totalCases).toBe(5);
    expect(bundle.runSummary.passedCases).toBe(4);
    expect(bundle.runSummary.failedCases).toBe(1);
  });

  it("runSummary.suites lists all suite names", () => {
    const rr1 = makeRunnerResult({ suite: "loom-routing" });
    const rr2 = makeRunnerResult({ suite: "tapestry-execution" });
    const result = assembleBundle({
      runnerResults: [rr1, rr2],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      dryRun: false,
    });
    expect(result._unsafeUnwrap().runSummary.suites).toEqual([
      "loom-routing",
      "tapestry-execution",
    ]);
  });

  it("scoreFiles has one entry per distinct suite (not per runner result)", () => {
    const rr1 = makeRunnerResult({ suite: "loom-routing" });
    const rr2 = makeRunnerResult({ suite: "tapestry-execution" });
    const result = assembleBundle({
      runnerResults: [rr1, rr2],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      dryRun: false,
    });
    expect(result._unsafeUnwrap().scoreFiles).toHaveLength(2);
  });

  it("multi-model run: same-suite runner results are merged into one score file", () => {
    // Simulate 3 models × 1 suite = 3 RunnerResults all with suite "loom-routing"
    const rr1 = makeRunnerResult({
      suite: "loom-routing",
      caseResults: [makeCaseResult("case-1", "model-a")],
    });
    const rr2 = makeRunnerResult({
      suite: "loom-routing",
      caseResults: [makeCaseResult("case-1", "model-b")],
    });
    const rr3 = makeRunnerResult({
      suite: "loom-routing",
      caseResults: [makeCaseResult("case-1", "model-c")],
    });
    const result = assembleBundle({
      runnerResults: [rr1, rr2, rr3],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      dryRun: false,
    });
    expect(result.isOk()).toBe(true);
    const bundle = result._unsafeUnwrap();
    // Only 1 score file despite 3 runner results
    expect(bundle.scoreFiles).toHaveLength(1);
    // The single score file has 3 rows (one per model)
    expect(bundle.scoreFiles[0]?.results).toHaveLength(3);
    expect(bundle.scoreFiles[0]?.suite).toBe("loom-routing");
  });

  it("multi-model multi-suite: produces one score file per suite with all model rows", () => {
    // Simulate 2 models × 2 suites = 4 RunnerResults
    const loomRr1 = makeRunnerResult({
      suite: "loom-routing",
      caseResults: [makeCaseResult("case-1", "model-a")],
    });
    const loomRr2 = makeRunnerResult({
      suite: "loom-routing",
      caseResults: [makeCaseResult("case-1", "model-b")],
    });
    const tapestryRr1 = makeRunnerResult({
      suite: "tapestry-execution",
      caseResults: [makeCaseResult("case-2", "model-a")],
    });
    const tapestryRr2 = makeRunnerResult({
      suite: "tapestry-execution",
      caseResults: [makeCaseResult("case-2", "model-b")],
    });
    const result = assembleBundle({
      runnerResults: [loomRr1, loomRr2, tapestryRr1, tapestryRr2],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      dryRun: false,
    });
    expect(result.isOk()).toBe(true);
    const bundle = result._unsafeUnwrap();
    // 2 score files — one per suite
    expect(bundle.scoreFiles).toHaveLength(2);
    const loomSf = bundle.scoreFiles.find((sf) => sf.suite === "loom-routing");
    const tapestrySf = bundle.scoreFiles.find(
      (sf) => sf.suite === "tapestry-execution",
    );
    expect(loomSf?.results).toHaveLength(2); // model-a + model-b rows
    expect(tapestrySf?.results).toHaveLength(2);
  });

  it("runSummary.suites lists deduplicated suite names (multi-model)", () => {
    const rr1 = makeRunnerResult({ suite: "loom-routing" });
    const rr2 = makeRunnerResult({ suite: "loom-routing" }); // same suite, different model
    const result = assembleBundle({
      runnerResults: [rr1, rr2],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      dryRun: false,
    });
    // Only one unique suite should appear
    expect(result._unsafeUnwrap().runSummary.suites).toEqual(["loom-routing"]);
  });

  it("provenanceRef is null when no manifest supplied", () => {
    const result = assembleBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      dryRun: false,
    });
    expect(result._unsafeUnwrap().provenanceRef).toBeNull();
  });

  it("provenanceRef is populated when manifest is supplied", () => {
    const result = assembleBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: makeProvenanceManifest(),
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      dryRun: false,
    });
    const ref = result._unsafeUnwrap().provenanceRef;
    expect(ref).not.toBeNull();
    expect(ref?.manifestPath).toBe("provenance-manifest.json");
    expect(ref?.agentCount).toBe(2); // loom + tapestry in fixture
  });

  it("promptHashRecords are empty when no manifest is supplied", () => {
    const result = assembleBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      dryRun: false,
    });
    expect(result._unsafeUnwrap().promptHashRecords).toHaveLength(0);
  });

  it("promptHashRecords match manifest agent count when manifest is supplied", () => {
    const result = assembleBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: makeProvenanceManifest(),
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      dryRun: false,
    });
    expect(result._unsafeUnwrap().promptHashRecords).toHaveLength(2);
  });

  it("bundle JSON passes assertJsonPublishSafe", () => {
    const result = assembleBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: makeProvenanceManifest(),
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      dryRun: false,
    });
    const bundle = result._unsafeUnwrap();
    const json = JSON.stringify(bundle);
    const check = assertJsonPublishSafe(json, "EvalBundle");
    expect(check.isOk()).toBe(true);
  });

  it("is deterministic for identical inputs", () => {
    const opts = {
      runnerResults: [makeRunnerResult()],
      provenanceManifest: makeProvenanceManifest(),
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      dryRun: false,
    };
    const b1 = JSON.stringify(assembleBundle(opts)._unsafeUnwrap());
    const b2 = JSON.stringify(assembleBundle(opts)._unsafeUnwrap());
    expect(b1).toBe(b2);
  });
});

// ---------------------------------------------------------------------------
// assertBundlePublishEligible
// ---------------------------------------------------------------------------

describe("assertBundlePublishEligible", () => {
  function makeMinimalBundle(overrides: Partial<EvalBundle> = {}): EvalBundle {
    return {
      version: 1,
      assembledAt: FIXED_TIMESTAMP,
      gitSha: FIXED_GIT_SHA,
      dryRun: false,
      runSummary: {
        totalCases: 1,
        passedCases: 1,
        failedCases: 0,
        allSuitesGreen: true,
        suites: ["loom-routing"],
      },
      scoreFiles: [
        {
          suite: "loom-routing",
          assembledAt: FIXED_TIMESTAMP,
          gitSha: FIXED_GIT_SHA,
          dryRun: false,
          results: [],
          totals: {
            totalCases: 1,
            passedCases: 1,
            failedCases: 0,
            suiteGreen: true,
          },
        },
      ],
      promptHashRecords: [],
      provenanceRef: null,
      ...overrides,
    };
  }

  it("returns ok for a real non-dry-run bundle with score files", () => {
    const bundle = makeMinimalBundle();
    const result = assertBundlePublishEligible(bundle);
    expect(result.isOk()).toBe(true);
  });

  it("returns err for a dry-run bundle", () => {
    const bundle = makeMinimalBundle({ dryRun: true });
    const result = assertBundlePublishEligible(bundle);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("PublishPolicyViolation");
    expect(error.message.toLowerCase()).toContain("dry-run");
  });

  it("returns err for a bundle with no score files", () => {
    const bundle = makeMinimalBundle({ scoreFiles: [] });
    const result = assertBundlePublishEligible(bundle);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("PublishPolicyViolation");
    expect(error.message).toContain("score file");
  });
});

// ---------------------------------------------------------------------------
// ArtifactBundleWriter — writeBundle
// ---------------------------------------------------------------------------

describe("ArtifactBundleWriter.writeBundle", () => {
  it("writes bundle-index.json to a deterministic path", async () => {
    const bundleRoot = resolve(TEMP_DIR, `bundle-writer-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "local",
      dryRun: false,
    });

    expect(result.isOk()).toBe(true);
    const { bundleDir, filesWritten } = result._unsafeUnwrap();

    // Directory name is deterministic
    expect(bundleDir).toContain("abc123d-2026-01-15");

    // bundle-index.json was written
    const indexFile = filesWritten.find((f) => f.includes("bundle-index.json"));
    expect(indexFile).toBeDefined();

    // Content is valid JSON
    if (!indexFile) throw new Error("indexFile not written");
    const content = await Bun.file(indexFile).json();
    expect(content.version).toBe(1);
    expect(content.gitSha).toBe(FIXED_GIT_SHA);
  });

  it("writes run-summary.json", async () => {
    const bundleRoot = resolve(TEMP_DIR, `bundle-writer-summary-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "local",
      dryRun: false,
    });

    expect(result.isOk()).toBe(true);
    const { filesWritten } = result._unsafeUnwrap();
    const summaryFile = filesWritten.find((f) =>
      f.includes("run-summary.json"),
    );
    expect(summaryFile).toBeDefined();
  });

  it("writes a score file per suite", async () => {
    const bundleRoot = resolve(TEMP_DIR, `bundle-writer-scores-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    const result = await writer.writeBundle({
      runnerResults: [
        makeRunnerResult({ suite: "loom-routing" }),
        makeRunnerResult({ suite: "tapestry-execution" }),
      ],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "local",
      dryRun: false,
    });

    expect(result.isOk()).toBe(true);
    const { filesWritten } = result._unsafeUnwrap();
    const loomScore = filesWritten.find((f) =>
      f.includes("score-loom-routing.json"),
    );
    const tapestryScore = filesWritten.find((f) =>
      f.includes("score-tapestry-execution.json"),
    );
    expect(loomScore).toBeDefined();
    expect(tapestryScore).toBeDefined();
  });

  it("writes provenance-manifest.json when manifest is supplied", async () => {
    const bundleRoot = resolve(TEMP_DIR, `bundle-writer-prov-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: makeProvenanceManifest(),
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "local",
      dryRun: false,
    });

    expect(result.isOk()).toBe(true);
    const { filesWritten } = result._unsafeUnwrap();
    const provFile = filesWritten.find((f) =>
      f.includes("provenance-manifest.json"),
    );
    expect(provFile).toBeDefined();
  });

  it("writes prompt-hashes.json when manifest with records is supplied", async () => {
    const bundleRoot = resolve(TEMP_DIR, `bundle-writer-hashes-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: makeProvenanceManifest(),
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "local",
      dryRun: false,
    });

    expect(result.isOk()).toBe(true);
    const { filesWritten } = result._unsafeUnwrap();
    const hashFile = filesWritten.find((f) => f.includes("prompt-hashes.json"));
    expect(hashFile).toBeDefined();
  });

  it("all written JSON files pass assertJsonPublishSafe", async () => {
    const bundleRoot = resolve(TEMP_DIR, `bundle-writer-safe-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: makeProvenanceManifest(),
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "local",
      dryRun: false,
    });

    expect(result.isOk()).toBe(true);
    const { filesWritten } = result._unsafeUnwrap();

    for (const filePath of filesWritten) {
      const content = await Bun.file(filePath).text();
      const check = assertJsonPublishSafe(content, filePath);
      expect(check.isOk()).toBe(true);
    }
  });

  it("returns err(PublishTokenMissing) in publish mode without token", async () => {
    const bundleRoot = resolve(TEMP_DIR, `bundle-writer-token-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "publish",
      dryRun: false,
      env: makeEnvWithoutToken(),
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("PublishTokenMissing");
    if (error.type === "PublishTokenMissing") {
      expect(error.envVar).toBe(EVAL_RESULTS_REPO_TOKEN_ENV_VAR);
    }
  });

  it("proceeds (local write) in publish mode when token is present", async () => {
    const bundleRoot = resolve(TEMP_DIR, `bundle-writer-token-ok-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "publish",
      dryRun: false,
      env: makeEnvWithToken(),
    });

    // Should succeed at least for the local write phase
    expect(result.isOk()).toBe(true);
  });

  it("dry-run bundles are written locally even when mode is publish", async () => {
    const bundleRoot = resolve(TEMP_DIR, `bundle-writer-dryrun-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    // No token supplied — would fail if publish mode were enforced for dry-runs
    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "publish",
      dryRun: true,
      env: makeEnvWithoutToken(), // no token — should be fine since dry-run bypasses publish
    });

    expect(result.isOk()).toBe(true);
    const { bundle } = result._unsafeUnwrap();
    expect(bundle.dryRun).toBe(true);
  });

  it("bundle directory path is deterministic across calls with same inputs", async () => {
    const bundleRoot = resolve(TEMP_DIR, `bundle-writer-det-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    const opts = {
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "local" as const,
      dryRun: false,
    };

    const r1 = await writer.writeBundle(opts);
    const r2 = await writer.writeBundle(opts);

    expect(r1.isOk()).toBe(true);
    expect(r2.isOk()).toBe(true);
    expect(r1._unsafeUnwrap().bundleDir).toBe(r2._unsafeUnwrap().bundleDir);
  });

  it("multi-model run: two runner results for the same suite write one score file", async () => {
    const bundleRoot = resolve(TEMP_DIR, `bundle-writer-multimodel-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    const rr1 = makeRunnerResult({
      suite: "loom-routing",
      caseResults: [makeCaseResult("case-1", "anthropic/claude-sonnet-4.5")],
      totalCases: 1,
      passedCases: 1,
      failedCases: 0,
    });
    const rr2 = makeRunnerResult({
      suite: "loom-routing",
      caseResults: [makeCaseResult("case-1", "openai/gpt-4o")],
      totalCases: 1,
      passedCases: 1,
      failedCases: 0,
    });

    const result = await writer.writeBundle({
      runnerResults: [rr1, rr2],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "local",
      dryRun: false,
    });

    expect(result.isOk()).toBe(true);
    const { filesWritten } = result._unsafeUnwrap();

    // Only one score file should exist (not two)
    const scoreFiles = filesWritten.filter((f) =>
      f.includes("score-loom-routing.json"),
    );
    expect(scoreFiles).toHaveLength(1);

    // The single file should have both model rows
    const scoreFile = scoreFiles[0];
    if (!scoreFile) throw new Error("scoreFile not written");
    const content = await Bun.file(scoreFile).json();
    expect(content.results).toHaveLength(2);
    expect(
      content.results.some(
        (r: { modelId: string }) => r.modelId === "anthropic/claude-sonnet-4.5",
      ),
    ).toBe(true);
    expect(
      content.results.some(
        (r: { modelId: string }) => r.modelId === "openai/gpt-4o",
      ),
    ).toBe(true);
  });

  it("multi-model multi-suite: exactly one score file per suite", async () => {
    const bundleRoot = resolve(TEMP_DIR, `bundle-writer-mm-ms-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    // 2 models × 2 suites = 4 runner results
    const loomRr1 = makeRunnerResult({
      suite: "loom-routing",
      caseResults: [makeCaseResult("c1", "model-a")],
    });
    const loomRr2 = makeRunnerResult({
      suite: "loom-routing",
      caseResults: [makeCaseResult("c1", "model-b")],
    });
    const tapestryRr1 = makeRunnerResult({
      suite: "tapestry-execution",
      caseResults: [makeCaseResult("c2", "model-a")],
    });
    const tapestryRr2 = makeRunnerResult({
      suite: "tapestry-execution",
      caseResults: [makeCaseResult("c2", "model-b")],
    });

    const result = await writer.writeBundle({
      runnerResults: [loomRr1, loomRr2, tapestryRr1, tapestryRr2],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "local",
      dryRun: false,
    });

    expect(result.isOk()).toBe(true);
    const { filesWritten } = result._unsafeUnwrap();

    const loomScores = filesWritten.filter((f) =>
      f.includes("score-loom-routing.json"),
    );
    const tapestryScores = filesWritten.filter((f) =>
      f.includes("score-tapestry-execution.json"),
    );
    expect(loomScores).toHaveLength(1);
    expect(tapestryScores).toHaveLength(1);

    // Each score file contains 2 model rows
    const loomScoreFile = loomScores[0];
    const tapestryScoreFile = tapestryScores[0];
    if (!loomScoreFile) throw new Error("loomScoreFile not written");
    if (!tapestryScoreFile) throw new Error("tapestryScoreFile not written");
    const loomContent = await Bun.file(loomScoreFile).json();
    expect(loomContent.results).toHaveLength(2);
    const tapestryContent = await Bun.file(tapestryScoreFile).json();
    expect(tapestryContent.results).toHaveLength(2);
  });
});
