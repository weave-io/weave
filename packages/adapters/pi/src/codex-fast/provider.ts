/**
 * Pi OpenAI Codex subscription fast mode: the wrapped provider.
 *
 * This is the seam the whole mapping exists for. Pi's hook surface cannot own
 * the `originator` header and cannot see the final body, so
 * `docs/specs/fast-provider-acceleration-contract.md` authorizes one
 * Weave-registered override of the native `openai-codex` provider instead.
 * The override is identical to the native provider in every respect except
 * `stream` and `streamSimple`, and even those delegate to the native
 * implementation; the wrapper only decides what options that implementation
 * receives.
 *
 * Per stream call there are exactly two shapes:
 *
 * - **Passthrough.** No fast intent, or any eligibility rule failing before a
 *   single byte was touched, delegates with the caller's own options object,
 *   by reference. Nothing is added, removed, forced, or observed, so such a
 *   request is indistinguishable from one this wrapper never saw.
 * - **Mapped.** An eligible call delegates with three request-scoped
 *   injections and nothing else: an `onPayload` chain that runs the caller's
 *   hook first and only then applies the tier under collision rule 6;
 *   `transport: "sse"`, because the SSE path is the only one exposing a
 *   request seam; and a `fetch` wrapper that owns the two routing headers for
 *   one attempt and reads that same attempt's bounded response evidence.
 *
 * A mapped call stays provisional until that payload step runs, because rule
 * 6 can only be decided on the final body. The pinned host reads
 * `options.transport` and `options.fetch` strictly *after* it awaits
 * `options.onPayload`, so a collision found there is still early enough to
 * undo: the wrapper puts all three injected fields back to the caller's own
 * values, and the call then behaves exactly like passthrough — native
 * transport, native fetch, native hook, untouched body. This is the third
 * shape, and the reason a body collision is not a partially mapped request.
 *
 * The restoration has to reach the object the host will actually read.
 * `streamSimple` copies the fields it cares about out of the options this
 * wrapper prepared into a fresh object and hands *that* to `stream`, so the
 * prepared object alone is not enough. The host invokes the hook as
 * `options.onPayload(...)`, which makes that derived object the hook's
 * receiver, so the chain restores its own `this` as well. Both targets are
 * identified by the identity of this call's own `fetch` wrapper, so no
 * foreign object is ever rewritten.
 *
 * Choosing between them is a decision made *before* the body is touched. The
 * host merges its request headers from two caller-held sources — the request
 * model's headers and the options headers — and both are in hand at the entry
 * point, so rule 7's preexisting-hint check is a preflight: a hint already
 * present there makes the call ineligible, and it takes the passthrough shape
 * with the caller's own options object. This ordering is what makes rule 8
 * ("both parts or neither") hold as a property of the wire rather than of the
 * wrapper's intentions: by the time any fetch runs, the body this wrapper
 * mutated has already been serialized, and possibly zstd-compressed, so a
 * collision discovered only then can no longer be undone. Such an attempt is
 * not sent at all — the serialized body is never decoded, rewritten, or
 * guessed at, and a partial fast request never reaches the network.
 *
 * Deliberate properties:
 *
 * - **Fail closed, always toward native.** Every step that could throw runs
 *   inside a `Result` boundary whose failure branch restores native behavior
 *   and records a bounded degradation. The wrapper never guesses a header and
 *   never converts its own trouble into the caller's trouble. The single
 *   exception is the one case where no native behavior is left to restore: a
 *   body this wrapper already mutated, whose routing pair can no longer be
 *   written. Not sending is then the only fail-closed answer available.
 * - **Native semantics are preserved, not improved.** A failure that the
 *   native path would have raised — a caller `onPayload` that throws, a fetch
 *   that rejects — still propagates unchanged. The wrapper only notes it.
 * - **Nothing is cached.** Intent is read per call; header authority is
 *   decided per attempt; the only state that survives a call is what the
 *   caller's sink chose to keep.
 */

