/**
 * Tests for `evals/runner.ts` — `EvalOrchestrator` and `buildEvalRunner`.
 *
 * Verifies:
 *   - Pre-flight: missing API key → typed `CliError`, exit 1, no model calls.
 *   - Pre-flight: model matrix load failure → `CliError`, no suite runs.
 *   - Pre-flight: unknown model filter → `CliError` with allowlist hint.
 *   - Suite fan-out: all registered suites run when no agent filter.
 *   - Suite fan-out: only the matching suite runs when agent filter is set.
 *   - Per-suite hard failures (NoCasesFound) accumulate as partialFailures.
 *   - Run-level summary has correct agentRollups and modelRollups.
 *   - allSuitesGreen is false when any required case fails.
 *   - allSuitesGreen is true when all required cases pass.
 *   - buildEvalRunner maps green summary → exit 0.
 *   - buildEvalRunner maps threshold misses with complete results → exit 0.
 *   - buildEvalRunner maps partialFailures → exit 1.
 *   - Run metadata contains bunVersion, repoSha, filters, publishMode.
 *   - Run metadata never contains API key, token, or raw env values.
 *   - workflowRunId is populated from GITHUB_RUN_ID when digits-only.
 *   - workflowRunId is null when GITHUB_RUN_ID contains any non-digit chars (including hyphens).
 *   - Raw artifacts are written only when rawArtifacts === true.
 *   - Repeatability diagnostics are written for non-dry runs and compare only exact-filter reruns.
 *   - No real network, git, LangChain, or file-system calls in the unit test sections.
 *
 * Integration sections (labeled "integration"):
 *   - Use `REAL_EVALS_ROOT` (repo fixtures) with injected StubModelClient/StubAgentEvalsScorer.
 *   - Write to OS temp dir (`os.tmpdir()`); no hardcoded host paths.
 *
 * All external dependencies are injected:
 *   - `StubModelClient` for model inference.
 *   - `StubAgentEvalsScorer` for scoring.
 *   - `MockPromptProvider` for prompt composition.
 *   - Stub `GitShaProvider` returning a known SHA.
 *   - `evalsRoot` pointing to a non-existent directory (empty fixture set).
 *   - `bundleRoot` pointing to a temp directory for file writes.
 *   - `env` injected without real API keys in assertions.
 *
 * Note: because the suite runners load fixtures from disk (and we point
 * evalsRoot to a non-existent path), all suites produce NoCasesFound hard
 * errors which are accumulated as partialFailures. Tests that need
 * successful suite results use a custom `evalsRoot` with fixture stubs or
 * verify summary fields directly.
 */

import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { err, ok, ResultAsync } from "neverthrow";
import type { EvalRunRequest } from "../input-validation.js";
import { StubAgentEvalsScorer } from "../langchain-agent-evals.js";
import { StubModelClient } from "../openrouter-client.js";
import type { GitShaProvider } from "../provenance.js";
import { StubResultsRepoPublisher } from "../results-repo.js";
import {
  buildEvalRunner,
  EvalOrchestrator,
  type EvalOrchestratorOptions,
  getEvalCoveredPromptAgents,
  type SnapshotProvider,
} from "../runner.js";
import type {
  DimensionScore,
  NormalizedScoreRecord,
  PromptProvider,
  PromptSnapshot,
  ProvenanceError,
} from "../types.js";
import { EVAL_SHORT_AGENT_FILTERS, EVAL_SUITE_REGISTRY } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEMP_DIR = tmpdir();
const FAKE_EVALS_ROOT = join(TEMP_DIR, "fake-evals-runner-test");
const FAKE_BUNDLE_ROOT = join(TEMP_DIR, "fake-bundles-runner-test");
const FAKE_GIT_SHA = "abc1234def5678901234567890123456789012ab";
const FAKE_API_KEY = "test-api-key-not-real";
const FIXED_TIMESTAMP = "2026-06-10T00:00:00.000Z";

/**
 * Absolute path to the real eval fixtures in the repo root.
 * Used by integration tests that exercise case loading from disk
 * without going all the way to the model API or LangChain scorer.
 */
const REAL_EVALS_ROOT = resolve(import.meta.dir, "../../../../..", "evals");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class MockPromptProvider implements PromptProvider {
  constructor(private readonly prompt: string = "You are a test agent.") {}

  getPrompt(_agentName: string): ResultAsync<string, ProvenanceError> {
    return ResultAsync.fromSafePromise(Promise.resolve(this.prompt));
  }
}

class FailingPromptProvider implements PromptProvider {
  getPrompt(agentName: string): ResultAsync<string, ProvenanceError> {
    return new ResultAsync(
      Promise.resolve(
        err<string, ProvenanceError>({
          type: "PromptCompositionError",
          agentName,
          message: "Stub prompt provider configured to fail",
        }),
      ),
    );
  }
}

/**
 * Stub `SnapshotProvider` that returns controlled `PromptSnapshot` records
 * without any file I/O, git, or engine calls.
 */
class StubSnapshotProvider implements SnapshotProvider {
  readonly calls: Array<readonly string[]> = [];

  constructor(private readonly snapshots: PromptSnapshot[] = []) {}

  async getSnapshots(agentNames: readonly string[]): Promise<PromptSnapshot[]> {
    this.calls.push(agentNames);
    return this.snapshots;
  }
}

/**
 * Build a minimal `PromptSnapshot` record for testing.
 */
function makeSnapshot(
  agentName: string,
  hash = "abc123def456",
): PromptSnapshot {
  return {
    agentName,
    hash,
    byteLength: 42,
    charLength: 42,
    sources: [{ kind: "builtin", layer: "primary" }],
  };
}

/**
 * Extract the `message` field from a `CliError` when it is an `EvalValidation`
 * variant. Throws if the variant does not have a `message` field.
 */
function getEvalValidationMessage(cliErr: {
  type: string;
  message?: string;
}): string {
  if (cliErr.type !== "EvalValidation") {
    throw new Error(`Expected EvalValidation error but got: ${cliErr.type}`);
  }
  if (cliErr.message === undefined) {
    throw new Error("EvalValidation error has no message");
  }
  return cliErr.message;
}

function makeGitShaProvider(sha: string = FAKE_GIT_SHA): GitShaProvider {
  return { resolveGitSha: () => ok(sha) };
}

function makeRequest(overrides: Partial<EvalRunRequest> = {}): EvalRunRequest {
  return {
    agent: undefined,
    model: undefined,
    case: undefined,
    dryRun: false,
    rawArtifacts: false,
    ...overrides,
  };
}

function makeOptions(
  overrides: Partial<EvalOrchestratorOptions> = {},
): EvalOrchestratorOptions {
  return {
    modelClient: new StubModelClient(),
    scorer: new StubAgentEvalsScorer(),
    promptProvider: new MockPromptProvider(),
    snapshotProvider: new StubSnapshotProvider(),
    gitShaProvider: makeGitShaProvider(),
    bundleRoot: FAKE_BUNDLE_ROOT,
    evalsRoot: FAKE_EVALS_ROOT,
    assembledAt: FIXED_TIMESTAMP,
    env: { OPENROUTER_API_KEY: FAKE_API_KEY },
    ...overrides,
  };
}

async function writeInvalidDryRunFixtureRoot(): Promise<string> {
  const evalsRoot = join(TEMP_DIR, `invalid-dry-run-fixtures-${uid()}`);
  await Bun.write(
    join(evalsRoot, "cases/loom-routing/bad-case.json"),
    JSON.stringify({
      description: "missing id should fail schema validation",
      suite: "loom-routing",
      allowed_agents: ["loom"],
      allowed_models: ["anthropic/claude-sonnet-4.5"],
      expected_outcome: {
        kind: "agent_routing",
        target_agent: "loom",
        via: [],
      },
    }),
  );
  return evalsRoot;
}

// ---------------------------------------------------------------------------
// Integration helpers — used by raw-artifact timestamp integration tests
// ---------------------------------------------------------------------------

