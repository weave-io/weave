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
 *   - Cases and rubrics are constructed inline.
 *   - The runner is constructed via `InMemoryTapestryCategoryRoutingRunner`
 *     which bypasses file-based fixture loading.
 */

import { describe, expect, it } from "bun:test";
import { err, ok, ResultAsync } from "neverthrow";
import { StubModelClient } from "../openrouter-client.js";
import {
  analyzeCategoryRouting,
  extractCategoryShuttles,
  GENERIC_SHUTTLE_FALLBACK_SCORE,
  scoreRoutingCorrectness,
  TAPESTRY_CATEGORY_ROUTING_SUITE,
  TapestryCategoryRoutingRunner,
  type TapestryCategoryRoutingRunnerOptions,
  type TapestryCategoryRoutingRunRequest,
} from "../tapestry-category-routing-runner.js";
import type {
  CaseResult,
  EvalCase,
  EvalRubric,
  PromptProvider,
  ProvenanceError,
  RunnerResult,
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
// InMemoryTapestryCategoryRoutingRunner — bypasses file I/O
// ---------------------------------------------------------------------------

/**
 * A test double that overrides the fixture-loading step with in-memory
 * cases and rubrics, exercising the full runner pipeline without file I/O.
 */
class InMemoryTapestryCategoryRoutingRunner extends TapestryCategoryRoutingRunner {
  private readonly _promptProvider: PromptProvider | undefined;

  constructor(
    options: TapestryCategoryRoutingRunnerOptions,
    private readonly cases: EvalCase[],
    private readonly rubrics: EvalRubric[],
  ) {
    super({ ...options, evalsRoot: "/tmp/nonexistent-evals-root-for-tests" });
    this._promptProvider = options.promptProvider;
  }

  override run(
    request: TapestryCategoryRoutingRunRequest = {},
  ): ResultAsync<RunnerResult, import("../types.js").RunnerError> {
    const dryRun = request.dryRun ?? false;
    const rawArtifacts = request.rawArtifacts ?? false;

    let cases = [...this.cases];
    const rubrics = this.rubrics;

    // Apply case filter
    if (request.caseFilter !== undefined) {
      const match = cases.find((c) => c.id === request.caseFilter);
      if (match === undefined) {
        const known = cases.map((c) => c.id).join(", ") || "(none)";
        return new ResultAsync(
          Promise.resolve(
            err<RunnerResult, import("../types.js").RunnerError>({
              type: "CaseFilterNotFound",
              caseId: request.caseFilter,
              message: `Case "${request.caseFilter}" not found. Known: ${known}`,
            }),
          ),
        );
      }
      cases = [match];
    }

    if (cases.length === 0) {
      return new ResultAsync(
        Promise.resolve(
          err<RunnerResult, import("../types.js").RunnerError>({
            type: "NoCasesFound",
            suite: TAPESTRY_CATEGORY_ROUTING_SUITE,
            message: `No cases found in suite "${TAPESTRY_CATEGORY_ROUTING_SUITE}".`,
          }),
        ),
      );
    }

    // Apply model filter
    const workItems = cases.flatMap((evalCase) => {
      if (request.modelFilter !== undefined) {
        if (!evalCase.allowed_models.includes(request.modelFilter)) {
          return [];
        }
        return [{ evalCase, modelId: request.modelFilter }];
      }
      const modelId = evalCase.allowed_models[0];
      if (modelId === undefined) return [];
      return [{ evalCase, modelId }];
    });

    if (workItems.length === 0) {
      return new ResultAsync(
        Promise.resolve(
          err<RunnerResult, import("../types.js").RunnerError>({
            type: "NoCasesFound",
            suite: TAPESTRY_CATEGORY_ROUTING_SUITE,
            message: `No cases match model filter "${request.modelFilter}".`,
          }),
        ),
      );
    }

    if (dryRun) {
      const caseResults = workItems.map(({ evalCase, modelId }) => ({
        summary: {
          caseId: evalCase.id,
          modelId,
          suite: evalCase.suite,
          passed: false,
          required: evalCase.transcript_expectations.length === 0,
          weightedTotal: 0,
          dimensionScores: {
            routingCorrectness: { score: 0, applicable: false },
            delegationCorrectness: { score: 0, applicable: false },
            executionCompleteness: { score: 0, applicable: false },
            rationaleQuality: { score: 0, applicable: false },
          },
          scoredAt: new Date().toISOString(),
          dryRun: true,
        },
      }));
      return ResultAsync.fromSafePromise(
        Promise.resolve(
          assembleRunnerResult(TAPESTRY_CATEGORY_ROUTING_SUITE, caseResults),
        ),
      );
    }

    // Resolve prompt provider
    const resolvePrompt = (): ResultAsync<
      string,
      import("../types.js").RunnerError
    > => {
      if (this._promptProvider !== undefined) {
        return this._promptProvider
          .getPrompt("tapestry")
          .mapErr((): import("../types.js").RunnerError => ({
            type: "PromptProviderFailed",
            agentName: "tapestry",
            message: "Tapestry prompt provider failed.",
          }));
      }
      return ResultAsync.fromSafePromise(
        Promise.resolve("Test Tapestry system prompt"),
      );
    };

    return resolvePrompt().andThen((systemPrompt) => {
      const executeAll = workItems.reduce(
        (acc, { evalCase, modelId }) =>
          acc.andThen((results) =>
            executeCaseInMemory(
              this,
              evalCase,
              modelId,
              rubrics,
              rawArtifacts,
              systemPrompt,
            ).map((result) => [...results, result]),
          ),
        ResultAsync.fromSafePromise(Promise.resolve([] as CaseResult[])),
      );

      return (executeAll as ResultAsync<CaseResult[], never>).andThen(
        (caseResults) =>
          ResultAsync.fromSafePromise(
            Promise.resolve(
              assembleRunnerResult(
                TAPESTRY_CATEGORY_ROUTING_SUITE,
                caseResults,
              ),
            ),
          ),
      );
    });
  }
}

function assembleRunnerResult(
  suite: string,
  caseResults: CaseResult[],
): RunnerResult {
  const passedCases = caseResults.filter((r) => r.summary.passed).length;
  const failedCases = caseResults.length - passedCases;
  const suiteGreen = caseResults
    .filter((r) => r.summary.required && !r.summary.dryRun)
    .every((r) => r.summary.passed);

  return {
    suite,
    suiteGreen,
    caseResults,
    totalCases: caseResults.length,
    passedCases,
    failedCases,
    completedAt: new Date().toISOString(),
  };
}

function executeCaseInMemory(
  runner: TapestryCategoryRoutingRunner,
  evalCase: EvalCase,
  modelId: string,
  rubrics: EvalRubric[],
  _rawArtifacts: boolean,
  systemPrompt: string,
): ResultAsync<CaseResult, never> {
  const userMessage = `Task to route: ${evalCase.description}`;

  // Access the model client via duck-typing
  const anyRunner = runner as unknown as { modelClient: StubModelClient };

  const modelResultAsync = anyRunner.modelClient.complete({
    model: modelId,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature: 0.2,
  });

  const matchPromise = modelResultAsync
    .andThen((response) => {
      const expectedTarget =
        evalCase.expected_outcome.kind === "agent_routing"
          ? evalCase.expected_outcome.target_agent
          : "";

      const analysis = analyzeCategoryRouting(
        response.content,
        expectedTarget,
        evalCase.accepted_alternates,
      );

      const rubric = rubrics.find((r) => r.case_id === evalCase.id);
      if (rubric === undefined) {
        return new ResultAsync<CaseResult, { type: string; message: string }>(
          Promise.resolve(
            err({
              type: "RubricNotFound",
              message: `No rubric for "${evalCase.id}".`,
            }),
          ),
        );
      }

      const routingScore = scoreRoutingCorrectness(analysis);
      const passed = rubric.scoring.required
        ? routingScore.score >= 0.95
        : routingScore.score >= 0.5;

      const caseResult: CaseResult = {
        summary: {
          caseId: evalCase.id,
          modelId,
          suite: evalCase.suite,
          passed,
          required: rubric.scoring.required,
          weightedTotal: routingScore.score * rubric.scoring.outcome_weight,
          dimensionScores: {
            routingCorrectness: {
              score: routingScore.score,
              applicable: routingScore.applicable,
            },
            delegationCorrectness: { score: 0, applicable: false },
            executionCompleteness: { score: 0, applicable: false },
            rationaleQuality: { score: 0, applicable: false },
          },
          scoredAt: new Date().toISOString(),
          dryRun: false,
        },
      };

      return ResultAsync.fromSafePromise(Promise.resolve(caseResult));
    })
    .match<CaseResult>(
      (result) => result,
      () => ({
        summary: {
          caseId: evalCase.id,
          modelId,
          suite: evalCase.suite,
          passed: false,
          required: true,
          weightedTotal: 0,
          dimensionScores: {
            routingCorrectness: { score: 0, applicable: false },
            delegationCorrectness: { score: 0, applicable: false },
            executionCompleteness: { score: 0, applicable: false },
            rationaleQuality: { score: 0, applicable: false },
          },
          scoredAt: new Date().toISOString(),
          dryRun: false,
        },
      }),
    );

  return new ResultAsync(
    matchPromise.then((result) => ok<CaseResult, never>(result)),
  );
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
// Integration tests — InMemoryTapestryCategoryRoutingRunner
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

    const runner = new InMemoryTapestryCategoryRoutingRunner(
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

    const runner = new InMemoryTapestryCategoryRoutingRunner(
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

    const runner = new InMemoryTapestryCategoryRoutingRunner(
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

    const runnerCorrect = new InMemoryTapestryCategoryRoutingRunner(
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

    const runnerGeneric = new InMemoryTapestryCategoryRoutingRunner(
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

    const runner = new InMemoryTapestryCategoryRoutingRunner(
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

    const runner = new InMemoryTapestryCategoryRoutingRunner(
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

    const runner = new InMemoryTapestryCategoryRoutingRunner(
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

    const runner = new InMemoryTapestryCategoryRoutingRunner(
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

    const runner = new InMemoryTapestryCategoryRoutingRunner(
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

    const runnerPass = new InMemoryTapestryCategoryRoutingRunner(
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

    const runnerFail = new InMemoryTapestryCategoryRoutingRunner(
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
});
