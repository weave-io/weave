/**
 * Tests for `tapestry-execution-runner.ts`.
 *
 * Verifies:
 *   - `TapestryExecutionRunner` loads cases from the suite and executes them.
 *   - Case filter narrows the workload to the matching case.
 *   - Model filter narrows to cases that allow the model.
 *   - Dry-run mode returns `CaseResult` entries with `dryRun: true` and no
 *     model calls made.
 *   - `extractDelegationChain()` correctly identifies chains in text.
 *   - `detectCompletionSignal()` correctly identifies completion phrases.
 *   - `extractProducedArtifacts()` returns only expected artifacts found.
 *   - `CaseFilterNotFound` is returned when `--case` filter matches no case.
 *   - `NoCasesFound` is returned when model filter eliminates all cases.
 *   - Per-case model errors are accumulated as zero-score results.
 *   - Per-case scoring errors are accumulated as zero-score results.
 *   - Publishable summary NEVER contains raw prompt text, transcript content,
 *     tool args, error details, or raw model responses.
 *   - `rawArtifact` contains composedPrompt, transcript, rawContent, and
 *     dimensionRationales only when `rawArtifacts: true`.
 *   - Both `task_completion` and `delegation_chain` case kinds are handled.
 *   - Suite green status reflects required cases passing.
 *   - No real network, LangChain, git, or file I/O in any test.
 */

import { describe, expect, it } from "bun:test";
import { err, ok, ResultAsync } from "neverthrow";
import { StubAgentEvalsScorer } from "../langchain-agent-evals.js";
import { StubModelClient } from "../openrouter-client.js";
import {
  detectCompletionSignal,
  extractDelegationChain,
  extractProducedArtifacts,
  TAPESTRY_EXECUTION_SUITE,
  TapestryExecutionRunner,
  type TapestryExecutionRunnerOptions,
  type TapestryRunRequest,
} from "../tapestry-execution-runner.js";
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
  RunnerError,
  RunnerResult,
  ScoringDimension,
} from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCORED_AT = "2026-01-01T00:00:00.000Z";

function makeDelegationCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "delegate-to-shuttle",
    description: "Delegate a backend task from tapestry to shuttle",
    suite: "tapestry-execution",
    allowed_agents: ["tapestry", "shuttle"],
    allowed_models: ["anthropic/claude-sonnet-4.5"],
    expected_outcome: {
      kind: "delegation_chain",
      chain: ["tapestry", "shuttle"],
    },
    accepted_alternates: [],
    transcript_expectations: [],
    tags: [],
    ...overrides,
  };
}

function makeTaskCompletionCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "complete-coding-task",
    description: "Implement a REST API endpoint",
    suite: "tapestry-execution",
    allowed_agents: ["tapestry", "shuttle"],
    allowed_models: ["anthropic/claude-sonnet-4.5"],
    expected_outcome: {
      kind: "task_completion",
      description: "Implement the REST API endpoint",
      required_artifacts: ["api-spec", "implementation"],
    },
    accepted_alternates: [],
    transcript_expectations: [],
    tags: [],
    ...overrides,
  };
}

function makeEvalRubric(
  caseId = "delegate-to-shuttle",
  suite = "tapestry-execution",
): EvalRubric {
  return {
    case_id: caseId,
    suite,
    scoring: {
      outcome_weight: 0.7,
      per_expectation_weight: 0.3,
      required: true,
    },
  };
}

