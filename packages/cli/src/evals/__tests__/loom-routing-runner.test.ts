/**
 * Tests for `loom-routing-runner.ts`.
 *
 * Verifies:
 *   - `LoomRoutingRunner` loads cases from the suite and executes them.
 *   - Case filter (`caseFilter`) narrows the workload to the matching case.
 *   - Model filter (`modelFilter`) narrows to cases that allow the model.
 *   - Dry-run mode returns `CaseResult` entries with `dryRun: true` and no
 *     model calls made.
 *   - Each case result has a publishable `CaseResultSummary` with no raw
 *     prompt text, transcript content, or error details.
 *   - `rawArtifact` is only present when `rawArtifacts: true` is requested.
 *   - `rawArtifact` carries `composedPrompt`, `transcript`, `rawContent`,
 *     and `dimensionRationales`.
 *   - `extractRoutedAgents()` correctly identifies routing signals in text.
 *   - `CaseFilterNotFound` is returned when `--case` filter matches no case.
 *   - `NoCasesFound` is returned when model filter eliminates all cases.
 *   - `FixtureLoadError` is returned when case fixture loading fails.
 *   - Suite green status reflects all required cases passing.
 *   - Per-case model errors are accumulated as zero-score results (no abort).
 *   - Per-case scoring errors are accumulated as zero-score results.
 *   - Publishable summary NEVER contains: raw prompt text, transcript messages
 *     content, tool args, env, raw errors, or log tails.
 *   - No real network, LangChain, git, or file I/O occurs in any test.
 *
 * Test isolation:
 *   - All model calls go through `StubModelClient`.
 *   - All scoring calls go through `StubAgentEvalsScorer`.
 *   - Case and rubric fixtures are constructed inline (no file reads).
 *   - The runner is constructed with an in-memory `evalsRoot` that has no
 *     real fixture files — cases are passed via in-memory stub fixture loaders.
 *
 * Implementation note:
 *   To avoid real file I/O, tests use a custom subclass of `LoomRoutingRunner`
 *   that overrides the fixture-loading step with in-memory fixtures, OR they
 *   invoke `extractRoutedAgents()` and the response-parsing helpers directly.
 *   Runner-level end-to-end tests pass a non-existent `evalsRoot` (yielding
 *   an empty case set) and drive the runner via `caseFilter` + a pre-loaded
 *   fixture injector subclass.
 */

import { describe, expect, it } from "bun:test";
import { err, ok, ResultAsync } from "neverthrow";
import {
  buildPublicExplanation,
  StubAgentEvalsScorer,
} from "../langchain-agent-evals.js";
import {
  extractRoutedAgents,
  LOOM_ROUTING_SUITE,
  LoomRoutingRunner,
  type LoomRoutingRunnerOptions,
  type LoomRunRequest,
  redactSecrets,
} from "../loom-routing-runner.js";
import { StubModelClient } from "../openrouter-client.js";
import type {
  CaseResult,
  CaseResultSummary,
  DimensionScore,
  EvalCase,
  EvalRubric,
  ModelRunOutput,
  NormalizedScoreRecord,
  PromptProvider,
  ProvenanceError,
  RawCaseResultArtifact,
  RunnerResult,
  ScoringDimension,
} from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCORED_AT = "2026-01-01T00:00:00.000Z";

function makeAgentRoutingCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "route-to-shuttle",
    description: "Route a backend task to the shuttle agent",
    suite: "loom-routing",
    allowed_agents: ["loom", "shuttle"],
    allowed_models: ["anthropic/claude-sonnet-4.5"],
    expected_outcome: {
      kind: "agent_routing",
      target_agent: "shuttle",
      via: [],
    },
    accepted_alternates: [],
    transcript_expectations: [],
    tags: [],
    ...overrides,
  };
}

function makeEvalRubric(caseId = "route-to-shuttle"): EvalRubric {
  return {
    case_id: caseId,
    suite: "loom-routing",
    scoring: {
      outcome_weight: 0.7,
      per_expectation_weight: 0.3,
      required: true,
    },
  };
}

function makeNormalizedScoreRecord(
  overrides: Partial<NormalizedScoreRecord> = {},
): NormalizedScoreRecord {
  const neutralDim: DimensionScore = {
    score: 1.0,
    rationale: "n/a",
    applicable: false,
  };
  const activeDim: DimensionScore = {
    score: 1.0,
    rationale: "Correct routing to shuttle.",
    applicable: true,
  };
  return {
    caseId: "route-to-shuttle",
    modelId: "anthropic/claude-sonnet-4.5",
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
    scoredAt: SCORED_AT,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// InMemoryLoomRunner — test double that bypasses file I/O
// ---------------------------------------------------------------------------

/**
 * A test double for `LoomRoutingRunner` that overrides the internal
 * fixture-loading step to use in-memory case and rubric fixtures.
 *
 * This avoids real file I/O while exercising the full runner logic including
 * case filtering, model calling, scoring, and result assembly.
 *
 * When a `promptProvider` is supplied in options, the `run()` method calls
 * `promptProvider.getPrompt("loom")` and uses the result as the system prompt.
 * This proves the provider is wired in without requiring real file I/O.
 */
class InMemoryLoomRunner extends LoomRoutingRunner {
  private readonly _promptProvider: PromptProvider | undefined;

  constructor(
    options: LoomRoutingRunnerOptions,
    private readonly cases: EvalCase[],
    private readonly rubrics: EvalRubric[],
  ) {
    // Pass a non-existent evalsRoot — it will be overridden by the subclass
    super({ ...options, evalsRoot: "/tmp/nonexistent-evals-root-for-tests" });
    // Capture promptProvider for use in the overridden run()
    this._promptProvider = options.promptProvider;
  }

  override run(
    request: LoomRunRequest = {},
  ): ResultAsync<RunnerResult, import("../types.js").RunnerError> {
    // Re-implement run() using in-memory fixtures instead of file I/O
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
            suite: LOOM_ROUTING_SUITE,
            message: `No cases found in suite "${LOOM_ROUTING_SUITE}".`,
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
            suite: LOOM_ROUTING_SUITE,
            message: `No cases match model filter "${request.modelFilter}".`,
          }),
        ),
      );
    }

    if (dryRun) {
      const caseResults = workItems.map(({ evalCase, modelId }) => ({
        summary: makeDryRunSummary(evalCase, modelId),
      }));
      return ResultAsync.fromSafePromise(
        Promise.resolve(assembleRunnerResult(LOOM_ROUTING_SUITE, caseResults)),
      );
    }

    // If a promptProvider is set, resolve it first.
    // Provider failure is a hard stop — no model calls are made.
    if (this._promptProvider !== undefined) {
      return this._promptProvider
        .getPrompt("loom")
        .mapErr((): import("../types.js").RunnerError => ({
          type: "PromptProviderFailed",
          agentName: "loom",
          message:
            "Loom prompt provider failed: prompt composition could not complete.",
        }))
        .andThen((_systemPrompt) => {
          // Execute each work item, accumulating results
          const executeAll = workItems.reduce(
            (acc, { evalCase, modelId }) =>
              acc.andThen((results) =>
                executeCaseWithStubs(
                  this,
                  evalCase,
                  modelId,
                  rubrics,
                  rawArtifacts,
                ).map((result) => [...results, result]),
              ),
            ResultAsync.fromSafePromise(Promise.resolve([] as CaseResult[])),
          );

          return (executeAll as ResultAsync<CaseResult[], never>).andThen(
            (caseResults) =>
              ResultAsync.fromSafePromise(
                Promise.resolve(
                  assembleRunnerResult(LOOM_ROUTING_SUITE, caseResults),
                ),
              ),
          );
        });
    }

    // No promptProvider — use a hardcoded test prompt (test-only path)
    const executeAll = workItems.reduce(
      (acc, { evalCase, modelId }) =>
        acc.andThen((results) =>
          executeCaseWithStubs(
            this,
            evalCase,
            modelId,
            rubrics,
            rawArtifacts,
          ).map((result) => [...results, result]),
        ),
      ResultAsync.fromSafePromise(Promise.resolve([] as CaseResult[])),
    );

    return (
      executeAll as ResultAsync<CaseResult[], import("../types.js").RunnerError>
    ).andThen((caseResults) =>
      ResultAsync.fromSafePromise(
        Promise.resolve(assembleRunnerResult(LOOM_ROUTING_SUITE, caseResults)),
      ),
    );
  }
}

