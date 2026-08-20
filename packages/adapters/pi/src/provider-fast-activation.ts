import { Result } from "neverthrow";
import type { CodexFastSnapshot } from "./codex-fast/attempt.js";
import type { CodexFastAllowlistRuleId } from "./codex-fast/routing.js";
import { CODEX_FAST_MODEL_ALLOWLIST } from "./codex-fast/routing.js";

/**
 * Pi provider-fast activation: the adapter's public, sanitized vocabulary.
 *
 * `fast true` is neutral intent. Turning it into a runtime state needs two
 * proofs bound to the *same* prepared provider request: the exact transport
 * that request will use, and the provider's own documented response field for
 * that same attempt. Which of those proofs exist depends entirely on the seam
 * the request travelled through, so this adapter has exactly two mappings and
 * this module is where they meet:
 *
 * - **The hook seam, for every provider.** `before_provider_request`,
 *   `before_provider_headers`, and `after_provider_response` bind neither
 *   proof: `getProviderAuth()` describes a *fresh* resolution rather than the
 *   transport a held request was prepared with, and no public hook exposes the
 *   response body of one attempt. The adapter therefore registers no
 *   acceleration hook, mutates no payload and no header there, and reports one
 *   bounded terminal `unsupported` outcome. `classifyProviderFastIntent` is
 *   that fallback, and it stays the answer for every non-Codex or unmapped
 *   intent.
 * - **The wrapped `openai-codex` provider, for the Codex subscription
 *   mapping.** Weave owns that provider object, so one stream call holds the
 *   effective transport, the final body, the outgoing headers, and the same
 *   attempt's response. `../codex-fast/attempt.js` correlates those facts into
 *   a `CodexFastSnapshot`; `projectCodexFastSnapshot` is the only door through
 *   which such an attempt may become a reportable public state.
 *
 * Both doors produce the same closed shape, so telemetry, `/weave:status`, and
 * the capability declaration need no knowledge of which seam ran.
 *
 * Deliberate properties:
 *
 * - **Tokens only.** A public snapshot carries enum tokens and, at most, one
 *   allowlist rule id. No provider string, model text, URL, header name,
 *   header value, payload fragment, credential, or diagnostic can enter it, so
 *   none can leave through a journal entry, a status line, or a log.
 * - **Never upgraded.** The projection copies a correlated state; it can lower
 *   an outcome to a bounded degradation but can never raise one. `applied`
 *   survives the door only with same-attempt `confirmed` evidence of the kind
 *   the contract names.
 * - **No request surface.** This module still holds no payload, header,
 *   transport, correlation token, or attempt tracker. Requests are shaped in
 *   the codex-fast modules; states are named here.
 *
 * @see docs/specs/fast-provider-acceleration-contract.md
 */

/**
 * The neutral runtime states, exactly the engine's
 * `PROVIDER_FAST_ACTIVATION_STATUSES`. The adapter may only report a token
 * from this set, so the engine never has to translate an adapter-local name.
 *
 * `declared` belongs to the vocabulary because the contract defines it, not
 * because this adapter rests there: declared intent that reaches no eligible
 * Codex attempt terminates immediately at `unsupported`, and an intent that
 * does reach one is already an attempt state.
 */
export const PROVIDER_FAST_STATES = Object.freeze([
  "declared",
  "requested",
  "applied",
  "not-confirmed",
  "unsupported",
] as const);

export type ProviderFastState = (typeof PROVIDER_FAST_STATES)[number];

/**
 * Bounded reason codes this adapter may report, in contract order.
 *
 * `none` is the explicit "nothing to explain" token, so the field is never
 * nullable. `harness-seam-unavailable` names the proven Pi host gap for the
 * hook seam: no documented hook binds an effective transport, or a response
 * proof, to one prepared request. Every remaining token is a bounded verdict
 * of the Codex subscription mapping — an eligibility or collision failure, a
 * missing response proof, or a fail-closed wrapper degradation.
 *
 * Coverage of the mapping's own reasons is proven by the compiler:
 * `projectCodexFastSnapshot` assigns a `CodexFastReason` straight into this
 * type, so a new mapping reason cannot ship without appearing here.
 */
export const PROVIDER_FAST_REASONS = Object.freeze([
  "none",
  "harness-seam-unavailable",
  "provider-not-codex",
  "model-id-unsafe",
  "model-not-allowed",
  "model-owner-mismatch",
  "transport-not-first-party",
  "auth-not-subscription",
  "request-collision",
  "response-proof-unavailable",
  "attempt-uncorrelated",
  "canceled",
  "timed-out",
  "wrapper-degraded",
] as const);

export type ProviderFastReason = (typeof PROVIDER_FAST_REASONS)[number];

/** The hook seam's single reason: the host cannot bind either proof. */
export const PROVIDER_FAST_UNSUPPORTED_REASON: ProviderFastReason =
  "harness-seam-unavailable";

