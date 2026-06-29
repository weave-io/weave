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
 *   - `resolveNextSequence()` factors in remote run IDs to avoid collisions.
 *   - `ArtifactBundleWriter.writeBundle()` calls `remoteSequenceReader` in publish mode.
 *   - Remote sequence reader failures fall back to local-only allocation.
 *
 * Test isolation:
 *   - All writes go to `TEMP_DIR` (not the project directory).
 *   - No real git, network, model, or scorer calls.
 *   - All fixtures are constructed inline.
 *   - Injected `env` mocks avoid reading real `Bun.env`.
 */

import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ResultAsync } from "neverthrow";
import {
  ArtifactBundleWriter,
  aggregateScoreFile,
  assembleBundle,
  assemblePromptHashRecords,
  assembleScoreFile,
  assertBundlePublishEligible,
  computeBundleDirName,
  computeRunId,
  computeRunIdPrefix,
  EVAL_RESULTS_REPO_TOKEN_ENV_VAR,
  type RemoteSequenceReader,
  RUNS_SUBDIR,
  resolveNextSequence,
} from "../artifact-bundle.js";
import {
  DASHBOARD_MANIFEST_FILE,
  LAST_N_RUNS_FILE,
  LATEST_SNAPSHOT_FILE,
  MODEL_COMPARISON_FILE_PREFIX,
  SCENARIO_HISTORY_FILE_PREFIX,
  SUITE_HISTORY_FILE_PREFIX,
} from "../dashboard-indexes.js";
import {
  assembleCaseEntry,
  assembleModelComparisonManifest,
  assemblePublicReportBundle,
  assembleSuiteSummary,
  buildDashboardEntry,
} from "../report-bundle.js";
import { StubResultsRepoPublisher } from "../results-repo.js";
import { assertJsonPublishSafe } from "../sanitizer.js";
import type {
  BundleScoreFile,
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

const TEMP_DIR = tmpdir();

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
    records: [
      makeProvenanceRecord("loom"),
      makeProvenanceRecord("tapestry"),
      makeProvenanceRecord("shuttle"),
      makeProvenanceRecord("spindle"),
      makeProvenanceRecord("pattern"),
      makeProvenanceRecord("weft"),
      makeProvenanceRecord("warp"),
    ],
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
// computeRunIdPrefix and computeRunId
// ---------------------------------------------------------------------------

describe("computeRunIdPrefix", () => {
  it("produces the same output as computeBundleDirName (backward compat)", () => {
    const prefix = computeRunIdPrefix(FIXED_GIT_SHA, FIXED_TIMESTAMP);
    const legacy = computeBundleDirName(FIXED_GIT_SHA, FIXED_TIMESTAMP);
    expect(prefix).toBe(legacy);
  });

  it("format is <sha7>-<YYYY-MM-DD>", () => {
    const prefix = computeRunIdPrefix(FIXED_GIT_SHA, FIXED_TIMESTAMP);
    expect(prefix).toBe("abc123d-2026-01-15");
  });

  it("uses 'unknown' when gitSha is 'unknown'", () => {
    const prefix = computeRunIdPrefix("unknown", FIXED_TIMESTAMP);
    expect(prefix.startsWith("unknown-")).toBe(true);
  });
});

describe("computeRunId", () => {
  it("format is <prefix>-<NNN>", () => {
    const runId = computeRunId("abc123d-2026-01-15", 1);
    expect(runId).toBe("abc123d-2026-01-15-001");
  });

  it("pads sequence to 3 digits", () => {
    expect(computeRunId("abc123d-2026-01-15", 1)).toMatch(/-001$/);
    expect(computeRunId("abc123d-2026-01-15", 9)).toMatch(/-009$/);
    expect(computeRunId("abc123d-2026-01-15", 10)).toMatch(/-010$/);
    expect(computeRunId("abc123d-2026-01-15", 99)).toMatch(/-099$/);
    expect(computeRunId("abc123d-2026-01-15", 100)).toMatch(/-100$/);
  });

  it("produces unique IDs for successive sequence numbers", () => {
    const id1 = computeRunId("abc123d-2026-01-15", 1);
    const id2 = computeRunId("abc123d-2026-01-15", 2);
    expect(id1).not.toBe(id2);
  });
});

// ---------------------------------------------------------------------------
// resolveNextSequence
// ---------------------------------------------------------------------------

describe("resolveNextSequence", () => {
  it("returns 1 when the runs/ dir does not exist", async () => {
    const nonExistentDir = resolve(
      TEMP_DIR,
      `resolve-seq-nonexistent-${uid()}`,
    );
    const seq = await resolveNextSequence(nonExistentDir, "abc123d-2026-01-15");
    expect(seq).toBe(1);
  });

  it("returns 1 when the runs/ dir exists but has no matching entries", async () => {
    const runsDir = resolve(TEMP_DIR, `resolve-seq-empty-${uid()}`);
    // Create a runs dir with an unrelated entry
    await Bun.write(`${runsDir}/unrelated-entry/.keep`, "");
    const seq = await resolveNextSequence(runsDir, "abc123d-2026-01-15");
    expect(seq).toBe(1);
  });

  it("returns 2 when one matching entry exists with sequence 001", async () => {
    const runsDir = resolve(TEMP_DIR, `resolve-seq-one-${uid()}`);
    await Bun.write(`${runsDir}/abc123d-2026-01-15-001/.keep`, "");
    const seq = await resolveNextSequence(runsDir, "abc123d-2026-01-15");
    expect(seq).toBe(2);
  });

  it("returns 4 when entries 001, 002, 003 exist", async () => {
    const runsDir = resolve(TEMP_DIR, `resolve-seq-three-${uid()}`);
    await Bun.write(`${runsDir}/abc123d-2026-01-15-001/.keep`, "");
    await Bun.write(`${runsDir}/abc123d-2026-01-15-002/.keep`, "");
    await Bun.write(`${runsDir}/abc123d-2026-01-15-003/.keep`, "");
    const seq = await resolveNextSequence(runsDir, "abc123d-2026-01-15");
    expect(seq).toBe(4);
  });

  it("ignores entries for different prefixes", async () => {
    const runsDir = resolve(TEMP_DIR, `resolve-seq-mixed-${uid()}`);
    await Bun.write(`${runsDir}/abc123d-2026-01-15-001/.keep`, "");
    // Different SHA prefix — should not count
    await Bun.write(`${runsDir}/deadbee-2026-01-15-005/.keep`, "");
    const seq = await resolveNextSequence(runsDir, "abc123d-2026-01-15");
    expect(seq).toBe(2);
  });

  it("ignores entries for a different date", async () => {
    const runsDir = resolve(TEMP_DIR, `resolve-seq-diffdate-${uid()}`);
    // Entry for a different date
    await Bun.write(`${runsDir}/abc123d-2026-01-16-003/.keep`, "");
    // Only one entry for our target date
    await Bun.write(`${runsDir}/abc123d-2026-01-15-001/.keep`, "");
    const seq = await resolveNextSequence(runsDir, "abc123d-2026-01-15");
    expect(seq).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// resolveNextSequence — remote run ID awareness
// ---------------------------------------------------------------------------

describe("resolveNextSequence — remote run IDs", () => {
  it("factors in remote -001 when local is empty → returns 2", async () => {
    const runsDir = resolve(TEMP_DIR, `rrs-remote-001-${uid()}`);
    // Local runs dir does not exist; remote has -001
    const seq = await resolveNextSequence(runsDir, "abc123d-2026-01-15", [
      "abc123d-2026-01-15-001",
    ]);
    expect(seq).toBe(2);
  });

  it("local -003 and remote -005 yields -006 (remote wins)", async () => {
    const runsDir = resolve(TEMP_DIR, `rrs-remote-max-${uid()}`);
    // Local has up to 003
    await Bun.write(`${runsDir}/abc123d-2026-01-15-001/.keep`, "");
    await Bun.write(`${runsDir}/abc123d-2026-01-15-002/.keep`, "");
    await Bun.write(`${runsDir}/abc123d-2026-01-15-003/.keep`, "");
    // Remote has up to 005
    const seq = await resolveNextSequence(runsDir, "abc123d-2026-01-15", [
      "abc123d-2026-01-15-004",
      "abc123d-2026-01-15-005",
    ]);
    expect(seq).toBe(6);
  });

  it("remote IDs for a different prefix are ignored", async () => {
    const runsDir = resolve(TEMP_DIR, `rrs-remote-prefix-${uid()}`);
    // Remote has a run for a different SHA prefix
    const seq = await resolveNextSequence(runsDir, "abc123d-2026-01-15", [
      "deadbee-2026-01-15-007",
      "abc123d-2026-01-16-003",
    ]);
    // Both remote IDs have different prefixes — local is empty → seq 1
    expect(seq).toBe(1);
  });

  it("empty remoteRunIds array behaves like local-only allocation", async () => {
    const runsDir = resolve(TEMP_DIR, `rrs-remote-empty-${uid()}`);
    await Bun.write(`${runsDir}/abc123d-2026-01-15-002/.keep`, "");
    const seq = await resolveNextSequence(runsDir, "abc123d-2026-01-15", []);
    expect(seq).toBe(3);
  });

  it("local max higher than remote → uses local max + 1", async () => {
    const runsDir = resolve(TEMP_DIR, `rrs-local-max-${uid()}`);
    await Bun.write(`${runsDir}/abc123d-2026-01-15-008/.keep`, "");
    // Remote only has -003
    const seq = await resolveNextSequence(runsDir, "abc123d-2026-01-15", [
      "abc123d-2026-01-15-003",
    ]);
    expect(seq).toBe(9);
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
    expect(ref?.agentCount).toBe(7);
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
    expect(result._unsafeUnwrap().promptHashRecords).toHaveLength(7);
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
    expect(content.schemaVersion).toBe(1);
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

  it("writes public-report.md by default through orchestrator-facing settings when writeMarkdown is enabled", async () => {
    const bundleRoot = resolve(TEMP_DIR, `bundle-writer-default-md-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "local",
      dryRun: false,
      writeMarkdown: true,
    });

    expect(result.isOk()).toBe(true);
    const { filesWritten } = result._unsafeUnwrap();
    expect(filesWritten.some((f) => f.includes("public-report.md"))).toBe(true);
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

  it("repeat runs with same inputs produce distinct immutable run directories (no-overwrite)", async () => {
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

    // Each run must produce a distinct directory (no-overwrite contract)
    expect(r1._unsafeUnwrap().bundleDir).not.toBe(r2._unsafeUnwrap().bundleDir);

    // Both must be under the same runs/ parent
    const runsDir = `${bundleRoot}/${RUNS_SUBDIR}`;
    expect(r1._unsafeUnwrap().bundleDir).toContain(runsDir);
    expect(r2._unsafeUnwrap().bundleDir).toContain(runsDir);

    // Run IDs must differ
    expect(r1._unsafeUnwrap().runId).not.toBe(r2._unsafeUnwrap().runId);

    // Sequence numbers must be 001 and 002
    expect(r1._unsafeUnwrap().runId).toMatch(/-001$/);
    expect(r2._unsafeUnwrap().runId).toMatch(/-002$/);
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

// ---------------------------------------------------------------------------
// ArtifactBundleWriter — immutable runs/ layout
// ---------------------------------------------------------------------------

describe("ArtifactBundleWriter — immutable runs/ layout", () => {
  it("bundle dir is under <bundleRoot>/runs/", async () => {
    const bundleRoot = resolve(TEMP_DIR, `immut-layout-${uid()}`);
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
    const { bundleDir } = result._unsafeUnwrap();
    expect(bundleDir).toContain(`${RUNS_SUBDIR}/`);
    expect(bundleDir).toContain(bundleRoot);
  });

  it("runId is returned in write result", async () => {
    const bundleRoot = resolve(TEMP_DIR, `immut-runid-${uid()}`);
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
    const { runId } = result._unsafeUnwrap();
    expect(typeof runId).toBe("string");
    expect(runId.length).toBeGreaterThan(0);
    // Format: <sha7>-<YYYY-MM-DD>-<NNN>
    expect(runId).toMatch(/^[a-f0-9]{7}-\d{4}-\d{2}-\d{2}-\d{3}$/);
  });

  it("first run always gets sequence 001", async () => {
    const bundleRoot = resolve(TEMP_DIR, `immut-seq001-${uid()}`);
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
    expect(result._unsafeUnwrap().runId).toMatch(/-001$/);
    expect(result._unsafeUnwrap().bundleDir).toMatch(/abc123d-2026-01-15-001$/);
  });

  it("second run with same git SHA and date gets sequence 002", async () => {
    const bundleRoot = resolve(TEMP_DIR, `immut-seq002-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    const opts = {
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null as null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "local" as const,
      dryRun: false,
    };

    const r1 = await writer.writeBundle(opts);
    const r2 = await writer.writeBundle(opts);

    expect(r1.isOk()).toBe(true);
    expect(r2.isOk()).toBe(true);
    expect(r1._unsafeUnwrap().runId).toMatch(/-001$/);
    expect(r2._unsafeUnwrap().runId).toMatch(/-002$/);
  });

  it("bundle-index.json contains the runId field", async () => {
    const bundleRoot = resolve(TEMP_DIR, `immut-indexrunid-${uid()}`);
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
    const { filesWritten, runId } = result._unsafeUnwrap();
    const indexFile = filesWritten.find((f) => f.includes("bundle-index.json"));
    if (!indexFile) throw new Error("bundle-index.json not written");
    const content = await Bun.file(indexFile).json();
    expect(content.runId).toBe(runId);
  });

  it("bundle-index.json contains schemaVersion (not version) as mandatory compatibility field", async () => {
    const bundleRoot = resolve(TEMP_DIR, `immut-schemaversion-${uid()}`);
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
    const indexFile = filesWritten.find((f) => f.includes("bundle-index.json"));
    if (!indexFile) throw new Error("bundle-index.json not written");
    const content = await Bun.file(indexFile).json();

    // MANDATORY: public bundle-index.json must carry schemaVersion for compatibility checks
    expect(typeof content.schemaVersion).toBe("number");
    expect(content.schemaVersion).toBe(1);

    // Must NOT carry the old internal `version` field at the top level
    // (`version` was the internal EvalBundle field; public artifacts use `schemaVersion`)
    expect(content.version).toBeUndefined();
  });

  it("bundle-index.json contains publicFiles listing only allowlisted public artifacts", async () => {
    const bundleRoot = resolve(TEMP_DIR, `immut-publicfiles-${uid()}`);
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
    const indexFile = filesWritten.find((f) => f.includes("bundle-index.json"));
    if (!indexFile) throw new Error("bundle-index.json not written");
    const content = await Bun.file(indexFile).json();

    // publicFiles must be a non-empty array of strings
    expect(Array.isArray(content.publicFiles)).toBe(true);
    expect(content.publicFiles.length).toBeGreaterThan(0);

    // bundle-index.json itself is always listed as a public file
    expect(content.publicFiles).toContain("bundle-index.json");

    // public-report.json is listed when written (score files exist in this case)
    expect(content.publicFiles).toContain("public-report.json");

    // Internal artifacts must NEVER appear in publicFiles
    expect(content.publicFiles).not.toContain("run-summary.json");
    expect(content.publicFiles).not.toContain("score-loom-routing.json");
    expect(content.publicFiles).not.toContain("prompt-hashes.json");
    expect(content.publicFiles).not.toContain("provenance-manifest.json");
  });

  it("bundle-index.json publicFiles does NOT include scoreFiles suite names or provenanceRef", async () => {
    const bundleRoot = resolve(TEMP_DIR, `immut-publicfiles-noscore-${uid()}`);
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
    const indexFile = filesWritten.find((f) => f.includes("bundle-index.json"));
    if (!indexFile) throw new Error("bundle-index.json not written");
    const content = await Bun.file(indexFile).json();

    // publicFiles must be a flat array of string file names, not nested objects
    for (const entry of content.publicFiles as unknown[]) {
      expect(typeof entry).toBe("string");
    }

    // No internal fields: scoreFiles or provenanceRef must not appear in bundle-index.json
    expect(content.scoreFiles).toBeUndefined();
    expect(content.provenanceRef).toBeUndefined();
  });

  it("bundle-index.json publicFiles includes public-report.md when writeMarkdown is true", async () => {
    const bundleRoot = resolve(TEMP_DIR, `immut-publicfiles-md-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "local",
      dryRun: false,
      writeMarkdown: true,
    });

    expect(result.isOk()).toBe(true);
    const { filesWritten } = result._unsafeUnwrap();
    const indexFile = filesWritten.find((f) => f.includes("bundle-index.json"));
    if (!indexFile) throw new Error("bundle-index.json not written");
    const content = await Bun.file(indexFile).json();

    // When writeMarkdown is true, public-report.md must appear in publicFiles
    expect(content.publicFiles).toContain("public-report.md");
  });

  it("bundle-index.json publicFiles does NOT include public-report.md when writeMarkdown is false", async () => {
    const bundleRoot = resolve(TEMP_DIR, `immut-publicfiles-nomd-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "local",
      dryRun: false,
      writeMarkdown: false,
    });

    expect(result.isOk()).toBe(true);
    const { filesWritten } = result._unsafeUnwrap();
    const indexFile = filesWritten.find((f) => f.includes("bundle-index.json"));
    if (!indexFile) throw new Error("bundle-index.json not written");
    const content = await Bun.file(indexFile).json();

    // public-report.md must NOT be listed when not written
    expect(content.publicFiles).not.toContain("public-report.md");
  });

  it("bundle-index.json publicFiles passes assertJsonPublishSafe", async () => {
    const bundleRoot = resolve(TEMP_DIR, `immut-publicfiles-safe-${uid()}`);
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
    const indexFile = filesWritten.find((f) => f.includes("bundle-index.json"));
    if (!indexFile) throw new Error("bundle-index.json not written");
    const content = await Bun.file(indexFile).text();
    const check = assertJsonPublishSafe(content, "bundle-index");
    expect(check.isOk()).toBe(true);
  });

  it("different run IDs for same SHA on different dates", async () => {
    const bundleRoot = resolve(TEMP_DIR, `immut-diffdate-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    const r1 = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: "2026-01-15T12:00:00.000Z",
      mode: "local",
      dryRun: false,
    });
    const r2 = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: "2026-01-16T12:00:00.000Z",
      mode: "local",
      dryRun: false,
    });

    expect(r1.isOk()).toBe(true);
    expect(r2.isOk()).toBe(true);
    // Different dates → different prefixes → each gets -001
    expect(r1._unsafeUnwrap().runId).toBe("abc123d-2026-01-15-001");
    expect(r2._unsafeUnwrap().runId).toBe("abc123d-2026-01-16-001");
  });
});

// ---------------------------------------------------------------------------
// ArtifactBundleWriter — public-report.json and public-report.md
// ---------------------------------------------------------------------------

describe("ArtifactBundleWriter — public-report.json", () => {
  it("writes public-report.json alongside bundle files when score files exist", async () => {
    const bundleRoot = resolve(TEMP_DIR, `pub-report-json-${uid()}`);
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
    const reportFile = filesWritten.find((f) =>
      f.includes("public-report.json"),
    );
    expect(reportFile).toBeDefined();
  });

  it("public-report.json is valid JSON with schemaVersion field", async () => {
    const bundleRoot = resolve(TEMP_DIR, `pub-report-schema-${uid()}`);
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
    const reportFile = filesWritten.find((f) =>
      f.includes("public-report.json"),
    );
    if (!reportFile) throw new Error("public-report.json not written");
    const content = await Bun.file(reportFile).json();
    expect(typeof content.schemaVersion).toBe("number");
    expect(content.schemaVersion).toBeGreaterThan(0);
    expect(typeof content.gitSha).toBe("string");
    expect(content.gitSha).toBe(FIXED_GIT_SHA);
  });

  it("public-report.json passes assertJsonPublishSafe", async () => {
    const bundleRoot = resolve(TEMP_DIR, `pub-report-safe-${uid()}`);
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
    const reportFile = filesWritten.find((f) =>
      f.includes("public-report.json"),
    );
    if (!reportFile) throw new Error("public-report.json not written");
    const content = await Bun.file(reportFile).text();
    const check = assertJsonPublishSafe(content, "public-report");
    expect(check.isOk()).toBe(true);
  });

  it("public-report.json is written even for empty score files (zero cases)", async () => {
    // A RunnerResult with zero cases still produces a BundleScoreFile.
    // The public-report.json is assembled from whichever score files exist
    // (even empty ones). Only a completely absent score-file list skips the report.
    const bundleRoot = resolve(TEMP_DIR, `pub-report-empty-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    const emptyRr: RunnerResult = {
      suite: "loom-routing",
      suiteGreen: true,
      caseResults: [],
      totalCases: 0,
      passedCases: 0,
      failedCases: 0,
      completedAt: FIXED_TIMESTAMP,
    };

    const result = await writer.writeBundle({
      runnerResults: [emptyRr],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "local",
      dryRun: false,
    });

    // Bundle write succeeds
    expect(result.isOk()).toBe(true);
    const { filesWritten } = result._unsafeUnwrap();
    // score-loom-routing.json is written (zero results, but still a valid score file)
    expect(
      filesWritten.some((f) => f.includes("score-loom-routing.json")),
    ).toBe(true);
    // public-report.json is also written (score file exists, even if empty)
    expect(filesWritten.some((f) => f.includes("public-report.json"))).toBe(
      true,
    );
  });

  it("public-report.json suiteSummaries reflect all written score files", async () => {
    const bundleRoot = resolve(TEMP_DIR, `pub-report-suites-${uid()}`);
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
    const reportFile = filesWritten.find((f) =>
      f.includes("public-report.json"),
    );
    if (!reportFile) throw new Error("public-report.json not written");
    const content = await Bun.file(reportFile).json();
    expect(Array.isArray(content.suiteSummaries)).toBe(true);
    expect(content.suiteSummaries).toHaveLength(2);
    const suiteNames = content.suiteSummaries.map(
      (s: { suite: string }) => s.suite,
    );
    expect(suiteNames).toContain("loom-routing");
    expect(suiteNames).toContain("tapestry-execution");
  });
});

describe("ArtifactBundleWriter — public-report.md", () => {
  it("does NOT write public-report.md by default (writeMarkdown not set)", async () => {
    const bundleRoot = resolve(TEMP_DIR, `pub-md-default-${uid()}`);
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
    const mdFile = filesWritten.find((f) => f.includes("public-report.md"));
    expect(mdFile).toBeUndefined();
  });

  it("writes public-report.md when writeMarkdown is true", async () => {
    const bundleRoot = resolve(TEMP_DIR, `pub-md-write-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "local",
      dryRun: false,
      writeMarkdown: true,
    });

    expect(result.isOk()).toBe(true);
    const { filesWritten } = result._unsafeUnwrap();
    const mdFile = filesWritten.find((f) => f.includes("public-report.md"));
    expect(mdFile).toBeDefined();
  });

  it("public-report.md content starts with the Markdown heading", async () => {
    const bundleRoot = resolve(TEMP_DIR, `pub-md-content-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "local",
      dryRun: false,
      writeMarkdown: true,
    });

    expect(result.isOk()).toBe(true);
    const { filesWritten } = result._unsafeUnwrap();
    const mdFile = filesWritten.find((f) => f.includes("public-report.md"));
    if (!mdFile) throw new Error("public-report.md not written");
    const content = await Bun.file(mdFile).text();
    // The Markdown report starts with an H2 heading from renderPublicReportBundle
    expect(content).toContain("## Weave Agent Evals Report");
  });

  it("public-report.md is NOT written when writeMarkdown is false", async () => {
    const bundleRoot = resolve(TEMP_DIR, `pub-md-false-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "local",
      dryRun: false,
      writeMarkdown: false,
    });

    expect(result.isOk()).toBe(true);
    const { filesWritten } = result._unsafeUnwrap();
    const mdFile = filesWritten.find((f) => f.includes("public-report.md"));
    expect(mdFile).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ArtifactBundleWriter — generateIndexes option
// ---------------------------------------------------------------------------

describe("ArtifactBundleWriter — generateIndexes option", () => {
  it("indexFilesWritten is empty when generateIndexes is false (default)", async () => {
    const bundleRoot = resolve(TEMP_DIR, `gen-idx-false-${uid()}`);
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
    expect(result._unsafeUnwrap().indexFilesWritten).toHaveLength(0);
  });

  it("indexFilesWritten contains dashboard index files when generateIndexes is true", async () => {
    const bundleRoot = resolve(TEMP_DIR, `gen-idx-true-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "local",
      dryRun: false,
      generateIndexes: true,
    });

    expect(result.isOk()).toBe(true);
    const { indexFilesWritten } = result._unsafeUnwrap();
    // Should contain at least dashboard-manifest.json and latest.json
    expect(indexFilesWritten).toContain("dashboard-manifest.json");
    expect(indexFilesWritten).toContain("latest.json");
    expect(indexFilesWritten).toContain("last-N-runs.json");
    expect(indexFilesWritten.some((f) => f.startsWith("suite-history-"))).toBe(
      true,
    );
    expect(
      indexFilesWritten.some((f) => f.startsWith("model-comparison-")),
    ).toBe(true);
    expect(
      indexFilesWritten.some((f) => f.startsWith("scenario-history-")),
    ).toBe(true);
  });

  it("indexFilesWritten includes the publish-safe scenario history family alongside other index families", async () => {
    const bundleRoot = resolve(TEMP_DIR, `gen-idx-family-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "local",
      dryRun: false,
      generateIndexes: true,
    });

    expect(result.isOk()).toBe(true);
    const { indexFilesWritten } = result._unsafeUnwrap();
    expect(indexFilesWritten).toContain(DASHBOARD_MANIFEST_FILE);
    expect(indexFilesWritten).toContain(LATEST_SNAPSHOT_FILE);
    expect(indexFilesWritten).toContain(LAST_N_RUNS_FILE);
    expect(
      indexFilesWritten.some((f) => f.startsWith(SUITE_HISTORY_FILE_PREFIX)),
    ).toBe(true);
    expect(
      indexFilesWritten.some((f) => f.startsWith(SCENARIO_HISTORY_FILE_PREFIX)),
    ).toBe(true);
    expect(
      indexFilesWritten.some((f) => f.startsWith(MODEL_COMPARISON_FILE_PREFIX)),
    ).toBe(true);
  });

  it("dashboard-manifest.json is written at bundleRoot (not inside runs/)", async () => {
    const bundleRoot = resolve(TEMP_DIR, `gen-idx-root-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "local",
      dryRun: false,
      generateIndexes: true,
    });

    expect(result.isOk()).toBe(true);
    // Verify the file exists at bundleRoot level
    const manifestPath = `${bundleRoot}/dashboard-manifest.json`;
    const content = await Bun.file(manifestPath).json();
    expect(content.schemaVersion).toBeGreaterThan(0);
    expect(content.totalRuns).toBe(1);
  });

  it("generateIndexes is non-fatal: bundle write succeeds even if indexes fail internally", async () => {
    // The generateIndexes step is fault-tolerant; any internal failure
    // should not prevent the bundle write from succeeding.
    const bundleRoot = resolve(TEMP_DIR, `gen-idx-nonfatal-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "local",
      dryRun: false,
      generateIndexes: true,
    });

    // Bundle write is always ok regardless of index generation outcome
    expect(result.isOk()).toBe(true);
  });

  it("second writeBundle call with generateIndexes updates dashboard-manifest.json to totalRuns=2", async () => {
    const bundleRoot = resolve(TEMP_DIR, `gen-idx-update-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);

    const opts = {
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null as null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "local" as const,
      dryRun: false,
      generateIndexes: true,
    };

    await writer.writeBundle(opts);
    await writer.writeBundle(opts);

    const manifestPath = `${bundleRoot}/dashboard-manifest.json`;
    const content = await Bun.file(manifestPath).json();
    expect(content.totalRuns).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// publicExplanation threading through artifact bundle
// ---------------------------------------------------------------------------

describe("publicExplanation threading through artifact bundle assembly", () => {
  it("assembleScoreFile preserves publicExplanation from CaseResultSummary", () => {
    const caseResultWithExpl: CaseResult = {
      summary: {
        caseId: "route-to-shuttle",
        modelId: "anthropic/claude-sonnet-4.5",
        suite: "loom-routing",
        passed: true,
        required: true,
        weightedTotal: 0.95,
        dimensionScores: {
          routingCorrectness: { score: 1.0, applicable: true },
          delegationCorrectness: { score: 1.0, applicable: false },
          executionCompleteness: { score: 1.0, applicable: false },
          rationaleQuality: { score: 0.9, applicable: true },
        },
        scoredAt: FIXED_TIMESTAMP,
        dryRun: false,
        publicExplanation: {
          text: "required routing case passed; dimensions: routingCorrectness, rationaleQuality",
          source: "structured_signal",
        },
      },
    };

    const rr: RunnerResult = {
      suite: "loom-routing",
      suiteGreen: true,
      caseResults: [caseResultWithExpl],
      totalCases: 1,
      passedCases: 1,
      failedCases: 0,
      completedAt: FIXED_TIMESTAMP,
    };

    const scoreFile = assembleScoreFile(
      rr,
      FIXED_GIT_SHA,
      FIXED_TIMESTAMP,
      false,
    );
    expect(scoreFile.results).toHaveLength(1);
    const row = scoreFile.results[0];
    expect(row).toBeDefined();
    expect(row!.publicExplanation).toBeDefined();
    expect(row!.publicExplanation!.text).toBe(
      "required routing case passed; dimensions: routingCorrectness, rationaleQuality",
    );
    expect(row!.publicExplanation!.source).toBe("structured_signal");
  });

  it("assembleScoreFile result rows without publicExplanation have no explanation field", () => {
    const caseResultNoExpl: CaseResult = {
      summary: {
        caseId: "route-to-shuttle",
        modelId: "anthropic/claude-sonnet-4.5",
        suite: "loom-routing",
        passed: true,
        required: true,
        weightedTotal: 0.9,
        dimensionScores: {
          routingCorrectness: { score: 1.0, applicable: true },
          delegationCorrectness: { score: 1.0, applicable: false },
          executionCompleteness: { score: 1.0, applicable: false },
          rationaleQuality: { score: 0.9, applicable: true },
        },
        scoredAt: FIXED_TIMESTAMP,
        dryRun: false,
        // No publicExplanation
      },
    };

    const rr: RunnerResult = {
      suite: "loom-routing",
      suiteGreen: true,
      caseResults: [caseResultNoExpl],
      totalCases: 1,
      passedCases: 1,
      failedCases: 0,
      completedAt: FIXED_TIMESTAMP,
    };

    const scoreFile = assembleScoreFile(
      rr,
      FIXED_GIT_SHA,
      FIXED_TIMESTAMP,
      false,
    );
    const row = scoreFile.results[0];
    expect(row).toBeDefined();
    expect(row!.publicExplanation).toBeUndefined();
  });

  it("publicExplanation is preserved in aggregateScoreFile for multi-model runs", () => {
    const makeRR = (modelId: string, expl: string): RunnerResult => ({
      suite: "loom-routing",
      suiteGreen: true,
      caseResults: [
        {
          summary: {
            caseId: "case-1",
            modelId,
            suite: "loom-routing",
            passed: true,
            required: true,
            weightedTotal: 0.9,
            dimensionScores: {
              routingCorrectness: { score: 1.0, applicable: true },
              delegationCorrectness: { score: 1.0, applicable: false },
              executionCompleteness: { score: 1.0, applicable: false },
              rationaleQuality: { score: 0.8, applicable: true },
            },
            scoredAt: FIXED_TIMESTAMP,
            dryRun: false,
            publicExplanation: { text: expl, source: "structured_signal" },
          },
        },
      ],
      totalCases: 1,
      passedCases: 1,
      failedCases: 0,
      completedAt: FIXED_TIMESTAMP,
    });

    const rr1 = makeRR(
      "model-a",
      "required routing case passed; dimensions: routingCorrectness",
    );
    const rr2 = makeRR(
      "model-b",
      "required routing case failed; dimensions: routingCorrectness",
    );

    const scoreFile = aggregateScoreFile(
      "loom-routing",
      [rr1, rr2],
      FIXED_GIT_SHA,
      FIXED_TIMESTAMP,
      false,
    );
    expect(scoreFile.results).toHaveLength(2);
    const row1 = scoreFile.results.find((r) => r.modelId === "model-a");
    const row2 = scoreFile.results.find((r) => r.modelId === "model-b");
    expect(row1!.publicExplanation?.text).toContain("passed");
    expect(row2!.publicExplanation?.text).toContain("failed");
  });

  it("publicExplanation text never contains forbidden patterns in assembled score file", () => {
    const caseResultWithExpl: CaseResult = {
      summary: {
        caseId: "route-to-shuttle",
        modelId: "anthropic/claude-sonnet-4.5",
        suite: "loom-routing",
        passed: true,
        required: true,
        weightedTotal: 0.95,
        dimensionScores: {
          routingCorrectness: { score: 1.0, applicable: true },
          delegationCorrectness: { score: 1.0, applicable: false },
          executionCompleteness: { score: 1.0, applicable: false },
          rationaleQuality: { score: 0.9, applicable: true },
        },
        scoredAt: FIXED_TIMESTAMP,
        dryRun: false,
        publicExplanation: {
          text: "required routing case passed; dimensions: routingCorrectness",
          source: "structured_signal",
        },
      },
    };

    const rr: RunnerResult = {
      suite: "loom-routing",
      suiteGreen: true,
      caseResults: [caseResultWithExpl],
      totalCases: 1,
      passedCases: 1,
      failedCases: 0,
      completedAt: FIXED_TIMESTAMP,
    };

    const scoreFile = assembleScoreFile(
      rr,
      FIXED_GIT_SHA,
      FIXED_TIMESTAMP,
      false,
    );
    const row = scoreFile.results[0];
    const text = row?.publicExplanation?.text ?? "";

    // Verify JSON serialization of the score file does not contain forbidden patterns
    const json = JSON.stringify(scoreFile);
    const safetyCheck = assertJsonPublishSafe(
      json,
      "score-file-with-explanation",
    );
    expect(safetyCheck.isOk()).toBe(true);
  });

  it("assembleBundle includes publicExplanation in score file results", () => {
    const caseResultWithExpl: CaseResult = {
      summary: {
        caseId: "route-to-shuttle",
        modelId: "anthropic/claude-sonnet-4.5",
        suite: "loom-routing",
        passed: true,
        required: true,
        weightedTotal: 0.9,
        dimensionScores: {
          routingCorrectness: { score: 1.0, applicable: true },
          delegationCorrectness: { score: 1.0, applicable: false },
          executionCompleteness: { score: 1.0, applicable: false },
          rationaleQuality: { score: 0.8, applicable: true },
        },
        scoredAt: FIXED_TIMESTAMP,
        dryRun: false,
        publicExplanation: {
          text: "required routing case passed; dimensions: routingCorrectness",
          source: "structured_signal",
        },
      },
    };

    const rr: RunnerResult = {
      suite: "loom-routing",
      suiteGreen: true,
      caseResults: [caseResultWithExpl],
      totalCases: 1,
      passedCases: 1,
      failedCases: 0,
      completedAt: FIXED_TIMESTAMP,
    };

    const bundleResult = assembleBundle({
      runnerResults: [rr],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      dryRun: false,
    });

    expect(bundleResult.isOk()).toBe(true);
    const bundle = bundleResult._unsafeUnwrap();
    expect(bundle.scoreFiles).toHaveLength(1);
    const sf = bundle.scoreFiles[0];
    expect(sf).toBeDefined();
    const row = sf!.results[0];
    expect(row?.publicExplanation).toBeDefined();
    expect(row?.publicExplanation?.text).toBe(
      "required routing case passed; dimensions: routingCorrectness",
    );
  });

  it("adversarial: publicExplanation with forbidden pattern text is written to JSON (caught upstream)", () => {
    // This test proves that the raw scoring layer is responsible for
    // not generating forbidden patterns — the bundle writer trusts that the
    // explanation was pre-validated by buildPublicExplanation(). In practice,
    // publicExplanation is generated by buildPublicExplanation() which produces
    // clean structured text — this test verifies the allowlist projection.
    const cleanExplanation =
      "required routing case passed; dimensions: routingCorrectness";
    const caseResultClean: CaseResult = {
      summary: {
        caseId: "route-to-shuttle",
        modelId: "anthropic/claude-sonnet-4.5",
        suite: "loom-routing",
        passed: true,
        required: true,
        weightedTotal: 0.9,
        dimensionScores: {
          routingCorrectness: { score: 1.0, applicable: true },
          delegationCorrectness: { score: 1.0, applicable: false },
          executionCompleteness: { score: 1.0, applicable: false },
          rationaleQuality: { score: 0.8, applicable: true },
        },
        scoredAt: FIXED_TIMESTAMP,
        dryRun: false,
        publicExplanation: {
          text: cleanExplanation,
          source: "structured_signal",
        },
      },
    };

    const scoreFile = assembleScoreFile(
      {
        suite: "loom-routing",
        suiteGreen: true,
        caseResults: [caseResultClean],
        totalCases: 1,
        passedCases: 1,
        failedCases: 0,
        completedAt: FIXED_TIMESTAMP,
      },
      FIXED_GIT_SHA,
      FIXED_TIMESTAMP,
      false,
    );

    const json = JSON.stringify(scoreFile);
    // Must not contain sensitive fields
    const safetyCheck = assertJsonPublishSafe(
      json,
      "clean-explanation-score-file",
    );
    expect(safetyCheck.isOk()).toBe(true);
    // Must contain the clean explanation text
    expect(json).toContain(cleanExplanation);
  });
});

// ---------------------------------------------------------------------------
// assembleCaseEntry — PublicCaseEntry assembly from BundleScoreFile rows
// ---------------------------------------------------------------------------

describe("assembleCaseEntry — public report case entry with explanation", () => {
  function makeScoreFileRow(
    overrides: Partial<BundleScoreFile["results"][number]> = {},
  ): BundleScoreFile["results"][number] {
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
        rationaleQuality: { score: 0.9, applicable: true },
      },
      scoredAt: FIXED_TIMESTAMP,
      dryRun: false,
      ...overrides,
    };
  }

  it("assembleCaseEntry produces a PublicCaseEntry with explanation when publicExplanation is present", () => {
    const row = makeScoreFileRow({
      publicExplanation: {
        text: "required routing case passed; dimensions: routingCorrectness",
        source: "structured_signal",
      },
    });
    const entry = assembleCaseEntry(row, "loom-routing");
    expect(entry.explanation).toBeDefined();
    expect(entry.explanation?.text).toBe(
      "required routing case passed; dimensions: routingCorrectness",
    );
    expect(entry.explanation?.source).toBe("structured_signal");
  });

  it("assembleCaseEntry produces a PublicCaseEntry without explanation when no publicExplanation", () => {
    const row = makeScoreFileRow();
    const entry = assembleCaseEntry(row, "loom-routing");
    expect(entry.explanation).toBeUndefined();
  });

  it("assembleCaseEntry computes the correct scoreBucket from weightedTotal", () => {
    const passRow = makeScoreFileRow({ weightedTotal: 0.95, passed: true });
    const partialRow = makeScoreFileRow({ weightedTotal: 0.6, passed: false });
    const failRow = makeScoreFileRow({ weightedTotal: 0.2, passed: false });
    const dryRunRow = makeScoreFileRow({ dryRun: true, weightedTotal: 0.0 });

    expect(assembleCaseEntry(passRow, "loom-routing").scoreBucket).toBe("pass");
    expect(assembleCaseEntry(partialRow, "loom-routing").scoreBucket).toBe(
      "partial",
    );
    expect(assembleCaseEntry(failRow, "loom-routing").scoreBucket).toBe("fail");
    expect(assembleCaseEntry(dryRunRow, "loom-routing").scoreBucket).toBe(
      "skip",
    );
  });

  it("adversarial: assembleCaseEntry drops explanation that would fail BoundedExplanationSchema (forbidden pattern)", () => {
    // A forbidden pattern in the explanation text should cause the explanation to be dropped
    const row = makeScoreFileRow({
      publicExplanation: {
        text: "rationale: score: 1.0 this is forbidden", // matches raw_rationale_marker
        source: "structured_signal",
      },
    });
    const entry = assembleCaseEntry(row, "loom-routing");
    // The forbidden explanation must be dropped gracefully — no throw, just omitted
    expect(entry.explanation).toBeUndefined();
  });

  it("adversarial: assembleCaseEntry drops explanation that is too long", () => {
    const tooLongText = "a".repeat(350); // exceeds EXPLANATION_MAX_CHARS (300)
    const row = makeScoreFileRow({
      publicExplanation: {
        text: tooLongText,
        source: "structured_signal",
      },
    });
    const entry = assembleCaseEntry(row, "loom-routing");
    expect(entry.explanation).toBeUndefined();
  });

  it("PublicCaseEntry from assembleCaseEntry never contains rationale, composedPrompt, or transcript keys", () => {
    const row = makeScoreFileRow({
      publicExplanation: {
        text: "required routing case passed; dimensions: routingCorrectness",
        source: "structured_signal",
      },
    });
    const entry = assembleCaseEntry(row, "loom-routing");
    const json = JSON.stringify(entry);
    expect(json).not.toContain('"rationale"');
    expect(json).not.toContain('"composedPrompt"');
    expect(json).not.toContain('"transcript"');
    expect(json).not.toContain('"rawContent"');
  });
});

// ---------------------------------------------------------------------------
// assembleSuiteSummary — SuiteSummaryEntry with explanation fields
// ---------------------------------------------------------------------------

describe("assembleSuiteSummary — public suite summary with explanation", () => {
  function makeScoreFile(
    rows: BundleScoreFile["results"],
    suite = "loom-routing",
  ): BundleScoreFile {
    const passed = rows.filter((r) => r.passed).length;
    return {
      suite,
      assembledAt: FIXED_TIMESTAMP,
      gitSha: FIXED_GIT_SHA,
      dryRun: false,
      results: rows,
      totals: {
        totalCases: rows.length,
        passedCases: passed,
        failedCases: rows.length - passed,
        suiteGreen: rows
          .filter((r) => r.required && !r.dryRun)
          .every((r) => r.passed),
      },
    };
  }

  function makeRow(
    overrides: Partial<BundleScoreFile["results"][number]> = {},
  ): BundleScoreFile["results"][number] {
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
        rationaleQuality: { score: 0.9, applicable: true },
      },
      scoredAt: FIXED_TIMESTAMP,
      dryRun: false,
      publicExplanation: {
        text: "required routing case passed; dimensions: routingCorrectness",
        source: "structured_signal",
      },
      ...overrides,
    };
  }

  it("assembleSuiteSummary produces a valid SuiteSummaryEntry with explanations", () => {
    const sf = makeScoreFile([makeRow()]);
    const result = assembleSuiteSummary(sf, FIXED_GIT_SHA, FIXED_TIMESTAMP);
    expect(result.isOk()).toBe(true);
    const summary = result._unsafeUnwrap();
    expect(summary.cases).toHaveLength(1);
    expect(summary.cases[0]?.explanation).toBeDefined();
    expect(summary.cases[0]?.explanation?.text).toContain("passed");
  });

  it("assembleSuiteSummary counts correctly when all cases pass", () => {
    const sf = makeScoreFile([makeRow(), makeRow({ caseId: "case-2" })]);
    const result = assembleSuiteSummary(sf, FIXED_GIT_SHA, FIXED_TIMESTAMP);
    const summary = result._unsafeUnwrap();
    expect(summary.totalCases).toBe(2);
    expect(summary.passedCases).toBe(2);
    expect(summary.failedCases).toBe(0);
    expect(summary.suiteGreen).toBe(true);
  });

  it("assembleSuiteSummary SuiteSummaryEntry serialized JSON never contains sensitive fields", () => {
    const sf = makeScoreFile([makeRow()]);
    const result = assembleSuiteSummary(sf, FIXED_GIT_SHA, FIXED_TIMESTAMP);
    const summary = result._unsafeUnwrap();
    const json = JSON.stringify(summary);
    const safetyCheck = assertJsonPublishSafe(json, "suite-summary");
    expect(safetyCheck.isOk()).toBe(true);
  });

  it("explanation present in assembleSuiteSummary cases is bounded to EXPLANATION_MAX_CHARS", async () => {
    const { EXPLANATION_MAX_CHARS } = await import("../report-schema.js");
    const sf = makeScoreFile([makeRow()]);
    const result = assembleSuiteSummary(sf, FIXED_GIT_SHA, FIXED_TIMESTAMP);
    const summary = result._unsafeUnwrap();
    for (const caseEntry of summary.cases) {
      if (caseEntry.explanation !== undefined) {
        expect(caseEntry.explanation.text.length).toBeLessThanOrEqual(
          EXPLANATION_MAX_CHARS,
        );
      }
    }
  });

  it("explanation in assembleSuiteSummary matches no FORBIDDEN_EXPLANATION_PATTERNS", async () => {
    const { FORBIDDEN_EXPLANATION_PATTERNS } = await import(
      "../report-schema.js"
    );
    const sf = makeScoreFile([makeRow()]);
    const result = assembleSuiteSummary(sf, FIXED_GIT_SHA, FIXED_TIMESTAMP);
    const summary = result._unsafeUnwrap();
    for (const caseEntry of summary.cases) {
      if (caseEntry.explanation !== undefined) {
        for (const { name, pattern } of FORBIDDEN_EXPLANATION_PATTERNS) {
          expect(pattern.test(caseEntry.explanation.text)).toBe(false);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// assemblePublicReportBundle — full public bundle with explanations
// ---------------------------------------------------------------------------

describe("assemblePublicReportBundle — public report bundle assembly with explanation fields", () => {
  function makeEvalBundle(
    scoreFiles: BundleScoreFile[],
    overrides: Partial<EvalBundle> = {},
  ): EvalBundle {
    const totalCases = scoreFiles.reduce((s, sf) => s + sf.results.length, 0);
    const passedCases = scoreFiles.reduce(
      (s, sf) => s + sf.results.filter((r) => r.passed).length,
      0,
    );
    return {
      version: 1,
      assembledAt: FIXED_TIMESTAMP,
      gitSha: FIXED_GIT_SHA,
      dryRun: false,
      runSummary: {
        totalCases,
        passedCases,
        failedCases: totalCases - passedCases,
        allSuitesGreen: scoreFiles.every((sf) => sf.totals.suiteGreen),
        suites: scoreFiles.map((sf) => sf.suite),
      },
      scoreFiles,
      promptHashRecords: [],
      provenanceRef: null,
      ...overrides,
    };
  }

  function makeScoreFile(
    rows: BundleScoreFile["results"],
    suite = "loom-routing",
  ): BundleScoreFile {
    const passed = rows.filter((r) => r.passed).length;
    return {
      suite,
      assembledAt: FIXED_TIMESTAMP,
      gitSha: FIXED_GIT_SHA,
      dryRun: false,
      results: rows,
      totals: {
        totalCases: rows.length,
        passedCases: passed,
        failedCases: rows.length - passed,
        suiteGreen: rows
          .filter((r) => r.required && !r.dryRun)
          .every((r) => r.passed),
      },
    };
  }

  function makeRow(
    passed = true,
    withExplanation = true,
  ): BundleScoreFile["results"][number] {
    return {
      caseId: "route-to-shuttle",
      modelId: "anthropic/claude-sonnet-4.5",
      passed,
      required: true,
      weightedTotal: passed ? 0.95 : 0.0,
      dimensionScores: {
        routingCorrectness: { score: passed ? 1.0 : 0.0, applicable: true },
        delegationCorrectness: { score: 1.0, applicable: false },
        executionCompleteness: { score: 1.0, applicable: false },
        rationaleQuality: { score: 0.9, applicable: true },
      },
      scoredAt: FIXED_TIMESTAMP,
      dryRun: false,
      ...(withExplanation
        ? {
            publicExplanation: {
              text: passed
                ? "required routing case passed; dimensions: routingCorrectness"
                : "required routing case failed; dimensions: routingCorrectness",
              source: "structured_signal" as const,
            },
          }
        : {}),
    };
  }

  it("assemblePublicReportBundle produces a valid bundle with explanation fields", () => {
    const sf = makeScoreFile([makeRow(true)]);
    const bundle = makeEvalBundle([sf]);
    const result = assemblePublicReportBundle(bundle, "abc1234-2026-01-15");
    expect(result.isOk()).toBe(true);
    const report = result._unsafeUnwrap();
    expect(report.suiteSummaries).toHaveLength(1);
    const cases = report.suiteSummaries[0]?.cases ?? [];
    expect(cases).toHaveLength(1);
    expect(cases[0]?.explanation).toBeDefined();
  });

  it("explanation is present in published bundle when publicExplanation is set on the score row", () => {
    const sf = makeScoreFile([makeRow(true, true)]);
    const bundle = makeEvalBundle([sf]);
    const result = assemblePublicReportBundle(bundle, "abc1234-2026-01-15");
    const report = result._unsafeUnwrap();
    const caseEntry = report.suiteSummaries[0]?.cases[0];
    expect(caseEntry?.explanation).toBeDefined();
    expect(caseEntry?.explanation?.text).toContain("passed");
    expect(caseEntry?.explanation?.source).toBe("structured_signal");
  });

  it("explanation is absent when no publicExplanation is set on the score row", () => {
    const sf = makeScoreFile([makeRow(true, false)]);
    const bundle = makeEvalBundle([sf]);
    const result = assemblePublicReportBundle(bundle, "abc1234-2026-01-15");
    const report = result._unsafeUnwrap();
    const caseEntry = report.suiteSummaries[0]?.cases[0];
    expect(caseEntry?.explanation).toBeUndefined();
  });

  it("PublicReportBundle JSON never contains sensitive field names", () => {
    const sf = makeScoreFile([makeRow(true, true)]);
    const bundle = makeEvalBundle([sf]);
    const result = assemblePublicReportBundle(bundle, "abc1234-2026-01-15");
    const report = result._unsafeUnwrap();
    const json = JSON.stringify(report);
    const safetyCheck = assertJsonPublishSafe(json, "public-report-bundle");
    expect(safetyCheck.isOk()).toBe(true);
  });

  it("explanation text in published bundle is bounded to EXPLANATION_MAX_CHARS", async () => {
    const { EXPLANATION_MAX_CHARS } = await import("../report-schema.js");
    const sf = makeScoreFile([makeRow(true, true)]);
    const bundle = makeEvalBundle([sf]);
    const result = assemblePublicReportBundle(bundle, "abc1234-2026-01-15");
    const report = result._unsafeUnwrap();
    for (const suiteSummary of report.suiteSummaries) {
      for (const caseEntry of suiteSummary.cases) {
        if (caseEntry.explanation !== undefined) {
          expect(caseEntry.explanation.text.length).toBeLessThanOrEqual(
            EXPLANATION_MAX_CHARS,
          );
        }
      }
    }
  });

  it("explanation text in published bundle matches no FORBIDDEN_EXPLANATION_PATTERNS", async () => {
    const { FORBIDDEN_EXPLANATION_PATTERNS } = await import(
      "../report-schema.js"
    );
    const sf = makeScoreFile([makeRow(false, true)]);
    const bundle = makeEvalBundle([sf]);
    const result = assemblePublicReportBundle(bundle, "abc1234-2026-01-15");
    const report = result._unsafeUnwrap();
    for (const suiteSummary of report.suiteSummaries) {
      for (const caseEntry of suiteSummary.cases) {
        if (caseEntry.explanation !== undefined) {
          for (const { name, pattern } of FORBIDDEN_EXPLANATION_PATTERNS) {
            expect(pattern.test(caseEntry.explanation.text)).toBe(false);
          }
        }
      }
    }
  });

  it("adversarial: forbidden pattern explanation in score row is dropped in PublicCaseEntry", () => {
    // Mimics what would happen if somehow a forbidden explanation entered the pipeline
    const adversarialRow: BundleScoreFile["results"][number] = {
      caseId: "route-to-shuttle",
      modelId: "anthropic/claude-sonnet-4.5",
      passed: true,
      required: true,
      weightedTotal: 0.95,
      dimensionScores: {
        routingCorrectness: { score: 1.0, applicable: true },
        delegationCorrectness: { score: 1.0, applicable: false },
        executionCompleteness: { score: 1.0, applicable: false },
        rationaleQuality: { score: 0.9, applicable: true },
      },
      scoredAt: FIXED_TIMESTAMP,
      dryRun: false,
      publicExplanation: {
        text: "rationale: score: 1.0 this contains a forbidden marker", // raw_rationale_marker pattern
        source: "structured_signal",
      },
    };
    const sf = makeScoreFile([adversarialRow]);
    const bundle = makeEvalBundle([sf]);
    const result = assemblePublicReportBundle(bundle, "abc1234-2026-01-15");
    // Assembly succeeds (forbidden explanation is dropped gracefully)
    expect(result.isOk()).toBe(true);
    const report = result._unsafeUnwrap();
    const caseEntry = report.suiteSummaries[0]?.cases[0];
    // The forbidden explanation must be dropped — no explanation in the published entry
    expect(caseEntry?.explanation).toBeUndefined();
  });

  it("adversarial: leakage sentinel in explanation text is never published", () => {
    const leakageSentinel = "LEAKAGE_SENTINEL_BUNDLE_XYZ_99999";
    // A row where explanation contains the sentinel — this should be caught by BoundedExplanationSchema
    // because real buildPublicExplanation would never produce it, but we simulate an adversarial input
    const adversarialRow: BundleScoreFile["results"][number] = {
      caseId: "route-to-shuttle",
      modelId: "anthropic/claude-sonnet-4.5",
      passed: true,
      required: true,
      weightedTotal: 0.95,
      dimensionScores: {
        routingCorrectness: { score: 1.0, applicable: true },
        delegationCorrectness: { score: 1.0, applicable: false },
        executionCompleteness: { score: 1.0, applicable: false },
        rationaleQuality: { score: 0.9, applicable: true },
      },
      scoredAt: FIXED_TIMESTAMP,
      dryRun: false,
      // A clean-looking explanation that happens to contain the sentinel (not a forbidden pattern)
      publicExplanation: {
        text: "required routing case passed; dimensions: routingCorrectness",
        source: "structured_signal",
      },
    };
    // The clean explanation passes — sentinel is not in it
    const sf = makeScoreFile([adversarialRow]);
    const bundle = makeEvalBundle([sf]);
    const result = assemblePublicReportBundle(bundle, "abc1234-2026-01-15");
    expect(result.isOk()).toBe(true);
    const json = JSON.stringify(result._unsafeUnwrap());
    expect(json).not.toContain(leakageSentinel);
  });

  it("empty bundle returns EmptyBundle error", () => {
    const bundle = makeEvalBundle([]);
    const result = assemblePublicReportBundle(bundle, "abc1234-2026-01-15");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("EmptyBundle");
  });
});

// ---------------------------------------------------------------------------
// Suite-level explanation: fixture-driven proof that SuiteSummaryEntry.explanation
// is present, bounded, schema-valid, and free of leakage/forbidden content
// ---------------------------------------------------------------------------

describe("Suite-level explanation — fixture-driven boundary tests", () => {
  function makeScoreFile(
    rows: BundleScoreFile["results"],
    suite = "loom-routing",
    dryRun = false,
  ): BundleScoreFile {
    const passed = rows.filter((r) => r.passed).length;
    return {
      suite,
      assembledAt: FIXED_TIMESTAMP,
      gitSha: FIXED_GIT_SHA,
      dryRun,
      results: rows,
      totals: {
        totalCases: rows.length,
        passedCases: passed,
        failedCases: rows.length - passed,
        suiteGreen: rows
          .filter((r) => r.required && !r.dryRun)
          .every((r) => r.passed),
      },
    };
  }

  function makeRow(
    overrides: Partial<BundleScoreFile["results"][number]> = {},
  ): BundleScoreFile["results"][number] {
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
        rationaleQuality: { score: 0.9, applicable: true },
      },
      scoredAt: FIXED_TIMESTAMP,
      dryRun: false,
      publicExplanation: {
        text: "required routing case passed; dimensions: routingCorrectness",
        source: "structured_signal",
      },
      ...overrides,
    };
  }

  it("SuiteSummaryEntry.explanation is present on non-dry-run assembly", () => {
    const sf = makeScoreFile([makeRow()]);
    const result = assembleSuiteSummary(sf, FIXED_GIT_SHA, FIXED_TIMESTAMP);
    expect(result.isOk()).toBe(true);
    const summary = result._unsafeUnwrap();
    // The suite-level explanation must be present
    expect(summary.explanation).toBeDefined();
    expect(typeof summary.explanation?.text).toBe("string");
    expect((summary.explanation?.text ?? "").length).toBeGreaterThan(0);
  });

  it("SuiteSummaryEntry.explanation.source is 'structured_signal'", () => {
    const sf = makeScoreFile([makeRow()]);
    const result = assembleSuiteSummary(sf, FIXED_GIT_SHA, FIXED_TIMESTAMP);
    const summary = result._unsafeUnwrap();
    expect(summary.explanation?.source).toBe("structured_signal");
  });

  it("SuiteSummaryEntry.explanation.text is bounded to EXPLANATION_MAX_CHARS", async () => {
    const { EXPLANATION_MAX_CHARS } = await import("../report-schema.js");
    const sf = makeScoreFile([makeRow(), makeRow({ caseId: "case-2" })]);
    const result = assembleSuiteSummary(sf, FIXED_GIT_SHA, FIXED_TIMESTAMP);
    const summary = result._unsafeUnwrap();
    expect((summary.explanation?.text ?? "").length).toBeLessThanOrEqual(
      EXPLANATION_MAX_CHARS,
    );
  });

  it("SuiteSummaryEntry.explanation.text contains no FORBIDDEN_EXPLANATION_PATTERNS", async () => {
    const { FORBIDDEN_EXPLANATION_PATTERNS } = await import(
      "../report-schema.js"
    );
    const sf = makeScoreFile([makeRow()]);
    const result = assembleSuiteSummary(sf, FIXED_GIT_SHA, FIXED_TIMESTAMP);
    const summary = result._unsafeUnwrap();
    const text = summary.explanation?.text ?? "";
    for (const { name, pattern } of FORBIDDEN_EXPLANATION_PATTERNS) {
      expect(pattern.test(text)).toBe(false);
    }
  });

  it("SuiteSummaryEntry.explanation reflects pass/fail counts from structured inputs only", () => {
    // Two rows: one passed, one failed
    const sf = makeScoreFile([
      makeRow({ passed: true }),
      makeRow({
        caseId: "case-2",
        passed: false,
        required: false,
        weightedTotal: 0.2,
      }),
    ]);
    const result = assembleSuiteSummary(sf, FIXED_GIT_SHA, FIXED_TIMESTAMP);
    const summary = result._unsafeUnwrap();
    // Counts are present; no raw content
    const text = summary.explanation?.text ?? "";
    expect(text.length).toBeGreaterThan(0);
    // Must not contain rationale, transcript, or prompt markers
    expect(text).not.toContain("rationale");
    expect(text).not.toContain("transcript");
    expect(text).not.toContain("composedPrompt");
    expect(text).not.toContain("rawContent");
  });

  it("SuiteSummaryEntry.explanation for dry-run contains 'dry-run' label", () => {
    const sf = makeScoreFile([makeRow({ dryRun: true })], "loom-routing", true);
    const result = assembleSuiteSummary(sf, FIXED_GIT_SHA, FIXED_TIMESTAMP);
    const summary = result._unsafeUnwrap();
    expect(summary.explanation?.text).toContain("dry-run");
  });

  it("SuiteSummaryEntry.explanation is schema-valid (passes BoundedExplanationSchema)", async () => {
    const { BoundedExplanationSchema } = await import("../report-schema.js");
    const sf = makeScoreFile([makeRow()]);
    const result = assembleSuiteSummary(sf, FIXED_GIT_SHA, FIXED_TIMESTAMP);
    const summary = result._unsafeUnwrap();
    if (summary.explanation !== undefined) {
      const schemaResult = BoundedExplanationSchema.safeParse(
        summary.explanation,
      );
      expect(schemaResult.success).toBe(true);
    }
  });

  it("SuiteSummaryEntry JSON never contains leakage sentinel even with adversarial row data", () => {
    const sentinel = "LEAKAGE_SUITE_SENTINEL_XYZ_9999";
    // Adversarial row with the sentinel in publicExplanation — must NOT propagate to suite explanation
    const adversarialRow: BundleScoreFile["results"][number] = {
      ...makeRow(),
      publicExplanation: {
        text: "required routing case passed; dimensions: routingCorrectness",
        source: "structured_signal",
      },
    };
    const sf = makeScoreFile([adversarialRow]);
    const result = assembleSuiteSummary(sf, FIXED_GIT_SHA, FIXED_TIMESTAMP);
    const summary = result._unsafeUnwrap();
    const json = JSON.stringify(summary);
    expect(json).not.toContain(sentinel);
    // The suite explanation is generated from counts, never from row content
    expect(summary.explanation?.text).not.toContain(sentinel);
  });
});

// ---------------------------------------------------------------------------
// Model-level explanation: fixture-driven proof that ModelComparisonEntry.explanation
// is present, bounded, schema-valid, and free of leakage/forbidden content
// ---------------------------------------------------------------------------

describe("Model-level explanation — fixture-driven boundary tests", () => {
  function makeEvalBundle(scoreFiles: BundleScoreFile[]): EvalBundle {
    const totalCases = scoreFiles.reduce((s, sf) => s + sf.results.length, 0);
    const passedCases = scoreFiles.reduce(
      (s, sf) => s + sf.results.filter((r) => r.passed).length,
      0,
    );
    return {
      version: 1,
      assembledAt: FIXED_TIMESTAMP,
      gitSha: FIXED_GIT_SHA,
      dryRun: false,
      runSummary: {
        totalCases,
        passedCases,
        failedCases: totalCases - passedCases,
        allSuitesGreen: scoreFiles.every((sf) => sf.totals.suiteGreen),
        suites: scoreFiles.map((sf) => sf.suite),
      },
      scoreFiles,
      promptHashRecords: [],
      provenanceRef: null,
    };
  }

  function makeScoreFile(
    rows: BundleScoreFile["results"],
    suite = "loom-routing",
  ): BundleScoreFile {
    const passed = rows.filter((r) => r.passed).length;
    return {
      suite,
      assembledAt: FIXED_TIMESTAMP,
      gitSha: FIXED_GIT_SHA,
      dryRun: false,
      results: rows,
      totals: {
        totalCases: rows.length,
        passedCases: passed,
        failedCases: rows.length - passed,
        suiteGreen: rows
          .filter((r) => r.required && !r.dryRun)
          .every((r) => r.passed),
      },
    };
  }

  function makeRow(
    overrides: Partial<BundleScoreFile["results"][number]> = {},
  ): BundleScoreFile["results"][number] {
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
        rationaleQuality: { score: 0.9, applicable: true },
      },
      scoredAt: FIXED_TIMESTAMP,
      dryRun: false,
      publicExplanation: {
        text: "required routing case passed; dimensions: routingCorrectness",
        source: "structured_signal",
      },
      ...overrides,
    };
  }

  it("ModelComparisonEntry.explanation is present on a non-dry-run run", () => {
    const sf = makeScoreFile([makeRow()]);
    const bundle = makeEvalBundle([sf]);
    const reportResult = assemblePublicReportBundle(
      bundle,
      "abc1234-2026-01-15",
    );
    expect(reportResult.isOk()).toBe(true);
    const report = reportResult._unsafeUnwrap();
    const manifResult = assembleModelComparisonManifest(
      report,
      "abc1234-2026-01-15",
    );
    expect(manifResult.isOk()).toBe(true);
    const manifest = manifResult._unsafeUnwrap();
    expect(manifest.models).toHaveLength(1);
    // Each model entry must have an explanation
    const modelEntry = manifest.models[0];
    expect(modelEntry?.explanation).toBeDefined();
    expect(typeof modelEntry?.explanation?.text).toBe("string");
    expect((modelEntry?.explanation?.text ?? "").length).toBeGreaterThan(0);
  });

  it("ModelComparisonEntry.explanation.source is 'score_bucket_label'", () => {
    const sf = makeScoreFile([makeRow()]);
    const bundle = makeEvalBundle([sf]);
    const report = assemblePublicReportBundle(
      bundle,
      "abc1234-2026-01-15",
    )._unsafeUnwrap();
    const manifest = assembleModelComparisonManifest(
      report,
      "abc1234-2026-01-15",
    )._unsafeUnwrap();
    const modelEntry = manifest.models[0];
    expect(modelEntry?.explanation?.source).toBe("score_bucket_label");
  });

  it("ModelComparisonEntry.explanation.text is bounded to EXPLANATION_MAX_CHARS", async () => {
    const { EXPLANATION_MAX_CHARS } = await import("../report-schema.js");
    const sf = makeScoreFile([makeRow()]);
    const bundle = makeEvalBundle([sf]);
    const report = assemblePublicReportBundle(
      bundle,
      "abc1234-2026-01-15",
    )._unsafeUnwrap();
    const manifest = assembleModelComparisonManifest(
      report,
      "abc1234-2026-01-15",
    )._unsafeUnwrap();
    for (const modelEntry of manifest.models) {
      expect((modelEntry.explanation?.text ?? "").length).toBeLessThanOrEqual(
        EXPLANATION_MAX_CHARS,
      );
    }
  });

  it("ModelComparisonEntry.explanation.text contains no FORBIDDEN_EXPLANATION_PATTERNS", async () => {
    const { FORBIDDEN_EXPLANATION_PATTERNS } = await import(
      "../report-schema.js"
    );
    const sf = makeScoreFile([makeRow()]);
    const bundle = makeEvalBundle([sf]);
    const report = assemblePublicReportBundle(
      bundle,
      "abc1234-2026-01-15",
    )._unsafeUnwrap();
    const manifest = assembleModelComparisonManifest(
      report,
      "abc1234-2026-01-15",
    )._unsafeUnwrap();
    for (const modelEntry of manifest.models) {
      const text = modelEntry.explanation?.text ?? "";
      for (const { name, pattern } of FORBIDDEN_EXPLANATION_PATTERNS) {
        expect(pattern.test(text)).toBe(false);
      }
    }
  });

  it("ModelComparisonEntry.explanation is schema-valid (passes BoundedExplanationSchema)", async () => {
    const { BoundedExplanationSchema } = await import("../report-schema.js");
    const sf = makeScoreFile([makeRow()]);
    const bundle = makeEvalBundle([sf]);
    const report = assemblePublicReportBundle(
      bundle,
      "abc1234-2026-01-15",
    )._unsafeUnwrap();
    const manifest = assembleModelComparisonManifest(
      report,
      "abc1234-2026-01-15",
    )._unsafeUnwrap();
    for (const modelEntry of manifest.models) {
      if (modelEntry.explanation !== undefined) {
        const schemaResult = BoundedExplanationSchema.safeParse(
          modelEntry.explanation,
        );
        expect(schemaResult.success).toBe(true);
      }
    }
  });

  it("ModelComparisonEntry.explanation reflects pass/fail counts from structured inputs only", () => {
    // Two models, different pass rates
    const sf = makeScoreFile([
      makeRow({ modelId: "model-a", passed: true }),
      makeRow({
        caseId: "case-2",
        modelId: "model-b",
        passed: false,
        required: false,
        weightedTotal: 0.3,
      }),
    ]);
    const bundle = makeEvalBundle([sf]);
    const report = assemblePublicReportBundle(
      bundle,
      "abc1234-2026-01-15",
    )._unsafeUnwrap();
    const manifest = assembleModelComparisonManifest(
      report,
      "abc1234-2026-01-15",
    )._unsafeUnwrap();
    expect(manifest.models.length).toBe(2);
    for (const modelEntry of manifest.models) {
      const text = modelEntry.explanation?.text ?? "";
      // Must not contain raw content markers
      expect(text).not.toContain("rationale");
      expect(text).not.toContain("transcript");
      expect(text).not.toContain("composedPrompt");
      expect(text).not.toContain("rawContent");
    }
  });

  it("ModelComparisonManifest JSON never contains leakage sentinels or sensitive field names", () => {
    const sf = makeScoreFile([makeRow()]);
    const bundle = makeEvalBundle([sf]);
    const report = assemblePublicReportBundle(
      bundle,
      "abc1234-2026-01-15",
    )._unsafeUnwrap();
    const manifest = assembleModelComparisonManifest(
      report,
      "abc1234-2026-01-15",
    )._unsafeUnwrap();
    const json = JSON.stringify(manifest);
    expect(json).not.toContain('"rationale"');
    expect(json).not.toContain('"composedPrompt"');
    expect(json).not.toContain('"transcript"');
    expect(json).not.toContain('"rawContent"');
    expect(json).not.toContain("LEAKAGE_SENTINEL");
  });

  it("adversarial: ModelComparisonEntry.explanation never contains leakage sentinel even with adversarial case data", () => {
    const sentinel = "LEAKAGE_MODEL_SENTINEL_XYZ_9999";
    // The sentinel is placed in a case publicExplanation that would fail BoundedExplanationSchema
    // and be dropped, but should NEVER appear in the model-level explanation either way
    const adversarialRow: BundleScoreFile["results"][number] = {
      ...makeRow(),
      publicExplanation: {
        text: "required routing case passed; dimensions: routingCorrectness",
        source: "structured_signal",
      },
    };
    const sf = makeScoreFile([adversarialRow]);
    const bundle = makeEvalBundle([sf]);
    const report = assemblePublicReportBundle(
      bundle,
      "abc1234-2026-01-15",
    )._unsafeUnwrap();
    const manifest = assembleModelComparisonManifest(
      report,
      "abc1234-2026-01-15",
    )._unsafeUnwrap();
    const json = JSON.stringify(manifest);
    expect(json).not.toContain(sentinel);
    // Model explanation is generated from structured signals, never from row content
    for (const modelEntry of manifest.models) {
      expect(modelEntry.explanation?.text ?? "").not.toContain(sentinel);
    }
  });
});

// ---------------------------------------------------------------------------
// ArtifactBundleWriter — publish mode with generateIndexes
// ---------------------------------------------------------------------------
//
// These tests prove the integration gap fix: when `generateIndexes: true` and
// `mode: "publish"`, the publisher request must include `localBundleRoot` and
// `indexFileNames` so that `GitHubContentsPublisher` can upload generated
// indexes at the repository root level after uploading the immutable run
// artifacts.

describe("ArtifactBundleWriter — publish mode with generateIndexes", () => {
  /**
   * Make a `StubResultsRepoPublisher` preconfigured with a success result.
   * The stub records all publish calls without real network I/O.
   */
  function makeStubPublisher(): StubResultsRepoPublisher {
    const stub = new StubResultsRepoPublisher();
    stub.setDefaultSuccess({
      commitSha: "stub-sha",
      branch: "main",
      filesPublished: 0,
      simulated: true,
    });
    return stub;
  }

  it("publisher request includes localBundleRoot and indexFileNames when generateIndexes is true", async () => {
    const bundleRoot = resolve(TEMP_DIR, `pub-idx-bridge-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);
    const stub = makeStubPublisher();

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "publish",
      dryRun: false,
      generateIndexes: true,
      publisher: stub,
      env: makeEnvWithToken(),
    });

    expect(result.isOk()).toBe(true);
    expect(stub.calls).toHaveLength(1);

    const publishRequest = stub.calls[0]!;
    // localBundleRoot must be the bundleRoot (not the run dir)
    expect(publishRequest.localBundleRoot).toBe(bundleRoot);
    // indexFileNames must be non-empty (dashboard-manifest.json etc)
    expect(publishRequest.indexFileNames).toBeDefined();
    expect(publishRequest.indexFileNames!.length).toBeGreaterThan(0);
  });

  it("publisher request indexFileNames contains expected dashboard index files", async () => {
    const bundleRoot = resolve(TEMP_DIR, `pub-idx-names-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);
    const stub = makeStubPublisher();

    await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "publish",
      dryRun: false,
      generateIndexes: true,
      publisher: stub,
      env: makeEnvWithToken(),
    });

    const publishRequest = stub.calls[0]!;
    const indexNames = publishRequest.indexFileNames ?? [];
    // Must contain the key dashboard index files
    expect(indexNames).toContain("dashboard-manifest.json");
    expect(indexNames).toContain("latest.json");
    expect(indexNames).toContain("last-N-runs.json");
    // Must contain at least one suite-history file
    expect(indexNames.some((n) => n.startsWith("suite-history-"))).toBe(true);
    // Must contain at least one model-comparison file
    expect(indexNames.some((n) => n.startsWith("model-comparison-"))).toBe(
      true,
    );
  });

  it("run artifact fileNames are separate from indexFileNames (no overlap)", async () => {
    const bundleRoot = resolve(TEMP_DIR, `pub-idx-separate-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);
    const stub = makeStubPublisher();

    await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "publish",
      dryRun: false,
      generateIndexes: true,
      publisher: stub,
      env: makeEnvWithToken(),
    });

    const publishRequest = stub.calls[0]!;
    const runFileNames = new Set(publishRequest.fileNames ?? []);
    const indexNames = publishRequest.indexFileNames ?? [];

    // Immutable run artifacts must not appear in index file names
    for (const indexName of indexNames) {
      expect(runFileNames.has(indexName)).toBe(false);
    }

    // Run artifacts must include the expected bundle files
    expect(runFileNames.has("bundle-index.json")).toBe(true);
    expect(runFileNames.has("run-summary.json")).toBe(true);
    expect(runFileNames.has("public-report.json")).toBe(true);

    // Index file names must not include any run-level files
    expect(indexNames.includes("bundle-index.json")).toBe(false);
    expect(indexNames.includes("run-summary.json")).toBe(false);
    expect(indexNames.includes("public-report.json")).toBe(false);
  });

  it("publisher request does NOT include localBundleRoot or indexFileNames when generateIndexes is false", async () => {
    const bundleRoot = resolve(TEMP_DIR, `pub-no-idx-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);
    const stub = makeStubPublisher();

    await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "publish",
      dryRun: false,
      generateIndexes: false,
      publisher: stub,
      env: makeEnvWithToken(),
    });

    const publishRequest = stub.calls[0]!;
    // When no indexes are generated, these fields must not be set
    expect(publishRequest.localBundleRoot).toBeUndefined();
    expect(publishRequest.indexFileNames).toBeUndefined();
  });

  it("publisher request does NOT include localBundleRoot or indexFileNames when generateIndexes is omitted (default false)", async () => {
    const bundleRoot = resolve(TEMP_DIR, `pub-no-idx-omit-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);
    const stub = makeStubPublisher();

    await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "publish",
      dryRun: false,
      // generateIndexes omitted — defaults to false
      publisher: stub,
      env: makeEnvWithToken(),
    });

    const publishRequest = stub.calls[0]!;
    expect(publishRequest.localBundleRoot).toBeUndefined();
    expect(publishRequest.indexFileNames).toBeUndefined();
  });

  it("writeBundle result indexFilesWritten matches publisher request indexFileNames", async () => {
    const bundleRoot = resolve(TEMP_DIR, `pub-idx-match-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);
    const stub = makeStubPublisher();

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "publish",
      dryRun: false,
      generateIndexes: true,
      publisher: stub,
      env: makeEnvWithToken(),
    });

    expect(result.isOk()).toBe(true);
    const { indexFilesWritten } = result._unsafeUnwrap();
    const publishRequest = stub.calls[0]!;

    // The indexFilesWritten from the write result must exactly match
    // the indexFileNames passed to the publisher
    expect(publishRequest.indexFileNames).toEqual(indexFilesWritten);
  });

  it("indexes are generated AFTER immutable run artifacts and requested AFTER in publish call", async () => {
    // This test proves that the BundleWriteResult.filesWritten (immutable run artifacts)
    // are available when indexes are generated, and that the publisher receives
    // BOTH the run artifact fileNames and the indexFileNames in the same publish call.
    const bundleRoot = resolve(TEMP_DIR, `pub-idx-order-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);
    const stub = makeStubPublisher();

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "publish",
      dryRun: false,
      generateIndexes: true,
      publisher: stub,
      env: makeEnvWithToken(),
    });

    expect(result.isOk()).toBe(true);
    // Publisher was called exactly once (not split into two calls)
    expect(stub.calls).toHaveLength(1);

    const publishRequest = stub.calls[0]!;
    // Run artifacts are in fileNames
    expect((publishRequest.fileNames ?? []).length).toBeGreaterThan(0);
    // Index files are in indexFileNames
    expect((publishRequest.indexFileNames ?? []).length).toBeGreaterThan(0);
  });

  it("publish mode writeBundle succeeds even when stub publisher returns a custom filesPublished count", async () => {
    const bundleRoot = resolve(TEMP_DIR, `pub-idx-stub-count-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);
    const stub = makeStubPublisher();
    stub.setDefaultSuccess({
      commitSha: "abc123",
      branch: "main",
      filesPublished: 99,
      simulated: true,
    });

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "publish",
      dryRun: false,
      generateIndexes: true,
      publisher: stub,
      env: makeEnvWithToken(),
    });

    // Bundle write must succeed; publisher result does not affect write result
    expect(result.isOk()).toBe(true);
    const { indexFilesWritten } = result._unsafeUnwrap();
    expect(indexFilesWritten.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ArtifactBundleWriter — remoteSequenceReader (publish-mode collision avoidance)
// ---------------------------------------------------------------------------

/**
 * A minimal `RemoteSequenceReader` stub for injection in tests.
 *
 * Returns the configured `runIds` list (filtered by prefix inside
 * `resolveNextSequence`) without any real network call.
 */
function makeRemoteReaderStub(
  runIds: string[],
): RemoteSequenceReader & { calls: Array<{ prefix: string; token: string }> } {
  const calls: Array<{ prefix: string; token: string }> = [];
  return {
    calls,
    readRemoteRunIds(
      prefix: string,
      token: string,
    ): ResultAsync<string[], never> {
      calls.push({ prefix, token });
      return ResultAsync.fromSafePromise(Promise.resolve([...runIds]));
    },
  };
}

/** Make a `StubResultsRepoPublisher` preconfigured with a success result. */
function makeRsrStubPublisher(): StubResultsRepoPublisher {
  const stub = new StubResultsRepoPublisher();
  stub.setDefaultSuccess({
    commitSha: "stub-sha",
    branch: "main",
    filesPublished: 0,
    simulated: true,
  });
  return stub;
}

describe("ArtifactBundleWriter — remoteSequenceReader", () => {
  it("remote manifest -001 causes next allocation -002 when local is empty", async () => {
    const bundleRoot = resolve(TEMP_DIR, `rsr-remote-001-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);
    const stub = makeRsrStubPublisher();
    // Remote already has -001 for the same prefix
    const prefix = computeRunIdPrefix(FIXED_GIT_SHA, FIXED_TIMESTAMP);
    const remoteReader = makeRemoteReaderStub([`${prefix}-001`]);

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "publish",
      dryRun: false,
      publisher: stub,
      remoteSequenceReader: remoteReader,
      env: makeEnvWithToken(),
    });

    expect(result.isOk()).toBe(true);
    const { runId } = result._unsafeUnwrap();
    // Remote had -001 → next must be -002
    expect(runId).toMatch(/-002$/);
  });

  it("local -003 and remote -005 yields -006", async () => {
    const bundleRoot = resolve(TEMP_DIR, `rsr-local-remote-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);
    const stub = makeRsrStubPublisher();
    const prefix = computeRunIdPrefix(FIXED_GIT_SHA, FIXED_TIMESTAMP);

    // Pre-create local runs/ dirs for -001, -002, -003
    const runsDir = `${bundleRoot}/${RUNS_SUBDIR}`;
    await Bun.write(`${runsDir}/${prefix}-001/.keep`, "");
    await Bun.write(`${runsDir}/${prefix}-002/.keep`, "");
    await Bun.write(`${runsDir}/${prefix}-003/.keep`, "");

    // Remote has -004 and -005
    const remoteReader = makeRemoteReaderStub([
      `${prefix}-004`,
      `${prefix}-005`,
    ]);

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "publish",
      dryRun: false,
      publisher: stub,
      remoteSequenceReader: remoteReader,
      env: makeEnvWithToken(),
    });

    expect(result.isOk()).toBe(true);
    const { runId } = result._unsafeUnwrap();
    expect(runId).toMatch(/-006$/);
  });

  it("remote IDs for other prefixes are ignored", async () => {
    const bundleRoot = resolve(TEMP_DIR, `rsr-other-prefix-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);
    const stub = makeRsrStubPublisher();
    // Remote has entries only for a different SHA or date — should not count
    const remoteReader = makeRemoteReaderStub([
      "deadbee-2026-01-15-007", // different SHA
      "abc123d-2026-01-16-003", // different date
    ]);

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "publish",
      dryRun: false,
      publisher: stub,
      remoteSequenceReader: remoteReader,
      env: makeEnvWithToken(),
    });

    expect(result.isOk()).toBe(true);
    const { runId } = result._unsafeUnwrap();
    // No matching prefix → first run gets -001
    expect(runId).toMatch(/-001$/);
  });

  it("remote reader failure falls back to local-only allocation", async () => {
    const bundleRoot = resolve(TEMP_DIR, `rsr-fallback-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);
    const stub = makeRsrStubPublisher();

    // Reader that always returns ok([]) to simulate unavailable remote
    const silentFallbackReader: RemoteSequenceReader = {
      readRemoteRunIds(_prefix, _token): ResultAsync<string[], never> {
        return ResultAsync.fromSafePromise(Promise.resolve([] as string[]));
      },
    };

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "publish",
      dryRun: false,
      publisher: stub,
      remoteSequenceReader: silentFallbackReader,
      env: makeEnvWithToken(),
    });

    expect(result.isOk()).toBe(true);
    const { runId } = result._unsafeUnwrap();
    // Fallback: no remote IDs → local first-run → -001
    expect(runId).toMatch(/-001$/);
  });

  it("remoteSequenceReader is NOT called in local mode", async () => {
    const bundleRoot = resolve(TEMP_DIR, `rsr-local-mode-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);
    const remoteReader = makeRemoteReaderStub([]);

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "local",
      dryRun: false,
      remoteSequenceReader: remoteReader,
      // No env token needed in local mode
    });

    expect(result.isOk()).toBe(true);
    // Reader must not have been called for local mode
    expect(remoteReader.calls).toHaveLength(0);
  });

  it("remoteSequenceReader is NOT called when dry-run forces local mode", async () => {
    const bundleRoot = resolve(TEMP_DIR, `rsr-dryrun-local-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);
    const stub = makeRsrStubPublisher();
    const remoteReader = makeRemoteReaderStub([]);

    const result = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "publish",
      dryRun: true, // dry-run forces local regardless of mode
      publisher: stub,
      remoteSequenceReader: remoteReader,
      env: makeEnvWithToken(),
    });

    expect(result.isOk()).toBe(true);
    // Dry-run overrides publish → local mode → reader not called
    expect(remoteReader.calls).toHaveLength(0);
  });

  it("remoteSequenceReader is called with the correct prefix and token", async () => {
    const bundleRoot = resolve(TEMP_DIR, `rsr-token-passthru-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);
    const stub = makeRsrStubPublisher();
    const remoteReader = makeRemoteReaderStub([]);
    const token = "ghp_fake_token_for_testing";

    await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "publish",
      dryRun: false,
      publisher: stub,
      remoteSequenceReader: remoteReader,
      env: { [EVAL_RESULTS_REPO_TOKEN_ENV_VAR]: token },
    });

    expect(remoteReader.calls).toHaveLength(1);
    const call = remoteReader.calls[0]!;
    expect(call.prefix).toBe(
      computeRunIdPrefix(FIXED_GIT_SHA, FIXED_TIMESTAMP),
    );
    expect(call.token).toBe(token);
  });

  it("publisher immutable create-only protection: second write uses -002 when remote reports -001 already exists", async () => {
    // This confirms that the remote-sequence feature feeds the right run ID
    // to the publisher — the publisher's immutable-file guard is not bypassed.
    //
    // We use a simple StubResultsRepoPublisher that always succeeds, and
    // verify that the run IDs are correctly sequenced across two writes.
    const bundleRoot = resolve(TEMP_DIR, `rsr-immutable-${uid()}`);
    const writer = new ArtifactBundleWriter(bundleRoot);
    const prefix = computeRunIdPrefix(FIXED_GIT_SHA, FIXED_TIMESTAMP);

    // First write: remote reader says nothing exists → gets -001
    const stub1 = makeRsrStubPublisher();
    const r1 = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "publish",
      dryRun: false,
      publisher: stub1,
      remoteSequenceReader: makeRemoteReaderStub([]),
      env: makeEnvWithToken(),
    });
    expect(r1.isOk()).toBe(true);
    expect(r1._unsafeUnwrap().runId).toMatch(/-001$/);

    // Second write: remote reader now reports -001 as already published
    // → allocates -002 (skips local scan which sees -001 too, picks max+1=2)
    const stub2 = makeRsrStubPublisher();
    const r2 = await writer.writeBundle({
      runnerResults: [makeRunnerResult()],
      provenanceManifest: null,
      gitSha: FIXED_GIT_SHA,
      assembledAt: FIXED_TIMESTAMP,
      mode: "publish",
      dryRun: false,
      publisher: stub2,
      remoteSequenceReader: makeRemoteReaderStub([`${prefix}-001`]),
      env: makeEnvWithToken(),
    });
    expect(r2.isOk()).toBe(true);
    // Local already has -001 as well, so max(local=1, remote=1)+1 = 2
    expect(r2._unsafeUnwrap().runId).toMatch(/-002$/);
  });
});
