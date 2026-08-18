/**
 * Pi OpenAI Codex subscription fast mode: the request-scoped attempt
 * correlator.
 *
 * One `createCodexFastAttempt` instance tracks exactly one provider stream
 * call. It is the only place that decides which neutral runtime state that
 * call may report, and it exists because the rules in
 * `docs/specs/fast-provider-acceleration-contract.md`
 * ("Pi Codex subscription mapping rules") are conditional on facts that
 * arrive at four different moments of a single call:
 *
 * 1. the final body's tier, after every other extension's `onPayload` ran;
 * 2. whether this wrapper's own `fetch` actually ran and wrote *both* routing
 *    parts for one outgoing attempt (rule 8, rule 11);
 * 3. what the bounded response sniffer read for that *same* attempt (rule 10);
 * 4. whether the call was aborted, timed out, or degraded before any of that
 *    could complete (rule 10, rule 12).
 *
 * Holding those facts in one small machine is what makes `applied` provable
 * rather than guessed. Nothing else in the adapter may synthesize an
 * acceleration state.
 *
 * Deliberate properties:
 *
 * - **Bounded by construction.** The only import is the sibling routing
 *   module, which itself imports nothing. There is no I/O, no timer, no
 *   clock, no global, and no reference to a payload, header bag, response,
 *   credential, URL, or model string. A public snapshot can therefore carry
 *   only enum tokens, one boolean pair, and a saturating small integer.
 * - **Monotonic and fail-closed.** Every transition can only keep or lower
 *   the reportable outcome. Out-of-order, duplicate, cross-attempt, and
 *   post-terminal input is ignored with a bounded cause; malformed input that
 *   would imply a broken wrapper invariant terminates the mapping instead of
 *   relaxing it.
 * - **Values, not exceptions.** Nothing here throws, so no caller needs a
 *   `Result` wrapper. An ignored transition is a normal, named outcome of the
 *   machine's contract, not a failure, so it is modelled the same way the
 *   sibling routing module models its verdicts: as a discriminated union.
 */

import type {
  CodexFastAllowlistRuleId,
  CodexFastEligibility,
  CodexIneligibleReason,
} from "./routing.js";
import { CODEX_INELIGIBLE_REASONS } from "./routing.js";

/**
 * The reportable states, restricted to the subset of the engine's
 * `PROVIDER_FAST_ACTIVATION_STATUSES` this mapping can reach. `declared`
 * describes a descriptor with no provider attempt, which is a fact about the
 * owner rather than about one stream call, so it is never produced here.
 */
export const CODEX_FAST_STATES = Object.freeze([
  "requested",
  "applied",
  "not-confirmed",
  "unsupported",
] as const);

export type CodexFastState = (typeof CODEX_FAST_STATES)[number];

/**
 * Bounded terminal reasons. The first group mirrors the eligibility verdicts
 * of the routing module; the rest name the ways one otherwise eligible call
 * can end below `applied`. `none` is the explicit "no failure to report"
 * token, kept as an enum member so the field never has to be nullable.
 *
 * `wrapper-degraded` is this module's own token for rule 12: a wrapper
 * invariant broke, so the mapping is abandoned for this call. It carries no
 * diagnostic, message, or stack.
 */
export const CODEX_FAST_REASONS = Object.freeze([
  "none",
  ...CODEX_INELIGIBLE_REASONS,
  "harness-seam-unavailable",
  "response-proof-unavailable",
  "attempt-uncorrelated",
  "canceled",
  "timed-out",
  "wrapper-degraded",
] as const);

export type CodexFastReason =
  | "none"
  | CodexIneligibleReason
  | "harness-seam-unavailable"
  | "response-proof-unavailable"
  | "attempt-uncorrelated"
  | "canceled"
  | "timed-out"
  | "wrapper-degraded";

/**
 * What the wrapper's `onPayload` step concluded about the final body, under
 * collision rule 6. The tier value itself never enters this module.
 */
export const CODEX_FAST_PAYLOAD_DECISIONS = Object.freeze([
  "priority-set",
  "priority-preserved",
  "collision",
] as const);

export type CodexFastPayloadDecision =
  (typeof CODEX_FAST_PAYLOAD_DECISIONS)[number];