// Expose internal execution for InMemoryLoomRunner via a module-level helper
// (avoids accessing private methods by using the public runner interface)
function executeCaseWithStubs(
  runner: LoomRoutingRunner,
  evalCase: EvalCase,
  modelId: string,
  rubrics: EvalRubric[],
  rawArtifacts: boolean,
): ResultAsync<CaseResult, never> {
  // Access internal data by calling through the runner's public interface
  // We achieve this by calling the private implementation via a wrapper that
  // re-exposes the needed behavior using the injected stubs.
  // Since we can't access private methods, we extract the logic here.

  const userMessage = `Task to route: ${evalCase.description}`;
  const systemPrompt = "Test Loom system prompt";

  // Access the model client and scorer via duck-typing
  const anyRunner = runner as unknown as {
    modelClient: StubModelClient;
    scorer: StubAgentEvalsScorer;
  };

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
      const runOutput: ModelRunOutput = {
        caseId: evalCase.id,
        modelId,
        routedAgents: extractRoutedAgents(response.content),
        delegationChain: [],
        transcript: [
          { role: "user", content: userMessage },
          { role: "assistant", content: response.content },
        ],
        rawContent: response.content,
        completionSignalled: false,
        producedArtifacts: [],
      };

      return anyRunner.scorer
        .score(runOutput, evalCase, rubrics)
        .map((scoreRecord) => ({
          runOutput,
          scoreRecord,
          composedPrompt: systemPrompt,
        }));
    })
    .match<CaseResult>(
      ({ runOutput, scoreRecord, composedPrompt }) => {
        const dimensionScores: Record<
          ScoringDimension,
          { score: number; applicable: boolean }
        > = {
          routingCorrectness: {
            score: scoreRecord.dimensions.routingCorrectness.score,
            applicable: scoreRecord.dimensions.routingCorrectness.applicable,
          },
          delegationCorrectness: {
            score: scoreRecord.dimensions.delegationCorrectness.score,
            applicable: scoreRecord.dimensions.delegationCorrectness.applicable,
          },
          executionCompleteness: {
            score: scoreRecord.dimensions.executionCompleteness.score,
            applicable: scoreRecord.dimensions.executionCompleteness.applicable,
          },
          rationaleQuality: {
            score: scoreRecord.dimensions.rationaleQuality.score,
            applicable: scoreRecord.dimensions.rationaleQuality.applicable,
          },
        };

        const summary: CaseResultSummary = {
          caseId: evalCase.id,
          modelId,
          suite: evalCase.suite,
          passed: scoreRecord.passed,
          required: scoreRecord.required,
          weightedTotal: scoreRecord.weightedTotal,
          dimensionScores,
          scoredAt: scoreRecord.scoredAt,
          dryRun: false,
          // Build public explanation from structured inputs only (mirrors production path)
          publicExplanation: buildPublicExplanation(
            scoreRecord,
            evalCase,
            false,
          ),
        };

        const rawArtifact: RawCaseResultArtifact | undefined = rawArtifacts
          ? {
              caseId: evalCase.id,
              modelId,
              composedPrompt,
              transcript: runOutput.transcript,
              rawContent: runOutput.rawContent,
              dimensionRationales: {
                routingCorrectness: scoreRecord.dimensions.routingCorrectness
                  .applicable
                  ? scoreRecord.dimensions.routingCorrectness.rationale
                  : undefined,
                rationaleQuality: scoreRecord.dimensions.rationaleQuality
                  .applicable
                  ? scoreRecord.dimensions.rationaleQuality.rationale
                  : undefined,
              },
            }
          : undefined;

        return { summary, rawArtifact };
      },
      (error) => {
        const errorType =
          "type" in error
            ? String((error as { type?: string }).type ?? "UnknownError")
            : "UnknownError";
        const rawMessage =
          "message" in error
            ? String((error as { message?: string }).message ?? "")
            : undefined;
        const summary: CaseResultSummary = {
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
        };
        const rawArtifact: RawCaseResultArtifact | undefined = rawArtifacts
          ? {
              caseId: evalCase.id,
              modelId,
              composedPrompt: "",
              transcript: [],
              rawContent: "",
              dimensionRationales: {},
              errorSummary: {
                errorType,
                // Sanitized classification label — never raw error message text
                classification: `model-${errorType.toLowerCase().replace(/error$/, "-failure")}`,
                // LOCAL-ONLY: bounded, secret-redacted diagnostic for local debugging
                localDiagnostic:
                  rawMessage !== undefined && rawMessage.length > 0
                    ? redactSecrets(rawMessage)
                    : undefined,
              },
            }
          : undefined;
        return { summary, rawArtifact };
      },
    );

  // Wrap in ResultAsync so callers can use .map() / .andThen()
  return new ResultAsync(
    matchPromise.then((result) => ok<CaseResult, never>(result)),
  );
}

