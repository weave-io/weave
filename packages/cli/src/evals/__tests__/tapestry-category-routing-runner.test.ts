/**
 * Tests for `tapestry-category-routing-runner.ts`.
 *
 * Verifies:
 *   - `extractCategoryShuttles()` extracts `shuttle-{category}` names without
 *     canonicalization.
 *   - `analyzeCategoryRouting()` classifies exact match, wrong category, and
 *     generic shuttle fallback correctly.
 *   - `scoreRoutingCorrectness()` assigns 1.0 for exact match, 0.0 for wrong
 *     category, and partial credit for generic shuttle fallback.
 *   - `TapestryCategoryRoutingRunner` executes the full case → score pipeline
 *     using in-memory fixtures (no file I/O, no real model calls).
 *   - Dry-run mode returns zero-score results with `dryRun: true`.
 *   - `PromptProviderFailed` is returned when the prompt provider errors.
 *   - `CaseFilterNotFound` is returned when `--case` filter matches nothing.
 *   - `NoCasesFound` is returned when model filter eliminates all cases.
 *   - Publishable summary NEVER contains raw prompt text, transcript content,
 *     or raw error strings.
 *
 * Test isolation:
 *   - All model calls go through `StubModelClient`.
 *   - No real file I/O, LangChain, git, or network calls occur.
 *   - Cases and rubrics are constructed inline and injected via `caseLoader`
 *     and `rubricLoader` options — the production `run()` is exercised directly.
 */

import { describe, expect, it } from "bun:test";
import { err, ResultAsync } from "neverthrow";
import { StubAgentEvalsScorer } from "../langchain-agent-evals.js";
import { StubModelClient } from "../openrouter-client.js";
import {
  analyzeCategoryRouting,
  detectGenericShuttleFallback,
  extractCategoryShuttles,
  GENERIC_SHUTTLE_FALLBACK_SCORE,
  QUALITATIVE_PASS_THRESHOLD,
  scoreExecutionCompleteness,
  scoreRoutingCorrectness,
  TAPESTRY_CATEGORY_ROUTING_SUITE,
  TapestryCategoryRoutingRunner,
  type TapestryCategoryRoutingRunnerOptions,
} from "../tapestry-category-routing-runner.js";
import type {
  EvalCase,
  EvalRubric,
  NormalizedScoreRecord,
  PromptProvider,
  ProvenanceError,
} from "../types.js";

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
// Unit tests — extractCategoryShuttles()
// ---------------------------------------------------------------------------

