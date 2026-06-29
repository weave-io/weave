/**
 * Spindle tools eval runner for `weave eval run`.
 *
 * Executes the `spindle-tools` suite against synthetic external-research
 * prompts. Scoring remains text-only: citation structure, separation of source
 * facts from interpretation, and explicit confidence reporting are extracted
 * from assistant text alone.
 */

import { err, ok, ResultAsync } from "neverthrow";
import {
  loadSuiteCases,
  loadSuiteRubrics,
  validateCaseFilter,
} from "./case-loader.js";
import {
  type AgentEvalsScorer,
  buildPublicExplanation,
} from "./langchain-agent-evals.js";
import type { ModelClient } from "./openrouter-client.js";
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
  RawErrorSummary,
  RunnerError,
  RunnerResult,
  ScoringDimension,
  TranscriptMessage,
} from "./types.js";

export const SPINDLE_TOOLS_SUITE = "spindle-tools";

const INLINE_CITATION_RE = /\[(?:\d+|source\s*\d+)\]/gi;
const SOURCE_FACTS_HEADER_RE =
  /^\s*(?:##+\s*)?(?:Source facts|Facts from sources|Verified facts)\s*:?\s*$/im;
const INTERPRETATION_HEADER_RE =
  /^\s*(?:##+\s*)?(?:Interpretation|Analysis|Inference)\s*:?\s*$/im;
const SOURCES_HEADER_RE = /^\s*(?:##+\s*)?(?:Sources|Citations)\s*:?\s*$/im;
const SOURCE_LIST_LINE_RE =
  /^\s*(?:[-*]|\d+\.)\s*(?:\[\d+\]|Source\s+\d+:?).+$/gim;
const CONFIDENCE_RE =
  /^\s*Confidence\s*:\s*(low|medium|high|[1-9]\d?%|100%|0(?:\.\d+)?|1(?:\.0+)?)\b/im;

const LOCAL_DIAGNOSTIC_MAX_CHARS = 500;
const SECRET_REDACTION_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
  [/\bsk-(?:or-|proj-)?[A-Za-z0-9_-]{8,}/g, "[REDACTED-KEY]"],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, "[REDACTED-KEY]"],
  [/\b[0-9a-f]{32,}\b/gi, "[REDACTED-HEX]"],
  [/Authorization:\s*[^\s,;\n]{8,}/gi, "Authorization: [REDACTED]"],
  [/[?&](?:api_key|apikey|key|token)=[^&\s]{4,}/gi, "?[key]=[REDACTED]"],
];

export interface SpindleResearchSignals {
  inlineCitationsPresent: boolean;
  sourceFactsSeparated: boolean;
  confidenceReported: boolean;
  sourcesListed: boolean;
  inlineCitationCount: number;
  sourceListCount: number;
  producedArtifacts: string[];
}

function countInlineCitations(content: string): number {
  return [...content.matchAll(INLINE_CITATION_RE)].length;
}

function findSectionIndex(content: string, re: RegExp): number {
  const match = re.exec(content);
  re.lastIndex = 0;

  if (match?.index === undefined) {
    return -1;
  }

  return match.index;
}

export function extractSpindleResearchSignals(
  content: string,
): SpindleResearchSignals {
  const inlineCitationCount = countInlineCitations(content);
  const sourceListCount = [...content.matchAll(SOURCE_LIST_LINE_RE)].length;
  const sourceFactsIndex = findSectionIndex(content, SOURCE_FACTS_HEADER_RE);
  const interpretationIndex = findSectionIndex(
    content,
    INTERPRETATION_HEADER_RE,
  );
  const sourcesHeaderPresent = SOURCES_HEADER_RE.test(content);
  const confidenceReported = CONFIDENCE_RE.test(content);

  const inlineCitationsPresent = inlineCitationCount > 0;
  const sourceFactsSeparated =
    sourceFactsIndex >= 0 &&
    interpretationIndex >= 0 &&
    sourceFactsIndex < interpretationIndex;
  const sourcesListed = sourcesHeaderPresent && sourceListCount > 0;

  const producedArtifacts = new Set<string>();
  if (inlineCitationsPresent) {
    producedArtifacts.add("spindle_inline_citations_present");
  }
  if (sourceFactsSeparated) {
    producedArtifacts.add("spindle_source_facts_separated");
  }
  if (confidenceReported) {
    producedArtifacts.add("spindle_confidence_reported");
  }
  if (sourcesListed) {
    producedArtifacts.add("spindle_sources_list_present");
  }

  return {
    inlineCitationsPresent,
    sourceFactsSeparated,
    confidenceReported,
    sourcesListed,
    inlineCitationCount,
    sourceListCount,
    producedArtifacts: [...producedArtifacts],
  };
}

function buildModelRunOutput(
  evalCase: EvalCase,
  modelId: string,
  userMessage: string,
  content: string,
): ModelRunOutput {
  const signals = extractSpindleResearchSignals(content);
  const transcript: TranscriptMessage[] = [
    { role: "user", content: userMessage },
    { role: "assistant", content },
  ];

  return {
    caseId: evalCase.id,
    modelId,
    routedAgents:
      signals.inlineCitationsPresent || signals.sourcesListed
        ? ["spindle"]
        : [],
    delegationChain: [],
    transcript,
    rawContent: content,
    completionSignalled:
      signals.inlineCitationsPresent &&
      signals.sourceFactsSeparated &&
      signals.confidenceReported &&
      signals.sourcesListed,
    producedArtifacts: signals.producedArtifacts,
  };
}

function classifyErrorType(errorType: string): string {
  switch (errorType) {
    case "NetworkError":
      return "model-network-failure";
    case "HttpError":
      return "model-http-failure";
    case "ParseError":
      return "model-parse-failure";
    case "EmptyResponse":
      return "model-empty-response";
    case "NotConfigured":
      return "stub-not-configured";
    case "RubricNotFound":
      return "scoring-rubric-missing";
    case "RubricCaseMismatch":
      return "scoring-rubric-mismatch";
    case "ScorerAdapterError":
      return "scoring-adapter-failure";
    default:
      return "unknown-error";
  }
}

export function redactSecrets(raw: string): string {
  let redacted = raw;
  for (const [pattern, replacement] of SECRET_REDACTION_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  if (redacted.length > LOCAL_DIAGNOSTIC_MAX_CHARS) {
    return `${redacted.slice(0, LOCAL_DIAGNOSTIC_MAX_CHARS)}… [truncated]`;
  }
  return redacted;
}

function buildErrorResult(
  evalCase: EvalCase,
  modelId: string,
  errorType: string,
  rawArtifacts: boolean,
  dimension?: string,
  rawMessage?: string,
): CaseResult {
  const scoredAt = new Date().toISOString();
  const dimensionScores: Record<
    ScoringDimension,
    { score: number; applicable: boolean }
  > = {
    routingCorrectness: { score: 0, applicable: false },
    delegationCorrectness: { score: 0, applicable: false },
    executionCompleteness: { score: 0, applicable: false },
    rationaleQuality: { score: 0, applicable: false },
  };

  const summary: CaseResultSummary = {
    caseId: evalCase.id,
    modelId,
    suite: evalCase.suite,
    passed: false,
    required: true,
    weightedTotal: 0,
    dimensionScores,
    scoredAt,
    dryRun: false,
  };

  const errorSummary: RawErrorSummary = {
    errorType,
    classification: classifyErrorType(errorType),
    dimension,
    localDiagnostic:
      rawArtifacts && rawMessage !== undefined
        ? redactSecrets(rawMessage)
        : undefined,
  };

  const rawArtifact: RawCaseResultArtifact | undefined = rawArtifacts
    ? {
        caseId: evalCase.id,
        modelId,
        composedPrompt: "",
        transcript: [],
        rawContent: "",
        dimensionRationales: {},
        errorSummary,
      }
    : undefined;

  return { summary, rawArtifact };
}

function buildDryRunResult(evalCase: EvalCase, modelId: string): CaseResult {
  const scoredAt = new Date().toISOString();
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
    summary: {
      caseId: evalCase.id,
      modelId,
      suite: evalCase.suite,
      passed: false,
      required: true,
      weightedTotal: 0,
      dimensionScores,
      scoredAt,
      dryRun: true,
    },
  };
}

export function buildUserMessage(evalCase: EvalCase): string {
  const outcome = evalCase.expected_outcome;
  const requiredArtifacts =
    outcome.kind === "task_completion" ? outcome.required_artifacts : [];

  return [
    "Perform a text-only external research synthesis using only the synthetic source brief below.",
    `Synthetic research brief: ${evalCase.description}`,
    "Do not assume live browsing, tool telemetry, hidden network access, or unpublished sources.",
    "Write a section titled 'Source facts' that uses inline citations such as [1] and [2].",
    "Write a separate section titled 'Interpretation' for your analysis or synthesis.",
    "End with a bounded confidence line in the form 'Confidence: high', 'Confidence: medium', or 'Confidence: low'.",
    "Include a final 'Sources:' section listing the cited sources.",
    "If you mention network or tool usage, present it only as an explicit plain-text claim rather than an implied event.",
    requiredArtifacts.length > 0
      ? `Required structural signals: ${requiredArtifacts.join(", ")}`
      : "Required structural signals: none",
  ].join("\n");
}

export interface SpindleToolsRunnerOptions {
  modelClient: ModelClient;
  scorer: AgentEvalsScorer;
  promptProvider?: PromptProvider;
  spindleSystemPrompt?: string;
  evalsRoot?: string;
}

export interface SpindleToolsRunRequest {
  caseFilter?: string;
  modelFilter?: string;
  dryRun?: boolean;
  rawArtifacts?: boolean;
}

export class SpindleToolsRunner {
  private readonly modelClient: ModelClient;
  private readonly scorer: AgentEvalsScorer;
  private readonly promptProvider: PromptProvider;
  private readonly evalsRoot: string | undefined;

  constructor(options: SpindleToolsRunnerOptions) {
    this.modelClient = options.modelClient;
    this.scorer = options.scorer;
    this.evalsRoot = options.evalsRoot;

    if (options.promptProvider !== undefined) {
      this.promptProvider = options.promptProvider;
      return;
    }

    if (options.spindleSystemPrompt !== undefined) {
      const prompt = options.spindleSystemPrompt;
      this.promptProvider = {
        getPrompt: (_agentName: string) =>
          ResultAsync.fromSafePromise(Promise.resolve(prompt)),
      };
      return;
    }

    this.promptProvider = makeDefaultSpindlePromptProvider();
  }

  run(
    request: SpindleToolsRunRequest = {},
  ): ResultAsync<RunnerResult, RunnerError> {
    const dryRun = request.dryRun ?? false;
    const rawArtifacts = request.rawArtifacts ?? false;

    const casesAsync =
      this.evalsRoot !== undefined
        ? loadSuiteCases(SPINDLE_TOOLS_SUITE, this.evalsRoot)
        : loadSuiteCases(SPINDLE_TOOLS_SUITE);

    const rubricsAsync =
      this.evalsRoot !== undefined
        ? loadSuiteRubrics(SPINDLE_TOOLS_SUITE, this.evalsRoot)
        : loadSuiteRubrics(SPINDLE_TOOLS_SUITE);

    return ResultAsync.fromSafePromise(
      Promise.all([casesAsync, rubricsAsync]),
    ).andThen(([casesResult, rubricsResult]) => {
      if (casesResult.isErr()) {
        return new ResultAsync(
          Promise.resolve(
            err<RunnerResult, RunnerError>({
              type: "FixtureLoadError",
              message: casesResult.error.message,
              cause: casesResult.error,
            }),
          ),
        );
      }

      if (rubricsResult.isErr()) {
        return new ResultAsync(
          Promise.resolve(
            err<RunnerResult, RunnerError>({
              type: "FixtureLoadError",
              message: rubricsResult.error.message,
              cause: rubricsResult.error,
            }),
          ),
        );
      }

      let cases = casesResult.value;
      const rubrics = rubricsResult.value;

      if (request.caseFilter !== undefined) {
        const filterResult = validateCaseFilter(request.caseFilter, cases);
        if ("type" in filterResult) {
          return new ResultAsync(
            Promise.resolve(
              err<RunnerResult, RunnerError>({
                type: "CaseFilterNotFound",
                caseId: request.caseFilter,
                message: filterResult.message,
              }),
            ),
          );
        }
        cases = [filterResult];
      }

      if (cases.length === 0) {
        return new ResultAsync(
          Promise.resolve(
            err<RunnerResult, RunnerError>({
              type: "NoCasesFound",
              suite: SPINDLE_TOOLS_SUITE,
              message:
                `No cases found in suite "${SPINDLE_TOOLS_SUITE}"` +
                (request.caseFilter !== undefined
                  ? ` matching case filter "${request.caseFilter}"`
                  : "") +
                ".",
            }),
          ),
        );
      }

      const workItems = this.buildWorkItems(cases, request.modelFilter);
      if (workItems.length === 0) {
        return new ResultAsync(
          Promise.resolve(
            err<RunnerResult, RunnerError>({
              type: "NoCasesFound",
              suite: SPINDLE_TOOLS_SUITE,
              message:
                request.modelFilter !== undefined
                  ? `No cases found in suite "${SPINDLE_TOOLS_SUITE}" matching model filter "${request.modelFilter}".`
                  : `No cases found in suite "${SPINDLE_TOOLS_SUITE}".`,
            }),
          ),
        );
      }

      if (dryRun) {
        const caseResults = workItems.map(({ evalCase, modelId }) =>
          buildDryRunResult(evalCase, modelId),
        );
        return ResultAsync.fromSafePromise(
          Promise.resolve(
            this.assembleResult(SPINDLE_TOOLS_SUITE, caseResults),
          ),
        );
      }

      return this.promptProvider
        .getPrompt("spindle")
        .mapErr(
          (): RunnerError => ({
            type: "PromptProviderFailed",
            agentName: "spindle",
            message:
              "Spindle prompt provider failed: prompt composition could not complete.",
          }),
        )
        .andThen((systemPrompt) =>
          this.executeWorkItems(
            workItems,
            rubrics,
            rawArtifacts,
            systemPrompt,
          ).andThen((caseResults) =>
            ResultAsync.fromSafePromise(
              Promise.resolve(
                this.assembleResult(SPINDLE_TOOLS_SUITE, caseResults),
              ),
            ),
          ),
        );
    });
  }

  private buildWorkItems(
    cases: EvalCase[],
    modelFilter: string | undefined,
  ): Array<{ evalCase: EvalCase; modelId: string }> {
    const items: Array<{ evalCase: EvalCase; modelId: string }> = [];

    for (const evalCase of cases) {
      if (modelFilter !== undefined) {
        if (!evalCase.allowed_models.includes(modelFilter)) {
          continue;
        }
        items.push({ evalCase, modelId: modelFilter });
        continue;
      }

      const modelId = evalCase.allowed_models[0];
      if (modelId !== undefined) {
        items.push({ evalCase, modelId });
      }
    }

    return items;
  }

  private executeWorkItems(
    workItems: Array<{ evalCase: EvalCase; modelId: string }>,
    rubrics: EvalRubric[],
    rawArtifacts: boolean,
    systemPrompt: string,
  ): ResultAsync<CaseResult[], never> {
    const executeAll = workItems.reduce(
      (acc, item) =>
        acc.andThen((results) =>
          this.executeSingleCase(
            item.evalCase,
            item.modelId,
            rubrics,
            rawArtifacts,
            systemPrompt,
          ).map((result) => [...results, result]),
        ),
      ResultAsync.fromSafePromise(Promise.resolve([] as CaseResult[])),
    );

    return executeAll as ResultAsync<CaseResult[], never>;
  }

  private executeSingleCase(
    evalCase: EvalCase,
    modelId: string,
    rubrics: EvalRubric[],
    rawArtifacts: boolean,
    systemPrompt: string,
  ): ResultAsync<CaseResult, never> {
    const userMessage = buildUserMessage(evalCase);

    const modelResultAsync = this.modelClient.complete({
      model: modelId,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.1,
    });

    const matchPromise = modelResultAsync
      .andThen((response) => {
        const runOutput = buildModelRunOutput(
          evalCase,
          modelId,
          userMessage,
          response.content,
        );

        return this.scorer
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
            dimensionScores: buildDimensionScoreSummary(scoreRecord.dimensions),
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
                dimensionRationales: buildDimensionRationales(
                  scoreRecord.dimensions,
                ),
              }
            : undefined;

          return { summary, rawArtifact };
        },
        (error) => {
          const errorType =
            "type" in error
              ? String((error as { type: string }).type)
              : "UnknownError";
          const dimension =
            "dimension" in error
              ? String((error as { dimension: string }).dimension)
              : undefined;
          const rawMessage =
            "message" in error
              ? String((error as { message: string }).message)
              : undefined;

          return buildErrorResult(
            evalCase,
            modelId,
            errorType,
            rawArtifacts,
            dimension,
            rawMessage,
          );
        },
      );

    return new ResultAsync(
      matchPromise.then((result) => ok<CaseResult, never>(result)),
    );
  }

  private assembleResult(
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
}

function makeDefaultSpindlePromptProvider(): PromptProvider {
  return {
    getPrompt: (agentName: string) => {
      const importPromise = ResultAsync.fromPromise(
        import("./prompt-snapshots.js"),
        (cause): ProvenanceError => ({
          type: "PromptCompositionError",
          agentName,
          message: `Dynamic import of prompt-snapshots failed: ${String(cause)}`,
        }),
      );

      return importPromise.andThen(({ composeAgentSnapshots }) =>
        composeAgentSnapshots({ agentNames: [agentName], rawArtifacts: true })
          .mapErr((provErr): ProvenanceError => provErr)
          .andThen((snapshotResult) => {
            const raw = snapshotResult.rawArtifacts.find(
              (a) => a.agentName === agentName,
            );
            if (raw !== undefined) {
              return ResultAsync.fromSafePromise(
                Promise.resolve(raw.composedPrompt),
              );
            }

            return new ResultAsync<string, ProvenanceError>(
              Promise.resolve(
                err<string, ProvenanceError>({
                  type: "PromptCompositionError",
                  agentName,
                  message: `No raw artifact found for agent "${agentName}" after composition.`,
                }),
              ),
            );
          }),
      );
    },
  };
}

function buildDimensionScoreSummary(
  dimensions: NormalizedScoreRecord["dimensions"],
): Record<ScoringDimension, { score: number; applicable: boolean }> {
  return {
    routingCorrectness: {
      score: dimensions.routingCorrectness.score,
      applicable: dimensions.routingCorrectness.applicable,
    },
    delegationCorrectness: {
      score: dimensions.delegationCorrectness.score,
      applicable: dimensions.delegationCorrectness.applicable,
    },
    executionCompleteness: {
      score: dimensions.executionCompleteness.score,
      applicable: dimensions.executionCompleteness.applicable,
    },
    rationaleQuality: {
      score: dimensions.rationaleQuality.score,
      applicable: dimensions.rationaleQuality.applicable,
    },
  };
}

function buildDimensionRationales(
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