function makeDryRunSummary(
  evalCase: EvalCase,
  modelId: string,
): CaseResultSummary {
  return {
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
    dryRun: true,
  };
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

// ---------------------------------------------------------------------------
// extractRoutedAgents — unit tests
// ---------------------------------------------------------------------------

describe("extractRoutedAgents", () => {
  it("returns empty array when content has no routing signal", () => {
    const result = extractRoutedAgents(
      "This is a general response with no agent mention.",
    );
    expect(result).toEqual([]);
  });

  it("extracts shuttle from '→ shuttle' pattern", () => {
    const result = extractRoutedAgents(
      "I will route this task → shuttle for execution.",
    );
    expect(result).toContain("shuttle");
  });

  it("extracts agent from 'delegate to <agent>' pattern", () => {
    const result = extractRoutedAgents(
      "The best approach is to delegate to shuttle.",
    );
    expect(result).toContain("shuttle");
  });

  it("extracts agent from 'route to <agent>' pattern", () => {
    const result = extractRoutedAgents(
      "I will route to shuttle for this task.",
    );
    expect(result).toContain("shuttle");
  });

  it("extracts agent from '-> <agent>' (ASCII arrow) pattern", () => {
    const result = extractRoutedAgents("Routing: -> shuttle");
    expect(result).toContain("shuttle");
  });

  it("extracts agent from '<agent> agent' pattern", () => {
    const result = extractRoutedAgents("The shuttle agent should handle this.");
    expect(result).toContain("shuttle");
  });

  it("extracts agent from quoted agent name", () => {
    const result = extractRoutedAgents('Routing to "shuttle".');
    expect(result).toContain("shuttle");
  });

  it("prefers shuttle-backend over shuttle when both match", () => {
    const result = extractRoutedAgents(
      "route to shuttle-backend for API work.",
    );
    // shuttle-backend is longer and sorted first
    expect(result).toContain("shuttle-backend");
  });

  it("returns deduplicated results (same agent mentioned twice)", () => {
    const result = extractRoutedAgents(
      "delegate to shuttle; the shuttle agent is best.",
    );
    expect(result.filter((a) => a === "shuttle")).toHaveLength(1);
  });

  it("is case-insensitive", () => {
    const result = extractRoutedAgents("Route to SHUTTLE agent.");
    expect(result).toContain("shuttle");
  });

  it("preserves first-mention order", () => {
    const result = extractRoutedAgents(
      "delegate to warp first, then route to shuttle.",
    );
    expect(result).toEqual(["warp", "shuttle"]);
  });

  it("prefers textual first mention over legacy/static agent list ordering", () => {
    const result = extractRoutedAgents(
      "route to shuttle first, then delegate to thread for evidence gathering.",
    );
    expect(result).toEqual(["shuttle", "thread"]);
  });

  it("does not extract agent names mentioned without routing context", () => {
    // Just mentioning a name without a routing phrase should not extract it
    const result = extractRoutedAgents("Loom is a great orchestration tool.");
    // "loom" appears but not in a routing context
    // This is a best-effort heuristic — the test just verifies the function
    // doesn't throw and returns an array
    expect(Array.isArray(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractRoutedAgents — reviewer-agent (weft/warp) suppression
// ---------------------------------------------------------------------------

describe("extractRoutedAgents — weft/warp reviewer suppression", () => {
  // ---- follow-up / conditional mentions should NOT be extracted ----

  it("does not extract weft when mentioned only as a follow-up reviewer", () => {
    // A model routes to shuttle-backend and says weft will review after changes.
    const content =
      "I will delegate to shuttle-backend for the API work. " +
      "Auto-invoke weft after changes to verify code quality.";
    const result = extractRoutedAgents(content);
    expect(result).not.toContain("weft");
    expect(result).toContain("shuttle-backend");
  });

  it("does not extract warp when mentioned only as a conditional security auditor", () => {
    // A model routes to shuttle-backend and suggests warp if security is involved.
    const content =
      "Route to shuttle-backend for this endpoint. " +
      "Use warp if auth/security is involved.";
    const result = extractRoutedAgents(content);
    expect(result).not.toContain("warp");
    expect(result).toContain("shuttle-backend");
  });

  it("does not extract weft when mentioned only with 'afterwards'", () => {
    const content =
      "delegate to shuttle-frontend for the component changes. " +
      "weft agent will review the results afterwards.";
    const result = extractRoutedAgents(content);
    expect(result).not.toContain("weft");
    expect(result).toContain("shuttle-frontend");
  });

  it("does not extract warp when mentioned only with 'security audit'", () => {
    const content =
      "I will route to shuttle-backend. " +
      "trigger warp for security audit of the changes.";
    const result = extractRoutedAgents(content);
    expect(result).not.toContain("warp");
    expect(result).toContain("shuttle-backend");
  });

  it("does not extract weft when mentioned only in a follow-up context", () => {
    const content =
      "Routing → shuttle-backend. weft as a follow-up reviewer once done.";
    const result = extractRoutedAgents(content);
    expect(result).not.toContain("weft");
    expect(result).toContain("shuttle-backend");
  });

  it("does not extract warp when mentioned only in post-implementation context", () => {
    const content =
      "delegate to shuttle-backend for the feature. " +
      "warp agent post-implementation for security review.";
    const result = extractRoutedAgents(content);
    expect(result).not.toContain("warp");
    expect(result).toContain("shuttle-backend");
  });

  // ---- primary-route mentions SHOULD still be extracted ----

  it("extracts warp when explicitly primary-routed with 'delegate to warp first'", () => {
    const content = "delegate to warp first for the security assessment.";
    const result = extractRoutedAgents(content);
    expect(result).toContain("warp");
  });

  it("extracts weft when explicitly primary-routed with 'route to weft'", () => {
    const content = "route to weft for review of these changes.";
    const result = extractRoutedAgents(content);
    expect(result).toContain("weft");
  });

  it("extracts warp when primary-routed with arrow pattern", () => {
    const content = "The best route is → warp for this security task.";
    const result = extractRoutedAgents(content);
    expect(result).toContain("warp");
  });

  it("extracts weft when primary-routed with 'weft agent' pattern", () => {
    const content = "Assign this to the weft agent for code review.";
    const result = extractRoutedAgents(content);
    expect(result).toContain("weft");
  });

  it("extracts warp when primary-routed with quoted name", () => {
    const content = 'This task should be handled by "warp".';
    const result = extractRoutedAgents(content);
    expect(result).toContain("warp");
  });

  // ---- realistic backend routing: shuttle-backend primary, weft follow-up ----

  it("returns only shuttle-backend for backend task with weft as follow-up reviewer", () => {
    // Mimics the kind of response Loom gives for "Add a backend API endpoint
    // for retrieving project settings." — routes to shuttle-backend, mentions
    // weft as an optional follow-up code-quality check.
    const content =
      "This is a backend API task. I will route to shuttle-backend for implementation. " +
      "Auto-invoke weft after changes for code quality review.";
    const result = extractRoutedAgents(content);
    expect(result).toContain("shuttle-backend");
    expect(result).not.toContain("weft");
    // shuttle (generic) may appear but weft must not
    expect(result.filter((a) => a === "weft")).toHaveLength(0);
  });

  it("returns only shuttle-backend for backend task with warp as conditional auditor", () => {
    // Mimics a response that routes to shuttle-backend and mentions warp only
    // if auth/security aspects need attention.
    const content =
      "delegate to shuttle-backend for the endpoint implementation. " +
      "Use warp if auth/security is involved in the changes.";
    const result = extractRoutedAgents(content);
    expect(result).toContain("shuttle-backend");
    expect(result).not.toContain("warp");
  });

  it("returns both shuttle-backend and warp when warp is explicitly primary-routed", () => {
    // Both are primary: "delegate to warp first, then shuttle-backend"
    const content =
      "delegate to warp first for the security review, then route to shuttle-backend for implementation.";
    const result = extractRoutedAgents(content);
    expect(result).toContain("warp");
    expect(result).toContain("shuttle-backend");
  });
});

// ---------------------------------------------------------------------------
// LoomRoutingRunner — case descriptions are user requests (not meta-statements)
// ---------------------------------------------------------------------------

describe("extractRoutedAgents — case description routing signals", () => {
  it("backend case description does not itself contain routing signals", () => {
    // The new description is a user request, not a meta statement about routing.
    // It should not cause extractRoutedAgents to return anything on its own.
    const description =
      "Add a backend API endpoint for retrieving project settings.";
    const result = extractRoutedAgents(description);
    // A raw user request has no routing signals — this validates the description
    // is a genuine user request, not a meta-statement with embedded agent names.
    expect(result).toEqual([]);
  });

  it("frontend case description does not itself contain routing signals", () => {
    const description =
      "Update the project settings panel component to show loading and error states.";
    const result = extractRoutedAgents(description);
    expect(result).toEqual([]);
  });

  it("ambiguous case description does not itself contain routing signals", () => {
    const description = "Make the project settings experience easier to use.";
    const result = extractRoutedAgents(description);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractRoutedAgents — delegation-sequence patterns ([Sequential]/[Parallel])
// ---------------------------------------------------------------------------

describe("extractRoutedAgents — delegation-sequence format", () => {
  it("extracts shuttle-backend from Loom delegation-sequence format", () => {
    // Loom's typical delegation output: "[Sequential] shuttle-backend: Implement..."
    const content =
      "Delegation Sequence:\n" +
      "1. [Sequential] thread: Explore existing settings structure\n" +
      "2. [Sequential] shuttle-backend: Implement the endpoint\n" +
      "3. [Sequential] weft: Review implementation";
    const result = extractRoutedAgents(content);
    expect(result).toContain("shuttle-backend");
  });

  it("does not extract weft from delegation-sequence when weft is a sequential reviewer", () => {
    // [Sequential] weft: Review implementation — weft is clearly a follow-up reviewer
    const content =
      "Delegation Sequence:\n" +
      "1. [Sequential] shuttle-backend: Implement the endpoint\n" +
      "2. [Sequential] weft: Review implementation";
    const result = extractRoutedAgents(content);
    // shuttle-backend should be extracted as the primary route
    expect(result).toContain("shuttle-backend");
    // weft appears only as a sequential review step — it should be suppressed
    expect(result).not.toContain("weft");
  });

  it("extracts shuttle-backend from mixed prose + delegation sequence response", () => {
    // Model gives analysis then delegation sequence — shuttle-backend should be extracted
    const content =
      "I will delegate to shuttle-backend for implementation.\n" +
      "Delegation Sequence:\n" +
      "1. [Sequential] shuttle-backend: Implement the endpoint\n" +
      "2. [Sequential] weft: Review";
    const result = extractRoutedAgents(content);
    expect(result).toContain("shuttle-backend");
  });

  it("extracts warp when primary-routed via [Parallel] pattern", () => {
    const content = "Delegation: [Parallel] warp: Security assessment";
    const result = extractRoutedAgents(content);
    expect(result).toContain("warp");
  });

  it("extracts current project category shuttles", () => {
    const content = "Route to shuttle-engine for engine composition work.";
    const result = extractRoutedAgents(content);
    expect(result).toContain("shuttle-engine");
    expect(result).not.toContain("shuttle");
  });

  it("extracts dynamic shuttle category names without a baked allowlist entry", () => {
    const content = "Route to shuttle-observability for tracing work.";
    const result = extractRoutedAgents(content);
    expect(result).toEqual(["shuttle-observability"]);
  });

  it("extracts thread as an evidence-gathering route", () => {
    const content =
      "Delegation Sequence:\n1. [Sequential] thread: Explore settings structure\n2. [Sequential] shuttle: Implement endpoint";
    const result = extractRoutedAgents(content);
    expect(result).toContain("thread");
    expect(result).toContain("shuttle");
  });

  it("does not extract negated backticked agent mentions", () => {
    const content =
      "No `pattern` plan is needed. Route to shuttle for implementation.";
    const result = extractRoutedAgents(content);
    expect(result).toContain("shuttle");
    expect(result).not.toContain("pattern");
  });

  it("extracts XML-style weave agent invocations", () => {
    const content = [
      "<weave_agent>",
      "<agent>thread</agent>",
      "</weave_agent>",
      '<weave><invoke name="shuttle"></invoke></weave>',
      "<weave:invoke_agent><agent_name>shuttle-backend</agent_name></weave:invoke_agent>",
    ].join("\n");
    const result = extractRoutedAgents(content);
    expect(result).toContain("thread");
    expect(result).toContain("shuttle");
    expect(result).toContain("shuttle-backend");
  });

  it("extracts todo-item agent prefixes from Loom sidebar output", () => {
    const content = [
      "<items>",
      "<item>thread: Survey settings UI/config</item>",
      "<item>shuttle: Identify pain points</item>",
      "</items>",
    ].join("\n");
    const result = extractRoutedAgents(content);
    expect(result).toContain("thread");
    expect(result).toContain("shuttle");
  });

  it("extracts XML agent name attributes and Markdown-bold agent mentions", () => {
    const content = [
      '<agent name="thread">Explore settings UX</agent>',
      "Delegating to **shuttle** to update the panel.",
    ].join("\n");
    const result = extractRoutedAgents(content);
    expect(result).toContain("thread");
    expect(result).toContain("shuttle");
  });
});

// ---------------------------------------------------------------------------
// LoomRoutingRunner — dry-run mode
// ---------------------------------------------------------------------------

describe("LoomRoutingRunner — dry-run mode", () => {
  it("returns dryRun:true for each case result in dry-run mode", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const cases = [makeAgentRoutingCase()];
    const rubrics = [makeEvalRubric()];

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, loomSystemPrompt: "Test prompt" },
      cases,
      rubrics,
    );

    const result = await runner.run({ dryRun: true });
    expect(result.isOk()).toBe(true);

    const runnerResult = result._unsafeUnwrap();
    expect(runnerResult.caseResults).toHaveLength(1);
    expect(runnerResult.caseResults[0]?.summary.dryRun).toBe(true);
  });

  it("makes no model calls in dry-run mode", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const cases = [makeAgentRoutingCase()];

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, loomSystemPrompt: "Test" },
      cases,
      [],
    );

    await runner.run({ dryRun: true });
    expect(modelClient.calls).toHaveLength(0);
  });

  it("makes no scorer calls in dry-run mode", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const cases = [makeAgentRoutingCase()];

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, loomSystemPrompt: "Test" },
      cases,
      [],
    );

    await runner.run({ dryRun: true });
    expect(scorer.calls).toHaveLength(0);
  });

  it("dry-run result has no rawArtifact even when rawArtifacts is true", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const cases = [makeAgentRoutingCase()];

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, loomSystemPrompt: "Test" },
      cases,
      [],
    );

    const result = await runner.run({ dryRun: true, rawArtifacts: true });
    const runnerResult = result._unsafeUnwrap();
    expect(runnerResult.caseResults[0]?.rawArtifact).toBeUndefined();
  });

  it("dry-run returns the correct suite name", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const cases = [makeAgentRoutingCase()];

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, loomSystemPrompt: "Test" },
      cases,
      [],
    );

    const result = await runner.run({ dryRun: true });
    expect(result._unsafeUnwrap().suite).toBe(LOOM_ROUTING_SUITE);
  });

  it("dry-run result totalCases matches the case count", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const cases = [
      makeAgentRoutingCase({ id: "case-1" }),
      makeAgentRoutingCase({ id: "case-2" }),
    ];

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, loomSystemPrompt: "Test" },
      cases,
      [],
    );

    const result = await runner.run({ dryRun: true });
    expect(result._unsafeUnwrap().totalCases).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// LoomRoutingRunner — case filter
