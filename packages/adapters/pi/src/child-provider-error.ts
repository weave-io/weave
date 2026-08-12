/**
 * Bounded, canonical projection of a child's terminal provider error.
 *
 * Pi reports a failed assistant turn on the terminal assistant message, not on
 * a dedicated error event. The exact shape this module reads comes from
 * `@earendil-works/pi-ai` 0.84.1 (`dist/types.d.ts`):
 *
 * ```ts
 * type StopReason =
 *   "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
 *
 * interface AssistantMessage {
 *   role: "assistant";
 *   api: Api;
 *   provider: ProviderId;
 *   model: string;
 *   responseModel?: string;
 *   stopReason: StopReason;
 *   errorMessage?: string;
 *   rawStopReason?: string;
 *   // ...content, usage, diagnostics, responseId, deferred, timestamp
 * }
 * ```
 *
 * Only `stopReason: "error"` is a provider error here. Everything else —
 * including `aborted`, which Pi uses for its own interruption path — is not a
 * provider failure and produces typed absence.
 *
 * ## Why no provider prose survives
 *
 * `errorMessage` is raw provider output: it can carry request IDs, URLs,
 * headers, credentials, filesystem paths, prompt or completion text, nested
 * provider JSON, and control or bidi characters. Sanitizing that text and
 * hoping the filter is complete is not a boundary. So this module never
 * preserves any provider prose at all. The human-readable `message` field is
 * drawn from a nine-entry frozen table keyed by error class, and the schema
 * pins `message` to exactly that closed set. A projection therefore cannot
 * carry provider text even if a future edit tried to put it there.
 *
 * ## What evidence is admissible
 *
 * Status, code, and class come only from **anchored, allowlisted** evidence in
 * the top-level `errorMessage`:
 *
 * 1. an HTTP status anchored at offset zero (the provider-SDK convention,
 *    `429 …`), restricted to 400–599;
 * 2. an allowlisted code token that is the entire remaining body after that
 *    optional status (the errno convention, `ECONNRESET`).
 *
 * Every JSON-shaped body is untrusted generic unknown. After any separately
 * handled authoritative non-JSON HTTP status prefix, if the bounded trimmed
 * remainder starts with `{` or `[`, this module does not inspect type, code,
 * status, or any member inside it. The JSON suffix contributes no evidence:
 * no safe code is retained from it, and classification uses only the leading
 * HTTP status when one is present — otherwise the class is `unknown` with the
 * canonical details-unavailable message. Bare valid JSON Anthropic/OpenAI
 * envelopes, malformed JSON, trailing content or commas, duplicates, arrays,
 * nested or sibling members, inherited or proxy shapes, and oversized JSON all
 * stay unknown and never throw.
 *
 * Nothing else is read. Assistant content, prompts, completions, free prose,
 * and unmarked numbers contribute nothing, so a completion that happens to
 * contain `HTTP 429 rate_limit_error` cannot change the class. Ambiguous or
 * unrecognized non-JSON data collapses to `provider-error` or `unknown`.
 *
 * ## Identity labels
 *
 * Provider, API, and model labels are never read out of the event. A provider
 * is free to place an account id, an organization id, or a key fragment in any
 * of those fields, and the event has no authority over its own labels. Labels
 * enter only through {@link PiChildProviderErrorDescriptor}, an explicit
 * controller-owned seam, and even there each label must pass the label token
 * grammar and the secret-shaped rejection in `TrustedLabelSchema`.
 *
 * Layer position: it depends on `child-session-events.ts` only, so overlay
 * types may hold the projected model without an import cycle. Window scanning
 * over overlay entries lives in `child-overlay-telemetry.ts` beside the usage
 * scan.
 *
 * A provider rate limit is a provider fact, not a session-readiness fact: this
 * projection never retries, never changes a model, and never influences child
 * readiness.
 */

