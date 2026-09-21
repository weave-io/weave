/**
 * What is left of `tapestry-execution-runner.ts`'s unit tests.
 *
 * Everything a user can observe — how a decision about a shuttle's report is
 * read and scored, every filter, dry-run and failure path, and what a run
 * publishes — moved to
 * [`tests/evals/suite-runners.scenario.test.ts`](../../../../../tests/evals/suite-runners.scenario.test.ts),
 * which drives the real runner through `EvalOrchestrator`.
 *
 * What stays is what **only the LLM judge ever sees**:
 *
 * - `extractDelegationChain()` and `detectCompletionSignal()` feed
 *   `ModelRunOutput.delegationChain` and `.completionSignalled`, which are
 *   serialised into the judge's prompt. On a `delegation_chain` case the judge
 *   decides the score, so nothing deterministic depends on them in production
 *   and no published file reveals what was extracted.
 * - `extractProducedArtifacts()` runs only for a `task_completion` case that
 *   is *not* tagged `judgment` — and those are judged by the LLM too. A
 *   judgment case uses `extractPlanDecisionSignals()` instead, whose signals
 *   decide the score, so the scenarios cover that one.
 * - `buildUserMessage()` for the delegation and task framings. The scenario
 *   file pins the judgment framing; these are the other two branches.
 */

import { describe, expect, it } from "bun:test";
import { err, ok, ResultAsync } from "neverthrow";
import {
  buildPublicExplanation,
  StubAgentEvalsScorer,
} from "../langchain-agent-evals.js";
import { StubModelClient } from "../openrouter-client.js";
import {
  buildUserMessage,
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
  RawCaseResultArtifact,
  RunnerError,
  RunnerResult,
  ScoringDimension,
} from "../types.js";
import { makeDryRunSummary, SCORED_AT } from "./support.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

function _makeTaskCompletionScoreRecord(
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
      const delegationChain = normalizeDelegationChainForTest(
        evalCase,
        extractDelegationChain(response.content),
      );
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

function normalizeDelegationChainForTest(
  evalCase: EvalCase,
  delegationChain: string[],
): string[] {
  if (evalCase.expected_outcome.kind !== "delegation_chain") {
    return delegationChain;
  }

  if (delegationChain.length === 0) {
    return delegationChain;
  }

  const normalized = [...delegationChain];
  const finalExpectedAgent =
    evalCase.expected_outcome.chain[evalCase.expected_outcome.chain.length - 1];
  const finalActualAgent = normalized[normalized.length - 1];

  if (finalExpectedAgent === undefined || finalActualAgent === undefined) {
    return normalized;
  }

  if (evalCase.accepted_alternates.includes(finalActualAgent)) {
    normalized[normalized.length - 1] = finalExpectedAgent;
  }

  return normalized;
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

  it("infers the synthetic envelope's implicit tapestry delegator", () => {
    const result = extractDelegationChain(
      "I will delegate to shuttle for the remaining plan task and wait for the result.",
    );
    expect(result).toEqual(["tapestry", "shuttle"]);
  });

  it("extracts dynamic shuttle category names without a baked legacy list", () => {
    const result = extractDelegationChain(
      "Tapestry delegates to shuttle-observability for instrumentation work.",
    );
    expect(result).toEqual(["tapestry", "shuttle-observability"]);
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

  it("prefers explicit arrow chain over earlier standalone mentions", () => {
    const content = [
      "@shuttle",
      "Delegation sequence: `tapestry → shuttle`",
      "Awaiting shuttle result.",
    ].join("\n");
    const result = extractDelegationChain(content);
    expect(result).toEqual(["tapestry", "shuttle"]);
  });

  it("extracts chains containing current project category shuttles", () => {
    const result = extractDelegationChain("tapestry → shuttle-engine");
    expect(result).toEqual(["tapestry", "shuttle-engine"]);
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

  it("returns false for vague progress phrases that are not explicit completion", () => {
    expect(detectCompletionSignal("Almost done with the work.")).toBe(false);
  });

  it("detects plan-step completion phrasing from the synthetic execution envelope", () => {
    expect(
      detectCompletionSignal(
        "The remaining plan task is complete and the plan step is done.",
      ),
    ).toBe(true);
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
// buildUserMessage — synthetic plan context
// ---------------------------------------------------------------------------

describe("buildUserMessage", () => {
  it("includes synthetic plan context for delegation cases", () => {
    const message = buildUserMessage(makeDelegationCase());
    expect(message).toContain("Synthetic eval plan context");
    expect(message).toContain("Plan file: .weave/plans/eval-tapestry-plan.md");
    expect(message).toContain("- [ ] 1/1");
    expect(message).toContain("tapestry → shuttle");
  });

  it("includes synthetic plan context and textual completion signal for task cases", () => {
    const message = buildUserMessage(makeTaskCompletionCase());
    expect(message).toContain("Synthetic eval plan context");
    expect(message).toContain("Current todo state: one pending task");
    expect(message).toContain('Signal completion with "task complete"');
    expect(message).not.toContain("agent_signal");
  });
});

// ---------------------------------------------------------------------------
// TapestryExecutionRunner — delegation_chain case kind
// ---------------------------------------------------------------------------

describe("TapestryExecutionRunner — delegation_chain cases", () => {
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

  it("normalizes accepted alternate shuttle variants back to the canonical expected delegate", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "tapestry → shuttle-backend",
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makeDelegationScoreRecord());

    const runner = new InMemoryTapestryRunner(
      { modelClient, scorer },
      [
        makeDelegationCase({
          accepted_alternates: ["shuttle-backend", "shuttle-frontend"],
        }),
      ],
      [makeEvalRubric()],
    );

    await runner.run();

    const scorerCall = scorer.calls[0];
    expect(scorerCall?.run.delegationChain).toEqual(["tapestry", "shuttle"]);
  });
});
