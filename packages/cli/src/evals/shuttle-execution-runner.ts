/**
 * Shuttle execution eval runner for `weave eval run`.
 *
 * Executes the `shuttle-execution` suite against synthetic delegated-task text
 * prompts. The suite remains text-only: it scores bounded file awareness,
 * acceptance evidence, command/check results, honest assumptions, and the
 * absence of fabricated telemetry from assistant text alone.
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
const TASK_INTAKE_HEADER_RE = /^\s*(?:##+\s*)?Task intake\s*:?\s*$/im;
const WHAT_LINE_RE = /^\s*(?:[-*]\s+)?(?:\*\*)?What(?:\*\*)?:\s+.+$/im;
const FILES_LINE_RE = /^\s*(?:[-*]\s+)?(?:\*\*)?Files(?:\*\*)?:\s+.+$/im;
const FILE_PATH_RE =
  /`([^`]+)`|\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\b|\b[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|weave|yml|yaml|css|scss|html|go|rs|py)\b/g;
const ACCEPTANCE_HEADER_RE =
  /^\s*(?:##\s+Acceptance|Acceptance:|\*\*Acceptance\*\*:)/im;
const ACCEPTANCE_CHECK_RE = /^\s*[-*]\s+(?:\[[ xX]\]\s*)?.+$/gm;
const COMMAND_LINE_RE =
  /^\s*(?:[-*]\s+)?(?:bun|npm|pnpm|yarn|git|cargo|go|pytest|vitest|jest|deno)\b.+$/gim;
const TEST_RESULT_RE =
  /\b(?:pass|passed|fail|failed|skipped)\b.*\b\d+\b|\b\d+\s*(?:passed|failed|skipped)\b/gi;
const ACCEPTANCE_EVIDENCE_RE =
  /\b(?:acceptance criteria|acceptance|success criteria)\b[\s\S]{0,240}\b(?:met|satisfied|confirmed|complete|completed|pass|passed|fail|failed|not met|unable)\b/i;
const HONESTY_SIGNAL_RE =
  /\b(?:assumption|assumptions|text[- ]only|synthetic|not observed|cannot verify|not run|did not run|no real|no tool|no telemetry|unavailable)\b/i;
const FABRICATED_TELEMETRY_RE =
  /\b(?:actual|real)\s+(?:file|filesystem|shell|tool|network|mutation|telemetry)\b|\b(?:tool|shell|filesystem|file mutation|network)\s+telemetry\b/i;

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
  /** Legacy diagnostic: retained for compatibility, not a completion gate. */
  taskIntakeStructured: boolean;
  filesAcknowledged: boolean;
  fileScopeBounded: boolean;
  acceptanceConfirmed: boolean;
  acceptanceEvidence: boolean;
  evidenceReported: boolean;
  checksReported: boolean;
  assumptionsHonest: boolean;
  fabricatedTelemetryDetected: boolean;
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
  const taskIntakeRestated =
    TASK_INTAKE_HEADER_RE.test(content) &&
    WHAT_LINE_RE.test(content) &&
    FILES_LINE_RE.test(content) &&
    ACCEPTANCE_HEADER_RE.test(content);

  const taskIntakeStructured =
    /\btask\s*\[\d+\/\d+\]\b/i.test(content) ||
    taskIntakeRestated ||
    lower.includes("acceptance:") ||
    lower.includes("files changed") ||
    lower.includes("commands run");

  const filesAcknowledged =
    lower.includes("files changed") ||
    lower.includes("files:") ||
    fileBullets.length > 0;

  const fileScopeBounded = fileRefs.length > 0 && fileRefs.length <= 20;
  const acceptanceEvidence = ACCEPTANCE_EVIDENCE_RE.test(content);
  const acceptanceConfirmed =
    acceptanceEvidence ||
    /all acceptance criteria (?:are )?met/i.test(content) ||
    /acceptance criteria (?:met|satisfied|confirmed)/i.test(content) ||
    (ACCEPTANCE_HEADER_RE.test(content) && acceptanceLines.length > 0);
  const checksReported = commandLines.length > 0 && testResultLines.length > 0;
  const evidenceReported = checksReported || lower.includes("commands run");
  const assumptionsHonest = HONESTY_SIGNAL_RE.test(content);
  const fabricatedTelemetryDetected = content
    .split(/\n/)
    .some(
      (line) =>
        FABRICATED_TELEMETRY_RE.test(line) &&
        !/\b(?:no|not|without|didn't|did not|cannot|unable to)\b/i.test(line),
    );

  const producedArtifacts = new Set<string>();

  if (taskIntakeStructured) {
    producedArtifacts.add("shuttle_task_intake_structured");
  }
  if (filesAcknowledged && fileScopeBounded) {
    producedArtifacts.add("shuttle_files_acknowledged");
    producedArtifacts.add("shuttle_file_scope_bounded");
  }
  if (acceptanceConfirmed && acceptanceEvidence) {
    producedArtifacts.add("shuttle_acceptance_confirmed");
    producedArtifacts.add("shuttle_acceptance_evidence");
  }
  if (evidenceReported) {
    producedArtifacts.add("shuttle_evidence_reported");
  }
  if (checksReported) {
    producedArtifacts.add("shuttle_checks_reported");
  }
  if (assumptionsHonest && !fabricatedTelemetryDetected) {
    producedArtifacts.add("shuttle_honest_assumptions");
  }

  return {
    taskIntakeStructured,
    filesAcknowledged,
    fileScopeBounded,
    acceptanceConfirmed,
    acceptanceEvidence,
    evidenceReported,
    checksReported,
    assumptionsHonest,
    fabricatedTelemetryDetected,
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
    routedAgents:
      signals.fileScopeBounded && signals.acceptanceEvidence ? ["shuttle"] : [],
    delegationChain: [],
    transcript,
    rawContent: content,
    completionSignalled:
      signals.fileScopeBounded &&
      signals.acceptanceEvidence &&
      signals.checksReported &&
      signals.assumptionsHonest &&
      !signals.fabricatedTelemetryDetected,
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
    `Delegated task: ${evalCase.description}`,
    "Relevant files include packages/cli/src/evals/shuttle-execution-runner.ts and evals/README.md.",
    "Report only bounded, text-visible completion evidence.",
    "Include enough file scope to show what was considered, acceptance evidence, commands or checks with their results, and any honest assumptions or limits.",
    "Do not claim hidden file mutation, tool telemetry, shell history, network activity, or other evidence you did not observe.",
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
