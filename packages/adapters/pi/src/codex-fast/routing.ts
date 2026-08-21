/**
 * Pi OpenAI Codex subscription fast mode: routing resolution and eligibility.
 *
 * This module is the pure core of the mapping normative in
 * `docs/specs/fast-provider-acceleration-contract.md`
 * ("OpenAI Codex subscription fast mode (ChatGPT backend)"). It answers two
 * questions and nothing else:
 *
 * 1. Given the final body's model id and tier, which routing parts may this
 *    attempt carry? (`resolveCodexFastRouting`)
 * 2. Given already-extracted scalars about one stream call, is that call
 *    eligible for the mapping at all? (`classifyCodexFastEligibility`)
 *
 * Deliberate properties:
 *
 * - **No dependencies.** The file declares no module specifier of any kind,
 *   so no harness, engine, runtime, or provider code can reach it. That keeps
 *   it trivially testable and impossible to couple to a Pi version.
 * - **Scalars in, tokens out.** Callers extract the scalars themselves. The
 *   raw credential, account id, request payload, response, and header bag
 *   never enter this module, so they can never leave it. A verdict carries an
 *   allowlist rule id or a bounded reason token, never model text or a URL.
 * - **Fail closed.** Every unknown, malformed, or hostile value produces a
 *   verdict that suppresses the mapping. Nothing here throws, so no caller
 *   needs a `Result` wrapper around it.
 */

/** Provider id of the wrapped Codex provider. No other provider is mapped. */
export const CODEX_PROVIDER_ID = "openai-codex";

/** Header name carrying the request originator. */
export const CODEX_ORIGINATOR_HEADER = "originator";

/** Originator value the Codex subscription fast contract requires. */
export const CODEX_FAST_ORIGINATOR = "codex_cli_rs";

/** Header name carrying the routing hint. */
export const CODEX_ROUTING_HINT_HEADER = "x-codex-routing-hint";

/**
 * The only effective transport this mapping accepts, compared as a whole
 * string. Absence is also accepted; anything else is a gateway or proxy.
 */
export const CODEX_FIRST_PARTY_BASE_URL = "https://chatgpt.com/backend-api";

/** Body value the contract requires before either header may be written. */
export const CODEX_PRIORITY_SERVICE_TIER = "priority";

/** Frozen allowlist revision recorded in the spec. */
export const CODEX_FAST_ALLOWLIST_REVISION = "codex-sub-r1";

/**
 * The model id character rule. The id is embedded in a header value, so it
 * must not be able to carry CR, LF, the `;` separator, whitespace, Unicode,
 * or unbounded length. Kept as a source string because a live `RegExp` is
 * mutable state a caller could disturb.
 */
export const CODEX_SAFE_MODEL_ID_PATTERN_SOURCE = "^[A-Za-z0-9._-]{1,64}$";

/** Allowlist rule ids frozen by revision `codex-sub-r1`. */
export type CodexFastAllowlistRuleId =
  | "codex-sub-01"
  | "codex-sub-02"
  | "codex-sub-03"
  | "codex-sub-04"
  | "codex-sub-05"
  | "codex-sub-06"
  | "codex-sub-07";

export type CodexFastAllowlistEntry = {
  /** Exact provider model id from the pinned host catalog. */
  readonly modelId: string;
  /** The only model-adjacent token evidence may name. */
  readonly ruleId: CodexFastAllowlistRuleId;
};

/**
 * Allowlist revision `codex-sub-r1`: the complete `openai-codex` catalog of
 * the pinned host (Pi 0.84.2), in spec order. A newer host catalog does not
 * widen this list; adding an entry requires re-freezing the spec table and
 * bumping the revision.
 */
