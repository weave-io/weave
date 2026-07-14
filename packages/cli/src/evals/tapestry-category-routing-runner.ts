/**
 * Tapestry category-routing eval runner for `weave eval run`.
 *
 * Executes the `tapestry-category-routing` eval suite: for each case
 * (optionally filtered by `--case` or `--model`), the runner:
 *
 *   1. Composes the Tapestry agent prompt via the prompt provider (default:
 *      `composeAgentSnapshots` from `prompt-snapshots.ts`).
 *   2. Constructs a chat completion request from the case description.
 *   3. Calls the model client and captures the raw response.
 *   4. Parses the model response for `shuttle-{category}` routing signals
 *      WITHOUT any canonicalization to `shuttle`.
 *   5. Scores the result across four category-aware dimensions.
 *   6. Emits a `CaseResult` with a publishable `CaseResultSummary`.
 *
 * # Category-aware scoring
 *
 * Unlike the Loom routing runner, this runner does NOT canonicalize
 * `shuttle-{category}` names back to `shuttle`. Category fidelity is first-
 * class: `shuttle-client-frontend` routing to `shuttle-client-frontend` scores
 * 1.0 on `correct_category`; routing to generic `shuttle` scores partial
 * credit (configurable via `accepted_alternates` with penalty semantics);
 * routing to a wrong category (e.g. `shuttle-backend` when
 * `shuttle-client-frontend` was expected) scores 0.
 *
 * Scoring dimensions:
 *   - `routingCorrectness`      — exact category shuttle match vs accepted alternates
 *   - `delegationCorrectness`   — rationale quality (route justification)
 *   - `executionCompleteness`   — path evidence present (file patterns, context)
 *   - `rationaleQuality`        — generic shuttle fallback appropriateness
 *
 * # Prompt provider
 *
 * The runner accepts a `PromptProvider` in its options. When omitted, a default
 * provider is constructed that calls `composeAgentSnapshots` for `"tapestry"`.
 * Provider failure is a hard stop — no model calls are made.
 *
 * Tests inject a `MockPromptProvider` (or use `tapestrySystemPrompt`) to avoid
 * file I/O, git, or network calls.
 *
 * # Raw-data boundary
 *
 * The publishable boundary is enforced structurally:
 *   - `CaseResultSummary` carries only scores, IDs, timestamps, and
 *     dimension score + applicability pairs. No raw prompt text, no
 *     transcript content, no tool arguments, no raw error strings.
 *   - `RawCaseResultArtifact` carries the composed prompt, full transcript,
 *     raw model content, and a bounded `RawErrorSummary`.
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

/** Suite name handled by this runner. */
export const TAPESTRY_CATEGORY_ROUTING_SUITE = "tapestry-category-routing";

/**
 * Dynamic category-shuttle pattern.
 * Matches `shuttle-{category}` names (e.g. `shuttle-client-frontend`,
 * `shuttle-backend`) without any canonicalization. Used to extract the full
 * category-qualified name from model responses.
 */
const CATEGORY_SHUTTLE_RE = /\bshuttle-[a-z0-9_-]+\b/gi;

/**
 * Generic shuttle name — matched only when no category-qualified shuttle is
 * found on the same routing line. Used to score fallback appropriateness.
 */
const GENERIC_SHUTTLE = "shuttle";

/**
 * Penalty score applied when the model falls back to generic `shuttle`
 * instead of the expected `shuttle-{category}` name.
 *
 * Partial credit — the model identified the shuttle domain but failed to
 * name the specific category.
 */
export const GENERIC_SHUTTLE_FALLBACK_SCORE = 0.4;

// ---------------------------------------------------------------------------
// Category-routing extraction (no canonicalization)
// ---------------------------------------------------------------------------

/**
 * Routing phrase prefixes that indicate a positive routing decision.
 * Used to identify which lines in model output contain routing signals.
 */
const ROUTING_PREFIXES = [
  "→",
  "->",
  "delegate to",
  "delegating to",
  "route to",
  "routing to",
  "assign to",
  "send to",
];

/**
 * Phrase patterns that indicate an agent is mentioned in a secondary or
 * follow-up context rather than as the primary routing target.
 */
