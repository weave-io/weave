import { Result } from "neverthrow";

/**
 * Pi provider-fast intent classification.
 *
 * `fast true` is neutral intent. Reporting it as `requested` or `applied`
 * needs two proofs bound to the *same* prepared provider request: the exact
 * transport that request will use, and the provider's own documented
 * response field for that same attempt. Pi's public extension contract
 * supplies neither.
 *
 * - `ctx.modelRegistry.getProviderAuth()` performs a fresh auth resolution.
 *   It describes what a *new* resolution would return, not the transport the
 *   request a hook already holds was prepared with, so it cannot bind a
 *   first-party transport proof to that request.
 * - No public hook exposes the provider response body or the streamed usage
 *   event, so no attempt can ever gain positive application evidence.
 *
 * Sending acceleration controls without those proofs would mean guessing.
 * The adapter therefore mutates no provider payload and no provider header,
 * and reports one bounded terminal `unsupported` outcome instead.
 *
 * This module is pure and stateless. There is no attempt tracker, no
 * correlation token, and no request mutation, because there is no attempt.
 */

/**
 * Bounded reason codes this adapter may report. `harness-seam-unavailable`
 * names the proven Pi host gap: no documented seam binds an effective
 * transport, or a response proof, to one prepared request.
 */
export const PROVIDER_FAST_UNSUPPORTED_REASONS = [
  "harness-seam-unavailable",
] as const;

export type ProviderFastUnsupportedReason =
  (typeof PROVIDER_FAST_UNSUPPORTED_REASONS)[number];

export const PROVIDER_FAST_UNSUPPORTED_REASON: ProviderFastUnsupportedReason =
  "harness-seam-unavailable";

/**
 * The only neutral runtime state this adapter can reach. `declared`,
 * `requested`, and `not-confirmed` all describe an attempt that carried
 * controls; this adapter never creates one.
 */
export const PROVIDER_FAST_STATES = ["unsupported"] as const;

export type ProviderFastState = (typeof PROVIDER_FAST_STATES)[number];

/** Evidence kinds allowed by the normative sanitized-evidence contract. */
export const PROVIDER_FAST_EVIDENCE_KINDS = [
  "none",
  "openai-service-tier",
  "anthropic-usage-speed",
] as const;

export type ProviderFastEvidenceKind =
  (typeof PROVIDER_FAST_EVIDENCE_KINDS)[number];

/** Evidence outcomes allowed by the normative sanitized-evidence contract. */
export const PROVIDER_FAST_EVIDENCE_OUTCOMES = [
  "confirmed",
  "standard",
  "absent",
  "ambiguous",
  "inaccessible",
] as const;

export type ProviderFastEvidenceOutcome =
  (typeof PROVIDER_FAST_EVIDENCE_OUTCOMES)[number];

/**
 * The sanitized public state the adapter may report and persist. It carries
 * enum tokens only: no provider string, model text, payload, header, URL, or
 * response data can enter it.
 */
export type ProviderFastPublicSnapshot = {
  readonly state: ProviderFastState;
  readonly evidenceKind: ProviderFastEvidenceKind;
  readonly evidenceOutcome: ProviderFastEvidenceOutcome;
  readonly reason: ProviderFastUnsupportedReason;
};

/**
 * The single terminal outcome. No request carried a control, so no evidence
 * of any kind could exist for it: the evidence kind is `none` and the
 * outcome is `absent`.
 */
export const PROVIDER_FAST_UNSUPPORTED_SNAPSHOT: ProviderFastPublicSnapshot =
  Object.freeze({
    state: "unsupported",
    evidenceKind: "none",
    evidenceOutcome: "absent",
    reason: PROVIDER_FAST_UNSUPPORTED_REASON,
  });

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
 * Classify one owner's neutral fast intent.
 *
 * Omission is no intent and emits no acceleration state at all. Exact
 * `fast true` is intent Pi cannot carry, so it classifies as terminal
 * `unsupported`. Provider, endpoint, model, and transport are not inspected
 * because none of them can change this outcome on this host.
 */
export function classifyProviderFastIntent(
  intent: unknown,
): ProviderFastClassification {
  return readOwnFastIntent(intent).unwrapOr(false) ? UNSUPPORTED : NO_INTENT;
}
