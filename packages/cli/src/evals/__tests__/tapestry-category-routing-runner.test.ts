/**
 * What is left of `tapestry-category-routing-runner.ts`'s unit tests.
 *
 * How an answer is read as a category route, what each route scores, and
 * everything a run publishes moved to
 * [`tests/evals/suite-runners.scenario.test.ts`](../../../../../tests/evals/suite-runners.scenario.test.ts),
 * which drives the real runner through `EvalOrchestrator`.
 *
 * What stays cannot be reached from a `weave eval run`:
 *
 * - **`scoreExecutionCompleteness()`** is the local heuristic used when no
 *   scorer is injected. The orchestrator always injects one, so these path
 *   forms — Unix, Windows absolute, Windows relative, a bare filename — never
 *   reach a published score.
 * - **"without scorer, required case passes on routing gate alone"** is the
 *   same unreachable branch at runner level.
 * - **"locally computed routingCorrectness overrides scorer's routing score"**
 *   needs a scorer that returns a routing score at all; the real scorer
 *   computes that dimension itself and never disagrees with it.
 * - **The qualitative gate** case builds a score record with all three
 *   qualitative dimensions applicable and low. The real scorer cannot produce
 *   that for an `agent_routing` case — it marks two of them inapplicable at
 *   1.0 — so the gate this pins is a contract for a future scorer rather than
 *   current behaviour. The scenario file drives the gate the real scorer
 *   reaches, where only the applicable `rationaleQuality` counts.
 * - **The tcr-04/tcr-10 block** reads the repository's own fixtures from disk
 *   with the production `EVALS_ROOT`. A scenario brings its own corpus, so it
 *   cannot notice a real fixture drifting.
 */

import { describe, expect, it } from "bun:test";
import { ResultAsync } from "neverthrow";
import { StubAgentEvalsScorer } from "../langchain-agent-evals.js";
import { StubModelClient } from "../openrouter-client.js";
import { EXPLANATION_MAX_CHARS } from "../report-schema.js";
import {
  analyzeCategoryRouting,
  QUALITATIVE_PASS_THRESHOLD,
  scoreExecutionCompleteness,
  TapestryCategoryRoutingRunner,
  type TapestryCategoryRoutingRunnerOptions,
} from "../tapestry-category-routing-runner.js";
import type { EvalCase, EvalRubric, NormalizedScoreRecord } from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCategoryRoutingCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "route-to-shuttle-client-frontend",
    description: "Route a frontend UI task to the correct category shuttle",
    suite: "tapestry-category-routing",
    allowed_agents: ["tapestry", "shuttle-client-frontend"],
    allowed_models: ["anthropic/claude-sonnet-4.5"],
    expected_outcome: {
      kind: "agent_routing",
      target_agent: "shuttle-client-frontend",
      via: [],
    },
    accepted_alternates: [],
    transcript_expectations: [],
    tags: [],
    ...overrides,
  };
}

function makeEvalRubric(
  caseId = "route-to-shuttle-client-frontend",
): EvalRubric {
  return {
    case_id: caseId,
    suite: "tapestry-category-routing",
    scoring: {
      outcome_weight: 0.7,
      per_expectation_weight: 0.3,
      required: true,
    },
  };
}

// ---------------------------------------------------------------------------
// makeRunner — constructs the real TapestryCategoryRoutingRunner with injected
// in-memory loaders so the production run() pipeline is exercised without file I/O.
// ---------------------------------------------------------------------------

function makeRunner(
  options: Omit<
    TapestryCategoryRoutingRunnerOptions,
    "caseLoader" | "rubricLoader"
  >,
  cases: EvalCase[],
  rubrics: EvalRubric[],
): TapestryCategoryRoutingRunner {
  return new TapestryCategoryRoutingRunner({
    ...options,
    caseLoader: (_suite) =>
      ResultAsync.fromSafePromise(Promise.resolve([...cases])),
    rubricLoader: (_suite) =>
      ResultAsync.fromSafePromise(Promise.resolve([...rubrics])),
  });
}

// ---------------------------------------------------------------------------
// Unit tests — scoreExecutionCompleteness() path evidence
// ---------------------------------------------------------------------------

