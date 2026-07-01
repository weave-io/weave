/**
 * Loom routing eval runner for `weave eval run`.
 *
 * Executes the `loom-routing` eval suite: for each case (optionally filtered
 * by `--case` or `--model`), the runner:
 *
 *   1. Composes the Loom agent prompt via the prompt provider (default:
 *      `composeAgentSnapshots` from `prompt-snapshots.ts`).
 *   2. Constructs a chat completion request from the case description.
 *   3. Calls the model client and captures the raw response.
 *   4. Parses the model response into a `ModelRunOutput` (extracting routed
 *      agents from the content).
 *   5. Invokes the scorer to produce a `NormalizedScoreRecord`.
 *   6. Emits a `CaseResult` with a publishable `CaseResultSummary` (no raw
 *      content) and an optional local-only `RawCaseResultArtifact`.
 *
 * # Prompt provider
 *
 * The runner accepts a `PromptProvider` in its options. When omitted, a
 * default provider is constructed that calls `composeAgentSnapshots` to
 * retrieve the fully rendered Loom prompt from the engine.
 *
 * **Provider failure is a hard stop.** If the provider returns an error,
 * the runner returns `err({ type: "PromptProviderFailed" })` and no model
 * calls are made. This enforces prompt provenance: the runner never executes
 * with a hardcoded fallback prompt.
 *
 * Tests inject a `MockPromptProvider` to return a controlled string without
 * any file I/O, git, or network calls. The `loomSystemPrompt` constructor
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
 *   - Case and rubric loading is done once at the start of `run()` and cached
 *     for the duration of the runner execution.
 *   - Per-case errors are accumulated into zero-score `CaseResult` entries
 *     rather than aborting the entire run.
 *   - The composed Loom prompt is resolved once before executing work items
 *     and reused across all cases.
 *
 * # Prompt extraction
 *
 * The composed Loom prompt is injected as the `system` message. The case
 * description becomes the `user` message. The model response is parsed for
 * agent routing signals using heuristic text patterns (e.g. lines containing
 * `→ <agent>`, `delegate to <agent>`, or `route to <agent>`).
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The suite name handled by this runner.
 * Used for case loading and result labelling.
 */
export const LOOM_ROUTING_SUITE = "loom-routing";

/**
 * Agent name patterns used to extract routing signals from model responses.
 * The runner searches model content for these patterns (case-insensitive).
 */
const ROUTING_BASE_AGENT_NAMES = [
  "loom",
  "tapestry",
  "thread",
  "shuttle",
  "warp",
  "weft",
  "spindle",
  "pattern",
] as const;

/**
 * Dynamic category-shuttle matcher.
 *
 * Avoids baking stale project-specific shuttle names into the runner while
 * still allowing current `shuttle-{category}` targets to be extracted from
 * text when the model explicitly names them.
 */
const DYNAMIC_SHUTTLE_AGENT_RE = /\bshuttle-[a-z0-9_-]+\b/gi;

// ---------------------------------------------------------------------------
// Routing signal extraction
// ---------------------------------------------------------------------------

/**
 * Agent names that are reviewers/auditors and should be excluded when they
 * appear only in a follow-up, conditional, or review/security-audit context
 * rather than as the primary routing target.
 *
 * Pattern examples that indicate a secondary (non-primary) role:
 *   - "Auto-invoke weft after changes"
 *   - "use warp if auth/security is involved"
 *   - "weft will review afterwards"
 *   - "trigger warp for security audit"
 *
 * These agents are still extracted when they are explicitly the primary route,
 * e.g. "delegate to warp first" or "route to weft for review".
 */
const REVIEWER_AGENT_NAMES = new Set(["weft", "warp"]);

/**
 * Patterns that indicate a reviewer/auditor agent is mentioned in a secondary,
 * conditional, or follow-up role rather than as the primary routing target.
 * Checked (case-insensitively) against the whole content line containing the
 * agent name.
 *
 * These are deliberately narrow — only unambiguous follow-up/conditional phrases
 * that could not also appear on a genuine primary-routing line.
 */
