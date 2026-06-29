import { describe, expect, it } from "bun:test";
import { err, ok, ResultAsync } from "neverthrow";
import {
  buildPublicExplanation,
  StubAgentEvalsScorer,
} from "../langchain-agent-evals.js";
import { StubModelClient } from "../openrouter-client.js";
import {
  buildUserMessage,
  extractPlanningSignals,
  PATTERN_PLANNING_SUITE,
  PatternPlanningRunner,
  type PatternPlanningRunnerOptions,
  type PatternPlanningRunRequest,
  redactSecrets,
} from "../pattern-planning-runner.js";
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

type ResultAsyncRunnerError = ResultAsync<RunnerResult, RunnerError>;

const SCORED_AT = "2026-01-01T00:00:00.000Z";

function makePlanningCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "pattern-plan-settings-refactor",
    description:
      "Create an implementation plan for refactoring the project settings workflow.",
    suite: "pattern-planning",
    allowed_agents: ["pattern"],
    allowed_models: ["anthropic/claude-sonnet-4.5"],
    expected_outcome: {
      kind: "task_completion",
      description:
        "Produce a structurally sound plan with explicit scope, file-backed tasks, sequencing, and acceptance coverage.",
      required_artifacts: [
        "plan_scope_explicit",
        "plan_file_tasks",
        "plan_sequence_explicit",
        "plan_acceptance_coverage",
      ],
    },
    accepted_alternates: [],
    transcript_expectations: [
      { check: "content_contains", role: "assistant", contains: "#scope" },
      { check: "content_contains", role: "assistant", contains: "#files" },
      { check: "content_contains", role: "assistant", contains: "#sequence" },
      { check: "content_contains", role: "assistant", contains: "#acceptance" },
      { check: "agent_mentioned", agent_name: "pattern" },
    ],
    tags: ["planning", "structure"],
    ...overrides,
  };
}

function makeEvalRubric(caseId = "pattern-plan-settings-refactor"): EvalRubric {
  return {
    case_id: caseId,
    suite: "pattern-planning",
    scoring: {
      outcome_weight: 0.7,
      per_expectation_weight: 0.3,
      required: true,
      notes:
        "Score deterministic planning structure signals, not semantic elegance.",
    },
  };
}

function makePlanningScoreRecord(
  overrides: Partial<NormalizedScoreRecord> = {},
): NormalizedScoreRecord {
  const neutralDim: DimensionScore = {
    score: 1,
    rationale: "n/a",
    applicable: false,
  };
  const executionDim: DimensionScore = {
    score: 1,
    rationale: "Plan includes structural planning signals.",
    applicable: true,
  };

  return {
    caseId: "pattern-plan-settings-refactor",
    modelId: "anthropic/claude-sonnet-4.5",
    suite: "pattern-planning",
    dimensions: {
      routingCorrectness: neutralDim,
      delegationCorrectness: neutralDim,
      executionCompleteness: executionDim,
      rationaleQuality: {
        score: 0.9,
        rationale: "Clear structural rationale.",
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

class InMemoryPatternRunner extends PatternPlanningRunner {
  private readonly _promptProvider: PromptProvider | undefined;

  constructor(
    options: PatternPlanningRunnerOptions,
    private readonly cases: EvalCase[],
    private readonly rubrics: EvalRubric[],
  ) {
    super({ ...options, evalsRoot: "/tmp/nonexistent-evals-root-for-tests" });
    this._promptProvider = options.promptProvider;
  }

  override run(
    request: PatternPlanningRunRequest = {},
  ): ResultAsyncRunnerError {
    const dryRun = request.dryRun ?? false;
    const rawArtifacts = request.rawArtifacts ?? false;

    let cases = [...this.cases];
    const rubrics = this.rubrics;

    if (request.caseFilter !== undefined) {
      const match = cases.find((c) => c.id === request.caseFilter);
      if (match === undefined) {
        return new ResultAsync<RunnerResult, RunnerError>(
          Promise.resolve(
            err<RunnerResult, RunnerError>({
              type: "CaseFilterNotFound",
              caseId: request.caseFilter,
              message: `Case "${request.caseFilter}" not found.`,
            }),
          ),
        );
      }
      cases = [match];
    }

    if (cases.length === 0) {
      return new ResultAsync<RunnerResult, RunnerError>(
        Promise.resolve(
          err<RunnerResult, RunnerError>({
            type: "NoCasesFound",
            suite: PATTERN_PLANNING_SUITE,
            message: `No cases found in suite "${PATTERN_PLANNING_SUITE}".`,
          }),
        ),
      );
    }

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
      return new ResultAsync<RunnerResult, RunnerError>(
        Promise.resolve(
          err<RunnerResult, RunnerError>({
            type: "NoCasesFound",
            suite: PATTERN_PLANNING_SUITE,
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
          assembleRunnerResult(PATTERN_PLANNING_SUITE, caseResults),
        ),
      );
    }

    if (this._promptProvider !== undefined) {
      return this._promptProvider
        .getPrompt("pattern")
        .mapErr(
          (): RunnerError => ({
            type: "PromptProviderFailed",
            agentName: "pattern",
            message:
              "Pattern prompt provider failed: prompt composition could not complete.",
          }),
        )
        .andThen((_prompt) => {
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
                  assembleRunnerResult(PATTERN_PLANNING_SUITE, caseResults),
                ),
              ),
          );
        });
    }

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
            assembleRunnerResult(PATTERN_PLANNING_SUITE, caseResults),
          ),
        ),
    );
  }
}