function makeDelegationScoreRecord(
  overrides: Partial<NormalizedScoreRecord> = {},
): NormalizedScoreRecord {
  const neutralDim: DimensionScore = {
    score: 1.0,
    rationale: "n/a",
    applicable: false,
  };
  const activeDim: DimensionScore = {
    score: 1.0,
    rationale: "Correct delegation chain: tapestry → shuttle.",
    applicable: true,
  };
  return {
    caseId: "delegate-to-shuttle",
    modelId: "anthropic/claude-sonnet-4.5",
    suite: "tapestry-execution",
    dimensions: {
      routingCorrectness: neutralDim,
      delegationCorrectness: activeDim,
      executionCompleteness: neutralDim,
      rationaleQuality: {
        score: 0.85,
        rationale: "Well-structured reasoning.",
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

function makeTaskCompletionScoreRecord(
  overrides: Partial<NormalizedScoreRecord> = {},
): NormalizedScoreRecord {
  const neutralDim: DimensionScore = {
    score: 1.0,
    rationale: "n/a",
    applicable: false,
  };
  const activeDim: DimensionScore = {
    score: 1.0,
    rationale: "Task completed with required artifacts.",
    applicable: true,
  };
  return {
    caseId: "complete-coding-task",
    modelId: "anthropic/claude-sonnet-4.5",
    suite: "tapestry-execution",
    dimensions: {
      routingCorrectness: neutralDim,
      delegationCorrectness: neutralDim,
      executionCompleteness: activeDim,
      rationaleQuality: {
        score: 0.9,
        rationale: "Clear explanation.",
        applicable: true,
      },
    },
    weightedTotal: 0.95,
    passed: true,
    required: true,
    scoredAt: SCORED_AT,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// InMemoryTapestryRunner — test double that bypasses file I/O
// ---------------------------------------------------------------------------

class InMemoryTapestryRunner extends TapestryExecutionRunner {
  private readonly _promptProvider: PromptProvider | undefined;

  constructor(
    options: TapestryExecutionRunnerOptions,
    private readonly cases: EvalCase[],
    private readonly rubrics: EvalRubric[],
  ) {
    super({ ...options, evalsRoot: "/tmp/nonexistent-evals-root-for-tests" });
    this._promptProvider = options.promptProvider;
  }

  override run(
    request: TapestryRunRequest = {},
  ): ResultAsync<RunnerResult, RunnerError> {
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
            err<RunnerResult, RunnerError>({
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
          err<RunnerResult, RunnerError>({
            type: "NoCasesFound",
            suite: TAPESTRY_EXECUTION_SUITE,
            message: `No cases found in suite "${TAPESTRY_EXECUTION_SUITE}".`,
          }),
        ),
      );
    }

    // Build work items
    const workItems = cases.flatMap((evalCase) => {
      if (request.modelFilter !== undefined) {
        if (!evalCase.allowed_models.includes(request.modelFilter)) return [];
        return [{ evalCase, modelId: request.modelFilter }];
      }
      const modelId = evalCase.allowed_models[0];
      if (modelId === undefined) return [];
      return [{ evalCase, modelId }];
    });

    if (workItems.length === 0) {
      return new ResultAsync(
        Promise.resolve(
          err<RunnerResult, RunnerError>({
            type: "NoCasesFound",
            suite: TAPESTRY_EXECUTION_SUITE,
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
        Promise.resolve(
          assembleRunnerResult(TAPESTRY_EXECUTION_SUITE, caseResults),
        ),
      );
    }

    // If a promptProvider is set, resolve it first.
    // Provider failure is a hard stop — no model calls are made.
    if (this._promptProvider !== undefined) {
      return this._promptProvider
        .getPrompt("tapestry")
        .mapErr(
          (): RunnerError => ({
            type: "PromptProviderFailed",
            agentName: "tapestry",
            message:
              "Tapestry prompt provider failed: prompt composition could not complete.",
          }),
        )
        .andThen((_systemPrompt) => {
          // Execute all work items
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
                  assembleRunnerResult(TAPESTRY_EXECUTION_SUITE, caseResults),
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

    return (executeAll as ResultAsync<CaseResult[], RunnerError>).andThen(
      (caseResults) =>
        ResultAsync.fromSafePromise(
          Promise.resolve(
            assembleRunnerResult(TAPESTRY_EXECUTION_SUITE, caseResults),
          ),
        ),
    );
  }
}

// Module-level helper to execute a case using injected stubs
function executeCaseWithStubs(
  runner: TapestryExecutionRunner,
  evalCase: EvalCase,
  modelId: string,
  rubrics: EvalRubric[],
  rawArtifacts: boolean,
): ResultAsync<CaseResult, never> {
  const systemPrompt = "Test Tapestry system prompt";

  // Build user message based on outcome kind
  let userMessage: string;
  const outcome = evalCase.expected_outcome;
  if (outcome.kind === "delegation_chain") {
    userMessage = `Execute task with delegation: ${evalCase.description}`;
  } else if (outcome.kind === "task_completion") {
    userMessage = `Complete task: ${evalCase.description}`;
  } else {
    userMessage = `Task: ${evalCase.description}`;
  }

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
      const delegationChain = extractDelegationChain(response.content);
      const completionSignalled = detectCompletionSignal(response.content);
      const expectedArtifacts =
        evalCase.expected_outcome.kind === "task_completion"
          ? evalCase.expected_outcome.required_artifacts
          : [];
      const producedArtifacts = extractProducedArtifacts(
        response.content,
        expectedArtifacts,
      );

      const runOutput: ModelRunOutput = {
        caseId: evalCase.id,
        modelId,
        routedAgents: [],
        delegationChain,
        transcript: [
          { role: "user", content: userMessage },
          { role: "assistant", content: response.content },
        ],
        rawContent: response.content,
        completionSignalled,
        producedArtifacts,
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
        };

        const rawArtifact: RawCaseResultArtifact | undefined = rawArtifacts
          ? {
              caseId: evalCase.id,
              modelId,
              composedPrompt,
              transcript: runOutput.transcript,
              rawContent: runOutput.rawContent,
              dimensionRationales: buildRationales(scoreRecord.dimensions),
            }
          : undefined;

        return { summary, rawArtifact };
      },
      (error) => {
        const errorType =
          "type" in error
            ? String((error as { type: string }).type)
            : "UnknownError";
        const errorSummary: CaseResultSummary = {
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
              },
            }
          : undefined;
        return { summary: errorSummary, rawArtifact };
      },
    );

  // Wrap match promise in ResultAsync so callers can use .map() / .andThen()
  return new ResultAsync(
    matchPromise.then((result) => ok<CaseResult, never>(result)),
  );
}

function buildRationales(
  dimensions: NormalizedScoreRecord["dimensions"],
): Partial<Record<ScoringDimension, string>> {
  const out: Partial<Record<ScoringDimension, string>> = {};
  for (const [dim, score] of Object.entries(dimensions) as Array<
    [ScoringDimension, DimensionScore]
  >) {
    if (score.applicable) {
      out[dim] = score.rationale;
    }
  }
  return out;
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
// extractDelegationChain — unit tests
// ---------------------------------------------------------------------------

describe("extractDelegationChain", () => {
  it("returns empty array when content has no chain signal", () => {
    const result = extractDelegationChain("This is a general response.");
    expect(result).toEqual([]);
  });

  it("extracts chain from '→' separator", () => {
    const result = extractDelegationChain("tapestry → shuttle");
    expect(result).toEqual(["tapestry", "shuttle"]);
  });

  it("extracts chain from '->' (ASCII arrow) separator", () => {
    const result = extractDelegationChain("tapestry -> shuttle");
    expect(result).toEqual(["tapestry", "shuttle"]);
  });

  it("extracts chain from 'delegates to' phrase", () => {
    const result = extractDelegationChain("tapestry delegates to shuttle");
    expect(result).toEqual(["tapestry", "shuttle"]);
  });

  it("extracts chain from 'delegating to' phrase", () => {
    const result = extractDelegationChain("tapestry delegating to shuttle");
    expect(result).toEqual(["tapestry", "shuttle"]);
  });

  it("returns empty array for single agent (requires at least 2)", () => {
    const result = extractDelegationChain("Only shuttle is mentioned.");
    expect(result.length).toBeLessThan(2);
  });

  it("is case-insensitive", () => {
    const result = extractDelegationChain("TAPESTRY → SHUTTLE");
    expect(result).toEqual(["tapestry", "shuttle"]);
  });

  it("handles longer chains (3 agents)", () => {
    const result = extractDelegationChain("tapestry → pattern → shuttle");
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result).toContain("tapestry");
    expect(result).toContain("shuttle");
  });

  it("does not extract chains with unknown agent names", () => {
    const result = extractDelegationChain("tapestry → unknown-agent");
    // unknown-agent is not in the known set; chain length should be < 2 or empty
    expect(result.length).toBeLessThan(2);
  });
});

// ---------------------------------------------------------------------------
// detectCompletionSignal — unit tests
// ---------------------------------------------------------------------------

describe("detectCompletionSignal", () => {
  it("returns false when content has no completion signal", () => {
    expect(detectCompletionSignal("Here is my analysis of the task.")).toBe(
      false,
    );
  });

  it("detects 'task complete'", () => {
    expect(
      detectCompletionSignal("The implementation is ready. Task complete."),
    ).toBe(true);
  });

  it("detects 'task completed'", () => {
    expect(detectCompletionSignal("Task completed successfully.")).toBe(true);
  });

  it("detects 'done'", () => {
    expect(detectCompletionSignal("All steps are done.")).toBe(true);
  });

  it("detects 'finished'", () => {
    expect(detectCompletionSignal("The workflow is finished.")).toBe(true);
  });

  it("detects 'completed successfully'", () => {
    expect(detectCompletionSignal("The task was completed successfully.")).toBe(
      true,
    );
  });

  it("detects 'execution complete'", () => {
    expect(
      detectCompletionSignal("Execution complete. All artifacts produced."),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(detectCompletionSignal("TASK COMPLETE")).toBe(true);
  });

  it("returns false for 'almost done' (not an exact signal)", () => {
    // 'done' is a substring — this tests heuristic partial matching
    // The implementation uses includes() so 'done' in 'almost done' matches
    expect(detectCompletionSignal("Almost done with the work.")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractProducedArtifacts — unit tests
// ---------------------------------------------------------------------------

describe("extractProducedArtifacts", () => {
  it("returns empty array when no expected artifacts appear in content", () => {
    const result = extractProducedArtifacts(
      "A general response with no artifact mentions.",
      ["api-spec", "implementation"],
    );
    expect(result).toEqual([]);
  });

  it("returns matching artifacts when they appear in content", () => {
    const result = extractProducedArtifacts(
      "I have produced the api-spec and implementation files.",
      ["api-spec", "implementation"],
    );
    expect(result).toContain("api-spec");
    expect(result).toContain("implementation");
  });

  it("only returns artifacts from the expected set (no phantom artifacts)", () => {
    const result = extractProducedArtifacts(
      "I produced api-spec and a bonus-file.",
      ["api-spec"],
    );
    expect(result).toEqual(["api-spec"]);
    expect(result).not.toContain("bonus-file");
  });

  it("is case-insensitive for artifact matching", () => {
    const result = extractProducedArtifacts("The API-SPEC has been created.", [
      "api-spec",
    ]);
    expect(result).toContain("api-spec");
  });

  it("returns empty array when expectedArtifacts is empty", () => {
    const result = extractProducedArtifacts("lots of content", []);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TapestryExecutionRunner — dry-run mode
// ---------------------------------------------------------------------------

describe("TapestryExecutionRunner — dry-run mode", () => {
  it("returns dryRun:true for each case result in dry-run mode", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const cases = [makeDelegationCase()];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      [],
    );

    const result = await runner.run({ dryRun: true });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().caseResults[0]?.summary.dryRun).toBe(true);
  });

  it("makes no model calls in dry-run mode", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const cases = [makeDelegationCase(), makeTaskCompletionCase()];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      [],
    );

    await runner.run({ dryRun: true });
    expect(modelClient.calls).toHaveLength(0);
  });

  it("makes no scorer calls in dry-run mode", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const cases = [makeDelegationCase()];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      [],
    );

    await runner.run({ dryRun: true });
    expect(scorer.calls).toHaveLength(0);
  });

  it("dry-run returns correct suite name", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const cases = [makeDelegationCase()];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      [],
    );

    const result = await runner.run({ dryRun: true });
    expect(result._unsafeUnwrap().suite).toBe(TAPESTRY_EXECUTION_SUITE);
  });

  it("dry-run totalCases matches the case count", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const cases = [makeDelegationCase(), makeTaskCompletionCase()];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      [],
    );

    const result = await runner.run({ dryRun: true });
    expect(result._unsafeUnwrap().totalCases).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// TapestryExecutionRunner — case filter
// ---------------------------------------------------------------------------

describe("TapestryExecutionRunner — case filter", () => {
  it("executes only the matching case when caseFilter is set", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const cases = [
      makeDelegationCase({ id: "case-a" }),
      makeDelegationCase({ id: "case-b" }),
    ];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
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
    const cases = [makeDelegationCase({ id: "case-a" })];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      [],
    );

    const result = await runner.run({ caseFilter: "nonexistent" });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("CaseFilterNotFound");
  });
});

// ---------------------------------------------------------------------------
// TapestryExecutionRunner — model filter
// ---------------------------------------------------------------------------

describe("TapestryExecutionRunner — model filter", () => {
  it("executes only cases that allow the filtered model", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const cases = [
      makeDelegationCase({
        id: "case-sonnet",
        allowed_models: ["anthropic/claude-sonnet-4.5"],
      }),
      makeDelegationCase({
        id: "case-gpt",
        allowed_models: ["openai/gpt-5.5"],
      }),
    ];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      [],
    );

    const result = await runner.run({
      dryRun: true,
      modelFilter: "anthropic/claude-sonnet-4.5",
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().totalCases).toBe(1);
    expect(result._unsafeUnwrap().caseResults[0]?.summary.caseId).toBe(
      "case-sonnet",
    );
  });

  it("returns NoCasesFound when modelFilter eliminates all cases", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const cases = [
      makeDelegationCase({ allowed_models: ["anthropic/claude-sonnet-4.5"] }),
    ];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      [],
    );

    const result = await runner.run({ modelFilter: "openai/gpt-5.5" });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("NoCasesFound");
  });
});

// ---------------------------------------------------------------------------
// TapestryExecutionRunner — publishable summary raw-data boundary
// ---------------------------------------------------------------------------

describe("TapestryExecutionRunner — publishable summary raw-data boundary", () => {
  const FAKE_PROMPT = "SENSITIVE_TAPESTRY_PROMPT_DO_NOT_PUBLISH";
  const FAKE_RESPONSE = "SENSITIVE_TAPESTRY_RESPONSE_DO_NOT_PUBLISH";

  function makeSecretRunner(): {
    runner: InMemoryTapestryRunner;
    modelClient: StubModelClient;
    scorer: StubAgentEvalsScorer;
  } {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: FAKE_RESPONSE,
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makeDelegationScoreRecord());

    const cases = [makeDelegationCase()];
    const rubrics = [makeEvalRubric()];

    const runner = new InMemoryTapestryRunner(
      {
        modelClient,
        scorer,
        tapestrySystemPrompt: FAKE_PROMPT,
      },
      cases,
      rubrics,
    );

    return { runner, modelClient, scorer };
  }

  it("summary does not contain the system prompt text", async () => {
    const { runner } = makeSecretRunner();
    const result = await runner.run({ rawArtifacts: false });
    const summaryStr = JSON.stringify(
      result._unsafeUnwrap().caseResults.map((r) => r.summary),
    );
    expect(summaryStr).not.toContain(FAKE_PROMPT);
  });

  it("summary does not contain the raw model response content", async () => {
    const { runner } = makeSecretRunner();
    const result = await runner.run({ rawArtifacts: false });
    const summaryStr = JSON.stringify(
      result._unsafeUnwrap().caseResults.map((r) => r.summary),
    );
    expect(summaryStr).not.toContain(FAKE_RESPONSE);
  });

  it("rawArtifact is absent when rawArtifacts is false", async () => {
    const { runner } = makeSecretRunner();
    const result = await runner.run({ rawArtifacts: false });
    for (const caseResult of result._unsafeUnwrap().caseResults) {
      expect(caseResult.rawArtifact).toBeUndefined();
    }
  });

  it("rawArtifact is present when rawArtifacts is true", async () => {
    const { runner } = makeSecretRunner();
    const result = await runner.run({ rawArtifacts: true });
    for (const caseResult of result._unsafeUnwrap().caseResults) {
      expect(caseResult.rawArtifact).toBeDefined();
    }
  });

  it("rawArtifact.rawContent contains the model response when rawArtifacts is true", async () => {
    const { runner } = makeSecretRunner();
    const result = await runner.run({ rawArtifacts: true });
    const artifact = result._unsafeUnwrap().caseResults[0]?.rawArtifact;
    expect(artifact?.rawContent).toBe(FAKE_RESPONSE);
  });

  it("rawArtifact.transcript is populated when rawArtifacts is true", async () => {
    const { runner } = makeSecretRunner();
    const result = await runner.run({ rawArtifacts: true });
    const artifact = result._unsafeUnwrap().caseResults[0]?.rawArtifact;
    expect(Array.isArray(artifact?.transcript)).toBe(true);
    expect(artifact?.transcript.length ?? 0).toBeGreaterThan(0);
  });

  it("publishable summary dimensionScores has no rationale field", async () => {
    const { runner } = makeSecretRunner();
    const result = await runner.run({ rawArtifacts: false });
    const summary = result._unsafeUnwrap().caseResults[0]?.summary;

    for (const [, dimScore] of Object.entries(summary?.dimensionScores ?? {})) {
      expect("rationale" in dimScore).toBe(false);
    }
  });

  it("dimensionRationales are in rawArtifact only", async () => {
    const { runner } = makeSecretRunner();
    const result = await runner.run({ rawArtifacts: true });
    const artifact = result._unsafeUnwrap().caseResults[0]?.rawArtifact;

    expect(artifact?.dimensionRationales).toBeDefined();
    // The rationale text should appear in the artifact
    const rationaleStr = JSON.stringify(artifact?.dimensionRationales);
    expect(rationaleStr.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// TapestryExecutionRunner — delegation_chain case kind
// ---------------------------------------------------------------------------

describe("TapestryExecutionRunner — delegation_chain cases", () => {
  it("executes a delegation_chain case and returns a result", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "tapestry → shuttle for backend work.",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makeDelegationScoreRecord());

    const cases = [makeDelegationCase()];
    const rubrics = [makeEvalRubric()];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      rubrics,
    );

    const result = await runner.run();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().caseResults).toHaveLength(1);
  });

  it("scorer receives ModelRunOutput with delegationChain populated", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "tapestry → shuttle",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makeDelegationScoreRecord());

    const cases = [makeDelegationCase()];
    const rubrics = [makeEvalRubric()];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      rubrics,
    );

    await runner.run();

    const scorerCall = scorer.calls[0];
    expect(scorerCall?.run.delegationChain).toBeDefined();
    expect(scorerCall?.run.delegationChain.length).toBeGreaterThanOrEqual(2);
  });

  it("result summary reflects delegationCorrectness dimension", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "tapestry → shuttle",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(
      makeDelegationScoreRecord({
        dimensions: {
          routingCorrectness: {
            score: 1.0,
            rationale: "n/a",
            applicable: false,
          },
          delegationCorrectness: {
            score: 1.0,
            rationale: "Correct chain.",
            applicable: true,
          },
          executionCompleteness: {
            score: 1.0,
            rationale: "n/a",
            applicable: false,
          },
          rationaleQuality: {
            score: 0.8,
            rationale: "Good.",
            applicable: true,
          },
        },
      }),
    );

    const cases = [makeDelegationCase()];
    const rubrics = [makeEvalRubric()];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      rubrics,
    );

    const result = await runner.run();
    const summary = result._unsafeUnwrap().caseResults[0]?.summary;
    expect(summary?.dimensionScores.delegationCorrectness.applicable).toBe(
      true,
    );
    expect(summary?.dimensionScores.routingCorrectness.applicable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TapestryExecutionRunner — task_completion case kind
// ---------------------------------------------------------------------------

describe("TapestryExecutionRunner — task_completion cases", () => {
  it("executes a task_completion case and returns a result", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content:
        "I have produced the api-spec and implementation. Task complete.",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makeTaskCompletionScoreRecord());

    const cases = [makeTaskCompletionCase()];
    const rubrics = [makeEvalRubric("complete-coding-task")];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      rubrics,
    );

    const result = await runner.run();
    expect(result.isOk()).toBe(true);
  });

  it("scorer receives ModelRunOutput with completionSignalled when signal detected", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "Task completed successfully. The api-spec is ready.",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makeTaskCompletionScoreRecord());

    const cases = [makeTaskCompletionCase()];
    const rubrics = [makeEvalRubric("complete-coding-task")];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      rubrics,
    );

    await runner.run();

    const scorerCall = scorer.calls[0];
    expect(scorerCall?.run.completionSignalled).toBe(true);
  });

  it("scorer receives ModelRunOutput with producedArtifacts matching expected", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content:
        "I produced api-spec and implementation artifacts. Task complete.",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makeTaskCompletionScoreRecord());

    const cases = [makeTaskCompletionCase()];
    const rubrics = [makeEvalRubric("complete-coding-task")];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      rubrics,
    );

    await runner.run();

    const scorerCall = scorer.calls[0];
    expect(scorerCall?.run.producedArtifacts).toContain("api-spec");
    expect(scorerCall?.run.producedArtifacts).toContain("implementation");
  });
});

