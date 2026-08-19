import { describe, expect, it } from "bun:test";
import { err, ok, ResultAsync } from "neverthrow";
import {
  buildPublicExplanation,
  StubAgentEvalsScorer,
} from "../langchain-agent-evals.js";
import { StubModelClient } from "../openrouter-client.js";
import {
  buildUserMessage,
  extractShuttleExecutionSignals,
  redactSecrets,
  SHUTTLE_EXECUTION_SUITE,
  ShuttleExecutionRunner,
  type ShuttleExecutionRunnerOptions,
  type ShuttleExecutionRunRequest,
} from "../shuttle-execution-runner.js";
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
} from "../types.js";

type ResultAsyncRunnerError = ResultAsync<RunnerResult, RunnerError>;
type ShuttleTestOptions = ShuttleExecutionRunnerOptions & {
  modelClient: StubModelClient;
  scorer: StubAgentEvalsScorer;
};
type ShuttleTestDependencies = Pick<
  ShuttleTestOptions,
  "modelClient" | "scorer"
>;

const SCORED_AT = "2026-01-01T00:00:00.000Z";

function makeExecutionCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "shuttle-execution-report-structured-evidence",
    description:
      "Update the shuttle execution suite docs and report concrete completion evidence without claiming real file mutation telemetry.",
    suite: "shuttle-execution",
    allowed_agents: ["shuttle"],
    allowed_models: ["anthropic/claude-sonnet-4.5"],
    expected_outcome: {
      kind: "task_completion",
      description:
        "Respond with bounded file scope, acceptance evidence, check results, and honest assumptions.",
      required_artifacts: [
        "shuttle_file_scope_bounded",
        "shuttle_acceptance_evidence",
        "shuttle_checks_reported",
        "shuttle_honest_assumptions",
      ],
    },
    accepted_alternates: [],
    transcript_expectations: [
      {
        check: "agent_mentioned",
        agent_name: "shuttle",
      },
    ],
    tags: ["execution", "reporting", "shuttle"],
    ...overrides,
  };
}

function makeEvidenceCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return makeExecutionCase({
    id: "shuttle-execution-report-tests-and-assumptions",
    description:
      "Confirm a delegated shuttle task with explicit assumptions, test results, and bounded evidence from assistant text only.",
    transcript_expectations: [
      {
        check: "agent_mentioned",
        agent_name: "shuttle",
      },
    ],
    ...overrides,
  });
}

function makeEvalRubric(caseId: string): EvalRubric {
  return {
    case_id: caseId,
    suite: "shuttle-execution",
    scoring: {
      outcome_weight: 0.7,
      per_expectation_weight: 0.3,
      required: true,
      notes:
        "Score only the delegated-task structure visible in assistant text; no real tool telemetry or file mutation required.",
    },
  };
}