const SECONDARY_CONTEXT_INDICATORS = [
  "after changes",
  "after completion",
  "after implementation",
  "afterwards",
  "as a follow",
  "follow-up",
  "followup",
  "security audit",
  "post-implementation",
  "post implementation",
  ": review",
];

/**
 * Negation prefixes that appear immediately before a shuttle name in a
 * clause that explicitly rejects or excludes that shuttle from routing.
 * When one of these precedes a `shuttle-{category}` match (within a short
 * window), that match is treated as a negated mention and excluded from
 * extraction.
 *
 * Examples caught:
 *   "do not route to shuttle-client-frontend"
 *   "not shuttle-backend"
 *   "cannot use shuttle-backend"
 *   "skip shuttle-client-frontend"
 *   "avoid shuttle-client-frontend"
 *   "instead of shuttle-client-frontend"
 *   "shuttle-client-frontend is disabled"
 *   "disabled; route to shuttle"
 */
const NEGATION_PREFIXES_RE =
  /\b(?:not?|do not|cannot|can't|don'?t|skip|avoid|instead of|excluding?|without|bypass(?:ing)?)\s+/i;

/**
 * Suffixes immediately after a shuttle name that indicate exclusion.
 * Catches patterns like "shuttle-client-frontend is disabled".
 */
const NEGATION_SUFFIX_RE = /\s+(?:is\s+)?(?:disabled|unavailable|excluded)/i;

/**
 * Return true when the shuttle name at `matchIndex` within `line` is
 * preceded by a negation prefix (within a 40-character window) or
 * followed by a negation suffix (within a 40-character window).
 */
function isNegatedMention(
  line: string,
  matchIndex: number,
  matchLength: number,
): boolean {
  const windowBefore = line.slice(Math.max(0, matchIndex - 40), matchIndex);
  const windowAfter = line.slice(
    matchIndex + matchLength,
    matchIndex + matchLength + 40,
  );
  return (
    NEGATION_PREFIXES_RE.test(windowBefore) ||
    NEGATION_SUFFIX_RE.test(windowAfter)
  );
}

function isSecondaryLine(line: string): boolean {
  const lower = line.toLowerCase();
  return SECONDARY_CONTEXT_INDICATORS.some((indicator) =>
    lower.includes(indicator),
  );
}

function isRoutingLine(line: string): boolean {
  const lower = line.toLowerCase();
  return ROUTING_PREFIXES.some((prefix) => lower.includes(prefix));
}

/**
 * Classification of a category-routing extraction result.
 *
 * Used in `CategoryRoutingAnalysis` to describe how the observed routing
 * compares to the expected target without any canonicalization.
 */
export type CategoryRoutingClassification =
  | "exact-category-match"
  | "accepted-alternate"
  | "generic-shuttle-fallback"
  | "wrong-category"
  | "extraction-miss";

/**
 * The structured result of category-routing extraction and classification.
 *
 * Produced by `analyzeCategoryRouting()` and consumed by the scoring and
 * diagnostics helpers.
 */
export interface CategoryRoutingAnalysis {
  /** All `shuttle-{category}` names extracted from the response (no dedup). */
  extractedCategoryShuttles: string[];
  /** Whether a generic `shuttle` (without category) was mentioned. */
  genericShuttleMentioned: boolean;
  /** The first `shuttle-{category}` found on a routing line, if any. */
  primaryCategoryTarget: string | undefined;
  /** Classification vs the expected target. */
  classification: CategoryRoutingClassification;
  /** Expected target agent from the fixture. */
  expectedTarget: string;
  /** Accepted targets (expected + alternates). */
  acceptedTargets: string[];
}

/**
 * Extract `shuttle-{category}` routing signals from model output.
 *
 * Does NOT canonicalize to `shuttle`. Prefers matches on explicit routing
 * lines (`→`, `delegate to`, etc.). Falls back to generic `shuttle` detection
 * if no category-qualified name is found.
 *
 * Returns the ordered list of `shuttle-{category}` names found (deduped,
 * first-mention order).
 *
 * Exported for unit testing.
 */