describe("scoreExecutionCompleteness path evidence", () => {
  function makeExactAnalysis() {
    return analyzeCategoryRouting(
      "→ shuttle-client-frontend",
      "shuttle-client-frontend",
      [],
    );
  }

  it("scores 1.0 for Unix forward-slash path (src/components/Button.tsx)", () => {
    const { score } = scoreExecutionCompleteness(
      "→ shuttle-client-frontend because src/components/Button.tsx is a React file",
      makeExactAnalysis(),
    );
    expect(score).toBe(1.0);
  });

  it("scores 1.0 for Windows absolute path (C:\\app\\screen.tsx)", () => {
    const { score } = scoreExecutionCompleteness(
      "→ shuttle-client-frontend for C:\\app\\screen.tsx",
      makeExactAnalysis(),
    );
    expect(score).toBe(1.0);
  });

  it("scores 1.0 for Windows relative backslash path (src\\components\\Button.tsx)", () => {
    const { score } = scoreExecutionCompleteness(
      "→ shuttle-client-frontend for src\\components\\Button.tsx",
      makeExactAnalysis(),
    );
    expect(score).toBe(1.0);
  });

  it("scores 1.0 for ordinary filename with extension (screen.tsx)", () => {
    const { score } = scoreExecutionCompleteness(
      "→ shuttle-client-frontend for screen.tsx",
      makeExactAnalysis(),
    );
    expect(score).toBe(1.0);
  });

  it("scores 0.5 when no path evidence at all", () => {
    // Use a routing decision with no domain keywords or file paths
    const noEvidenceAnalysis = analyzeCategoryRouting(
      "→ shuttle-ui",
      "shuttle-ui",
      [],
    );
    const { score } = scoreExecutionCompleteness(
      "→ shuttle-ui",
      noEvidenceAnalysis,
    );
    expect(score).toBe(0.5);
  });

  it("scores 0.0 for extraction-miss regardless of path content", () => {
    const missAnalysis = analyzeCategoryRouting(
      "No routing signal",
      "shuttle-client-frontend",
      [],
    );
    const { score } = scoreExecutionCompleteness(
      "No routing signal, but src/api/server.ts mentioned",
      missAnalysis,
    );
    expect(score).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// Scorer integration tests
// ---------------------------------------------------------------------------

/** Build a minimal NormalizedScoreRecord for StubAgentEvalsScorer responses. */
function makeScorerRecord(
  caseId: string,
  overrides: Partial<NormalizedScoreRecord> = {},
): NormalizedScoreRecord {
  return {
    caseId,
    modelId: "anthropic/claude-sonnet-4.5",
    suite: "tapestry-category-routing",
    dimensions: {
      routingCorrectness: {
        score: 1.0,
        rationale: "correct",
        applicable: true,
      },
      delegationCorrectness: {
        score: 0.9,
        rationale: "good rationale",
        applicable: true,
      },
      executionCompleteness: {
        score: 0.8,
        rationale: "path evidence present",
        applicable: true,
      },
      rationaleQuality: {
        score: 0.85,
        rationale: "appropriate choice",
        applicable: true,
      },
    },
    weightedTotal: 0.9,
    passed: true,
    required: true,
    scoredAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("TapestryCategoryRoutingRunner — scorer integration", () => {
  it("locally computed routingCorrectness overrides scorer's routing score", async () => {
    const evalCase = makeCategoryRoutingCase(); // expected: shuttle-client-frontend

    // Rubric has no transcript_expectations so qualitative gate doesn't apply
    const rubric = makeEvalRubric();

    const modelClient = new StubModelClient();
    // Model routes to WRONG category
    modelClient.enqueueResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "→ shuttle-backend",
    });

    const scorer = new StubAgentEvalsScorer();
    // Scorer returns routingCorrectness: 1.0 (wrong — we trust local computation)
    scorer.enqueueRecord(
      makeScorerRecord(evalCase.id, {
        dimensions: {
          routingCorrectness: {
            score: 1.0,
            rationale: "scorer says correct (wrong!)",
            applicable: true,
          },
          delegationCorrectness: {
            score: 0.9,
            rationale: "ok",
            applicable: true,
          },
          executionCompleteness: {
            score: 0.9,
            rationale: "ok",
            applicable: true,
          },
          rationaleQuality: { score: 0.9, rationale: "ok", applicable: true },
        },
        passed: true,
      }),
    );

    const runner = makeRunner(
      { modelClient, scorer, tapestrySystemPrompt: "You are Tapestry." },
      [evalCase],
      [rubric],
    );

    const result = await runner.run().match(
      (r) => r,
      (e) => {
        throw new Error(`Unexpected error: ${e.type}`);
      },
    );

    const summary = result.caseResults[0]?.summary;
    // Local computation: wrong category → 0.0
    expect(summary?.dimensionScores.routingCorrectness.score).toBe(0.0);
    // Required case with routingCorrectness 0.0 must fail, even if scorer said passed
    expect(summary?.passed).toBe(false);
  });

  it("qualitative gate enforced for required case with transcript_expectations when scorer present", async () => {
    // Case with transcript_expectations — should require qualitative avg >= 0.7
    const evalCase = makeCategoryRoutingCase({
      transcript_expectations: [
        { check: "agent_mentioned", agent_name: "shuttle-client-frontend" },
      ],
    });
    const rubric = makeEvalRubric();

    const modelClient = new StubModelClient();
    modelClient.enqueueResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "→ shuttle-client-frontend",
    });

    const scorer = new StubAgentEvalsScorer();
    // Routing is correct (1.0) but qualitative avg is below 0.7
    scorer.enqueueRecord(
      makeScorerRecord(evalCase.id, {
        dimensions: {
          routingCorrectness: {
            score: 1.0,
            rationale: "correct",
            applicable: true,
          },
          delegationCorrectness: {
            score: 0.4,
            rationale: "weak rationale",
            applicable: true,
          },
          executionCompleteness: {
            score: 0.5,
            rationale: "missing paths",
            applicable: true,
          },
          rationaleQuality: { score: 0.3, rationale: "poor", applicable: true },
        },
      }),
    );

    const runner = makeRunner(
      { modelClient, scorer, tapestrySystemPrompt: "You are Tapestry." },
      [evalCase],
      [rubric],
    );

    const result = await runner.run().match(
      (r) => r,
      (e) => {
        throw new Error(`Unexpected error: ${e.type}`);
      },
    );

    const summary = result.caseResults[0]?.summary;
    // routingCorrectness is 1.0 (passes routing gate)
    expect(summary?.dimensionScores.routingCorrectness.score).toBe(1.0);
    // avg qualitative: (0.4 + 0.5 + 0.3) / 3 = 0.4 < 0.7 → fails qualitative gate
    const avgQual = (0.4 + 0.5 + 0.3) / 3;
    expect(avgQual).toBeLessThan(QUALITATIVE_PASS_THRESHOLD);
    expect(summary?.passed).toBe(false);
  });

  it("without scorer, required case passes on routing gate alone (heuristic path)", async () => {
    // Verifies backwards compat: no scorer = heuristic path, no qualitative gate
    const evalCase = makeCategoryRoutingCase({
      transcript_expectations: [
        { check: "agent_mentioned", agent_name: "shuttle-client-frontend" },
      ],
    });
    const rubric = makeEvalRubric();

    const modelClient = new StubModelClient();
    modelClient.enqueueResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "→ shuttle-client-frontend",
    });

    // NO scorer injected
    const runner = makeRunner(
      { modelClient, tapestrySystemPrompt: "You are Tapestry." },
      [evalCase],
      [rubric],
    );

    const result = await runner.run().match(
      (r) => r,
      (e) => {
        throw new Error(`Unexpected error: ${e.type}`);
      },
    );

    const summary = result.caseResults[0]?.summary;
    expect(summary?.dimensionScores.routingCorrectness.score).toBe(1.0);
    // Heuristic path: only routing gate, no qualitative threshold
    expect(summary?.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Production-shaped E2E: real tcr-04/tcr-10 fixtures, injected scorer failure.
// Since Spec 37 task 16.4 a judge failure errors the case whenever the judge's
// verdict was needed; only a wrong route on a required case is decided
// without it.
// ---------------------------------------------------------------------------

describe("TapestryCategoryRoutingRunner — tcr-04/tcr-10 real fixtures with scorer failure (production-shaped E2E)", () => {
  // No `caseLoader`/`rubricLoader` override: this exercises the production
  // `TapestryCategoryRoutingRunner` reading the real fixture/rubric files
  // from `evals/cases/tapestry-category-routing/` and
  // `evals/rubrics/tapestry-category-routing/` on disk via `case-loader.ts`.
  const productionCases: Array<{ caseId: string; modelContent: string }> = [
    {
      caseId: "tcr-04-no-match",
      modelContent:
        "→ shuttle. No declared category pattern matches src/Infrastructure/Logging/Logger.cs, " +
        "so this falls back to the generic shuttle agent.",
    },
    {
      caseId: "tcr-10-disabled-category",
      modelContent:
        "→ shuttle. The matching category shuttle-client-frontend is disabled, " +
        "so this falls back to the generic shuttle agent.",
    },
  ];

  /** Runs one real case with a scorer that fails every call. */
  async function runWithFailingScorer(caseId: string, modelContent: string) {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: modelContent,
    });

    // Scorer fails for every case — simulates a live judge failure
    // without a network dependency.
    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultError({
      type: "JudgeHttpError",
      dimension: "rationaleQuality",
      status: 503,
      message: "judge returned HTTP 503: upstream unavailable",
    });

    const runner = new TapestryCategoryRoutingRunner({
      modelClient,
      scorer,
      tapestrySystemPrompt: "You are Tapestry.",
    });

    const result = await runner.run({ caseFilter: caseId, rawArtifacts: true });
    expect(result.isOk()).toBe(true);
    const runnerResult = result._unsafeUnwrap();
    expect(runnerResult.caseResults).toHaveLength(1);
    return { runnerResult, caseResult: runnerResult.caseResults[0] };
  }

  for (const { caseId, modelContent } of productionCases) {
    it(`loads the real "${caseId}" fixture/rubric from disk and reports a correct route the judge could not gate as errored, not passed`, async () => {
      const { runnerResult, caseResult } = await runWithFailingScorer(
        caseId,
        modelContent,
      );
      const summary = caseResult?.summary;

      // The route is right, but the judge's gate still had to be cleared, so
      // the case was not measured: errored, with the judge failure named.
      expect(summary?.errored).toBe(true);
      expect(summary?.errorClassification).toBe("judge-http-failure");
      expect(summary?.passed).toBe(false);
      expect(runnerResult.erroredCases).toBe(1);
      expect(runnerResult.failedCases).toBe(0);
      expect(runnerResult.suiteGreen).toBe(false);

      // The raw (local-only) artifact records the failure as a typed,
      // classified error.
      const errorSummary = caseResult?.rawArtifact?.errorSummary;
      expect(errorSummary?.errorType).toBe("JudgeHttpError");
      expect(errorSummary?.classification).toBe("judge-http-failure");
      expect(errorSummary?.dimension).toBe("rationaleQuality");
    });
  }

  it("still fails a wrong route on a required case, with a public explanation, because the judge could not have saved it", async () => {
    const { runnerResult, caseResult } = await runWithFailingScorer(
      "tcr-04-no-match",
      "→ shuttle-client-frontend. This looks like frontend work.",
    );
    const summary = caseResult?.summary;

    expect(summary?.errored).toBeUndefined();
    expect(summary?.passed).toBe(false);
    expect(summary?.dimensionScores.routingCorrectness.applicable).toBe(true);
    expect(summary?.dimensionScores.routingCorrectness.score).toBeLessThan(
      0.95,
    );
    expect(runnerResult.failedCases).toBe(1);
    expect(summary?.publicExplanation?.text.length).toBeGreaterThan(0);
    expect(summary?.publicExplanation?.text.length).toBeLessThanOrEqual(
      EXPLANATION_MAX_CHARS,
    );
    // The judge failure is still on record, locally.
    expect(caseResult?.rawArtifact?.errorSummary?.errorType).toBe(
      "JudgeHttpError",
    );
  });
});