/** The evidence kinds the normative sanitized-evidence contract allows here. */
export const CODEX_FAST_EVIDENCE_KINDS = Object.freeze([
  "none",
  "openai-service-tier",
] as const);

export type CodexFastEvidenceKind = (typeof CODEX_FAST_EVIDENCE_KINDS)[number];

/** The evidence outcomes the sniffer may report for one attempt. */
export const CODEX_FAST_EVIDENCE_OUTCOMES = Object.freeze([
  "confirmed",
  "standard",
  "absent",
  "ambiguous",
  "inaccessible",
] as const);

export type CodexFastEvidenceOutcome =
  (typeof CODEX_FAST_EVIDENCE_OUTCOMES)[number];

/** Why a transition changed nothing. Every cause is bounded and stable. */
export const CODEX_FAST_IGNORE_CAUSES = Object.freeze([
  "terminal",
  "out-of-order",
  "duplicate",
  "cross-attempt",
  "not-eligible",
  "invalid",
] as const);

export type CodexFastIgnoreCause = (typeof CODEX_FAST_IGNORE_CAUSES)[number];

/**
 * The public attempt-count ceiling. Pi's SSE retry loop is small and this
 * wrapper adds no retries of its own, so eight outgoing attempts is already
 * far past any real logical call. Beyond it the exposed count saturates and
 * `attemptsCapped` says so; correlation keeps working, because it uses an
 * internal sequence the snapshot never exposes.
 */
export const CODEX_FAST_MAX_ATTEMPTS = 8;

/**
 * The sanitized public state of one stream call.
 *
 * Every field is an enum token, a boolean, or an integer in `0 ..
 * CODEX_FAST_MAX_ATTEMPTS`. `ruleId` is the only model-adjacent value the
 * contract allows, and it is an allowlist rule id, never model text.
 */
export type CodexFastSnapshot = {
  /** The neutral runtime state. */
  readonly state: CodexFastState;
  /** Bounded reason, or `none` when there is nothing to explain. */
  readonly reason: CodexFastReason;
  /** Allowlist rule id, or `none` when no mapping was eligible. */
  readonly ruleId: CodexFastAllowlistRuleId | "none";
  /** Whether a body or header collision suppressed the mapping. */
  readonly collision: boolean;
  /** Outgoing attempts observed, saturating at `CODEX_FAST_MAX_ATTEMPTS`. */
  readonly attemptCount: number;
  /** Whether more attempts occurred than the counter can express. */
  readonly attemptsCapped: boolean;
  /** `openai-service-tier` once a request carried controls, else `none`. */
  readonly evidenceKind: CodexFastEvidenceKind;
  /** The final attempt's evidence outcome; `absent` when none was read. */
  readonly evidenceOutcome: CodexFastEvidenceOutcome;
  /** Whether this snapshot can still change. */
  readonly terminal: boolean;
};

/** A transition that changed nothing, with the bounded cause. */
export type CodexFastIgnoredTransition = {
  readonly kind: "ignored";
  readonly cause: CodexFastIgnoreCause;
};

/** The result of a transition that either lands or is ignored. */
export type CodexFastTransition =
  | { readonly kind: "accepted" }
  | CodexFastIgnoredTransition;

/**
 * The result of opening one outgoing attempt. `attempt` is an opaque
 * correlation token: the caller must hand the same value back with the
 * evidence read from that attempt's response.
 */
export type CodexFastFetchTransition =
  | { readonly kind: "opened"; readonly attempt: number }
  | CodexFastIgnoredTransition;

/** Which routing parts this wrapper wrote on the outgoing request. */
export type CodexFastHeaderParts = {
  /** `true` only when `originator` was actually written. */
  readonly originator: unknown;
  /** `true` only when `x-codex-routing-hint` was actually written. */
  readonly routingHint: unknown;
};

/**
 * One stream call's correlator. Methods are the explicit transitions; the two
 * readers are pure views.
 */