export function extractCategoryShuttles(content: string): string[] {
  const lines = content.split(/\n/);
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    if (isSecondaryLine(line)) {
      continue;
    }

    const matches = [...line.matchAll(CATEGORY_SHUTTLE_RE)];
    for (const match of matches) {
      const name = match[0].toLowerCase();
      const matchIndex = match.index ?? 0;
      if (isNegatedMention(line, matchIndex, match[0].length)) {
        continue;
      }
      if (!seen.has(name)) {
        seen.add(name);
        result.push(name);
      }
    }
  }

  return result;
}

/**
 * Determine whether the content mentions generic `shuttle` (without a
 * category suffix) on a routing line that is NOT a secondary context.
 *
 * A line is considered to have a non-negated category shuttle only when at
 * least one `shuttle-{category}` match on that line is NOT preceded by a
 * negation prefix or followed by a negation suffix. Lines where every
 * category shuttle mention is negated are treated as if no category shuttle
 * is present, so a generic `shuttle` routing signal on the same line can
 * still be detected as a fallback.
 *
 * Used to detect fallback behaviour for partial scoring.
 */
export function detectGenericShuttleFallback(content: string): boolean {
  const lines = content.split(/\n/);

  for (const line of lines) {
    if (isSecondaryLine(line)) {
      continue;
    }
    const lower = line.toLowerCase();
    if (!lower.includes(GENERIC_SHUTTLE) || !isRoutingLine(line)) {
      CATEGORY_SHUTTLE_RE.lastIndex = 0;
      continue;
    }

    // Check whether any category shuttle on this line is non-negated.
    const categoryMatches = [...line.matchAll(CATEGORY_SHUTTLE_RE)];
    CATEGORY_SHUTTLE_RE.lastIndex = 0;
    const hasNonNegatedCategory = categoryMatches.some(
      (m) => !isNegatedMention(line, m.index ?? 0, m[0].length),
    );

    // Generic shuttle is detectable only when no non-negated category shuttle
    // exists on this routing line.
    if (!hasNonNegatedCategory) {
      return true;
    }
  }

  return false;
}

/**
 * Analyze category-routing content and classify the result vs the expected
 * target without any canonicalization.
 *
 * Classification priority:
 *   1. `exact-category-match`   — primary extracted target equals expected
 *   2. `accepted-alternate`     — primary extracted target is in accepted_alternates
 *   3. `generic-shuttle-fallback` — no category shuttle found, generic shuttle present
 *   4. `wrong-category`         — a category shuttle was found but it is wrong
 *   5. `extraction-miss`        — nothing found
 *
 * Exported for unit testing.
 */
export function analyzeCategoryRouting(
  content: string,
  expectedTarget: string,
  acceptedAlternates: string[],
): CategoryRoutingAnalysis {
  const extractedCategoryShuttles = extractCategoryShuttles(content);
  const genericShuttleMentioned = detectGenericShuttleFallback(content);
  const primaryCategoryTarget = extractedCategoryShuttles[0];

  const expectedLower = expectedTarget.toLowerCase();
  const acceptedTargets = [
    expectedLower,
    ...acceptedAlternates.map((a) => a.toLowerCase()),
  ];

  let classification: CategoryRoutingClassification;

  if (primaryCategoryTarget === undefined) {
    if (genericShuttleMentioned) {
      classification = "generic-shuttle-fallback";
    } else {
      classification = "extraction-miss";
    }
  } else if (primaryCategoryTarget === expectedLower) {
    classification = "exact-category-match";
  } else if (acceptedTargets.includes(primaryCategoryTarget)) {
    classification = "accepted-alternate";
  } else {
    classification = "wrong-category";
  }

  return {
    extractedCategoryShuttles,
    genericShuttleMentioned,
    primaryCategoryTarget,
    classification,
    expectedTarget: expectedLower,
    acceptedTargets,
  };
}

// ---------------------------------------------------------------------------
// Category-aware dimension scoring
// ---------------------------------------------------------------------------