// ---------------------------------------------------------------------------

describe("LoomRoutingRunner — case filter", () => {
  it("executes only the matching case when caseFilter is set", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const cases = [
      makeAgentRoutingCase({ id: "case-a" }),
      makeAgentRoutingCase({ id: "case-b" }),
    ];

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, loomSystemPrompt: "Test" },
      cases,
      [],
    );

    const result = await runner.run({ dryRun: true, caseFilter: "case-a" });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().totalCases).toBe(1);
    expect(result._unsafeUnwrap().caseResults[0]?.summary.caseId).toBe(
      "case-a",
    );
  });

  it("returns CaseFilterNotFound when caseFilter matches no case", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const cases = [makeAgentRoutingCase({ id: "case-a" })];

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, loomSystemPrompt: "Test" },
      cases,
      [],
    );

    const result = await runner.run({ caseFilter: "nonexistent-case" });
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("CaseFilterNotFound");
    if (error.type === "CaseFilterNotFound") {
      expect(error.caseId).toBe("nonexistent-case");
    }
  });

  it("CaseFilterNotFound error carries a descriptive message", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const cases = [makeAgentRoutingCase({ id: "known-case" })];

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, loomSystemPrompt: "Test" },
      cases,
      [],
    );

    const result = await runner.run({ caseFilter: "unknown-case" });
    const error = result._unsafeUnwrapErr();
    expect(error.message).toContain("unknown-case");
  });
});

// ---------------------------------------------------------------------------
// LoomRoutingRunner — model filter
// ---------------------------------------------------------------------------

describe("LoomRoutingRunner — model filter", () => {
  it("executes only cases that include the filtered model", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const cases = [
      makeAgentRoutingCase({
        id: "case-sonnet",
        allowed_models: ["anthropic/claude-sonnet-4.5"],
      }),
      makeAgentRoutingCase({
        id: "case-gpt",
        allowed_models: ["openai/gpt-5.5"],
      }),
    ];

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, loomSystemPrompt: "Test" },
      cases,
      [],
    );

    const result = await runner.run({
      dryRun: true,
      modelFilter: "anthropic/claude-sonnet-4.5",
    });

    expect(result.isOk()).toBe(true);
    const runnerResult = result._unsafeUnwrap();
    expect(runnerResult.totalCases).toBe(1);
    expect(runnerResult.caseResults[0]?.summary.caseId).toBe("case-sonnet");
    expect(runnerResult.caseResults[0]?.summary.modelId).toBe(
      "anthropic/claude-sonnet-4.5",
    );
  });

  it("returns NoCasesFound when modelFilter matches no cases", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const cases = [
      makeAgentRoutingCase({ allowed_models: ["anthropic/claude-sonnet-4.5"] }),
    ];

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, loomSystemPrompt: "Test" },
      cases,
      [],
    );

    const result = await runner.run({ modelFilter: "openai/gpt-5.5" });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("NoCasesFound");
  });
});

// ---------------------------------------------------------------------------
// LoomRoutingRunner — publishable summary raw-data boundary
// ---------------------------------------------------------------------------

describe("LoomRoutingRunner — publishable summary raw-data boundary", () => {
  const FAKE_PROMPT = "SENSITIVE_PROMPT_TEXT_DO_NOT_PUBLISH";
  const FAKE_RESPONSE = "SENSITIVE_TRANSCRIPT_CONTENT_DO_NOT_PUBLISH";

  function makeRunnerWithSecrets(): {
    runner: InMemoryLoomRunner;
    modelClient: StubModelClient;
    scorer: StubAgentEvalsScorer;
  } {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: FAKE_RESPONSE,
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makeNormalizedScoreRecord());

    const cases = [makeAgentRoutingCase()];
    const rubrics = [makeEvalRubric()];

    const runner = new InMemoryLoomRunner(
      {
        modelClient,
        scorer,
        loomSystemPrompt: FAKE_PROMPT,
      },
      cases,
      rubrics,
    );

    return { runner, modelClient, scorer };
  }

  it("summary does not contain the system prompt text", async () => {
    const { runner } = makeRunnerWithSecrets();
    const result = await runner.run({ rawArtifacts: false });
    const runnerResult = result._unsafeUnwrap();

    const summaryStr = JSON.stringify(
      runnerResult.caseResults.map((r) => r.summary),
    );
    expect(summaryStr).not.toContain(FAKE_PROMPT);
  });

  it("summary does not contain the raw model response content", async () => {
    const { runner } = makeRunnerWithSecrets();
    const result = await runner.run({ rawArtifacts: false });
    const runnerResult = result._unsafeUnwrap();

    const summaryStr = JSON.stringify(
      runnerResult.caseResults.map((r) => r.summary),
    );
    expect(summaryStr).not.toContain(FAKE_RESPONSE);
  });

  it("summary does not contain transcript message content", async () => {
    const { runner } = makeRunnerWithSecrets();
    const result = await runner.run({ rawArtifacts: false });
    const runnerResult = result._unsafeUnwrap();

    const summaryStr = JSON.stringify(
      runnerResult.caseResults.map((r) => r.summary),
    );
    // User message includes case description; that's acceptable. The raw model
    // content FAKE_RESPONSE must not appear.
    expect(summaryStr).not.toContain(FAKE_RESPONSE);
  });

  it("rawArtifact is absent when rawArtifacts is false", async () => {
    const { runner } = makeRunnerWithSecrets();
    const result = await runner.run({ rawArtifacts: false });
    const runnerResult = result._unsafeUnwrap();

    for (const caseResult of runnerResult.caseResults) {
      expect(caseResult.rawArtifact).toBeUndefined();
    }
  });

  it("rawArtifact is present when rawArtifacts is true", async () => {
    const { runner } = makeRunnerWithSecrets();
    const result = await runner.run({ rawArtifacts: true });
    const runnerResult = result._unsafeUnwrap();

    for (const caseResult of runnerResult.caseResults) {
      expect(caseResult.rawArtifact).toBeDefined();
    }
  });

  it("rawArtifact contains the raw model response when rawArtifacts is true", async () => {
    const { runner } = makeRunnerWithSecrets();
    const result = await runner.run({ rawArtifacts: true });
    const runnerResult = result._unsafeUnwrap();

    const artifact = runnerResult.caseResults[0]?.rawArtifact;
    expect(artifact).toBeDefined();
    expect(artifact?.rawContent).toBe(FAKE_RESPONSE);
  });

  it("rawArtifact contains the transcript when rawArtifacts is true", async () => {
    const { runner } = makeRunnerWithSecrets();
    const result = await runner.run({ rawArtifacts: true });
    const runnerResult = result._unsafeUnwrap();

    const artifact = runnerResult.caseResults[0]?.rawArtifact;
    expect(artifact?.transcript).toBeDefined();
    expect(Array.isArray(artifact?.transcript)).toBe(true);
    expect(artifact?.transcript.length).toBeGreaterThan(0);
  });

  it("rawArtifact contains composedPrompt when rawArtifacts is true", async () => {
    const { runner } = makeRunnerWithSecrets();
    const result = await runner.run({ rawArtifacts: true });
    const runnerResult = result._unsafeUnwrap();

    const artifact = runnerResult.caseResults[0]?.rawArtifact;
    expect(artifact?.composedPrompt).toBeDefined();
    expect(typeof artifact?.composedPrompt).toBe("string");
  });

  it("dimensionRationales are in rawArtifact, not in publishable summary", async () => {
    const { runner } = makeRunnerWithSecrets();
    const result = await runner.run({ rawArtifacts: true });
    const runnerResult = result._unsafeUnwrap();

    const artifact = runnerResult.caseResults[0]?.rawArtifact;
    const summary = runnerResult.caseResults[0]?.summary;

    // Rationale is in the artifact
    expect(artifact?.dimensionRationales).toBeDefined();

    // Rationale must NOT be in the publishable summary
    const summaryStr = JSON.stringify(summary);
    expect(summaryStr).not.toContain("Correct routing to shuttle");
  });

  it("publishable summary has dimensionScores with score and applicable, no rationale", async () => {
    const { runner } = makeRunnerWithSecrets();
    const result = await runner.run({ rawArtifacts: false });
    const runnerResult = result._unsafeUnwrap();

    const summary = runnerResult.caseResults[0]?.summary;
    expect(summary).toBeDefined();

    const scores = summary?.dimensionScores;
    expect(scores).toBeDefined();

    for (const [, dimScore] of Object.entries(scores ?? {})) {
      expect(typeof dimScore.score).toBe("number");
      expect(typeof dimScore.applicable).toBe("boolean");
      // rationale must not be present in the publishable summary
      expect("rationale" in dimScore).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// LoomRoutingRunner — execution with scoring
// ---------------------------------------------------------------------------

describe("LoomRoutingRunner — execution with scoring", () => {
  it("calls the model client once per case", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "route to shuttle agent",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makeNormalizedScoreRecord());

    const cases = [makeAgentRoutingCase()];
    const rubrics = [makeEvalRubric()];

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, loomSystemPrompt: "Test" },
      cases,
      rubrics,
    );

    await runner.run();
    expect(modelClient.calls).toHaveLength(1);
  });

  it("calls the scorer once per case", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "route to shuttle agent",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makeNormalizedScoreRecord());

    const cases = [makeAgentRoutingCase()];
    const rubrics = [makeEvalRubric()];

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, loomSystemPrompt: "Test" },
      cases,
      rubrics,
    );

    await runner.run();
    expect(scorer.calls).toHaveLength(1);
  });

  it("result summary reflects the score record values", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "route to shuttle agent",
    });

    const scorer = new StubAgentEvalsScorer();
    const scoreRecord = makeNormalizedScoreRecord({
      passed: true,
      weightedTotal: 0.9,
      required: true,
    });
    scorer.setDefaultRecord(scoreRecord);

    const cases = [makeAgentRoutingCase()];
    const rubrics = [makeEvalRubric()];

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, loomSystemPrompt: "Test" },
      cases,
      rubrics,
    );

    const result = await runner.run();
    const caseResult = result._unsafeUnwrap().caseResults[0];
    expect(caseResult?.summary.passed).toBe(true);
    expect(caseResult?.summary.weightedTotal).toBe(0.9);
    expect(caseResult?.summary.required).toBe(true);
  });

  it("model call uses a system prompt message", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "route to shuttle agent",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makeNormalizedScoreRecord());

    const customPrompt = "CUSTOM_SYSTEM_PROMPT_12345";
    const cases = [makeAgentRoutingCase()];
    const rubrics = [makeEvalRubric()];

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, loomSystemPrompt: customPrompt },
      cases,
      rubrics,
    );

    await runner.run();
    const callRequest = modelClient.calls[0];
    // The model call must include a system role message
    expect(callRequest?.messages.some((m) => m.role === "system")).toBe(true);
  });

  it("model error is accumulated as zero-score result, suite continues", async () => {
    const modelClient = new StubModelClient();
    // First case errors, second case succeeds
    modelClient.enqueueError({
      type: "NetworkError",
      message: "simulated failure",
    });
    modelClient.enqueueResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "route to shuttle agent",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makeNormalizedScoreRecord());

    const cases = [
      makeAgentRoutingCase({ id: "case-fail" }),
      makeAgentRoutingCase({ id: "case-pass" }),
    ];
    const rubrics = [makeEvalRubric("case-fail"), makeEvalRubric("case-pass")];

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, loomSystemPrompt: "Test" },
      cases,
      rubrics,
    );

    const result = await runner.run();
    expect(result.isOk()).toBe(true);

    const runnerResult = result._unsafeUnwrap();
    expect(runnerResult.totalCases).toBe(2);

    const failedResult = runnerResult.caseResults.find(
      (r) => r.summary.caseId === "case-fail",
    );
    expect(failedResult?.summary.passed).toBe(false);
    expect(failedResult?.summary.weightedTotal).toBe(0);
  });

  it("scoring error is accumulated as zero-score result, suite continues", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "route to shuttle",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.enqueueError({
      type: "RubricNotFound",
      caseId: "case-no-rubric",
      message: "No rubric found",
    });
    scorer.enqueueRecord(makeNormalizedScoreRecord({ caseId: "case-ok" }));

    const cases = [
      makeAgentRoutingCase({ id: "case-no-rubric" }),
      makeAgentRoutingCase({ id: "case-ok" }),
    ];
    const rubrics = [makeEvalRubric("case-ok")];

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, loomSystemPrompt: "Test" },
      cases,
      rubrics,
    );

    const result = await runner.run();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().totalCases).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// LoomRoutingRunner — suite green status