const SECONDARY_ROLE_INDICATORS = [
  "after changes",
  "after completion",
  "after implementation",
  "afterwards",
  "as a follow",
  "follow-up",
  "followup",
  "if auth",
  "if security",
  "security audit",
  "invoke weft",
  "invoke warp",
  "trigger weft",
  "trigger warp",
  "auto-invoke",
  "autoinvoke",
  "post-implementation",
  "post implementation",
  // Sequential/parallel review steps in Loom delegation-sequence format:
  // "[Sequential] weft: Review implementation" — the ": review" suffix
  // identifies weft/warp as a downstream reviewer, not the primary route.
  ": review",
  // Also catch plain "review" after a colon-separated agent label
  "weft: review",
  "warp: review",
];

/**
 * Primary routing phrase + agent substrings. When any of these appear verbatim
 * in the content (case-insensitively), the agent is the explicit primary target.
 */
function makePrimarySubstrings(agent: string): string[] {
  return [
    `→ ${agent}`,
    `-> ${agent}`,
    `delegate to ${agent}`,
    `delegating to ${agent}`,
    `route to ${agent}`,
    `routing to ${agent}`,
    `assign to ${agent}`,
    `send to ${agent}`,
  ];
}

function isNegatedMentionLine(line: string, agent: string): boolean {
  const plainLine = line.replace(/[`"']/g, "");
  const escaped = agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const agentPattern = `\\b${escaped}\\b`;
  const negatedPatterns = [
    new RegExp(`\\bno\\s+${agentPattern}\\b`, "i"),
    new RegExp(
      `\\bnot\\s+(?:use|using|needed|need|route|routing|delegate|delegating)[^\\n]*${agentPattern}`,
      "i",
    ),
    new RegExp(
      `\\b${agentPattern}\\b[^\\n]{0,32}\\b(?:no|not needed|not required|unnecessary)\\b`,
      "i",
    ),
    new RegExp(`\\bwithout\\s+${agentPattern}\\b`, "i"),
  ];
  return negatedPatterns.some((pattern) => pattern.test(plainLine));
}

function findStandaloneAgentPatternIndex(
  lower: string,
  pattern: string,
): number | undefined {
  let searchFrom = 0;
  while (searchFrom < lower.length) {
    const index = lower.indexOf(pattern, searchFrom);
    if (index < 0) return undefined;
    const afterAgentIndex = index + pattern.length;
    if (lower.charAt(afterAgentIndex) !== "-") return index;
    searchFrom = afterAgentIndex;
  }
  return undefined;
}

function collectRoutingAgentCandidates(content: string): string[] {
  const lower = content.toLowerCase();
  const candidates = new Set<string>(ROUTING_BASE_AGENT_NAMES);

  for (const match of lower.matchAll(DYNAMIC_SHUTTLE_AGENT_RE)) {
    const agent = match[0];
    if (agent !== "") {
      candidates.add(agent);
    }
  }

  return [...candidates];
}

/**
 * Determine whether an agent that IS matched by a routing pattern is actually
 * appearing only in a secondary/follow-up role.
 *
 * Strategy:
 *   1. If any explicit `${primaryPhrase}${agent}` substring appears anywhere in
 *      the content, the agent is unambiguously the primary routing target — not
 *      secondary.
 *   2. Otherwise the match was via `weft/warp agent` or quoted-name patterns.
 *      Check each line containing the agent name: if any line has the agent
 *      without a secondary-role indicator, it is treated as a primary line.
 *   3. If no primary line was found, the agent is classified as only secondary.
 *
 * This avoids false positives from a different agent's routing phrase appearing
 * earlier on the same line (e.g. "delegate to shuttle-backend. warp agent post-
 * implementation…").
 *
 * Returns `true` if the agent is only in a secondary role (should be excluded).
 * Returns `false` if at least one occurrence is in a clearly primary position.
 */
function isOnlySecondaryRole(lower: string, agent: string): boolean {
  // Step 1: check for an explicit primary-routing phrase+agent combo anywhere.
  const primarySubstrings = makePrimarySubstrings(agent);
  if (primarySubstrings.some((sub) => lower.includes(sub))) {
    return false;
  }

  // Step 2: the match was via `${agent} agent`, quoted name, or backtick pattern.
  // Scan each line: if any line with the agent has no secondary-role indicator,
  // treat it as a primary line.
  const lines = lower.split(/\n/);
  let foundNonSecondaryLine = false;

  for (const line of lines) {
    if (!line.includes(agent)) {
      continue;
    }
    const isSecondaryLine = SECONDARY_ROLE_INDICATORS.some((indicator) =>
      line.includes(indicator),
    );
    if (!isSecondaryLine) {
      foundNonSecondaryLine = true;
      break;
    }
  }

  return !foundNonSecondaryLine;
}

/**
 * Extract agent routing signals from raw model content.
 *
 * Scans the content for known agent names in the context of routing-relevant
 * phrases. Returns the ordered list of mentioned agent names (deduplicated,
 * preserving first-mention order).
 *
 * Heuristic patterns (case-insensitive):
 *   - `→ <agent>` or `-> <agent>`
 *   - `delegate to <agent>`
 *   - `route to <agent>`
 *   - `routing to <agent>`
 *   - `assign to <agent>`
 *   - `send to <agent>`
 *   - `"<agent>"` or `<agent> agent`
 *
 * ## Reviewer-agent suppression
 *
 * `weft` and `warp` are reviewer/auditor agents. They are excluded from the
 * result when they appear only in follow-up, conditional, or review context
 * (e.g. "Auto-invoke weft after changes" or "use warp if security is involved").
 * They are still included when they are explicitly the primary route target
 * (e.g. "delegate to warp first" or "route to weft for review" would need a
 * primary-routing phrase such as `→ warp` or `delegate to warp`).
 *
 * Exported for unit testing of the extraction logic.
 */
export function extractRoutedAgents(content: string): string[] {
  const lower = content.toLowerCase();
  const matches: Array<{ agent: string; index: number }> = [];

  // Sort by length descending for matching only, so longer names such as
  // `shuttle-engine` win over the `shuttle` prefix at the same location.
  const sortedNames = collectRoutingAgentCandidates(content).sort(
    (a, b) => b.length - a.length,
  );

  for (const agent of sortedNames) {
    if (!lower.includes(agent)) {
      continue;
    }

    // Check for routing-relevant context patterns around the agent name.
    const patterns = [
      `→ ${agent}`,
      `-> ${agent}`,
      `delegate to ${agent}`,
      `delegating to ${agent}`,
      `route to ${agent}`,
      `routing to ${agent}`,
      `assign to ${agent}`,
      `send to ${agent}`,
      `${agent} agent`,
      `"${agent}"`,
      `\`${agent}\``,
      // Loom delegation-sequence formats: "[Sequential] agent:" / "[Parallel] agent:"
      `[sequential] ${agent}`,
      `[parallel] ${agent}`,
      `sequential] ${agent}`,
      `parallel] ${agent}`,
      `<agent>${agent}</agent>`,
      `<agent_name>${agent}</agent_name>`,
      `<agent_id>${agent}</agent_id>`,
      `<${agent}>`,
      `<invoke name="${agent}"`,
      `<invoke name='${agent}'`,
      `agent="${agent}"`,
      `agent='${agent}'`,
      `agent name="${agent}"`,
      `agent name='${agent}'`,
      `agent_id="${agent}"`,
      `agent_id='${agent}'`,
      `<item>${agent}:`,
      `<item>${agent} `,
      `>${agent}:`,
      `**${agent}**`,
      `**${agent}**:`,
    ];

    let firstMatchIndex: number | undefined;
    for (const pattern of patterns) {
      const index = findStandaloneAgentPatternIndex(lower, pattern);
      if (index === undefined) {
        continue;
      }
      if (firstMatchIndex === undefined || index < firstMatchIndex) {
        firstMatchIndex = index;
      }
    }

    if (firstMatchIndex === undefined) {
      continue;
    }

    const matchingLines = lower
      .split(/\n/)
      .filter((line) => line.includes(agent));
    if (
      matchingLines.length > 0 &&
      matchingLines.every((line) => isNegatedMentionLine(line, agent))
    ) {
      continue;
    }

    // For reviewer agents (weft/warp), additionally verify the match is not
    // solely in a secondary/follow-up/conditional context.
    if (REVIEWER_AGENT_NAMES.has(agent) && isOnlySecondaryRole(lower, agent)) {
      continue;
    }

    matches.push({ agent, index: firstMatchIndex });
  }

  matches.sort((left, right) => {
    if (left.index !== right.index) {
      return left.index - right.index;
    }
    return right.agent.length - left.agent.length;
  });

  return [...new Set(matches.map((match) => match.agent))];
}

