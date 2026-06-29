/**
 * Warp security eval runner for `weave eval run`.
 *
 * Executes the `warp-security` suite against synthetic security-review prompts.
 * Scoring stays text-only: verdict format, capped blocker counts, and
 * evidence-backed security finding structure are extracted from assistant text.
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

export const WARP_SECURITY_SUITE = "warp-security";

const VERDICT_APPROVE_RE = /^\s*APPROVE\b/im;
const VERDICT_BLOCK_RE = /^\s*BLOCK\b/im;
const FINDING_RE = /^\s*FINDING:\s+.+$/gim;
const EVIDENCE_RE = /^\s*EVIDENCE:\s+.+$/gim;
const IMPACT_RE = /^\s*IMPACT:\s+.+$/gim;
const FIX_RE = /^\s*FIX:\s+.+$/gim;
const SEVERITY_RE = /^\s*SEVERITY:\s+(LOW|MEDIUM|HIGH|CRITICAL)\b/im;
const FILE_REFERENCE_RE =
  /`([^`]+)`|\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|weave|yml|yaml|css|scss|html|go|rs|py)\b/g;
const CAP_LINE_RE = /^\s*BLOCKERS:\s*(\d+)\s*\/\s*(\d+)\s*$/im;
const MAX_CAP = 3;

const LOCAL_DIAGNOSTIC_MAX_CHARS = 500;
const SECRET_REDACTION_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
  [/\bsk-(?:or-|proj-)?[A-Za-z0-9_-]{8,}/g, "[REDACTED-KEY]"],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, "[REDACTED-KEY]"],
  [/\b[0-9a-f]{32,}\b/gi, "[REDACTED-HEX]"],
  [/Authorization:\s*[^\s,;\n]{8,}/gi, "Authorization: [REDACTED]"],
  [/[?&](?:api_key|apikey|key|token)=[^&\s]{4,}/gi, "?[key]=[REDACTED]"],
];

type SecurityVerdict = "approve" | "block" | "invalid" | "missing";

export interface SecuritySignals {
  verdict: SecurityVerdict;
  blockerCount: number;
  blockerCap: number | undefined;
  cappedBlockers: boolean;
  findingCount: number;
  evidenceBackedFindingCount: number;
  fileReferenceCount: number;
  approveDisciplined: boolean;
  blockDisciplined: boolean;
  producedArtifacts: string[];
}

function extractFileReferences(content: string): string[] {
  const references = new Set<string>();

  for (const match of content.matchAll(FILE_REFERENCE_RE)) {
    const backticked = match[1];
    const plain = match[0];
    const fileRef = backticked ?? plain;

    if (fileRef !== undefined && fileRef.trim() !== "") {
      references.add(fileRef);
    }
  }

  return [...references];
}

function parseCap(content: string): {
  blockerCount: number;
  blockerCap: number | undefined;
} {
  const capMatch = content.match(CAP_LINE_RE);
  if (capMatch === null) {
    return { blockerCount: 0, blockerCap: undefined };
  }

  const blockerCount = Number.parseInt(capMatch[1] ?? "0", 10);
  const blockerCap = Number.parseInt(capMatch[2] ?? "0", 10);

  return {
    blockerCount: Number.isFinite(blockerCount) ? blockerCount : 0,
    blockerCap: Number.isFinite(blockerCap) ? blockerCap : undefined,
  };
}

export function extractSecuritySignals(content: string): SecuritySignals {
  const hasApprove = VERDICT_APPROVE_RE.test(content);
  const hasBlock = VERDICT_BLOCK_RE.test(content);

  let verdict: SecurityVerdict = "missing";
  if (hasApprove && hasBlock) {
    verdict = "invalid";
  }
  if (hasApprove && !hasBlock) {
    verdict = "approve";
  }
  if (!hasApprove && hasBlock) {
    verdict = "block";
  }

  const findings = [...content.matchAll(FINDING_RE)];
  const evidences = [...content.matchAll(EVIDENCE_RE)];
  const impacts = [...content.matchAll(IMPACT_RE)];
  const fixes = [...content.matchAll(FIX_RE)];
  const severityPresent = SEVERITY_RE.test(content);
  const { blockerCount, blockerCap } = parseCap(content);
  const fileReferences = extractFileReferences(content);

  const evidenceBackedFindingCount = Math.min(
    findings.length,
    evidences.length,
    impacts.length,
    fixes.length,
  );

  const cappedBlockers =
    blockerCap !== undefined &&
    blockerCap <= MAX_CAP &&
    blockerCount <= blockerCap;

  const approveDisciplined =
    verdict === "approve" && blockerCount === 0 && findings.length === 0;
  const blockDisciplined =
    verdict === "block" &&
    blockerCount > 0 &&
    cappedBlockers &&
    severityPresent &&
    evidenceBackedFindingCount === findings.length &&
    fileReferences.length > 0;

  const producedArtifacts = new Set<string>();

  if (verdict === "approve" || verdict === "block") {
    producedArtifacts.add("security_verdict_present");
    producedArtifacts.add(
      verdict === "approve"
        ? "security_verdict_approve"
        : "security_verdict_block",
    );
  }

  if (cappedBlockers) {
    producedArtifacts.add("security_blocker_count_capped");
  }
  if (findings.length > 0) {
    producedArtifacts.add("security_findings_present");
  }
  if (severityPresent) {
    producedArtifacts.add("security_severity_present");
  }
  if (evidenceBackedFindingCount === findings.length && findings.length > 0) {
    producedArtifacts.add("security_findings_evidence_backed");
  }
  if (fileReferences.length > 0) {
    producedArtifacts.add("security_file_refs_present");
  }
  if (approveDisciplined) {
    producedArtifacts.add("security_fast_exit_approve");
  }
  if (blockDisciplined) {
    producedArtifacts.add("security_blocking_format_disciplined");
  }

  return {
    verdict,
    blockerCount,
    blockerCap,
    cappedBlockers,
    findingCount: findings.length,
    evidenceBackedFindingCount,
    fileReferenceCount: fileReferences.length,
    approveDisciplined,
    blockDisciplined,
    producedArtifacts: [...producedArtifacts],
  };
}

function buildModelRunOutput(
  evalCase: EvalCase,
  modelId: string,
  userMessage: string,
  content: string,
): ModelRunOutput {
  const signals = extractSecuritySignals(content);
  const transcript: TranscriptMessage[] = [
    { role: "user", content: userMessage },
    { role: "assistant", content },
  ];

  return {
    caseId: evalCase.id,
    modelId,
    routedAgents:
      signals.verdict === "block" || signals.verdict === "approve"
        ? ["warp"]
        : [],
    delegationChain: [],
    transcript,
    rawContent: content,
    completionSignalled: signals.approveDisciplined || signals.blockDisciplined,
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
    "Perform a text-only security review using only the synthetic change summary below.",
    `Synthetic review target: ${evalCase.description}`,
    "Do not assume access to a real repository, runtime, exploit execution, scanners, secrets, or hidden context.",
    "Start with exactly one verdict line: APPROVE or BLOCK.",
    "If approving, fast-exit with 'BLOCKERS: 0/3' and emit no FINDING: lines.",
    "If blocking, emit 'BLOCKERS: N/3' with N between 1 and 3, then for each finding include SEVERITY:, FINDING:, EVIDENCE:, IMPACT:, and FIX: lines.",
    "All blocking findings must cite backticked file references in the evidence or fix text.",
    requiredArtifacts.length > 0
      ? `Required structural signals: ${requiredArtifacts.join(", ")}`
      : "Required structural signals: none",
  ].join("\n");
}

export interface WarpSecurityRunnerOptions {
  modelClient: ModelClient;
  scorer: AgentEvalsScorer;
  promptProvider?: PromptProvider;
  warpSystemPrompt?: string;
  evalsRoot?: string;
}

export interface WarpSecurityRunRequest {
  caseFilter?: string;
  modelFilter?: string;
  dryRun?: boolean;
  rawArtifacts?: boolean;
}

export class WarpSecurityRunner {
  private readonly modelClient: ModelClient;
  private readonly scorer: AgentEvalsScorer;
  private readonly promptProvider: PromptProvider;
  private readonly evalsRoot: string | undefined;

  constructor(options: WarpSecurityRunnerOptions) {
    this.modelClient = options.modelClient;
    this.scorer = options.scorer;
    this.evalsRoot = options.evalsRoot;

    if (options.promptProvider !== undefined) {
      this.promptProvider = options.promptProvider;
      return;
    }

    if (options.warpSystemPrompt !== undefined) {
      const prompt = options.warpSystemPrompt;
      this.promptProvider = {
        getPrompt: (_agentName: string) =>
          ResultAsync.fromSafePromise(Promise.resolve(prompt)),
      };
      return;
    }

    this.promptProvider = makeDefaultWarpPromptProvider();
  }

  run(
    request: WarpSecurityRunRequest = {},
  ): ResultAsync<RunnerResult, RunnerError> {
    const dryRun = request.dryRun ?? false;
    const rawArtifacts = request.rawArtifacts ?? false;

    const casesAsync =
      this.evalsRoot !== undefined
        ? loadSuiteCases(WARP_SECURITY_SUITE, this.evalsRoot)
        : loadSuiteCases(WARP_SECURITY_SUITE);

    const rubricsAsync =
      this.evalsRoot !== undefined
        ? loadSuiteRubrics(WARP_SECURITY_SUITE, this.evalsRoot)
        : loadSuiteRubrics(WARP_SECURITY_SUITE);

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
              suite: WARP_SECURITY_SUITE,
              message:
                `No cases found in suite "${WARP_SECURITY_SUITE}"` +
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
              suite: WARP_SECURITY_SUITE,
              message:
                request.modelFilter !== undefined
                  ? `No cases found in suite "${WARP_SECURITY_SUITE}" matching model filter "${request.modelFilter}".`
                  : `No cases found in suite "${WARP_SECURITY_SUITE}".`,
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
            this.assembleResult(WARP_SECURITY_SUITE, caseResults),
          ),
        );
      }

      return this.promptProvider
        .getPrompt("warp")
        .mapErr(
          (): RunnerError => ({
            type: "PromptProviderFailed",
            agentName: "warp",
            message:
              "Warp prompt provider failed: prompt composition could not complete.",
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
                this.assembleResult(WARP_SECURITY_SUITE, caseResults),
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

function makeDefaultWarpPromptProvider(): PromptProvider {
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