import { err, ok, Result } from "neverthrow";
import { z } from "zod";
import {
  type PiChildSessionEvent,
  projectAssistantUsageFacts,
} from "./child-session-events.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Pinned ceiling on the human message retained for display. Every canonical
 * message is far below it; the bound exists so the schema rejects any value
 * that is not one of them for length reasons as well as identity reasons.
 */
export const MAX_CHILD_ERROR_MESSAGE_LENGTH = 160;

/** Pinned ceiling on how much raw text is scanned for evidence. */
export const MAX_CHILD_ERROR_SCAN_LENGTH = 4_096;

/** Pinned ceiling on trusted identity labels (source, provider, model). */
export const MAX_CHILD_ERROR_LABEL_LENGTH = 64;

/** Pinned ceiling on an allowlisted safe code token. */
export const MAX_CHILD_ERROR_CODE_LENGTH = 48;

/**
 * Only a client- or server-error status is failure evidence. A 1xx/2xx/3xx
 * number at the head of a failed turn is not a status Weave can reason about,
 * so it is discarded rather than reported.
 */
export const MIN_CHILD_ERROR_EVIDENCE_STATUS = 400;
export const MAX_CHILD_ERROR_EVIDENCE_STATUS = 599;

export const CHILD_PROVIDER_ERROR_BOUNDS = Object.freeze({
  maxMessageLength: MAX_CHILD_ERROR_MESSAGE_LENGTH,
  maxScanLength: MAX_CHILD_ERROR_SCAN_LENGTH,
  maxLabelLength: MAX_CHILD_ERROR_LABEL_LENGTH,
  maxCodeLength: MAX_CHILD_ERROR_CODE_LENGTH,
  minHttpStatus: 100,
  maxHttpStatus: 599,
  minEvidenceStatus: MIN_CHILD_ERROR_EVIDENCE_STATUS,
  maxEvidenceStatus: MAX_CHILD_ERROR_EVIDENCE_STATUS,
});

// ---------------------------------------------------------------------------
// Closed model
// ---------------------------------------------------------------------------

/**
 * The closed set of error classes. Nothing outside this list can be produced,
 * so no provider taxonomy leaks through the projection.
 */
export const PI_CHILD_ERROR_CLASSES = [
  "rate-limit",
  "auth",
  "timeout",
  "overload",
  "connection",
  "cancelled",
  "malformed-response",
  "provider-error",
  "unknown",
] as const;

export type PiChildErrorClass = (typeof PI_CHILD_ERROR_CLASSES)[number];

/**
 * The closed set of human messages. `message` is pinned to this list by the
 * schema, which is what makes "no provider prose survives" a property of the
 * type rather than a property of a filter.
 */
export const PI_CHILD_ERROR_MESSAGES = [
  "Provider rate limit exceeded. Retry later.",
  "Provider rejected the credentials.",
  "Provider request timed out.",
  "Provider is overloaded. Retry later.",
  "Connection to the provider failed.",
  "Request was cancelled.",
  "Provider returned a malformed response.",
  "Provider request failed.",
  "Provider failure details unavailable.",
] as const;

export type PiChildErrorMessage = (typeof PI_CHILD_ERROR_MESSAGES)[number];

/**
 * Class to fixed message. Each entry states what Weave knows and claims
 * nothing more; none of them is derived from provider output.
 */
export const CHILD_ERROR_CANONICAL_MESSAGE: Readonly<
  Record<PiChildErrorClass, PiChildErrorMessage>
> = Object.freeze({
  "rate-limit": "Provider rate limit exceeded. Retry later.",
  auth: "Provider rejected the credentials.",
  timeout: "Provider request timed out.",
  overload: "Provider is overloaded. Retry later.",
  connection: "Connection to the provider failed.",
  cancelled: "Request was cancelled.",
  "malformed-response": "Provider returned a malformed response.",
  "provider-error": "Provider request failed.",
  unknown: "Provider failure details unavailable.",
});

/**
 * Safe code allowlist. A code token is retained only when it is one of these
 * generic, non-identifying tokens; arbitrary codes are never kept, because a
 * provider is free to put an account, key, or request identifier in that field.
 */
