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
  extractSecuritySignals,
  redactSecrets,
  WARP_SECURITY_SUITE,
  WarpSecurityRunner,
  type WarpSecurityRunnerOptions,
  type WarpSecurityRunRequest,
} from "../warp-security-runner.js";

type ResultAsyncRunnerError = ResultAsync<RunnerResult, RunnerError>;

const SCORED_AT = "2026-01-01T00:00:00.000Z";

function makeApproveCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "warp-security-fast-exit-approve",
    description:
      "Synthetic security review summary: `packages/cli/src/evals/runner.ts` adds documentation-only changes with no new attack surface. Approve only if the review fast-exits cleanly without findings.",
    suite: "warp-security",
    allowed_agents: ["warp"],
    allowed_models: ["anthropic/claude-sonnet-4.5"],
    expected_outcome: {
      kind: "task_completion",
      description:
        "Emit a fast-exit APPROVE verdict with zero blockers and no findings.",
      required_artifacts: [
        "security_verdict_present",
        "security_verdict_approve",
        "security_blocker_count_capped",
        "security_fast_exit_approve",
      ],
    },
    accepted_alternates: [],
    transcript_expectations: [
      { check: "content_contains", role: "assistant", contains: "APPROVE" },
      {
        check: "content_contains",
        role: "assistant",
        contains: "BLOCKERS: 0/3",
      },
    ],
    tags: ["security", "approve", "triage"],
    ...overrides,
  };
}

function makeBlockCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "warp-security-block-evidence-findings",
    description:
      "Synthetic security review summary: `packages/cli/src/evals/openrouter-client.ts` logs raw Authorization headers and `packages/cli/src/evals/sanitizer.ts` misses secret-bearing query strings. Block only if findings are evidence-backed and capped.",
    suite: "warp-security",
    allowed_agents: ["warp"],
    allowed_models: ["anthropic/claude-sonnet-4.5"],
    expected_outcome: {
      kind: "task_completion",
      description:
        "Emit a blocking security review with capped blockers and evidence-backed findings.",
      required_artifacts: [
        "security_verdict_present",
        "security_verdict_block",
        "security_blocker_count_capped",
        "security_findings_present",
        "security_severity_present",
        "security_findings_evidence_backed",
        "security_file_refs_present",
        "security_blocking_format_disciplined",
      ],
    },
    accepted_alternates: [],
    transcript_expectations: [
      { check: "content_contains", role: "assistant", contains: "BLOCK" },
      { check: "content_contains", role: "assistant", contains: "FINDING:" },
      { check: "content_contains", role: "assistant", contains: "EVIDENCE:" },
    ],
    tags: ["security", "block", "evidence"],
    ...overrides,
  };
}

function makeEvalRubric(caseId: string): EvalRubric {
  return {
    case_id: caseId,
    suite: "warp-security",
    scoring: {
      outcome_weight: 0.7,
      per_expectation_weight: 0.3,
      required: true,
      notes: "Score only text-visible security review structure.",
    },
  };
}

