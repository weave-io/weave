import { describe, expect, it } from "bun:test";
import { err, ResultAsync } from "neverthrow";
import { StubAgentEvalsScorer } from "../langchain-agent-evals.js";
import { StubModelClient } from "../openrouter-client.js";
import {
  buildUserMessage,
  extractSpindleResearchSignals,
  redactSecrets,
  SPINDLE_TOOLS_SUITE,
  SpindleToolsRunner,
  type SpindleToolsRunnerOptions,
  type SpindleToolsRunRequest,
} from "../spindle-tools-runner.js";
import type {
  CaseResult,
  CaseResultSummary,
  DimensionScore,
  EvalCase,
  EvalRubric,
  NormalizedScoreRecord,
  PromptProvider,
  ProvenanceError,
  RunnerError,
  RunnerResult,
  ScoringDimension,
} from "../types.js";

type ResultAsyncRunnerError = ResultAsync<RunnerResult, RunnerError>;

const SCORED_AT = "2026-01-01T00:00:00.000Z";

function makeResearchCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "spindle-tools-citations-facts-confidence",
    description:
      "Synthetic research brief: [1] Bun compatibility docs allow node:path and node:os in Bun-only projects. [2] Weave runtime policy forbids Node fs and child_process usage. Summarize the guidance with source-cited facts, clear interpretation, and explicit confidence.",
    suite: "spindle-tools",
    allowed_agents: ["spindle"],
    allowed_models: ["anthropic/claude-sonnet-4.5"],
    expected_outcome: {
      kind: "task_completion",
      description:
        "Respond with source-cited facts, separate interpretation, a sources list, and explicit confidence.",
      required_artifacts: [
        "spindle_inline_citations_present",
        "spindle_source_facts_separated",
        "spindle_confidence_reported",
        "spindle_sources_list_present",
      ],
    },
    accepted_alternates: [],
    transcript_expectations: [
      {
        check: "content_contains",
        role: "assistant",
        contains: "Source facts",
      },
      {
        check: "content_contains",
        role: "assistant",
        contains: "Interpretation",
      },
      { check: "content_contains", role: "assistant", contains: "Confidence:" },
      { check: "content_contains", role: "assistant", contains: "Sources:" },
    ],
    tags: ["research", "citations", "confidence"],
    ...overrides,
  };
}

function makeBoundaryCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return makeResearchCase({
    id: "spindle-tools-source-boundary-network-claims",
    description:
      "Synthetic research brief: [1] docs/agent-evals.md says text-only evals do not capture real tool-call or network events. [2] evals/README.md says network/tool usage stays out of scope unless surfaced as plain text claims. Explain the boundary with citations and explicit confidence.",
    tags: ["research", "boundary", "text-only"],
    ...overrides,
  });
}

function makeEvalRubric(caseId: string): EvalRubric {
  return {
    case_id: caseId,
    suite: "spindle-tools",
    scoring: {
      outcome_weight: 0.7,
      per_expectation_weight: 0.3,
      required: true,
      notes:
        "Score only textual research structure: citations, source-facts vs interpretation separation, and bounded confidence.",
    },
  };
}