/**
 * Compute the `routingCorrectness` score from a category routing analysis.
 *
 * - `exact-category-match`    → 1.0
 * - `accepted-alternate`      → 0.8  (correct domain, non-primary name)
 * - `generic-shuttle-fallback`→ `GENERIC_SHUTTLE_FALLBACK_SCORE` (0.4) when a
 *   category-specific shuttle was expected; 1.0 when the expected target itself
 *   is the generic `shuttle` (no-match/disabled-category cases).
 * - `wrong-category`          → 0.0
 * - `extraction-miss`         → 0.0
 *
 * The special case for generic shuttle when expected target is `shuttle`:
 * tcr-04 (no-match) and tcr-10 (disabled-category) both set
 * `expected_outcome.target_agent = "shuttle"`. When the model correctly falls
 * back to generic `shuttle` in those cases, the classification is
 * `generic-shuttle-fallback` but the expected target IS `shuttle`, so the
 * score should be 1.0 not the partial-credit fallback score.
 *
 * Exported for unit testing.
 */
export function scoreRoutingCorrectness(
  analysis: CategoryRoutingAnalysis,
): DimensionScore {
  switch (analysis.classification) {
    case "exact-category-match":
      return {
        score: 1.0,
        rationale: `Exact category match: model routed to "${analysis.primaryCategoryTarget}" which equals expected "${analysis.expectedTarget}".`,
        applicable: true,
      };

    case "accepted-alternate":
      return {
        score: 0.8,
        rationale: `Accepted alternate: model routed to "${analysis.primaryCategoryTarget}" which is an accepted alternate for "${analysis.expectedTarget}".`,
        applicable: true,
      };

    case "generic-shuttle-fallback": {
      // When the expected target IS the generic shuttle (no-match / disabled-category
      // cases such as tcr-04 and tcr-10), the model routed correctly — score 1.0.
      if (analysis.expectedTarget === GENERIC_SHUTTLE) {
        return {
          score: 1.0,
          rationale: `Correct generic shuttle fallback: model routed to generic "shuttle" which is the expected target for this no-match/disabled-category case.`,
          applicable: true,
        };
      }
      return {
        score: GENERIC_SHUTTLE_FALLBACK_SCORE,
        rationale: `Generic shuttle fallback: model routed to generic "shuttle" instead of specific category "${analysis.expectedTarget}". Partial credit awarded.`,
        applicable: true,
      };
    }

    case "wrong-category":
      return {
        score: 0.0,
        rationale: `Wrong category: model routed to "${analysis.primaryCategoryTarget}" but expected "${analysis.expectedTarget}" (accepted: ${analysis.acceptedTargets.join(", ")}).`,
        applicable: true,
      };

    case "extraction-miss":
      return {
        score: 0.0,
        rationale: `Extraction miss: no shuttle routing signal found in model response. Expected "${analysis.expectedTarget}".`,
        applicable: true,
      };
  }
}

/**
 * Score `delegationCorrectness` (rationale quality for routing decision).
 *
 * Checks whether the model provided a rationale for why it chose the
 * specific category shuttle. Heuristic: looks for file-path patterns,
 * category keywords, or domain phrases in the content.
 */
export function scoreDelegationCorrectness(
  content: string,
  analysis: CategoryRoutingAnalysis,
): DimensionScore {
  if (
    analysis.classification === "extraction-miss" ||
    analysis.classification === "wrong-category"
  ) {
    return {
      score: 0.0,
      rationale: "No valid routing decision to evaluate rationale for.",
      applicable: true,
    };
  }

  const lower = content.toLowerCase();

  // Look for rationale signals: explanatory phrases near routing decision
  const rationaleSignals = [
    "because",
    "since",
    "this is",
    "handles",
    "responsible for",
    "specializes in",
    "matches",
    "corresponds to",
  ];
  const hasRationale = rationaleSignals.some((signal) =>
    lower.includes(signal),
  );

  if (hasRationale) {
    return {
      score: 1.0,
      rationale: "Model provided a rationale for the routing decision.",
      applicable: true,
    };
  }

  return {
    score: 0.5,
    rationale:
      "Model made a routing decision but did not provide explicit rationale.",
    applicable: true,
  };
}

/**
 * Score `executionCompleteness` (path/context evidence present).
 *
 * Checks whether the model referenced file patterns, directory paths, or
 * domain-specific evidence to justify the category routing.
 */