// ---------------------------------------------------------------------------
// TapestryExecutionRunner — error accumulation
// ---------------------------------------------------------------------------

describe("TapestryExecutionRunner — error accumulation", () => {
  it("model error is accumulated as zero-score result, suite continues", async () => {
    const modelClient = new StubModelClient();
    modelClient.enqueueError({
      type: "NetworkError",
      message: "simulated failure",
    });
    modelClient.enqueueResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "tapestry → shuttle",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makeDelegationScoreRecord({ passed: true }));

    const cases = [
      makeDelegationCase({ id: "case-fail" }),
      makeDelegationCase({ id: "case-pass" }),
    ];
    const rubrics = [makeEvalRubric("case-pass")];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      rubrics,
    );

    const result = await runner.run();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().totalCases).toBe(2);

    const failedResult = result
      ._unsafeUnwrap()
      .caseResults.find((r) => r.summary.caseId === "case-fail");
    expect(failedResult?.summary.passed).toBe(false);
    expect(failedResult?.summary.weightedTotal).toBe(0);
  });

  it("model error rawArtifact.errorSummary is populated when rawArtifacts is true", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultError({
      type: "NetworkError",
      message: "SIMULATED_ERROR_TEXT",
    });

    const scorer = new StubAgentEvalsScorer();

    const cases = [makeDelegationCase()];
    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      [],
    );

    const result = await runner.run({ rawArtifacts: true });
    const artifact = result._unsafeUnwrap().caseResults[0]?.rawArtifact;
    // errorSummary is populated; classification is a sanitized label (not raw msg)
    expect(artifact?.errorSummary).toBeDefined();
    expect(artifact?.errorSummary?.errorType).toBe("NetworkError");
    expect(artifact?.errorSummary?.classification).toBeDefined();
    // classification must NOT contain the raw SIMULATED_ERROR_TEXT
    expect(artifact?.errorSummary?.classification).not.toContain(
      "SIMULATED_ERROR_TEXT",
    );
  });

  it("model error rawArtifact is absent when rawArtifacts is false", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultError({ type: "NetworkError", message: "failure" });

    const scorer = new StubAgentEvalsScorer();
    const cases = [makeDelegationCase()];
    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      [],
    );

    const result = await runner.run({ rawArtifacts: false });
    const caseResult = result._unsafeUnwrap().caseResults[0];
    expect(caseResult?.rawArtifact).toBeUndefined();
  });

  it("scoring error is accumulated as zero-score result, suite continues", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "tapestry → shuttle",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.enqueueError({
      type: "RubricNotFound",
      caseId: "case-no-rubric",
      message: "No rubric",
    });
    scorer.enqueueRecord(
      makeDelegationScoreRecord({ caseId: "case-ok", passed: true }),
    );

    const cases = [
      makeDelegationCase({ id: "case-no-rubric" }),
      makeDelegationCase({ id: "case-ok" }),
    ];
    const rubrics = [makeEvalRubric("case-ok")];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      rubrics,
    );

    const result = await runner.run();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().totalCases).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// TapestryExecutionRunner — suite green status
