/**
 * Pattern planning eval runner for `weave eval run`.
 *
 * Executes the `pattern-planning` suite against text-only plan-quality fixtures.
 * Structural scoring comes from deterministic signals extracted from the model
 * response, then flows through the existing scorer path for normalized output.
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
  RawCaseResultArtifact,
  RawErrorSummary,
  RunnerError,
  RunnerResult,
  ScoringDimension,
  TranscriptMessage,
} from "./types.js";

export const PATTERN_PLANNING_SUITE = "pattern-planning";

const STRUCTURAL_TAG_RE = /(?:^|\s)#(?<tag>[a-z_][a-z0-9_-]*)\b/gim;
const TASK_CHECKBOX_LINE_RE = /^\s*[-*]\s*\[[ xX]?\]\s+.+$/gm;
const TASK_NUMBERED_LINE_RE = /^\s*\d+\.\s+.+$/gm;
const TASKS_HEADING_RE = /^\s*(?:#{1,6}\s*)?tasks?\b\s*:?(?:\s|$)/im;
const WHAT_FIELD_RE = /^\s*[-*]?\s*(?:\*\*)?what(?:\*\*)?\s*:/gim;
const FILE_TOKEN_RE =
  /`([^`]+)`|\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\b|\b[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|weave|yml|yaml|css|scss|html)\b/g;
const ACCEPTANCE_LINE_RE =
  /^\s*(?:[-*]|\d+\.)\s+(?:acceptance|verify|confirm|ensure|assert|expect)\b.+$|^\s*[-*]?\s*(?:\*\*)?acceptance(?:\s+criteria)?(?:\*\*)?\s*:/gim;

const SCOPE_HEADING_RE = /^\s*(?:#{1,6}\s*)?scope\b\s*:?(?:\s|$)/im;
const FILES_HEADING_RE = /^\s*(?:#{1,6}\s*)?files?\b\s*:?(?:\s|$)/im;
const FILES_FIELD_RE = /^\s*[-*]?\s*(?:\*\*)?files?(?:\*\*)?\s*:/im;
const FILES_FIELD_GLOBAL_RE = /^\s*[-*]?\s*(?:\*\*)?files?(?:\*\*)?\s*:/gim;
const ORDER_HEADING_RE =
  /^\s*(?:#{1,6}\s*)?(?:sequence|order|order of operations|implementation order|execution order|dependencies and order)\b\s*:?(?:\s|$)/im;
const DEPENDENCY_FIELD_RE =
  /^\s*[-*]?\s*(?:\*\*)?(?:depends on|dependencies?)(?:\*\*)?\s*:/im;
const DEPENDENCY_FIELD_GLOBAL_RE =
  /^\s*[-*]?\s*(?:\*\*)?(?:depends on|dependencies?)(?:\*\*)?\s*:/gim;
const ACCEPTANCE_HEADING_RE =
  /^\s*(?:#{1,6}\s*)?(?:acceptance(?:\s+criteria)?|success\s+criteria)\b\s*:?(?:\s|$)/im;
const ACCEPTANCE_FIELD_RE =
  /^\s*[-*]?\s*(?:\*\*)?acceptance(?:\s+criteria)?(?:\*\*)?\s*:/im;
const ACCEPTANCE_FIELD_GLOBAL_RE =
  /^\s*[-*]?\s*(?:\*\*)?acceptance(?:\s+criteria)?(?:\*\*)?\s*:/gim;
const SUCCESS_CRITERIA_FIELD_RE =
  /^\s*[-*]?\s*(?:\*\*)?(?:success|completion)\s+criteria(?:\*\*)?\s*:/im;
const SUCCESS_CRITERIA_FIELD_GLOBAL_RE =
  /^\s*[-*]?\s*(?:\*\*)?(?:success|completion)\s+criteria(?:\*\*)?\s*:/gim;

const STRUCTURAL_ARTIFACTS = [
  "plan_scope_explicit",
  "plan_file_tasks",
  "plan_sequence_explicit",
  "plan_acceptance_coverage",
] as const;

type StructuralArtifact = (typeof STRUCTURAL_ARTIFACTS)[number];

function countMatches(content: string, pattern: RegExp): number {
  return [...content.matchAll(pattern)].length;
}

type PlanningSignals = ReturnType<typeof extractPlanningSignals>;

function detectStructuralArtifacts(
  content: string,
  evidence: {
    hasTaskStructure: boolean;
    fileCount: number;
    fileFieldCount: number;
    acceptanceCount: number;
    acceptanceFieldCount: number;
    successCriteriaFieldCount: number;
    numberedLineCount: number;
  },
): StructuralArtifact[] {
  const lower = content.toLowerCase();
  const tags = new Set<string>();

  for (const match of lower.matchAll(STRUCTURAL_TAG_RE)) {
    const tag = match.groups?.tag;
    if (tag !== undefined) {
      tags.add(tag);
    }
  }

  const produced: StructuralArtifact[] = [];
  if (tags.has("scope") || SCOPE_HEADING_RE.test(content)) {
    produced.push("plan_scope_explicit");
  }
  if (
    (tags.has("files") &&
      evidence.hasTaskStructure &&
      evidence.fileCount > 0) ||
    ((FILES_HEADING_RE.test(content) || FILES_FIELD_RE.test(content)) &&
      evidence.hasTaskStructure &&
      evidence.fileCount > 0) ||
    (evidence.fileFieldCount > 0 &&
      evidence.hasTaskStructure &&
      evidence.fileCount > 0)
  ) {
    produced.push("plan_file_tasks");
  }
  if (
    tags.has("sequence") ||
    ORDER_HEADING_RE.test(content) ||
    DEPENDENCY_FIELD_RE.test(content) ||
    /\bstep\s+1\b/.test(lower) ||
    (TASKS_HEADING_RE.test(content) && evidence.numberedLineCount >= 2)
  ) {
    produced.push("plan_sequence_explicit");
  }
  if (
    (tags.has("acceptance") && evidence.acceptanceCount > 0) ||
    ACCEPTANCE_HEADING_RE.test(content) ||
    ACCEPTANCE_FIELD_RE.test(content) ||
    SUCCESS_CRITERIA_FIELD_RE.test(content) ||
    /\bacceptance\s+criteria\b/.test(lower) ||
    ((evidence.acceptanceFieldCount > 0 ||
      evidence.successCriteriaFieldCount > 0) &&
      evidence.hasTaskStructure)
  ) {
    produced.push("plan_acceptance_coverage");
  }

  return produced;
}

export function extractPlanningSignals(content: string): {
  scopeExplicit: boolean;
  fileBackedTasks: boolean;
  sequencingExplicit: boolean;
  acceptanceCoverage: boolean;
  taskCount: number;
  fileCount: number;
  acceptanceCount: number;
  producedArtifacts: string[];
} {
  const checklistTaskCount = countMatches(content, TASK_CHECKBOX_LINE_RE);
  const numberedLineCount = countMatches(content, TASK_NUMBERED_LINE_RE);
  const whatFieldCount = countMatches(content, WHAT_FIELD_RE);
  const fileFieldCount = countMatches(content, FILES_FIELD_GLOBAL_RE);
  const dependencyCount = countMatches(content, DEPENDENCY_FIELD_GLOBAL_RE);
  const acceptanceFieldCount = countMatches(
    content,
    ACCEPTANCE_FIELD_GLOBAL_RE,
  );
  const successCriteriaFieldCount = countMatches(
    content,
    SUCCESS_CRITERIA_FIELD_GLOBAL_RE,
  );
  const fileMatches = [...content.matchAll(FILE_TOKEN_RE)];
  const acceptanceCount = countMatches(content, ACCEPTANCE_LINE_RE);
  const hasTaskStructure =
    checklistTaskCount > 0 ||
    whatFieldCount > 0 ||
    fileFieldCount > 0 ||
    acceptanceFieldCount > 0 ||
    successCriteriaFieldCount > 0 ||
    TASKS_HEADING_RE.test(content);
  const taskCount = Math.max(
    checklistTaskCount,
    whatFieldCount,
    fileFieldCount,
    acceptanceFieldCount + successCriteriaFieldCount,
    TASKS_HEADING_RE.test(content) ? numberedLineCount : 0,
  );
  const producedArtifacts = detectStructuralArtifacts(content, {
    hasTaskStructure,
    fileCount: fileMatches.length,
    fileFieldCount,
    acceptanceCount,
    acceptanceFieldCount,
    successCriteriaFieldCount,
    numberedLineCount,
  });

  return {
    scopeExplicit: producedArtifacts.includes("plan_scope_explicit"),
    fileBackedTasks:
      producedArtifacts.includes("plan_file_tasks") ||
      (taskCount > 0 && fileFieldCount > 0 && fileMatches.length > 0),
    sequencingExplicit:
      producedArtifacts.includes("plan_sequence_explicit") ||
      dependencyCount > 0 ||
      (TASKS_HEADING_RE.test(content) && numberedLineCount >= 2),
    acceptanceCoverage:
      producedArtifacts.includes("plan_acceptance_coverage") ||
      ((acceptanceFieldCount > 0 || successCriteriaFieldCount > 0) &&
        taskCount > 0) ||
      acceptanceCount > 0,
    taskCount,
    fileCount: fileMatches.length,
    acceptanceCount,
    producedArtifacts,
  };
}

function requiredPlanningArtifacts(evalCase: EvalCase): string[] {
  if (evalCase.expected_outcome.kind !== "task_completion") {
    return [];
  }

  return evalCase.expected_outcome.required_artifacts;
}

function hasRequiredPlanningArtifacts(
  evalCase: EvalCase,
  producedArtifacts: readonly string[],
): boolean {
  const requiredArtifacts = requiredPlanningArtifacts(evalCase);
  if (requiredArtifacts.length === 0) {
    return false;
  }

  return requiredArtifacts.every((artifact) =>
    producedArtifacts.includes(artifact),
  );
}

function missingRequiredPlanningArtifacts(
  evalCase: EvalCase,
  producedArtifacts: readonly string[],
): string[] {
  return requiredPlanningArtifacts(evalCase).filter(
    (artifact) => !producedArtifacts.includes(artifact),
  );
}

export function buildPlanningRunnerDiagnostics(
  evalCase: EvalCase,
  signals: PlanningSignals,
): NonNullable<RawCaseResultArtifact["runnerDiagnostics"]> {
  return {
    detectedArtifacts: signals.producedArtifacts,
    missingRequiredArtifacts: missingRequiredPlanningArtifacts(
      evalCase,
      signals.producedArtifacts,
    ),
    planningSignals: {
      scopeExplicit: signals.scopeExplicit,
      fileBackedTasks: signals.fileBackedTasks,
      sequencingExplicit: signals.sequencingExplicit,
      acceptanceCoverage: signals.acceptanceCoverage,
      taskCount: signals.taskCount,
      fileCount: signals.fileCount,
      acceptanceCount: signals.acceptanceCount,
    },
  };
}

export function buildModelRunOutput(
  evalCase: EvalCase,
  modelId: string,
  userMessage: string,
  content: string,
): ModelRunOutput {
  const signals = extractPlanningSignals(content);
  const transcript: TranscriptMessage[] = [
    { role: "user", content: userMessage },
    { role: "assistant", content },
  ];

  return {
    caseId: evalCase.id,
    modelId,
    routedAgents: signals.scopeExplicit ? ["pattern"] : [],
    delegationChain: [],
    transcript,
    rawContent: content,
    completionSignalled: hasRequiredPlanningArtifacts(
      evalCase,
      signals.producedArtifacts,
    ),
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

const LOCAL_DIAGNOSTIC_MAX_CHARS = 500;
const SECRET_REDACTION_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
  [/\bsk-(?:or-|proj-)?[A-Za-z0-9_-]{8,}/g, "[REDACTED-KEY]"],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, "[REDACTED-KEY]"],
  [/\b[0-9a-f]{32,}\b/gi, "[REDACTED-HEX]"],
  [/Authorization:\s*[^\s,;\n]{8,}/gi, "Authorization: [REDACTED]"],
  [/[?&](?:api_key|apikey|key|token)=[^&\s]{4,}/gi, "?[key]=[REDACTED]"],
];

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
    "Create a concise implementation plan.",
    `Goal: ${evalCase.description}`,
    "Respond as a text-only plan, not code.",
    "Include explicit scope, file-backed tasks, sequencing with dependency language, and acceptance coverage.",
    "Use clear section headings and task fields such as `## Scope`, `## Dependencies and Order`, `**Files**`, and `**Acceptance**`.",
    requiredArtifacts.length > 0
      ? `Required structural signals: ${requiredArtifacts.join(", ")}`
      : "Required structural signals: none",
  ].join("\n");
}

export interface PatternPlanningRunnerOptions {
  modelClient: ModelClient;
  scorer: AgentEvalsScorer;
  promptProvider?: PromptProvider;
  patternSystemPrompt?: string;
  evalsRoot?: string;
}

export interface PatternPlanningRunRequest {
  caseFilter?: string;
  modelFilter?: string;
  dryRun?: boolean;
  rawArtifacts?: boolean;
}

export class PatternPlanningRunner {
  private readonly modelClient: ModelClient;
  private readonly scorer: AgentEvalsScorer;
  private readonly promptProvider: PromptProvider;
  private readonly evalsRoot: string | undefined;

  constructor(options: PatternPlanningRunnerOptions) {
    this.modelClient = options.modelClient;
    this.scorer = options.scorer;
    this.evalsRoot = options.evalsRoot;

    if (options.promptProvider !== undefined) {
      this.promptProvider = options.promptProvider;
      return;
    }

    if (options.patternSystemPrompt !== undefined) {
      const prompt = options.patternSystemPrompt;
      this.promptProvider = {
        getPrompt: (_agentName: string) =>
          ResultAsync.fromSafePromise(Promise.resolve(prompt)),
      };
      return;
    }

    this.promptProvider = makeDefaultPatternPromptProvider();
  }

  run(
    request: PatternPlanningRunRequest = {},
  ): ResultAsync<RunnerResult, RunnerError> {
    const dryRun = request.dryRun ?? false;
    const rawArtifacts = request.rawArtifacts ?? false;

    const casesAsync =
      this.evalsRoot !== undefined
        ? loadSuiteCases(PATTERN_PLANNING_SUITE, this.evalsRoot)
        : loadSuiteCases(PATTERN_PLANNING_SUITE);

    const rubricsAsync =
      this.evalsRoot !== undefined
        ? loadSuiteRubrics(PATTERN_PLANNING_SUITE, this.evalsRoot)
        : loadSuiteRubrics(PATTERN_PLANNING_SUITE);

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
              suite: PATTERN_PLANNING_SUITE,
              message:
                `No cases found in suite "${PATTERN_PLANNING_SUITE}"` +
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
              suite: PATTERN_PLANNING_SUITE,
              message:
                request.modelFilter !== undefined
                  ? `No cases found in suite "${PATTERN_PLANNING_SUITE}" matching model filter "${request.modelFilter}".`
                  : `No cases found in suite "${PATTERN_PLANNING_SUITE}".`,
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
            this.assembleResult(PATTERN_PLANNING_SUITE, caseResults),
          ),
        );
      }

      return this.promptProvider
        .getPrompt("pattern")
        .mapErr(
          (): RunnerError => ({
            type: "PromptProviderFailed",
            agentName: "pattern",
            message:
              "Pattern prompt provider failed: prompt composition could not complete.",
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
                this.assembleResult(PATTERN_PLANNING_SUITE, caseResults),
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
                runnerDiagnostics: buildPlanningRunnerDiagnostics(
                  evalCase,
                  extractPlanningSignals(runOutput.rawContent),
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

function makeDefaultPatternPromptProvider(): PromptProvider {
  return {
    getPrompt: (agentName: string) => {
      const importPromise = ResultAsync.fromPromise(
        import("./prompt-snapshots.js"),
        (cause): import("./types.js").ProvenanceError => ({
          type: "PromptCompositionError",
          agentName,
          message: `Dynamic import of prompt-snapshots failed: ${String(cause)}`,
        }),
      );

      return importPromise.andThen(({ composeAgentSnapshots }) =>
        composeAgentSnapshots({ agentNames: [agentName], rawArtifacts: true })
          .mapErr((provErr): import("./types.js").ProvenanceError => provErr)
          .andThen((snapshotResult) => {
            const raw = snapshotResult.rawArtifacts.find(
              (a) => a.agentName === agentName,
            );
            if (raw !== undefined) {
              return ResultAsync.fromSafePromise(
                Promise.resolve(raw.composedPrompt),
              );
            }

            return new ResultAsync<
              string,
              import("./types.js").ProvenanceError
            >(
              Promise.resolve(
                err<string, import("./types.js").ProvenanceError>({
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
