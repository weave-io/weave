/**
 * Unit tests for `artifact-bundle.ts` — what a user cannot observe on disk.
 *
 * Everything this file used to assert about the **written bundle** now lives in
 * [`tests/evals/bundle-writing.scenario.test.ts`](../../../../../tests/evals/bundle-writing.scenario.test.ts):
 * run IDs and sequence numbering, immutability across repeat writes, the
 * remote-aware sequence allocation, score-file aggregation for multi-model
 * runs, the `publicFiles` allowlist, the token gate, provenance and prompt
 * hashes, and the Markdown report. Those promises are observable in the files
 * the writer produces, so they belong in the scenario bucket; see
 * [`docs/testing-strategy.md`](../../../../../docs/testing-strategy.md).
 *
 * What stays here, and why:
 *
 *   - **`assertBundlePublishEligible()`** — an exported publish-policy guard
 *     with no production caller. Nothing it decides reaches a file, so a
 *     scenario cannot reach it. (That it has no caller is itself worth a look.)
 *   - **Dashboard index families** — which index files `generateIndexes`
 *     produces, and that a failing index build never fails the bundle write.
 *     The index writer is `dashboard-indexes.ts`'s subject, not this file's;
 *     the scenario bucket only pins where the indexes land and their run count.
 *   - **`ModelComparisonEntry` explanations** — the model-comparison manifest
 *     is an index artifact rather than part of a run directory, so its bounded
 *     explanation fields are not reachable from the bundle scenarios.
 *   - **What the results-repo publisher is handed** — `localBundleRoot`,
 *     `fileNames` and `indexFileNames`, and their ordering. This is an
 *     injected external seam, not a file on disk.
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
  assertBundlePublishEligible,
  EVAL_RESULTS_REPO_TOKEN_ENV_VAR,
  type RemoteSequenceReader,
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
  assembleModelComparisonManifest,
  assemblePublicReportBundle,
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
    erroredCases: 0,
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

function makeEnvWithToken(): Record<string, string | undefined> {
  return { [EVAL_RESULTS_REPO_TOKEN_ENV_VAR]: "test-token-value" };
}

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
// ArtifactBundleWriter — generateIndexes option
// ---------------------------------------------------------------------------

describe("ArtifactBundleWriter — generateIndexes option", () => {
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