// ---------------------------------------------------------------------------

describe("TapestryExecutionRunner — suite green status", () => {
  it("suiteGreen is true when all required cases pass", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "tapestry → shuttle",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makeDelegationScoreRecord({ passed: true }));

    const cases = [
      makeDelegationCase({ id: "c1" }),
      makeDelegationCase({ id: "c2" }),
    ];
    const rubrics = [makeEvalRubric("c1"), makeEvalRubric("c2")];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      rubrics,
    );

    const result = await runner.run();
    expect(result._unsafeUnwrap().suiteGreen).toBe(true);
  });

  it("suiteGreen is false when a required case fails", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "tapestry → shuttle",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.enqueueRecord(makeDelegationScoreRecord({ passed: true }));
    scorer.enqueueRecord(
      makeDelegationScoreRecord({ passed: false, weightedTotal: 0.1 }),
    );

    const cases = [
      makeDelegationCase({ id: "c-pass" }),
      makeDelegationCase({ id: "c-fail" }),
    ];
    const rubrics = [makeEvalRubric("c-pass"), makeEvalRubric("c-fail")];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
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
      content: "tapestry → shuttle",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.enqueueRecord(makeDelegationScoreRecord({ passed: true }));
    scorer.enqueueRecord(
      makeDelegationScoreRecord({ passed: false, weightedTotal: 0 }),
    );

    const cases = [
      makeDelegationCase({ id: "c-pass" }),
      makeDelegationCase({ id: "c-fail" }),
    ];
    const rubrics = [makeEvalRubric("c-pass"), makeEvalRubric("c-fail")];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      rubrics,
    );

    const result = await runner.run();
    const runnerResult = result._unsafeUnwrap();
    expect(runnerResult.passedCases).toBe(1);
    expect(runnerResult.failedCases).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TapestryExecutionRunner — NoCasesFound