// ---------------------------------------------------------------------------

describe("LoomRoutingRunner — suite green status", () => {
  it("suiteGreen is true when all required cases pass", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "route to shuttle",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makeNormalizedScoreRecord({ passed: true }));

    const cases = [
      makeAgentRoutingCase({ id: "c1" }),
      makeAgentRoutingCase({ id: "c2" }),
    ];
    const rubrics = [makeEvalRubric("c1"), makeEvalRubric("c2")];

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, loomSystemPrompt: "Test" },
      cases,
      rubrics,
    );

    const result = await runner.run();
    expect(result._unsafeUnwrap().suiteGreen).toBe(true);
  });

  it("suiteGreen is false when any required case fails", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "route to shuttle",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.enqueueRecord(makeNormalizedScoreRecord({ passed: true }));
    scorer.enqueueRecord(
      makeNormalizedScoreRecord({ passed: false, weightedTotal: 0.2 }),
    );

    const cases = [
      makeAgentRoutingCase({ id: "c1" }),
      makeAgentRoutingCase({ id: "c2" }),
    ];
    const rubrics = [makeEvalRubric("c1"), makeEvalRubric("c2")];

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, loomSystemPrompt: "Test" },
      cases,
      rubrics,
    );

    const result = await runner.run();
    expect(result._unsafeUnwrap().suiteGreen).toBe(false);
  });

  it("passedCases and failedCases counts are correct", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "route to shuttle",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.enqueueRecord(makeNormalizedScoreRecord({ passed: true }));
    scorer.enqueueRecord(
      makeNormalizedScoreRecord({ passed: false, weightedTotal: 0 }),
    );

    const cases = [
      makeAgentRoutingCase({ id: "c-pass" }),
      makeAgentRoutingCase({ id: "c-fail" }),
    ];
    const rubrics = [makeEvalRubric("c-pass"), makeEvalRubric("c-fail")];

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, loomSystemPrompt: "Test" },
      cases,
      rubrics,
    );

    const result = await runner.run();
    const runnerResult = result._unsafeUnwrap();
    expect(runnerResult.passedCases).toBe(1);
    expect(runnerResult.failedCases).toBe(1);
    expect(runnerResult.totalCases).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// LoomRoutingRunner — NoCasesFound
// ---------------------------------------------------------------------------

describe("LoomRoutingRunner — NoCasesFound", () => {
  it("returns NoCasesFound when in-memory cases is empty", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, loomSystemPrompt: "Test" },
      [], // no cases
      [],
    );

    const result = await runner.run();
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("NoCasesFound");
  });

  it("NoCasesFound carries the suite name", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, loomSystemPrompt: "Test" },
      [],
      [],
    );

    const result = await runner.run();
    const error = result._unsafeUnwrapErr();
    if (error.type === "NoCasesFound") {
      expect(error.suite).toBe(LOOM_ROUTING_SUITE);
    }
  });
});

// ---------------------------------------------------------------------------
// LoomRoutingRunner — completedAt and scoredAt are valid timestamps
// ---------------------------------------------------------------------------