import { Result, ResultAsync } from "neverthrow";
import type {
  CodexFastAttempt,
  CodexFastEvidenceOutcome,
  CodexFastPayloadDecision,
  CodexFastSnapshot,
} from "./attempt.js";
import { createCodexFastAttempt } from "./attempt.js";
import { createCodexServiceTierSniffer } from "./evidence-sniffer.js";
import type { CodexFastEligibility } from "./routing.js";
import {
  CODEX_ORIGINATOR_HEADER,
  CODEX_PRIORITY_SERVICE_TIER,
  CODEX_ROUTING_HINT_HEADER,
  classifyCodexFastEligibility,
  resolveCodexFastRouting,
} from "./routing.js";

/** The JWT claim namespace a ChatGPT subscription credential carries. */
const CODEX_JWT_CLAIM_PATH = "https://api.openai.com/auth";

/** Nothing longer than this is treated as a credential worth decoding. */
const MAX_CREDENTIAL_LENGTH = 16_384;

/** The body field the mapping owns. */
const SERVICE_TIER_FIELD = "service_tier";

/** The body field the routing hint must echo. */
const MODEL_FIELD = "model";

/** The transport the mapping forces, because it is the only provable one. */
const FORCED_TRANSPORT = "sse";

/**
 * The only option fields a mapped call replaces. Every other field the caller
 * set is copied through by value and never rewritten.
 */
const INJECTED_OPTION_KEYS = ["onPayload", "transport", "fetch"] as const;

type InjectedOptionKey = (typeof INJECTED_OPTION_KEYS)[number];

/** What one injected field held before this wrapper replaced it. */
type NativeOptionField = {
  readonly key: InjectedOptionKey;
  /** Whether the caller's options carried the field at all. */
  readonly present: boolean;
  /** The caller's own value, or `undefined` when the field was absent. */
  readonly value: unknown;
};

/**
 * The message of the only error this wrapper ever originates.
 *
 * It is thrown exactly when an attempt would otherwise put a body this
 * wrapper set to `service_tier: "priority"` on the wire without the routing
 * pair rule 8 requires. The text is static and bounded: it names no header,
 * model, url, payload, credential, or any other caller value.
 */
export const CODEX_FAST_BLOCKED_REQUEST_MESSAGE =
  "weave codex fast mode: blocked an outgoing request whose priority body could not carry the required routing headers";

/** Build that one error. Nothing about the request enters it. */
function blockedRequestError(): Error {
  const error = new Error(CODEX_FAST_BLOCKED_REQUEST_MESSAGE);
  error.name = "CodexFastBlockedRequestError";
  return error;
}

/**
 * The fast intent of the process-local active owner, read fresh for every
 * stream call. A port rather than a value, because a cached snapshot could
 * outlive the generation that declared it.
 */
export type CodexFastIntent = {
  /** Only the literal `true` counts as intent. */
  readonly fast: unknown;
  /** The owner's resolved model id, which the request model must equal. */
  readonly modelId: unknown;
};

export type CodexFastIntentPort = {
  /** Returns the current owner's intent, or `undefined` when none holds. */
  readonly readIntent: () => CodexFastIntent | undefined;
};

/**
 * Where sanitized states go. The wrapper reports every meaningful transition,
 * so the last snapshot a call produces is its most truthful one. Non-terminal
 * `requested` is a legitimate final report: it means a fast request went out
 * and no proof came back.
 */
export type CodexFastAttemptSink = {
  readonly record: (snapshot: CodexFastSnapshot) => void;
};

/** The minimum a provider must expose for this wrapper to override it. */
export type CodexWrappableProvider = {
  readonly id: string;
  /**
   * The native signatures are generic over the provider's api union, so the
   * constraint has to be the loosest callable shape. `never[]` parameters
   * accept any concrete signature without widening anything to `any`, and
   * the wrapper only ever calls these with the caller's own arguments.
   */
  stream: (...args: never[]) => unknown;
  streamSimple: (...args: never[]) => unknown;
};

/** The only way wrapping itself can fail. */
export type CodexFastWrapError = {
  readonly kind: "provider-not-wrappable";
};