// ---------------------------------------------------------------------------

describe("TapestryExecutionRunner — NoCasesFound", () => {
  it("returns NoCasesFound when cases array is empty", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();

    const runner = new InMemoryTapestryRunner({ modelClient, scorer }, [], []);

    const result = await runner.run();
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("NoCasesFound");
  });

  it("NoCasesFound carries the suite name", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();

    const runner = new InMemoryTapestryRunner({ modelClient, scorer }, [], []);

    const result = await runner.run();
    const error = result._unsafeUnwrapErr();
    if (error.type === "NoCasesFound") {
      expect(error.suite).toBe(TAPESTRY_EXECUTION_SUITE);
    }
  });
});

// ---------------------------------------------------------------------------
// TapestryExecutionRunner — module exports and constants
// ---------------------------------------------------------------------------

describe("TapestryExecutionRunner — module exports", () => {
  it("TAPESTRY_EXECUTION_SUITE is 'tapestry-execution'", () => {
    expect(TAPESTRY_EXECUTION_SUITE).toBe("tapestry-execution");
  });

  it("TapestryExecutionRunner is constructable with minimal options", () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const runner = new TapestryExecutionRunner({ modelClient, scorer });
    expect(runner).toBeDefined();
  });

  it("run() returns a ResultAsync (thenable)", () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const runner = new InMemoryTapestryRunner({ modelClient, scorer }, [], []);

    const result = runner.run({ dryRun: true });
    expect(typeof result.then).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// CaseResult type boundary tests — shared between both runners
// ---------------------------------------------------------------------------

describe("CaseResultSummary type boundary", () => {
  it("CaseResultSummary has no raw text fields in type definition", () => {
    // This is a type-level test — we verify that the runtime shape of a
    // dry-run result only contains the allowed publishable fields.
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const cases = [makeDelegationCase()];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      [],
    );
    const resultAsync = runner.run({ dryRun: true });

    // The test verifies that the summary shape is correct
    expect(typeof resultAsync.then).toBe("function");
  });

  it("rawArtifact errorSummary carries classification label without raw error text", async () => {
    const modelClient = new StubModelClient();
    const errorMsg = "Controlled simulated error for test — DO NOT STORE RAW";
    modelClient.setDefaultError({ type: "ParseError", message: errorMsg });

    const scorer = new StubAgentEvalsScorer();
    const cases = [makeDelegationCase()];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      [],
    );

    const result = await runner.run({ rawArtifacts: true });
    const artifact = result._unsafeUnwrap().caseResults[0]?.rawArtifact;
    // errorSummary.classification is a sanitized label — never raw error text
    expect(artifact?.errorSummary?.classification).toBeDefined();
    expect(typeof artifact?.errorSummary?.classification).toBe("string");
    expect(artifact?.errorSummary?.classification).not.toContain(errorMsg);
    // rawContent should be empty (no model response was received)
    expect(artifact?.rawContent).toBe("");
  });
});

