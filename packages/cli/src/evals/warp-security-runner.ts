/**
 * Warp security eval runner for `weave eval run`.
 *
 * Executes the `warp-security` suite against synthetic security-review prompts.
 * Scoring stays text-only: verdict format, capped blocker counts, and
 * evidence-backed security finding structure are extracted from assistant text.
 */

import { redactSecrets as engineRedactSecrets } from "@weaveio/weave-engine";
import { err, ok, ResultAsync } from "neverthrow";
import {
  loadSuiteCases,
  loadSuiteRubrics,
  validateCaseFilter,
} from "./case-loader.js";
import { buildRequiredSignalsLine, isTracedFinding } from "./judgment-cases.js";
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

// A verdict line may be bare, bracketed as the Warp prompt specifies
// (`[BLOCK]`), or bold (`**BLOCK**`). The trailing guard keeps
// `BLOCKERS: 0/3` from reading as a verdict.
const VERDICT_APPROVE_RE = /^\s*(?:\*\*|\[)*APPROVE(?:\]|\*\*)*(?![A-Za-z])/im;
const VERDICT_BLOCK_RE = /^\s*(?:\*\*|\[)*BLOCK(?:\]|\*\*)*(?![A-Za-z])/im;
// Field lines may carry a list marker (`1. SEVERITY: High`, `- FINDING: …`)
// when a model numbers its blocking issues.
const FINDING_RE = /^\s*(?:(?:[-*]|\d+[.)])\s+)?FINDING:\s+.+$/gim;
const EVIDENCE_RE = /^\s*(?:(?:[-*]|\d+[.)])\s+)?EVIDENCE:\s+.+$/gim;
const IMPACT_RE = /^\s*(?:(?:[-*]|\d+[.)])\s+)?IMPACT:\s+.+$/gim;
const FIX_RE = /^\s*(?:(?:[-*]|\d+[.)])\s+)?FIX:\s+.+$/gim;
const SEVERITY_RE =
  /^\s*(?:(?:[-*]|\d+[.)])\s+)?SEVERITY:\s+(LOW|MEDIUM|HIGH|CRITICAL)\b/im;
const EVIDENCE_LABEL_RE = /^\s*(?:(?:[-*]|\d+[.)])\s+)?EVIDENCE:/i;
// Ends an EVIDENCE block: the next upper-case field label (IMPACT:, FIX:,
// SUSPECTED:, …) or a markdown heading / bold finding title.
const BLOCK_END_RE = /^\s*(?:(?:[-*]|\d+[.)])\s+)?(?:[A-Z][A-Z _-]*:|#|\*\*)/;
const FILE_REFERENCE_RE =
  /`([^`]+)`|\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|weave|yml|yaml|css|scss|html|go|rs|py)\b/g;
const CAP_LINE_RE = /^\s*BLOCKERS:\s*(\d+)\s*\/\s*(\d+)\s*$/im;
const MAX_CAP = 3;

const LOCAL_DIAGNOSTIC_MAX_CHARS = 500;

type SecurityVerdict = "approve" | "block" | "invalid" | "missing";

export interface SecuritySignals {
  verdict: SecurityVerdict;
  blockerCount: number;
  blockerCap: number | undefined;
  cappedBlockers: boolean;
  findingCount: number;
  evidenceBackedFindingCount: number;
  tracedEvidenceCount: number;
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

// An EVIDENCE field may be one line or a label followed by bullet lines
// (`EVIDENCE:` / `- Source: …` / `- Sink: …`); the trace is read from the
// whole block.
function extractEvidenceBlocks(content: string): string[] {
  const blocks: string[] = [];
  let current: string[] | undefined;

  for (const line of content.split("\n")) {
    if (EVIDENCE_LABEL_RE.test(line)) {
      if (current !== undefined) {
        blocks.push(current.join("\n"));
      }
      current = [line];
      continue;
    }
    if (current === undefined) {
      continue;
    }
    if (BLOCK_END_RE.test(line)) {
      blocks.push(current.join("\n"));
      current = undefined;
      continue;
    }
    current.push(line);
  }

  if (current !== undefined) {
    blocks.push(current.join("\n"));
  }
  return blocks;
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

  const tracedEvidenceCount =
    extractEvidenceBlocks(content).filter(isTracedFinding).length;

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
  // Traced: at least one finding's EVIDENCE names the source and the sink.
  // Other findings (for example a missing auth check) may legitimately sit
  // at a single location.
  if (findings.length > 0 && tracedEvidenceCount > 0) {
    producedArtifacts.add("security_finding_traced");
  }

  return {
    verdict,
    blockerCount,
    blockerCap,
    cappedBlockers,
    findingCount: findings.length,
    evidenceBackedFindingCount,
    tracedEvidenceCount,
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

/**
 * Redact secret-shaped substrings from local diagnostic text before logging.
 * Delegates to the shared, engine-owned `redactSecrets` helper (which also
 * covers GitHub token prefixes) so all packages apply one canonical pattern
 * set; this wrapper only adds the local diagnostic truncation cap.
 */
export function redactSecrets(raw: string): string {
  return engineRedactSecrets(raw, LOCAL_DIAGNOSTIC_MAX_CHARS);
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
    buildRequiredSignalsLine(evalCase, requiredArtifacts),
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

      // An empty list is not a failure here: a model may be outside every
      // case's allowed_models. `EvalOrchestrator` fails a suite that ran no
      // cases on any model (#205).
      const workItems = this.buildWorkItems(cases, request.modelFilter);

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