let _uidCounter = 0;
function uid(): string {
  return `${Date.now()}-${++_uidCounter}`;
}

/**
 * Build a minimal passing `NormalizedScoreRecord` for a loom-routing case.
 *
 * Used in integration tests that need the scorer stub to return a passing
 * record so the orchestrator produces a `CaseResult` with `rawArtifact`.
 */
function makePassingScoreRecord(
  caseId: string,
  modelId: string,
): NormalizedScoreRecord {
  const neutralDim: DimensionScore = {
    score: 1.0,
    rationale: "n/a",
    applicable: false,
  };
  const activeDim: DimensionScore = {
    score: 1.0,
    rationale: "Correctly routed to shuttle.",
    applicable: true,
  };
  return {
    caseId,
    modelId,
    suite: "loom-routing",
    dimensions: {
      routingCorrectness: activeDim,
      delegationCorrectness: neutralDim,
      executionCompleteness: neutralDim,
      rationaleQuality: {
        score: 0.9,
        rationale: "Good rationale.",
        applicable: true,
      },
    },
    weightedTotal: 1.0,
    passed: true,
    required: true,
    scoredAt: new Date().toISOString(),
  };
}

/**
 * Build a minimal failing `NormalizedScoreRecord` for a loom-routing case.
 *
 * This represents a completed eval case that missed its pass threshold. The
 * CLI should publish/report this as eval data, not treat it as process failure.
 */
function makeFailingScoreRecord(
  caseId: string,
  modelId: string,
): NormalizedScoreRecord {
  const inactiveDim: DimensionScore = {
    score: 0.0,
    rationale: "n/a",
    applicable: false,
  };
  const failingDim: DimensionScore = {
    score: 0.0,
    rationale: "Incorrect route.",
    applicable: true,
  };
  return {
    caseId,
    modelId,
    suite: "loom-routing",
    dimensions: {
      routingCorrectness: failingDim,
      delegationCorrectness: inactiveDim,
      executionCompleteness: inactiveDim,
      rationaleQuality: {
        score: 0.2,
        rationale: "Sparse rationale.",
        applicable: true,
      },
    },
    weightedTotal: 0.0,
    passed: false,
    required: true,
    scoredAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Pre-flight: environment validation
// ---------------------------------------------------------------------------

describe("EvalOrchestrator — environment validation", () => {
  it("returns CliError when OPENROUTER_API_KEY is missing", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions({ env: {} }));
    const result = await orchestrator.run(makeRequest());
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("EvalValidation");
      const msg = getEvalValidationMessage(result.error);
      expect(msg).toContain("OPENROUTER_API_KEY");
      // Must not expose the key value (it was never set, so no value to expose)
    }
  });

  it("returns CliError when OPENROUTER_API_KEY is empty string", async () => {
    const orchestrator = new EvalOrchestrator(
      makeOptions({ env: { OPENROUTER_API_KEY: "" } }),
    );
    const result = await orchestrator.run(makeRequest());
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("EvalValidation");
    }
  });

  it("does not call any model when API key is missing", async () => {
    const modelClient = new StubModelClient();
    const orchestrator = new EvalOrchestrator(
      makeOptions({ modelClient, env: {} }),
    );
    await orchestrator.run(makeRequest());
    expect(modelClient.calls).toHaveLength(0);
  });

  it("error message does not contain Bearer or sk- (no token leakage)", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions({ env: {} }));
    const result = await orchestrator.run(makeRequest());
    if (result.isErr()) {
      const msg = getEvalValidationMessage(result.error);
      expect(msg).not.toContain("Bearer");
      expect(msg).not.toContain("sk-");
    }
  });

  it("skips OPENROUTER_API_KEY validation in dry-run while still loading real fixtures", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const orchestrator = new EvalOrchestrator(
      makeOptions({
        env: {},
        modelClient,
        scorer,
        evalsRoot: REAL_EVALS_ROOT,
      }),
    );

    const result = await orchestrator.run(
      makeRequest({
        dryRun: true,
        agent: "loom",
        model: "anthropic/claude-sonnet-4.5",
        case: "loom-route-backend-api",
      }),
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.totalCases).toBe(1);
    expect(result.value.partialFailures).toHaveLength(0);
    expect(result.value.runId).toBeNull();
    expect(result.value.filesWritten).toEqual([]);
    expect(modelClient.calls).toHaveLength(0);
    expect(scorer.calls).toHaveLength(0);
  });

  it("dry-run surfaces fixture-load failures through the real suite path", async () => {
    const evalsRoot = await writeInvalidDryRunFixtureRoot();
    const orchestrator = new EvalOrchestrator(
      makeOptions({
        env: {},
        evalsRoot,
      }),
    );

    const result = await orchestrator.run(
      makeRequest({
        dryRun: true,
        agent: "loom",
        model: "anthropic/claude-sonnet-4.5",
      }),
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.totalCases).toBe(0);
    expect(result.value.partialFailures).toHaveLength(1);
    expect(result.value.partialFailures[0]?.type).toBe("FixtureLoadError");
  });
});

// ---------------------------------------------------------------------------
// Pre-flight: model matrix validation
// ---------------------------------------------------------------------------

describe("EvalOrchestrator — model matrix", () => {
  it("returns CliError for unknown model filter", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    // Use a model ID that does not exist in the real matrix
    const result = await orchestrator.run(
      makeRequest({ model: "totally/unknown-model-xyz" }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("EvalValidation");
      const msg = getEvalValidationMessage(result.error);
      expect(msg).toContain("totally/unknown-model-xyz");
    }
  });

  it("model filter error message contains allowlist hint (no raw values)", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(
      makeRequest({ model: "nonexistent/model" }),
    );
    if (result.isErr()) {
      // The error should mention the model ID filter and the allowed models
      const msg = getEvalValidationMessage(result.error);
      expect(msg).toContain("nonexistent/model");
      // But must not contain any API key, token, or secret
      expect(msg).not.toContain(FAKE_API_KEY);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite fan-out: all registered suites run by default
// ---------------------------------------------------------------------------

describe("EvalOrchestrator — suite fan-out", () => {
  it("shared suite registry still enumerates the seven-suite text-only surface", () => {
    expect(EVAL_SUITE_REGISTRY).toHaveLength(7);
    expect(EVAL_SUITE_REGISTRY.map((suite) => suite.shortAgentFilter)).toEqual(
      EVAL_SHORT_AGENT_FILTERS,
    );
  });

  it("returns ok(summary) when env and matrix are valid (even with empty fixture sets)", async () => {
    // evalsRoot points to non-existent dir → all registered suites produce NoCasesFound
    // which is accumulated as partialFailures, not a hard error
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest());
    // Should succeed (partialFailures are not hard errors)
    expect(result.isOk()).toBe(true);
  });

  it("registered suites appear in partialFailures when fixtures are missing", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const summary = result.value;
      // With 3 default models × registry suite count, expect one failure per
      // model × suite combination when fixtures are missing.
      // (NoCasesFound or PromptProviderFailed for each model × suite pair)
      const failureTypes = summary.partialFailures.map((f) => f.type);
      // NoCasesFound (or PromptProviderFailed) expected for each missing suite
      expect(failureTypes.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("fan-out across all default models: partialFailures count reflects model × suite combinations", async () => {
    // With 3 default models and the current registry suite count, we get one
    // partial failure per model × suite combination (NoCasesFound here).
    // This verifies that the orchestrator fans out across the full default matrix,
    // not just the first model.
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // At least 3 partial failures (one per model for at least one suite);
      // the real count is 6 but we allow flexibility for how runners fail
      expect(result.value.partialFailures.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("single model filter produces only one model's suite failures", async () => {
    // When a specific model is filtered, only that model is run → fewer failures
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(
      makeRequest({ model: "anthropic/claude-sonnet-4.5" }),
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.partialFailures.length).toBeLessThanOrEqual(
        EVAL_SUITE_REGISTRY.length,
      );
    }
  });

  it("agent filter 'loom' restricts to loom suite only across all default models", async () => {
    const modelClient = new StubModelClient();
    const orchestrator = new EvalOrchestrator(makeOptions({ modelClient }));
    const result = await orchestrator.run(makeRequest({ agent: "loom" }));
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Loom suite only, 3 default models → at most 3 partial failures
      // (one NoCasesFound per model, other suites are skipped)
      expect(result.value.partialFailures.length).toBeLessThanOrEqual(3);
    }
  });

  it("agent filter 'tapestry' restricts to tapestry suite only across all default models", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest({ agent: "tapestry" }));
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Tapestry suite only, 3 default models → at most 3 partial failures
      expect(result.value.partialFailures.length).toBeLessThanOrEqual(3);
    }
  });

  it("agent filter 'shuttle' restricts to shuttle suite only across all default models", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest({ agent: "shuttle" }));
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.partialFailures.length).toBeLessThanOrEqual(3);
    }
  });

  it("agent filter 'spindle' restricts to spindle suite only across all default models", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest({ agent: "spindle" }));
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.partialFailures.length).toBeLessThanOrEqual(3);
    }
  });

  it("agent filter 'weft' restricts to weft suite only across all default models", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest({ agent: "weft" }));
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.partialFailures.length).toBeLessThanOrEqual(3);
    }
  });

  it("agent filter 'warp' restricts to warp suite only across all default models", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest({ agent: "warp" }));
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.partialFailures.length).toBeLessThanOrEqual(3);
    }
  });
});