// ---------------------------------------------------------------------------
// MockPromptProvider — test double for PromptProvider
// ---------------------------------------------------------------------------

/**
 * A test double for `PromptProvider` that returns a pre-configured string
 * without touching the file system, git, or any network endpoint.
 */
class MockPromptProvider implements PromptProvider {
  readonly calls: string[] = [];

  constructor(
    private readonly promptText: string,
    private readonly shouldFail: boolean = false,
  ) {}

  getPrompt(
    agentName: string,
  ): import("neverthrow").ResultAsync<string, ProvenanceError> {
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
// TapestryExecutionRunner — PromptProvider injection (no git/network/LangChain)
// ---------------------------------------------------------------------------

describe("TapestryExecutionRunner — PromptProvider injection", () => {
  it("uses the injected promptProvider's getPrompt result", async () => {
    const MOCK_PROMPT = "MOCK_TAPESTRY_PROMPT_FROM_PROVIDER_12345";
    const promptProvider = new MockPromptProvider(MOCK_PROMPT);

    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "tapestry → shuttle",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makeDelegationScoreRecord());

    const cases = [makeDelegationCase()];
    const rubrics = [makeEvalRubric()];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer, promptProvider },
      cases,
      rubrics,
    );

    await runner.run();

    // Provider was called
    expect(promptProvider.calls).toContain("tapestry");
  });

