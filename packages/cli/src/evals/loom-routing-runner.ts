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

import type {
  TrajectoryCase,
  TrajectoryRunner,
  TrajectoryWorkspace,
} from "@weaveio/weave-core";
import { err, ok, okAsync, ResultAsync } from "neverthrow";
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
import { scoreTrajectoryResult } from "./trajectory-scoring.js";
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
 * Agents that can act as an exploratory/evidence-gathering pre-hop before a
 * primary implementation route (`thread` for internal code investigation,
 * `spindle` for external research). When one of these agents appears in a
 * line carrying an exploratory-pre-hop indicator AND a later primary route is
 * also present, the agent is demoted to `exploratoryAgents` rather than
 * scored as the primary route. When no later primary route exists, the
 * agent remains the primary route (see the fallback in `analyzeLoomRouting`).
 */
const PREHOP_AGENT_NAMES = new Set(["thread", "spindle"]);

/**
 * Phrases that mark a pre-hop agent (`thread`/`spindle`) as exploratory
 * evidence-gathering rather than the primary implementation route.
 */
const EXPLORATORY_PREHOP_INDICATORS = [
  "explore",
  "exploring",
  "investigate",
  "investigating",
  "survey",
  "gather context",
  "gather evidence",
  "research",
  "understand",
  "inspect",
  "audit",
  "discover",
  "triage",
  "locate",
];

/**
 * Phrases that mark an agent mention as a rejected/negated alternative —
 * explicitly considered and ruled out in favor of a different route, rather
 * than being the chosen route.
 *
 * These are deliberately narrow, unambiguous phrases layered on top of the
 * `isNegatedMentionLine` regex checks below.
 */
const REJECTED_ALTERNATIVE_INDICATORS = [
  "not warranted",
  "not necessary",
  "unnecessary",
  "is not needed",
  "not needed here",
  "will eventually implement",
];

/**
 * Canonicalize category shuttle names back to the text-only `shuttle` contract
 * used by the current Loom fixtures and rubrics.
 */
function canonicalizeRoutingAgent(agent: string): string {
  if (agent.startsWith("shuttle-")) {
    return "shuttle";
  }
  return agent;
}

function uniqueInOrder(values: string[]): string[] {
  return [...new Set(values)];
}

function collectAgentLines(lower: string, agent: string): string[] {
  return lower.split(/\n/).filter((line) => line.includes(agent));
}

function isExploratoryPrehopAgent(lower: string, agent: string): boolean {
  if (!PREHOP_AGENT_NAMES.has(agent)) {
    return false;
  }

  const lines = collectAgentLines(lower, agent);
  if (lines.length === 0) {
    return false;
  }

  return lines.some((line) =>
    EXPLORATORY_PREHOP_INDICATORS.some((indicator) => line.includes(indicator)),
  );
}

/**
 * Determine whether an agent is mentioned only as a rejected/negated
 * alternative — explicitly considered and ruled out in text, rather than
 * being chosen as the route. Used for LOCAL-ONLY diagnostics; does not
 * affect scoring directly (rejected agents are already excluded from
 * `extractedAgents` by `isNegatedMentionLine`/`REJECTED_ALTERNATIVE_INDICATORS`
 * checks inside `extractRoutedAgents`).
 */
function isRejectedAlternativeAgent(lower: string, agent: string): boolean {
  const lines = collectAgentLines(lower, agent);
  if (lines.length === 0) {
    return false;
  }

  return lines.some(
    (line) =>
      isNegatedMentionLine(line, agent) ||
      REJECTED_ALTERNATIVE_INDICATORS.some((indicator) =>
        line.includes(indicator),
      ),
  );
}

/**
 * Determine whether a reviewer/auditor agent (`weft`/`warp`) is mentioned
 * only in a downstream review/security-audit role for LOCAL-ONLY diagnostics.
 * Mirrors the scoring-affecting check in `isOnlySecondaryRole` but is exposed
 * independently so diagnostics can report downstream mentions even when the
 * agent never appears in `extractedAgents`.
 */
function isDownstreamReviewAgent(lower: string, agent: string): boolean {
  if (!REVIEWER_AGENT_NAMES.has(agent)) {
    return false;
  }
  const lines = collectAgentLines(lower, agent);
  if (lines.length === 0) {
    return false;
  }
  return isOnlySecondaryRole(lower, agent);
}