export const CODEX_FAST_MODEL_ALLOWLIST: readonly CodexFastAllowlistEntry[] =
  Object.freeze([
    Object.freeze({
      modelId: "gpt-5.3-codex-spark",
      ruleId: "codex-sub-01",
    } as const),
    Object.freeze({ modelId: "gpt-5.4", ruleId: "codex-sub-02" } as const),
    Object.freeze({ modelId: "gpt-5.4-mini", ruleId: "codex-sub-03" } as const),
    Object.freeze({ modelId: "gpt-5.5", ruleId: "codex-sub-04" } as const),
    Object.freeze({ modelId: "gpt-5.6-luna", ruleId: "codex-sub-05" } as const),
    Object.freeze({ modelId: "gpt-5.6-sol", ruleId: "codex-sub-06" } as const),
    Object.freeze({
      modelId: "gpt-5.6-terra",
      ruleId: "codex-sub-07",
    } as const),
  ] as const);

/**
 * Bounded ineligibility reasons, ordered exactly as the spec's eligibility
 * and collision rules are evaluated.
 */
export const CODEX_INELIGIBLE_REASONS = Object.freeze([
  "provider-not-codex",
  "model-id-unsafe",
  "model-not-allowed",
  "model-owner-mismatch",
  "transport-not-first-party",
  "auth-not-subscription",
  "request-collision",
] as const);

export type CodexIneligibleReason = (typeof CODEX_INELIGIBLE_REASONS)[number];

/**
 * A primitive string parser for values arriving at the pure routing boundary.
 * Boxed strings and objects with a custom `toString` never enter the matcher.
 */
function isStringInput<T>(value: T): value is T & string {
  return (
    Object(value) !== value &&
    Object.prototype.toString.call(value) === "[object String]"
  );
}

/**
 * Test one model id against the header-safety rule. A non-string is unsafe.
 * A fresh `RegExp` per call keeps this free of shared matcher state.
 */
export function isSafeCodexModelId<TModelId>(
  modelId: TModelId,
): modelId is TModelId & string {
  if (!isStringInput(modelId)) {
    return false;
  }
  return new RegExp(CODEX_SAFE_MODEL_ID_PATTERN_SOURCE).test(modelId);
}

/** Find the allowlist entry for an exact model id, or `undefined`. */
export function findCodexFastAllowlistEntry<TModelId>(
  modelId: TModelId,
): CodexFastAllowlistEntry | undefined {
  if (!isStringInput(modelId)) {
    return undefined;
  }
  return CODEX_FAST_MODEL_ALLOWLIST.find((entry) => entry.modelId === modelId);
}

/** Scalars read from the final request body plus the owner's fast intent. */
export type CodexFastRoutingInput = {
  /** `model` from the same final body the tier was read from. */
  readonly modelId: unknown;
  /** The active owner's neutral fast intent. Only literal `true` counts. */
  readonly fast: unknown;
  /** `service_tier` from the final body, after every other extension ran. */
  readonly serviceTier: unknown;
};

/** Both routing parts, or neither. Nothing in between exists. */
export type CodexFastRouting =
  | { readonly kind: "none" }
  | {
      readonly kind: "routing";
      readonly originatorHeader: typeof CODEX_ORIGINATOR_HEADER;
      readonly originator: typeof CODEX_FAST_ORIGINATOR;
      readonly routingHintHeader: typeof CODEX_ROUTING_HINT_HEADER;
      readonly routingHint: string;
    };

const NO_ROUTING: CodexFastRouting = Object.freeze({ kind: "none" } as const);

/**
 * Resolve the two-part routing contract for one attempt.
 *
 * Both parts are emitted only when fast intent held, the same attempt's final
 * body resolved to `service_tier: "priority"`, and the model id can safely
 * enter a header value. Every other input emits neither part, which is what
 * keeps a fast-off or ineligible attempt byte-identical and keeps a stale
 * routing hint from surviving into a later request.
 *
 * Allowlist membership is not rechecked here: it is an eligibility rule, and
 * a caller reaches this function only after `classifyCodexFastEligibility`
 * returned `eligible`. The hint therefore echoes the model id the caller
 * passed, which is the whole point of the header.
 */
