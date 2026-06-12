/**
 * Tapestry execution eval runner for `weave eval run`.
 *
 * Executes the `tapestry-execution` eval suite: for each case (optionally
 * filtered by `--case` or `--model`), the runner:
 *
 *   1. Resolves the Tapestry agent prompt via the prompt provider (default:
 *      `composeAgentSnapshots` from `prompt-snapshots.ts`).
 *   2. Constructs a chat completion request from the case description and
 *      expected outcome kind (`task_completion` or `delegation_chain`).
 *   3. Calls the model client and captures the raw response.
 *   4. Parses the model response into a `ModelRunOutput` (extracting delegation
 *      chain, completion signal, and produced artifacts from the content).
 *   5. Invokes the scorer to produce a `NormalizedScoreRecord`.
 *   6. Emits a `CaseResult` with a publishable `CaseResultSummary` (no raw
 *      content) and an optional local-only `RawCaseResultArtifact`.
 *
 * # Prompt provider
 *
 * The runner accepts a `PromptProvider` in its options. When omitted, a
 * default provider is constructed that calls `composeAgentSnapshots` to
 * retrieve the fully rendered Tapestry prompt from the engine.
 *
 * **Provider failure is a hard stop.** If the provider returns an error,
 * the runner returns `err({ type: "PromptProviderFailed" })` and no model
 * calls are made. This enforces prompt provenance: the runner never executes
 * with a hardcoded fallback prompt.
 *
 * Tests inject a `MockPromptProvider` to return a controlled string without
 * any file I/O, git, or network calls. The `tapestrySystemPrompt` constructor
 * option is a test-only escape hatch for passing a pre-composed string
 * directly; it MUST NOT be used in production code.
 *
 * # Raw-data boundary
 *
 * The publishable boundary is enforced structurally:
 *   - `CaseResultSummary` carries only scores, IDs, timestamps, and
 *     dimension score + applicability pairs. No raw prompt text, no
 *     transcript content, no tool arguments, no raw error strings.
 *   - `RawCaseResultArtifact` carries the composed prompt, full transcript,
 *     raw model content, and a bounded `RawErrorSummary` (not a raw string).
 *     `RawErrorSummary` stores only a sanitized `classification` label derived
 *     from the typed error discriminant — never raw provider message text.
 *     It is ONLY populated when `rawArtifacts === true` and MUST NOT be
 *     serialized to publishable output.
 *
 * # Design
 *
 *   - All external dependencies (`ModelClient`, `AgentEvalsScorer`,
 *     `PromptProvider`) are injected via constructor so tests can substitute
 *     stubs without touching git, network, or the file system.
 *   - Case and rubric loading is done once at the start of `run()`.
 *   - Per-case errors are accumulated into zero-score `CaseResult` entries.
 *   - Tapestry handles both `task_completion` and `delegation_chain` case kinds.
 *
 * # Response parsing
 *
 * For `delegation_chain` cases, the response is scanned for delegation
 * sequences using agent name patterns (ordered chains separated by `→` or `>`).
 *
 * For `task_completion` cases, the response is scanned for:
 *   - Completion signals: phrases like "task complete", "done", "finished"
 *   - Produced artifact names: patterns like "artifact: <name>" or
 *     "produced: <name>" matched against `expected_outcome.required_artifacts`
 */

import { err, ok, ResultAsync } from "neverthrow";
import {
  loadSuiteCases,
  loadSuiteRubrics,
  validateCaseFilter,
} from "./case-loader.js";
import type { AgentEvalsScorer } from "./langchain-agent-evals.js";
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The suite name handled by this runner.
 */
export const TAPESTRY_EXECUTION_SUITE = "tapestry-execution";

/**
 * Known agent names used for delegation chain extraction.
 */
const DELEGATION_AGENT_NAMES = [
  "loom",
  "tapestry",
  "shuttle",
  "shuttle-backend",
  "shuttle-frontend",
  "shuttle-infra",
  "warp",
  "weft",
  "spindle",
  "pattern",
] as const;

/**
 * Completion signal phrases (case-insensitive).
 */