export function scoreExecutionCompleteness(
  content: string,
  analysis: CategoryRoutingAnalysis,
): DimensionScore {
  if (analysis.classification === "extraction-miss") {
    return {
      score: 0.0,
      rationale: "No routing decision to evaluate path evidence for.",
      applicable: true,
    };
  }

  const lower = content.toLowerCase();

  // File path patterns: *.ts, *.tsx, src/, components/, etc.
  const pathPatterns = [
    /\b\w+\/\w+/,
    /\*\.\w{1,6}/,
    /\bsrc\b/,
    /\bcomponents?\b/,
    /\bpages?\b/,
    /\bapi\b/,
    /\bserver\b/,
    /\bdatabase\b/,
    /\bdb\b/,
    /\bfrontend\b/,
    /\bbackend\b/,
    /\bclient\b/,
  ];

  const hasPathEvidence = pathPatterns.some((pattern) => pattern.test(lower));

  if (hasPathEvidence) {
    return {
      score: 1.0,
      rationale:
        "Model referenced file patterns or domain context to justify routing.",
      applicable: true,
    };
  }

  return {
    score: 0.5,
    rationale:
      "Model made a routing decision but no file path or domain evidence found.",
    applicable: true,
  };
}

/**
 * Score `rationaleQuality` (fallback appropriateness).
 *
 * When the model falls back to generic `shuttle`, this dimension assesses
 * whether the fallback was appropriate (e.g. the category was genuinely
 * ambiguous). When the model made an exact or alternate match, this
 * dimension is 1.0 (the decision was appropriate by definition).
 */
export function scoreRationaleQuality(
  analysis: CategoryRoutingAnalysis,
): DimensionScore {
  switch (analysis.classification) {
    case "exact-category-match":
    case "accepted-alternate":
      return {
        score: 1.0,
        rationale:
          "Routing to specific category shuttle is the appropriate choice.",
        applicable: true,
      };

    case "generic-shuttle-fallback":
      // When the expected target IS the generic shuttle, the fallback is appropriate.
      if (analysis.expectedTarget === GENERIC_SHUTTLE) {
        return {
          score: 1.0,
          rationale:
            "Falling back to generic shuttle is correct here: no category pattern matched or the matching category is disabled.",
          applicable: true,
        };
      }
      return {
        score: 0.4,
        rationale:
          "Falling back to generic shuttle is only appropriate when category is genuinely ambiguous. Specific category is preferred.",
        applicable: true,
      };

    case "wrong-category":
      return {
        score: 0.0,
        rationale:
          "Routing to wrong category is inappropriate — specific category knowledge is expected.",
        applicable: true,
      };

    case "extraction-miss":
      return {
        score: 0.0,
        rationale:
          "No shuttle routing signal found; fallback appropriateness cannot be assessed.",
        applicable: true,
      };
  }
}

// ---------------------------------------------------------------------------
// Model run output construction
// ---------------------------------------------------------------------------

function buildCategoryModelRunOutput(
  caseId: string,
  modelId: string,
  userMessage: string,
  content: string,
  analysis: CategoryRoutingAnalysis,
): ModelRunOutput {
  const transcript: TranscriptMessage[] = [
    { role: "user", content: userMessage },
    { role: "assistant", content },
  ];

  // routedAgents uses the extracted category shuttles (NOT canonicalized)
  let routedAgents: string[];
  if (analysis.primaryCategoryTarget !== undefined) {
    routedAgents = [analysis.primaryCategoryTarget];
  } else if (analysis.genericShuttleMentioned) {
    routedAgents = [GENERIC_SHUTTLE];
  } else {
    routedAgents = [];
  }

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
// Error classification
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Zero-score result (error paths)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Dry-run result
// ---------------------------------------------------------------------------

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
    required: evalCase.transcript_expectations.length === 0,
    weightedTotal: 0,
    dimensionScores,
    scoredAt,
    dryRun: true,
  };

  return { summary };
}

// ---------------------------------------------------------------------------
// Score record building
// ---------------------------------------------------------------------------

/**
 * Build a `NormalizedScoreRecord` from the four category-aware dimensions
 * for a single case run. The rubric `outcome_weight` gates the `passed` flag.
 */