/** Evidence kinds allowed by the normative sanitized-evidence contract. */
export const PROVIDER_FAST_EVIDENCE_KINDS = Object.freeze([
  "none",
  "openai-service-tier",
  "anthropic-usage-speed",
] as const);

export type ProviderFastEvidenceKind =
  (typeof PROVIDER_FAST_EVIDENCE_KINDS)[number];

/** Evidence outcomes allowed by the normative sanitized-evidence contract. */
export const PROVIDER_FAST_EVIDENCE_OUTCOMES = Object.freeze([
  "confirmed",
  "standard",
  "absent",
  "ambiguous",
  "inaccessible",
] as const);

export type ProviderFastEvidenceOutcome =
  (typeof PROVIDER_FAST_EVIDENCE_OUTCOMES)[number];

/**
 * The only model-adjacent token the contract allows in evidence: an allowlist
 * rule id. It is derived from the frozen allowlist itself, so a revision that
 * adds an entry cannot leave the reportable set behind, and arbitrary model
 * text can never become one.
 */
export type ProviderFastRuleId = CodexFastAllowlistRuleId;

export const PROVIDER_FAST_RULE_IDS: readonly ProviderFastRuleId[] =
  Object.freeze([
    ...new Set(CODEX_FAST_MODEL_ALLOWLIST.map((entry) => entry.ruleId)),
  ]);

/** Accept an allowlist rule id only in its exact frozen shape. */
export function isProviderFastRuleId(
  value: unknown,
): value is ProviderFastRuleId {
  return (
    typeof value === "string" &&
    PROVIDER_FAST_RULE_IDS.includes(value as ProviderFastRuleId)
  );
}

/**
 * The sanitized public state the adapter may report and persist.
 *
 * `ruleId` is present only when an allowlist entry actually matched, so an
 * outcome with no mapping carries no model-adjacent token at all rather than a
 * placeholder. The mapping's attempt counter and collision flag are
 * deliberately not carried: no consumer decides anything from the counter, and
 * a collision is already fully described by the reason `request-collision`.
 */
export type ProviderFastPublicSnapshot = {
  readonly state: ProviderFastState;
  readonly evidenceKind: ProviderFastEvidenceKind;
  readonly evidenceOutcome: ProviderFastEvidenceOutcome;
  readonly reason: ProviderFastReason;
  readonly ruleId?: ProviderFastRuleId;
};

/**
 * The hook seam's terminal outcome. No request carried a control, so no
 * evidence of any kind could exist for it: the evidence kind is `none` and the
 * outcome is `absent`.
 */
export const PROVIDER_FAST_UNSUPPORTED_SNAPSHOT: ProviderFastPublicSnapshot =
  Object.freeze({
    state: "unsupported",
    evidenceKind: "none",
    evidenceOutcome: "absent",
    reason: PROVIDER_FAST_UNSUPPORTED_REASON,
  });

/**
 * The fail-closed answer for a correlated snapshot this module cannot trust.
 * A malformed, hostile, or self-contradicting attempt state reports the same
 * thing as no mapping at all, never something better.
 */
export const PROVIDER_FAST_DEGRADED_SNAPSHOT: ProviderFastPublicSnapshot =
  Object.freeze({
    state: "unsupported",
    evidenceKind: "none",
    evidenceOutcome: "absent",
    reason: "wrapper-degraded",
  });

/** Attempt states that may exist only for a matched allowlist entry. */
const RULE_BOUND_STATES: readonly ProviderFastState[] = Object.freeze([
  "requested",
  "applied",
  "not-confirmed",
] as const);

function isProviderFastState(value: unknown): value is ProviderFastState {
  return (
    typeof value === "string" &&
    PROVIDER_FAST_STATES.includes(value as ProviderFastState)
  );
}

function isProviderFastReason(value: unknown): value is ProviderFastReason {
  return (
    typeof value === "string" &&
    PROVIDER_FAST_REASONS.includes(value as ProviderFastReason)
  );
}

function isProviderFastEvidenceKind(
  value: unknown,
): value is ProviderFastEvidenceKind {
  return (
    typeof value === "string" &&
    PROVIDER_FAST_EVIDENCE_KINDS.includes(value as ProviderFastEvidenceKind)
  );
}

function isProviderFastEvidenceOutcome(
  value: unknown,
): value is ProviderFastEvidenceOutcome {
  return (
    typeof value === "string" &&
    PROVIDER_FAST_EVIDENCE_OUTCOMES.includes(
      value as ProviderFastEvidenceOutcome,
    )
  );
}