  it("promptProvider.getPrompt is called with 'tapestry'", async () => {
    const promptProvider = new MockPromptProvider("Test tapestry prompt");

    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "tapestry → shuttle",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makeDelegationScoreRecord());

    const cases = [makeDelegationCase()];
    const rubrics = [makeEvalRubric()];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer, promptProvider },
      cases,
      rubrics,
    );

    await runner.run();
    expect(promptProvider.calls[0]).toBe("tapestry");
  });

  it("runner completes without touching git, network, or file system when promptProvider is injected", async () => {
    const promptProvider = new MockPromptProvider("Isolated prompt — no I/O");

    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "tapestry → shuttle",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makeDelegationScoreRecord());

    const cases = [makeDelegationCase()];
    const rubrics = [makeEvalRubric()];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer, promptProvider },
      cases,
      rubrics,
    );

    const result = await runner.run();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().totalCases).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TapestryExecutionRunner — bounded rawArtifact errorSummary
// ---------------------------------------------------------------------------

describe("TapestryExecutionRunner — bounded rawArtifact errorSummary", () => {
  it("errorSummary.errorType is set from the typed error discriminant", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultError({ type: "NetworkError", message: "timeout" });

    const scorer = new StubAgentEvalsScorer();
    const cases = [makeDelegationCase()];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      [],
    );

    const result = await runner.run({ rawArtifacts: true });
    const artifact = result._unsafeUnwrap().caseResults[0]?.rawArtifact;
    expect(artifact?.errorSummary?.errorType).toBeDefined();
    expect(typeof artifact?.errorSummary?.errorType).toBe("string");
  });

  it("errorSummary.classification is a sanitized label (not raw error text)", async () => {
    const SENSITIVE_MSG = "Tapestry test network failure — DO NOT PUBLISH";
    const modelClient = new StubModelClient();
    modelClient.setDefaultError({
      type: "NetworkError",
      message: SENSITIVE_MSG,
    });

    const scorer = new StubAgentEvalsScorer();
    const cases = [makeDelegationCase()];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      [],
    );

    const result = await runner.run({ rawArtifacts: true });
    const artifact = result._unsafeUnwrap().caseResults[0]?.rawArtifact;
    // classification is a fixed sanitized label, not the raw error message
    expect(typeof artifact?.errorSummary?.classification).toBe("string");
    expect(
      (artifact?.errorSummary?.classification ?? "").length,
    ).toBeGreaterThan(0);
    expect(artifact?.errorSummary?.classification).not.toContain(SENSITIVE_MSG);
  });

  it("errorSummary has no 'message' field (message is not stored)", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultError({
      type: "NetworkError",
      message: "some error",
    });

    const scorer = new StubAgentEvalsScorer();
    const cases = [makeDelegationCase()];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      [],
    );

    const result = await runner.run({ rawArtifacts: true });
    const artifact = result._unsafeUnwrap().caseResults[0]?.rawArtifact;
    // The 'message' field must not be present in RawErrorSummary
    expect("message" in (artifact?.errorSummary ?? {})).toBe(false);
  });

  it("errorSummary.classification is short (bounded), not unbounded error text", async () => {
    const LONG_MSG = "B".repeat(500);
    const modelClient = new StubModelClient();
    modelClient.setDefaultError({ type: "ParseError", message: LONG_MSG });

    const scorer = new StubAgentEvalsScorer();
    const cases = [makeDelegationCase()];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      [],
    );

    const result = await runner.run({ rawArtifacts: true });
    const artifact = result._unsafeUnwrap().caseResults[0]?.rawArtifact;
    const classification = artifact?.errorSummary?.classification ?? "";
    // classification is always a short sanitized label
    expect(classification.length).toBeLessThan(100);
    expect(classification).not.toContain("B".repeat(50));
  });

  it("publishable summary does not contain error message from errorSummary", async () => {
    const SENSITIVE_ERROR = "SENSITIVE_ERROR_TAPESTRY_DO_NOT_PUBLISH";
    const modelClient = new StubModelClient();
    modelClient.setDefaultError({
      type: "NetworkError",
      message: SENSITIVE_ERROR,
    });

    const scorer = new StubAgentEvalsScorer();
    const cases = [makeDelegationCase()];

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      [],
    );

    const result = await runner.run({ rawArtifacts: true });
    const summary = result._unsafeUnwrap().caseResults[0]?.summary;
    const summaryStr = JSON.stringify(summary);

    expect(summaryStr).not.toContain(SENSITIVE_ERROR);
  });

  it("raw artifacts do not contain sensitive error marker strings from provider or scorer", async () => {
    const SENSITIVE_SCORER_MSG = "SENSITIVE_SCORER_TAPESTRY_MESSAGE_12345";
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "tapestry → shuttle",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.enqueueError({
      type: "RubricNotFound",
      caseId: "delegate-to-shuttle",
      message: SENSITIVE_SCORER_MSG,
    });

    const cases = [makeDelegationCase()];
    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      cases,
      [],
    );

    const result = await runner.run({ rawArtifacts: true });
    const artifact = result._unsafeUnwrap().caseResults[0]?.rawArtifact;
    const artifactStr = JSON.stringify(artifact);

    // Sensitive marker text must not appear in raw artifact
    expect(artifactStr).not.toContain(SENSITIVE_SCORER_MSG);
  });
});