// ---------------------------------------------------------------------------
// Model run output construction
// ---------------------------------------------------------------------------

/**
 * Build a `ModelRunOutput` from a raw model response for a Loom routing case.
 *
 * The content is parsed for routing signals. The transcript captures the
 * user prompt and assistant response (no raw prompt text in the transcript
 * role fields — that is isolated in `RawCaseResultArtifact`).
 */
function buildModelRunOutput(
  caseId: string,
  modelId: string,
  userMessage: string,
  content: string,
): ModelRunOutput {
  const routedAgents = extractRoutedAgents(content);

  const transcript: TranscriptMessage[] = [
    { role: "user", content: userMessage },
    { role: "assistant", content },
  ];

  return {
    caseId,
    modelId,
    routedAgents,
    delegationChain: [],
    transcript,
    rawContent: content,
    completionSignalled: false,
    producedArtifacts: [],
  };
}

// ---------------------------------------------------------------------------
// Error classification — sanitized labels for RawErrorSummary
// ---------------------------------------------------------------------------

/**
 * Derive a sanitized, allowlisted classification label from a typed error
 * discriminant.
 *
 * This function maps known error type strings to short classification labels
 * that are safe to store in `RawErrorSummary.classification`. It never copies
 * raw provider/scorer message text into the output.
 *
 * Unknown discriminants produce `"unknown-error"` — a bounded fallback that
 * does not expose internal error details.
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
 *
 * Caps the diagnostic string to prevent unbounded growth from provider
 * response bodies or stack traces being accidentally included.
 */