function executeCaseWithStubs(
  runner: PatternPlanningRunner,
  evalCase: EvalCase,
  modelId: string,
  rubrics: EvalRubric[],
  rawArtifacts: boolean,
): ResultAsync<CaseResult, never> {
  const anyRunner = runner as unknown as {
    modelClient: StubModelClient;
    scorer: StubAgentEvalsScorer;
  };

  const systemPrompt = "Test Pattern system prompt";
  const userMessage = buildUserMessage(evalCase);
  const modelResultAsync = anyRunner.modelClient.complete({
    model: modelId,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature: 0.1,
  });

  const matchPromise = modelResultAsync
    .andThen((response) => {
      const signals = extractPlanningSignals(response.content);
      const runOutput: ModelRunOutput = {
        caseId: evalCase.id,
        modelId,
        routedAgents: signals.scopeExplicit ? ["pattern"] : [],
        delegationChain: [],
        transcript: [
          { role: "user", content: userMessage },
          { role: "assistant", content: response.content },
        ],
        rawContent: response.content,
        completionSignalled:
          signals.scopeExplicit &&
          signals.fileBackedTasks &&
          signals.sequencingExplicit &&
          signals.acceptanceCoverage,
        producedArtifacts: signals.producedArtifacts,
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
        const summary: CaseResultSummary = {
          caseId: evalCase.id,
          modelId,
          suite: evalCase.suite,
          passed: scoreRecord.passed,
          required: scoreRecord.required,
          weightedTotal: scoreRecord.weightedTotal,
          dimensionScores: {
            routingCorrectness: {
              score: scoreRecord.dimensions.routingCorrectness.score,
              applicable: scoreRecord.dimensions.routingCorrectness.applicable,
            },
            delegationCorrectness: {
              score: scoreRecord.dimensions.delegationCorrectness.score,
              applicable:
                scoreRecord.dimensions.delegationCorrectness.applicable,
            },
            executionCompleteness: {
              score: scoreRecord.dimensions.executionCompleteness.score,
              applicable:
                scoreRecord.dimensions.executionCompleteness.applicable,
            },
            rationaleQuality: {
              score: scoreRecord.dimensions.rationaleQuality.score,
              applicable: scoreRecord.dimensions.rationaleQuality.applicable,
            },
          },
          scoredAt: scoreRecord.scoredAt,
          dryRun: false,
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
                classification: `model-${errorType.toLowerCase().replace(/error$/, "-failure")}`,
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

  return new ResultAsync<CaseResult, never>(
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

describe("extractPlanningSignals", () => {
  it("detects all structural planning signals from tagged plan text", () => {
    const content = [
      "pattern plan",
      "#scope Focus on settings workflow and no auth changes.",
      "#files",
      "1. Update `packages/cli/src/evals/pattern-planning-runner.ts`.",
      "2. Update evals/README.md to document the suite.",
      "#sequence Execute the loader updates before docs.",
      "#acceptance",
      "- Verify dry-run loads the suite.",
      "- Confirm scoring uses deterministic signals.",
    ].join("\n");

    const signals = extractPlanningSignals(content);
    expect(signals.scopeExplicit).toBe(true);
    expect(signals.fileBackedTasks).toBe(true);
    expect(signals.sequencingExplicit).toBe(true);
    expect(signals.acceptanceCoverage).toBe(true);
    expect(signals.taskCount).toBeGreaterThanOrEqual(2);
    expect(signals.fileCount).toBeGreaterThanOrEqual(2);
    expect(signals.acceptanceCount).toBeGreaterThanOrEqual(2);
    expect(signals.producedArtifacts).toEqual([
      "plan_scope_explicit",
      "plan_file_tasks",
      "plan_sequence_explicit",
      "plan_acceptance_coverage",
    ]);
  });

  it("does not infer coverage from vague prose alone", () => {
    const signals = extractPlanningSignals(
      "We should think about the work and maybe touch a file later.",
    );
    expect(signals.scopeExplicit).toBe(false);
    expect(signals.fileBackedTasks).toBe(false);
    expect(signals.acceptanceCoverage).toBe(false);
    expect(signals.producedArtifacts).toEqual([]);
  });
});

describe("buildUserMessage", () => {
  it("requests structural planning signals explicitly", () => {
    const message = buildUserMessage(makePlanningCase());
    expect(message).toContain("explicit scope");
    expect(message).toContain("#scope #files #sequence #acceptance");
    expect(message).toContain("plan_scope_explicit");
  });
});

describe("PatternPlanningRunner", () => {
  it("returns dry-run results without model calls", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const runner = new InMemoryPatternRunner(
      { modelClient, scorer, patternSystemPrompt: "test" },
      [makePlanningCase()],
      [makeEvalRubric()],
    );

    const result = await runner.run({ dryRun: true });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().caseResults[0]?.summary.dryRun).toBe(true);
    expect(modelClient.calls).toHaveLength(0);
    expect(scorer.calls).toHaveLength(0);
  });

  it("scores a representative structural planning case through the scorer path", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: [
        "pattern will produce the plan.",
        "#scope Refactor settings planning only.",
        "#files",
        "1. Update `packages/cli/src/evals/pattern-planning-runner.ts`.",
        "2. Update `evals/README.md`.",
        "#sequence Complete runner changes before docs.",
        "#acceptance",
        "- Verify dry-run works.",
      ].join("\n"),
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makePlanningScoreRecord());

    const runner = new InMemoryPatternRunner(
      { modelClient, scorer, patternSystemPrompt: "test" },
      [makePlanningCase()],
      [makeEvalRubric()],
    );

    const result = await runner.run();
    expect(result.isOk()).toBe(true);
    const runnerResult = result._unsafeUnwrap();
    expect(runnerResult.suite).toBe(PATTERN_PLANNING_SUITE);
    expect(runnerResult.totalCases).toBe(1);
    expect(runnerResult.caseResults[0]?.summary.passed).toBe(true);

    const scorerCall = scorer.calls[0];
    expect(scorerCall?.run.completionSignalled).toBe(true);
    expect(scorerCall?.run.producedArtifacts).toEqual([
      "plan_scope_explicit",
      "plan_file_tasks",
      "plan_sequence_explicit",
      "plan_acceptance_coverage",
    ]);
  });

  it("loads raw artifacts only when requested", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content:
        "pattern\n#scope\n#files\n1. Update `a.ts`\n#sequence\n#acceptance\n- Verify",
    });
    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(makePlanningScoreRecord());

    const runner = new InMemoryPatternRunner(
      { modelClient, scorer, patternSystemPrompt: "test" },
      [makePlanningCase()],
      [makeEvalRubric()],
    );

    const withoutRaw = await runner.run({ rawArtifacts: false });
    expect(
      withoutRaw._unsafeUnwrap().caseResults[0]?.rawArtifact,
    ).toBeUndefined();

    const withRaw = await runner.run({ rawArtifacts: true });
    expect(withRaw._unsafeUnwrap().caseResults[0]?.rawArtifact).toBeDefined();
  });

  it("accumulates model errors as zero-score results", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultError({ type: "NetworkError", message: "failure" });
    const scorer = new StubAgentEvalsScorer();

    const runner = new InMemoryPatternRunner(
      { modelClient, scorer, patternSystemPrompt: "test" },
      [makePlanningCase()],
      [makeEvalRubric()],
    );

    const result = await runner.run({ rawArtifacts: true });
    expect(result.isOk()).toBe(true);
    const caseResult = result._unsafeUnwrap().caseResults[0];
    expect(caseResult?.summary.weightedTotal).toBe(0);
    expect(caseResult?.rawArtifact?.errorSummary?.errorType).toBe(
      "NetworkError",
    );
  });

  it("returns NoCasesFound when model filter removes all cases", async () => {
    const runner = new InMemoryPatternRunner(
      {
        modelClient: new StubModelClient(),
        scorer: new StubAgentEvalsScorer(),
        patternSystemPrompt: "test",
      },
      [makePlanningCase()],
      [makeEvalRubric()],
    );

    const result = await runner.run({ modelFilter: "openai/gpt-5.5" });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("NoCasesFound");
  });
});
