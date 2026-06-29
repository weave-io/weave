/**
 * Shuttle execution eval runner for `weave eval run`.
 *
 * Executes the `shuttle-execution` suite against synthetic delegated-task text
 * prompts. The suite remains text-only: it scores whether the assistant
 * reflects Shuttle task intake structure, file-list awareness, acceptance
 * confirmation, and final evidence reporting from assistant text alone.
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

export const SHUTTLE_EXECUTION_SUITE = "shuttle-execution";

const LOCAL_DIAGNOSTIC_MAX_CHARS = 500;
const SECRET_REDACTION_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
  [/\bsk-(?:or-|proj-)?[A-Za-z0-9_-]{8,}/g, "[REDACTED-KEY]"],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, "[REDACTED-KEY]"],
  [/\b[0-9a-f]{32,}\b/gi, "[REDACTED-HEX]"],
  [/Authorization:\s*[^\s,;\n]{8,}/gi, "Authorization: [REDACTED]"],
  [/[?&](?:api_key|apikey|key|token)=[^&\s]{4,}/gi, "?[key]=[REDACTED]"],
];

const FILE_BULLET_RE = /^\s*[-*]\s+[^\n]+$/gim;
const FILE_PATH_RE =
  /`([^`]+)`|\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\b|\b[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|weave|yml|yaml|css|scss|html|go|rs|py)\b/g;
const ACCEPTANCE_HEADER_RE =
  /^\s*(?:##\s+Acceptance|Acceptance:|\*\*Acceptance\*\*:)/im;
const ACCEPTANCE_CHECK_RE = /^\s*[-*]\s+(?:\[[ xX]\]\s*)?.+$/gm;
const COMMAND_LINE_RE =
  /^\s*(?:[-*]\s+)?(?:bun|npm|pnpm|yarn|git|cargo|go|pytest|vitest|jest|deno)\b.+$/gim;
const TEST_RESULT_RE =
  /\b(?:pass|passed|fail|failed)\b.*\b\d+\b|\b\d+\s*(?:passed|failed)\b/gi;

function extractFileReferences(content: string): string[] {
  const refs = new Set<string>();

  for (const match of content.matchAll(FILE_PATH_RE)) {
    const ref = match[1] ?? match[0];
    if (ref !== undefined && ref.trim() !== "") {
      refs.add(ref);
    }
  }

  return [...refs];
}

export interface ShuttleExecutionSignals {
  taskIntakeStructured: boolean;
  filesAcknowledged: boolean;
  acceptanceConfirmed: boolean;
  evidenceReported: boolean;
  filesChangedCount: number;
  commandsReportedCount: number;
  testResultCount: number;
  producedArtifacts: string[];
}

export function extractShuttleExecutionSignals(
  content: string,
): ShuttleExecutionSignals {
  const lower = content.toLowerCase();
  const fileRefs = extractFileReferences(content);
  const fileBullets = [...content.matchAll(FILE_BULLET_RE)].filter(
    (match) => extractFileReferences(match[0] ?? "").length > 0,
  );
  const acceptanceLines = [...content.matchAll(ACCEPTANCE_CHECK_RE)];
  const commandLines = [...content.matchAll(COMMAND_LINE_RE)];
  const testResultLines = [...content.matchAll(TEST_RESULT_RE)];

  const taskIntakeStructured =
    /\btask\s*\[\d+\/\d+\]\b/i.test(content) ||
    lower.includes("acceptance:") ||
    lower.includes("files changed") ||
    lower.includes("commands run");

  const filesAcknowledged =
    lower.includes("files changed") ||
    lower.includes("files:") ||
    fileBullets.length > 0;

  const acceptanceConfirmed =
    /all acceptance criteria (?:are )?met/i.test(content) ||
    /acceptance criteria (?:met|satisfied|confirmed)/i.test(content) ||
    (ACCEPTANCE_HEADER_RE.test(content) && acceptanceLines.length > 0);

  const evidenceReported =
    lower.includes("commands run") ||
    lower.includes("test results") ||
    lower.includes("pass/fail") ||
    commandLines.length > 0;

  const producedArtifacts = new Set<string>();

  if (taskIntakeStructured) {
    producedArtifacts.add("shuttle_task_intake_structured");
  }
  if (filesAcknowledged) {
    producedArtifacts.add("shuttle_files_acknowledged");
  }
  if (acceptanceConfirmed) {
    producedArtifacts.add("shuttle_acceptance_confirmed");
  }
  if (evidenceReported) {
    producedArtifacts.add("shuttle_evidence_reported");
  }
  if (commandLines.length > 0) {
    producedArtifacts.add("shuttle_commands_reported");
  }
  if (testResultLines.length > 0) {
    producedArtifacts.add("shuttle_test_results_reported");
  }

  return {
    taskIntakeStructured,
    filesAcknowledged,
    acceptanceConfirmed,
    evidenceReported,
    filesChangedCount: fileRefs.length,
    commandsReportedCount: commandLines.length,
    testResultCount: testResultLines.length,
    producedArtifacts: [...producedArtifacts],
  };
}

function buildModelRunOutput(
  evalCase: EvalCase,
  modelId: string,
  userMessage: string,
  content: string,
): ModelRunOutput {
  const signals = extractShuttleExecutionSignals(content);
  const transcript: TranscriptMessage[] = [
    { role: "user", content: userMessage },
    { role: "assistant", content },
  ];

  return {
    caseId: evalCase.id,
    modelId,
    routedAgents: signals.taskIntakeStructured ? ["shuttle"] : [],
    delegationChain: [],
    transcript,
    rawContent: content,
    completionSignalled:
      signals.taskIntakeStructured &&
      signals.filesAcknowledged &&
      signals.acceptanceConfirmed &&
      signals.evidenceReported,
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
    "Task [1/1]: Synthetic Shuttle delegated task",
    `**What**: ${evalCase.description}`,
    "**Files**: packages/cli/src/evals/shuttle-execution-runner.ts, evals/README.md",
    "**Acceptance**: Reflect bounded task intake, file-list awareness, acceptance-criteria confirmation, and final evidence reporting from text only.",
    "**Context from completed tasks**: Reuse the current text-only execution model.",
    "**Learnings**: Do not claim real file mutation or tool telemetry.",
    "",
    "Respond exactly like Shuttle reporting completed delegated work.",
    "Include sections for Files changed, Commands run and their output, Test results, Issues/assumptions, and explicit acceptance confirmation.",
    requiredArtifacts.length > 0
      ? `Required structural signals: ${requiredArtifacts.join(", ")}`
      : "Required structural signals: none",
  ].join("\n");
}

export interface ShuttleExecutionRunnerOptions {
  modelClient: ModelClient;
  scorer: AgentEvalsScorer;
  promptProvider?: PromptProvider;
  shuttleSystemPrompt?: string;
  evalsRoot?: string;
}

export interface ShuttleExecutionRunRequest {
  caseFilter?: string;
  modelFilter?: string;
  dryRun?: boolean;
  rawArtifacts?: boolean;
}

export class ShuttleExecutionRunner {
  private readonly modelClient: ModelClient;
  private readonly scorer: AgentEvalsScorer;
  private readonly promptProvider: PromptProvider;
  private readonly evalsRoot: string | undefined;

  constructor(options: ShuttleExecutionRunnerOptions) {
    this.modelClient = options.modelClient;
    this.scorer = options.scorer;
    this.evalsRoot = options.evalsRoot;

    if (options.promptProvider !== undefined) {
      this.promptProvider = options.promptProvider;
      return;
    }

    if (options.shuttleSystemPrompt !== undefined) {
      const prompt = options.shuttleSystemPrompt;
      this.promptProvider = {
        getPrompt: (_agentName: string) =>
          ResultAsync.fromSafePromise(Promise.resolve(prompt)),
      };
      return;
    }

    this.promptProvider = makeDefaultShuttlePromptProvider();
  }

  run(
    request: ShuttleExecutionRunRequest = {},
  ): ResultAsync<RunnerResult, RunnerError> {
    const dryRun = request.dryRun ?? false;
    const rawArtifacts = request.rawArtifacts ?? false;

    const casesAsync =
      this.evalsRoot !== undefined
        ? loadSuiteCases(SHUTTLE_EXECUTION_SUITE, this.evalsRoot)
        : loadSuiteCases(SHUTTLE_EXECUTION_SUITE);

    const rubricsAsync =
      this.evalsRoot !== undefined
        ? loadSuiteRubrics(SHUTTLE_EXECUTION_SUITE, this.evalsRoot)
        : loadSuiteRubrics(SHUTTLE_EXECUTION_SUITE);

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
              suite: SHUTTLE_EXECUTION_SUITE,
              message:
                `No cases found in suite "${SHUTTLE_EXECUTION_SUITE}"` +
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
              suite: SHUTTLE_EXECUTION_SUITE,
              message:
                request.modelFilter !== undefined
                  ? `No cases match model filter "${request.modelFilter}".`
                  : `No cases found in suite "${SHUTTLE_EXECUTION_SUITE}".`,
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
            this.assembleResult(SHUTTLE_EXECUTION_SUITE, caseResults),
          ),
        );
      }

      return this.promptProvider
        .getPrompt("shuttle")
        .mapErr(
          (): RunnerError => ({
            type: "PromptProviderFailed",
            agentName: "shuttle",
            message:
              "Shuttle prompt provider failed: prompt composition could not complete.",
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
                this.assembleResult(SHUTTLE_EXECUTION_SUITE, caseResults),
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
      temperature: 0.2,
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
}

function makeDefaultShuttlePromptProvider(): PromptProvider {
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
              (artifact) => artifact.agentName === agentName,
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

  for (const [dimension, score] of Object.entries(dimensions) as Array<
    [ScoringDimension, DimensionScore]
  >) {
    if (score.applicable) {
      rationales[dimension] = score.rationale;
    }
  }

  return rationales;
}