export type CodexFastAttempt = {
  /** Record the final body decision from the wrapper's `onPayload` step. */
  readonly resolvePayload: (
    decision: CodexFastPayloadDecision,
  ) => CodexFastTransition;
  /** Open one outgoing attempt, returning its correlation token. */
  readonly beginFetchAttempt: () => CodexFastFetchTransition;
  /** Record that both routing parts landed on the open attempt. */
  readonly activateHeaders: (
    parts: CodexFastHeaderParts,
  ) => CodexFastTransition;
  /** Record a preexisting routing hint this attempt did not write. */
  readonly recordHeaderCollision: () => CodexFastTransition;
  /** Record the bounded sniffer's outcome for one correlated attempt. */
  readonly recordEvidence: (
    attempt: unknown,
    outcome: CodexFastEvidenceOutcome,
  ) => CodexFastTransition;
  /** End the call as aborted. */
  readonly cancel: () => CodexFastTransition;
  /** End the call as timed out. */
  readonly timeout: () => CodexFastTransition;
  /** End the call as a fail-closed wrapper degradation (rule 12). */
  readonly degrade: () => CodexFastTransition;
  /** Freeze and return the terminal snapshot; idempotent. */
  readonly terminalize: () => CodexFastSnapshot | undefined;
  /** The current reportable snapshot, if one exists yet. */
  readonly snapshot: () => CodexFastSnapshot | undefined;
  /** The ordered reportable states this call passed through. */
  readonly history: () => readonly CodexFastState[];
};

const ACCEPTED: CodexFastTransition = Object.freeze({
  kind: "accepted",
} as const);

const IGNORED: Readonly<
  Record<CodexFastIgnoreCause, CodexFastIgnoredTransition>
> = Object.freeze({
  terminal: Object.freeze({ kind: "ignored", cause: "terminal" } as const),
  "out-of-order": Object.freeze({
    kind: "ignored",
    cause: "out-of-order",
  } as const),
  duplicate: Object.freeze({ kind: "ignored", cause: "duplicate" } as const),
  "cross-attempt": Object.freeze({
    kind: "ignored",
    cause: "cross-attempt",
  } as const),
  "not-eligible": Object.freeze({
    kind: "ignored",
    cause: "not-eligible",
  } as const),
  invalid: Object.freeze({ kind: "ignored", cause: "invalid" } as const),
});

function isPayloadDecision(value: unknown): value is CodexFastPayloadDecision {
  return (
    typeof value === "string" &&
    (CODEX_FAST_PAYLOAD_DECISIONS as readonly string[]).includes(value)
  );
}

function isEvidenceOutcome(value: unknown): value is CodexFastEvidenceOutcome {
  return (
    typeof value === "string" &&
    (CODEX_FAST_EVIDENCE_OUTCOMES as readonly string[]).includes(value)
  );
}

function isIneligibleReason(value: unknown): value is CodexIneligibleReason {
  return (
    typeof value === "string" &&
    (CODEX_INELIGIBLE_REASONS as readonly string[]).includes(value)
  );
}

/**
 * Accept an allowlist rule id only in its exact frozen shape. A caller that
 * invents one gets no mapping rather than an unbounded token in a snapshot.
 */
function isAllowlistRuleId(value: unknown): value is CodexFastAllowlistRuleId {
  return typeof value === "string" && /^codex-sub-0[1-7]$/.test(value);
}

/** One outgoing attempt's private record. */
type OutgoingAttempt = {
  readonly sequence: number;
  activated: boolean;
  evidence: CodexFastEvidenceOutcome | undefined;
};

/**
 * Create the correlator for one stream call.
 *
 * The eligibility verdict decides the machine's whole shape:
 *
 * - `no-intent` produces no acceleration state at any point. Every
 *   transition is ignored and both readers stay empty, which is what keeps a
 *   request without `fast true` byte-identical *and* silent.
 * - `ineligible` is terminal on arrival: `unsupported` with the verdict's
 *   bounded reason, so the caller can journal one honest outcome and take the
 *   native path.
 * - `eligible` starts the real machine.
 *
 * Anything else is a broken caller. Rather than trust it, the machine
 * terminates as `unsupported` / `wrapper-degraded`, which is the same
 * fail-closed answer rule 12 demands from every other doubt.
 */