const COMPLETION_SIGNALS = [
  "task complete",
  "task completed",
  "task is complete",
  "task is done",
  "completed successfully",
  "execution complete",
  "done",
  "finished",
  "implementation complete",
  "all steps completed",
  "workflow complete",
];

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Extract an ordered delegation chain from raw model content.
 *
 * Scans for sequences of agent names connected by `→`, `->`, `>`, `then`,
 * or `delegates to`. Returns the first detected chain, or an empty array
 * when no chain is found.
 *
 * Exported for unit testing.
 */
export function extractDelegationChain(content: string): string[] {
  const lower = content.toLowerCase();

  // Sort agent names by length descending to match longer names first
  const sortedNames = [...DELEGATION_AGENT_NAMES].sort(
    (a, b) => b.length - a.length,
  );
  const agentSet = new Set(sortedNames);

  // Tokenise: split on whitespace and punctuation, try to find chains
  // by looking for known agent names adjacent to chain connectors
  const connectorPattern = /([→\->]|then|delegates?\s+to|delegating\s+to)/gi;

  // Replace connectors with a pipe for easy splitting
  const normalised = lower
    .replace(connectorPattern, "|")
    .split("|")
    .map((s) => s.trim());

  const chain: string[] = [];
  for (const segment of normalised) {
    // Find any agent name mentioned in this segment
    for (const agent of sortedNames) {
      if (segment.includes(agent) && !chain.includes(agent)) {
        chain.push(agent);
        break;
      }
    }
  }

  // Require at least 2 agents to form a valid chain
  if (chain.length < 2) {
    return [];
  }

  // Validate all members are known agents
  for (const member of chain) {
    if (!agentSet.has(member as (typeof DELEGATION_AGENT_NAMES)[number])) {
      return [];
    }
  }

  return chain;
}

/**
 * Detect whether the model's response signals task completion.
 *
 * Exported for unit testing.
 */
export function detectCompletionSignal(content: string): boolean {
  const lower = content.toLowerCase();
  return COMPLETION_SIGNALS.some((signal) => lower.includes(signal));
}

/**
 * Extract artifact names from model content that match a set of expected
 * artifact names.
 *
 * The function only reports artifacts that appear in `expectedArtifacts`
 * so runners don't infer phantom artifacts from free-form text.
 *
 * Exported for unit testing.
 */
export function extractProducedArtifacts(
  content: string,
  expectedArtifacts: readonly string[],
): string[] {
  const lower = content.toLowerCase();
  return expectedArtifacts.filter((artifact) =>
    lower.includes(artifact.toLowerCase()),
  );
}

// ---------------------------------------------------------------------------
// Model run output construction
// ---------------------------------------------------------------------------

/**
 * Build a `ModelRunOutput` from a raw model response for a Tapestry execution case.
 */
function buildModelRunOutput(
  evalCase: EvalCase,
  modelId: string,
  userMessage: string,
  content: string,
): ModelRunOutput {
  const delegationChain = extractDelegationChain(content);
  const completionSignalled = detectCompletionSignal(content);

  const expectedArtifacts =
    evalCase.expected_outcome.kind === "task_completion"
      ? evalCase.expected_outcome.required_artifacts
      : [];

  const producedArtifacts = extractProducedArtifacts(
    content,
    expectedArtifacts,
  );

  const transcript: TranscriptMessage[] = [
    { role: "user", content: userMessage },
    { role: "assistant", content },
  ];

  return {
    caseId: evalCase.id,
    modelId,
    routedAgents: [],
    delegationChain,
    transcript,
    rawContent: content,
    completionSignalled,
    producedArtifacts,
  };
}

// ---------------------------------------------------------------------------
// Error classification — sanitized labels for RawErrorSummary
// ---------------------------------------------------------------------------

/**
 * Derive a sanitized, allowlisted classification label from a typed error
 * discriminant.
 *
 * Maps known error type strings to short classification labels safe to store
 * in `RawErrorSummary.classification`. Never copies raw provider/scorer
 * message text.
 */
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
 * Maximum character length for `RawErrorSummary.localDiagnostic`.
 */
const LOCAL_DIAGNOSTIC_MAX_CHARS = 500;

/**
 * Common secret patterns redacted from `localDiagnostic` strings.
 */