describe("extractCategoryShuttles", () => {
  it("extracts a single category shuttle name from routing line", () => {
    const content = "→ shuttle-client-frontend for UI changes";
    expect(extractCategoryShuttles(content)).toEqual([
      "shuttle-client-frontend",
    ]);
  });

  it("extracts multiple category shuttle names in order", () => {
    const content =
      "delegate to shuttle-backend first, then shuttle-client-frontend";
    expect(extractCategoryShuttles(content)).toEqual([
      "shuttle-backend",
      "shuttle-client-frontend",
    ]);
  });

  it("does NOT return generic 'shuttle' alone", () => {
    const content = "route to shuttle for this task";
    expect(extractCategoryShuttles(content)).toEqual([]);
  });

  it("does NOT canonicalize shuttle-client-frontend to shuttle", () => {
    const content = "→ shuttle-client-frontend";
    const result = extractCategoryShuttles(content);
    expect(result).not.toContain("shuttle");
    expect(result).toContain("shuttle-client-frontend");
  });

  it("skips secondary context lines", () => {
    const content = [
      "→ shuttle-client-frontend",
      "shuttle-backend: review afterwards",
    ].join("\n");
    // shuttle-backend is on a secondary line, should not be extracted
    const result = extractCategoryShuttles(content);
    expect(result).toContain("shuttle-client-frontend");
    expect(result).not.toContain("shuttle-backend");
  });

  it("returns empty array when no shuttle-{category} present", () => {
    expect(extractCategoryShuttles("This task has no routing signals")).toEqual(
      [],
    );
  });

  it("deduplicates repeated category shuttle mentions", () => {
    const content =
      "→ shuttle-backend\nWe route to shuttle-backend because it handles APIs";
    const result = extractCategoryShuttles(content);
    expect(result).toEqual(["shuttle-backend"]);
  });

  it("ignores negated category shuttle mention: 'do not route to shuttle-X; route to shuttle'", () => {
    // The disabled category shuttle appears in a negated clause; the affirmative
    // choice is generic shuttle. The negated shuttle-client-frontend must be ignored.
    const content =
      "do not route to shuttle-client-frontend because it is disabled; route to shuttle";
    const result = extractCategoryShuttles(content);
    expect(result).not.toContain("shuttle-client-frontend");
    expect(result).toEqual([]);
  });

  it("ignores 'shuttle-X is disabled' negated suffix pattern", () => {
    const content =
      "shuttle-client-frontend is disabled, so delegate to shuttle";
    const result = extractCategoryShuttles(content);
    expect(result).not.toContain("shuttle-client-frontend");
    expect(result).toEqual([]);
  });

  it("still extracts a wrong affirmative category shuttle", () => {
    // shuttle-backend is affirmatively selected; shuttle-client-frontend is expected but wrong
    const content = "→ shuttle-backend for this API task";
    const result = extractCategoryShuttles(content);
    expect(result).toEqual(["shuttle-backend"]);
  });

  it("two-pass: routing-line targets appear before non-routing diagnostic mentions", () => {
    // Line 1: non-routing diagnostic mention of shuttle-backend (no routing phrase)
    // Line 2: explicit routing to shuttle-client-frontend
    // Two-pass: pass-1 picks up shuttle-client-frontend (routing line),
    // pass-2 picks up shuttle-backend (non-routing line) — result[0] is frontend.
    const content = [
      "shuttle-backend handles APIs and data persistence",
      "→ shuttle-client-frontend",
    ].join("\n");
    const result = extractCategoryShuttles(content);
    expect(result[0]).toBe("shuttle-client-frontend");
  });

  it("two-pass: explicit routing-line target wins over earlier non-routing mention", () => {
    // Line 1: diagnostic mention of shuttle-backend (no routing phrase)
    // Line 2: explicit routing to shuttle-client-frontend
    // Primary target must be shuttle-client-frontend (routing-line pass 1)
    const content = [
      "shuttle-backend handles APIs and data persistence",
      "→ shuttle-client-frontend",
    ].join("\n");
    const result = extractCategoryShuttles(content);
    expect(result[0]).toBe("shuttle-client-frontend");
    // shuttle-backend appears in pass-2 after the primary target
    expect(result[1]).toBe("shuttle-backend");
  });

  it("two-pass: fallback when no routing phrase exists selects from non-routing lines", () => {
    // No routing line at all → pass 1 finds nothing → pass 2 picks up the mention
    const content = "shuttle-backend is the right agent for this task";
    const result = extractCategoryShuttles(content);
    expect(result).toEqual(["shuttle-backend"]);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — detectGenericShuttleFallback()
// ---------------------------------------------------------------------------

describe("detectGenericShuttleFallback", () => {
  it("detects bare shuttle on a routing line", () => {
    expect(detectGenericShuttleFallback("→ shuttle for this task")).toBe(true);
  });

  it("does NOT detect shuttle-backend as a generic shuttle fallback", () => {
    expect(
      detectGenericShuttleFallback("→ shuttle-backend for this task"),
    ).toBe(false);
  });

  it("'do not route to shuttle-backend' alone is not a generic fallback", () => {
    // Only negated category shuttle; no bare shuttle present
    expect(
      detectGenericShuttleFallback("do not route to shuttle-backend"),
    ).toBe(false);
  });

  it("'do not route to shuttle-backend; route to shuttle' is a generic fallback", () => {
    // Negated category shuttle + affirmative bare shuttle on same line
    expect(
      detectGenericShuttleFallback(
        "do not route to shuttle-backend; route to shuttle",
      ),
    ).toBe(true);
  });

  it("'do not route to shuttle' is NOT a generic fallback (bare token negated)", () => {
    // Bare shuttle is negated — should NOT count
    expect(detectGenericShuttleFallback("do not route to shuttle")).toBe(false);
  });

  it("non-routing line with bare shuttle does not trigger fallback", () => {
    // "shuttle" appears but line has no routing phrase
    expect(detectGenericShuttleFallback("shuttle is an agent")).toBe(false);
  });

  it("secondary context line is ignored", () => {
    // "route to shuttle" but on a line with a secondary indicator
    expect(
      detectGenericShuttleFallback("route to shuttle as a follow-up"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — analyzeCategoryRouting()
// ---------------------------------------------------------------------------

describe("analyzeCategoryRouting", () => {
  it("classifies exact match as 'exact-category-match'", () => {
    const content = "→ shuttle-client-frontend for this UI task";
    const analysis = analyzeCategoryRouting(
      content,
      "shuttle-client-frontend",
      [],
    );
    expect(analysis.classification).toBe("exact-category-match");
    expect(analysis.primaryCategoryTarget).toBe("shuttle-client-frontend");
  });

  it("classifies wrong category as 'wrong-category'", () => {
    const content = "→ shuttle-backend for this backend API task";
    const analysis = analyzeCategoryRouting(
      content,
      "shuttle-client-frontend",
      [],
    );
    expect(analysis.classification).toBe("wrong-category");
    expect(analysis.primaryCategoryTarget).toBe("shuttle-backend");
  });

  it("classifies generic shuttle as 'generic-shuttle-fallback'", () => {
    const content = "→ shuttle for this task";
    const analysis = analyzeCategoryRouting(
      content,
      "shuttle-client-frontend",
      [],
    );
    expect(analysis.classification).toBe("generic-shuttle-fallback");
    expect(analysis.primaryCategoryTarget).toBeUndefined();
    expect(analysis.genericShuttleMentioned).toBe(true);
  });

  it("classifies extraction miss when no routing signal present", () => {
    const content = "This task involves UI components.";
    const analysis = analyzeCategoryRouting(
      content,
      "shuttle-client-frontend",
      [],
    );
    expect(analysis.classification).toBe("extraction-miss");
  });

  it("classifies accepted alternate correctly", () => {
    const content = "→ shuttle-frontend for this task";
    const analysis = analyzeCategoryRouting(
      content,
      "shuttle-client-frontend",
      ["shuttle-frontend"],
    );
    expect(analysis.classification).toBe("accepted-alternate");
  });

  it("does NOT equate shuttle-client-frontend with shuttle", () => {
    const contentExact = "→ shuttle-client-frontend";
    const contentGeneric = "→ shuttle";

    const analysisExact = analyzeCategoryRouting(
      contentExact,
      "shuttle-client-frontend",
      [],
    );
    const analysisGeneric = analyzeCategoryRouting(
      contentGeneric,
      "shuttle-client-frontend",
      [],
    );

    expect(analysisExact.classification).toBe("exact-category-match");
    expect(analysisGeneric.classification).toBe("generic-shuttle-fallback");
    // These are NOT the same classification
    expect(analysisExact.classification).not.toBe(
      analysisGeneric.classification,
    );
  });

  it("classifies negated disabled category + generic shuttle selection as 'generic-shuttle-fallback'", () => {
    // A correct disabled-category response: model says the category is disabled and
    // falls back to generic shuttle. Must NOT be classified as wrong-category or
    // exact-category-match merely because the disabled shuttle name appears negated.
    const content =
      "do not route to shuttle-client-frontend because it is disabled; route to shuttle";
    const analysis = analyzeCategoryRouting(content, "shuttle", []);
    expect(analysis.classification).toBe("generic-shuttle-fallback");
    expect(analysis.primaryCategoryTarget).toBeUndefined();
    expect(analysis.genericShuttleMentioned).toBe(true);
  });

  it("classifies affirmative wrong category as 'wrong-category' even with negated mention in same response", () => {
    // The model explicitly names shuttle-backend (wrong), even if it also mentions
    // shuttle-client-frontend in a negated clause.
    const content =
      "do not use shuttle-client-frontend; instead route to shuttle-backend";
    const analysis = analyzeCategoryRouting(
      content,
      "shuttle-client-frontend",
      [],
    );
    expect(analysis.classification).toBe("wrong-category");
    expect(analysis.primaryCategoryTarget).toBe("shuttle-backend");
  });
});

// ---------------------------------------------------------------------------
// Unit tests — scoreRoutingCorrectness()
// ---------------------------------------------------------------------------

describe("scoreRoutingCorrectness", () => {
  it("returns 1.0 for exact-category-match", () => {
    const analysis = analyzeCategoryRouting(
      "→ shuttle-client-frontend",
      "shuttle-client-frontend",
      [],
    );
    const score = scoreRoutingCorrectness(analysis);
    expect(score.score).toBe(1.0);
    expect(score.applicable).toBe(true);
  });

  it("returns 0.0 for wrong-category", () => {
    const analysis = analyzeCategoryRouting(
      "→ shuttle-backend",
      "shuttle-client-frontend",
      [],
    );
    const score = scoreRoutingCorrectness(analysis);
    expect(score.score).toBe(0.0);
    expect(score.applicable).toBe(true);
  });

  it("returns GENERIC_SHUTTLE_FALLBACK_SCORE for generic-shuttle-fallback", () => {
    const analysis = analyzeCategoryRouting(
      "→ shuttle",
      "shuttle-client-frontend",
      [],
    );
    const score = scoreRoutingCorrectness(analysis);
    expect(score.score).toBe(GENERIC_SHUTTLE_FALLBACK_SCORE);
    expect(score.applicable).toBe(true);
  });

  it("returns 0.0 for extraction-miss", () => {
    const analysis = analyzeCategoryRouting(
      "No routing signals here",
      "shuttle-client-frontend",
      [],
    );
    const score = scoreRoutingCorrectness(analysis);
    expect(score.score).toBe(0.0);
    expect(score.applicable).toBe(true);
  });

  it("returns 0.8 for accepted-alternate", () => {
    const analysis = analyzeCategoryRouting(
      "→ shuttle-frontend",
      "shuttle-client-frontend",
      ["shuttle-frontend"],
    );
    const score = scoreRoutingCorrectness(analysis);
    expect(score.score).toBe(0.8);
    expect(score.applicable).toBe(true);
  });

  it("shuttle-client-frontend scores higher than generic shuttle", () => {
    const exactAnalysis = analyzeCategoryRouting(
      "→ shuttle-client-frontend",
      "shuttle-client-frontend",
      [],
    );
    const genericAnalysis = analyzeCategoryRouting(
      "→ shuttle",
      "shuttle-client-frontend",
      [],
    );

    const exactScore = scoreRoutingCorrectness(exactAnalysis);
    const genericScore = scoreRoutingCorrectness(genericAnalysis);

    expect(exactScore.score).toBeGreaterThan(genericScore.score);
  });

  // tcr-04 / tcr-10: when expected target IS generic shuttle, score 1.0 not 0.4
  it("returns 1.0 for generic-shuttle-fallback when expected target is shuttle (tcr-04 no-match)", () => {
    // Model responds with generic shuttle, and expected is also generic shuttle
    const analysis = analyzeCategoryRouting(
      "→ shuttle for this task",
      "shuttle",
      [],
    );
    expect(analysis.classification).toBe("generic-shuttle-fallback");
    const score = scoreRoutingCorrectness(analysis);
    expect(score.score).toBe(1.0);
    expect(score.applicable).toBe(true);
  });

  it("returns 1.0 for generic-shuttle-fallback when expected target is shuttle (tcr-10 disabled-category)", () => {
    // Model responds with generic shuttle; the matching category shuttle is disabled.
    // The content must not mention any shuttle-{category} name -- only generic shuttle.
    const analysis = analyzeCategoryRouting(
      "→ shuttle because the category shuttle is disabled",
      "shuttle",
      ["loom"],
    );
    expect(analysis.classification).toBe("generic-shuttle-fallback");
    const score = scoreRoutingCorrectness(analysis);
    expect(score.score).toBe(1.0);
  });

  it("returns GENERIC_SHUTTLE_FALLBACK_SCORE (0.4) when generic shuttle used but category expected", () => {
    // Model falls back to shuttle when shuttle-client-frontend was expected — partial only
    const analysis = analyzeCategoryRouting(
      "→ shuttle for this task",
      "shuttle-client-frontend",
      [],
    );
    expect(analysis.classification).toBe("generic-shuttle-fallback");
    const score = scoreRoutingCorrectness(analysis);
    expect(score.score).toBe(GENERIC_SHUTTLE_FALLBACK_SCORE);
    expect(score.score).toBeLessThan(1.0);
  });
});

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
// Integration tests — TapestryCategoryRoutingRunner (real run() with injected loaders)
// ---------------------------------------------------------------------------

describe("TapestryCategoryRoutingRunner (in-memory)", () => {
  it("passes when model routes to exact category shuttle", async () => {
    const evalCase = makeCategoryRoutingCase();
    const rubric = makeEvalRubric();

    const modelClient = new StubModelClient();
    modelClient.enqueueResponse({
      model: "anthropic/claude-sonnet-4.5",
      content:
        "→ shuttle-client-frontend for this UI task because it handles frontend components",
    });

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

    expect(result.suite).toBe(TAPESTRY_CATEGORY_ROUTING_SUITE);
    expect(result.caseResults).toHaveLength(1);

    const summary = result.caseResults[0]?.summary;
    expect(summary.passed).toBe(true);
    expect(summary.dimensionScores.routingCorrectness.score).toBe(1.0);
  });

  it("fails when model routes to wrong category shuttle (score 0)", async () => {
    const evalCase = makeCategoryRoutingCase();
    const rubric = makeEvalRubric();

    const modelClient = new StubModelClient();
    modelClient.enqueueResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "→ shuttle-backend because this is a backend task",
    });

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
    expect(summary.passed).toBe(false);
    expect(summary.dimensionScores.routingCorrectness.score).toBe(0.0);
  });

  it("scores partial credit for generic shuttle fallback (not 0, not 1)", async () => {
    const evalCase = makeCategoryRoutingCase();
    const rubric = makeEvalRubric();

    const modelClient = new StubModelClient();
    modelClient.enqueueResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "→ shuttle for this task",
    });

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
    expect(summary.passed).toBe(false); // required case, needs >= 0.95
    const score = summary.dimensionScores.routingCorrectness.score;
    expect(score).toBeGreaterThan(0.0); // not zero — partial credit
    expect(score).toBeLessThan(1.0); // not perfect
    expect(score).toBe(GENERIC_SHUTTLE_FALLBACK_SCORE);
  });

  it("shuttle-client-frontend is NOT canonicalized to shuttle in scoring", async () => {
    const evalCase = makeCategoryRoutingCase({
      expected_outcome: {
        kind: "agent_routing",
        target_agent: "shuttle-client-frontend",
        via: [],
      },
    });
    const rubric = makeEvalRubric();

    // Model correctly names shuttle-client-frontend
    const modelClientCorrect = new StubModelClient();
    modelClientCorrect.enqueueResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "→ shuttle-client-frontend",
    });

    const runnerCorrect = makeRunner(
      {
        modelClient: modelClientCorrect,
        tapestrySystemPrompt: "You are Tapestry.",
      },
      [evalCase],
      [rubric],
    );

    const resultCorrect = await runnerCorrect.run().match(
      (r) => r,
      (e) => {
        throw new Error(`Unexpected error: ${e.type}`);
      },
    );

    // Model falls back to generic shuttle
    const modelClientGeneric = new StubModelClient();
    modelClientGeneric.enqueueResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "→ shuttle",
    });

    const runnerGeneric = makeRunner(
      {
        modelClient: modelClientGeneric,
        tapestrySystemPrompt: "You are Tapestry.",
      },
      [evalCase],
      [rubric],
    );

    const resultGeneric = await runnerGeneric.run().match(
      (r) => r,
      (e) => {
        throw new Error(`Unexpected error: ${e.type}`);
      },
    );

    const correctScore =
      resultCorrect.caseResults[0]?.summary.dimensionScores.routingCorrectness
        .score;
    const genericScore =
      resultGeneric.caseResults[0]?.summary.dimensionScores.routingCorrectness
        .score;

    // If canonicalization happened, both would score the same.
    // Without canonicalization, exact match scores higher.
    expect(correctScore).toBe(1.0);
    expect(genericScore).toBe(GENERIC_SHUTTLE_FALLBACK_SCORE);
    expect(correctScore).toBeGreaterThan(genericScore);
  });

  it("dry-run mode returns zero-score results with dryRun: true", async () => {
    const evalCase = makeCategoryRoutingCase();
    const rubric = makeEvalRubric();
    const modelClient = new StubModelClient(); // no responses queued

    const runner = makeRunner(
      { modelClient, tapestrySystemPrompt: "You are Tapestry." },
      [evalCase],
      [rubric],
    );

    const result = await runner.run({ dryRun: true }).match(
      (r) => r,
      (e) => {
        throw new Error(`Unexpected error: ${e.type}`);
      },
    );

    expect(result.caseResults).toHaveLength(1);
    expect(result.caseResults[0]?.summary.dryRun).toBe(true);
    expect(result.caseResults[0]?.summary.weightedTotal).toBe(0);
  });

  it("returns CaseFilterNotFound for unknown case filter", async () => {
    const evalCase = makeCategoryRoutingCase();
    const rubric = makeEvalRubric();
    const modelClient = new StubModelClient();

    const runner = makeRunner(
      { modelClient, tapestrySystemPrompt: "You are Tapestry." },
      [evalCase],
      [rubric],
    );

    const result = await runner
      .run({ caseFilter: "nonexistent-case-id" })
      .match(
        (r) => r,
        (e) => e,
      );

    expect(result).toMatchObject({ type: "CaseFilterNotFound" });
  });

  it("returns NoCasesFound when model filter eliminates all cases", async () => {
    const evalCase = makeCategoryRoutingCase();
    const rubric = makeEvalRubric();
    const modelClient = new StubModelClient();

    const runner = makeRunner(
      { modelClient, tapestrySystemPrompt: "You are Tapestry." },
      [evalCase],
      [rubric],
    );

    const result = await runner
      .run({ modelFilter: "openai/gpt-999-does-not-exist" })
      .match(
        (r) => r,
        (e) => e,
      );

    expect(result).toMatchObject({ type: "NoCasesFound" });
  });

  it("returns PromptProviderFailed when provider errors", async () => {
    const evalCase = makeCategoryRoutingCase();
    const rubric = makeEvalRubric();
    const modelClient = new StubModelClient();

    const failingProvider: PromptProvider = {
      getPrompt: (_agentName: string) =>
        new ResultAsync<string, ProvenanceError>(
          Promise.resolve(
            err<string, ProvenanceError>({
              type: "PromptCompositionError",
              agentName: "tapestry",
              message: "Failed to compose prompt",
            }),
          ),
        ),
    };

    const runner = makeRunner(
      { modelClient, promptProvider: failingProvider },
      [evalCase],
      [rubric],
    );

    const result = await runner.run().match(
      (r) => r,
      (e) => e,
    );

    expect(result).toMatchObject({ type: "PromptProviderFailed" });
  });

  it("publishable summary does not contain raw prompt text or transcript content", async () => {
    const evalCase = makeCategoryRoutingCase();
    const rubric = makeEvalRubric();

    const modelClient = new StubModelClient();
    modelClient.enqueueResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "→ shuttle-client-frontend SECRET_CONTENT_THAT_SHOULD_NOT_LEAK",
    });

    const runner = makeRunner(
      { modelClient, tapestrySystemPrompt: "SECRET_SYSTEM_PROMPT_CONTENT" },
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
    const summaryStr = JSON.stringify(summary);

    expect(summaryStr).not.toContain("SECRET_SYSTEM_PROMPT_CONTENT");
    expect(summaryStr).not.toContain("SECRET_CONTENT_THAT_SHOULD_NOT_LEAK");

    // Verify rawArtifact is not set (rawArtifacts not requested)
    expect(result.caseResults[0]?.rawArtifact).toBeUndefined();
  });

  it("suiteGreen is true only when all required cases pass", async () => {
    const evalCase = makeCategoryRoutingCase();
    const rubric = makeEvalRubric();

    const modelClient = new StubModelClient();
    modelClient.enqueueResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "→ shuttle-client-frontend",
    });

    const runnerPass = makeRunner(
      { modelClient, tapestrySystemPrompt: "You are Tapestry." },
      [evalCase],
      [rubric],
    );

    const resultPass = await runnerPass.run().match(
      (r) => r,
      (e) => {
        throw new Error(`Unexpected error: ${e.type}`);
      },
    );

    expect(resultPass.suiteGreen).toBe(true);

    const modelClientFail = new StubModelClient();
    modelClientFail.enqueueResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "→ shuttle-backend",
    });

    const runnerFail = makeRunner(
      {
        modelClient: modelClientFail,
        tapestrySystemPrompt: "You are Tapestry.",
      },
      [evalCase],
      [rubric],
    );

    const resultFail = await runnerFail.run().match(
      (r) => r,
      (e) => {
        throw new Error(`Unexpected error: ${e.type}`);
      },
    );

    expect(resultFail.suiteGreen).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Requirement 4: Empty model-filtered work set → NoCasesFound before dry/live
  // -------------------------------------------------------------------------

  it("dry-run: returns NoCasesFound (not ok) when model filter empties work set — no model calls made", async () => {
    const evalCase = makeCategoryRoutingCase(); // only allows anthropic/claude-sonnet-4.5
    const rubric = makeEvalRubric();
    const modelClient = new StubModelClient(); // would throw if called

    const runner = makeRunner(
      { modelClient, tapestrySystemPrompt: "You are Tapestry." },
      [evalCase],
      [rubric],
    );

    const result = await runner
      .run({ dryRun: true, modelFilter: "openai/gpt-999-does-not-exist" })
      .match(
        (r) => r,
        (e) => e,
      );

    expect(result).toMatchObject({ type: "NoCasesFound" });
    // No model calls were attempted (StubModelClient throws on empty queue)
  });

  it("live: returns NoCasesFound before prompt/model when model filter empties work set", async () => {
    const evalCase = makeCategoryRoutingCase();
    const rubric = makeEvalRubric();
    const modelClient = new StubModelClient(); // no responses queued — would throw

    let promptCalled = false;
    const trackingProvider: PromptProvider = {
      getPrompt: (_agentName: string) => {
        promptCalled = true;
        return ResultAsync.fromSafePromise(
          Promise.resolve("Test Tapestry system prompt"),
        );
      },
    };

    const runner = makeRunner(
      { modelClient, promptProvider: trackingProvider },
      [evalCase],
      [rubric],
    );

    const result = await runner
      .run({ modelFilter: "openai/gpt-999-does-not-exist" })
      .match(
        (r) => r,
        (e) => e,
      );

    expect(result).toMatchObject({ type: "NoCasesFound" });
    expect(promptCalled).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Requirement 5: Dry-run required derives from rubric scoring.required
  // -------------------------------------------------------------------------

  it("dry-run: required=true when rubric.scoring.required is true", async () => {
    const evalCase = makeCategoryRoutingCase();
    const rubric = makeEvalRubric(); // required: true by default
    const modelClient = new StubModelClient();

    const runner = makeRunner(
      { modelClient, tapestrySystemPrompt: "You are Tapestry." },
      [evalCase],
      [rubric],
    );

    const result = await runner.run({ dryRun: true }).match(
      (r) => r,
      (e) => {
        throw new Error(`Unexpected error: ${e.type}`);
      },
    );

    expect(result.caseResults[0]?.summary.dryRun).toBe(true);
    expect(result.caseResults[0]?.summary.required).toBe(true);
  });

  it("dry-run: required=false when rubric.scoring.required is false", async () => {
    const evalCase = makeCategoryRoutingCase();
    const rubric: EvalRubric = {
      case_id: "route-to-shuttle-client-frontend",
      suite: "tapestry-category-routing",
      scoring: {
        outcome_weight: 0.7,
        per_expectation_weight: 0.3,
        required: false, // non-required case
      },
    };
    const modelClient = new StubModelClient();

    const runner = makeRunner(
      { modelClient, tapestrySystemPrompt: "You are Tapestry." },
      [evalCase],
      [rubric],
    );

    const result = await runner.run({ dryRun: true }).match(
      (r) => r,
      (e) => {
        throw new Error(`Unexpected error: ${e.type}`);
      },
    );

    expect(result.caseResults[0]?.summary.dryRun).toBe(true);
    expect(result.caseResults[0]?.summary.required).toBe(false);
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
  it("calls injected scorer with real ModelRunOutput, EvalCase, and rubrics", async () => {
    const evalCase = makeCategoryRoutingCase();
    const rubric = makeEvalRubric();

    const modelClient = new StubModelClient();
    modelClient.enqueueResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "→ shuttle-client-frontend because src/components are frontend",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.enqueueRecord(makeScorerRecord(evalCase.id));

    const runner = makeRunner(
      { modelClient, scorer, tapestrySystemPrompt: "You are Tapestry." },
      [evalCase],
      [rubric],
    );

    await runner.run().match(
      (r) => r,
      (e) => {
        throw new Error(`Unexpected error: ${e.type}`);
      },
    );

    expect(scorer.calls).toHaveLength(1);
    const call = scorer.calls[0];
    expect(call?.evalCase.id).toBe(evalCase.id);
    expect(call?.run.caseId).toBe(evalCase.id);
    // Rubric array must be passed (scorer does its own lookup)
    expect(call?.rubrics.length).toBeGreaterThan(0);
  });

  it("uses scorer's qualitative dimensions (delegationCorrectness, executionCompleteness, rationaleQuality) in final result", async () => {
    const evalCase = makeCategoryRoutingCase();
    const rubric = makeEvalRubric();

    const modelClient = new StubModelClient();
    modelClient.enqueueResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "→ shuttle-client-frontend",
    });

    const scorer = new StubAgentEvalsScorer();
    // Scorer returns distinct qualitative scores that differ from heuristic defaults
    scorer.enqueueRecord(
      makeScorerRecord(evalCase.id, {
        dimensions: {
          routingCorrectness: {
            score: 0.5,
            rationale: "scorer routing (ignored)",
            applicable: true,
          },
          delegationCorrectness: {
            score: 0.77,
            rationale: "scorer delegation",
            applicable: true,
          },
          executionCompleteness: {
            score: 0.88,
            rationale: "scorer execution",
            applicable: true,
          },
          rationaleQuality: {
            score: 0.66,
            rationale: "scorer rationale",
            applicable: true,
          },
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
    // Qualitative dimensions come from scorer
    expect(summary?.dimensionScores.delegationCorrectness.score).toBe(0.77);
    expect(summary?.dimensionScores.executionCompleteness.score).toBe(0.88);
    expect(summary?.dimensionScores.rationaleQuality.score).toBe(0.66);
    // routingCorrectness is locally computed (1.0 for exact match), NOT the scorer's 0.5
    expect(summary?.dimensionScores.routingCorrectness.score).toBe(1.0);
  });

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

  it("scorer failure yields a typed ScorerAdapterError zero-score result without throwing; suite continues", async () => {
    const evalCase = makeCategoryRoutingCase();
    const rubric = makeEvalRubric();

    const modelClient = new StubModelClient();
    modelClient.enqueueResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "→ shuttle-client-frontend",
    });

    const scorer = new StubAgentEvalsScorer();
    // Scorer errors
    scorer.enqueueError({
      type: "ScorerAdapterError",
      caseId: evalCase.id,
      dimension: "delegationCorrectness",
      message: "LangChain judge timed out",
    });

    const runner = makeRunner(
      { modelClient, scorer, tapestrySystemPrompt: "You are Tapestry." },
      [evalCase],
      [rubric],
    );

    // Suite must not throw
    const result = await runner.run().match(
      (r) => r,
      (e) => {
        throw new Error(`Unexpected runner error: ${e.type}`);
      },
    );

    // Suite completes — one case result emitted
    expect(result.caseResults).toHaveLength(1);
    const summary = result.caseResults[0]?.summary;
    // Scorer error → zero-score, not passed
    expect(summary?.passed).toBe(false);
    expect(summary?.weightedTotal).toBe(0);
    // All dimension scores are 0 and not applicable (error path)
    expect(summary?.dimensionScores.routingCorrectness.score).toBe(0);
    expect(summary?.dimensionScores.delegationCorrectness.score).toBe(0);

    // rawArtifact errorSummary must contain ScorerAdapterError classification
    // (requires rawArtifacts: true)
  });

  it("scorer error raw artifact contains ScorerAdapterError and preserves dimension", async () => {
    const evalCase = makeCategoryRoutingCase();
    const rubric = makeEvalRubric();

    const modelClient = new StubModelClient();
    modelClient.enqueueResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "→ shuttle-client-frontend",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.enqueueError({
      type: "ScorerAdapterError",
      caseId: evalCase.id,
      dimension: "delegationCorrectness",
      message: "LangChain judge timed out",
    });

    const runner = makeRunner(
      { modelClient, scorer, tapestrySystemPrompt: "You are Tapestry." },
      [evalCase],
      [rubric],
    );

    const result = await runner.run({ rawArtifacts: true }).match(
      (r) => r,
      (e) => {
        throw new Error(`Unexpected runner error: ${e.type}`);
      },
    );

    const caseResult = result.caseResults[0];
    expect(caseResult?.rawArtifact).toBeDefined();
    const errorSummary = caseResult?.rawArtifact?.errorSummary;
    expect(errorSummary).toBeDefined();
    // errorType must be ScorerAdapterError
    expect(errorSummary?.errorType).toBe("ScorerAdapterError");
    // classification must map to scoring-adapter-failure
    expect(errorSummary?.classification).toBe("scoring-adapter-failure");
    // dimension must be preserved from the scorer error
    expect(errorSummary?.dimension).toBe("delegationCorrectness");
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

  it("required case WITHOUT transcript_expectations passes on routing gate alone (no qualitative gate)", async () => {
    // No transcript_expectations — qualitative gate should NOT apply
    const evalCase = makeCategoryRoutingCase({
      transcript_expectations: [], // explicitly empty
    });
    const rubric = makeEvalRubric();

    const modelClient = new StubModelClient();
    modelClient.enqueueResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "→ shuttle-client-frontend",
    });

    const scorer = new StubAgentEvalsScorer();
    // Routing correct (1.0) but qualitative is low — should still pass (no gate)
    scorer.enqueueRecord(
      makeScorerRecord(evalCase.id, {
        dimensions: {
          routingCorrectness: {
            score: 1.0,
            rationale: "correct",
            applicable: true,
          },
          delegationCorrectness: {
            score: 0.2,
            rationale: "poor",
            applicable: true,
          },
          executionCompleteness: {
            score: 0.2,
            rationale: "poor",
            applicable: true,
          },
          rationaleQuality: { score: 0.2, rationale: "poor", applicable: true },
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
    expect(summary?.dimensionScores.routingCorrectness.score).toBe(1.0);
    // No transcript_expectations → qualitative gate not applied → passes on routing alone
    expect(summary?.passed).toBe(true);
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