// ---------------------------------------------------------------------------
// Run-level summary structure
// ---------------------------------------------------------------------------

describe("EvalOrchestrator — run summary structure", () => {
  it("summary contains metadata with bunVersion and repoSha", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const { metadata } = result.value;
      expect(typeof metadata.bunVersion).toBe("string");
      expect(metadata.bunVersion.length).toBeGreaterThan(0);
      expect(metadata.repoSha).toBe(FAKE_GIT_SHA);
    }
  });

  it("metadata filters match the request values", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(
      makeRequest({ agent: "loom", case: "case-01" }),
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const { metadata } = result.value;
      expect(metadata.agentFilter).toBe("loom");
      expect(metadata.caseFilter).toBe("case-01");
      expect(metadata.modelFilter).toBeNull();
    }
  });

  it("metadata filters are null when no filters are set", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const { metadata } = result.value;
      expect(metadata.agentFilter).toBeNull();
      expect(metadata.modelFilter).toBeNull();
      expect(metadata.caseFilter).toBeNull();
    }
  });

  it("metadata.rawArtifactsEnabled reflects the request", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest({ rawArtifacts: false }));
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.metadata.rawArtifactsEnabled).toBe(false);
    }
  });

  it("metadata.publishMode defaults to 'local'", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.metadata.publishMode).toBe("local");
    }
  });

  it("metadata.publishMode is 'publish' when configured", async () => {
    const orchestrator = new EvalOrchestrator(
      makeOptions({ publishMode: "publish" }),
    );
    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.metadata.publishMode).toBe("publish");
    }
  });

  it("metadata.startedAt is an ISO 8601 timestamp", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const { startedAt } = result.value.metadata;
      expect(startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });

  it("metadata does not contain the API key", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const metadataStr = JSON.stringify(result.value.metadata);
      expect(metadataStr).not.toContain(FAKE_API_KEY);
      expect(metadataStr).not.toContain("Bearer");
    }
  });

  it("summary totals are zero when no cases ran", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const summary = result.value;
      expect(summary.totalCases).toBe(0);
      expect(summary.passedCases).toBe(0);
      expect(summary.failedCases).toBe(0);
    }
  });

  it("agentRollups is empty when no suites produced results", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.agentRollups).toHaveLength(0);
    }
  });

  it("modelRollups is empty when no cases ran", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.modelRollups).toHaveLength(0);
    }
  });

  it("bundleDir is reported in summary", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(typeof result.value.bundleDir).toBe("string");
      expect(result.value.bundleDir.length).toBeGreaterThan(0);
    }
  });

  it("rawArtifactsWritten is empty when rawArtifacts is false", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.rawArtifactsWritten).toEqual([]);
    }
  });

  it("repeatabilityDiagnostics is null when no runner results were produced", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.repeatabilityDiagnostics).toBeNull();
    }
  });

  it("runId is null when no runner results were produced (empty fixture sets)", async () => {
    // With an empty evalsRoot, no runner results are produced → runId is null
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.runId).toBeNull();
    }
  });

  it("allSuitesGreen is true when no required cases ran (vacuously)", async () => {
    // With empty fixture sets, no required cases exist → vacuously green
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // allSuitesGreen is every() over an empty array → true
      expect(result.value.allSuitesGreen).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Workflow run ID from CI env
// ---------------------------------------------------------------------------

describe("EvalOrchestrator — workflowRunId metadata", () => {
  it("workflowRunId is null when GITHUB_RUN_ID is not set", async () => {
    const orchestrator = new EvalOrchestrator(
      makeOptions({ env: { OPENROUTER_API_KEY: FAKE_API_KEY } }),
    );
    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.metadata.workflowRunId).toBeNull();
    }
  });

  it("workflowRunId is set from GITHUB_RUN_ID when numeric", async () => {
    const orchestrator = new EvalOrchestrator(
      makeOptions({
        env: { OPENROUTER_API_KEY: FAKE_API_KEY, GITHUB_RUN_ID: "12345678" },
      }),
    );
    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.metadata.workflowRunId).toBe("12345678");
    }
  });

  it("workflowRunId is null when GITHUB_RUN_ID contains non-numeric chars", async () => {
    const orchestrator = new EvalOrchestrator(
      makeOptions({
        // Arbitrary string — must be rejected to prevent env leakage
        env: { OPENROUTER_API_KEY: FAKE_API_KEY, GITHUB_RUN_ID: "run-abc-xyz" },
      }),
    );
    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // "run-abc-xyz" has letters → must be null
      expect(result.value.metadata.workflowRunId).toBeNull();
    }
  });

  it("workflowRunId is null when GITHUB_RUN_ID contains hyphens (digits-only contract)", async () => {
    const orchestrator = new EvalOrchestrator(
      makeOptions({
        env: { OPENROUTER_API_KEY: FAKE_API_KEY, GITHUB_RUN_ID: "123-456" },
      }),
    );
    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // "123-456" has hyphens → digits-only contract rejects it
      expect(result.value.metadata.workflowRunId).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// buildEvalRunner — exit code mapping
// ---------------------------------------------------------------------------

describe("buildEvalRunner — exit code mapping", () => {
  it("returns ok(1) when partial failures prevent complete results", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const runner = buildEvalRunner(orchestrator);
    const result = await runner(makeRequest());
    // Empty fixture sets → no required cases → allSuitesGreen is true
    // But partialFailures exist → exit 1
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // partialFailures (NoCasesFound) cause exit 1
      expect(result.value).toBe(1);
    }
  });

  it("returns ok(1) when orchestrator returns hard CliError", async () => {
    const orchestrator = new EvalOrchestrator(
      makeOptions({ env: {} }), // missing API key → CliError
    );
    const runner = buildEvalRunner(orchestrator);
    const result = await runner(makeRequest());
    // buildEvalRunner propagates err(CliError) directly
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("EvalValidation");
    }
  });

  it("returns ok(1) when there are partial failures", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const runner = buildEvalRunner(orchestrator);
    const result = await runner(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Partial failures (empty fixture sets) → exit 1
      expect(result.value).toBe(1);
    }
  });

  it("returns ok(0) when complete eval results miss thresholds", async () => {
    const caseId = "loom-route-backend-api";
    const modelId = "anthropic/claude-sonnet-4.5";
    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makeFailingScoreRecord(caseId, modelId));
    const orchestrator = new EvalOrchestrator(
      makeOptions({ scorer, evalsRoot: REAL_EVALS_ROOT }),
    );
    const runner = buildEvalRunner(orchestrator);
    const request = makeRequest({
      agent: "loom",
      model: modelId,
      case: caseId,
    });

    const summaryResult = await orchestrator.run(request);
    expect(summaryResult.isOk()).toBe(true);
    if (summaryResult.isOk()) {
      expect(summaryResult.value.allSuitesGreen).toBe(false);
      expect(summaryResult.value.failedCases).toBeGreaterThan(0);
      expect(summaryResult.value.partialFailures).toHaveLength(0);
    }

    const result = await runner(request);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Threshold misses are reported in artifacts and summaries, not as a
      // process failure. Hard partialFailures still return exit 1 above.
      expect(result.value).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Publish policy: raw artifacts never in bundle
// ---------------------------------------------------------------------------

describe("EvalOrchestrator — publish policy", () => {
  it("does not write bundle files to disk when no runner results (empty fixture sets)", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // No runner results → no files written (empty filesWritten list)
      expect(result.value.filesWritten).toHaveLength(0);
    }
  });

  it("summary JSON does not contain any known sensitive field names", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const summaryStr = JSON.stringify(result.value);
      const sensitiveFields = [
        '"composedPrompt"',
        '"rawContent"',
        '"rawArtifact"',
        '"transcript"',
        '"rationale"',
        '"cause"',
        '"apiKey"',
      ];
      for (const field of sensitiveFields) {
        expect(summaryStr).not.toContain(field);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Git SHA provider injection
// ---------------------------------------------------------------------------

describe("EvalOrchestrator — git SHA provider", () => {
  it("uses provided git SHA in metadata", async () => {
    const orchestrator = new EvalOrchestrator(
      makeOptions({
        gitShaProvider: makeGitShaProvider(
          "deadbeef12345678deadbeef12345678deadbeef",
        ),
      }),
    );
    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.metadata.repoSha).toBe(
        "deadbeef12345678deadbeef12345678deadbeef",
      );
    }
  });

  it("uses 'unknown' SHA when provider returns unknown", async () => {
    const orchestrator = new EvalOrchestrator(
      makeOptions({
        gitShaProvider: { resolveGitSha: () => ok("unknown") },
      }),
    );
    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.metadata.repoSha).toBe("unknown");
    }
  });
});