function makeResearchScoreRecord(
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
      "Research answer includes citations, clear separation, and confidence.",
    applicable: true,
  };

  return {
    caseId,
    modelId: "anthropic/claude-sonnet-4.5",
    suite: "spindle-tools",
    dimensions: {
      routingCorrectness: neutralDim,
      delegationCorrectness: neutralDim,
      executionCompleteness: executionDim,
      rationaleQuality: {
        score: 0.9,
        rationale: "Clear, appropriately bounded synthesis.",
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

class InMemorySpindleRunner extends SpindleToolsRunner {
  private readonly _promptProvider: PromptProvider | undefined;

  constructor(
    options: SpindleToolsRunnerOptions,
    private readonly cases: EvalCase[],
    private readonly rubrics: EvalRubric[],
  ) {
    super({ ...options, evalsRoot: "/tmp/nonexistent-evals-root-for-tests" });
    this._promptProvider = options.promptProvider;
  }

  override run(request: SpindleToolsRunRequest = {}): ResultAsyncRunnerError {
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
            suite: SPINDLE_TOOLS_SUITE,
            message: `No cases found in suite "${SPINDLE_TOOLS_SUITE}".`,
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
            suite: SPINDLE_TOOLS_SUITE,
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
        Promise.resolve(assembleRunnerResult(SPINDLE_TOOLS_SUITE, caseResults)),
      );
    }

    if (this._promptProvider !== undefined) {
      return this._promptProvider
        .getPrompt("spindle")
        .mapErr(
          (): RunnerError => ({
            type: "PromptProviderFailed",
            agentName: "spindle",
            message:
              "Spindle prompt provider failed: prompt composition could not complete.",
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
                  assembleRunnerResult(SPINDLE_TOOLS_SUITE, caseResults),
                ),
              ),
          );
        });
    }

    return ResultAsync.fromSafePromise(
      Promise.resolve(assembleRunnerResult(SPINDLE_TOOLS_SUITE, [])),
    );
  }
}