type NativeStreamCall = (
  model: unknown,
  context: unknown,
  options?: unknown,
) => unknown;

type FetchLike = (input: unknown, init?: unknown) => Promise<Response>;

/** JSON-shaped record test, used only on values this module parsed itself. */
function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray(value) === false
  );
}

/**
 * The strict plain-object test collision rule 6 requires. A class instance, an
 * array, a `null`-returning exotic object, or anything with a foreign
 * prototype is not a payload this wrapper will touch.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** Read one property of an unknown value without assuming it is safe. */
function readUnknownProperty(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null) {
    return undefined;
  }
  return (source as Record<string, unknown>)[key];
}

/**
 * Reproduce the host's own header merge and report whether the outgoing
 * request would already carry a routing hint this wrapper did not write.
 *
 * The pinned codex api builds its request headers from `requestModel.headers`
 * first and then `options.headers`, where a `null` value deletes the name and
 * anything else sets it. Both sources are caller-held values the wrapper has
 * before it touches the body, which is what turns rule 7's collision check
 * into a preflight instead of a discovery made after serialization. `Headers`
 * does the lookup precisely because its names are case insensitive, so a hint
 * spelled in any casing still collides.
 *
 * Only names decide the answer. A caller header value is compared against the
 * `null` delete sentinel and nothing else: none is stringified, copied,
 * stored, or logged. Hostile accessors are the caller's own trouble — this
 * runs inside the classification boundary, whose failure branch is native
 * passthrough.
 */
function hasPreexistingRoutingHint(model: unknown, options: unknown): boolean {
  const headers = new Headers(
    readUnknownProperty(model, "headers") as HeadersInit | undefined,
  );
  const additional = readUnknownProperty(options, "headers");
  if (additional instanceof Headers) {
    // The pinned host merges this source with `Object.entries`, which sees
    // nothing on a `Headers` instance, so a hint held this way would not
    // reach the wire today. It counts anyway: over-detecting costs one
    // unmapped call, while under-detecting costs a blocked one.
    return (
      headers.has(CODEX_ROUTING_HINT_HEADER) ||
      additional.has(CODEX_ROUTING_HINT_HEADER)
    );
  }
  if (typeof additional === "object" && additional !== null) {
    for (const [name, value] of Object.entries(
      additional as Record<string, unknown>,
    )) {
      if (value === null) {
        headers.delete(name);
        continue;
      }
      headers.set(name, "");
    }
  }
  return headers.has(CODEX_ROUTING_HINT_HEADER);
}

/**
 * Decide whether the resolved credential is a ChatGPT subscription token that
 * carries an account claim, mirroring what the host's own codex OAuth code
 * checks. Only the boolean leaves this function: neither the token nor the
 * account id is returned, stored, or logged.
 */
export function hasCodexSubscriptionAccountClaim(apiKey: unknown): boolean {
  if (typeof apiKey !== "string") {
    return false;
  }
  if (apiKey.length === 0 || apiKey.length > MAX_CREDENTIAL_LENGTH) {
    return false;
  }
  const parts = apiKey.split(".");
  if (parts.length !== 3) {
    return false;
  }
  const segment = parts[1] ?? "";
  if (segment.length === 0) {
    return false;
  }
  const decoded = Result.fromThrowable(
    () => {
      const normalized = segment.replaceAll("-", "+").replaceAll("_", "/");
      const padding = (4 - (normalized.length % 4)) % 4;
      return JSON.parse(atob(normalized + "=".repeat(padding))) as unknown;
    },
    () => undefined,
  )();
  if (decoded.isErr()) {
    return false;
  }
  const claims = decoded.value;
  if (!isJsonRecord(claims)) {
    return false;
  }
  const auth = claims[CODEX_JWT_CLAIM_PATH];
  if (!isJsonRecord(auth)) {
    return false;
  }
  const accountId = auth.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0;
}

/**
 * Record what the caller's own options held at each field this wrapper is
 * about to replace, reading the already-copied values by descriptor so a
 * caller accessor is not invoked a second time.
 */