function buildCategoryScoreRecord(
  evalCase: EvalCase,
  modelId: string,
  rubric: EvalRubric,
  analysis: CategoryRoutingAnalysis,
  content: string,
): NormalizedScoreRecord {
  const routingCorrectness = scoreRoutingCorrectness(analysis);
  const delegationCorrectness = scoreDelegationCorrectness(content, analysis);
  const executionCompleteness = scoreExecutionCompleteness(content, analysis);
  const rationaleQuality = scoreRationaleQuality(analysis);

  const weightedTotal =
    routingCorrectness.score * rubric.scoring.outcome_weight +
    delegationCorrectness.score * (rubric.scoring.per_expectation_weight / 3) +
    executionCompleteness.score * (rubric.scoring.per_expectation_weight / 3) +
    rationaleQuality.score * (rubric.scoring.per_expectation_weight / 3);

  // Required cases must have routing correctness >= 0.95 to pass
  const passed = rubric.scoring.required
    ? routingCorrectness.score >= 0.95
    : weightedTotal >= 0.5;

  const scoredAt = new Date().toISOString();

  return {
    caseId: evalCase.id,
    modelId,
    suite: evalCase.suite,
    dimensions: {
      routingCorrectness,
      delegationCorrectness,
      executionCompleteness,
      rationaleQuality,
    },
    weightedTotal,
    passed,
    required: rubric.scoring.required,
    scoredAt,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildUserMessage(evalCase: EvalCase): string {
  return `Task to route: ${evalCase.description}`;
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

// ---------------------------------------------------------------------------
// Runner options and request
// ---------------------------------------------------------------------------

/** Options for constructing a `TapestryCategoryRoutingRunner`. */
export interface TapestryCategoryRoutingRunnerOptions {
  /** The model client used for inference. Inject `StubModelClient` in tests. */
  modelClient: ModelClient;
  /**
   * The scorer used to evaluate model run outputs.
   * When provided, used for judge-based scoring (LangChain path).
   * When omitted, the runner uses its built-in category-aware heuristic scorer.
   * Inject `StubAgentEvalsScorer` in tests.
   */
  scorer?: AgentEvalsScorer;
  /**
   * Prompt provider for the Tapestry agent system prompt.
   *
   * When set, the runner calls `provider.getPrompt("tapestry")` once before
   * executing work items. If the provider fails, the runner returns
   * `err({ type: "PromptProviderFailed" })`.
   *
   * When omitted, a default provider that calls `composeAgentSnapshots` is used.
   * Takes precedence over `tapestrySystemPrompt` when both are supplied.
   */
  promptProvider?: PromptProvider;
  /**
   * TEST-ONLY: Explicit system prompt string (bypasses the prompt provider).
   *
   * MUST NOT be used in production code.
   */
  tapestrySystemPrompt?: string;
  /** Eval fixture root directory override (for tests). */
  evalsRoot?: string;
}

/** Run request for a `TapestryCategoryRoutingRunner` execution. */
export interface TapestryCategoryRoutingRunRequest {
  /** Optional case ID filter. */
  caseFilter?: string;
  /** Optional model ID filter. */
  modelFilter?: string;
  /** When `true`, no model calls are made. */
  dryRun?: boolean;
  /** When `true`, populate `CaseResult.rawArtifact`. */
  rawArtifacts?: boolean;
}

// ---------------------------------------------------------------------------
// TapestryCategoryRoutingRunner
// ---------------------------------------------------------------------------

/**
 * Runner for the `tapestry-category-routing` eval suite.
 *
 * Evaluates Tapestry's category shuttle routing fidelity WITHOUT canonicalizing
 * `shuttle-{category}` names to `shuttle`. Category fidelity is scored on four
 * dimensions: routing correctness (exact/alternate/fallback/wrong), delegation
 * correctness (rationale quality), execution completeness (path evidence), and
 * rationale quality (fallback appropriateness).
 *
 * ## Prompt composition — hard fail on provider error
 *
 * The prompt is resolved once at the start of `run()` via the provider.
 * If the provider returns an error, the runner returns
 * `err({ type: "PromptProviderFailed" })` immediately.
 *
 * ## Scoring
 *
 * The runner's built-in heuristic scorer is used by default. When a `scorer`
 * is injected, it is used for rationale quality dimensions while the
 * heuristic scorer handles routing correctness. This allows test isolation
 * without LangChain dependencies.
 *
 * ## Usage
 *
 * ```ts
 * // Production
 * const runner = new TapestryCategoryRoutingRunner({
 *   modelClient: new OpenRouterClient(env),
 * });
 *
 * // Tests
 * const runner = new TapestryCategoryRoutingRunner({
 *   modelClient: new StubModelClient(),
 *   tapestrySystemPrompt: "You are Tapestry...",
 * });
 * ```
 */
export class TapestryCategoryRoutingRunner {
  private readonly modelClient: ModelClient;
  private readonly scorer: AgentEvalsScorer | undefined;
  private readonly promptProvider: PromptProvider;
  private readonly evalsRoot: string | undefined;

  constructor(options: TapestryCategoryRoutingRunnerOptions) {
    this.modelClient = options.modelClient;
    this.scorer = options.scorer;
    this.evalsRoot = options.evalsRoot;

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
   * Execute the tapestry-category-routing suite.
   *
   * Returns `ok(RunnerResult)` when fixture loading succeeds (even when
   * individual cases fail — those are accumulated as zero-score results).
   * Returns `err(RunnerError)` only when fixture loading or the case filter
   * itself fails.
   */
  run(
    request: TapestryCategoryRoutingRunRequest = {},
  ): ResultAsync<RunnerResult, RunnerError> {
    const dryRun = request.dryRun ?? false;
    const rawArtifacts = request.rawArtifacts ?? false;

    const casesAsync =
      this.evalsRoot !== undefined
        ? loadSuiteCases(TAPESTRY_CATEGORY_ROUTING_SUITE, this.evalsRoot)
        : loadSuiteCases(TAPESTRY_CATEGORY_ROUTING_SUITE);

    const rubricsAsync =
      this.evalsRoot !== undefined
        ? loadSuiteRubrics(TAPESTRY_CATEGORY_ROUTING_SUITE, this.evalsRoot)
        : loadSuiteRubrics(TAPESTRY_CATEGORY_ROUTING_SUITE);

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
              suite: TAPESTRY_CATEGORY_ROUTING_SUITE,
              message: `No cases found in suite "${TAPESTRY_CATEGORY_ROUTING_SUITE}"${request.caseFilter !== undefined ? ` matching case filter "${request.caseFilter}"` : ""}.`,
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
            this.assembleResult(TAPESTRY_CATEGORY_ROUTING_SUITE, caseResults),
          ),
        );
      }

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
                this.assembleResult(
                  TAPESTRY_CATEGORY_ROUTING_SUITE,
                  caseResults,
                ),
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
      } else {
        const modelId = evalCase.allowed_models[0];
        if (modelId !== undefined) {
          items.push({ evalCase, modelId });
        }
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
        // Determine expected target and alternates from the case fixture
        const expectedTarget =
          evalCase.expected_outcome.kind === "agent_routing"
            ? evalCase.expected_outcome.target_agent
            : "";
        const acceptedAlternates = evalCase.accepted_alternates;

        const analysis = analyzeCategoryRouting(
          response.content,
          expectedTarget,
          acceptedAlternates,
        );

        // Find matching rubric
        const rubric = rubrics.find((r) => r.case_id === evalCase.id);
        if (rubric === undefined) {
          return new ResultAsync<
            {
              runOutput: ModelRunOutput;
              scoreRecord: NormalizedScoreRecord;
              composedPrompt: string;
            },
            { type: string; message: string }
          >(
            Promise.resolve(
              err({
                type: "RubricNotFound",
                message: `No rubric found for case "${evalCase.id}" in suite "${evalCase.suite}".`,
              }),
            ),
          );
        }

        const runOutput = buildCategoryModelRunOutput(
          evalCase.id,
          modelId,
          userMessage,
          response.content,
          analysis,
        );

        const scoreRecord = buildCategoryScoreRecord(
          evalCase,
          modelId,
          rubric,
          analysis,
          response.content,
        );

        return ResultAsync.fromSafePromise(
          Promise.resolve({
            runOutput,
            scoreRecord,
            composedPrompt: systemPrompt,
          }),
        );
      })
      .match<CaseResult>(
        ({ runOutput, scoreRecord, composedPrompt }) => {
          const dimensionScores = buildDimensionScoreSummary(
            scoreRecord.dimensions,
          );

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

// ---------------------------------------------------------------------------
// Default prompt provider
// ---------------------------------------------------------------------------

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