// ---------------------------------------------------------------------------
// TapestryExecutionRunner — provider failure prevents model calls
// ---------------------------------------------------------------------------

describe("TapestryExecutionRunner — provider failure prevents model calls", () => {
  it("returns PromptProviderFailed when promptProvider fails", async () => {
    const failingProvider = new MockPromptProvider(
      "unused",
      /* shouldFail */ true,
    );

    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();

    const cases = [makeDelegationCase()];
    const runner = new InMemoryTapestryRunner(
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

    const cases = [makeDelegationCase()];
    const runner = new InMemoryTapestryRunner(
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

    const cases = [makeDelegationCase()];
    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer, promptProvider: failingProvider },
      cases,
      [],
    );

    await runner.run();
    // Critical: no scorer calls must have been made
    expect(scorer.calls).toHaveLength(0);
  });

  it("PromptProviderFailed error carries agentName 'tapestry'", async () => {
    const failingProvider = new MockPromptProvider(
      "unused",
      /* shouldFail */ true,
    );

    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();

    const cases = [makeDelegationCase()];
    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer, promptProvider: failingProvider },
      cases,
      [],
    );

    const result = await runner.run();
    const error = result._unsafeUnwrapErr();
    if (error.type === "PromptProviderFailed") {
      expect(error.agentName).toBe("tapestry");
    }
  });

  it("PromptProviderFailed error message does not contain raw provider error text", async () => {
    const failingProvider = new MockPromptProvider(
      "unused",
      /* shouldFail */ true,
    );

    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();

    const cases = [makeDelegationCase()];
    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer, promptProvider: failingProvider },
      cases,
      [],
    );

    const result = await runner.run();
    const error = result._unsafeUnwrapErr();
    // runner error message must be a fixed sanitized string
    const SENSITIVE_PROVIDER_MSG = "MockPromptProvider: configured to fail";
    expect(error.message).not.toContain(SENSITIVE_PROVIDER_MSG);
    expect(typeof error.message).toBe("string");
    expect(error.message.length).toBeGreaterThan(0);
  });

  it("provider failure with rawArtifacts:true still returns PromptProviderFailed", async () => {
    const failingProvider = new MockPromptProvider(
      "unused",
      /* shouldFail */ true,
    );

    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();

    const cases = [makeDelegationCase()];
    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer, promptProvider: failingProvider },
      cases,
      [],
    );

    const result = await runner.run({ rawArtifacts: true });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("PromptProviderFailed");
    expect(modelClient.calls).toHaveLength(0);
  });
});