export function createCodexFastAttempt(
  eligibility: CodexFastEligibility,
): CodexFastAttempt {
  const verdict: unknown = eligibility;
  const kind =
    typeof verdict === "object" && verdict !== null
      ? (verdict as { readonly kind?: unknown }).kind
      : undefined;

  const noIntent = kind === "no-intent";

  let ruleId: CodexFastAllowlistRuleId | "none" = "none";
  let terminalSnapshot: CodexFastSnapshot | undefined;
  let payloadResolved = false;
  let collision = false;
  let requestedReached = false;
  let sawUncorrelatedEvidence = false;
  let sequence = 0;
  let attemptCount = 0;
  let attemptsCapped = false;
  let current: OutgoingAttempt | undefined;
  const states: CodexFastState[] = [];

  function build(
    state: CodexFastState,
    reason: CodexFastReason,
    evidenceOutcome: CodexFastEvidenceOutcome,
    terminal: boolean,
  ): CodexFastSnapshot {
    return Object.freeze({
      state,
      reason,
      ruleId,
      collision,
      attemptCount,
      attemptsCapped,
      evidenceKind: requestedReached ? "openai-service-tier" : "none",
      evidenceOutcome,
      terminal,
    } as const);
  }

  function record(state: CodexFastState): void {
    if (states.length >= CODEX_FAST_STATES.length) {
      return;
    }
    if (states[states.length - 1] === state) {
      return;
    }
    states.push(state);
  }

  /**
   * End the call below `applied` with a bounded reason. `requested` was
   * either reached, in which case a real fast request went out and the honest
   * cap is `not-confirmed`, or it was not, in which case no valid fast
   * request exists and the state is `unsupported`.
   */
  function endWith(reason: CodexFastReason): CodexFastSnapshot {
    const state: CodexFastState = requestedReached
      ? "not-confirmed"
      : "unsupported";
    const snapshot = build(state, reason, current?.evidence ?? "absent", true);
    terminalSnapshot = snapshot;
    record(state);
    return snapshot;
  }

  if (noIntent) {
    // Nothing to correlate and nothing to report, ever.
  } else if (kind === "eligible") {
    const declared = (verdict as { readonly ruleId?: unknown }).ruleId;
    if (isAllowlistRuleId(declared)) {
      ruleId = declared;
    } else {
      endWith("wrapper-degraded");
    }
  } else if (kind === "ineligible") {
    const reason = (verdict as { readonly reason?: unknown }).reason;
    if (isIneligibleReason(reason)) {
      collision = reason === "request-collision";
      endWith(reason);
    } else {
      endWith("wrapper-degraded");
    }
  } else {
    endWith("wrapper-degraded");
  }

  /** The gate every transition shares: silent, terminal, or open. */
  function blocked(): CodexFastIgnoredTransition | undefined {
    if (noIntent) {
      return IGNORED["not-eligible"];
    }
    if (terminalSnapshot !== undefined) {
      return IGNORED.terminal;
    }
    return undefined;
  }

  function resolvePayload(
    decision: CodexFastPayloadDecision,
  ): CodexFastTransition {
    const gate = blocked();
    if (gate !== undefined) {
      return gate;
    }
    if (payloadResolved) {
      return IGNORED.duplicate;
    }
    if (!isPayloadDecision(decision)) {
      endWith("wrapper-degraded");
      return IGNORED.invalid;
    }
    if (decision === "collision") {
      collision = true;
      endWith("request-collision");
      return ACCEPTED;
    }
    payloadResolved = true;
    return ACCEPTED;
  }

  function beginFetchAttempt(): CodexFastFetchTransition {
    const gate = blocked();
    if (gate !== undefined) {
      return gate;
    }
    if (!payloadResolved) {
      return IGNORED["out-of-order"];
    }
    sequence += 1;
    if (attemptCount < CODEX_FAST_MAX_ATTEMPTS) {
      attemptCount += 1;
    } else {
      attemptsCapped = true;
    }
    // A retry is a new correlation scope: the previous attempt's evidence can
    // no longer describe what goes on the wire, so only the final attempt's
    // own evidence may terminalize this call (rule 10).
    current = { sequence, activated: false, evidence: undefined };
    return Object.freeze({ kind: "opened", attempt: sequence } as const);
  }

  function activateHeaders(parts: CodexFastHeaderParts): CodexFastTransition {
    const gate = blocked();
    if (gate !== undefined) {
      return gate;
    }
    if (!payloadResolved || current === undefined) {
      return IGNORED["out-of-order"];
    }
    if (current.activated) {
      return IGNORED.duplicate;
    }
    const both =
      typeof parts === "object" &&
      parts !== null &&
      parts.originator === true &&
      parts.routingHint === true;
    if (!both) {
      // Rule 8 is both parts or neither. A partial write means the wrapper
      // broke its own invariant, so the mapping is abandoned rather than
      // reported as a request.
      endWith("wrapper-degraded");
      return IGNORED.invalid;
    }
    current.activated = true;
    requestedReached = true;
    record("requested");
    return ACCEPTED;
  }

  function recordHeaderCollision(): CodexFastTransition {
    const gate = blocked();
    if (gate !== undefined) {
      return gate;
    }
    collision = true;
    endWith("request-collision");
    return ACCEPTED;
  }

  function recordEvidence(
    attempt: unknown,
    outcome: CodexFastEvidenceOutcome,
  ): CodexFastTransition {
    const gate = blocked();
    if (gate !== undefined) {
      return gate;
    }
    if (current === undefined) {
      return IGNORED["out-of-order"];
    }
    if (attempt !== current.sequence) {
      // Late evidence from a superseded attempt, or an invented token. It can
      // never describe the request that is on the wire now.
      sawUncorrelatedEvidence = true;
      return IGNORED["cross-attempt"];
    }
    if (!current.activated) {
      return IGNORED["out-of-order"];
    }
    if (current.evidence !== undefined) {
      return IGNORED.duplicate;
    }
    if (!isEvidenceOutcome(outcome)) {
      return IGNORED.invalid;
    }
    current.evidence = outcome;
    return ACCEPTED;
  }

  function end(reason: CodexFastReason): CodexFastTransition {
    const gate = blocked();
    if (gate !== undefined) {
      return gate;
    }
    endWith(reason);
    return ACCEPTED;
  }

  function terminalize(): CodexFastSnapshot | undefined {
    if (noIntent) {
      return undefined;
    }
    if (terminalSnapshot !== undefined) {
      return terminalSnapshot;
    }
    if (!requestedReached) {
      // The wrapper's own fetch never wrote both parts for any attempt, so no
      // valid fast request exists for this call.
      return endWith("harness-seam-unavailable");
    }
    if (current === undefined || !current.activated) {
      const snapshot = build(
        "not-confirmed",
        "attempt-uncorrelated",
        "absent",
        true,
      );
      terminalSnapshot = snapshot;
      record("not-confirmed");
      return snapshot;
    }
    const evidence = current.evidence;
    if (evidence === "confirmed") {
      const snapshot = build("applied", "none", "confirmed", true);
      terminalSnapshot = snapshot;
      record("applied");
      return snapshot;
    }
    if (evidence === "standard") {
      const snapshot = build("not-confirmed", "none", "standard", true);
      terminalSnapshot = snapshot;
      record("not-confirmed");
      return snapshot;
    }
    if (evidence !== undefined) {
      const snapshot = build(
        "not-confirmed",
        "response-proof-unavailable",
        evidence,
        true,
      );
      terminalSnapshot = snapshot;
      record("not-confirmed");
      return snapshot;
    }
    const snapshot = build(
      "not-confirmed",
      sawUncorrelatedEvidence
        ? "attempt-uncorrelated"
        : "response-proof-unavailable",
      "absent",
      true,
    );
    terminalSnapshot = snapshot;
    record("not-confirmed");
    return snapshot;
  }

  /**
   * The live view. Before both parts land there is nothing truthful to
   * report, and `applied` is withheld until `terminalize`, because an attempt
   * that is still open can still be canceled.
   */
  function snapshot(): CodexFastSnapshot | undefined {
    if (terminalSnapshot !== undefined) {
      return terminalSnapshot;
    }
    if (!requestedReached) {
      return undefined;
    }
    return build("requested", "none", current?.evidence ?? "absent", false);
  }

  return Object.freeze({
    resolvePayload,
    beginFetchAttempt,
    activateHeaders,
    recordHeaderCollision,
    recordEvidence,
    cancel: () => end("canceled"),
    timeout: () => end("timed-out"),
    degrade: () => end("wrapper-degraded"),
    terminalize,
    snapshot,
    history: () => Object.freeze([...states]),
  } as const);
}