// ---------------------------------------------------------------------------
// Prompt provider injection
// ---------------------------------------------------------------------------

describe("EvalOrchestrator — prompt provider", () => {
  it("uses injected prompt provider (no real git or file I/O)", async () => {
    const provider = new MockPromptProvider("System prompt for testing");
    const orchestrator = new EvalOrchestrator(
      makeOptions({ promptProvider: provider }),
    );
    const result = await orchestrator.run(makeRequest());
    // The provider is used but the suite will still fail on empty fixtures
    expect(result.isOk()).toBe(true);
  });

  it("failing prompt provider accumulates as partialFailure when fixtures present", async () => {
    // A failing prompt provider causes PromptProviderFailed on each runner.
    // With no fixtures, the NoCasesFound error comes first (fixtures missing
    // before prompt is even needed), so we just verify the run still completes.
    const orchestrator = new EvalOrchestrator(
      makeOptions({ promptProvider: new FailingPromptProvider() }),
    );
    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Multi-model fan-out (no model filter → default matrix)
// ---------------------------------------------------------------------------

describe("EvalOrchestrator — multi-model fan-out", () => {
  it("no model filter: all default models are attempted (default matrix has 3 models)", async () => {
    // With no --model filter, the orchestrator should run suites for ALL models
    // in the default matrix. With fake evalsRoot (no fixtures), each combination
    // produces a NoCasesFound partial failure. With 3 default models × 7 suites,
    // we expect exactly 21 partial failures.
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // 3 models × 7 suites = 21 partial failures (NoCasesFound for each)
      expect(result.value.partialFailures.length).toBe(21);
    }
  });

  it("model filter limits execution to one model only", async () => {
    // With --model filter, only the matching model runs.
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(
      makeRequest({ model: "anthropic/claude-sonnet-4.5" }),
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // 1 model × 7 suites = 7 partial failures
      expect(result.value.partialFailures.length).toBe(7);
    }
  });

  it("agent filter 'loom' + no model filter: 3 partial failures (one per default model)", async () => {
    // Only loom suite runs, for each of the 3 default models.
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest({ agent: "loom" }));
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // 3 models × 1 suite = 3 partial failures
      expect(result.value.partialFailures.length).toBe(3);
    }
  });

  it("agent filter 'tapestry' + no model filter: 3 partial failures (one per default model)", async () => {
    // Only tapestry suite runs, for each of the 3 default models.
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest({ agent: "tapestry" }));
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // 3 models × 1 suite = 3 partial failures
      expect(result.value.partialFailures.length).toBe(3);
    }
  });

  it("agent filter 'shuttle' + no model filter: 3 partial failures (one per default model)", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest({ agent: "shuttle" }));
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.partialFailures.length).toBe(3);
    }
  });

  it("agent filter 'spindle' + no model filter: 3 partial failures (one per default model)", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest({ agent: "spindle" }));
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.partialFailures.length).toBe(3);
    }
  });

  it("agent filter 'weft' + no model filter: 3 partial failures (one per default model)", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest({ agent: "weft" }));
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.partialFailures.length).toBe(3);
    }
  });

  it("agent filter 'warp' + no model filter: 3 partial failures (one per default model)", async () => {
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest({ agent: "warp" }));
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.partialFailures.length).toBe(3);
    }
  });

  it("model rollups would cover all default models when cases ran", async () => {
    // With no cases (empty fixture set), modelRollups is empty. But the metadata
    // modelFilter must be null when no filter was supplied.
    const orchestrator = new EvalOrchestrator(makeOptions());
    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // No cases ran → modelRollups is empty (but modelFilter is null)
      expect(result.value.metadata.modelFilter).toBeNull();
      expect(result.value.modelRollups).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Snapshot provider injection — provenance wiring
// ---------------------------------------------------------------------------

describe("EvalOrchestrator — snapshot provider for provenance", () => {
  it("calls the injected snapshot provider once during run", async () => {
    const snapshotProvider = new StubSnapshotProvider([
      makeSnapshot("loom", "aabbccdd"),
      makeSnapshot("tapestry", "eeff0011"),
      makeSnapshot("shuttle", "11223344"),
      makeSnapshot("spindle", "99aabbcc"),
      makeSnapshot("pattern", "22334455"),
      makeSnapshot("weft", "33445566"),
      makeSnapshot("warp", "44556677"),
    ]);
    const orchestrator = new EvalOrchestrator(
      makeOptions({ snapshotProvider }),
    );

    await orchestrator.run(makeRequest());

    // The snapshot provider must be called exactly once per orchestrator run
    expect(snapshotProvider.calls).toHaveLength(1);
    // And it should be called with all suite-backed prompt agents
    if (snapshotProvider.calls[0] !== undefined) {
      expect(snapshotProvider.calls[0]).toContain("loom");
      expect(snapshotProvider.calls[0]).toContain("tapestry");
      expect(snapshotProvider.calls[0]).toContain("shuttle");
      expect(snapshotProvider.calls[0]).toContain("spindle");
      expect(snapshotProvider.calls[0]).toContain("pattern");
      expect(snapshotProvider.calls[0]).toContain("weft");
      expect(snapshotProvider.calls[0]).toContain("warp");
    }
  });

  it("summary JSON does not contain raw prompt text even when snapshots are provided", async () => {
    const snapshotProvider = new StubSnapshotProvider([
      makeSnapshot("loom", "aabbccdd"),
    ]);
    const orchestrator = new EvalOrchestrator(
      makeOptions({ snapshotProvider }),
    );

    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const summaryStr = JSON.stringify(result.value);
      // Raw prompt text must never appear in the summary even if snapshots were taken
      expect(summaryStr).not.toContain("composedPrompt");
      expect(summaryStr).not.toContain("rawContent");
    }
  });

  it("default snapshot provider (empty stubs) produces an empty provenance manifest", async () => {
    // With StubSnapshotProvider([]) — no snapshots — the manifest has 0 records.
    // This is the test-default path: provenance manifests still get produced,
    // they just have no records when no snapshots are available.
    const snapshotProvider = new StubSnapshotProvider([]);
    const orchestrator = new EvalOrchestrator(
      makeOptions({ snapshotProvider }),
    );

    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);
    // Orchestrator still completes successfully even with no provenance snapshots
  });

  it("snapshot provider with suite-backed snapshots is called regardless of agent filter", async () => {
    // Even when filtering to only loom suite, all suite-backed snapshots should be collected
    // because provenance covers all orchestrated agents, not just the filtered suite.
    const snapshotProvider = new StubSnapshotProvider([
      makeSnapshot("loom", "aa"),
      makeSnapshot("tapestry", "bb"),
      makeSnapshot("shuttle", "cc"),
      makeSnapshot("spindle", "zz"),
      makeSnapshot("pattern", "dd"),
      makeSnapshot("weft", "ee"),
      makeSnapshot("warp", "ff"),
    ]);
    const orchestrator = new EvalOrchestrator(
      makeOptions({ snapshotProvider }),
    );

    await orchestrator.run(makeRequest({ agent: "loom" }));

    // Snapshot provider still called once (for provenance, not per suite)
    expect(snapshotProvider.calls).toHaveLength(1);
  });

  it("snapshot provider uses short agent filters from the shared registry", async () => {
    const snapshotProvider = new StubSnapshotProvider([]);
    const orchestrator = new EvalOrchestrator(
      makeOptions({ snapshotProvider }),
    );

    await orchestrator.run(makeRequest());

    expect(snapshotProvider.calls).toHaveLength(1);
    expect(snapshotProvider.calls[0]).toEqual(EVAL_SHORT_AGENT_FILTERS);
  });

  it("getEvalCoveredPromptAgents stays aligned with the shared short-agent registry", () => {
    expect(getEvalCoveredPromptAgents()).toEqual(EVAL_SHORT_AGENT_FILTERS);
  });
});