export function resolveCodexFastRouting(
  input: CodexFastRoutingInput,
): CodexFastRouting {
  if (input.fast !== true) {
    return NO_ROUTING;
  }
  if (input.serviceTier !== CODEX_PRIORITY_SERVICE_TIER) {
    return NO_ROUTING;
  }
  if (!isSafeCodexModelId(input.modelId)) {
    return NO_ROUTING;
  }
  return Object.freeze({
    kind: "routing",
    originatorHeader: CODEX_ORIGINATOR_HEADER,
    originator: CODEX_FAST_ORIGINATOR,
    routingHintHeader: CODEX_ROUTING_HINT_HEADER,
    routingHint: `model=${input.modelId};tier=${CODEX_PRIORITY_SERVICE_TIER}`,
  } as const);
}

/**
 * Already-extracted scalars describing one stream call. The caller reads each
 * value from the request it holds; no raw credential, payload, response, or
 * header bag is ever passed.
 */
export type CodexFastEligibilityInput = {
  /** Provider id the request reached. Must be exactly `openai-codex`. */
  readonly providerId: unknown;
  /** The process-local active owner's fast intent. Only `true` counts. */
  readonly fast: unknown;
  /** `requestModel.id` of the held request. */
  readonly modelId: unknown;
  /** The active owner's resolved model id. */
  readonly ownerModelId: unknown;
  /** Effective post-auth `requestModel.baseUrl`; absent is authorized. */
  readonly baseUrl: unknown;
  /**
   * `true` only when the resolved credential already parsed as a ChatGPT
   * subscription token carrying an account claim. The token and the account
   * id itself must never be passed.
   */
  readonly subscriptionAuthProven: unknown;
  /**
   * `true` when a body or header collision was already observed for this
   * attempt. Anything other than `false` or absence fails closed.
   */
  readonly collisionObserved: unknown;
};

/**
 * The verdict. `no-intent` emits no acceleration state at all; `ineligible`
 * emits a bounded reason; `eligible` names only the allowlist rule id.
 */
export type CodexFastEligibility =
  | { readonly kind: "no-intent" }
  | { readonly kind: "eligible"; readonly ruleId: CodexFastAllowlistRuleId }
  | { readonly kind: "ineligible"; readonly reason: CodexIneligibleReason };

const NO_INTENT: CodexFastEligibility = Object.freeze({
  kind: "no-intent",
} as const);

function ineligible(reason: CodexIneligibleReason): CodexFastEligibility {
  return Object.freeze({ kind: "ineligible", reason } as const);
}

/** Absence is the spec-authorized alternative to the exact first-party URL. */
function isFirstPartyTransport<TBaseUrl>(baseUrl: TBaseUrl): boolean {
  if (baseUrl === undefined || baseUrl === null) {
    return true;
  }
  return baseUrl === CODEX_FIRST_PARTY_BASE_URL;
}

/**
 * Classify one stream call against the normative eligibility and collision
 * rules, in spec order: provider identity, intent, model, transport, auth,
 * collision. The first failing rule wins, and every failure forces native
 * passthrough at the call site.
 */
export function classifyCodexFastEligibility(
  input: CodexFastEligibilityInput,
): CodexFastEligibility {
  if (input.providerId !== CODEX_PROVIDER_ID) {
    return ineligible("provider-not-codex");
  }
  if (input.fast !== true) {
    return NO_INTENT;
  }
  if (!isSafeCodexModelId(input.modelId)) {
    return ineligible("model-id-unsafe");
  }
  const entry = findCodexFastAllowlistEntry(input.modelId);
  if (entry === undefined) {
    return ineligible("model-not-allowed");
  }
  if (input.ownerModelId !== input.modelId) {
    return ineligible("model-owner-mismatch");
  }
  if (!isFirstPartyTransport(input.baseUrl)) {
    return ineligible("transport-not-first-party");
  }
  if (input.subscriptionAuthProven !== true) {
    return ineligible("auth-not-subscription");
  }
  if (
    input.collisionObserved !== false &&
    input.collisionObserved !== undefined
  ) {
    return ineligible("request-collision");
  }
  return Object.freeze({ kind: "eligible", ruleId: entry.ruleId } as const);
}