export interface LoomRoutingAnalysis {
  extractedAgents: string[];
  canonicalRoutedAgents: string[];
  primaryRoutedAgents: string[];
  exploratoryAgents: string[];
  /**
   * Agents mentioned only as a rejected/negated alternative — considered and
   * ruled out in favor of a different route. LOCAL-ONLY diagnostic; never
   * affects scoring directly (rejection already excludes the agent from
   * `extractedAgents`).
   */
  rejectedAgents: string[];
  /**
   * Reviewer/auditor agents (`weft`/`warp`) mentioned only as a downstream
   * follow-up review or security-audit step, not as the primary route.
   * LOCAL-ONLY diagnostic; never affects scoring directly.
   */
  downstreamAgents: string[];
  /**
   * Candidate agent names present in the raw text without any
   * routing-relevant phrase — a non-routing mention. LOCAL-ONLY diagnostic;
   * never affects scoring.
   */
  mentionOnlyAgents: string[];
}

/**
 * Analyze Loom routing text into raw extracted agents, canonical routed agents,
 * and the primary implementation route used for scoring.
 *
 * In addition to the scoring-relevant fields (`primaryRoutedAgents`,
 * `exploratoryAgents`), this also derives LOCAL-ONLY diagnostic buckets that
 * classify every candidate agent occurrence into one of: affirmative primary
 * route, exploratory pre-hop, downstream reviewer/security step,
 * rejected/negated alternative, or non-routing mention. These diagnostic
 * buckets never influence scoring — only `primaryRoutedAgents` is scored.
 */
export function analyzeLoomRouting(content: string): LoomRoutingAnalysis {
  const lower = content.toLowerCase();
  const extractedAgents = extractRoutedAgents(content);
  const exploratoryAgents = uniqueInOrder(
    extractedAgents
      .filter((agent) => isExploratoryPrehopAgent(lower, agent))
      .map((agent) => canonicalizeRoutingAgent(agent)),
  );

  const canonicalRoutedAgents = uniqueInOrder(
    extractedAgents.map((agent) => canonicalizeRoutingAgent(agent)),
  );

  const primaryRoutedAgents = uniqueInOrder(
    extractedAgents
      .filter((agent) => !isExploratoryPrehopAgent(lower, agent))
      .map((agent) => canonicalizeRoutingAgent(agent)),
  );

  // LOCAL-ONLY diagnostics: scan the full candidate set (not just
  // extractedAgents) so rejected/downstream mentions are visible even when
  // extraction already excluded them from scoring.
  const candidates = collectRoutingAgentCandidates(content);
  const extractedSet = new Set(extractedAgents);

  const rejectedAgents = uniqueInOrder(
    candidates
      .filter((agent) => isRejectedAlternativeAgent(lower, agent))
      .map((agent) => canonicalizeRoutingAgent(agent)),
  );

  const downstreamAgents = uniqueInOrder(
    candidates
      .filter((agent) => isDownstreamReviewAgent(lower, agent))
      .map((agent) => canonicalizeRoutingAgent(agent)),
  );

  const rejectedOrDownstreamSet = new Set([
    ...rejectedAgents,
    ...downstreamAgents,
  ]);

  const mentionOnlyAgents = uniqueInOrder(
    candidates
      .filter(
        (agent) =>
          lower.includes(agent) &&
          !extractedSet.has(agent) &&
          !isRejectedAlternativeAgent(lower, agent) &&
          !isDownstreamReviewAgent(lower, agent),
      )
      .map((agent) => canonicalizeRoutingAgent(agent))
      .filter((agent) => !rejectedOrDownstreamSet.has(agent)),
  );

  if (primaryRoutedAgents.length > 0) {
    return {
      extractedAgents,
      canonicalRoutedAgents,
      primaryRoutedAgents,
      exploratoryAgents,
      rejectedAgents,
      downstreamAgents,
      mentionOnlyAgents,
    };
  }

  return {
    extractedAgents,
    canonicalRoutedAgents,
    primaryRoutedAgents: canonicalRoutedAgents,
    exploratoryAgents,
    rejectedAgents,
    downstreamAgents,
    mentionOnlyAgents,
  };
}