function makeDryRunSummary(
  evalCase: EvalCase,
  modelId: string,
): CaseResultSummary {
  const dimensionScores: Record<
    ScoringDimension,
    { score: number; applicable: boolean }
  > = {
    routingCorrectness: { score: 0, applicable: false },
    delegationCorrectness: { score: 0, applicable: false },
    executionCompleteness: { score: 0, applicable: false },
    rationaleQuality: { score: 0, applicable: false },
  };

  return {
    caseId: evalCase.id,
    modelId,
    suite: evalCase.suite,
    passed: false,
    required: true,
    weightedTotal: 0,
    dimensionScores,
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

  return {
    suite,
    suiteGreen: caseResults.every(
      (r) => !r.summary.required || r.summary.passed,
    ),
    caseResults,
    totalCases: caseResults.length,
    passedCases,
    failedCases,
    completedAt: SCORED_AT,
  };
}

function executeCaseWithStubs(
  runner: SpindleToolsRunner,
  evalCase: EvalCase,
  modelId: string,
  rubrics: EvalRubric[],
  rawArtifacts: boolean,
): ResultAsync<CaseResult, never> {
  const anyRunner = runner as unknown as {
    executeSingleCase: (
      evalCase: EvalCase,
      modelId: string,
      rubrics: EvalRubric[],
      rawArtifacts: boolean,
      systemPrompt: string,
    ) => ResultAsync<CaseResult, never>;
  };

  return anyRunner.executeSingleCase(
    evalCase,
    modelId,
    rubrics,
    rawArtifacts,
    "You are Spindle.",
  );
}

describe("extractSpindleResearchSignals", () => {
  it("detects citations, fact/interpretation separation, sources, and confidence", () => {
    const signals = extractSpindleResearchSignals(`
Source facts
- Bun allows node:path in Bun-only projects [1].
- Weave forbids Node fs usage [2].

Interpretation
Prefer node:path over fs imports for Bun-native code [1][2].

Confidence: high

Sources:
- [1] Bun compatibility notes
- [2] Weave runtime policy
`);

    expect(signals.inlineCitationsPresent).toBe(true);
    expect(signals.sourceFactsSeparated).toBe(true);
    expect(signals.confidenceReported).toBe(true);
    expect(signals.sourcesListed).toBe(true);
    expect(signals.producedArtifacts).toEqual([
      "spindle_inline_citations_present",
      "spindle_source_facts_separated",
      "spindle_confidence_reported",
      "spindle_sources_list_present",
    ]);
  });

  it("does not mark completion signals when confidence is missing", () => {
    const signals = extractSpindleResearchSignals(`
Source facts
- Fact [1]

Interpretation
Analysis [1]

Sources:
- [1] Synthetic source
`);

    expect(signals.inlineCitationsPresent).toBe(true);
    expect(signals.sourceFactsSeparated).toBe(true);
    expect(signals.sourcesListed).toBe(true);
    expect(signals.confidenceReported).toBe(false);
  });
});

describe("buildUserMessage", () => {
  it("instructs text-only research structure and forbids assuming live browsing", () => {
    const message = buildUserMessage(makeResearchCase());

    expect(message).toContain("text-only external research synthesis");
    expect(message).toContain("Do not assume live browsing");
    expect(message).toContain("Open with a short direct answer");
    expect(message).toContain("Source facts");
    expect(message).toContain("Interpretation");
    expect(message).toContain("Confidence: high");
    expect(message).toContain("Sources:");
  });
});

describe("redactSecrets", () => {
  it("redacts bearer tokens and query keys", () => {
    const redacted = redactSecrets(
      "Authorization: Bearer super-secret-token api?token=abcd1234",
    );

    expect(redacted).not.toContain("super-secret-token");
    expect(redacted).toContain("Bearer [REDACTED]");
    expect(redacted).toContain("?[key]=[REDACTED]");
  });
});

describe("SpindleToolsRunner", () => {
  it("runs a structured research case with prompt provider and raw artifacts", async () => {
    const modelClient = new StubModelClient();
    modelClient.setDefaultResponse({
      model: "anthropic/claude-sonnet-4.5",
      content: `
Source facts
- Bun allows node:path in Bun-only projects [1].
- Weave forbids Node fs usage [2].

Interpretation
Use node:path while avoiding fs APIs in eval runners [1][2].

Confidence: high

Sources:
- [1] Bun compatibility notes
- [2] Weave runtime policy
`,
    });

    const scorer = new StubAgentEvalsScorer();
    scorer.setDefaultRecord(
      makeResearchScoreRecord("spindle-tools-citations-facts-confidence"),
    );

    class RecordingPromptProvider implements PromptProvider {
      readonly calls: string[] = [];

      getPrompt(agentName: string): ResultAsync<string, ProvenanceError> {
        this.calls.push(agentName);
        return ResultAsync.fromSafePromise(Promise.resolve("You are Spindle."));
      }
    }

    const promptProvider = new RecordingPromptProvider();
    const runner = new InMemorySpindleRunner(
      { modelClient, scorer, promptProvider },
      [makeResearchCase()],
      [makeEvalRubric("spindle-tools-citations-facts-confidence")],
    );

    const result = await runner.run({ rawArtifacts: true });
    expect(result.isOk()).toBe(true);

    if (result.isErr()) {
      return;
    }

    expect(promptProvider.calls).toEqual(["spindle"]);
    expect(result.value.suite).toBe(SPINDLE_TOOLS_SUITE);
    expect(result.value.totalCases).toBe(1);
    expect(result.value.passedCases).toBe(1);
    expect(result.value.caseResults[0]?.rawArtifact?.rawContent).toContain(
      "Confidence: high",
    );
  });

  it("supports dry run without model execution", async () => {
    const runner = new InMemorySpindleRunner(
      {
        modelClient: new StubModelClient(),
        scorer: new StubAgentEvalsScorer(),
      },
      [makeResearchCase(), makeBoundaryCase()],
      [
        makeEvalRubric("spindle-tools-citations-facts-confidence"),
        makeEvalRubric("spindle-tools-source-boundary-network-claims"),
      ],
    );

    const result = await runner.run({ dryRun: true });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    expect(result.value.totalCases).toBe(2);
    expect(result.value.caseResults.every((r) => r.summary.dryRun)).toBe(true);
  });

  it("returns PromptProviderFailed when prompt composition fails", async () => {
    class FailingPromptProvider implements PromptProvider {
      getPrompt(_agentName: string): ResultAsync<string, ProvenanceError> {
        return new ResultAsync(
          Promise.resolve(
            err<string, ProvenanceError>({
              type: "PromptCompositionError",
              agentName: "spindle",
              message: "boom",
            }),
          ),
        );
      }
    }

    const runner = new InMemorySpindleRunner(
      {
        modelClient: new StubModelClient(),
        scorer: new StubAgentEvalsScorer(),
        promptProvider: new FailingPromptProvider(),
      },
      [makeResearchCase()],
      [makeEvalRubric("spindle-tools-citations-facts-confidence")],
    );

    const result = await runner.run();
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("PromptProviderFailed");
  });
});