export const PI_CHILD_SAFE_ERROR_CODES = [
  "abort_err",
  "api_error",
  "authentication_error",
  "bad_gateway",
  "billing_hard_limit_reached",
  "context_length_exceeded",
  "eai_again",
  "econnaborted",
  "econnrefused",
  "econnreset",
  "ehostunreach",
  "enetunreach",
  "enotfound",
  "epipe",
  "etimedout",
  "gateway_timeout",
  "insufficient_quota",
  "internal_server_error",
  "invalid_api_key",
  "invalid_request_error",
  "malformed_response",
  "model_not_found",
  "not_found_error",
  "overloaded_error",
  "permission_error",
  "rate_limit_error",
  "request_too_large",
  "server_error",
  "service_unavailable",
  "timeout",
] as const;

export type PiChildSafeErrorCode = (typeof PI_CHILD_SAFE_ERROR_CODES)[number];

/** Grammar every trusted identity label must satisfy. */
const labelToken = z
  .string()
  .trim()
  .min(1)
  .max(MAX_CHILD_ERROR_LABEL_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u);

/**
 * Shapes that must never be accepted as an identity label even from a trusted
 * seam: key prefixes, credential words, and long opaque runs. A legitimate API,
 * provider, or model label is a short readable word list; anything that looks
 * like a secret is rejected rather than truncated.
 */
const SECRET_SHAPED_LABEL =
  /sk-|pk-|rk-|\b(?:token|key|apikey|secret|bearer|password|passwd|credential|credentials|session|cookie|signature|auth)\b|[A-Za-z0-9_-]{24,}/iu;

/**
 * A label supplied by a controller that has authenticated it. Even here the
 * value must pass the grammar and the secret-shaped rejection, so a mistaken
 * pass-through of provider output cannot widen the projection.
 */
export const TrustedLabelSchema = labelToken.refine(
  (value) => !SECRET_SHAPED_LABEL.test(value),
  "secret-shaped label",
);

/**
 * The explicitly trusted seam through which identity labels may enter the
 * projection.
 *
 * Nothing in the overlay path supplies one today: the overlay observes child
 * session events, which have no authority over their own labels. A controller
 * that holds an authenticated child descriptor may pass one, and each field is
 * still validated by `TrustedLabelSchema` before it is retained.
 */
export interface PiChildProviderErrorDescriptor {
  /** Authoritative Pi API label, from a controller-owned descriptor. */
  readonly source?: string;
  /** Authoritative provider id, from a controller-owned descriptor. */
  readonly provider?: string;
  /** Authoritative model label, from a controller-owned descriptor. */
  readonly model?: string;
}

/**
 * Every fact except `class` and `message` is optional: a class is always
 * derivable (`unknown` at worst) and the message is always present, since a
 * canonical entry exists for every class.
 */
export const PiChildProviderErrorSchema = z
  .object({
    /** Trusted Pi API label. Only ever set through a trusted descriptor. */
    source: TrustedLabelSchema.optional(),
    /** Trusted provider id. Only ever set through a trusted descriptor. */
    provider: TrustedLabelSchema.optional(),
    /** Trusted model label. Only ever set through a trusted descriptor. */
    model: TrustedLabelSchema.optional(),
    class: z.enum(PI_CHILD_ERROR_CLASSES),
    /** Real HTTP status, only from anchored evidence. */
    httpStatus: z
      .number()
      .int()
      .min(CHILD_PROVIDER_ERROR_BOUNDS.minHttpStatus)
      .max(CHILD_PROVIDER_ERROR_BOUNDS.maxHttpStatus)
      .optional(),
    /** Allowlisted safe code, canonical lowercase spelling. */
    code: z.enum(PI_CHILD_SAFE_ERROR_CODES).optional(),
    /** Fixed canonical copy for the class. Never provider text. */
    message: z.enum(PI_CHILD_ERROR_MESSAGES),
  })
  .strict();

export type PiChildProviderError = z.infer<typeof PiChildProviderErrorSchema>;