export function buildRoutingRunnerDiagnostics(
  evalCase: EvalCase,
  analysis: LoomRoutingAnalysis,
): NonNullable<RawCaseResultArtifact["runnerDiagnostics"]> | undefined {
  if (evalCase.expected_outcome.kind !== "agent_routing") {
    return undefined;
  }

  const acceptedTargets = uniqueInOrder(
    [
      evalCase.expected_outcome.target_agent,
      ...evalCase.accepted_alternates,
    ].map((agent) => canonicalizeRoutingAgent(agent)),
  );
  const observedPrimaryTarget = analysis.primaryRoutedAgents[0];

  const classification = classifyRoutingDiagnostics(
    analysis,
    observedPrimaryTarget,
    acceptedTargets,
  );

  return {
    detectedArtifacts: [],
    missingRequiredArtifacts: [],
    routingSignals: {
      extractedAgents: analysis.extractedAgents,
      canonicalRoutedAgents: analysis.canonicalRoutedAgents,
      primaryRoutedAgents: analysis.primaryRoutedAgents,
      exploratoryAgents: analysis.exploratoryAgents,
      rejectedAgents: analysis.rejectedAgents,
      downstreamAgents: analysis.downstreamAgents,
      mentionOnlyAgents: analysis.mentionOnlyAgents,
      expectedTarget: canonicalizeRoutingAgent(
        evalCase.expected_outcome.target_agent,
      ),
      acceptedTargets,
      observedPrimaryTarget,
      classification,
    },
  };
}

function classifyRoutingDiagnostics(
  analysis: LoomRoutingAnalysis,
  observedPrimaryTarget: string | undefined,
  acceptedTargets: readonly string[],
):
  | "matched-primary-target"
  | "acceptable-but-nonprimary-exploratory-route"
  | "wrong-primary-target"
  | "extraction-miss" {
  if (analysis.extractedAgents.length === 0) {
    return "extraction-miss";
  }

  if (
    analysis.exploratoryAgents.length > 0 &&
    observedPrimaryTarget !== undefined &&
    !analysis.exploratoryAgents.includes(observedPrimaryTarget) &&
    acceptedTargets.includes(observedPrimaryTarget)
  ) {
    return "acceptable-but-nonprimary-exploratory-route";
  }

  if (
    observedPrimaryTarget !== undefined &&
    acceptedTargets.includes(observedPrimaryTarget)
  ) {
    return "matched-primary-target";
  }

  return "wrong-primary-target";
}

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
      `\\b${agentPattern}\\b[^\\n]{0,32}\\b(?:no|not needed|not required|not warranted|unnecessary)\\b`,
      "i",
    ),
    new RegExp(`\\bwithout\\s+${agentPattern}\\b`, "i"),
    new RegExp(`\\bnot\\b[^\\n]{0,60}\\bvia\\s+${agentPattern}\\b`, "i"),
    new RegExp(`\\brather than\\s+${agentPattern}\\b`, "i"),
    new RegExp(`\\binstead of\\s+${agentPattern}\\b`, "i"),
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

// ---------------------------------------------------------------------------
// Affirmative primary-route detection
// ---------------------------------------------------------------------------

/**
 * Real model output frequently uses an "explain then decide" order: a
 * considered-but-rejected agent is named first in the reasoning (e.g. via
 * "route to <agent>" phrasing while discussing why it doesn't apply), while
 * the actual decision is stated later via an explicit affirmative-route
 * utterance (e.g. `**Route to: `shuttle`**`).
 *
 * Position-based extraction in `extractRoutedAgents()` otherwise picks the
 * FIRST mentioned agent, which is wrong for this ordering — it scores the
 * rejected alternative instead of the asserted route. These patterns detect
 * an explicit affirmative-route utterance regardless of position, so it can
 * override the position-based result.
 *
 * Recognizes the same forms as the Tapestry category-routing runner:
 *   - verb + "to": "route to X", "delegate to X", "assign to X", "send to X"
 *     (small word gap allowed between verb and "to", e.g. "route the task to X").
 *   - label form: "Route: X", "Primary route: X".
 *   - arrow form: "→ X".
 *   - labelled-answer form: "Answer: X", "Decision: X", "Result: X",
 *     "Conclusion: X", "Final: X", "Final answer: X", "Verdict: X",
 *     "Chosen: X", "Choice: X", "Recommendation: X", "Recommended: X",
 *     "Selected: X", "Selection: X" (case-insensitive).
 *
 * Markdown emphasis is stripped before matching.
 */
// A trailing `(?!-)` guard is applied after every captured identifier below
// so a partial match against malformed/placeholder text (e.g. a literal
// doc-style example `→ \`shuttle-{category}\`` where `{category}` isn't a
// real suffix) never collapses to a false bare identifier match — see task
// 9b-follow-up-5 for the concrete regression this guards against.
const AFFIRMATIVE_VERB_TO_RE =
  /\b(?:rout(?:e|ing)|delegat(?:e|ing)|assign(?:ing)?|send(?:ing)?)(?:\s+\w+){0,3}?\s+to\b\s*:?\s*([a-z][a-z0-9_-]*)(?!-)\b/gi;
const AFFIRMATIVE_LABEL_RE =
  /\b(?:primary\s+route|route)\s*:\s*([a-z][a-z0-9_-]*)(?!-)\b/gi;