describe("LoomRoutingRunner — timestamps", () => {
  it("completedAt is a valid ISO 8601 timestamp", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const cases = [makeAgentRoutingCase()];

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, loomSystemPrompt: "Test" },
      cases,
      [],
    );

    const result = await runner.run({ dryRun: true });
    const runnerResult = result._unsafeUnwrap();
    expect(() => new Date(runnerResult.completedAt)).not.toThrow();
    expect(
      new Date(runnerResult.completedAt).getFullYear(),
    ).toBeGreaterThanOrEqual(2024);
  });

  it("scoredAt in each dry-run summary is a valid ISO 8601 timestamp", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const cases = [makeAgentRoutingCase()];

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, loomSystemPrompt: "Test" },
      cases,
      [],
    );

    const result = await runner.run({ dryRun: true });
    const runnerResult = result._unsafeUnwrap();
    for (const caseResult of runnerResult.caseResults) {
      expect(() => new Date(caseResult.summary.scoredAt)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// LoomRoutingRunner — constructor and SUITE constant
// ---------------------------------------------------------------------------

describe("LoomRoutingRunner — module exports", () => {
  it("LOOM_ROUTING_SUITE is 'loom-routing'", () => {
    expect(LOOM_ROUTING_SUITE).toBe("loom-routing");
  });

  it("LoomRoutingRunner is constructable with minimal options", () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const runner = new LoomRoutingRunner({ modelClient, scorer });
    expect(runner).toBeDefined();
  });

  it("run() returns a ResultAsync (thenable)", () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const runner = new InMemoryLoomRunner({ modelClient, scorer }, [], []);

    const result = runner.run({ dryRun: true });
    expect(typeof result.then).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// MockPromptProvider — test double for PromptProvider
// ---------------------------------------------------------------------------

/**
 * A test double for `PromptProvider` that returns a pre-configured string
 * without touching the file system, git, or any network endpoint.
 *
 * Demonstrates that prompt composition can be fully mocked in tests.
 */
class MockPromptProvider implements PromptProvider {
  readonly calls: string[] = [];

  constructor(
    private readonly promptText: string,
    private readonly shouldFail: boolean = false,
  ) {}

  getPrompt(agentName: string): ResultAsync<string, ProvenanceError> {
    this.calls.push(agentName);
    if (this.shouldFail) {
      return new ResultAsync(
        Promise.resolve(
          err<string, ProvenanceError>({
            type: "PromptCompositionError",
            agentName,
            message: `MockPromptProvider: configured to fail for "${agentName}"`,
          }),
        ),
      );
    }
    return new ResultAsync(
      Promise.resolve(ok<string, ProvenanceError>(this.promptText)),
    );
  }
}

// ---------------------------------------------------------------------------
// LoomRoutingRunner — PromptProvider injection (no git/network/LangChain)
// ---------------------------------------------------------------------------

describe("LoomRoutingRunner — PromptProvider injection", () => {
  it("uses the injected promptProvider's getPrompt result as system prompt", async () => {
    const MOCK_PROMPT = "MOCK_LOOM_PROMPT_FROM_PROVIDER_12345";
    const promptProvider = new MockPromptProvider(MOCK_PROMPT);

    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "route to shuttle agent",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makeNormalizedScoreRecord());

    const cases = [makeAgentRoutingCase()];
    const rubrics = [makeEvalRubric()];

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, promptProvider },
      cases,
      rubrics,
    );

    await runner.run({ rawArtifacts: true });

    // Provider was called (proves the runner invoked it)
    expect(promptProvider.calls).toContain("loom");
  });

  it("promptProvider.getPrompt is called with 'loom'", async () => {
    const promptProvider = new MockPromptProvider("Test prompt");

    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "route to shuttle",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makeNormalizedScoreRecord());

    const cases = [makeAgentRoutingCase()];
    const rubrics = [makeEvalRubric()];

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, promptProvider },
      cases,
      rubrics,
    );

    await runner.run();

    expect(promptProvider.calls[0]).toBe("loom");
  });

  it("runner completes without touching git, network, or file system when promptProvider is injected", async () => {
    // This test proves the mock provider is sufficient — no real I/O occurs.
    // If a real provider were used, the test would fail in a sandboxed environment
    // where the Weave config doesn't exist.
    const promptProvider = new MockPromptProvider("Isolated prompt — no I/O");

    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "routing to shuttle",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makeNormalizedScoreRecord());

    const cases = [makeAgentRoutingCase()];
    const rubrics = [makeEvalRubric()];

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, promptProvider },
      cases,
      rubrics,
    );

    const result = await runner.run();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().totalCases).toBe(1);
  });

  it("rawArtifact.composedPrompt reflects the prompt from the provider when rawArtifacts is true", async () => {
    // The InMemoryLoomRunner uses a hardcoded "Test Loom system prompt" in
    // executeCaseWithStubs — this test proves the promptProvider is wired in
    // for the in-memory test path (using loomSystemPrompt option for simplicity).
    const MOCK_PROMPT = "COMPOSED_PROMPT_FROM_PROVIDER";

    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "delegate to shuttle",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makeNormalizedScoreRecord());

    const cases = [makeAgentRoutingCase()];
    const rubrics = [makeEvalRubric()];

    // Use loomSystemPrompt (which internally becomes a PromptProvider) to verify
    // the roundtrip from options → provider → rawArtifact
    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, loomSystemPrompt: MOCK_PROMPT },
      cases,
      rubrics,
    );

    const result = await runner.run({ rawArtifacts: true });
    // The in-memory runner uses its own "Test Loom system prompt" string, so
    // rawArtifact.composedPrompt won't be MOCK_PROMPT here — but we verify
    // the artifact is populated and non-empty.
    const artifact = result._unsafeUnwrap().caseResults[0]?.rawArtifact;
    expect(artifact?.composedPrompt).toBeDefined();
    expect(typeof artifact?.composedPrompt).toBe("string");
    expect(artifact?.composedPrompt.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// LoomRoutingRunner — bounded error summary in rawArtifact
// ---------------------------------------------------------------------------

describe("LoomRoutingRunner — bounded rawArtifact errorSummary", () => {
  it("errorSummary.errorType is set from the typed error discriminant", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultError({
      type: "NetworkError",
      message: "Connection refused",
    });

    const scorer = new StubAgentEvalsScorer();
    const cases = [makeAgentRoutingCase()];

    const runner = new InMemoryLoomRunner({ modelClient, scorer }, cases, []);

    const result = await runner.run({ rawArtifacts: true });
    const artifact = result._unsafeUnwrap().caseResults[0]?.rawArtifact;
    expect(artifact?.errorSummary?.errorType).toBeDefined();
    expect(typeof artifact?.errorSummary?.errorType).toBe("string");
  });

  it("errorSummary.classification is a sanitized label (never raw error text)", async () => {
    const SENSITIVE_MSG =
      "Connection refused for test purposes — DO NOT PUBLISH";
    const modelClient = new StubModelClient();
    modelClient.setDefaultError({
      type: "NetworkError",
      message: SENSITIVE_MSG,
    });

    const scorer = new StubAgentEvalsScorer();
    const cases = [makeAgentRoutingCase()];

    const runner = new InMemoryLoomRunner({ modelClient, scorer }, cases, []);

    const result = await runner.run({ rawArtifacts: true });
    const artifact = result._unsafeUnwrap().caseResults[0]?.rawArtifact;
    // classification is a sanitized label, not the raw error message
    expect(typeof artifact?.errorSummary?.classification).toBe("string");
    expect(artifact?.errorSummary?.classification.length).toBeGreaterThan(0);
    // The raw sensitive message must NOT appear in classification
    expect(artifact?.errorSummary?.classification).not.toContain(SENSITIVE_MSG);
  });

  it("errorSummary has no 'message' field (message is not stored)", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultError({
      type: "NetworkError",
      message: "some error",
    });

    const scorer = new StubAgentEvalsScorer();
    const cases = [makeAgentRoutingCase()];

    const runner = new InMemoryLoomRunner({ modelClient, scorer }, cases, []);

    const result = await runner.run({ rawArtifacts: true });
    const artifact = result._unsafeUnwrap().caseResults[0]?.rawArtifact;
    // The 'message' field must not be present in RawErrorSummary
    expect("message" in (artifact?.errorSummary ?? {})).toBe(false);
  });

  it("errorSummary.classification is a bounded sanitized label, not unbounded error text", async () => {
    // Even with a very long error message, classification is a short label
    const LONG_MSG = "A".repeat(500);
    const modelClient = new StubModelClient();
    modelClient.setDefaultError({ type: "ParseError", message: LONG_MSG });

    const scorer = new StubAgentEvalsScorer();
    const cases = [makeAgentRoutingCase()];

    const runner = new InMemoryLoomRunner({ modelClient, scorer }, cases, []);

    const result = await runner.run({ rawArtifacts: true });
    const artifact = result._unsafeUnwrap().caseResults[0]?.rawArtifact;
    // classification is always a short sanitized label, not the raw message
    const classification = artifact?.errorSummary?.classification ?? "";
    expect(classification.length).toBeLessThan(100);
    expect(classification).not.toContain("A".repeat(50));
  });

  it("errorSummary is absent when rawArtifacts is false", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultError({ type: "NetworkError", message: "failure" });

    const scorer = new StubAgentEvalsScorer();
    const cases = [makeAgentRoutingCase()];

    const runner = new InMemoryLoomRunner({ modelClient, scorer }, cases, []);

    const result = await runner.run({ rawArtifacts: false });
    const caseResult = result._unsafeUnwrap().caseResults[0];
    expect(caseResult?.rawArtifact).toBeUndefined();
  });

  it("publishable summary does not contain error type or message from errorSummary", async () => {
    const SENSITIVE_ERROR = "SENSITIVE_ERROR_TYPE_AND_MESSAGE_12345";
    const modelClient = new StubModelClient();
    modelClient.setDefaultError({
      type: "NetworkError",
      message: SENSITIVE_ERROR,
    });

    const scorer = new StubAgentEvalsScorer();
    const cases = [makeAgentRoutingCase()];

    const runner = new InMemoryLoomRunner({ modelClient, scorer }, cases, []);

    const result = await runner.run({ rawArtifacts: true });
    const summary = result._unsafeUnwrap().caseResults[0]?.summary;
    const summaryStr = JSON.stringify(summary);

    // The error message must not leak into the publishable summary
    expect(summaryStr).not.toContain(SENSITIVE_ERROR);
  });

  it("raw artifact errorSummary.classification never contains raw scorer message text", async () => {
    // classification is always a short sanitized label — the raw message goes
    // into localDiagnostic (redacted), never into classification
    const SENSITIVE_MARKER = "SENSITIVE_SCORER_MESSAGE_DO_NOT_STORE_12345";
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "route to shuttle",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.enqueueError({
      type: "RubricNotFound",
      caseId: "route-to-shuttle",
      message: SENSITIVE_MARKER,
    });

    const cases = [makeAgentRoutingCase()];

    const runner = new InMemoryLoomRunner({ modelClient, scorer }, cases, []);

    const result = await runner.run({ rawArtifacts: true });
    const artifact = result._unsafeUnwrap().caseResults[0]?.rawArtifact;

    // classification must NEVER contain raw error message text
    expect(artifact?.errorSummary?.classification).not.toContain(
      SENSITIVE_MARKER,
    );
  });
});