/**
 * Expected absence, never an exception.
 *
 * - `ProviderErrorUnavailable`: the input is not an authoritative terminal
 *   assistant message, or it is malformed or hostile beyond use.
 * - `ProviderErrorCleared`: the input *is* an authoritative terminal assistant
 *   message and it did not fail, so any retained error is stale and the holder
 *   must drop it.
 */
export type PiChildProviderErrorAbsence =
  | { readonly type: "ProviderErrorUnavailable" }
  | { readonly type: "ProviderErrorCleared" };

const UNAVAILABLE: PiChildProviderErrorAbsence = {
  type: "ProviderErrorUnavailable",
};
const CLEARED: PiChildProviderErrorAbsence = { type: "ProviderErrorCleared" };

/** The projected field name carried on rebuilt historical replay events. */
export const CHILD_PROVIDER_ERROR_REPLAY_FIELD = "weaveProviderError";

// ---------------------------------------------------------------------------
// Safe record access
// ---------------------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Read one property without trusting the descriptor. A hostile or exotic host
 * object can expose a throwing getter or a throwing Proxy trap, so the read is
 * wrapped and a throw is reported as an absent value. The whole projection is
 * additionally wrapped (see `guard`), so even a throw from a path this
 * helper does not cover cannot escape.
 */
const readProperty = Result.fromThrowable(
  (record: Record<string, unknown>, key: string): unknown => record[key],
  () => UNAVAILABLE,
);

const field = (
  record: Record<string, unknown> | undefined,
  key: string,
): unknown => {
  if (record === undefined) return undefined;
  const read = readProperty(record, key);
  return read.isOk() ? read.value : undefined;
};

const stringField = (
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const value = field(record, key);
  return typeof value === "string" ? value : undefined;
};

/**
 * Own-property presence without trusting descriptors or Proxy traps. A throw
 * from `Object.hasOwn`, a hostile `getOwnPropertyDescriptor` trap, or a
 * throwing `has` trap is reported as absence so inherited and accessor noise
 * cannot widen the allowlisted copy.
 */
const recordHasOwnKey = (
  record: Record<string, unknown>,
  key: string,
): boolean => {
  const result = Result.fromThrowable(
    () => Object.hasOwn(record, key),
    () => false,
  )();
  return result.isOk() ? result.value : false;
};

const trustedLabel = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const parsed = TrustedLabelSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

// ---------------------------------------------------------------------------
// Anchored evidence extraction
// ---------------------------------------------------------------------------

/**
 * Anchored HTTP status: the provider-SDK convention puts a bare status at
 * offset zero, followed by whitespace, a body, or nothing. A number anywhere
 * else in the value is prose or payload and is never read.
 */