const LOCAL_DIAGNOSTIC_MAX_CHARS = 500;

/**
 * Common secret patterns redacted from `localDiagnostic` strings.
 *
 * Matches common API key and bearer token patterns. The replacement is a
 * bounded redaction sentinel that does not reveal key length or prefix.
 */
const SECRET_REDACTION_PATTERNS: Array<[RegExp, string]> = [
  // Bearer tokens: "Bearer sk-abc123..."
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
  // OpenRouter / OpenAI key patterns: sk-or-..., sk-proj-..., sk-...
  [/\bsk-(?:or-|proj-)?[A-Za-z0-9_-]{8,}/g, "[REDACTED-KEY]"],
  // Anthropic key patterns: sk-ant-...
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, "[REDACTED-KEY]"],
  // Generic long hex tokens (32+ hex chars that look like secrets)
  [/\b[0-9a-f]{32,}\b/gi, "[REDACTED-HEX]"],
  // Authorization header values
  [/Authorization:\s*[^\s,;\n]{8,}/gi, "Authorization: [REDACTED]"],
  // API key query params: ?api_key=..., ?key=...
  [/[?&](?:api_key|apikey|key|token)=[^&\s]{4,}/gi, "?[key]=[REDACTED]"],
];

/**
 * Redact common secret patterns from a diagnostic string.
 *
 * Applies `SECRET_REDACTION_PATTERNS` to remove API keys, bearer tokens,
 * and other secret-like strings. The result is bounded to
 * `LOCAL_DIAGNOSTIC_MAX_CHARS` characters.
 *
 * This function is used exclusively for `RawErrorSummary.localDiagnostic`
 * — a LOCAL-ONLY field that must never appear in publishable output.
 */
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