const AFFIRMATIVE_ARROW_RE = /→\s*([a-z][a-z0-9_-]*)(?!-)\b/gi;
// Labelled-answer forms: same lead-word set as the Tapestry category-routing
// runner. Markdown emphasis around the label or target is stripped by
// `stripMarkdownEmphasis()` before matching. "final answer" is listed before
// "final" so the longer lead phrase wins the alternation. The captured
// identifier is validated against the candidate set by callers (same as the
// other affirmative patterns), so unrelated words before a stray colon never
// falsely match a real agent name.
const AFFIRMATIVE_LABELLED_ANSWER_RE =
  /\b(?:final\s+answer|answer|decision|result|conclusion|final|verdict|chosen|choice|recommendation|recommended|selected|selection)\s*:\s*([a-z][a-z0-9_-]*)(?!-)\b/gi;

// "Fallback verb" forms: "Fall back to X", "Falls back to X", "Falling back
// to X", "Fallback to X", "Fallback: X", "Fall back: X", "Default fallback:
// X", "Default fallback to X", "Default: X", "Default to X". Case-insensitive
// via the `i` flag; markdown emphasis is stripped before matching, same as
// the other affirmative patterns. See task 9b-follow-up-4 (deepseek run on
// tcr-10: "**Fall back to `shuttle`.**"). The captured identifier is
// validated against the candidate set by callers, same as the other
// affirmative patterns.
const AFFIRMATIVE_FALLBACK_VERB_RE =
  /\b(?:fall(?:s)?\s*back|falling\s+back|fallback|default(?:\s+fallback)?)(?:\s+to|\s*:)?\s+([a-z][a-z0-9_-]*)(?!-)\b/gi;
// "Use X" / "Use the X agent" forms. Scoped to start-of-sentence/clause
// (start of string, or immediately after ". " or a newline) so the common
// word "use" does not spuriously match mid-sentence prose. The captured
// identifier is validated against the candidate set by callers.
const AFFIRMATIVE_USE_VERB_RE =
  /(?<=^|[.\n]\s*)use\s+(?:the\s+)?([a-z][a-z0-9_-]*)(?!-)\b(?:\s+agent)?/gi;

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
 * hypothetical/considered-but-rejected mention, e.g. "would route to X".
 * Checked within the current clause/sentence only, so an unrelated
 * hypothetical word in an earlier, already-concluded sentence does not
 * falsely mark a later, unrelated affirmative-route utterance as
 * hypothetical.
 */
const HYPOTHETICAL_CONTEXT_RE = /\b(?:would|might|could|considered?)\b/i;