/**
 * Project one correlated Codex attempt state into the public vocabulary.
 *
 * This is a copy, not a decision: the attempt correlator already applied every
 * normative rule, and re-deriving them here would create a second, divergent
 * state machine. The projection therefore maps state, reason, evidence kind,
 * and evidence outcome across unchanged, keeps the allowlist rule id when one
 * matched, and drops the mapping's private counters.
 *
 * What it does add is a boundary check, because a public snapshot outlives the
 * attempt that produced it:
 *
 * - unknown tokens, or a shape that is not the closed snapshot, degrade;
 * - `applied` without same-attempt `confirmed` `openai-service-tier` evidence
 *   degrades, so no caller can promote a request into a claim;
 * - an attempt state with no matched allowlist entry degrades, because
 *   `requested`, `applied`, and `not-confirmed` all assert an exact match.
 *
 * A degradation reports `unsupported` / `wrapper-degraded`: the same answer as
 * no mapping, never a better one. No mapping attempt at all (`undefined`)
 * stays no acceleration state at all.
 */
const projectCodexSnapshot = Result.fromThrowable(
  (snapshot: CodexFastSnapshot): ProviderFastPublicSnapshot => {
    const state = snapshot.state;
    const reason = snapshot.reason;
    const evidenceKind = snapshot.evidenceKind;
    const evidenceOutcome = snapshot.evidenceOutcome;
    const ruleId = snapshot.ruleId;
    if (
      !isProviderFastState(state) ||
      !isProviderFastReason(reason) ||
      !isProviderFastEvidenceKind(evidenceKind) ||
      !isProviderFastEvidenceOutcome(evidenceOutcome)
    ) {
      return PROVIDER_FAST_DEGRADED_SNAPSHOT;
    }
    const matched = isProviderFastRuleId(ruleId);
    if (!matched && ruleId !== "none") {
      return PROVIDER_FAST_DEGRADED_SNAPSHOT;
    }
    if (!matched && RULE_BOUND_STATES.includes(state)) {
      return PROVIDER_FAST_DEGRADED_SNAPSHOT;
    }
    if (
      state === "applied" &&
      (evidenceKind !== "openai-service-tier" ||
        evidenceOutcome !== "confirmed")
    ) {
      return PROVIDER_FAST_DEGRADED_SNAPSHOT;
    }
    return Object.freeze(
      matched
        ? { state, evidenceKind, evidenceOutcome, reason, ruleId }
        : { state, evidenceKind, evidenceOutcome, reason },
    );
  },
  () => PROVIDER_FAST_DEGRADED_SNAPSHOT,
);

export function projectCodexFastSnapshot(
  snapshot: CodexFastSnapshot | undefined,
): ProviderFastPublicSnapshot | undefined {
  if (snapshot === undefined || snapshot === null) {
    return undefined;
  }
  return projectCodexSnapshot(snapshot).unwrapOr(
    PROVIDER_FAST_DEGRADED_SNAPSHOT,
  );
}

/** The neutral intent shape an effective descriptor or owner record carries. */
export type ProviderFastIntent = {
  readonly fast?: true;
};

export type ProviderFastClassification =
  | { readonly kind: "no-intent" }
  | {
      readonly kind: "unsupported";
      readonly snapshot: ProviderFastPublicSnapshot;
    };

const NO_INTENT: ProviderFastClassification = Object.freeze({
  kind: "no-intent",
});

const UNSUPPORTED: ProviderFastClassification = Object.freeze({
  kind: "unsupported",
  snapshot: PROVIDER_FAST_UNSUPPORTED_SNAPSHOT,
});

/**
 * Read exact own `fast: true`. Only an own data property counts, so an
 * inherited field or an accessor never declares intent and never runs.
 */
const readOwnFastIntent = Result.fromThrowable(
  (intent: unknown): boolean => {
    if (typeof intent !== "object" || intent === null) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(intent, "fast");
    if (descriptor === undefined || !("value" in descriptor)) {
      return false;
    }
    return descriptor.value === true;
  },
  () => false,
);

/**
 * Classify one owner's neutral fast intent through the hook seam.
 *
 * This is the no-mapping fallback, and it stays deliberately blind: provider,
 * endpoint, model, and transport are not inspected, because on this seam none
 * of them can change the outcome. Omission is no intent and emits no
 * acceleration state at all. Exact `fast true` that reached no eligible Codex
 * attempt is intent the host cannot carry, so it classifies as terminal
 * `unsupported` under the hook-audit reason.
 *
 * An eligible Codex attempt reports through `projectCodexFastSnapshot`
 * instead; the wrapped provider owns that path end to end.
 */
export function classifyProviderFastIntent(
  intent: unknown,
): ProviderFastClassification {
  return readOwnFastIntent(intent).unwrapOr(false) ? UNSUPPORTED : NO_INTENT;
}

/**
 * After a proven applied-model change, prior acceleration evidence is
 * invalid. Recompute from the new owner's intent only; never reuse a
 * previous provider or model's snapshot.
 */
export function recomputeProviderFastAfterAppliedModel(
  intent: unknown,
): ProviderFastClassification {
  return classifyProviderFastIntent(intent);
}