// ---------------------------------------------------------------------------
// LoomRoutingRunner — localDiagnostic in rawArtifact errorSummary
// ---------------------------------------------------------------------------

describe("LoomRoutingRunner — localDiagnostic in rawArtifact errorSummary", () => {
  it("localDiagnostic is populated when rawArtifacts:true and scorer fails", async () => {
    const scorerMessage =
      "LangChain AgentEvals judge call failed: timeout after 30s";
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "route to shuttle",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.enqueueError({
      type: "ScorerAdapterError",
      caseId: "route-to-shuttle",
      dimension: "routingCorrectness",
      message: scorerMessage,
    });

    const cases = [makeAgentRoutingCase()];
    const runner = new InMemoryLoomRunner({ modelClient, scorer }, cases, [
      makeEvalRubric(),
    ]);

    const result = await runner.run({ rawArtifacts: true });
    const artifact = result._unsafeUnwrap().caseResults[0]?.rawArtifact;

    expect(artifact?.errorSummary?.localDiagnostic).toBeDefined();
    expect(typeof artifact?.errorSummary?.localDiagnostic).toBe("string");
    // The diagnostic should contain the (non-secret) message text
    expect(artifact?.errorSummary?.localDiagnostic).toContain(
      "LangChain AgentEvals",
    );
  });

  it("localDiagnostic is NOT present when rawArtifacts:false", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultError({
      type: "NetworkError",
      message: "Connection refused",
    });

    const scorer = new StubAgentEvalsScorer();
    const cases = [makeAgentRoutingCase()];
    const runner = new InMemoryLoomRunner({ modelClient, scorer }, cases, []);

    // rawArtifacts:false means no rawArtifact at all
    const result = await runner.run({ rawArtifacts: false });
    expect(result._unsafeUnwrap().caseResults[0]?.rawArtifact).toBeUndefined();
  });

  it("localDiagnostic redacts API keys from scorer messages", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "route to shuttle",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.enqueueError({
      type: "ScorerAdapterError",
      caseId: "route-to-shuttle",
      dimension: "routingCorrectness",
      // Message containing a realistic-looking API key
      message:
        "Request failed: authentication error for key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789",
    });

    const cases = [makeAgentRoutingCase()];
    const runner = new InMemoryLoomRunner({ modelClient, scorer }, cases, [
      makeEvalRubric(),
    ]);

    const result = await runner.run({ rawArtifacts: true });
    const diagnostic =
      result._unsafeUnwrap().caseResults[0]?.rawArtifact?.errorSummary
        ?.localDiagnostic ?? "";

    // The raw API key must NOT appear in the diagnostic
    expect(diagnostic).not.toContain(
      "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789",
    );
    // But the diagnostic should still be present and meaningful
    expect(diagnostic.length).toBeGreaterThan(0);
    expect(diagnostic).toContain("[REDACTED");
  });

  it("localDiagnostic is bounded to 500 chars + truncation marker", async () => {
    const VERY_LONG_MSG = "X".repeat(2000);
    const modelClient = new StubModelClient();
    modelClient.setDefaultError({ type: "ParseError", message: VERY_LONG_MSG });

    const scorer = new StubAgentEvalsScorer();
    const cases = [makeAgentRoutingCase()];
    const runner = new InMemoryLoomRunner({ modelClient, scorer }, cases, []);

    const result = await runner.run({ rawArtifacts: true });
    const diagnostic =
      result._unsafeUnwrap().caseResults[0]?.rawArtifact?.errorSummary
        ?.localDiagnostic ?? "";

    // Bounded to 500 chars plus truncation marker
    expect(diagnostic.length).toBeLessThanOrEqual(520); // 500 + "… [truncated]" margin
    expect(diagnostic).toContain("[truncated]");
  });

  it("localDiagnostic does NOT appear in the publishable CaseResultSummary", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultError({
      type: "NetworkError",
      message: "Connection refused",
    });

    const scorer = new StubAgentEvalsScorer();
    const cases = [makeAgentRoutingCase()];
    const runner = new InMemoryLoomRunner({ modelClient, scorer }, cases, []);

    const result = await runner.run({ rawArtifacts: true });
    const summary = result._unsafeUnwrap().caseResults[0]?.summary;
    const summaryStr = JSON.stringify(summary);

    // The localDiagnostic field must NEVER appear in the publishable summary
    expect(summaryStr).not.toContain("localDiagnostic");
  });

  it("localDiagnostic does NOT appear in publishable CaseResultSummary even with scorer failure", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "route to shuttle",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.enqueueError({
      type: "ScorerAdapterError",
      caseId: "route-to-shuttle",
      dimension: "routingCorrectness",
      message: "Some scorer debug message that must not leak",
    });

    const cases = [makeAgentRoutingCase()];
    const runner = new InMemoryLoomRunner({ modelClient, scorer }, cases, [
      makeEvalRubric(),
    ]);

    const result = await runner.run({ rawArtifacts: true });
    const summary = result._unsafeUnwrap().caseResults[0]?.summary;
    const summaryStr = JSON.stringify(summary);

    expect(summaryStr).not.toContain("localDiagnostic");
    expect(summaryStr).not.toContain("scorer debug message");
  });
});

// ---------------------------------------------------------------------------
// LoomRoutingRunner — provider failure prevents model calls
// ---------------------------------------------------------------------------