function isHypotheticalContext(text: string, matchIndex: number): boolean {
  const rawWindowStart = Math.max(0, matchIndex - 40);
  const windowRaw = text.slice(rawWindowStart, matchIndex);
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
 * Negation prefixes/suffixes that indicate the agent name at a given index
 * is explicitly rejected rather than chosen — e.g. "do not route to X" or
 * "X is disabled". Mirrors the negation windows used by
 * `isNegatedMentionLine()` but applied to the full (unsplit) content so an
 * affirmative-looking match in an EARLIER, negated clause never wins over a
 * later, non-negated affirmative match sharing the same verb+"to" phrasing
 * (e.g. "do not route to X; route to Y").
 */
const AFFIRMATIVE_NEGATION_PREFIXES_RE =
  /\b(?:not?|do not|cannot|can't|don'?t|skip|avoid|instead of|excluding?|without|bypass(?:ing)?)\s+/i;
const AFFIRMATIVE_NEGATION_SUFFIX_RE =
  /\s+(?:is\s+)?(?:disabled|unavailable|excluded|unnecessary|not\s+(?:needed|required|necessary)|isn'?t\s+(?:needed|required|necessary))/i;

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

  const windowAfterRaw = text.slice(
    targetIndex + targetLength,
    targetIndex + targetLength + 40,
  );
  // Clamp the suffix window to the end of the current clause/sentence so a
  // negation suffix in a LATER, unrelated clause (e.g. "Route to X. Fallback
  // to Y is not required.") never bleeds back to negate an earlier,
  // non-negated affirmative match. Mirrors the clause clamping already
  // applied to the prefix window above. See task 9b-follow-up-5.
  const suffixBoundaryIdx = (() => {
    const candidates = [
      windowAfterRaw.indexOf(". "),
      windowAfterRaw.indexOf("; "),
      windowAfterRaw.indexOf(", "),
      windowAfterRaw.indexOf("\n"),
    ].filter((idx) => idx >= 0);
    return candidates.length > 0 ? Math.min(...candidates) : -1;
  })();
  const windowAfter =
    suffixBoundaryIdx >= 0
      ? windowAfterRaw.slice(0, suffixBoundaryIdx)
      : windowAfterRaw;
  return (
    AFFIRMATIVE_NEGATION_PREFIXES_RE.test(clauseWindow) ||
    AFFIRMATIVE_NEGATION_SUFFIX_RE.test(windowAfter)
  );
}

/**
 * Strip markdown emphasis characters (`**bold**`, `` `code` ``) so
 * affirmative-route patterns match regardless of markdown wrapping.
 */
function stripMarkdownEmphasis(content: string): string {
  return content.replace(/\*\*/g, "").replace(/`/g, "");
}

/**
 * Find the model's explicitly asserted primary route, regardless of where
 * it appears in the text — as opposed to the first agent name merely
 * mentioned (which may be a considered-and-rejected alternative discussed
 * earlier in the reasoning).
 *
 * Returns the lowercased agent name of the earliest non-hypothetical,
 * non-negated affirmative-route utterance whose target is a known routing
 * candidate, or `undefined` if no such utterance is found (callers should
 * fall back to first-mention extraction in that case).
 *
 * Exported for unit testing.
 */
export function findAffirmativeRoutedAgent(
  content: string,
  candidates: readonly string[],
): string | undefined {
  const stripped = stripMarkdownEmphasis(content);
  const candidateSet = new Set(candidates);
  const found: Array<{ index: number; target: string }> = [];

  for (const pattern of AFFIRMATIVE_ROUTE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of stripped.matchAll(pattern)) {
      const target = match[1].toLowerCase();
      if (!candidateSet.has(target)) {
        continue;
      }
      const index = match.index ?? 0;
      if (isHypotheticalContext(stripped, index)) {
        continue;
      }
      const targetIndex = index + match[0].length - match[1].length;
      if (isNegatedAffirmativeMatch(stripped, targetIndex, match[1].length)) {
        continue;
      }
      found.push({ index, target });
    }
  }

  if (found.length === 0) {
    return undefined;
  }

  found.sort((left, right) => left.index - right.index);
  return found[0].target;
}

/**
 * Matches a lone target identifier occupying the ENTIRE first non-blank
 * line of a model response — e.g. `` `shuttle` ``, `**shuttle**`,
 * `` **`shuttle`** ``, or `shuttle-client-frontend` — optionally followed by
 * a short parenthetical/dash/colon description on the same line (e.g.
 * `` `shuttle` — generic fallback ``, `**shuttle** (default)`).
 *
 * Mirrors the Tapestry category-routing runner's lone-opening-line rule:
 * real model output sometimes opens with a bare, unadorned decision (no
 * routing verb, no "Route to:" label) and only explains the reasoning
 * afterward. Anchored to the full (trimmed) line so multi-target or
 * full-sentence openers never match — only a standalone identifier (with
 * optional markdown wrapping and a short trailing description) counts.
 */
// Deterministic two-step match (not one combined regex): a single regex
// that allows both an optional hyphenated identifier suffix AND an
// arbitrary trailing description is ambiguous under backtracking — e.g.
// "shuttle-backend was considered..." can incorrectly backtrack the
// hyphen-run down to a shorter identifier and swallow the remainder as the
// "trailing description" group. Splitting into (1) a deterministic maximal
// leading-token match and (2) separate validation of that token (against
// the candidate set) and the remainder avoids the ambiguity entirely.
const LEADING_TOKEN_RE = /^\*{0,2}`?([a-z][a-z0-9_-]*)`?\*{0,2}(.*)$/i;
// Trailing description shape: either empty, or introduced by one of the
// lead-in markers below. No length cap — see module docs for rationale. The
// content that follows is validated separately by
// `trailingPointsToDifferentCandidate()`.
const LONE_OPENING_TRAILING_RE = /^\s*(?:[-\u2014\u2013(:].*)?$/;

/**
 * Return true when the trailing description (the text after the opener
 * token and its lead-in punctuation) contains an explicit route-verb phrase
 * (`route to`, `delegate to`, `→`, `primary route`) pointing at a DIFFERENT
 * known routing candidate than `openerIdentifier`. In that case the opener
 * is not actually the model's asserted decision — the real decision is
 * stated later in the same line — so the lone-opener rule should NOT
 * trigger (let `findAffirmativeRoutedAgent()` take over instead).
 *
 * A trailing mention of a different candidate WITHOUT a route verb (e.g.
 * explaining why another agent was rejected) does not disqualify the
 * opener — see module docs for rationale.
 */
function trailingPointsToDifferentCandidate(
  rest: string,
  openerIdentifier: string,
  candidateSet: ReadonlySet<string>,
): boolean {
  const stripped = stripMarkdownEmphasis(rest);
  for (const pattern of AFFIRMATIVE_ROUTE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of stripped.matchAll(pattern)) {
      const target = match[1].toLowerCase();
      if (!candidateSet.has(target)) {
        continue;
      }
      if (target !== openerIdentifier) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Find a lone target identifier occupying the entire first non-blank line
 * of the response, validated against `candidates` — see the comment on
 * `LEADING_TOKEN_RE` for the matching strategy and `findAffirmativeRoutedAgent()`'s
 * neighboring docs for the recognized forms and rationale.
 *
 * Only the first non-blank line is ever considered: if it doesn't match the
 * lone-identifier shape, or the matched identifier is not a known routing
 * candidate, this returns `undefined` immediately (callers fall back to
 * `findAffirmativeRoutedAgent()` and then first-mention extraction).
 *
 * Exported for unit testing.
 */
export function findLoneOpeningLineAgent(
  content: string,
  candidates: readonly string[],
): string | undefined {
  const candidateSet = new Set(candidates.map((c) => c.toLowerCase()));
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
    if (!candidateSet.has(identifier)) {
      return undefined;
    }
    if (!LONE_OPENING_TRAILING_RE.test(rest)) {
      return undefined;
    }
    if (trailingPointsToDifferentCandidate(rest, identifier, candidateSet)) {
      return undefined;
    }
    return identifier;
  }
  return undefined;
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

  const result = [...new Set(matches.map((match) => match.agent))];

  // Prefer a lone target identifier occupying the entire first non-blank
  // line (e.g. `` `shuttle` `` opening a response whose reasoning below
  // mentions other, rejected agent names) over both the explicit
  // affirmative-marker search and first-mention order — see
  // `findLoneOpeningLineAgent()` for the full rationale.
  const loneOpeningTarget = findLoneOpeningLineAgent(content, sortedNames);
  if (loneOpeningTarget !== undefined) {
    return [
      loneOpeningTarget,
      ...result.filter((agent) => agent !== loneOpeningTarget),
    ];
  }

  // Prefer an explicit affirmative-route utterance (e.g. `Route to: shuttle`,
  // `**Route to: `shuttle`**`) over the first-mentioned agent name. Real
  // model output often names a considered-but-rejected agent earlier in the
  // reasoning before stating the actual decision later — see
  // `findAffirmativeRoutedAgent()` for the full rationale. The affirmative
  // finder applies its own hypothetical/negation filtering, so it may find a
  // valid target that the phrase-substring extraction above missed entirely
  // (e.g. "Route to: X" with a colon, which the plain "route to X" substring
  // check does not match) — in that case the target is added, not just
  // reordered.
  const affirmativeTarget = findAffirmativeRoutedAgent(content, sortedNames);
  if (affirmativeTarget !== undefined) {
    return [
      affirmativeTarget,
      ...result.filter((agent) => agent !== affirmativeTarget),
    ];
  }

  return result;
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
  const routedAgents = analyzeLoomRouting(content).primaryRoutedAgents;

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
  /**
   * `TrajectoryRunner` used for cases whose `expected_outcome.kind ===
   * "harness_trajectory"`.
   *
   * When omitted, the runner lazily imports and constructs the production
   * `OpenCodeTrajectoryRunner` (via `opencode-trajectory-runner-adapter.ts`)
   * the first time a suite run contains at least one trajectory case. Tests
   * inject a stub `TrajectoryRunner` here to avoid any real Podman/file-
   * system access.
   */
  trajectoryRunner?: TrajectoryRunner;
  /**
   * Read-only sandbox image existence checker used ONLY on the `--dry-run`
   * path for trajectory cases (`podman image inspect`, never `podman run`).
   *
   * When omitted, defaults to the production checker in
   * `opencode-trajectory-runner-adapter.ts`. Tests inject a stub to avoid
   * spawning a real `podman` process. Failures are swallowed (treated as
   * "image not present") — the check never fails the dry run.
   */
  sandboxImageChecker?: (sandboxProfile: string) => Promise<boolean>;
  /**
   * Environment variable map used to construct the production trajectory
   * runner (reads `OPENROUTER_API_KEY`). Defaults to `Bun.env`.
   */
  env?: Record<string, string | undefined>;
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
  private readonly injectedTrajectoryRunner: TrajectoryRunner | undefined;
  private readonly sandboxImageChecker: (
    sandboxProfile: string,
  ) => Promise<boolean>;
  private readonly env: Record<string, string | undefined>;

  constructor(options: LoomRoutingRunnerOptions) {
    this.modelClient = options.modelClient;
    this.scorer = options.scorer;
    this.evalsRoot = options.evalsRoot;
    this.injectedTrajectoryRunner = options.trajectoryRunner;
    this.sandboxImageChecker =
      options.sandboxImageChecker ?? defaultSandboxImageChecker;
    this.env = options.env ?? Bun.env;

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
        // For `harness_trajectory` cases, run the read-only sandbox image
        // existence check (`podman image inspect`, never `podman run`) as
        // part of dry-run schema validation. The check result is
        // best-effort and never fails the dry run — a dev box without the
        // sandbox image built yet should still see a green dry run.
        const caseResultsPromise = Promise.all(
          workItems.map(async ({ evalCase, modelId }) => {
            if (evalCase.expected_outcome.kind === "harness_trajectory") {
              await this.sandboxImageChecker(
                evalCase.expected_outcome.sandbox_profile,
              );
            }
            return buildDryRunResult(evalCase, modelId);
          }),
        );
        return ResultAsync.fromSafePromise(
          caseResultsPromise.then((caseResults) =>
            this.assembleResult(LOOM_ROUTING_SUITE, caseResults),
          ),
        );
      }

      // Resolve the Loom prompt once before executing work items.
      // Provider failure is a hard stop — no fallback to hardcoded prompts.
      // This guarantees prompt provenance for all runs.
      const hasTrajectoryCase = workItems.some(
        (item) => item.evalCase.expected_outcome.kind === "harness_trajectory",
      );
      const trajectoryRunnerAsync: ResultAsync<
        TrajectoryRunner | undefined,
        RunnerError
      > = hasTrajectoryCase
        ? this.resolveTrajectoryRunner(cases)
        : okAsync(undefined);

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
          trajectoryRunnerAsync.andThen((trajectoryRunner) =>
            // Execute each work item sequentially to avoid overwhelming the model API
            this.executeWorkItems(
              workItems,
              rubrics,
              rawArtifacts,
              systemPrompt,
              trajectoryRunner,
            ).andThen((caseResults) =>
              ResultAsync.fromSafePromise(
                Promise.resolve(
                  this.assembleResult(LOOM_ROUTING_SUITE, caseResults),
                ),
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
    trajectoryRunner: TrajectoryRunner | undefined,
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
            trajectoryRunner,
          ).map((result) => [...results, result]),
        ),
      ResultAsync.fromSafePromise(Promise.resolve([] as CaseResult[])),
    );

    return executeAll as ResultAsync<CaseResult[], never>;
  }

  /**
   * Resolve the `TrajectoryRunner` used for `harness_trajectory` cases.
   *
   * Returns the injected runner when supplied at construction (tests always
   * inject a stub here). Otherwise lazily imports and constructs the
   * production `OpenCodeTrajectoryRunner` via
   * `opencode-trajectory-runner-adapter.ts` — real Podman/file-system
   * dependencies are only pulled in on this path, never for text-only suites
   * or dry runs.
   */
  private resolveTrajectoryRunner(
    cases: EvalCase[],
  ): ResultAsync<TrajectoryRunner, RunnerError> {
    if (this.injectedTrajectoryRunner !== undefined) {
      return okAsync(this.injectedTrajectoryRunner);
    }
    return ResultAsync.fromPromise(
      this.buildDefaultTrajectoryRunner(cases),
      (cause): RunnerError => ({
        type: "PromptProviderFailed",
        agentName: "loom-trajectory-runner",
        message: `Trajectory runner construction failed: ${String(cause)}`,
      }),
    );
  }

  private async buildDefaultTrajectoryRunner(
    cases: EvalCase[],
  ): Promise<TrajectoryRunner> {
    const { createProductionTrajectoryRunner } = await import(
      "./opencode-trajectory-runner-adapter.js"
    );
    return createProductionTrajectoryRunner(cases, this.env);
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
    trajectoryRunner: TrajectoryRunner | undefined,
  ): ResultAsync<CaseResult, never> {
    if (evalCase.expected_outcome.kind === "harness_trajectory") {
      return this.executeTrajectoryCase(
        evalCase,
        modelId,
        rubrics,
        rawArtifacts,
        trajectoryRunner,
      );
    }

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
            ? (() => {
                const routingDiagnostics = buildRoutingRunnerDiagnostics(
                  evalCase,
                  analyzeLoomRouting(runOutput.rawContent),
                );
                return {
                  caseId: evalCase.id,
                  modelId,
                  composedPrompt,
                  transcript: runOutput.transcript,
                  rawContent: runOutput.rawContent,
                  dimensionRationales: buildDimensionRationales(
                    scoreRecord.dimensions,
                  ),
                  ...(routingDiagnostics !== undefined
                    ? { runnerDiagnostics: routingDiagnostics }
                    : {}),
                };
              })()
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
   * Execute a single `harness_trajectory` case: run the real sandboxed
   * harness via the injected/lazily-constructed `TrajectoryRunner` and score
   * the observed event stream with `scoreTrajectoryResult`. Never routes
   * through `modelClient`/`scorer` — those are for text-only cases only.
   *
   * Never returns `err` — the same zero-score `CaseResult` convention as
   * `executeSingleCase` applies here.
   */
  private executeTrajectoryCase(
    evalCase: EvalCase,
    modelId: string,
    rubrics: EvalRubric[],
    rawArtifacts: boolean,
    trajectoryRunner: TrajectoryRunner | undefined,
  ): ResultAsync<CaseResult, never> {
    if (evalCase.expected_outcome.kind !== "harness_trajectory") {
      // Unreachable in practice — callers only route here for this kind.
      return new ResultAsync(
        Promise.resolve(
          ok(
            buildErrorResult(
              evalCase,
              modelId,
              "UnknownEvalSuite",
              rawArtifacts,
            ),
          ),
        ),
      );
    }
    const outcome = evalCase.expected_outcome;

    if (trajectoryRunner === undefined) {
      return new ResultAsync(
        Promise.resolve(
          ok(
            buildErrorResult(
              evalCase,
              modelId,
              "TrajectoryRunnerUnavailable",
              rawArtifacts,
              undefined,
              "No TrajectoryRunner was resolved for this suite run.",
            ),
          ),
        ),
      );
    }

    const rubric = rubrics.find((r) => r.case_id === evalCase.id);
    if (rubric === undefined) {
      return new ResultAsync(
        Promise.resolve(
          ok(
            buildErrorResult(
              evalCase,
              modelId,
              "RubricNotFound",
              rawArtifacts,
              undefined,
              `No rubric found for case "${evalCase.id}".`,
            ),
          ),
        ),
      );
    }

    const trajectoryCase: TrajectoryCase = {
      testCaseId: evalCase.id,
      expectedSpawns: outcome.expected_spawns,
      expectedTools: outcome.expected_tools,
      maxDurationSeconds: outcome.max_duration_seconds,
      sandboxProfile: outcome.sandbox_profile,
    };

    // The workspace passed here is a placeholder: `OpenCodeTrajectoryRunner`
    // constructs its own real ephemeral workspace internally via the
    // injected `TrajectoryWorkspaceFactory` before invoking the sandbox.
    const placeholderWorkspace: TrajectoryWorkspace = {
      root: "",
      artifactsDir: "",
    };

    const matchPromise = trajectoryRunner
      .run(trajectoryCase, modelId, placeholderWorkspace)
      .match<CaseResult>(
        (result) => {
          const scoreRecord = scoreTrajectoryResult({
            caseId: evalCase.id,
            modelId,
            suite: evalCase.suite,
            events: result.events,
            expectedOutcome: outcome,
            scoring: rubric.scoring,
          });

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
            trajectorySummary: result.summary,
          };

          // `result.events` (the full trajectory) and `result.rawArtifactRef`
          // are LOCAL-ONLY per docs/specs/33-spec-harness-trajectory-evals —
          // only stored in the raw artifact, never in `summary`.
          const rawArtifact: RawCaseResultArtifact | undefined = rawArtifacts
            ? {
                caseId: evalCase.id,
                modelId,
                composedPrompt: "",
                transcript: [],
                rawContent: JSON.stringify(result.events),
                dimensionRationales: buildDimensionRationales(
                  scoreRecord.dimensions,
                ),
              }
            : undefined;

          return { summary, rawArtifact };
        },
        (error) =>
          buildErrorResult(evalCase, modelId, error.type, rawArtifacts),
      );

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
 * Default `--dry-run` sandbox image existence checker.
 *
 * Lazily imports `opencode-trajectory-runner-adapter.ts` and delegates to
 * `checkSandboxImageExists`, which shells out to `podman image inspect`
 * (read-only, never `podman run`). Failures (missing podman binary, missing
 * image) resolve to `false` rather than rejecting.
 */
async function defaultSandboxImageChecker(
  sandboxProfile: string,
): Promise<boolean> {
  const { checkSandboxImageExists } = await import(
    "./opencode-trajectory-runner-adapter.js"
  );
  return checkSandboxImageExists(sandboxProfile).match(
    (exists) => exists,
    () => false,
  );
}

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
      // imports from @weaveio/weave-config and @weaveio/weave-engine; we only pull those in
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
