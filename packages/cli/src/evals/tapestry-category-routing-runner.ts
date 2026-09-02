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
 *   - `routingCorrectness`      — deterministic: exact category shuttle match vs accepted alternates.
 *                                 Always computed locally; injected scorer's routing score is ignored.
 *   - `delegationCorrectness`   — rationale quality (route justification).
 *                                 Computed by injected scorer when present; local heuristic otherwise.
 *   - `executionCompleteness`   — path evidence present (file patterns, context).
 *                                 Computed by injected scorer when present; local heuristic otherwise.
 *   - `rationaleQuality`        — generic shuttle fallback appropriateness.
 *                                 Computed by injected scorer when present; local heuristic otherwise.
 *
 * # Scorer integration
 *
 * When a `scorer` (`AgentEvalsScorer`) is injected, the runner calls it with
 * the real `ModelRunOutput`, `EvalCase`, and rubric array after extracting the
 * deterministic routing result. The scorer's `delegationCorrectness`,
 * `executionCompleteness`, and `rationaleQuality` dimensions replace the local
 * heuristics in the final score record. The locally computed `routingCorrectness`
 * is preserved — it always overrides any routing score the scorer may produce.
 *
 * Scorer errors are converted to the runner's existing typed per-case error
 * result (`ScorerAdapterError`), preserving suite continuation and raw artifact
 * boundaries. A scorer failure never throws — the case receives a zero-score
 * error result and the suite continues.
 *
 * When no scorer is injected, the runner uses local heuristic scoring for all
 * four dimensions (useful for isolated unit tests).
 *
 * # Qualitative pass gate
 *
 * For required cases that declare `transcript_expectations` (non-empty), an
 * additional qualitative threshold is enforced when a scorer is present:
 * the average of `delegationCorrectness`, `executionCompleteness`, and
 * `rationaleQuality` must be ≥ `QUALITATIVE_PASS_THRESHOLD` (0.7) for the
 * case to pass. The deterministic routing gate (≥ 0.95) is always enforced
 * first — if routing fails, the case fails regardless of qualitative scores.
 *
 * When no scorer is present (heuristic path), only the routing gate applies.
 * Optional cases (required: false) always use weighted scoring regardless of
 * whether a scorer is present.
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
  FixtureSchemaError,
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

/**
 * Minimum average of `delegationCorrectness`, `executionCompleteness`, and
 * `rationaleQuality` required for a required case with `transcript_expectations`
 * to pass when a scorer is present.
 *
 * Only enforced after the deterministic routing gate (≥ 0.95) passes. Optional
 * cases (required: false) always use weighted scoring, not this threshold.
 */
export const QUALITATIVE_PASS_THRESHOLD = 0.7;

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
 * Broader routing-phrase detector, applied in addition to `ROUTING_PREFIXES`.
 *
 * `ROUTING_PREFIXES` only matches an exact substring, so natural variations
 * that insert a word between the verb and "to" (e.g. "Route it to",
 * "Route the task to") were previously missed, as was fallback phrasing that
 * never uses a routing verb at all (e.g. "falls back to the default agent").
 * Both patterns were observed in real, unambiguous eval transcripts
 * (`tcr-04-no-match`, `tcr-10-disabled-category`) where the model clearly
 * named the correct target agent but the line was not recognized as a
 * routing line, producing a false `extraction-miss`.
 *
 * This regex accepts a small (<=20 char) gap between a routing verb and
 * "to", and separately recognizes "fall(s) back to" as a routing signal on
 * its own. Exported for unit testing.
 */
const ROUTING_VERB_NEAR_TO_RE =
  /\b(?:rout(?:e|ing)|delegat(?:e|ing)|assign(?:ing)?|send(?:ing)?)\b.{0,20}?\bto\b|\bfalls?\s+back\b.{0,20}?\bto\b/i;

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
 * preceded by a negation prefix (within its clause, up to a 40-character
 * window) or followed by a negation suffix (within a 40-character window).
 *
 * Clause boundaries (`; ` and `, `) are respected: the look-behind window
 * starts at the most recent clause boundary before `matchIndex`, preventing
 * negation phrases in an earlier clause from bleeding into a later clause.
 */