// ---------------------------------------------------------------------------
// Zero-score CaseResult (for error paths)
// ---------------------------------------------------------------------------

/**
 * Build a zero-score `CaseResult` for a case that errored during execution.
 *
 * The summary carries no raw content. The raw artifact carries a bounded
 * `RawErrorSummary` with:
 *   - `classification`: a sanitized label derived from the typed error discriminant
 *   - `localDiagnostic`: a bounded, secret-redacted copy of the error message for
 *     local debugging (only when `rawArtifacts` is enabled; never published)
 *
 * Only produced when `rawArtifacts` is enabled.
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
    required: true, // conservative: treat errored required cases as failed
    weightedTotal: 0,
    dimensionScores,
    scoredAt,
    dryRun: false,
  };

  const errorSummary: RawErrorSummary = {
    errorType,
    // Sanitized classification label — never raw provider/scorer message text
    classification: classifyErrorType(errorType),
    dimension,
    // LOCAL-ONLY: bounded, secret-redacted diagnostic for local debugging
    // Only populated when rawArtifacts is enabled and rawMessage is provided
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

// ---------------------------------------------------------------------------
// Dry-run CaseResult
// ---------------------------------------------------------------------------

/**
 * Build a dry-run `CaseResult` that signals the case would be executed
 * but no model was called.
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
    required: evalCase.transcript_expectations.length === 0, // conservative default
    weightedTotal: 0,
    dimensionScores,
    scoredAt,
    dryRun: true,
  };

  return { summary };
}

// ---------------------------------------------------------------------------
// Runner options
// ---------------------------------------------------------------------------

/**
 * Options for constructing a `LoomRoutingRunner`.
 */
export interface LoomRoutingRunnerOptions {
  /**
   * The model client used for inference.
   * Inject `StubModelClient` in tests.
   */
  modelClient: ModelClient;
  /**
   * The scorer used to evaluate model run outputs.
   * Inject `StubAgentEvalsScorer` in tests.
   */
  scorer: AgentEvalsScorer;
  /**
   * Prompt provider for the Loom agent system prompt.
   *
   * When set, the runner calls `provider.getPrompt("loom")` once before
   * executing work items. If the provider fails, the runner returns
   * `err({ type: "PromptProviderFailed" })` — no model calls are made.
   *
   * When omitted, a default provider is constructed that calls
   * `composeAgentSnapshots` from `prompt-snapshots.ts`. Tests inject a
   * `MockPromptProvider` to avoid git/network/file-system calls.
   *
   * Takes precedence over `loomSystemPrompt` when both are supplied.
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
   * Use `promptProvider` for composition-aware prompt supply.
   *
   * @deprecated Use `promptProvider` with a `MockPromptProvider` in tests.
   */
  loomSystemPrompt?: string;
  /**
   * Eval fixture root directory (for testing with fixture overrides).
   * When omitted, the default `EVALS_ROOT` from `case-loader.ts` is used.
   */
  evalsRoot?: string;
}

/**
 * Run request for a `LoomRoutingRunner` execution.
 */
export interface LoomRunRequest {
  /**
   * Optional case ID filter. When set, only the matching case is executed.
   */
  caseFilter?: string;
  /**
   * Optional model ID filter. When set, only cases that allow this model run.
   * When omitted, all models in `allowed_models` for each case are used
   * (limited to the first model for simplicity).
   */
  modelFilter?: string;
  /**
   * When `true`, no model calls are made. Returns dry-run `CaseResult` entries.
   */
  dryRun?: boolean;
  /**
   * When `true`, populate `CaseResult.rawArtifact` with local-only raw data.
   * MUST NOT be enabled in CI environments.
   */
  rawArtifacts?: boolean;
}

