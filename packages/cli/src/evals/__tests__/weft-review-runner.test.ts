import { describe, expect, it } from "bun:test";
import { err, ok, ResultAsync } from "neverthrow";
import {
  buildPublicExplanation,
  StubAgentEvalsScorer,
} from "../langchain-agent-evals.js";
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
  RawCaseResultArtifact,
  RunnerError,
  RunnerResult,
  ScoringDimension,
} from "../types.js";
import {
  buildUserMessage,
  extractReviewSignals,
  redactSecrets,
  WEFT_REVIEW_SUITE,
  WeftReviewRunner,
  type WeftReviewRunnerOptions,
  type WeftReviewRunRequest,
} from "../weft-review-runner.js";

type ResultAsyncRunnerError = ResultAsync<RunnerResult, RunnerError>;

const SCORED_AT = "2026-01-01T00:00:00.000Z";

function makeApprovalCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "weft-review-clean-approval",
    description:
      "Synthetic review summary for packages/cli/src/evals/runner.ts and evals/README.md; approve only if the review is structurally disciplined.",
    suite: "weft-review",
    allowed_agents: ["weft"],
    allowed_models: ["anthropic/claude-sonnet-4.5"],
    expected_outcome: {
      kind: "task_completion",
      description:
        "Emit a clean approval review with explicit verdict and file references.",
      required_artifacts: [
        "review_verdict_present",
        "review_verdict_approve",
        "review_blockers_zero",
        "review_file_refs_present",
        "review_approval_disciplined",
      ],
    },
    accepted_alternates: [],
    transcript_expectations: [
      { check: "content_contains", role: "assistant", contains: "[APPROVE]" },
      {
        check: "content_contains",
        role: "assistant",
        contains: "Reviewed files:",
      },
    ],
    tags: ["review", "approval"],
    ...overrides,
  };
}

function makeRejectCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "weft-review-reject-blocker-citation",
    description:
      "Synthetic review summary for packages/cli/src/commands/eval.ts and packages/cli/src/evals/weft-review-runner.ts; reject only if blockers are actionable and file-cited.",
    suite: "weft-review",
    allowed_agents: ["weft"],
    allowed_models: ["anthropic/claude-sonnet-4.5"],
    expected_outcome: {
      kind: "task_completion",
      description: "Emit a rejection review with file-specific blockers.",
      required_artifacts: [
        "review_verdict_present",
        "review_verdict_reject",
        "review_blockers_present",
        "review_blocker_file_refs",
        "review_rejection_disciplined",
        "review_blockers_cited",
      ],
    },
    accepted_alternates: [],
    transcript_expectations: [
      { check: "content_contains", role: "assistant", contains: "[REJECT]" },
      { check: "content_contains", role: "assistant", contains: "BLOCKER:" },
    ],
    tags: ["review", "reject"],
    ...overrides,
  };
}

function makeEvalRubric(caseId: string): EvalRubric {
  return {
    case_id: caseId,
    suite: "weft-review",
    scoring: {
      outcome_weight: 0.7,
      per_expectation_weight: 0.3,
      required: true,
      notes: "Score only structurally observable review signals.",
    },
  };
}