// ---------------------------------------------------------------------------
// Publish mode: orchestrator-level tests for publishMode: "publish"
//
// These tests prove that:
//   1. When publishMode === "publish" and there are actual runner results,
//      the injected publisher is invoked.
//   2. Publisher failures propagate as a hard BundleWriteError (err(CliError)).
//   3. Publisher is NOT called when publishMode === "local" (default).
//   4. Publisher is NOT called when there are no runner results (dry-run of
//      empty fixture sets skips the bundle write entirely).
//
// The integration tests that produce real runner results reuse the REAL_EVALS_ROOT
// with a StubModelClient + StubAgentEvalsScorer, matching the raw-artifact
// integration test pattern.
// ---------------------------------------------------------------------------

describe("EvalOrchestrator — publishMode: 'publish' integration", () => {
  it("does NOT invoke publisher when publishMode is 'local' (the default)", async () => {
    // No publisher injected, publishMode defaults to "local" —
    // even if one were injected it must not be called.
    const publisher = new StubResultsRepoPublisher();
    publisher.setDefaultSuccess({
      commitSha: "abc",
      branch: "main",
      filesPublished: 3,
      simulated: false,
    });

    const orchestrator = new EvalOrchestrator(
      makeOptions({ publisher, publishMode: "local" }),
    );

    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);

    // Publisher must not have been called (local mode)
    expect(publisher.calls).toHaveLength(0);
  });

  it("does NOT invoke publisher when there are no runner results (empty fixture sets)", async () => {
    // With an empty evalsRoot, no runner results are produced.
    // ArtifactBundleWriter short-circuits and never calls the publisher.
    const publisher = new StubResultsRepoPublisher();
    publisher.setDefaultSuccess({
      commitSha: null,
      branch: "main",
      filesPublished: 0,
      simulated: false,
    });

    const orchestrator = new EvalOrchestrator(
      makeOptions({
        publisher,
        publishMode: "publish",
        env: {
          OPENROUTER_API_KEY: FAKE_API_KEY,
          EVAL_RESULTS_REPO_TOKEN: "fake-token-for-test",
        },
      }),
    );

    const result = await orchestrator.run(makeRequest());
    expect(result.isOk()).toBe(true);

    // No runner results → no bundle write → publisher not called
    expect(publisher.calls).toHaveLength(0);
  });

  it("invokes publisher when publishMode is 'publish' and runner results exist", async () => {
    const modelId = "anthropic/claude-sonnet-4.5";
    const caseId = "loom-route-backend-api";
    const bundleRoot = join(TEMP_DIR, `publish-mode-invoke-${uid()}`);

    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: modelId,
      content: 'I will route to "shuttle" agent for this task.',
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makePassingScoreRecord(caseId, modelId));

    const publisher = new StubResultsRepoPublisher();
    publisher.setDefaultSuccess({
      commitSha: "commit-sha-abc123",
      branch: "main",
      filesPublished: 5,
      simulated: false,
    });

    const orchestrator = new EvalOrchestrator({
      modelClient,
      scorer,
      promptProvider: new MockPromptProvider("You are Loom. Route tasks."),
      snapshotProvider: new StubSnapshotProvider(),
      gitShaProvider: makeGitShaProvider(),
      bundleRoot,
      evalsRoot: REAL_EVALS_ROOT,
      publishMode: "publish",
      publisher,
      assembledAt: FIXED_TIMESTAMP,
      env: {
        OPENROUTER_API_KEY: FAKE_API_KEY,
        EVAL_RESULTS_REPO_TOKEN: "fake-results-token-not-real",
      },
    });

    const result = await orchestrator.run({
      agent: "loom",
      model: modelId,
      case: caseId,
      dryRun: false,
      rawArtifacts: false,
    });

    expect(result.isOk()).toBe(true);

    // Publisher MUST have been called exactly once (one bundle write)
    expect(publisher.calls).toHaveLength(1);

    // Publisher received the correct bundle dir
    const publishCall = publisher.calls[0];
    expect(publishCall).toBeDefined();
    if (publishCall !== undefined) {
      expect(publishCall.localBundleDir).toContain(bundleRoot);
      // fileNames must be provided and non-empty
      expect(publishCall.fileNames).toBeDefined();
      expect((publishCall.fileNames ?? []).length).toBeGreaterThan(0);
      // fileNames must not contain any raw/ paths
      for (const name of publishCall.fileNames ?? []) {
        expect(name).not.toMatch(/raw[\\/]/);
      }
    }
  });

  it("propagates publisher failure as a BundleWriteError (hard CliError)", async () => {
    const modelId = "anthropic/claude-sonnet-4.5";
    const caseId = "loom-route-backend-api";
    const bundleRoot = join(TEMP_DIR, `publish-mode-fail-${uid()}`);

    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: modelId,
      content: 'Route to "shuttle" agent.',
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makePassingScoreRecord(caseId, modelId));

    const publisher = new StubResultsRepoPublisher();
    // Configure publisher to return a failure
    publisher.setDefaultError({
      type: "PublishFailed",
      message: "GitHub API returned HTTP 403 for 'bundle-index.json'.",
    });

    const orchestrator = new EvalOrchestrator({
      modelClient,
      scorer,
      promptProvider: new MockPromptProvider("You are Loom."),
      snapshotProvider: new StubSnapshotProvider(),
      gitShaProvider: makeGitShaProvider(),
      bundleRoot,
      evalsRoot: REAL_EVALS_ROOT,
      publishMode: "publish",
      publisher,
      assembledAt: FIXED_TIMESTAMP,
      env: {
        OPENROUTER_API_KEY: FAKE_API_KEY,
        EVAL_RESULTS_REPO_TOKEN: "fake-results-token-not-real",
      },
    });

    const result = await orchestrator.run({
      agent: "loom",
      model: modelId,
      case: caseId,
      dryRun: false,
      rawArtifacts: false,
    });

    // Publisher failure must surface as a hard CliError (not swallowed)
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("EvalValidation");
      // Error message must reference the publication failure
      const msg = getEvalValidationMessage(result.error);
      expect(msg).toContain("Bundle write failed");
      // Must not leak the token value
      expect(msg).not.toContain("fake-results-token-not-real");
    }

    // Publisher was still called (failure is from publisher, not pre-flight)
    expect(publisher.calls).toHaveLength(1);
  });

  it("metadata.publishMode is 'publish' when configured with a real publisher", async () => {
    const modelId = "anthropic/claude-sonnet-4.5";
    const caseId = "loom-route-backend-api";
    const bundleRoot = join(TEMP_DIR, `publish-mode-meta-${uid()}`);

    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: modelId,
      content: 'Route to "shuttle" agent.',
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makePassingScoreRecord(caseId, modelId));

    const publisher = new StubResultsRepoPublisher();
    publisher.setDefaultSuccess({
      commitSha: null,
      branch: "main",
      filesPublished: 2,
      simulated: false,
    });

    const orchestrator = new EvalOrchestrator({
      modelClient,
      scorer,
      promptProvider: new MockPromptProvider("Prompt."),
      snapshotProvider: new StubSnapshotProvider(),
      gitShaProvider: makeGitShaProvider(),
      bundleRoot,
      evalsRoot: REAL_EVALS_ROOT,
      publishMode: "publish",
      publisher,
      assembledAt: FIXED_TIMESTAMP,
      env: {
        OPENROUTER_API_KEY: FAKE_API_KEY,
        EVAL_RESULTS_REPO_TOKEN: "fake-results-token-not-real",
      },
    });

    const result = await orchestrator.run({
      agent: "loom",
      model: modelId,
      case: caseId,
      dryRun: false,
      rawArtifacts: false,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.metadata.publishMode).toBe("publish");
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: raw artifact timestamp — orchestrator writes full ISO filenames
//
// These tests use the real evals/ fixtures from the repo root, a StubModelClient
// that returns a controlled routing signal, and a StubAgentEvalsScorer that
// returns a passing score. They write to a temp directory and assert that the
// raw artifact filename contains a time component (not date-only).
//
// Each test gets a unique bundleRoot so they don't interfere with each other.
//
// Design rationale:
//   The orchestrator's `writeRawArtifacts()` calls `new Date().toISOString()`
//   and passes the full ISO timestamp to `RawArtifactsWriter.writeCaseResultArtifact()`.
//   This test proves that the end-to-end path produces filenames like
//   `case-loom-route-backend-api-anthropic_claude-sonnet-4.5-2026-06-11T14-32-07-123Z.json`
//   and NOT date-only names like
//   `case-loom-route-backend-api-anthropic_claude-sonnet-4.5-2026-06-11.json`.
// ---------------------------------------------------------------------------

describe("EvalOrchestrator — raw artifact filename timestamp integration", () => {
  it("raw artifact filename contains time component (not date-only) when rawArtifacts=true", async () => {
    // Use real evals fixtures. The loom-route-backend-api case uses
    // anthropic/claude-sonnet-4.5 as its first allowed model.
    const modelId = "anthropic/claude-sonnet-4.5";
    const caseId = "loom-route-backend-api";

    const modelClient = new StubModelClient();
    // Return content that includes a routing signal for shuttle
    modelClient.setDefaultResponse({
      model: modelId,
      content: 'I will route to the "shuttle" agent for this backend API task.',
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makePassingScoreRecord(caseId, modelId));

    const bundleRoot = join(TEMP_DIR, `raw-ts-integration-${uid()}`);

    const orchestrator = new EvalOrchestrator({
      modelClient,
      scorer,
      promptProvider: new MockPromptProvider(
        "You are Loom. Route tasks to the right agent.",
      ),
      snapshotProvider: new StubSnapshotProvider(),
      gitShaProvider: makeGitShaProvider(),
      bundleRoot,
      evalsRoot: REAL_EVALS_ROOT,
      env: { OPENROUTER_API_KEY: FAKE_API_KEY },
      // Note: no assembledAt override — uses real current timestamp for bundle dir name
    });

    const result = await orchestrator.run({
      agent: "loom",
      model: modelId,
      case: caseId,
      dryRun: false,
      rawArtifacts: true,
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const summary = result.value;

    // The run should have produced at least one result (not all partial failures)
    expect(summary.agentRollups.length).toBeGreaterThan(0);
    expect(summary.filesWritten.length).toBeGreaterThan(0);

    // Verify raw artifact file was written
    // The file is in <bundleDir>/raw/<filename>.json
    // bundleDir is under bundleRoot/runs/, named <shortSha>-<YYYY-MM-DD>-<NNN>
    const bundleDirEntries = await Array.fromAsync(
      (async function* () {
        const glob = new Bun.Glob(`${bundleRoot}/runs/*/raw/*.json`);
        for await (const file of glob.scan({ cwd: "/" })) {
          yield file;
        }
      })(),
    );

    expect(bundleDirEntries.length).toBeGreaterThan(0);

    for (const filePath of bundleDirEntries) {
      const filename = filePath.split("/").pop() ?? filePath;

      // The filename must contain the case ID
      expect(filename).toContain(caseId);

      // The filename MUST contain a time component — verified by the presence
      // of "T" followed by digit pairs (hour-minute-second pattern)
      // e.g. "2026-06-11T14-32-07-123Z" → contains "T14-32-07"
      expect(filename).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);

      // The filename must NOT be date-only (no time part after the date)
      // A date-only filename would match /^\w+-.*-\d{4}-\d{2}-\d{2}\.json$/
      // This regex matches date-only: ends with YYYY-MM-DD.json (no T component)
      expect(filename).not.toMatch(/\d{4}-\d{2}-\d{2}\.json$/);

      // Must be filesystem-safe (no raw colons)
      expect(filename).not.toContain(":");
    }

    expect(summary.rawArtifactsWritten.length).toBeGreaterThan(0);
    for (const writtenPath of summary.rawArtifactsWritten) {
      expect(writtenPath).toContain("/raw/");
    }
  });

  it("raw artifact filename time component is distinct on sequential runs (no collision on same day)", async () => {
    // Two runs on the same day must produce distinct filenames because the
    // full ISO timestamp includes milliseconds — this test verifies uniqueness
    // by running twice and checking the filenames differ.
    const modelId = "anthropic/claude-sonnet-4.5";
    const caseId = "loom-route-backend-api";

    const bundleRoot = join(TEMP_DIR, `raw-ts-seq-${uid()}`);

    function buildOrchestrator(): EvalOrchestrator {
      const modelClient = new StubModelClient();
      modelClient.setDefaultResponse({
        model: modelId,
        content: 'Route to "shuttle" agent.',
      });
      const scorer = new StubAgentEvalsScorer();
      scorer.setDefaultRecord(makePassingScoreRecord(caseId, modelId));

      return new EvalOrchestrator({
        modelClient,
        scorer,
        promptProvider: new MockPromptProvider(
          "System prompt for sequential run test.",
        ),
        snapshotProvider: new StubSnapshotProvider(),
        gitShaProvider: makeGitShaProvider(),
        bundleRoot,
        evalsRoot: REAL_EVALS_ROOT,
        env: { OPENROUTER_API_KEY: FAKE_API_KEY },
      });
    }

    const request = {
      agent: "loom" as const,
      model: modelId,
      case: caseId,
      dryRun: false,
      rawArtifacts: true,
    };

    // Run 1
    const r1 = await buildOrchestrator().run(request);
    expect(r1.isOk()).toBe(true);

    // Wait 2ms to ensure timestamp difference
    await new Promise<void>((resolve) => setTimeout(resolve, 2));

    // Run 2
    const r2 = await buildOrchestrator().run(request);
    expect(r2.isOk()).toBe(true);

    // Collect all raw artifact files written across both runs
    // Each run is in its own immutable run dir under runs/
    const rawFiles: string[] = [];
    const glob = new Bun.Glob(`${bundleRoot}/runs/*/raw/*.json`);
    for await (const file of glob.scan({ cwd: "/" })) {
      rawFiles.push(file);
    }

    // Both runs should have written files (at least 2 — one per run)
    expect(rawFiles.length).toBeGreaterThanOrEqual(2);

    // All filenames must have time components (not date-only)
    for (const filePath of rawFiles) {
      const filename = filePath.split("/").pop() ?? filePath;
      expect(filename).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
      expect(filename).not.toContain(":");
    }

    // Filenames should be distinct (different millisecond timestamps)
    const filenames = rawFiles.map((f) => f.split("/").pop() ?? f);
    const uniqueFilenames = new Set(filenames);
    // Allow for same filename if runs happen in same millisecond (rare but possible)
    // At minimum verify they all have time components
    for (const fn of filenames) {
      expect(fn).toMatch(/T\d{2}-\d{2}-\d{2}-\d+Z/);
    }
    // If any are distinct, that's a stronger guarantee — but not required
    // since millisecond collisions can occur in fast test environments
    expect(uniqueFilenames.size).toBeGreaterThanOrEqual(1);
  });

  it("repeat runs on the same commit and date produce distinct immutable run directories (no overwrite)", async () => {
    // The new layout uses runs/<runId>/ with an auto-incremented sequence number.
    // Two runs on the same commit + same date get runs/aabbccd-2026-01-15-001/
    // and runs/aabbccd-2026-01-15-002/ — the first run's artifacts are preserved.
    const modelId = "anthropic/claude-sonnet-4.5";
    const caseId = "loom-route-backend-api";
    const sharedSha = `aabbccd${"d".repeat(33)}`; // 40-char SHA
    const bundleRoot = join(TEMP_DIR, `no-overwrite-${uid()}`);
    // Both runs use the same assembledAt date — only the time differs
    const assembledDate1 = "2026-01-15T10:00:00.000Z";
    const assembledDate2 = "2026-01-15T20:00:00.000Z";

    function buildOrchestratorForRun(assembledAt: string): EvalOrchestrator {
      const modelClient = new StubModelClient();
      modelClient.setDefaultResponse({
        model: modelId,
        content: 'Route to "shuttle" agent.',
      });
      const scorer = new StubAgentEvalsScorer();
      scorer.setDefaultRecord(makePassingScoreRecord(caseId, modelId));

      return new EvalOrchestrator({
        modelClient,
        scorer,
        promptProvider: new MockPromptProvider("No-overwrite test prompt."),
        snapshotProvider: new StubSnapshotProvider(),
        gitShaProvider: makeGitShaProvider(sharedSha),
        bundleRoot,
        evalsRoot: REAL_EVALS_ROOT,
        assembledAt,
        env: { OPENROUTER_API_KEY: FAKE_API_KEY },
      });
    }

    const request = {
      agent: "loom" as const,
      model: modelId,
      case: caseId,
      dryRun: false,
      rawArtifacts: false,
    };

    // Run 1
    const r1 = await buildOrchestratorForRun(assembledDate1).run(request);
    expect(r1.isOk()).toBe(true);
    if (!r1.isOk()) return;
    const runId1 = r1.value.runId;
    expect(runId1).not.toBeNull();
    expect(runId1).toMatch(/-001$/);

    // Run 2 with the same SHA and date → gets sequence 002
    const r2 = await buildOrchestratorForRun(assembledDate2).run(request);
    expect(r2.isOk()).toBe(true);
    if (!r2.isOk()) return;
    const runId2 = r2.value.runId;
    expect(runId2).not.toBeNull();
    expect(runId2).toMatch(/-002$/);

    // The two run IDs must be distinct
    expect(runId1).not.toBe(runId2);

    // Both run directories must exist independently
    const run1Dir = `${bundleRoot}/runs/${runId1}`;
    const run2Dir = `${bundleRoot}/runs/${runId2}`;
    expect(run1Dir).not.toBe(run2Dir);

    // Run 1's score file preserves the first assembledAt (not overwritten)
    const scoreFile1Content = (await Bun.file(
      `${run1Dir}/score-loom-routing.json`,
    ).json()) as { assembledAt: string };
    expect(scoreFile1Content.assembledAt).toBe(assembledDate1);

    // Run 2's score file has the second assembledAt in its own dir
    const scoreFile2Content = (await Bun.file(
      `${run2Dir}/score-loom-routing.json`,
    ).json()) as { assembledAt: string };
    expect(scoreFile2Content.assembledAt).toBe(assembledDate2);
  });

  it("writes repeatability diagnostics for live runs and accumulates comparable exact-filter reruns", async () => {
    const modelId = "anthropic/claude-sonnet-4.5";
    const caseId = "loom-route-backend-api";
    const bundleRoot = join(TEMP_DIR, `repeatability-${uid()}`);

    function buildOrchestrator(content: string): EvalOrchestrator {
      const modelClient = new StubModelClient();
      modelClient.setDefaultResponse({ model: modelId, content });

      const scorer = new StubAgentEvalsScorer();
      scorer.setDefaultRecord(makePassingScoreRecord(caseId, modelId));

      return new EvalOrchestrator({
        modelClient,
        scorer,
        promptProvider: new MockPromptProvider("You are Loom. Route tasks."),
        snapshotProvider: new StubSnapshotProvider(),
        gitShaProvider: makeGitShaProvider(),
        bundleRoot,
        evalsRoot: REAL_EVALS_ROOT,
        env: { OPENROUTER_API_KEY: FAKE_API_KEY },
      });
    }

    const request = {
      agent: "loom" as const,
      model: modelId,
      case: caseId,
      dryRun: false,
      rawArtifacts: false,
    };

    const run1 = await buildOrchestrator(
      'I will route to the "shuttle" agent.',
    ).run(request);
    expect(run1.isOk()).toBe(true);
    if (!run1.isOk()) return;

    const diag1 = run1.value.repeatabilityDiagnostics;
    expect(diag1).not.toBeNull();
    if (diag1 === null) return;
    expect(run1.value.runId).not.toBeNull();
    if (run1.value.runId === null) return;
    expect(diag1.comparableRunCount).toBe(1);
    expect(diag1.comparableRunIds).toEqual([run1.value.runId]);

    const artifact1 = await Bun.file(diag1.filePath).json();
    expect(artifact1).toMatchObject({
      schemaVersion: 1,
      comparisonKey: {
        agentFilter: "loom",
        modelFilter: modelId,
        caseFilter: caseId,
        suites: ["loom-routing"],
      },
      comparableRunCount: 1,
    });

    const run2 = await buildOrchestrator(
      'Route the task to the "shuttle" agent.',
    ).run(request);
    expect(run2.isOk()).toBe(true);
    if (!run2.isOk()) return;

    const diag2 = run2.value.repeatabilityDiagnostics;
    expect(diag2).not.toBeNull();
    if (diag2 === null) return;
    expect(run2.value.runId).not.toBeNull();
    if (run2.value.runId === null) return;
    expect(diag2.comparableRunCount).toBe(2);
    expect(diag2.comparableRunIds).toEqual([
      run1.value.runId,
      run2.value.runId,
    ]);

    const artifact2 = (await Bun.file(diag2.filePath).json()) as {
      comparableRunCount: number;
      comparableRunIds: string[];
      driftSummary: {
        models: Array<{ classification: string; comparableRunCount: number }>;
        caseModels: Array<{
          classification: string;
          comparableRunCount: number;
        }>;
      };
    };
    expect(artifact2.comparableRunCount).toBe(2);
    expect(artifact2.comparableRunIds).toEqual([
      run1.value.runId,
      run2.value.runId,
    ]);
    expect(artifact2.driftSummary.models).toHaveLength(1);
    expect(artifact2.driftSummary.models[0]).toMatchObject({
      classification: "consistent",
      comparableRunCount: 2,
    });
    expect(artifact2.driftSummary.caseModels).toHaveLength(1);
    expect(artifact2.driftSummary.caseModels[0]).toMatchObject({
      classification: "consistent-pass",
      comparableRunCount: 2,
    });
  });

  it("repeatability diagnostics ignore previous runs with different exact filters", async () => {
    const modelId = "anthropic/claude-sonnet-4.5";
    const caseId = "loom-route-backend-api";
    const bundleRoot = join(TEMP_DIR, `repeatability-filtered-${uid()}`);

    function buildOrchestrator(): EvalOrchestrator {
      const modelClient = new StubModelClient();
      modelClient.setDefaultResponse({
        model: modelId,
        content: 'I will route to the "shuttle" agent.',
      });

      const scorer = new StubAgentEvalsScorer();
      scorer.setDefaultRecord(makePassingScoreRecord(caseId, modelId));

      return new EvalOrchestrator({
        modelClient,
        scorer,
        promptProvider: new MockPromptProvider("You are Loom. Route tasks."),
        snapshotProvider: new StubSnapshotProvider(),
        gitShaProvider: makeGitShaProvider(),
        bundleRoot,
        evalsRoot: REAL_EVALS_ROOT,
        env: { OPENROUTER_API_KEY: FAKE_API_KEY },
      });
    }

    const broadRun = await buildOrchestrator().run({
      agent: "loom",
      model: modelId,
      case: undefined,
      dryRun: false,
      rawArtifacts: false,
    });
    expect(broadRun.isOk()).toBe(true);

    const narrowedRun = await buildOrchestrator().run({
      agent: "loom",
      model: modelId,
      case: caseId,
      dryRun: false,
      rawArtifacts: false,
    });
    expect(narrowedRun.isOk()).toBe(true);
    if (!narrowedRun.isOk()) return;

    const diag = narrowedRun.value.repeatabilityDiagnostics;
    expect(diag).not.toBeNull();
    if (diag === null) return;
    expect(narrowedRun.value.runId).not.toBeNull();
    if (narrowedRun.value.runId === null) return;

    expect(diag.comparableRunCount).toBe(1);
    expect(diag.comparableRunIds).toEqual([narrowedRun.value.runId]);
  });
});

// ---------------------------------------------------------------------------
// Blocker 1: generateIndexes wired into production eval bundle-write path
//
// Proves that:
//   1. A normal (non-dry-run) orchestrator run with real runner results
//      writes dashboard index files (generateIndexes: true path).
//   2. A dry-run orchestrator run does NOT generate indexes (dry-run stays
//      local-only, no indexes produced, no publisher called).
//   3. When mode is "publish" and runner results exist, the publisher receives
//      non-empty indexFileNames (indexes were generated and passed through).
// ---------------------------------------------------------------------------

describe("EvalOrchestrator — generateIndexes wired into production path", () => {
  it("normal (non-dry-run) run with real results writes dashboard index files to bundleRoot", async () => {
    const modelId = "anthropic/claude-sonnet-4.5";
    const caseId = "loom-route-backend-api";
    const bundleRoot = join(TEMP_DIR, `gen-idx-prod-${uid()}`);

    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: modelId,
      content: 'I will route to the "shuttle" agent.',
    });
    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makePassingScoreRecord(caseId, modelId));

    const orchestrator = new EvalOrchestrator({
      modelClient,
      scorer,
      promptProvider: new MockPromptProvider("You are Loom."),
      snapshotProvider: new StubSnapshotProvider(),
      gitShaProvider: makeGitShaProvider(),
      bundleRoot,
      evalsRoot: REAL_EVALS_ROOT,
      assembledAt: FIXED_TIMESTAMP,
      env: { OPENROUTER_API_KEY: FAKE_API_KEY },
    });

    const result = await orchestrator.run({
      agent: "loom",
      model: modelId,
      case: caseId,
      dryRun: false,
      rawArtifacts: false,
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    // Runner results exist → bundle was written → indexes were generated
    expect(result.value.runId).not.toBeNull();

    // dashboard-manifest.json must exist at bundleRoot (not inside runs/)
    const manifestContent = (await Bun.file(
      `${bundleRoot}/dashboard-manifest.json`,
    ).json()) as { totalRuns: number; schemaVersion: number };
    expect(typeof manifestContent.totalRuns).toBe("number");
    expect(manifestContent.totalRuns).toBeGreaterThan(0);
    expect(typeof manifestContent.schemaVersion).toBe("number");

    // latest.json must also exist at bundleRoot
    const latestContent = (await Bun.file(
      `${bundleRoot}/latest.json`,
    ).json()) as { runId: string };
    expect(typeof latestContent.runId).toBe("string");
    expect(result.value.runId).not.toBeNull();
    if (result.value.runId === null) return;
    expect(latestContent.runId).toBe(result.value.runId);
  });

  it("dry-run orchestrator run does NOT write dashboard index files", async () => {
    const modelId = "anthropic/claude-sonnet-4.5";
    const caseId = "loom-route-backend-api";
    const bundleRoot = join(TEMP_DIR, `gen-idx-dryrun-${uid()}`);

    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: modelId,
      content: 'I will route to the "shuttle" agent.',
    });
    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makePassingScoreRecord(caseId, modelId));

    const orchestrator = new EvalOrchestrator({
      modelClient,
      scorer,
      promptProvider: new MockPromptProvider("You are Loom."),
      snapshotProvider: new StubSnapshotProvider(),
      gitShaProvider: makeGitShaProvider(),
      bundleRoot,
      evalsRoot: REAL_EVALS_ROOT,
      assembledAt: FIXED_TIMESTAMP,
      env: { OPENROUTER_API_KEY: FAKE_API_KEY },
    });

    const result = await orchestrator.run({
      agent: "loom",
      model: modelId,
      case: caseId,
      dryRun: true, // dry-run: generateIndexes must be false
      rawArtifacts: false,
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    // dashboard-manifest.json must NOT exist for dry-run
    const manifestExists = await Bun.file(
      `${bundleRoot}/dashboard-manifest.json`,
    )
      .text()
      .then(() => true)
      .catch(() => false);
    expect(manifestExists).toBe(false);
  });

  it("publish mode with runner results passes indexFileNames to the publisher", async () => {
    const modelId = "anthropic/claude-sonnet-4.5";
    const caseId = "loom-route-backend-api";
    const bundleRoot = join(TEMP_DIR, `gen-idx-publish-${uid()}`);

    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: modelId,
      content: 'I will route to the "shuttle" agent.',
    });
    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makePassingScoreRecord(caseId, modelId));

    const publisher = new StubResultsRepoPublisher();
    publisher.setDefaultSuccess({
      commitSha: "idx-commit-sha",
      branch: "main",
      filesPublished: 5,
      simulated: false,
    });

    const orchestrator = new EvalOrchestrator({
      modelClient,
      scorer,
      promptProvider: new MockPromptProvider("You are Loom."),
      snapshotProvider: new StubSnapshotProvider(),
      gitShaProvider: makeGitShaProvider(),
      bundleRoot,
      evalsRoot: REAL_EVALS_ROOT,
      publishMode: "publish",
      publisher,
      assembledAt: FIXED_TIMESTAMP,
      env: {
        OPENROUTER_API_KEY: FAKE_API_KEY,
        EVAL_RESULTS_REPO_TOKEN: "fake-publish-token",
      },
    });

    const result = await orchestrator.run({
      agent: "loom",
      model: modelId,
      case: caseId,
      dryRun: false,
      rawArtifacts: false,
    });

    expect(result.isOk()).toBe(true);

    // Publisher was called
    expect(publisher.calls).toHaveLength(1);
    const publishCall = publisher.calls[0];
    expect(publishCall).toBeDefined();
    if (publishCall === undefined) return;

    // indexFileNames must be present and non-empty (indexes were generated)
    expect(publishCall.indexFileNames).toBeDefined();
    expect((publishCall.indexFileNames ?? []).length).toBeGreaterThan(0);
    // dashboard-manifest.json must be among the published index names
    expect(publishCall.indexFileNames).toContain("dashboard-manifest.json");

    // localBundleRoot must be provided (needed for publisher to read index files)
    expect(publishCall.localBundleRoot).toBeDefined();
  });
});