const ANCHORED_STATUS = /^(\d{3})(?=$|[\s{[,;:])/u;

/** The errno convention: the entire remaining body is one code token. */
const BARE_CODE_BODY = /^([A-Za-z][A-Za-z0-9_]{2,47})\.?$/u;

const SAFE_CODE_SET: ReadonlySet<string> = new Set(PI_CHILD_SAFE_ERROR_CODES);

const allowlistedCode = (token: string): PiChildSafeErrorCode | undefined => {
  const normalized = token.toLowerCase();
  if (normalized.length > MAX_CHILD_ERROR_CODE_LENGTH) return undefined;
  return SAFE_CODE_SET.has(normalized)
    ? (normalized as PiChildSafeErrorCode)
    : undefined;
};

/** The admissible evidence one `errorMessage` yields. */
interface AnchoredEvidence {
  readonly httpStatus?: number;
  readonly code?: PiChildSafeErrorCode;
  /** True when the value carried any text at all, status or not. */
  readonly present: boolean;
}

const NO_EVIDENCE: AnchoredEvidence = { present: false };

/**
 * Extract the admissible evidence from one top-level `errorMessage`.
 *
 * The scan is bounded, anchored, and allowlisted at every step. It never
 * searches the value for interesting substrings, so no part of a prompt,
 * completion, header, or nested payload can influence the result.
 */
function anchoredEvidence(raw: string | undefined): AnchoredEvidence {
  if (raw === undefined) return NO_EVIDENCE;
  const scanned = raw.slice(0, MAX_CHILD_ERROR_SCAN_LENGTH);
  const head = scanned.replace(/^\s+/u, "");
  if (head.length === 0) return NO_EVIDENCE;

  const status = ANCHORED_STATUS.exec(head);
  const statusText = status?.[1];
  const httpStatus =
    statusText === undefined
      ? undefined
      : (() => {
          const value = Number(statusText);
          return value >= MIN_CHILD_ERROR_EVIDENCE_STATUS &&
            value <= MAX_CHILD_ERROR_EVIDENCE_STATUS
            ? value
            : undefined;
        })();

  const body = (
    statusText === undefined ? head : head.slice(statusText.length)
  ).replace(/^\s+/u, "");

  // JSON-shaped remainder is never inspected for type/code/status members.
  if (body.startsWith("{") || body.startsWith("[")) {
    return {
      ...(httpStatus === undefined ? {} : { httpStatus }),
      present: true,
    };
  }

  return {
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(() => {
      const code = anchoredBareCode(body);
      return code === undefined ? {} : { code };
    })(),
    present: true,
  };
}

/**
 * An allowlisted code token only when the entire remaining body is that token
 * (errno convention). JSON-shaped bodies never reach this helper.
 */
function anchoredBareCode(body: string): PiChildSafeErrorCode | undefined {
  const bare = BARE_CODE_BODY.exec(body.trim());
  const bareToken = bare?.[1];
  if (bareToken === undefined) return undefined;
  return allowlistedCode(bareToken);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Status to class. Only statuses with one unambiguous meaning appear here. */
const STATUS_CLASS: Readonly<Record<number, PiChildErrorClass>> = Object.freeze(
  {
    401: "auth",
    403: "auth",
    407: "auth",
    408: "timeout",
    429: "rate-limit",
    503: "overload",
    504: "timeout",
    524: "timeout",
    529: "overload",
  },
);

/** Allowlisted code to class. Codes with no class meaning are omitted. */
const CODE_CLASS: Readonly<Record<string, PiChildErrorClass>> = Object.freeze({
  abort_err: "cancelled",
  authentication_error: "auth",
  eai_again: "connection",
  econnaborted: "connection",
  econnrefused: "connection",
  econnreset: "connection",
  ehostunreach: "connection",
  enetunreach: "connection",
  enotfound: "connection",
  epipe: "connection",
  etimedout: "timeout",
  gateway_timeout: "timeout",
  invalid_api_key: "auth",
  malformed_response: "malformed-response",
  overloaded_error: "overload",
  permission_error: "auth",
  rate_limit_error: "rate-limit",
  service_unavailable: "overload",
  timeout: "timeout",
});

/**
 * Classify from anchored evidence only, in this pinned precedence:
 * rate-limit, auth, timeout, overload, connection, cancelled,
 * malformed-response, then provider-error when some evidence exists, and
 * finally unknown.
 *
 * A class matches when either the anchored status or the allowlisted code maps
 * to it, so precedence is deterministic when the two disagree. No class is
 * ever inferred from prose or from an absent fact.
 */
function classify(evidence: AnchoredEvidence): PiChildErrorClass {
  const fromStatus =
    evidence.httpStatus === undefined
      ? undefined
      : STATUS_CLASS[evidence.httpStatus];
  const fromCode =
    evidence.code === undefined ? undefined : CODE_CLASS[evidence.code];

  for (const candidate of PI_CHILD_ERROR_CLASSES) {
    if (candidate === "provider-error" || candidate === "unknown") break;
    if (fromStatus === candidate || fromCode === candidate) return candidate;
  }
  if (evidence.httpStatus !== undefined || evidence.code !== undefined) {
    return "provider-error";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

const build = (
  raw: string | undefined,
  descriptor: PiChildProviderErrorDescriptor | undefined,
): Result<PiChildProviderError, PiChildProviderErrorAbsence> => {
  const evidence = anchoredEvidence(raw);
  const cls = classify(evidence);
  const source = trustedLabel(descriptor?.source);
  const provider = trustedLabel(descriptor?.provider);
  const model = trustedLabel(descriptor?.model);
  const projected: PiChildProviderError = {
    ...(source === undefined ? {} : { source }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    class: cls,
    ...(evidence.httpStatus === undefined
      ? {}
      : { httpStatus: evidence.httpStatus }),
    ...(evidence.code === undefined ? {} : { code: evidence.code }),
    message: CHILD_ERROR_CANONICAL_MESSAGE[cls],
  };
  // Re-validate: only a schema-valid, bounded, closed record leaves here.
  const parsed = PiChildProviderErrorSchema.safeParse(projected);
  return parsed.success ? ok(parsed.data) : err(UNAVAILABLE);
};

/**
 * An already-projected error carried on a rebuilt historical replay event.
 *
 * Historical entries are rebuilt from the persisted assistant message, whose
 * raw `errorMessage` must never be stored in overlay state. The rebuilt event
 * therefore carries the projection under
 * `CHILD_PROVIDER_ERROR_REPLAY_FIELD`, and it is re-validated here so a
 * tampered or stale saved value cannot widen the model.
 */
const preProjected = (
  message: Record<string, unknown> | undefined,
): Result<PiChildProviderError, PiChildProviderErrorAbsence> | undefined => {
  const carried = field(message, CHILD_PROVIDER_ERROR_REPLAY_FIELD);
  if (carried === undefined) return undefined;
  const parsed = PiChildProviderErrorSchema.safeParse(carried);
  return parsed.success ? ok(parsed.data) : err(UNAVAILABLE);
};

/**
 * Typed boundary around anything that touches an untrusted record.
 *
 * A hostile input can be a Proxy whose `get`, `has`, or `ownKeys` trap throws,
 * an object with a throwing getter, or a value whose `Symbol.toPrimitive`
 * throws inside Zod. Wrapping the complete unit of work — property access,
 * evidence extraction, and schema validation alike — means every one of those
 * paths yields `ProviderErrorUnavailable` instead of an exception crossing the
 * boundary.
 */
const guard = <A>(
  work: () => Result<A, PiChildProviderErrorAbsence>,
): Result<A, PiChildProviderErrorAbsence> =>
  Result.fromThrowable(work, () => UNAVAILABLE)().andThen((inner) => inner);

/** The same boundary for work whose natural result is a plain value. */
const guardValue = <A>(work: () => A, fallback: A): A => {
  const result = Result.fromThrowable(work, () => UNAVAILABLE)();
  return result.isOk() ? result.value : fallback;
};

/**
 * Project one assistant message into the bounded error model.
 *
 * `undefined` role is tolerated (some recorded shapes omit it), any other role
 * is not an authoritative terminal assistant message. A terminal message that
 * did not fail reports {@link PiChildProviderErrorAbsence} `ProviderErrorCleared`
 * so the holder can drop a stale error from an earlier turn.
 *
 * `descriptor` is the only channel through which identity labels can enter; it
 * must come from a controller that authenticated them, never from the message.
 *
 * Module-internal: the public surface is the event parser and the replay
 * helpers, so no caller outside this package can feed arbitrary unknown input
 * into the projection.
 */
export function projectAssistantProviderError(
  message: unknown,
  descriptor?: PiChildProviderErrorDescriptor,
): Result<PiChildProviderError, PiChildProviderErrorAbsence> {
  return guard(() => {
    const record = asRecord(message);
    if (record === undefined) return err(UNAVAILABLE);
    const role = field(record, "role");
    if (typeof role === "string" && role !== "assistant") {
      return err(UNAVAILABLE);
    }

    const carried = preProjected(record);
    if (carried !== undefined) return carried;

    const stopReason = field(record, "stopReason");
    if (typeof stopReason !== "string") return err(UNAVAILABLE);
    if (stopReason !== "error") return err(CLEARED);

    return build(stringField(record, "errorMessage"), descriptor);
  });
}

/**
 * Project a parser-approved child session event.
 *
 * Only the terminal `message_end` carries the failed assistant message, so
 * every other event is a typed absence. Never throws: malformed, oversized,
 * and hostile inputs all resolve to a typed absence or a bounded projection.
 */
export function parsePiChildProviderError(
  event: PiChildSessionEvent,
  descriptor?: PiChildProviderErrorDescriptor,
): Result<PiChildProviderError, PiChildProviderErrorAbsence> {
  if (event.type !== "message_end") return err(UNAVAILABLE);
  return guard(() => {
    const record = event as unknown as Record<string, unknown>;
    return projectAssistantProviderError(field(record, "message"), descriptor);
  });
}

// ---------------------------------------------------------------------------
// Safe assistant-message copy
// ---------------------------------------------------------------------------

/**
 * The only assistant-message fields an overlay reducer needs, and therefore
 * the only fields a retained or rebuilt event may carry.
 *
 * Copying is allowlist-only. The excluded set is not a filter of known-bad
 * names; it is everything not named here, which covers today's hazards —
 * `errorMessage`, `rawStopReason`, `responseId`, `diagnostics`, `api`,
 * `provider`, `deferred` — and every extension field a future Pi or a hostile
 * host might add.
 *
 * Each entry earns its place:
 *
 * - `id`, `messageId`: entry identity (`messageIdFromUnknown`, `messageIdFrom`).
 * - `role`: authoritative assistant discrimination in every reducer.
 * - `stopReason`: terminal outcome, read verbatim by the transcript reducer.
 * - `text`, `content`: terminal assistant text (`extractAssistantEndText`).
 * - `timestamp`: ordering fact the replay mapper preserves.
 *
 * Usage fields are deliberately not in this raw-copy allowlist. They are
 * rebuilt below from the closed, bounded `PiAssistantUsageFacts` projection.
 */
export const SAFE_ASSISTANT_MESSAGE_FIELDS = [
  "id",
  "messageId",
  "role",
  "stopReason",
  "text",
  "content",
  "timestamp",
] as const;

/**
 * Copy only the allowlisted fields of an assistant message.
 *
 * Reads walk the closed allowlist with guarded own-property checks: inherited
 * names, symbols, and unknown keys are never considered, and a Proxy whose
 * `ownKeys` / descriptor / getter traps throw contributes typed absence for
 * that field rather than an unbounded host object or an exception.
 */
function copySafeAssistantFields(
  message: Record<string, unknown>,
): Record<string, unknown> {
  return guardValue(() => {
    const next: Record<string, unknown> = {};
    for (const key of SAFE_ASSISTANT_MESSAGE_FIELDS) {
      if (!recordHasOwnKey(message, key)) continue;
      const value = field(message, key);
      if (value === undefined) continue;
      next[key] = value;
    }
    return next;
  }, {});
}

/**
 * Rebuild a terminal event with an allowlisted message copy and the canonical
 * error projection in place of the raw provider text.
 *
 * The controller stores parsed events in overlay entries and the transcript, so
 * an unredacted event would put `errorMessage` — and any credential, request
 * id, path, or payload inside it — straight into saved state, along with
 * `responseId`, `diagnostics`, and every other provider field. Redaction runs
 * before any downstream reduce, which makes the canonical projection the only
 * error fact the overlay can ever hold.
 *
 * Broader parser catchall on `PiChildSessionEvent` is outside this sanitizer's
 * `message_end` projection: a parser-approved event may still carry unknown
 * top-level keys, so this function never spreads `message_end`. It returns a
 * fresh object with only `type: "message_end"` and an allowlist-built
 * `message`. Non-`message_end` variants are returned unchanged in this
 * minimal task.
 */
export function redactProviderErrorFromEvent(
  event: PiChildSessionEvent,
): PiChildSessionEvent {
  if (event.type !== "message_end") return event;
  const emptyEnd = { type: "message_end" } as PiChildSessionEvent;
  return guardValue(() => {
    const record = event as unknown as Record<string, unknown>;
    const message = asRecord(field(record, "message"));
    if (message === undefined) return emptyEnd;
    const projected = projectAssistantProviderError(message);
    const usage = projectAssistantUsageFacts(message);
    const safeMessage: Record<string, unknown> = {
      ...copySafeAssistantFields(message),
      ...(usage?.usage === undefined ? {} : { usage: usage.usage }),
      ...(usage?.contextUsage === undefined
        ? {}
        : { contextUsage: usage.contextUsage }),
      ...(usage?.model === undefined ? {} : { model: usage.model }),
      ...(projected.isOk()
        ? { [CHILD_PROVIDER_ERROR_REPLAY_FIELD]: projected.value }
        : {}),
    };
    return {
      type: "message_end",
      message: safeMessage,
    } as PiChildSessionEvent;
  }, emptyEnd);
}

// ---------------------------------------------------------------------------
// Historical replay facts
// ---------------------------------------------------------------------------

/** Authoritative pi-ai `StopReason` values, copied verbatim, never invented. */
export const PI_STOP_REASONS = [
  "pending",
  "stop",
  "length",
  "toolUse",
  "error",
  "aborted",
  "deferred",
] as const;

const StopReasonSchema = z.enum(PI_STOP_REASONS);

/**
 * Bounded, canonical facts to attach to a rebuilt historical `message_end`.
 *
 * A rebuilt event must let the window scan reach the same conclusion the live
 * path reaches, so it carries the authoritative `stopReason` verbatim plus the
 * projection when the turn failed. The raw `errorMessage` is deliberately left
 * behind: it never enters overlay saved state.
 *
 * `undefined` means the persisted message carried no authoritative terminal
 * stop reason, so the rebuilt event stays exactly as it was.
 */
export function historicalProviderErrorFacts(message: unknown):
  | {
      readonly stopReason: (typeof PI_STOP_REASONS)[number];
      readonly providerError?: PiChildProviderError;
    }
  | undefined {
  return guardValue<
    | {
        readonly stopReason: (typeof PI_STOP_REASONS)[number];
        readonly providerError?: PiChildProviderError;
      }
    | undefined
  >(() => {
    const record = asRecord(message);
    if (record === undefined) return undefined;
    const stopReason = StopReasonSchema.safeParse(field(record, "stopReason"));
    if (!stopReason.success) return undefined;
    const projected = projectAssistantProviderError(message);
    return {
      stopReason: stopReason.data,
      ...(projected.isOk() ? { providerError: projected.value } : {}),
    };
  }, undefined);
}

/**
 * The extra `message_end` fields a rebuilt historical assistant entry carries.
 *
 * One helper covers both projections a persisted assistant message can
 * contribute, so the rebuilt window reaches the same conclusions the live path
 * does: pi-ai usage accounting (`usage`, `model`) and the terminal outcome
 * (`stopReason` verbatim plus the canonical error projection). The raw
 * `errorMessage` is deliberately left behind — it never enters overlay state.
 */
export function historicalAssistantMessageFields(
  message: unknown,
): Record<string, unknown> {
  return guardValue<Record<string, unknown>>(() => {
    const usage = projectAssistantUsageFacts(message);
    const facts = historicalProviderErrorFacts(message);
    return {
      ...(usage?.usage === undefined ? {} : { usage: usage.usage }),
      ...(usage?.contextUsage === undefined
        ? {}
        : { contextUsage: usage.contextUsage }),
      ...(usage?.model === undefined ? {} : { model: usage.model }),
      ...(facts === undefined ? {} : { stopReason: facts.stopReason }),
      ...(facts?.providerError === undefined
        ? {}
        : { [CHILD_PROVIDER_ERROR_REPLAY_FIELD]: facts.providerError }),
    };
  }, {});
}