function isNegatedMention(
  line: string,
  matchIndex: number,
  matchLength: number,
): boolean {
  // Find the nearest clause-start boundary before matchIndex (semicolon or comma)
  const rawWindowStart = Math.max(0, matchIndex - 40);
  const windowRaw = line.slice(rawWindowStart, matchIndex);
  const clauseBoundaryIdx = Math.max(
    windowRaw.lastIndexOf("; "),
    windowRaw.lastIndexOf(", "),
  );
  const clauseWindow =
    clauseBoundaryIdx >= 0 ? windowRaw.slice(clauseBoundaryIdx + 2) : windowRaw;

  const windowAfter = line.slice(
    matchIndex + matchLength,
    matchIndex + matchLength + 40,
  );
  return (
    NEGATION_PREFIXES_RE.test(clauseWindow) ||
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
  if (ROUTING_PREFIXES.some((prefix) => lower.includes(prefix))) {
    return true;
  }
  return ROUTING_VERB_NEAR_TO_RE.test(line);
}

// ---------------------------------------------------------------------------
// Affirmative primary-route detection
// ---------------------------------------------------------------------------

/**
 * Real model output frequently uses an "explain then decide" order: a
 * considered-but-rejected target (e.g. a disabled category shuttle) is named
 * first in the reasoning, while the actual decision is stated later via an
 * explicit affirmative-route utterance (e.g. `**Route to: `shuttle`**`).
 *
 * The plain position-based extraction in `extractCategoryShuttles()` picks
 * the FIRST mentioned shuttle name, which is wrong for this "explain then
 * decide" ordering — it scores the rejected alternative instead of the
 * asserted route. These patterns detect an explicit affirmative-route
 * utterance regardless of its position in the text, so it can override
 * position-based extraction.
 *
 * Four forms are recognized:
 *   - verb + "to": "route to X", "routing to X", "delegate to X",
 *     "assign to X", "send to X", "route the task to X" (small word gap
 *     allowed between the verb and "to").
 *   - label form: "Route: X", "Primary route: X".
 *   - arrow form: "→ X".
 *   - labelled-answer form: "Answer: X", "Decision: X", "Result: X",
 *     "Conclusion: X", "Final: X", "Final answer: X", "Verdict: X",
 *     "Chosen: X", "Choice: X", "Recommendation: X", "Recommended: X",
 *     "Selected: X", "Selection: X" (case-insensitive).
 *
 * Markdown emphasis (`**bold**`, `` `code` ``) around the verb or the target
 * name is stripped before matching so `**Route to: `shuttle`**` is
 * recognized the same as plain `Route to: shuttle`.
 */
const AFFIRMATIVE_VERB_TO_RE =
  /\b(?:rout(?:e|ing)|delegat(?:e|ing)|assign(?:ing)?|send(?:ing)?)(?:\s+\w+){0,3}?\s+to\b\s*:?\s*(shuttle(?:-[a-z0-9_-]+)?)\b/gi;
const AFFIRMATIVE_LABEL_RE =
  /\b(?:primary\s+route|route)\s*:\s*(shuttle(?:-[a-z0-9_-]+)?)\b/gi;
const AFFIRMATIVE_ARROW_RE = /→\s*(shuttle(?:-[a-z0-9_-]+)?)\b/gi;
// Labelled-answer forms: "Answer: X", "Decision: X", "Final answer: X", etc.
// (see module docs above the pattern list for the full recognized lead-word
// set). Markdown emphasis around the label or target is stripped by
// `stripMarkdownEmphasis()` before matching, so `**Answer: `shuttle`**` and
// `**Answer:** shuttle` are both recognized the same as plain `Answer:
// shuttle`. "final answer" is listed before "final" so the longer lead
// phrase wins the alternation.
const AFFIRMATIVE_LABELLED_ANSWER_RE =
  /\b(?:final\s+answer|answer|decision|result|conclusion|final|verdict|chosen|choice|recommendation|recommended|selected|selection)\s*:\s*(shuttle(?:-[a-z0-9_-]+)?)\b/gi;

// "Fallback verb" forms: "Fall back to X", "Falls back to X", "Falling back
// to X", "Fallback to X", "Fallback: X", "Fall back: X", "Default fallback:
// X", "Default fallback to X", "Default: X", "Default to X". Case-insensitive
// via the `i` flag; markdown emphasis is stripped before matching, same as
// the other affirmative patterns. See task 9b-follow-up-4 (deepseek run on
// tcr-10: "**Fall back to `shuttle`.**").
const AFFIRMATIVE_FALLBACK_VERB_RE =
  /\b(?:fall(?:s)?\s*back|falling\s+back|fallback|default(?:\s+fallback)?)(?:\s+to|\s*:)?\s+(shuttle(?:-[a-z0-9_-]+)?)\b/gi;
// "Use X" / "Use the X agent" forms. Scoped to start-of-sentence/clause
// (start of string, or immediately after ". " or a newline) so the common
// word "use" does not spuriously match mid-sentence prose. The target must
// still match the `shuttle(-category)?` identifier shape.
const AFFIRMATIVE_USE_VERB_RE =
  /(?<=^|[.\n]\s*)use\s+(?:the\s+)?(shuttle(?:-[a-z0-9_-]+)?)\b(?:\s+agent)?/gi;

const AFFIRMATIVE_ROUTE_PATTERNS = [
  AFFIRMATIVE_VERB_TO_RE,
  AFFIRMATIVE_LABEL_RE,
  AFFIRMATIVE_ARROW_RE,
  AFFIRMATIVE_LABELLED_ANSWER_RE,
  AFFIRMATIVE_FALLBACK_VERB_RE,
  AFFIRMATIVE_USE_VERB_RE,
];

/**
 * Words that turn an otherwise affirmative-looking routing phrase into a
 * hypothetical/considered-but-rejected mention, e.g. "would route to X",
 * "could route to X", "considered routing to X". Checked in a short window
 * immediately before the match.
 */
const HYPOTHETICAL_CONTEXT_RE = /\b(?:would|might|could|considered?)\b/i;

function isHypotheticalContext(text: string, matchIndex: number): boolean {
  const rawWindowStart = Math.max(0, matchIndex - 40);
  const windowRaw = text.slice(rawWindowStart, matchIndex);
  // Clamp to the current clause/sentence so an unrelated hypothetical word
  // in an EARLIER, already-concluded sentence (e.g. "...was considered but
  // rejected. Route to: X") does not falsely mark a later, unrelated
  // affirmative-route utterance as hypothetical.
  const boundaryIdx = Math.max(
    windowRaw.lastIndexOf("; "),
    windowRaw.lastIndexOf(", "),
    windowRaw.lastIndexOf(". "),
  );
  const clauseWindow =
    boundaryIdx >= 0 ? windowRaw.slice(boundaryIdx + 2) : windowRaw;
  return HYPOTHETICAL_CONTEXT_RE.test(clauseWindow);
}

/**
 * Return true when the affirmative-route candidate at `targetIndex` is
 * actually negated — e.g. "do not route to shuttle-client-frontend because
 * it is disabled". Reuses the same clause-aware negation windows as
 * `isNegatedMention()` so an affirmative match in an EARLIER, negated clause
 * never wins over a later, non-negated affirmative match (both may share the
 * same verb+"to" phrasing, e.g. "do not route to X; route to Y").
 */
function isNegatedAffirmativeMatch(
  text: string,
  targetIndex: number,
  targetLength: number,
): boolean {
  const rawWindowStart = Math.max(0, targetIndex - 40);
  const windowRaw = text.slice(rawWindowStart, targetIndex);
  const clauseBoundaryIdx = Math.max(
    windowRaw.lastIndexOf("; "),
    windowRaw.lastIndexOf(", "),
  );
  const clauseWindow =
    clauseBoundaryIdx >= 0 ? windowRaw.slice(clauseBoundaryIdx + 2) : windowRaw;

  const windowAfter = text.slice(
    targetIndex + targetLength,
    targetIndex + targetLength + 40,
  );
  return (
    NEGATION_PREFIXES_RE.test(clauseWindow) ||
    NEGATION_SUFFIX_RE.test(windowAfter)
  );
}

/**
 * Strip markdown emphasis characters (`**bold**`, `` `code` ``) so
 * affirmative-route patterns match regardless of markdown wrapping around
 * the verb, label, or target name.
 */
function stripMarkdownEmphasis(content: string): string {
  return content.replace(/\*\*/g, "").replace(/`/g, "");
}

/**
 * Find the model's explicitly asserted primary route, regardless of where
 * it appears in the text — as opposed to the first shuttle name merely
 * mentioned (which may be a considered-and-rejected alternative discussed
 * earlier in the reasoning).
 *
 * Returns the lowercased target name (`shuttle` or `shuttle-{category}`) of
 * the earliest non-hypothetical affirmative-route utterance, or `undefined`
 * if no such utterance is found (callers should fall back to first-mention
 * extraction in that case).
 *
 * Exported for unit testing.
 */
export function findAffirmativeRouteTarget(
  content: string,
): string | undefined {
  const stripped = stripMarkdownEmphasis(content);
  const candidates: Array<{ index: number; target: string }> = [];

  for (const pattern of AFFIRMATIVE_ROUTE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of stripped.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (isHypotheticalContext(stripped, index)) {
        continue;
      }
      const target = match[1];
      const targetIndex = index + match[0].length - target.length;
      if (isNegatedAffirmativeMatch(stripped, targetIndex, target.length)) {
        continue;
      }
      candidates.push({ index, target: target.toLowerCase() });
    }
  }

  if (candidates.length === 0) {
    return undefined;
  }

  candidates.sort((left, right) => left.index - right.index);
  return candidates[0].target;
}

/**
 * Matches a lone target identifier occupying the ENTIRE first non-blank
 * line of a model response — e.g. `` `shuttle` ``, `**shuttle**`,
 * `` **`shuttle`** ``, or `shuttle-client-frontend` — optionally followed by
 * a short parenthetical/dash/colon description on the same line (e.g.
 * `` `shuttle` — generic fallback ``, `**shuttle** (default)`).
 *
 * Real model output sometimes opens with a bare, unadorned decision (no
 * routing verb, no "Route to:" label) and only explains the reasoning
 * afterward, e.g.:
 *
 *   `shuttle`
 *
 *   Reason: the file matches `client-frontend`, which would normally route
 *   to `shuttle-client-frontend`, but that agent is disabled...
 *
 * Neither `findAffirmativeRouteTarget()` (which requires an explicit verb or
 * label) nor first-mention extraction (which picks up the FIRST shuttle name
 * anywhere, including ones discussed later in the reasoning) correctly
 * identify `shuttle` as the decision here. This pattern recognizes that
 * specific "lone opening line" shape.
 *
 * Anchored to the full (trimmed) line so multi-target or full-sentence
 * openers (e.g. "Consider shuttle or pattern", "The correct agent is
 * shuttle") never match — only a standalone identifier (with optional
 * markdown wrapping and a short trailing description) counts.
 */
// Deterministic two-step match (not one combined regex): a single regex
// that allows both an optional hyphenated identifier suffix AND an
// arbitrary trailing description is ambiguous under backtracking — e.g.
// "shuttle-backend was considered..." can incorrectly backtrack the
// hyphen-run down to bare "shuttle" and swallow "-backend was
// considered..." as the "trailing description" group. Splitting into (1) a
// deterministic maximal leading-token match and (2) separate validation of
// that token and the remainder avoids the ambiguity entirely.
const LEADING_TOKEN_RE = /^\*{0,2}`?([a-z][a-z0-9_-]*)`?\*{0,2}(.*)$/i;
const VALID_LONE_TARGET_RE = /^shuttle(?:-[a-z0-9_-]+)?$/i;
// Trailing description shape: either empty, or introduced by one of the
// lead-in markers below. No length cap — see module docs for rationale. The
// content that follows is validated separately by
// `trailingPointsToDifferentTarget()`.
const LONE_OPENING_TRAILING_RE = /^\s*(?:[-\u2014\u2013(:].*)?$/;

/**
 * Return true when the trailing description (the text after the opener
 * token and its lead-in punctuation) contains an explicit route-verb
 * phrase (`route to`, `delegate to`, `→`, `primary route`) pointing at a
 * DIFFERENT valid target than `openerIdentifier`. In that case the opener
 * is not actually the model's asserted decision — the real decision is
 * stated later in the same line — so the lone-opener rule should NOT
 * trigger (let `findAffirmativeRouteTarget()` take over instead).
 *
 * A trailing mention of a different target identifier WITHOUT a route verb
 * (e.g. explaining why another target was rejected) does not disqualify the
 * opener — see module docs for rationale.
 */
function trailingPointsToDifferentTarget(
  rest: string,
  openerIdentifier: string,
): boolean {
  const stripped = stripMarkdownEmphasis(rest);
  for (const pattern of AFFIRMATIVE_ROUTE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of stripped.matchAll(pattern)) {
      const target = match[1].toLowerCase();
      if (target !== openerIdentifier) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Find a lone target identifier occupying the entire first non-blank line
 * of the response — see the comment on `LEADING_TOKEN_RE` for the matching
 * strategy and module docs above for the recognized forms and rationale.
 *
 * Only the first non-blank line is ever considered: if it doesn't match the
 * lone-identifier shape, this returns `undefined` immediately (callers fall
 * back to `findAffirmativeRouteTarget()` and then first-mention extraction).
 *
 * Exported for unit testing.
 */
export function findLoneOpeningLineTarget(content: string): string | undefined {
  for (const line of content.split(/\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    const match = LEADING_TOKEN_RE.exec(trimmed);
    if (match === null) {
      return undefined;
    }
    const identifier = match[1].toLowerCase();
    const rest = match[2];
    if (!VALID_LONE_TARGET_RE.test(identifier)) {
      return undefined;
    }
    if (!LONE_OPENING_TRAILING_RE.test(rest)) {
      return undefined;
    }
    if (trailingPointsToDifferentTarget(rest, identifier)) {
      return undefined;
    }
    return identifier;
  }
  return undefined;
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
  /** All `shuttle-{category}` names extracted from the response (deduped, first-mention order). */
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
 * Does NOT canonicalize to `shuttle`. Uses a deterministic two-pass approach:
 *
 *   Pass 1 — Routing lines only: collect non-negated `shuttle-{category}`
 *     matches from lines that contain an explicit routing phrase (`→`, `delegate
 *     to`, etc.) and are not secondary-context lines. These are the primary
 *     routing targets.
 *
 *   Pass 2 — All other non-secondary lines: collect non-negated
 *     `shuttle-{category}` matches not yet seen. These are supporting mentions
 *     appended after the primary targets.
 *
 * Returns the ordered, deduped list of `shuttle-{category}` names (first-mention
 * order within each pass; pass-1 results precede pass-2 results).
 *
 * Exported for unit testing.
 */
export function extractCategoryShuttles(content: string): string[] {
  const lines = content.split(/\n/);
  const seen = new Set<string>();
  const result: string[] = [];

  // Pass 1: routing lines only
  for (const line of lines) {
    if (isSecondaryLine(line) || !isRoutingLine(line)) {
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

  // Pass 2: remaining non-secondary lines (non-routing diagnostic mentions)
  for (const line of lines) {
    if (isSecondaryLine(line) || isRoutingLine(line)) {
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
 * Standalone bare `shuttle` token pattern.
 *
 * Matches the word `shuttle` only when it is NOT immediately followed by a
 * hyphen (which would make it a `shuttle-{category}` name). This ensures
 * that `shuttle-backend` or `shuttle-client-frontend` are never treated as
 * generic-shuttle fallbacks.
 */
const BARE_SHUTTLE_RE = /\bshuttle(?!-[a-z0-9_-])\b/gi;

/**
 * Determine whether the content contains a standalone bare `shuttle` token
 * (not `shuttle-*`) on a routing line that is NOT a secondary context and
 * NOT a negated mention.
 *
 * A line is considered to have a non-negated category shuttle only when at
 * least one `shuttle-{category}` match on that line is NOT preceded by a
 * negation prefix or followed by a negation suffix. Lines where every
 * category shuttle mention is negated are treated as if no category shuttle
 * is present, so a bare `shuttle` routing signal on the same line can still
 * be detected as a fallback.
 *
 * Negation detection is also applied to the bare `shuttle` token itself:
 * "do not route to shuttle" does NOT count as a generic fallback.
 *
 * Used to detect fallback behaviour for partial scoring.
 */
export function detectGenericShuttleFallback(content: string): boolean {
  const lines = content.split(/\n/);

  for (const line of lines) {
    if (isSecondaryLine(line) || !isRoutingLine(line)) {
      continue;
    }

    // Find bare shuttle token(s) on this routing line
    const bareMatches = [...line.matchAll(BARE_SHUTTLE_RE)];
    if (bareMatches.length === 0) {
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
    if (hasNonNegatedCategory) {
      continue;
    }

    // Check that at least one bare shuttle mention is non-negated.
    const hasNonNegatedBare = bareMatches.some(
      (m) => !isNegatedMention(line, m.index ?? 0, m[0].length),
    );

    if (hasNonNegatedBare) {
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
  const genericShuttleFallbackDetected = detectGenericShuttleFallback(content);

  // Prefer a lone target identifier occupying the entire first non-blank
  // line (e.g. `` `shuttle` `` opening a response whose reasoning below
  // mentions other, rejected shuttle names) over both the explicit
  // affirmative-marker search and first-mention order — see
  // `findLoneOpeningLineTarget()` for the full rationale.
  const loneOpeningTarget = findLoneOpeningLineTarget(content);

  // Otherwise prefer an explicit affirmative-route utterance (e.g. `Route
  // to: shuttle`, `**Route to: `shuttle`**`) over the first-mentioned
  // shuttle name. Real model output often names a considered-but-rejected
  // category shuttle earlier in the reasoning before stating the actual
  // decision later — see `findAffirmativeRouteTarget()` for the full
  // rationale. Only when neither is found do we fall back to first-mention
  // order.
  const affirmativeTarget =
    loneOpeningTarget ?? findAffirmativeRouteTarget(content);

  let primaryCategoryTarget: string | undefined;
  let genericShuttleMentioned = genericShuttleFallbackDetected;

  if (affirmativeTarget !== undefined) {
    if (affirmativeTarget === GENERIC_SHUTTLE) {
      primaryCategoryTarget = undefined;
      genericShuttleMentioned = true;
    } else {
      primaryCategoryTarget = affirmativeTarget;
    }
  } else {
    primaryCategoryTarget = extractedCategoryShuttles[0];
  }

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
 * domain-specific evidence to justify the category routing. Recognizes:
 *   - Windows absolute paths (`C:\app\screen.tsx`)
 *   - Windows relative paths (`src\components\Button.tsx`)
 *   - Unix forward-slash paths (`src/components/Button.tsx`)
 *   - Glob patterns (`*.tsx`, `**\/components\/**`)
 *   - Ordinary filenames with extensions (`screen.tsx`, `server.go`)
 *   - Domain keywords (`frontend`, `backend`, `api`, etc.)
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

  // File path patterns: Unix forward-slash paths, Windows backslash paths,
  // glob patterns, and ordinary filenames with extensions.
  const pathPatterns = [
    /\b\w+\/\w+/, // Unix path segment (src/api)
    /\b\w+\\\w+/, // Windows backslash path segment (src\api)
    /[A-Za-z]:\\\S+/, // Windows absolute path (C:\app\screen.tsx)
    /\*\.\w{1,6}/, // glob *.ext
    /\b\w+\.\w{1,6}\b/, // filename.ext
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

/**
 * Bounded, local-only record of an injected scorer failure that was
 * recovered (not propagated) so the deterministic routing result survives.
 *
 * Never placed in `CaseResultSummary` (the publishable boundary) — only used
 * to construct the `RawErrorSummary` attached to `RawCaseResultArtifact` when
 * `rawArtifacts` mode is enabled. `rawMessage` is redacted via
 * `redactSecrets()` and bounded before it is ever written anywhere.
 */
interface ScorerDegradation {
  errorType: string;
  classification: string;
  dimension?: string;
  rawMessage?: string;
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

function buildDryRunResult(
  evalCase: EvalCase,
  modelId: string,
  rubric: EvalRubric | undefined,
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

  // Derive `required` from the rubric when available; fall back to true
  // (conservative default) when no rubric is present for this case.
  const required = rubric !== undefined ? rubric.scoring.required : true;

  const summary: CaseResultSummary = {
    caseId: evalCase.id,
    modelId,
    suite: evalCase.suite,
    passed: false,
    required,
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
 * for a single case run using local heuristics for all dimensions.
 *
 * Used when no scorer is injected (heuristic-only path). The rubric
 * `outcome_weight` gates the `passed` flag.
 *
 * Required cases pass when `routingCorrectness >= 0.95`. Optional cases pass
 * when `weightedTotal >= 0.5`. No qualitative threshold is applied here.
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

  // Required cases must have routing correctness >= 0.95 to pass.
  // No qualitative threshold without a scorer — only the routing gate applies.
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

/**
 * Build a `NormalizedScoreRecord` for a case whose injected scorer failed.
 *
 * Preserves the locally computed, deterministic `routingCorrectness` dimension
 * unconditionally — a scorer/judge failure is a judge-availability problem, not
 * a routing-correctness problem, and must never mask or discard a correct (or
 * incorrect) deterministic routing decision.
 *
 * The three qualitative dimensions (`delegationCorrectness`,
 * `executionCompleteness`, `rationaleQuality`) are marked `applicable: false`
 * with a fixed, safe rationale string — never the raw scorer error message.
 * `applicable: false` also means these dimensions are excluded from
 * `buildPublicExplanation()`'s dimension list, so the failure never leaks into
 * the public explanation.
 *
 * Pass gate degrades to the same deterministic-only gate used on the no-scorer
 * (heuristic) path: required cases pass when `routingCorrectness >= 0.95`;
 * optional cases pass when `weightedTotal >= 0.5`. The qualitative
 * (`transcript_expectations` + scorer-present) gate is intentionally NOT
 * applied here — it cannot be evaluated without a working scorer, and judge
 * unavailability must not turn a correct deterministic route into a failure.
 *
 * Exported for unit testing.
 */
export function buildScorerUnavailableScoreRecord(
  evalCase: EvalCase,
  modelId: string,
  rubric: EvalRubric,
  routingCorrectness: DimensionScore,
): NormalizedScoreRecord {
  const unavailable: DimensionScore = {
    score: 0,
    rationale:
      "Qualitative scoring unavailable: the injected scorer failed for this case.",
    applicable: false,
  };

  const weightedTotal =
    routingCorrectness.score * rubric.scoring.outcome_weight;

  const passed = rubric.scoring.required
    ? routingCorrectness.score >= 0.95
    : weightedTotal >= 0.5;

  return {
    caseId: evalCase.id,
    modelId,
    suite: evalCase.suite,
    dimensions: {
      routingCorrectness,
      delegationCorrectness: unavailable,
      executionCompleteness: unavailable,
      rationaleQuality: unavailable,
    },
    weightedTotal,
    passed,
    required: rubric.scoring.required,
    scoredAt: new Date().toISOString(),
  };
}

/**
 * Merge the locally computed `routingCorrectness` with qualitative dimensions
 * from an injected scorer's `NormalizedScoreRecord`.
 *
 * The locally computed `routingCorrectness` is always authoritative — the
 * scorer's routing score (if any) is discarded. The scorer's
 * `delegationCorrectness`, `executionCompleteness`, and `rationaleQuality`
 * replace the local heuristic dimensions.
 *
 * Pass gate (required cases):
 *   1. `routingCorrectness >= 0.95` (deterministic gate — always enforced)
 *   2. When the case has `transcript_expectations`: average qualitative score
 *      ≥ `QUALITATIVE_PASS_THRESHOLD` (executable rationale/evidence gate).
 *
 * Optional cases use weighted total >= 0.5.
 */
function mergeWithScorerDimensions(
  evalCase: EvalCase,
  modelId: string,
  rubric: EvalRubric,
  routingCorrectness: DimensionScore,
  scorerRecord: NormalizedScoreRecord,
): NormalizedScoreRecord {
  const delegationCorrectness = scorerRecord.dimensions.delegationCorrectness;
  const executionCompleteness = scorerRecord.dimensions.executionCompleteness;
  const rationaleQuality = scorerRecord.dimensions.rationaleQuality;

  const weightedTotal =
    routingCorrectness.score * rubric.scoring.outcome_weight +
    delegationCorrectness.score * (rubric.scoring.per_expectation_weight / 3) +
    executionCompleteness.score * (rubric.scoring.per_expectation_weight / 3) +
    rationaleQuality.score * (rubric.scoring.per_expectation_weight / 3);

  let passed: boolean;
  if (rubric.scoring.required) {
    // Deterministic routing gate is always first
    const routingPasses = routingCorrectness.score >= 0.95;
    if (!routingPasses) {
      passed = false;
    } else if (evalCase.transcript_expectations.length > 0) {
      // Qualitative gate: average of three qualitative dimensions must meet threshold
      const avgQualitative =
        (delegationCorrectness.score +
          executionCompleteness.score +
          rationaleQuality.score) /
        3;
      passed = avgQualitative >= QUALITATIVE_PASS_THRESHOLD;
    } else {
      passed = true;
    }
  } else {
    passed = weightedTotal >= 0.5;
  }

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
    scoredAt: scorerRecord.scoredAt,
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
   * The scorer used to evaluate model run outputs for qualitative dimensions.
   *
   * When provided, the runner calls `scorer.score()` with the real
   * `ModelRunOutput`, `EvalCase`, and rubric array after extracting the
   * deterministic routing result. The scorer's `delegationCorrectness`,
   * `executionCompleteness`, and `rationaleQuality` dimensions replace local
   * heuristics in the final score record.
   *
   * The locally computed `routingCorrectness` is always preserved and overrides
   * any routing score the scorer may produce.
   *
   * Scorer errors are converted to typed per-case zero-score error results
   * (`ScorerAdapterError`) — suite execution continues after a scorer failure.
   *
   * When omitted, the runner uses local heuristic scoring for all four
   * dimensions. Inject `StubAgentEvalsScorer` in tests.
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
  /**
   * Optional case loader function. Defaults to `loadSuiteCases` from
   * `case-loader.ts`. Inject an in-memory loader in tests to avoid file I/O.
   */
  caseLoader?: (suite: string) => ResultAsync<EvalCase[], FixtureSchemaError>;
  /**
   * Optional rubric loader function. Defaults to `loadSuiteRubrics` from
   * `case-loader.ts`. Inject an in-memory loader in tests to avoid file I/O.
   */
  rubricLoader?: (
    suite: string,
  ) => ResultAsync<EvalRubric[], FixtureSchemaError>;
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
 * ## Scorer integration
 *
 * When a `scorer` is injected, the runner calls `scorer.score()` with the real
 * `ModelRunOutput`, `EvalCase`, and rubric array for each case. The scorer's
 * qualitative dimensions (`delegationCorrectness`, `executionCompleteness`,
 * `rationaleQuality`) replace local heuristics in the final score record. The
 * locally computed `routingCorrectness` is preserved and overrides any routing
 * score from the scorer — category routing correctness is always deterministic.
 *
 * Scorer errors are converted to typed per-case zero-score error results
 * (`ScorerAdapterError`). Suite execution continues after a scorer failure.
 *
 * When no scorer is injected, local heuristic scoring is used for all four
 * dimensions (useful for isolated unit tests without LangChain dependencies).
 *
 * ## Pass gates
 *
 * Required cases (`required: true`):
 *   - `routingCorrectness >= 0.95` is always required (deterministic gate).
 *   - When `transcript_expectations` is non-empty AND a scorer is present:
 *     average of `delegationCorrectness + executionCompleteness + rationaleQuality`
 *     must also be ≥ `QUALITATIVE_PASS_THRESHOLD` (0.7).
 *   - When no scorer is present: only the routing gate applies.
 *
 * Optional cases (`required: false`): `weightedTotal >= 0.5`.
 *
 * ## Prompt composition — hard fail on provider error
 *
 * The prompt is resolved once at the start of `run()` via the provider.
 * If the provider returns an error, the runner returns
 * `err({ type: "PromptProviderFailed" })` immediately.
 *
 * ## Usage
 *
 * ```ts
 * // Production
 * const runner = new TapestryCategoryRoutingRunner({
 *   modelClient: new OpenRouterClient(env),
 *   scorer: new LangChainAgentEvalsScorer(judge),
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
  private readonly caseLoader: (
    suite: string,
  ) => ResultAsync<EvalCase[], FixtureSchemaError>;
  private readonly rubricLoader: (
    suite: string,
  ) => ResultAsync<EvalRubric[], FixtureSchemaError>;

  constructor(options: TapestryCategoryRoutingRunnerOptions) {
    this.modelClient = options.modelClient;
    this.scorer = options.scorer;
    this.caseLoader = options.caseLoader ?? ((suite) => loadSuiteCases(suite));
    this.rubricLoader =
      options.rubricLoader ?? ((suite) => loadSuiteRubrics(suite));

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

    const casesAsync = this.caseLoader(TAPESTRY_CATEGORY_ROUTING_SUITE);
    const rubricsAsync = this.rubricLoader(TAPESTRY_CATEGORY_ROUTING_SUITE);

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

      if (workItems.length === 0) {
        return new ResultAsync(
          Promise.resolve(
            err<RunnerResult, RunnerError>({
              type: "NoCasesFound",
              suite: TAPESTRY_CATEGORY_ROUTING_SUITE,
              message: `No cases match model filter "${request.modelFilter ?? "(none)"}" in suite "${TAPESTRY_CATEGORY_ROUTING_SUITE}".`,
            }),
          ),
        );
      }

      if (dryRun) {
        const caseResults = workItems.map(({ evalCase, modelId }) => {
          const rubric = rubrics.find((r) => r.case_id === evalCase.id);
          return buildDryRunResult(evalCase, modelId, rubric);
        });
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
              scorerDegradation: ScorerDegradation | undefined;
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

        // When a scorer is injected, call it for qualitative dimensions and
        // merge with the locally computed deterministic routing score.
        //
        // A scorer failure is recovered here (via `.orElse`), NOT propagated
        // to the outer `.match()` error branch. The deterministic
        // `routingCorrectness` was already computed above and is preserved
        // unconditionally: judge/scorer unavailability is a distinct failure
        // mode from a wrong deterministic route, and must never zero out or
        // discard a correct (or incorrect) routing decision. See
        // `buildScorerUnavailableScoreRecord()`.
        if (this.scorer !== undefined) {
          const routingCorrectness = scoreRoutingCorrectness(analysis);
          return this.scorer
            .score(runOutput, evalCase, rubrics)
            .map((scorerRecord) => ({
              runOutput,
              scoreRecord: mergeWithScorerDimensions(
                evalCase,
                modelId,
                rubric,
                routingCorrectness,
                scorerRecord,
              ),
              composedPrompt: systemPrompt,
              scorerDegradation: undefined as ScorerDegradation | undefined,
            }))
            .orElse((scoringError) => {
              const errorType =
                "type" in scoringError
                  ? String(scoringError.type)
                  : "ScorerAdapterError";
              const dimension =
                "dimension" in scoringError
                  ? String((scoringError as { dimension: string }).dimension)
                  : undefined;
              const rawMessage =
                "message" in scoringError
                  ? String(scoringError.message)
                  : undefined;

              const scorerDegradation: ScorerDegradation = {
                errorType,
                classification: classifyErrorType(errorType),
                dimension,
                rawMessage,
              };

              return ResultAsync.fromSafePromise(
                Promise.resolve({
                  runOutput,
                  scoreRecord: buildScorerUnavailableScoreRecord(
                    evalCase,
                    modelId,
                    rubric,
                    routingCorrectness,
                  ),
                  composedPrompt: systemPrompt,
                  scorerDegradation,
                }),
              );
            });
        }

        // No scorer: use local heuristic scoring for all dimensions.
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
            scorerDegradation: undefined as ScorerDegradation | undefined,
          }),
        );
      })
      .match<CaseResult>(
        ({ runOutput, scoreRecord, composedPrompt, scorerDegradation }) => {
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

          // A scorer degradation never appears in `summary` (the publishable
          // boundary) — only as a bounded, redacted `errorSummary` in the
          // local-only raw artifact, exactly like other typed error paths.
          const errorSummary: RawErrorSummary | undefined = scorerDegradation
            ? {
                errorType: scorerDegradation.errorType,
                classification: scorerDegradation.classification,
                dimension: scorerDegradation.dimension,
                localDiagnostic:
                  rawArtifacts && scorerDegradation.rawMessage !== undefined
                    ? redactSecrets(scorerDegradation.rawMessage)
                    : undefined,
              }
            : undefined;

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
                errorSummary,
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