// ---------------------------------------------------------------------------
// LoomRoutingRunner
// ---------------------------------------------------------------------------

/**
 * Runner for the `loom-routing` eval suite.
 *
 * Executes Loom routing cases: resolves the Loom system prompt via the
 * configured `PromptProvider` (default: `composeAgentSnapshots`), sends
 * it plus the case description to the model, parses the routing signal
 * from the response, scores it against the rubric, and emits per-case results.
 *
 * ## Prompt composition — hard fail on provider error
 *
 * The prompt is resolved once at the start of `run()` via the provider.
 * If the provider returns an error, the runner returns
 * `err({ type: "PromptProviderFailed" })` immediately. No model calls are
 * made. This guarantees prompt provenance: the runner never silently falls
 * back to a hardcoded prompt.
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
 * const runner = new LoomRoutingRunner({
 *   modelClient: new OpenRouterClient(env),
 *   scorer: new LangChainAgentEvalsScorer(judge),
 * });
 *
 * // Tests: inject a mock provider to avoid git/network/file-system calls
 * const runner = new LoomRoutingRunner({
 *   modelClient: new StubModelClient(),
 *   scorer: new StubAgentEvalsScorer(),
 *   promptProvider: new MockPromptProvider("You are Loom..."),
 * });
 *
 * const result = await runner.run({ caseFilter: "route-to-shuttle" });
 * ```
 */
export class LoomRoutingRunner {
  private readonly modelClient: ModelClient;
  private readonly scorer: AgentEvalsScorer;
  private readonly promptProvider: PromptProvider;
  private readonly evalsRoot: string | undefined;

  constructor(options: LoomRoutingRunnerOptions) {
    this.modelClient = options.modelClient;
    this.scorer = options.scorer;
    this.evalsRoot = options.evalsRoot;

    // Priority: explicit promptProvider > inline loomSystemPrompt > default composed provider
    if (options.promptProvider !== undefined) {
      this.promptProvider = options.promptProvider;
    } else if (options.loomSystemPrompt !== undefined) {
      const prompt = options.loomSystemPrompt;
      this.promptProvider = {
        getPrompt: (_agentName: string) =>
          ResultAsync.fromSafePromise(Promise.resolve(prompt)),
      };
    } else {
      this.promptProvider = makeDefaultLoomPromptProvider();
    }
  }