function captureNativeOptionFields(
  source: Record<string, unknown>,
): readonly NativeOptionField[] {
  return INJECTED_OPTION_KEYS.map((key): NativeOptionField => {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return { key, present: false, value: undefined };
    }
    return { key, present: true, value: descriptor.value as unknown };
  });
}

/** Read one captured field without assuming the array's order. */
function nativeFieldValue(
  fields: readonly NativeOptionField[],
  key: InjectedOptionKey,
): unknown {
  return fields.find((field) => field.key === key)?.value;
}

/**
 * Put one options view back to what the native path would have seen.
 *
 * The guard is identity, not shape: only an object that still carries *this*
 * call's own `fetch` wrapper is rewritten, and that check reads a descriptor
 * rather than the property, so nothing foreign and nothing trapped is
 * touched. A field the caller never had is deleted rather than set to
 * `undefined`, because the host reads both the same way and deleting is the
 * one that leaves no trace of this wrapper behind.
 */
function restoreNativeOptionFields(
  target: unknown,
  wrapperFetch: FetchLike,
  fields: readonly NativeOptionField[],
): void {
  if (typeof target !== "object" || target === null) {
    return;
  }
  const installed = Object.getOwnPropertyDescriptor(target, "fetch");
  if (
    installed === undefined ||
    !("value" in installed) ||
    installed.value !== wrapperFetch
  ) {
    return;
  }
  for (const field of fields) {
    if (field.present) {
      Object.defineProperty(target, field.key, {
        value: field.value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      continue;
    }
    Reflect.deleteProperty(target, field.key);
  }
}

/**
 * A verdict shape the attempt machine cannot recognize, which is exactly how
 * rule 12 is expressed: a broken wrapper invariant terminates as `unsupported`
 * / `wrapper-degraded` instead of relaxing into a guess.
 */
const DEGRADED_VERDICT = Object.freeze({
  kind: "wrapper-degraded",
} as const) as unknown as CodexFastEligibility;

/** One stream call's mutable, request-scoped facts. */
type CallState = {
  /** The final body's model id, once the payload step proved it. */
  finalModelId: string | undefined;
  /** Whether that same body ended at `service_tier: "priority"`. */
  tierProven: boolean;
  /**
   * Whether *this wrapper* wrote that tier, as opposed to preserving one the
   * caller had already set. Only the former is unrollbackable damage: a tier
   * the caller owns is what the native path would have sent anyway.
   */
  tierWritten: boolean;
};

export function wrapCodexProviderForFast<T extends CodexWrappableProvider>(
  native: T,
  intentPort: CodexFastIntentPort,
  attemptSink: CodexFastAttemptSink,
): Result<T, CodexFastWrapError> {
  const nativeStream = native.stream as unknown as NativeStreamCall;
  const nativeStreamSimple = native.streamSimple as unknown as NativeStreamCall;

  /** Report a snapshot. A throwing sink can never reach the stream. */
  function emit(attempt: CodexFastAttempt): void {
    Result.fromThrowable(
      () => {
        const snapshot = attempt.snapshot();
        if (snapshot !== undefined) {
          attemptSink.record(snapshot);
        }
      },
      () => undefined,
    )();
  }

  function emitTerminal(attempt: CodexFastAttempt): void {
    Result.fromThrowable(
      () => {
        const snapshot = attempt.terminalize();
        if (snapshot !== undefined) {
          attemptSink.record(snapshot);
        }
      },
      () => undefined,
    )();
  }

  /** Report one bounded degradation with no attempt behind it. */
  function emitDegraded(): void {
    emitTerminal(createCodexFastAttempt(DEGRADED_VERDICT));
  }

  /**
   * Classify one call from scalars the caller holds. Reading `model.id`,
   * `model.baseUrl`, `model.headers`, `options.apiKey`, `options.headers`,
   * and the intent port can all trigger hostile getters, so the whole read
   * runs inside one `Result`.
   *
   * The header preflight is deliberately evaluated last and only for a call
   * that already passed every other rule. That keeps the spec's rule order
   * intact — the first failing rule still wins, and its bounded reason is
   * still the one reported — while making a preexisting hint a reason to
   * never map the call at all, rather than something discovered at fetch time
   * with a mutated body already serialized.
   */
  function classify(
    model: unknown,
    options: unknown,
  ): Result<{ verdict: CodexFastEligibility; modelId: string }, undefined> {
    return Result.fromThrowable(
      () => {
        const intent = intentPort.readIntent();
        const fast = readUnknownProperty(intent, "fast");
        const modelId = readUnknownProperty(model, "id");
        const input = {
          providerId: native.id,
          fast,
          modelId,
          ownerModelId: readUnknownProperty(intent, "modelId"),
          baseUrl: readUnknownProperty(model, "baseUrl"),
          subscriptionAuthProven:
            fast === true &&
            hasCodexSubscriptionAccountClaim(
              readUnknownProperty(options, "apiKey"),
            ),
          collisionObserved: false,
        };
        const verdict = classifyCodexFastEligibility(input);
        const decided =
          verdict.kind === "eligible" &&
          hasPreexistingRoutingHint(model, options)
            ? classifyCodexFastEligibility({
                ...input,
                collisionObserved: true,
              })
            : verdict;
        return {
          verdict: decided,
          modelId: typeof modelId === "string" ? modelId : "",
        };
      },
      () => undefined,
    )();
  }

  /**
   * Apply collision rule 6 to the final body. Nothing here reads a value
   * through an accessor: every field is examined by descriptor, so a getter
   * trap planted by another extension is detected instead of invoked.
   */
  function decidePayload(
    payload: unknown,
    expectedModelId: string,
  ): { decision: CodexFastPayloadDecision; modelId: string | undefined } {
    const decided = Result.fromThrowable(
      (): {
        decision: CodexFastPayloadDecision;
        modelId: string | undefined;
      } => {
        if (!isPlainObject(payload)) {
          return { decision: "collision", modelId: undefined };
        }
        const modelDescriptor = Object.getOwnPropertyDescriptor(
          payload,
          MODEL_FIELD,
        );
        if (
          modelDescriptor === undefined ||
          !("value" in modelDescriptor) ||
          modelDescriptor.value !== expectedModelId
        ) {
          // The hint must echo the model this same body carries. A missing,
          // trapped, or rewritten `model` breaks that correlation.
          return { decision: "collision", modelId: undefined };
        }
        const tierDescriptor = Object.getOwnPropertyDescriptor(
          payload,
          SERVICE_TIER_FIELD,
        );
        if (tierDescriptor !== undefined) {
          if (
            "value" in tierDescriptor &&
            tierDescriptor.value === CODEX_PRIORITY_SERVICE_TIER
          ) {
            return { decision: "priority-preserved", modelId: expectedModelId };
          }
          return { decision: "collision", modelId: undefined };
        }
        Object.defineProperty(payload, SERVICE_TIER_FIELD, {
          value: CODEX_PRIORITY_SERVICE_TIER,
          writable: true,
          enumerable: true,
          configurable: true,
        });
        const written = Object.getOwnPropertyDescriptor(
          payload,
          SERVICE_TIER_FIELD,
        );
        if (
          written === undefined ||
          !("value" in written) ||
          written.value !== CODEX_PRIORITY_SERVICE_TIER
        ) {
          return { decision: "collision", modelId: undefined };
        }
        return { decision: "priority-set", modelId: expectedModelId };
      },
      () => undefined,
    )();
    if (decided.isErr()) {
      return { decision: "collision", modelId: undefined };
    }
    return decided.value;
  }

  type HeaderPlan =
    /** This attempt carries no mutation of the wrapper's, so it is native. */
    | { readonly kind: "not-mapped" }
    /** A routing hint appeared after the preflight cleared this call. */
    | { readonly kind: "collision" }
    /** The body is mapped, but the routing pair cannot be written. */
    | { readonly kind: "unavailable" }
    | { readonly kind: "activated"; readonly init: Record<string, unknown> };

  /**
   * Decide the outgoing headers for one attempt.
   *
   * A hint found here is not the ordinary case — the entry point already
   * preflighted both header sources the host merges — so it means something
   * reached these headers afterwards. It is still rule 7's collision, and it
   * is still reported as one, but it can no longer be answered by declining
   * to map: the body was mapped several steps ago. The distinction the caller
   * needs is therefore between "nothing of ours is in this body"
   * (`not-mapped`) and "our mutation is already in it" (`collision`,
   * `unavailable`), which is what these four kinds express.
   *
   * `Headers` is used for the lookup precisely because its names are case
   * insensitive, so a hint spelled in any casing is still a collision.
   */
  function planHeaders(
    init: unknown,
    state: CallState,
  ): Result<HeaderPlan, undefined> {
    return Result.fromThrowable(
      (): HeaderPlan => {
        if (!state.tierProven || state.finalModelId === undefined) {
          return { kind: "not-mapped" };
        }
        const routing = resolveCodexFastRouting({
          modelId: state.finalModelId,
          fast: true,
          serviceTier: CODEX_PRIORITY_SERVICE_TIER,
        });
        if (routing.kind !== "routing") {
          return { kind: "unavailable" };
        }
        const headerSource = readUnknownProperty(init, "headers");
        const headers = new Headers(headerSource as HeadersInit | undefined);
        if (headers.has(CODEX_ROUTING_HINT_HEADER)) {
          return { kind: "collision" };
        }
        headers.set(CODEX_ORIGINATOR_HEADER, routing.originator);
        headers.set(CODEX_ROUTING_HINT_HEADER, routing.routingHint);
        if (
          headers.get(CODEX_ORIGINATOR_HEADER) !== routing.originator ||
          headers.get(CODEX_ROUTING_HINT_HEADER) !== routing.routingHint
        ) {
          return { kind: "unavailable" };
        }
        const base =
          typeof init === "object" && init !== null
            ? { ...(init as Record<string, unknown>) }
            : {};
        base.headers = headers;
        return { kind: "activated", init: base };
      },
      () => undefined,
    )();
  }

  /** Whether a rejection is the caller's abort rather than a transport fault. */
  function isAbort(error: unknown, init: unknown): boolean {
    const signal = readUnknownProperty(init, "signal");
    if (readUnknownProperty(signal, "aborted") === true) {
      return true;
    }
    return readUnknownProperty(error, "name") === "AbortError";
  }

  function isTimeout(error: unknown): boolean {
    return readUnknownProperty(error, "name") === "TimeoutError";
  }

  /**
   * Install the bounded sniffer on one attempt's response. The body is piped,
   * never cloned and never buffered, so the consumer still sees the original
   * bytes in the original order.
   */
  function observeResponse(
    response: Response,
    attempt: CodexFastAttempt,
    token: number,
  ): Response {
    const record = (outcome: CodexFastEvidenceOutcome): void => {
      attempt.recordEvidence(token, outcome);
    };
    const body = response.body;
    if (
      body === null ||
      body.locked ||
      typeof body.pipeThrough !== "function" ||
      response.status < 200 ||
      response.status > 299
    ) {
      record("inaccessible");
      emit(attempt);
      return response;
    }
    const sniffer = createCodexServiceTierSniffer({
      onOutcome: (outcome) => {
        record(outcome);
        // Pi's SSE retry loop breaks on the first ok response, so an ok
        // response is this call's final attempt and its evidence is the one
        // the terminal snapshot must carry.
        emitTerminal(attempt);
      },
    });
    if (sniffer.isErr()) {
      record("inaccessible");
      emit(attempt);
      return response;
    }
    const wrapped = Result.fromThrowable(
      () =>
        new Response(body.pipeThrough(sniffer.value), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
      () => undefined,
    )();
    if (wrapped.isErr()) {
      record("inaccessible");
      emit(attempt);
      return response;
    }
    return wrapped.value;
  }

  /** The request-scoped `fetch` an eligible call delegates with. */
  function createWrapperFetch(
    baseFetch: FetchLike,
    attempt: CodexFastAttempt,
    state: CallState,
  ): FetchLike {
    /**
     * Leave one attempt to the native transport.
     *
     * That is exact only while the body is still the caller's own. Once this
     * wrapper wrote `service_tier: "priority"`, the body has been serialized
     * — and possibly zstd-compressed — before any fetch runs, so the mutation
     * cannot be rolled back and there is no native request left to fall back
     * to. Sending it without both routing parts is the partial fast request
     * rule 8 forbids, and decoding or rewriting the serialized body would be
     * a guess rule 12 forbids. The attempt is therefore not sent at all, and
     * the rejection is the caller's signal that nothing went out. A priority
     * tier the *caller* set is not this wrapper's to withhold: that request
     * is byte-for-byte what the native path would have sent.
     */
    function decline(input: unknown, init: unknown): Promise<Response> {
      if (state.tierWritten) {
        throw blockedRequestError();
      }
      return baseFetch(input, init);
    }

    return async (input: unknown, init?: unknown): Promise<Response> => {
      const opened = attempt.beginFetchAttempt();
      if (opened.kind !== "opened") {
        // Either no mapping ever happened on this call, or the call is
        // already terminal — including a retry of an attempt that was
        // blocked. Neither may carry the mutated body onto the wire.
        return decline(input, init);
      }
      const plan = planHeaders(init, state);
      if (plan.isErr()) {
        attempt.degrade();
        emit(attempt);
        return decline(input, init);
      }
      if (plan.value.kind === "collision") {
        attempt.recordHeaderCollision();
        emit(attempt);
        return decline(input, init);
      }
      if (plan.value.kind === "unavailable") {
        attempt.degrade();
        emit(attempt);
        return decline(input, init);
      }
      if (plan.value.kind === "not-mapped") {
        return baseFetch(input, init);
      }
      attempt.activateHeaders({ originator: true, routingHint: true });
      emit(attempt);
      const sent = await ResultAsync.fromPromise(
        baseFetch(input, plan.value.init),
        (error: unknown) => error,
      );
      if (sent.isErr()) {
        if (isAbort(sent.error, init)) {
          attempt.cancel();
          emit(attempt);
        } else if (isTimeout(sent.error)) {
          attempt.timeout();
          emit(attempt);
        }
        // A transport failure is the caller's failure, not the wrapper's.
        throw sent.error;
      }
      return observeResponse(sent.value, attempt, opened.attempt);
    };
  }

  /**
   * The `onPayload` chain an eligible call delegates with.
   *
   * `abandon` is how a mapping that cannot be completed becomes an ordinary
   * native call instead of a half-mapped one. It is called with this
   * invocation's receiver, because that is the options view the host reads
   * `transport` and `fetch` from next.
   */
  function createChainedOnPayload(
    callerOnPayload: unknown,
    attempt: CodexFastAttempt,
    state: CallState,
    modelId: string,
    abandon: (receiver: unknown) => void,
  ): (payload: unknown, model: unknown) => Promise<unknown> {
    // A method, not an arrow: the host calls the hook as
    // `options?.onPayload?.(body, model)`, so `this` is the options object it
    // is reading from, which on the `streamSimple` path is not the object
    // this wrapper prepared.
    return async function chainedOnPayload(
      this: unknown,
      payload: unknown,
      model: unknown,
    ): Promise<unknown> {
      let next = payload;
      if (typeof callerOnPayload === "function") {
        // `fromThrowable`, not `fromPromise`: the caller's hook may throw
        // synchronously before any promise exists.
        const called = await ResultAsync.fromThrowable(
          async (p: unknown, m: unknown): Promise<unknown> =>
            await (callerOnPayload as (p: unknown, m: unknown) => unknown)(
              p,
              m,
            ),
          (error: unknown) => error,
        )(payload, model);
        if (called.isErr()) {
          // The native path would have failed here too. Abandon the mapping
          // and let the caller's own failure through unchanged.
          attempt.degrade();
          emit(attempt);
          abandon(this);
          throw called.error;
        }
        next = called.value === undefined ? payload : called.value;
      }
      const decided = decidePayload(next, modelId);
      attempt.resolvePayload(decided.decision);
      if (decided.decision === "collision") {
        emit(attempt);
        // Nothing of this wrapper's is in the body, and the host has not read
        // a transport or a fetch yet, so there is a native call to go back
        // to. Rule 6's "leave the payload untouched" is only half the answer;
        // the other half is leaving the request itself untouched.
        abandon(this);
        return next;
      }
      state.finalModelId = decided.modelId;
      state.tierProven = true;
      state.tierWritten = decided.decision === "priority-set";
      return next;
    };
  }

  /** One wrapped entry point. `stream` and `streamSimple` differ only here. */
  function wrapCall(nativeCall: NativeStreamCall): NativeStreamCall {
    return (model: unknown, context: unknown, options?: unknown): unknown => {
      const classified = classify(model, options);
      if (classified.isErr()) {
        emitDegraded();
        return nativeCall.call(native, model, context, options);
      }
      const { verdict, modelId } = classified.value;
      if (verdict.kind === "no-intent") {
        return nativeCall.call(native, model, context, options);
      }
      const attempt = createCodexFastAttempt(verdict);
      if (verdict.kind !== "eligible") {
        emitTerminal(attempt);
        return nativeCall.call(native, model, context, options);
      }
      const prepared = Result.fromThrowable(
        (): Record<string, unknown> => {
          const state: CallState = {
            finalModelId: undefined,
            tierProven: false,
            tierWritten: false,
          };
          const source =
            typeof options === "object" && options !== null
              ? { ...(options as Record<string, unknown>) }
              : {};
          const nativeFields = captureNativeOptionFields(source);
          const callerFetch = nativeFieldValue(nativeFields, "fetch");
          const baseFetch: FetchLike =
            typeof callerFetch === "function"
              ? (callerFetch as FetchLike)
              : (input, init) =>
                  globalThis.fetch(input as RequestInfo, init as RequestInit);
          const wrapperFetch = createWrapperFetch(baseFetch, attempt, state);
          const abandon = (receiver: unknown): void => {
            // Restoring is best effort by construction: a host that read the
            // transport before the hook, or handed the hook a receiver this
            // wrapper never prepared, leaves nothing to put back. The fetch
            // wrapper still declines to add anything to such a call.
            Result.fromThrowable(
              () => {
                restoreNativeOptionFields(source, wrapperFetch, nativeFields);
                if (receiver !== source) {
                  restoreNativeOptionFields(
                    receiver,
                    wrapperFetch,
                    nativeFields,
                  );
                }
              },
              () => undefined,
            )();
          };
          source.onPayload = createChainedOnPayload(
            nativeFieldValue(nativeFields, "onPayload"),
            attempt,
            state,
            modelId,
            abandon,
          );
          source.transport = FORCED_TRANSPORT;
          source.fetch = wrapperFetch;
          return source;
        },
        () => undefined,
      )();
      if (prepared.isErr()) {
        attempt.degrade();
        emitTerminal(attempt);
        return nativeCall.call(native, model, context, options);
      }
      return nativeCall.call(native, model, context, prepared.value);
    };
  }

  return Result.fromThrowable(
    (): T => {
      const shell = Object.create(
        Object.getPrototypeOf(native) as object | null,
      ) as Record<string | symbol, unknown>;
      for (const key of Reflect.ownKeys(native)) {
        if (key === "stream" || key === "streamSimple") {
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(native, key);
        if (descriptor === undefined) {
          continue;
        }
        Object.defineProperty(shell, key, descriptor);
      }
      Object.defineProperty(shell, "stream", {
        value: wrapCall(nativeStream),
        writable: true,
        enumerable: true,
        configurable: true,
      });
      Object.defineProperty(shell, "streamSimple", {
        value: wrapCall(nativeStreamSimple),
        writable: true,
        enumerable: true,
        configurable: true,
      });
      return shell as unknown as T;
    },
    (): CodexFastWrapError => ({ kind: "provider-not-wrappable" }),
  )();
}