function makeExecutionScoreRecord(
  caseId: string,
  overrides: Partial<NormalizedScoreRecord> = {},
): NormalizedScoreRecord {
  const neutralDim: DimensionScore = {
    score: 1,
    rationale: "n/a",
    applicable: false,
  };
  const executionDim: DimensionScore = {
    score: 1,
    rationale:
      "Assistant reflected bounded task intake, file awareness, acceptance confirmation, and evidence reporting.",
    applicable: true,
  };

  return {
    caseId,
    modelId: "anthropic/claude-sonnet-4.5",
    suite: "shuttle-execution",
    dimensions: {
      routingCorrectness: neutralDim,
      delegationCorrectness: neutralDim,
      executionCompleteness: executionDim,
      rationaleQuality: {
        score: 0.9,
        rationale: "Clear, bounded evidence reporting.",
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

class InMemoryShuttleRunner extends ShuttleExecutionRunner {
  private readonly _promptProvider: PromptProvider | undefined;
  private readonly _dependencies: ShuttleTestDependencies;

  constructor(
    options: ShuttleTestOptions,
    private readonly cases: EvalCase[],
    private readonly rubrics: EvalRubric[],
  ) {
    super({ ...options, evalsRoot: "/tmp/nonexistent-evals-root-for-tests" });
    this._promptProvider = options.promptProvider;
    this._dependencies = {
      modelClient: options.modelClient,
      scorer: options.scorer,
    };
  }

  override run(
    request: ShuttleExecutionRunRequest = {},
  ): ResultAsyncRunnerError {
    const dryRun = request.dryRun ?? false;
    const rawArtifacts = request.rawArtifacts ?? false;

    let cases = [...this.cases];
    const rubrics = this.rubrics;

    if (request.caseFilter !== undefined) {
      const match = cases.find((c) => c.id === request.caseFilter);
      if (match === undefined) {
        return new ResultAsync(
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
      return new ResultAsync(
        Promise.resolve(
          err<RunnerResult, RunnerError>({
            type: "NoCasesFound",
            suite: SHUTTLE_EXECUTION_SUITE,
            message: `No cases found in suite "${SHUTTLE_EXECUTION_SUITE}".`,
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
      return new ResultAsync(
        Promise.resolve(
          err<RunnerResult, RunnerError>({
            type: "NoCasesFound",
            suite: SHUTTLE_EXECUTION_SUITE,
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
          assembleRunnerResult(SHUTTLE_EXECUTION_SUITE, caseResults),
        ),
      );
    }

    if (this._promptProvider !== undefined) {
      return this._promptProvider
        .getPrompt("shuttle")
        .mapErr(
          (): RunnerError => ({
            type: "PromptProviderFailed",
            agentName: "shuttle",
            message:
              "Shuttle prompt provider failed: prompt composition could not complete.",
          }),
        )
        .andThen((_prompt) => {
          const executeAll = workItems.reduce(
            (acc, { evalCase, modelId }) =>
              acc.andThen((results) =>
                executeCaseWithStubs(
                  this._dependencies,
                  evalCase,
                  modelId,
                  rubrics,
                  rawArtifacts,
                ).map((result) => [...results, result]),
              ),
            ResultAsync.fromSafePromise(Promise.resolve<CaseResult[]>([])),
          );

          return executeAll.andThen((caseResults) =>
            ResultAsync.fromSafePromise(
              Promise.resolve(
                assembleRunnerResult(SHUTTLE_EXECUTION_SUITE, caseResults),
              ),
            ),
          );
        });
    }

    const executeAll = workItems.reduce(
      (acc, { evalCase, modelId }) =>
        acc.andThen((results) =>
          executeCaseWithStubs(
            this._dependencies,
            evalCase,
            modelId,
            rubrics,
            rawArtifacts,
          ).map((result) => [...results, result]),
        ),
      ResultAsync.fromSafePromise(Promise.resolve<CaseResult[]>([])),
    );

    return executeAll.andThen((caseResults) =>
      ResultAsync.fromSafePromise(
        Promise.resolve(
          assembleRunnerResult(SHUTTLE_EXECUTION_SUITE, caseResults),
        ),
      ),
    );
  }
}

function executeCaseWithStubs(
  dependencies: ShuttleTestDependencies,
  evalCase: EvalCase,
  modelId: string,
  rubrics: EvalRubric[],
  rawArtifacts: boolean,
): ResultAsync<CaseResult, never> {
  const systemPrompt =
    "You are Shuttle. Execute delegated tasks and report evidence.";
  const userMessage = buildUserMessage(evalCase);

  const modelResultAsync = dependencies.modelClient.complete({
    model: modelId,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature: 0.2,
  });

  const matchPromise = modelResultAsync
    .andThen((response) => {
      const signals = extractShuttleExecutionSignals(response.content);

      const runOutput: ModelRunOutput = {
        caseId: evalCase.id,
        modelId,
        routedAgents:
          signals.fileScopeBounded && signals.acceptanceEvidence
            ? ["shuttle"]
            : [],
        delegationChain: [],
        transcript: [
          { role: "user", content: userMessage },
          { role: "assistant", content: response.content },
        ],
        rawContent: response.content,
        completionSignalled:
          signals.fileScopeBounded &&
          signals.acceptanceEvidence &&
          signals.checksReported &&
          signals.assumptionsHonest &&
          !signals.fabricatedTelemetryDetected,
        producedArtifacts: signals.producedArtifacts,
      };

      return dependencies.scorer
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
        const errorType = error.type;
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
                classification: `model-${errorType
                  .toLowerCase()
                  .replace(/error$/, "-failure")}`,
              },
            }
          : undefined;
        return { summary, rawArtifact };
      },
    );

  return new ResultAsync(
    matchPromise.then((result) => ok<CaseResult, never>(result)),
  );
}

type DimensionRationales = {
  routingCorrectness?: string;
  delegationCorrectness?: string;
  executionCompleteness?: string;
  rationaleQuality?: string;
};

function buildRationales(
  dimensions: NormalizedScoreRecord["dimensions"],
): DimensionRationales {
  const out: DimensionRationales = {};
  if (dimensions.routingCorrectness.applicable) {
    out.routingCorrectness = dimensions.routingCorrectness.rationale;
  }
  if (dimensions.delegationCorrectness.applicable) {
    out.delegationCorrectness = dimensions.delegationCorrectness.rationale;
  }
  if (dimensions.executionCompleteness.applicable) {
    out.executionCompleteness = dimensions.executionCompleteness.rationale;
  }
  if (dimensions.rationaleQuality.applicable) {
    out.rationaleQuality = dimensions.rationaleQuality.rationale;
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
  const passedCases = caseResults.filter(
    (result) => result.summary.passed,
  ).length;
  const failedCases = caseResults.length - passedCases;
  const suiteGreen = caseResults
    .filter((result) => result.summary.required && !result.summary.dryRun)
    .every((result) => result.summary.passed);

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

describe("extractShuttleExecutionSignals", () => {
  it("detects bounded shuttle evidence-report structure from assistant text", () => {
    const content = [
      "Task intake",
      "What: Update the shuttle execution suite docs and report concrete completion evidence.",
      "Files: packages/cli/src/evals/shuttle-execution-runner.ts, evals/README.md",
      "Acceptance:",
      "- Reflect bounded task intake",
      "Files changed:",
      "- `packages/cli/src/evals/shuttle-execution-runner.ts`: added structured parsing",
      "Commands run:",
      "- bun test packages/cli/src/evals/__tests__/shuttle-execution-runner.test.ts",
      "Test results: 4 passed, 0 failed",
      "ALL acceptance criteria are met.",
      "Assumption: this is synthetic assistant text; no real file mutation or tool telemetry was observed.",
    ].join("\n");

    const signals = extractShuttleExecutionSignals(content);
    expect(signals.taskIntakeStructured).toBe(true);
    expect(signals.filesAcknowledged).toBe(true);
    expect(signals.acceptanceConfirmed).toBe(true);
    expect(signals.acceptanceEvidence).toBe(true);
    expect(signals.checksReported).toBe(true);
    expect(signals.assumptionsHonest).toBe(true);
    expect(signals.evidenceReported).toBe(true);
    expect(signals.producedArtifacts).toContain("shuttle_checks_reported");
  });

  it("does not invent structure when the response is vague", () => {
    const signals = extractShuttleExecutionSignals("done, looks good");
    expect(signals.taskIntakeStructured).toBe(false);
    expect(signals.filesAcknowledged).toBe(false);
    expect(signals.acceptanceConfirmed).toBe(false);
    expect(signals.fileScopeBounded).toBe(false);
    expect(signals.checksReported).toBe(false);
    expect(signals.assumptionsHonest).toBe(false);
  });

  it("accepts prose without task-intake restatement or fixed headings", () => {
    const signals = extractShuttleExecutionSignals(
      [
        "I considered `evals/README.md` and `packages/cli/src/evals/shuttle-execution-runner.ts`.",
        "The acceptance criteria are satisfied: the report has bounded scope and evidence.",
        "bun test packages/cli/src/evals/__tests__/shuttle-execution-runner.test.ts — 6 passed, 0 failed.",
        "Assumption: this is synthetic text; no real file mutation or tool telemetry was observed.",
      ].join("\n"),
    );

    expect(signals.taskIntakeStructured).toBe(false);
    expect(signals.fileScopeBounded).toBe(true);
    expect(signals.acceptanceEvidence).toBe(true);
    expect(signals.checksReported).toBe(true);
    expect(signals.assumptionsHonest).toBe(true);
    expect(signals.fabricatedTelemetryDetected).toBe(false);
  });

  it("rejects missing checks and fabricated telemetry signals", () => {
    const signals = extractShuttleExecutionSignals(
      [
        "Updated `evals/README.md`.",
        "Acceptance criteria are met.",
        "The actual filesystem and tool telemetry verify the change.",
      ].join("\n"),
    );

    expect(signals.fileScopeBounded).toBe(true);
    expect(signals.acceptanceEvidence).toBe(true);
    expect(signals.checksReported).toBe(false);
    expect(signals.fabricatedTelemetryDetected).toBe(true);
    expect(signals.producedArtifacts).not.toContain(
      "shuttle_honest_assumptions",
    );
  });
});

describe("buildUserMessage", () => {
  it("injects bounded delegated-task instructions and text-only limits", () => {
    const message = buildUserMessage(makeExecutionCase());
    expect(message).toContain(
      "Delegated task: Update the shuttle execution suite docs and report concrete completion evidence without claiming real file mutation telemetry.",
    );
    expect(message).toContain(
      "Relevant files include packages/cli/src/evals/shuttle-execution-runner.ts and evals/README.md.",
    );
    expect(message).toContain(
      "Report only bounded, text-visible completion evidence.",
    );
    expect(message).toContain("acceptance evidence");
    expect(message).toContain("commands or checks with their results");
    expect(message).toContain("honest assumptions or limits");
    expect(message).toContain("Do not claim hidden file mutation");
    expect(message).not.toContain("Task [1/1]");
  });
});

describe("ShuttleExecutionRunner", () => {
  it("returns dry-run results without model calls", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const runner = new InMemoryShuttleRunner(
      { modelClient, scorer },
      [makeExecutionCase()],
      [],
    );

    const result = await runner.run({ dryRun: true });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().caseResults[0]?.summary.dryRun).toBe(true);
    expect(modelClient.calls).toHaveLength(0);
  });

  it("executes a structured shuttle case and reports executionCompleteness", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: [
        "Task intake:",
        "What: Update the shuttle execution suite docs and report concrete completion evidence.",
        "Files: packages/cli/src/evals/shuttle-execution-runner.ts, evals/README.md",
        "Acceptance:",
        "- Reflect bounded task intake, file-list awareness, acceptance-criteria confirmation, and final evidence reporting from text only.",
        "Files changed:",
        "- `packages/cli/src/evals/shuttle-execution-runner.ts`: added task-structure parsing",
        "Commands run:",
        "- bun test packages/cli/src/evals/__tests__/shuttle-execution-runner.test.ts",
        "Test results: 3 passed, 0 failed",
        "Issues/assumptions: synthetic fixture; no real file mutation.",
        "ALL acceptance criteria are met.",
        "shuttle completed the delegated task.",
      ].join("\n"),
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(
      makeExecutionScoreRecord("shuttle-execution-report-structured-evidence"),
    );

    const runner = new InMemoryShuttleRunner(
      { modelClient, scorer },
      [makeExecutionCase()],
      [makeEvalRubric("shuttle-execution-report-structured-evidence")],
    );

    const result = await runner.run();
    expect(result.isOk()).toBe(true);
    const summary = result._unsafeUnwrap().caseResults[0]?.summary;
    expect(summary?.dimensionScores.executionCompleteness.applicable).toBe(
      true,
    );
    expect(summary?.passed).toBe(true);
  });

  it("passes structured producedArtifacts to the scorer", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: [
        "Task intake:",
        "What: Confirm the delegated shuttle task.",
        "Files: evals/README.md",
        "Acceptance:",
        "- Report bounded evidence from assistant text only.",
        "Files changed:",
        "- `evals/README.md`: documented shuttle-execution fixtures",
        "Commands run:",
        "- bun test packages/cli/src/evals/__tests__/shuttle-execution-runner.test.ts",
        "Test results: 5 passed, 0 failed",
        "ALL acceptance criteria are met.",
      ].join("\n"),
    });
    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(
      makeExecutionScoreRecord("shuttle-execution-report-structured-evidence"),
    );

    const runner = new InMemoryShuttleRunner(
      { modelClient, scorer },
      [makeExecutionCase()],
      [makeEvalRubric("shuttle-execution-report-structured-evidence")],
    );

    await runner.run();

    expect(scorer.calls[0]?.run.producedArtifacts).toEqual(
      expect.arrayContaining([
        "shuttle_files_acknowledged",
        "shuttle_acceptance_confirmed",
        "shuttle_evidence_reported",
      ]),
    );
  });

  it("supports case and model filters", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const runner = new InMemoryShuttleRunner(
      { modelClient, scorer },
      [makeExecutionCase(), makeEvidenceCase()],
      [
        makeEvalRubric("shuttle-execution-report-structured-evidence"),
        makeEvalRubric("shuttle-execution-report-tests-and-assumptions"),
      ],
    );

    const result = await runner.run({
      dryRun: true,
      caseFilter: "shuttle-execution-report-tests-and-assumptions",
      modelFilter: "anthropic/claude-sonnet-4.5",
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().totalCases).toBe(1);
    expect(result._unsafeUnwrap().caseResults[0]?.summary.caseId).toBe(
      "shuttle-execution-report-tests-and-assumptions",
    );
  });

  it("returns PromptProviderFailed when prompt composition fails", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const promptProvider: PromptProvider = {
      getPrompt: (agentName: string) =>
        new ResultAsync(
          Promise.resolve(
            err<string, ProvenanceError>({
              type: "PromptCompositionError",
              agentName,
              message: "boom",
            }),
          ),
        ),
    };

    const runner = new InMemoryShuttleRunner(
      { modelClient, scorer, promptProvider },
      [makeExecutionCase()],
      [makeEvalRubric("shuttle-execution-report-structured-evidence")],
    );

    const result = await runner.run();
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("PromptProviderFailed");
  });

  it("keeps raw content out of summary and stores it only in rawArtifact", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content:
        "SENSITIVE_SHUTTLE_RESPONSE\nFiles changed:\n- `evals/README.md`\nCommands run:\n- bun test\nALL acceptance criteria are met.",
    });
    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(
      makeExecutionScoreRecord("shuttle-execution-report-structured-evidence"),
    );

    const runner = new InMemoryShuttleRunner(
      {
        modelClient,
        scorer,
        shuttleSystemPrompt: "SENSITIVE_SHUTTLE_PROMPT",
      },
      [makeExecutionCase()],
      [makeEvalRubric("shuttle-execution-report-structured-evidence")],
    );

    const result = await runner.run({ rawArtifacts: true });
    const caseResult = result._unsafeUnwrap().caseResults[0];
    const summaryJson = JSON.stringify(caseResult?.summary);

    expect(summaryJson).not.toContain("SENSITIVE_SHUTTLE_PROMPT");
    expect(summaryJson).not.toContain("SENSITIVE_SHUTTLE_RESPONSE");
    expect(caseResult?.rawArtifact?.rawContent).toContain(
      "SENSITIVE_SHUTTLE_RESPONSE",
    );
  });

  it("accumulates model failures as zero-score results", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultError({ type: "NetworkError", message: "failed" });
    const scorer = new StubAgentEvalsScorer();
    const runner = new InMemoryShuttleRunner(
      { modelClient, scorer },
      [makeExecutionCase()],
      [makeEvalRubric("shuttle-execution-report-structured-evidence")],
    );

    const result = await runner.run({ rawArtifacts: true });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().caseResults[0]?.summary.weightedTotal).toBe(
      0,
    );
    expect(
      result._unsafeUnwrap().caseResults[0]?.rawArtifact?.errorSummary
        ?.errorType,
    ).toBe("NetworkError");
  });
});

describe("redactSecrets", () => {
  it("redacts bearer tokens from local diagnostics", () => {
    const redacted = redactSecrets("Authorization: Bearer abcdefghijklmnop");
    expect(redacted).not.toContain("abcdefghijklmnop");
    expect(redacted).toContain("[REDACTED]");
  });
});