  /**
   * Execute the Loom routing suite.
   *
   * Returns `ok(RunnerResult)` when fixture loading succeeds (even when
   * individual cases fail — those are accumulated as zero-score results).
   * Returns `err(RunnerError)` only when the fixture loading step itself fails
   * (e.g. malformed case fixture files, or the case filter matches nothing).
   */
  run(request: LoomRunRequest = {}): ResultAsync<RunnerResult, RunnerError> {
    const dryRun = request.dryRun ?? false;
    const rawArtifacts = request.rawArtifacts ?? false;

    // Load cases and rubrics in parallel
    const casesAsync =
      this.evalsRoot !== undefined
        ? loadSuiteCases(LOOM_ROUTING_SUITE, this.evalsRoot)
        : loadSuiteCases(LOOM_ROUTING_SUITE);

    const rubricsAsync =
      this.evalsRoot !== undefined
        ? loadSuiteRubrics(LOOM_ROUTING_SUITE, this.evalsRoot)
        : loadSuiteRubrics(LOOM_ROUTING_SUITE);

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
              suite: LOOM_ROUTING_SUITE,
              message: `No cases found in suite "${LOOM_ROUTING_SUITE}"${request.caseFilter !== undefined ? ` matching case filter "${request.caseFilter}"` : ""}.`,
            }),
          ),
        );
      }

      // Build the list of (case, modelId) pairs to execute
      const workItems = this.buildWorkItems(cases, request.modelFilter);

      if (dryRun) {
        const caseResults = workItems.map(({ evalCase, modelId }) =>
          buildDryRunResult(evalCase, modelId),
        );
        return ResultAsync.fromSafePromise(
          Promise.resolve(this.assembleResult(LOOM_ROUTING_SUITE, caseResults)),
        );
      }

      // Resolve the Loom prompt once before executing work items.
      // Provider failure is a hard stop — no fallback to hardcoded prompts.
      // This guarantees prompt provenance for all runs.
      return this.promptProvider
        .getPrompt("loom")
        .mapErr(
          (): RunnerError => ({
            type: "PromptProviderFailed",
            agentName: "loom",
            message: `Loom prompt provider failed: prompt composition could not complete.`,
          }),
        )
        .andThen((systemPrompt) =>
          // Execute each work item sequentially to avoid overwhelming the model API
          this.executeWorkItems(
            workItems,
            rubrics,
            rawArtifacts,
            systemPrompt,
          ).andThen((caseResults) =>
            ResultAsync.fromSafePromise(
              Promise.resolve(
                this.assembleResult(LOOM_ROUTING_SUITE, caseResults),
              ),
            ),
          ),
        );
    });
  }

  /**
   * Build the (case, modelId) work items from the filtered case set.
   *
   * When `modelFilter` is set, only cases that include the filter model in
   * `allowed_models` are included (and the model is the filter value).
   * When `modelFilter` is omitted, each case uses its first `allowed_model`.
   */
  private buildWorkItems(
    cases: EvalCase[],
    modelFilter: string | undefined,
  ): Array<{ evalCase: EvalCase; modelId: string }> {
    const items: Array<{ evalCase: EvalCase; modelId: string }> = [];

    for (const evalCase of cases) {
      if (modelFilter !== undefined) {
        if (!evalCase.allowed_models.includes(modelFilter)) {
          continue; // skip cases that don't support this model
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
   * Execute all work items sequentially and collect per-case results.
   *
   * Per-case errors are accumulated as zero-score results — they do not abort
   * the suite run.
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
          evalCase.id,
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

          // Build public explanation before sanitization — derived from
          // structured inputs only (no raw model output or rationale text)
          const publicExplanation = buildPublicExplanation(
            scoreRecord,
            evalCase,
            false,
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
            publicExplanation,
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
          // Extract the raw message for local diagnostic (redacted of secrets before storage)
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
   * Assemble a `RunnerResult` from the collected per-case results.
   */
  private assembleResult(
    suite: string,
    caseResults: CaseResult[],
  ): RunnerResult {
    const passedCases = caseResults.filter((r) => r.summary.passed).length;
    const failedCases = caseResults.length - passedCases;

    // Suite is green iff all required cases passed
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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Construct the default `PromptProvider` for the Loom runner.
 *
 * The default provider calls `composeAgentSnapshots` from `prompt-snapshots.ts`
 * with `rawArtifacts: true` to retrieve the fully composed Loom prompt text.
 * This is the production path that uses the engine's prompt composition pipeline.
 *
 * If composition succeeds but no raw artifact is found (e.g. the agent name
 * was not in the snapshot result), the provider returns a `PromptCompositionError`.
 *
 * Tests inject a `MockPromptProvider` (via `LoomRoutingRunnerOptions.promptProvider`)
 * to avoid triggering git resolution, file I/O, or Weave config loading.
 */
function makeDefaultLoomPromptProvider(): PromptProvider {
  return {
    getPrompt: (agentName: string) => {
      // Dynamic import keeps the module boundary clean — prompt-snapshots.ts
      // imports from @weave/config and @weave/engine; we only pull those in
      // when the default provider is actually used.
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

/**
 * Build the user message for a Loom routing case.
 *
 * Uses the case description as the task to be routed. The description is
 * a plain-text string that was validated at load time — no injection risk.
 */
function buildUserMessage(evalCase: EvalCase): string {
  return `Task to route: ${evalCase.description}`;
}

/**
 * Build a dimension score summary (score + applicable only, no rationale)
 * for inclusion in the publishable `CaseResultSummary`.
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
 * Build a mapping of dimension name → rationale string for local-only
 * raw artifact storage.
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