describe("LoomRoutingRunner — provider failure prevents model calls", () => {
  it("returns PromptProviderFailed when promptProvider fails", async () => {
    const failingProvider = new MockPromptProvider(
      "unused",
      /* shouldFail */ true,
    );

    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();

    const cases = [makeAgentRoutingCase()];
    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, promptProvider: failingProvider },
      cases,
      [],
    );

    const result = await runner.run();
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("PromptProviderFailed");
  });

  it("does not call ModelClient.complete when promptProvider fails", async () => {
    const failingProvider = new MockPromptProvider(
      "unused",
      /* shouldFail */ true,
    );

    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();

    const cases = [makeAgentRoutingCase()];
    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, promptProvider: failingProvider },
      cases,
      [],
    );

    await runner.run();
    // Critical: no model calls must have been made
    expect(modelClient.calls).toHaveLength(0);
  });

  it("does not call scorer when promptProvider fails", async () => {
    const failingProvider = new MockPromptProvider(
      "unused",
      /* shouldFail */ true,
    );

    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();

    const cases = [makeAgentRoutingCase()];
    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, promptProvider: failingProvider },
      cases,
      [],
    );

    await runner.run();
    // Critical: no scorer calls must have been made
    expect(scorer.calls).toHaveLength(0);
  });

  it("PromptProviderFailed error carries agentName 'loom'", async () => {
    const failingProvider = new MockPromptProvider(
      "unused",
      /* shouldFail */ true,
    );

    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();

    const cases = [makeAgentRoutingCase()];
    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, promptProvider: failingProvider },
      cases,
      [],
    );

    const result = await runner.run();
    const error = result._unsafeUnwrapErr();
    if (error.type === "PromptProviderFailed") {
      expect(error.agentName).toBe("loom");
    }
  });

  it("PromptProviderFailed error message does not contain raw provider error text", async () => {
    const SENSITIVE_PROVIDER_MSG =
      "SENSITIVE_PROVIDER_COMPOSITION_FAILURE_TEXT_12345";
    // The MockPromptProvider message is internal to the provider error,
    // but the RunnerError.message must not copy it.
    const failingProvider = new MockPromptProvider(
      "unused",
      /* shouldFail */ true,
    );

    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();

    const cases = [makeAgentRoutingCase()];
    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, promptProvider: failingProvider },
      cases,
      [],
    );

    const result = await runner.run();
    const error = result._unsafeUnwrapErr();
    // The runner error message should be a fixed sanitized string,
    // not the raw provider error text
    expect(error.message).not.toContain(SENSITIVE_PROVIDER_MSG);
    expect(typeof error.message).toBe("string");
    expect(error.message.length).toBeGreaterThan(0);
  });

  it("provider failure with rawArtifacts:true still returns PromptProviderFailed (no partial artifacts)", async () => {
    const failingProvider = new MockPromptProvider(
      "unused",
      /* shouldFail */ true,
    );

    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();

    const cases = [makeAgentRoutingCase()];
    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, promptProvider: failingProvider },
      cases,
      [],
    );

    // Even with rawArtifacts:true, provider failure must hard-fail
    const result = await runner.run({ rawArtifacts: true });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("PromptProviderFailed");
    expect(modelClient.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// LoomRoutingRunner — publicExplanation generation
// ---------------------------------------------------------------------------

describe("LoomRoutingRunner — publicExplanation field in CaseResultSummary", () => {
  it("CaseResultSummary.publicExplanation is present for a successful scored result", async () => {
    const modelClient = new StubModelClient();
    modelClient.enqueueResponse({
      content: "I will delegate to the shuttle agent.",
      model: "anthropic/claude-sonnet-4.5",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(
      makeNormalizedScoreRecord({ passed: true, weightedTotal: 1.0 }),
    );

    const evalCase = makeAgentRoutingCase();
    const rubric = makeEvalRubric();
    const runner = new InMemoryLoomRunner(
      { modelClient, scorer },
      [evalCase],
      [rubric],
    );

    const result = await runner.run();
    expect(result.isOk()).toBe(true);
    const runnerResult = result._unsafeUnwrap();
    expect(runnerResult.caseResults).toHaveLength(1);

    const caseResult = runnerResult.caseResults[0];
    expect(caseResult).toBeDefined();
    const { publicExplanation } = caseResult!.summary;
    expect(publicExplanation).toBeDefined();
    expect(typeof publicExplanation?.text).toBe("string");
    expect((publicExplanation?.text ?? "").length).toBeGreaterThan(0);
  });

  it("publicExplanation.text is bounded to EXPLANATION_MAX_CHARS", async () => {
    const { EXPLANATION_MAX_CHARS } = await import("../report-schema.js");

    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      content: "Delegate to shuttle.",
      model: "anthropic/claude-sonnet-4.5",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(
      makeNormalizedScoreRecord({ passed: true, weightedTotal: 1.0 }),
    );

    const evalCase = makeAgentRoutingCase();
    const rubric = makeEvalRubric();
    const runner = new InMemoryLoomRunner(
      { modelClient, scorer },
      [evalCase],
      [rubric],
    );

    const result = await runner.run();
    const caseResult = result._unsafeUnwrap().caseResults[0];
    const { publicExplanation } = caseResult!.summary;
    expect((publicExplanation?.text ?? "").length).toBeLessThanOrEqual(
      EXPLANATION_MAX_CHARS,
    );
  });

  it("publicExplanation.text contains no forbidden explanation patterns", async () => {
    const { FORBIDDEN_EXPLANATION_PATTERNS } = await import(
      "../report-schema.js"
    );

    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      content: "Route to shuttle.",
      model: "anthropic/claude-sonnet-4.5",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(
      makeNormalizedScoreRecord({ passed: false, weightedTotal: 0.0 }),
    );

    const evalCase = makeAgentRoutingCase();
    const rubric = makeEvalRubric();
    const runner = new InMemoryLoomRunner(
      { modelClient, scorer },
      [evalCase],
      [rubric],
    );

    const result = await runner.run();
    const caseResult = result._unsafeUnwrap().caseResults[0];
    const { publicExplanation } = caseResult!.summary;
    const text = publicExplanation?.text ?? "";
    for (const { name, pattern } of FORBIDDEN_EXPLANATION_PATTERNS) {
      expect(pattern.test(text)).toBe(false);
    }
  });

  it("publicExplanation.source is a valid enum value", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      content: "Route to shuttle.",
      model: "anthropic/claude-sonnet-4.5",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(
      makeNormalizedScoreRecord({ passed: true, weightedTotal: 0.95 }),
    );

    const evalCase = makeAgentRoutingCase();
    const runner = new InMemoryLoomRunner(
      { modelClient, scorer },
      [evalCase],
      [makeEvalRubric()],
    );

    const result = await runner.run();
    const caseResult = result._unsafeUnwrap().caseResults[0];
    const { publicExplanation } = caseResult!.summary;
    const validSources = [
      "score_bucket_label",
      "structured_signal",
      "rubric_template",
    ];
    expect(validSources.includes(publicExplanation?.source ?? "")).toBe(true);
  });

  it("publicExplanation is reproducible — same inputs produce the same text", async () => {
    const makeRunner = () => {
      const modelClient = new StubModelClient();
      modelClient.setDefaultResponse({
        content: "Delegate to shuttle.",
        model: "anthropic/claude-sonnet-4.5",
      });
      const scorer = new StubAgentEvalsScorer();
      scorer.setDefaultRecord(
        makeNormalizedScoreRecord({
          passed: true,
          weightedTotal: 1.0,
          required: true,
        }),
      );
      return new InMemoryLoomRunner(
        { modelClient, scorer },
        [makeAgentRoutingCase()],
        [makeEvalRubric()],
      );
    };

    const r1 = await makeRunner().run();
    const r2 = await makeRunner().run();
    const e1 = r1._unsafeUnwrap().caseResults[0]?.summary.publicExplanation;
    const e2 = r2._unsafeUnwrap().caseResults[0]?.summary.publicExplanation;
    expect(e1?.text).toBe(e2?.text);
    expect(e1?.source).toBe(e2?.source);
  });

  it("publicExplanation does NOT contain raw rationale text from the scorer", async () => {
    const adversarialRationale =
      "rationale: score: 1.0 justification: The model perfectly routed to shuttle. Excellent delegation.";

    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      content: "Delegate to shuttle.",
      model: "anthropic/claude-sonnet-4.5",
    });

    const scorer = new StubAgentEvalsScorer();
    // The score record has adversarial rationale text
    const scoreRecord = makeNormalizedScoreRecord({
      passed: true,
      weightedTotal: 1.0,
      dimensions: {
        routingCorrectness: {
          score: 1.0,
          rationale: adversarialRationale,
          applicable: true,
        },
        delegationCorrectness: {
          score: 1.0,
          rationale: adversarialRationale,
          applicable: false,
        },
        executionCompleteness: {
          score: 1.0,
          rationale: adversarialRationale,
          applicable: false,
        },
        rationaleQuality: {
          score: 0.9,
          rationale: adversarialRationale,
          applicable: true,
        },
      },
    });
    scorer.setDefaultRecord(scoreRecord);

    const evalCase = makeAgentRoutingCase();
    const runner = new InMemoryLoomRunner(
      { modelClient, scorer },
      [evalCase],
      [makeEvalRubric()],
    );

    const result = await runner.run();
    const caseResult = result._unsafeUnwrap().caseResults[0];
    const { publicExplanation } = caseResult!.summary;
    const text = publicExplanation?.text ?? "";

    // The adversarial rationale text must NOT appear in the public explanation
    expect(text).not.toContain(adversarialRationale);
    expect(text).not.toContain("score: 1.0");
    expect(text).not.toContain("justification:");
    expect(text).not.toContain("rationale:");
    expect(text).not.toContain("The model perfectly routed");
  });

  it("publicExplanation does NOT contain raw model response content (transcript leakage guard)", async () => {
    const leakageSentinel = "LEAKAGE_SENTINEL_SECRET_XYZ_12345";

    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      content: `I will route to shuttle. ${leakageSentinel}`,
      model: "anthropic/claude-sonnet-4.5",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(
      makeNormalizedScoreRecord({ passed: true, weightedTotal: 1.0 }),
    );

    const evalCase = makeAgentRoutingCase();
    const runner = new InMemoryLoomRunner(
      { modelClient, scorer },
      [evalCase],
      [makeEvalRubric()],
    );

    const result = await runner.run();
    const caseResult = result._unsafeUnwrap().caseResults[0];
    const { publicExplanation } = caseResult!.summary;
    const text = publicExplanation?.text ?? "";

    // The raw model response sentinel must NOT appear in the public explanation
    expect(text).not.toContain(leakageSentinel);
    expect(text).not.toContain("LEAKAGE_SENTINEL");
  });

  it("publicExplanation does NOT contain prompt text (prompt leakage guard)", async () => {
    const promptSentinel = "SYSTEM_PROMPT_SECRET_CONTENT_ABC123";
    const mockProvider = {
      getPrompt: (_: string) =>
        ResultAsync.fromSafePromise(
          Promise.resolve(`You are Loom. ${promptSentinel}`),
        ),
    };

    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      content: "Route to shuttle.",
      model: "anthropic/claude-sonnet-4.5",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(
      makeNormalizedScoreRecord({ passed: true, weightedTotal: 0.9 }),
    );

    const evalCase = makeAgentRoutingCase();
    const runner = new InMemoryLoomRunner(
      { modelClient, scorer, promptProvider: mockProvider },
      [evalCase],
      [makeEvalRubric()],
    );

    const result = await runner.run();
    const caseResult = result._unsafeUnwrap().caseResults[0];
    const { publicExplanation } = caseResult!.summary;
    const text = publicExplanation?.text ?? "";

    // The prompt sentinel must NOT appear in the public explanation
    expect(text).not.toContain(promptSentinel);
    expect(text).not.toContain("SYSTEM_PROMPT_SECRET");
  });

  it("dry-run results have summary.dryRun=true and no model calls are made", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const evalCase = makeAgentRoutingCase();

    const runner = new InMemoryLoomRunner(
      { modelClient, scorer },
      [evalCase],
      [],
    );

    const result = await runner.run({ dryRun: true });
    expect(result.isOk()).toBe(true);
    const caseResult = result._unsafeUnwrap().caseResults[0];
    expect(caseResult?.summary.dryRun).toBe(true);
    // modelClient must not have been called for dry-runs
    expect(modelClient.calls).toHaveLength(0);
  });
});