function makeSecurityScoreRecord(
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
      "Security review output satisfies the structural verdict contract.",
    applicable: true,
  };

  return {
    caseId,
    modelId: "anthropic/claude-sonnet-4.5",
    suite: "warp-security",
    dimensions: {
      routingCorrectness: neutralDim,
      delegationCorrectness: neutralDim,
      executionCompleteness: executionDim,
      rationaleQuality: {
        score: 0.9,
        rationale: "Clear, evidence-based security reasoning.",
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

class InMemoryWarpRunner extends WarpSecurityRunner {
  private readonly _promptProvider: PromptProvider | undefined;

  constructor(
    options: WarpSecurityRunnerOptions,
    private readonly cases: EvalCase[],
    private readonly rubrics: EvalRubric[],
  ) {
    super({ ...options, evalsRoot: "/tmp/nonexistent-evals-root-for-tests" });
    this._promptProvider = options.promptProvider;
  }

  override run(request: WarpSecurityRunRequest = {}): ResultAsyncRunnerError {
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
            suite: WARP_SECURITY_SUITE,
            message: `No cases found in suite "${WARP_SECURITY_SUITE}".`,
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
            suite: WARP_SECURITY_SUITE,
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
        Promise.resolve(assembleRunnerResult(WARP_SECURITY_SUITE, caseResults)),
      );
    }

    if (this._promptProvider !== undefined) {
      return this._promptProvider
        .getPrompt("warp")
        .mapErr(
          (): RunnerError => ({
            type: "PromptProviderFailed",
            agentName: "warp",
            message:
              "Warp prompt provider failed: prompt composition could not complete.",
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
                  assembleRunnerResult(WARP_SECURITY_SUITE, caseResults),
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
            assembleRunnerResult(WARP_SECURITY_SUITE, caseResults),
          ),
        ),
    );
  }
}

function executeCaseWithStubs(
  runner: WarpSecurityRunner,
  evalCase: EvalCase,
  modelId: string,
  rubrics: EvalRubric[],
  rawArtifacts: boolean,
): ResultAsync<CaseResult, never> {
  const anyRunner = runner as unknown as {
    modelClient: StubModelClient;
    scorer: StubAgentEvalsScorer;
  };

  const systemPrompt = "Test Warp system prompt";
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
      const signals = extractSecuritySignals(response.content);
      const runOutput: ModelRunOutput = {
        caseId: evalCase.id,
        modelId,
        routedAgents:
          signals.verdict === "approve" || signals.verdict === "block"
            ? ["warp"]
            : [],
        delegationChain: [],
        transcript: [
          { role: "user", content: userMessage },
          { role: "assistant", content: response.content },
        ],
        rawContent: response.content,
        completionSignalled:
          signals.approveDisciplined || signals.blockDisciplined,
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
          scoredAt: SCORED_AT,
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
                classification: errorType,
                localDiagnostic: rawMessage,
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
    scoredAt: SCORED_AT,
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
    completedAt: SCORED_AT,
  };
}

function buildRationales(
  dimensions: NormalizedScoreRecord["dimensions"],
): Partial<Record<ScoringDimension, string>> {
  const rationales: Partial<Record<ScoringDimension, string>> = {};

  for (const [dim, score] of Object.entries(dimensions) as Array<
    [ScoringDimension, DimensionScore]
  >) {
    if (score.applicable) {
      rationales[dim] = score.rationale;
    }
  }

  return rationales;
}

describe("extractSecuritySignals", () => {
  it("detects a fast-exit approve with zero blockers", () => {
    const signals = extractSecuritySignals(
      [
        "APPROVE",
        "BLOCKERS: 0/3",
        "No security-impacting changes found in `evals/README.md`.",
      ].join("\n"),
    );

    expect(signals.verdict).toBe("approve");
    expect(signals.blockerCount).toBe(0);
    expect(signals.cappedBlockers).toBe(true);
    expect(signals.approveDisciplined).toBe(true);
    expect(signals.producedArtifacts).toContain("security_fast_exit_approve");
  });

  it("detects capped evidence-backed blocking findings", () => {
    const signals = extractSecuritySignals(
      [
        "BLOCK",
        "BLOCKERS: 2/3",
        "SEVERITY: HIGH",
        "FINDING: Authorization header logging exposes bearer tokens.",
        "EVIDENCE: `packages/cli/src/evals/openrouter-client.ts` writes Authorization values into logs.",
        "IMPACT: Log retention would expose reusable credentials.",
        "FIX: Remove header logging in `packages/cli/src/evals/openrouter-client.ts`.",
        "SEVERITY: MEDIUM",
        "FINDING: Query-string secrets are not fully redacted.",
        "EVIDENCE: `packages/cli/src/evals/sanitizer.ts` leaves token parameters intact in some paths.",
        "IMPACT: Published diagnostics could leak secrets.",
        "FIX: Extend redaction coverage in `packages/cli/src/evals/sanitizer.ts`.",
      ].join("\n"),
    );

    expect(signals.verdict).toBe("block");
    expect(signals.blockerCount).toBe(2);
    expect(signals.blockerCap).toBe(3);
    expect(signals.cappedBlockers).toBe(true);
    expect(signals.findingCount).toBe(2);
    expect(signals.evidenceBackedFindingCount).toBe(2);
    expect(signals.blockDisciplined).toBe(true);
    expect(signals.producedArtifacts).toContain(
      "security_findings_evidence_backed",
    );
  });

  it("marks uncapped blocker counts as incomplete", () => {
    const signals = extractSecuritySignals(
      [
        "BLOCK",
        "BLOCKERS: 4/4",
        "SEVERITY: HIGH",
        "FINDING: Too many blockers.",
        "EVIDENCE: `packages/cli/src/evals/openrouter-client.ts` leaks secrets.",
        "IMPACT: Secret exposure.",
        "FIX: Redact values in `packages/cli/src/evals/openrouter-client.ts`.",
      ].join("\n"),
    );

    expect(signals.cappedBlockers).toBe(false);
    expect(signals.blockDisciplined).toBe(false);
    expect(signals.producedArtifacts).not.toContain(
      "security_blocking_format_disciplined",
    );
  });
});

describe("buildUserMessage", () => {
  it("describes the BLOCK/APPROVE contract and blocker cap", () => {
    const message = buildUserMessage(makeBlockCase());
    expect(message).toContain("APPROVE or BLOCK");
    expect(message).toContain("BLOCKERS: N/3");
    expect(message).toContain("exploit execution");
  });
});

describe("WarpSecurityRunner", () => {
  it("dry-run result has no rawArtifact even when rawArtifacts is true", async () => {
    const runner = new InMemoryWarpRunner(
      {
        modelClient: new StubModelClient(),
        scorer: new StubAgentEvalsScorer(),
      },
      [makeApproveCase()],
      [makeEvalRubric("warp-security-fast-exit-approve")],
    );

    const result = await runner.run({ dryRun: true, rawArtifacts: true });
    expect(result.isOk()).toBe(true);
    const caseResult = result._unsafeUnwrap().caseResults[0];
    expect(caseResult?.summary.dryRun).toBe(true);
    expect(caseResult?.rawArtifact).toBeUndefined();
  });

  it("passes approve-case signals to the scorer", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: [
        "APPROVE",
        "BLOCKERS: 0/3",
        "No security-impacting changes found in `evals/README.md`.",
      ].join("\n"),
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(
      makeSecurityScoreRecord("warp-security-fast-exit-approve"),
    );

    const runner = new InMemoryWarpRunner(
      {
        modelClient,
        scorer,
        promptProvider: {
          getPrompt: () =>
            ResultAsync.fromSafePromise(Promise.resolve("Warp prompt")),
        },
      },
      [makeApproveCase()],
      [makeEvalRubric("warp-security-fast-exit-approve")],
    );

    const result = await runner.run();
    expect(result.isOk()).toBe(true);
    const scorerCall = scorer.calls[0];
    expect(scorerCall?.run.completionSignalled).toBe(true);
    expect(scorerCall?.run.producedArtifacts).toContain(
      "security_fast_exit_approve",
    );
    expect(scorerCall?.run.producedArtifacts).toContain(
      "security_blocker_count_capped",
    );
  });

  it("passes blocking evidence-backed findings to the scorer", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: [
        "BLOCK",
        "BLOCKERS: 2/3",
        "SEVERITY: HIGH",
        "FINDING: Authorization header logging exposes bearer tokens.",
        "EVIDENCE: `packages/cli/src/evals/openrouter-client.ts` writes Authorization values into logs.",
        "IMPACT: Log retention would expose reusable credentials.",
        "FIX: Remove header logging in `packages/cli/src/evals/openrouter-client.ts`.",
        "SEVERITY: MEDIUM",
        "FINDING: Query-string secrets are not fully redacted.",
        "EVIDENCE: `packages/cli/src/evals/sanitizer.ts` leaves token parameters intact in some paths.",
        "IMPACT: Published diagnostics could leak secrets.",
        "FIX: Extend redaction coverage in `packages/cli/src/evals/sanitizer.ts`.",
      ].join("\n"),
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(
      makeSecurityScoreRecord("warp-security-block-evidence-findings"),
    );

    const runner = new InMemoryWarpRunner(
      {
        modelClient,
        scorer,
        promptProvider: {
          getPrompt: () =>
            ResultAsync.fromSafePromise(Promise.resolve("Warp prompt")),
        },
      },
      [makeBlockCase()],
      [makeEvalRubric("warp-security-block-evidence-findings")],
    );

    const result = await runner.run();
    expect(result.isOk()).toBe(true);
    const scorerCall = scorer.calls[0];
    expect(scorerCall?.run.completionSignalled).toBe(true);
    expect(scorerCall?.run.producedArtifacts).toContain(
      "security_findings_evidence_backed",
    );
    expect(scorerCall?.run.producedArtifacts).toContain(
      "security_blocking_format_disciplined",
    );
  });

  it("marks invalid blocking structure as incomplete", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: [
        "BLOCK",
        "BLOCKERS: 4/4",
        "FINDING: Too many blockers without valid cap.",
        "EVIDENCE: `packages/cli/src/evals/openrouter-client.ts` logs secrets.",
        "IMPACT: Secret exposure.",
        "FIX: Redact values in `packages/cli/src/evals/openrouter-client.ts`.",
      ].join("\n"),
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(
      makeSecurityScoreRecord("warp-security-block-evidence-findings", {
        passed: false,
        weightedTotal: 0.2,
      }),
    );

    const runner = new InMemoryWarpRunner(
      {
        modelClient,
        scorer,
        promptProvider: {
          getPrompt: () =>
            ResultAsync.fromSafePromise(Promise.resolve("Warp prompt")),
        },
      },
      [makeBlockCase()],
      [makeEvalRubric("warp-security-block-evidence-findings")],
    );

    await runner.run();
    const scorerCall = scorer.calls[0];
    expect(scorerCall?.run.completionSignalled).toBe(false);
    expect(scorerCall?.run.producedArtifacts).not.toContain(
      "security_blocking_format_disciplined",
    );
  });

  it("returns NoCasesFound when model filter removes all cases", async () => {
    const runner = new InMemoryWarpRunner(
      {
        modelClient: new StubModelClient(),
        scorer: new StubAgentEvalsScorer(),
      },
      [makeApproveCase()],
      [makeEvalRubric("warp-security-fast-exit-approve")],
    );

    const result = await runner.run({ modelFilter: "openai/gpt-5.5" });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("NoCasesFound");
  });

  it("includes rawArtifact when rawArtifacts is true", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: ["APPROVE", "BLOCKERS: 0/3"].join("\n"),
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(
      makeSecurityScoreRecord("warp-security-fast-exit-approve"),
    );

    const runner = new InMemoryWarpRunner(
      {
        modelClient,
        scorer,
        promptProvider: {
          getPrompt: () =>
            ResultAsync.fromSafePromise(Promise.resolve("Warp prompt")),
        },
      },
      [makeApproveCase()],
      [makeEvalRubric("warp-security-fast-exit-approve")],
    );

    const result = await runner.run({ rawArtifacts: true });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().caseResults[0]?.rawArtifact).toBeDefined();
  });
});

describe("redactSecrets", () => {
  it("redacts bearer tokens and api keys", () => {
    const redacted = redactSecrets(
      "Bearer secret-token-value sk-test-12345678 ?api_key=abcdefghi",
    );
    expect(redacted).not.toContain("secret-token-value");
    expect(redacted).not.toContain("abcdefghi");
    expect(redacted).toContain("[REDACTED]");
  });
});