const SECRET_REDACTION_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
  [/\bsk-(?:or-|proj-)?[A-Za-z0-9_-]{8,}/g, "[REDACTED-KEY]"],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, "[REDACTED-KEY]"],
  [/\b[0-9a-f]{32,}\b/gi, "[REDACTED-HEX]"],
  [/Authorization:\s*[^\s,;\n]{8,}/gi, "Authorization: [REDACTED]"],
  [/[?&](?:api_key|apikey|key|token)=[^&\s]{4,}/gi, "?[key]=[REDACTED]"],
];

/**
 * Redact common secret patterns from a diagnostic string and bound its length.
 *
 * Used exclusively for `RawErrorSummary.localDiagnostic` — a LOCAL-ONLY
 * field that must never appear in publishable output.
 */
function redactSecrets(raw: string): string {
  let redacted = raw;
  for (const [pattern, replacement] of SECRET_REDACTION_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  if (redacted.length > LOCAL_DIAGNOSTIC_MAX_CHARS) {
    return `${redacted.slice(0, LOCAL_DIAGNOSTIC_MAX_CHARS)}… [truncated]`;
  }
  return redacted;
}

// ---------------------------------------------------------------------------
// Zero-score / dry-run CaseResult helpers
// ---------------------------------------------------------------------------

/**
 * Build a zero-score `CaseResult` for a case that errored.
 *
 * The raw artifact (when enabled) carries a bounded `RawErrorSummary` with:
 *   - `classification`: a sanitized label derived from the typed error discriminant
 *   - `localDiagnostic`: a bounded, secret-redacted copy of the error message for
 *     local debugging (only when `rawArtifacts` is enabled; never published)
 */
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

/**
 * Build a dry-run `CaseResult` (no model was called).
 */
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

  const summary: CaseResultSummary = {
    caseId: evalCase.id,
    modelId,
    suite: evalCase.suite,
    passed: false,
    required: true,
    weightedTotal: 0,
    dimensionScores,
    scoredAt,
    dryRun: true,
  };

  return { summary };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Build the user message for a Tapestry execution case.
 *
 * Includes hints about the expected outcome kind to help the model produce
 * a response that can be parsed for delegation chains, completion signals,
 * or produced artifacts.
 */
function buildUserMessage(evalCase: EvalCase): string {
  const outcome = evalCase.expected_outcome;

  if (outcome.kind === "delegation_chain") {
    const chain = outcome.chain.join(" → ");
    return (
      `Execute the following task using the appropriate delegation chain.\n` +
      `Task: ${evalCase.description}\n` +
      `Express the delegation sequence clearly (e.g., "${chain}").`
    );
  }

  if (outcome.kind === "task_completion") {
    const artifacts =
      outcome.required_artifacts.length > 0
        ? `\nRequired artifacts: ${outcome.required_artifacts.join(", ")}`
        : "";
    return (
      `Complete the following task and signal when done.\n` +
      `Task: ${evalCase.description}${artifacts}\n` +
      `Signal completion with "task complete" when done.`
    );
  }

  // Fallback for other outcome kinds
  return `Task: ${evalCase.description}`;
}

// ---------------------------------------------------------------------------
// Runner options
// ---------------------------------------------------------------------------

/**
 * Options for constructing a `TapestryExecutionRunner`.
 */
export interface TapestryExecutionRunnerOptions {
  /** The model client for inference. Inject `StubModelClient` in tests. */
  modelClient: ModelClient;
  /** The scorer. Inject `StubAgentEvalsScorer` in tests. */
  scorer: AgentEvalsScorer;
  /**
   * Prompt provider for the Tapestry agent system prompt.
   *
   * When set, the runner calls `provider.getPrompt("tapestry")` once before
   * executing work items. If the provider fails, the runner returns
   * `err({ type: "PromptProviderFailed" })` — no model calls are made.
   *
   * When omitted, a default provider is constructed that calls
   * `composeAgentSnapshots` from `prompt-snapshots.ts`. Tests inject a
   * `MockPromptProvider` to avoid git/network/file-system calls.
   *
   * Takes precedence over `tapestrySystemPrompt` when both are supplied.
   */
  promptProvider?: PromptProvider;
  /**
   * TEST-ONLY: Explicit system prompt string (bypasses the prompt provider).
   *
   * When set, the runner wraps this string in an always-succeeding provider.
   * Provider failure handling does NOT apply when this option is set — this
   * path is intentionally hardcoded for isolated unit tests only.
   *
   * MUST NOT be used in production code or CI end-to-end runners.
   * Use `promptProvider` with a `MockPromptProvider` in tests.
   *
   * @deprecated Use `promptProvider` with a `MockPromptProvider` in tests.
   */
  tapestrySystemPrompt?: string;
  /**
   * Eval fixture root directory (for testing).
   * When omitted, the default `EVALS_ROOT` from `case-loader.ts` is used.
   */
  evalsRoot?: string;
}

/**
 * Run request for a `TapestryExecutionRunner` execution.
 */
export interface TapestryRunRequest {
  /** Optional case ID filter. */
  caseFilter?: string;
  /**
   * Optional model ID filter. When set, only cases that allow this model run.
   */
  modelFilter?: string;
  /** When `true`, no model calls are made. */
  dryRun?: boolean;
  /** When `true`, populate `rawArtifact` with local-only raw data. */
  rawArtifacts?: boolean;
}

// ---------------------------------------------------------------------------
// TapestryExecutionRunner
// ---------------------------------------------------------------------------

/**
 * Runner for the `tapestry-execution` eval suite.
 *
 * Executes Tapestry execution and delegation cases. Resolves the Tapestry
 * system prompt via the configured `PromptProvider` (default:
 * `composeAgentSnapshots`), then for each case:
 *   - `delegation_chain` cases: extracts and scores the expressed delegation
 *     sequence against the expected ordered chain.
 *   - `task_completion` cases: detects completion signals and artifact
 *     mentions, then scores them against the rubric requirements.
 *
 * ## Prompt composition — hard fail on provider error
 *
 * The prompt is resolved once at the start of `run()` via the provider.
 * If the provider returns an error, the runner returns
 * `err({ type: "PromptProviderFailed" })` immediately. No model calls are
 * made. This guarantees prompt provenance for all runs.
 *
 * ## Raw-data boundary
 *
 * Publishable `CaseResultSummary` fields:
 *   - `caseId`, `modelId`, `suite`, `passed`, `required`
 *   - `weightedTotal`, `dimensionScores` (score + applicable only)
 *   - `scoredAt`, `dryRun`
 *
 * Local-only `RawCaseResultArtifact` fields (never publish):
 *   - `composedPrompt`, `transcript`, `rawContent`
 *   - `dimensionRationales`, `errorSummary` (bounded `RawErrorSummary`)
 *   - `errorSummary.classification` is a sanitized label — never raw error text
 *
 * ## Usage
 *
 * ```ts
 * // Production: uses composeAgentSnapshots by default
 * const runner = new TapestryExecutionRunner({
 *   modelClient: new OpenRouterClient(env),
 *   scorer: new LangChainAgentEvalsScorer(judge),
 * });
 *
 * // Tests: inject a mock provider to avoid git/network/file-system calls
 * const runner = new TapestryExecutionRunner({
 *   modelClient: new StubModelClient(),
 *   scorer: new StubAgentEvalsScorer(),
 *   promptProvider: new MockPromptProvider("You are Tapestry..."),
 * });
 * ```
 */
export class TapestryExecutionRunner {
  private readonly modelClient: ModelClient;
  private readonly scorer: AgentEvalsScorer;
  private readonly promptProvider: PromptProvider;
  private readonly evalsRoot: string | undefined;

  constructor(options: TapestryExecutionRunnerOptions) {
    this.modelClient = options.modelClient;
    this.scorer = options.scorer;
    this.evalsRoot = options.evalsRoot;

    // Priority: explicit promptProvider > inline tapestrySystemPrompt > default composed provider
    if (options.promptProvider !== undefined) {
      this.promptProvider = options.promptProvider;
    } else if (options.tapestrySystemPrompt !== undefined) {
      const prompt = options.tapestrySystemPrompt;
      this.promptProvider = {
        getPrompt: (_agentName: string) =>
          ResultAsync.fromSafePromise(Promise.resolve(prompt)),
      };
    } else {
      this.promptProvider = makeDefaultTapestryPromptProvider();
    }
  }

  /**
   * Execute the Tapestry execution suite.
   *
   * Returns `ok(RunnerResult)` when fixture loading succeeds (per-case errors
   * are accumulated). Returns `err(RunnerError)` when fixture loading fails.
   */
  run(
    request: TapestryRunRequest = {},
  ): ResultAsync<RunnerResult, RunnerError> {
    const dryRun = request.dryRun ?? false;
    const rawArtifacts = request.rawArtifacts ?? false;

    const casesAsync =
      this.evalsRoot !== undefined
        ? loadSuiteCases(TAPESTRY_EXECUTION_SUITE, this.evalsRoot)
        : loadSuiteCases(TAPESTRY_EXECUTION_SUITE);

    const rubricsAsync =
      this.evalsRoot !== undefined
        ? loadSuiteRubrics(TAPESTRY_EXECUTION_SUITE, this.evalsRoot)
        : loadSuiteRubrics(TAPESTRY_EXECUTION_SUITE);

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

      // Apply case filter
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
              suite: TAPESTRY_EXECUTION_SUITE,
              message:
                `No cases found in suite "${TAPESTRY_EXECUTION_SUITE}"` +
                (request.caseFilter !== undefined
                  ? ` matching case filter "${request.caseFilter}"`
                  : "") +
                ".",
            }),
          ),
        );
      }

      const workItems = this.buildWorkItems(cases, request.modelFilter);

      if (dryRun) {
        const caseResults = workItems.map(({ evalCase, modelId }) =>
          buildDryRunResult(evalCase, modelId),
        );
        return ResultAsync.fromSafePromise(
          Promise.resolve(
            this.assembleResult(TAPESTRY_EXECUTION_SUITE, caseResults),
          ),
        );
      }

      // Resolve the Tapestry prompt once before executing work items.
      // Provider failure is a hard stop — no fallback to hardcoded prompts.
      // This guarantees prompt provenance for all runs.
      return this.promptProvider
        .getPrompt("tapestry")
        .mapErr(
          (): RunnerError => ({
            type: "PromptProviderFailed",
            agentName: "tapestry",
            message: `Tapestry prompt provider failed: prompt composition could not complete.`,
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
                this.assembleResult(TAPESTRY_EXECUTION_SUITE, caseResults),
              ),
            ),
          ),
        );
    });
  }

  /**
   * Build work items from the filtered case set.
   */
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
      } else {
        const modelId = evalCase.allowed_models[0];
        if (modelId !== undefined) {
          items.push({ evalCase, modelId });
        }
      }
    }

    return items;
  }

  /**
   * Execute all work items sequentially, accumulating results.
   */
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

  /**
   * Execute a single case for one model.
   *
   * Never returns `err` — errors are converted to zero-score `CaseResult`
   * entries with bounded `RawErrorSummary` so the suite run continues.
   */
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
          const dimensionScores = buildDimensionScoreSummary(
            scoreRecord.dimensions,
          );

          const summary: CaseResultSummary = {
            caseId: evalCase.id,
            modelId,
            suite: evalCase.suite,
            passed: scoreRecord.passed,
            required: scoreRecord.required,
            weightedTotal: scoreRecord.weightedTotal,
            dimensionScores,
            scoredAt: scoreRecord.scoredAt,
            dryRun: false,
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

    // Wrap in ResultAsync so reduce chain .map() works correctly
    return new ResultAsync(
      matchPromise.then((result) => ok<CaseResult, never>(result)),
    );
  }

  /**
   * Assemble a `RunnerResult` from collected per-case results.
   */
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

// ---------------------------------------------------------------------------
// Default Tapestry prompt provider
// ---------------------------------------------------------------------------

/**
 * Construct the default `PromptProvider` for the Tapestry runner.
 *
 * The default provider calls `composeAgentSnapshots` from `prompt-snapshots.ts`
 * with `rawArtifacts: true` to retrieve the fully composed Tapestry prompt text.
 *
 * If composition succeeds but no raw artifact is found, the provider returns a
 * `PromptCompositionError` — no fallback to hardcoded prompts.
 *
 * Tests inject a `MockPromptProvider` to avoid git/network/file-system calls.
 */
function makeDefaultTapestryPromptProvider(): PromptProvider {
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
            // Composition succeeded but raw artifact not found — hard fail.
            // No fallback to hardcoded prompts; caller must handle the error.
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

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Build a dimension score summary (score + applicable, no rationale)
 * for the publishable `CaseResultSummary`.
 */
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

/**
 * Build dimension rationale mapping for local-only raw artifact storage.
 */
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