function makeReviewScoreRecord(
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
    rationale: "Review structure satisfies verdict and blocker discipline.",
    applicable: true,
  };

  return {
    caseId,
    modelId: "anthropic/claude-sonnet-4.5",
    suite: "weft-review",
    dimensions: {
      routingCorrectness: neutralDim,
      delegationCorrectness: neutralDim,
      executionCompleteness: executionDim,
      rationaleQuality: {
        score: 0.9,
        rationale: "Clear, actionable review rationale.",
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

class InMemoryWeftRunner extends WeftReviewRunner {
  private readonly _promptProvider: PromptProvider | undefined;

  constructor(
    options: WeftReviewRunnerOptions,
    private readonly cases: EvalCase[],
    private readonly rubrics: EvalRubric[],
  ) {
    super({ ...options, evalsRoot: "/tmp/nonexistent-evals-root-for-tests" });
    this._promptProvider = options.promptProvider;
  }

  override run(request: WeftReviewRunRequest = {}): ResultAsyncRunnerError {
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
            suite: WEFT_REVIEW_SUITE,
            message: `No cases found in suite "${WEFT_REVIEW_SUITE}".`,
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
            suite: WEFT_REVIEW_SUITE,
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
        Promise.resolve(assembleRunnerResult(WEFT_REVIEW_SUITE, caseResults)),
      );
    }

    if (this._promptProvider !== undefined) {
      return this._promptProvider
        .getPrompt("weft")
        .mapErr(
          (): RunnerError => ({
            type: "PromptProviderFailed",
            agentName: "weft",
            message:
              "Weft prompt provider failed: prompt composition could not complete.",
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
                  assembleRunnerResult(WEFT_REVIEW_SUITE, caseResults),
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
          Promise.resolve(assembleRunnerResult(WEFT_REVIEW_SUITE, caseResults)),
        ),
    );
  }
}

function executeCaseWithStubs(
  runner: WeftReviewRunner,
  evalCase: EvalCase,
  modelId: string,
  rubrics: EvalRubric[],
  rawArtifacts: boolean,
): ResultAsync<CaseResult, never> {
  const anyRunner = runner as unknown as {
    modelClient: StubModelClient;
    scorer: StubAgentEvalsScorer;
  };

  const systemPrompt = "Test Weft system prompt";
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
      const signals = extractReviewSignals(response.content);
      const runOutput: ModelRunOutput = {
        caseId: evalCase.id,
        modelId,
        routedAgents: [],
        delegationChain: [],
        transcript: [
          { role: "user", content: userMessage },
          { role: "assistant", content: response.content },
        ],
        rawContent: response.content,
        completionSignalled:
          (signals.approvalDisciplined && signals.fileReferenceCount > 0) ||
          signals.rejectionDisciplined,
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

describe("extractReviewSignals", () => {
  it("detects a clean approval with reviewed file references and no blockers", () => {
    const content = [
      "[APPROVE] The review is structurally valid.",
      "Reviewed files: `packages/cli/src/evals/runner.ts`, `evals/README.md`.",
      "No blocking issues found.",
    ].join("\n");

    const signals = extractReviewSignals(content);
    expect(signals.verdict).toBe("approve");
    expect(signals.blockerCount).toBe(0);
    expect(signals.fileReferenceCount).toBeGreaterThanOrEqual(2);
    expect(signals.approvalDisciplined).toBe(true);
    expect(signals.producedArtifacts).toContain("review_verdict_approve");
    expect(signals.producedArtifacts).toContain("review_approval_disciplined");
  });

  it("detects a disciplined rejection only when each blocker is actionable and file-cited", () => {
    const content = [
      "[REJECT] Blocking issues remain.",
      "BLOCKER: Fix `packages/cli/src/commands/eval.ts` so invalid verdicts fail closed.",
      "BLOCKER: Add `packages/cli/src/evals/weft-review-runner.ts` file references to every blocker explanation.",
    ].join("\n");

    const signals = extractReviewSignals(content);
    expect(signals.verdict).toBe("reject");
    expect(signals.blockerCount).toBe(2);
    expect(signals.actionableBlockerCount).toBe(2);
    expect(signals.rejectionDisciplined).toBe(true);
    expect(signals.producedArtifacts).toContain("review_blockers_cited");
  });

  it("treats mixed or malformed verdicts as structurally invalid", () => {
    const signals = extractReviewSignals(
      "[APPROVE]\n[REJECT]\nBLOCKER: Fix `a.ts` before merge.",
    );
    expect(signals.verdict).toBe("invalid");
    expect(signals.approvalDisciplined).toBe(false);
    expect(signals.rejectionDisciplined).toBe(false);
  });
});

describe("buildUserMessage", () => {
  it("states that the review uses only synthetic text input", () => {
    const message = buildUserMessage(makeApprovalCase());
    expect(message).toContain("synthetic change summary");
    expect(message).toContain("[APPROVE] or [REJECT]");
    expect(message).toContain("Do not assume access to a real repository");
  });
});

describe("WeftReviewRunner", () => {
  it("returns dry-run results without model calls", async () => {
    const modelClient = new StubModelClient();
    const scorer = new StubAgentEvalsScorer();
    const runner = new InMemoryWeftRunner(
      { modelClient, scorer, weftSystemPrompt: "test" },
      [makeApprovalCase()],
      [makeEvalRubric("weft-review-clean-approval")],
    );

    const result = await runner.run({ dryRun: true });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().caseResults[0]?.summary.dryRun).toBe(true);
    expect(modelClient.calls).toHaveLength(0);
    expect(scorer.calls).toHaveLength(0);
  });

  it("scores a clean approval through the scorer path", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: [
        "[APPROVE] The change is structurally sound.",
        "Reviewed files: `packages/cli/src/evals/runner.ts`, `evals/README.md`.",
        "No blocking issues found.",
      ].join("\n"),
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(
      makeReviewScoreRecord("weft-review-clean-approval"),
    );

    const runner = new InMemoryWeftRunner(
      { modelClient, scorer, weftSystemPrompt: "test" },
      [makeApprovalCase()],
      [makeEvalRubric("weft-review-clean-approval")],
    );

    const result = await runner.run();
    expect(result.isOk()).toBe(true);
    const runnerResult = result._unsafeUnwrap();
    expect(runnerResult.suite).toBe(WEFT_REVIEW_SUITE);
    expect(runnerResult.totalCases).toBe(1);
    expect(runnerResult.caseResults[0]?.summary.passed).toBe(true);

    const scorerCall = scorer.calls[0];
    expect(scorerCall?.run.completionSignalled).toBe(true);
    expect(scorerCall?.run.producedArtifacts).toContain(
      "review_verdict_approve",
    );
    expect(scorerCall?.run.producedArtifacts).toContain(
      "review_approval_disciplined",
    );
  });

  it("distinguishes a structurally invalid mixed-verdict review from a clean approval", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: [
        "[APPROVE] Looks good.",
        "[REJECT] Actually there is a blocker.",
        "BLOCKER: Fix `packages/cli/src/evals/weft-review-runner.ts`.",
      ].join("\n"),
    });
    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(
      makeReviewScoreRecord("weft-review-clean-approval", {
        weightedTotal: 0.2,
        passed: false,
        dimensions: {
          routingCorrectness: { score: 1, rationale: "n/a", applicable: false },
          delegationCorrectness: {
            score: 1,
            rationale: "n/a",
            applicable: false,
          },
          executionCompleteness: {
            score: 0,
            rationale: "Verdict structure is invalid.",
            applicable: true,
          },
          rationaleQuality: {
            score: 0.3,
            rationale: "Conflicting verdicts reduce clarity.",
            applicable: true,
          },
        },
      }),
    );

    const runner = new InMemoryWeftRunner(
      { modelClient, scorer, weftSystemPrompt: "test" },
      [makeApprovalCase()],
      [makeEvalRubric("weft-review-clean-approval")],
    );

    const result = await runner.run();
    expect(result.isOk()).toBe(true);
    const summary = result._unsafeUnwrap().caseResults[0]?.summary;
    expect(summary?.passed).toBe(false);
    expect(summary?.weightedTotal).toBe(0.2);

    const scorerCall = scorer.calls[0];
    expect(scorerCall?.run.completionSignalled).toBe(false);
    expect(scorerCall?.run.producedArtifacts).not.toContain(
      "review_approval_disciplined",
    );
    expect(scorerCall?.run.producedArtifacts).not.toContain(
      "review_rejection_disciplined",
    );
  });

  it("scores a rejection with blocker citations through the scorer path", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: [
        "[REJECT] Blocking issues remain.",
        "BLOCKER: Fix `packages/cli/src/commands/eval.ts` so malformed verdict tags fail closed.",
        "BLOCKER: Add `packages/cli/src/evals/weft-review-runner.ts` file references to every blocker explanation.",
      ].join("\n"),
    });
    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(
      makeReviewScoreRecord("weft-review-reject-blocker-citation"),
    );

    const runner = new InMemoryWeftRunner(
      { modelClient, scorer, weftSystemPrompt: "test" },
      [makeRejectCase()],
      [makeEvalRubric("weft-review-reject-blocker-citation")],
    );

    const result = await runner.run();
    expect(result.isOk()).toBe(true);
    const scorerCall = scorer.calls[0];
    expect(scorerCall?.run.completionSignalled).toBe(true);
    expect(scorerCall?.run.producedArtifacts).toContain(
      "review_blockers_cited",
    );
    expect(scorerCall?.run.producedArtifacts).toContain(
      "review_rejection_disciplined",
    );
  });

  it("loads raw artifacts only when requested", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: "[APPROVE]\nReviewed files: `a.ts`.",
    });
    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(
      makeReviewScoreRecord("weft-review-clean-approval"),
    );

    const runner = new InMemoryWeftRunner(
      { modelClient, scorer, weftSystemPrompt: "test" },
      [makeApprovalCase()],
      [makeEvalRubric("weft-review-clean-approval")],
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

    const runner = new InMemoryWeftRunner(
      { modelClient, scorer, weftSystemPrompt: "test" },
      [makeApprovalCase()],
      [makeEvalRubric("weft-review-clean-approval")],
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
    const runner = new InMemoryWeftRunner(
      {
        modelClient: new StubModelClient(),
        scorer: new StubAgentEvalsScorer(),
        weftSystemPrompt: "test",
      },
      [makeApprovalCase()],
      [makeEvalRubric("weft-review-clean-approval")],
    );

    const result = await runner.run({ modelFilter: "openai/gpt-5.5" });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("NoCasesFound");
  });
});
