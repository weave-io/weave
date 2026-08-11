/**
 * Bounded, sanitized projection of a child's terminal provider error.
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
 *   // ...content, usage, diagnostics, deferred, timestamp
 * }
 * ```
 *
 * Only `stopReason: "error"` is a provider error here. Everything else —
 * including `aborted`, which Pi uses for its own interruption path — is not a
 * provider failure and produces a typed absence.
 *
 * `errorMessage` is raw provider output: it can carry request IDs, URLs,
 * headers, credentials, filesystem paths, prompt or completion text, nested
 * provider JSON, and control or bidi characters. None of that may ever reach
 * overlay saved state, the Runtime Store, lifecycle metadata, Weave logs, the
 * engine API, or any model- or tool-visible detail Weave creates. This module
 * is therefore the only place that touches the raw value: it returns a closed,
 * Zod-validated model whose free-text field is either provably safe or honest
 * canonical copy.
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

/** Pinned ceiling on the sanitized human message retained for display. */
export const MAX_CHILD_ERROR_MESSAGE_LENGTH = 160;

/**
 * Pinned ceiling on a candidate message *before* sanitization. A genuine
 * provider error line is short; anything longer is prompt, completion, or
 * transcript spill and is replaced with canonical copy rather than truncated.
 */
export const MAX_CHILD_ERROR_CANDIDATE_LENGTH = 240;

/** Pinned ceiling on how much raw text is scanned for classification. */
export const MAX_CHILD_ERROR_SCAN_LENGTH = 4_096;

/** Pinned ceiling on bounded identity labels (source, provider, model). */
export const MAX_CHILD_ERROR_LABEL_LENGTH = 64;

/** Pinned ceiling on an allowlisted safe code token. */
export const MAX_CHILD_ERROR_CODE_LENGTH = 48;

export const CHILD_PROVIDER_ERROR_BOUNDS = Object.freeze({
  maxMessageLength: MAX_CHILD_ERROR_MESSAGE_LENGTH,
  maxCandidateLength: MAX_CHILD_ERROR_CANDIDATE_LENGTH,
  maxScanLength: MAX_CHILD_ERROR_SCAN_LENGTH,
  maxLabelLength: MAX_CHILD_ERROR_LABEL_LENGTH,
  maxCodeLength: MAX_CHILD_ERROR_CODE_LENGTH,
  minHttpStatus: 100,
  maxHttpStatus: 599,
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
 * Safe code allowlist. A provider code is retained only when it is one of
 * these generic, non-identifying tokens; arbitrary codes are never kept,
 * because a provider is free to put an account, key, or request identifier in
 * that field.
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

const labelToken = z
  .string()
  .trim()
  .min(1)
  .max(MAX_CHILD_ERROR_LABEL_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u);

/**
 * Every fact except `class` and `message` is optional: a class is always
 * derivable (`unknown` at worst) and the message is always present, since
 * canonical copy stands in when nothing can be preserved safely.
 */
export const PiChildProviderErrorSchema = z
  .object({
    /** Authoritative Pi API label the failing turn used (`AssistantMessage.api`). */
    source: labelToken.optional(),
    /** Authoritative provider id (`AssistantMessage.provider`). */
    provider: labelToken.optional(),
    /** Authoritative model label (`responseModel` preferred over `model`). */
    model: labelToken.optional(),
    class: z.enum(PI_CHILD_ERROR_CLASSES),
    /** Real HTTP status, only from unambiguous evidence. */
    httpStatus: z
      .number()
      .int()
      .min(CHILD_PROVIDER_ERROR_BOUNDS.minHttpStatus)
      .max(CHILD_PROVIDER_ERROR_BOUNDS.maxHttpStatus)
      .optional(),
    /** Allowlisted safe code, canonical lowercase spelling. */
    code: z.enum(PI_CHILD_SAFE_ERROR_CODES).optional(),
    /** Short sanitized human message, or honest canonical copy. */
    message: z.string().min(1).max(MAX_CHILD_ERROR_MESSAGE_LENGTH),
  })
  .strict();

export type PiChildProviderError = z.infer<typeof PiChildProviderErrorSchema>;

/**
 * Expected absence, never an exception.
 *
 * - `ProviderErrorUnavailable`: the input is not an authoritative terminal
 *   assistant message, or it is malformed beyond use.
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

/**
 * Canonical copy per class, used whenever safe preservation of provider text
 * cannot be proved. It states what Weave knows and claims nothing more.
 */
const CANONICAL_MESSAGE: Readonly<Record<PiChildErrorClass, string>> =
  Object.freeze({
    "rate-limit": "provider rate limit exceeded",
    auth: "provider rejected the credentials",
    timeout: "provider request timed out",
    overload: "provider is overloaded",
    connection: "connection to the provider failed",
    cancelled: "request was cancelled",
    "malformed-response": "provider returned a malformed response",
    "provider-error": "provider request failed",
    unknown: "details unavailable",
  });

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
 * object can expose a throwing getter, so the read is wrapped and a throw is
 * reported as an absent value.
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

const label = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const parsed = labelToken.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

/** C0 except TAB/LF/CR, DEL, C1, bidi, zero-width — String.raw for Biome. */
const UNSAFE_CONTROL_PATTERN = new RegExp(
  String.raw`[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]`,
  "gu",
);

/** Sensitive names whose following value is dropped along with the name. */
const SECRET_NAME_PATTERN =
  /\b(?:authorization|bearer|basic|cookie|set-cookie|x-api-key|api[_\- ]?key|apikey|access[_\- ]?token|refresh[_\- ]?token|id[_\- ]?token|token|secret|password|passwd|credential[s]?|signature|session[_\- ]?id|x-request-id|request[_\- ]?id|req[_\- ]?id|correlation[_\- ]?id|trace[_\- ]?id|organization|org[_\- ]?id|account[_\- ]?id|user[_\- ]?id)\b[\s:=]*["']?[^\s"',;)]*/giu;

/** URLs in any of the forms a provider error tends to carry. */
const URL_PATTERN = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|\/\/)[^\s"'<>]+/giu;

/** Absolute POSIX, home-relative, and Windows paths. */
const PATH_PATTERN = /(?:~|[A-Za-z]:\\|\/)[\w.\-\\/]*[\\/][\w.\-\\/]*/gu;

const EMAIL_PATTERN = /\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/gu;

const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;

/** Long opaque runs: keys, JWTs, request ids, hashes, base64 payloads. */
const OPAQUE_TOKEN_PATTERN = /\b[A-Za-z0-9_+/=-]{16,}\b/gu;

/** Any bracketed structure: nested provider JSON, arrays, HTML-ish markup. */
const STRUCTURE_PATTERN = /[{}[\]<>]/u;

/**
 * Keys that carry model input or output. Their presence means the raw value
 * mixes conversation content with the error, so free text is not preserved.
 */
const CONTENT_CARRIER_PATTERN =
  /"(?:content|prompt|completion|messages|choices|input|output|text|system|tools|arguments|thinking)"/iu;

/** Characters a preserved message may contain. Anything else is unprovable. */
const SAFE_MESSAGE_CHARSET = /^[A-Za-z0-9 .,;:!?'()%+-]+$/u;

const collapse = (value: string): string =>
  value
    .replace(/\s+/gu, " ")
    .trim()
    // A construct removed from the tail leaves a dangling separator behind.
    .replace(/[\s,;:.!?'()%+-]+$/u, "")
    .replace(/^[\s,;:.!?'()%+-]+/u, "")
    .trim();

/**
 * Strip every prohibited construct from a candidate string.
 *
 * Order matters: secrets and URLs are removed before the generic opaque-token
 * rule, so a named credential loses its name as well as its value.
 */
function stripProhibited(value: string): string {
  return collapse(
    value
      .replace(UNSAFE_CONTROL_PATTERN, " ")
      .replace(SECRET_NAME_PATTERN, " ")
      .replace(URL_PATTERN, " ")
      .replace(EMAIL_PATTERN, " ")
      .replace(PATH_PATTERN, " ")
      .replace(UUID_PATTERN, " ")
      .replace(OPAQUE_TOKEN_PATTERN, " ")
      .replace(/[{}[\]<>|$`\\/=*_~^]/gu, " "),
  );
}

/**
 * Innermost `"message"` string of a provider error envelope.
 *
 * Extraction runs only when the raw value looks like an error envelope
 * (`"type":"error"` or an `"error"` object) and carries no content-carrier key,
 * so conversation text is never mined for display copy.
 */
function envelopeMessage(raw: string): string | undefined {
  if (CONTENT_CARRIER_PATTERN.test(raw)) return undefined;
  const isErrorEnvelope =
    /"type"\s*:\s*"error"/iu.test(raw) || /"error"\s*:\s*[{"]/iu.test(raw);
  if (!isErrorEnvelope) return undefined;
  const matches = raw.matchAll(
    /"(?:message|detail|description)"\s*:\s*"((?:[^"\\]|\\.){0,512})"/giu,
  );
  let found: string | undefined;
  for (const match of matches) {
    const captured = match[1];
    if (captured !== undefined && captured.trim().length > 0) found = captured;
  }
  return found;
}

/**
 * The human message for one classified error.
 *
 * Preservation must be provable: the candidate has to come from an
 * unambiguous position, stay inside the candidate bound, survive stripping
 * with enough text left to be useful, and contain only the safe charset. Any
 * failure yields the canonical copy for the class, which is honest rather than
 * a truncated leak.
 */
function safeMessage(raw: string | undefined, cls: PiChildErrorClass): string {
  const canonical = CANONICAL_MESSAGE[cls];
  if (raw === undefined) return canonical;
  const scanned = raw.slice(0, MAX_CHILD_ERROR_SCAN_LENGTH);
  const envelope = envelopeMessage(scanned);
  const candidate =
    envelope ??
    (STRUCTURE_PATTERN.test(scanned) || CONTENT_CARRIER_PATTERN.test(scanned)
      ? undefined
      : scanned);
  if (candidate === undefined) return canonical;
  if (candidate.length > MAX_CHILD_ERROR_CANDIDATE_LENGTH) return canonical;

  const stripped = stripProhibited(candidate);
  if (stripped.length < 8) return canonical;
  if (stripped.length > MAX_CHILD_ERROR_MESSAGE_LENGTH) return canonical;
  if (!SAFE_MESSAGE_CHARSET.test(stripped)) return canonical;
  // A residue of only digits and punctuation carries no meaning and may be an
  // identifier remnant.
  if (!/[A-Za-z]{3,}/u.test(stripped)) return canonical;
  return stripped;
}

// ---------------------------------------------------------------------------
// Evidence extraction
// ---------------------------------------------------------------------------

/**
 * HTTP status from unambiguous evidence only.
 *
 * Accepted forms: a leading bare status (the provider-SDK convention, e.g.
 * `429 {"type":"error",...}`) and an explicitly marked status (`HTTP 503`,
 * `status: 500`, `statusCode=504`). Two different statuses in one value are
 * ambiguous, so nothing is reported.
 */
function httpStatusFrom(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const scanned = raw.slice(0, MAX_CHILD_ERROR_SCAN_LENGTH);
  const candidates = new Set<number>();
  const leading = /^\s*(\d{3})\b/u.exec(scanned);
  if (leading?.[1] !== undefined) candidates.add(Number(leading[1]));
  const marked = scanned.matchAll(
    /(?:https?\/[\d.]+\s+|\bhttp\s+|\bstatus(?:_?code)?\s*[:=]?\s*|"status"\s*:\s*)(\d{3})\b/giu,
  );
  for (const match of marked) {
    if (match[1] !== undefined) candidates.add(Number(match[1]));
  }
  const valid = [...candidates].filter(
    (status) =>
      status >= CHILD_PROVIDER_ERROR_BOUNDS.minHttpStatus &&
      status <= CHILD_PROVIDER_ERROR_BOUNDS.maxHttpStatus,
  );
  return valid.length === 1 ? valid[0] : undefined;
}

const SAFE_CODE_SET: ReadonlySet<string> = new Set(PI_CHILD_SAFE_ERROR_CODES);

/**
 * First allowlisted code token in the raw value, in canonical lowercase.
 *
 * Tokens are matched against the allowlist rather than read out of a code
 * field, so a provider that puts an account or request identifier in `code`
 * contributes nothing.
 */
function safeCodeFrom(
  raw: string | undefined,
): PiChildSafeErrorCode | undefined {
  if (raw === undefined) return undefined;
  const scanned = raw.slice(0, MAX_CHILD_ERROR_SCAN_LENGTH);
  const tokens = scanned.matchAll(/[A-Za-z][A-Za-z0-9_]{2,47}/gu);
  for (const token of tokens) {
    const normalized = token[0].toLowerCase();
    if (normalized.length > MAX_CHILD_ERROR_CODE_LENGTH) continue;
    if (SAFE_CODE_SET.has(normalized)) {
      return normalized as PiChildSafeErrorCode;
    }
  }
  return undefined;
}

const RATE_LIMIT_TEXT = /\brate[\s_-]?limit(?:ed|s)?\b|\btoo many requests\b/iu;
const AUTH_TEXT =
  /\bunauthori[sz]ed\b|\bforbidden\b|\binvalid api[\s_-]?key\b|\bauthentication (?:failed|error)\b|\bpermission denied\b|\bnot authori[sz]ed\b/iu;
const TIMEOUT_TEXT = /\btimed out\b|\btimeout\b|\bdeadline exceeded\b/iu;
const OVERLOAD_TEXT =
  /\boverloaded\b|\bservice unavailable\b|\bserver is busy\b|\btemporarily unavailable\b/iu;
const CONNECTION_TEXT =
  /\bconnection (?:reset|refused|closed|aborted|error|failure)\b|\bnetwork (?:error|failure|unreachable)\b|\bsocket hang up\b|\bfetch failed\b|\bdns\b|\bgetaddrinfo\b|\bunable to (?:connect|reach)\b/iu;
const CANCELLED_TEXT =
  /\b(?:request|operation) (?:was )?(?:cancell?ed|aborted)\b|\baborterror\b|\bcancell?ed by (?:the )?(?:user|caller)\b|\buser cancell?ed\b/iu;
const MALFORMED_TEXT =
  /\bmalformed\b|\bunexpected end of (?:json|input|stream)\b|\binvalid json\b|\bfailed to parse\b|\bunparsable\b|\bunexpected token\b|\binvalid response\b|\bschema validation failed\b/iu;

const CODE_CLASS: Readonly<Record<string, PiChildErrorClass>> = Object.freeze({
  rate_limit_error: "rate-limit",
  authentication_error: "auth",
  permission_error: "auth",
  invalid_api_key: "auth",
  timeout: "timeout",
  etimedout: "timeout",
  gateway_timeout: "timeout",
  overloaded_error: "overload",
  service_unavailable: "overload",
  econnreset: "connection",
  econnrefused: "connection",
  econnaborted: "connection",
  enotfound: "connection",
  eai_again: "connection",
  ehostunreach: "connection",
  enetunreach: "connection",
  epipe: "connection",
  abort_err: "cancelled",
  malformed_response: "malformed-response",
});

/**
 * Classify from unambiguous evidence only, in this pinned precedence:
 * rate-limit, auth, timeout, overload, connection, cancelled,
 * malformed-response, then provider-error when some failure evidence exists,
 * and finally unknown.
 *
 * Status and allowlisted code outrank free text within each class, and no
 * class is ever inferred from an absent fact.
 */
function classify(
  raw: string | undefined,
  status: number | undefined,
  code: PiChildSafeErrorCode | undefined,
): PiChildErrorClass {
  const text = raw?.slice(0, MAX_CHILD_ERROR_SCAN_LENGTH) ?? "";
  const codeClass = code === undefined ? undefined : CODE_CLASS[code];

  if (
    status === 429 ||
    codeClass === "rate-limit" ||
    RATE_LIMIT_TEXT.test(text)
  )
    return "rate-limit";
  if (
    status === 401 ||
    status === 403 ||
    codeClass === "auth" ||
    AUTH_TEXT.test(text)
  )
    return "auth";
  if (status === 504 || codeClass === "timeout" || TIMEOUT_TEXT.test(text))
    return "timeout";
  if (
    status === 503 ||
    status === 529 ||
    codeClass === "overload" ||
    OVERLOAD_TEXT.test(text)
  )
    return "overload";
  if (codeClass === "connection" || CONNECTION_TEXT.test(text))
    return "connection";
  if (codeClass === "cancelled" || CANCELLED_TEXT.test(text))
    return "cancelled";
  if (codeClass === "malformed-response" || MALFORMED_TEXT.test(text))
    return "malformed-response";
  if (status !== undefined || code !== undefined || text.trim().length > 0)
    return "provider-error";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

const build = (
  message: Record<string, unknown> | undefined,
  raw: string | undefined,
): Result<PiChildProviderError, PiChildProviderErrorAbsence> => {
  const status = httpStatusFrom(raw);
  const code = safeCodeFrom(raw);
  const cls = classify(raw, status, code);
  const projected: PiChildProviderError = {
    ...(label(field(message, "api")) === undefined
      ? {}
      : { source: label(field(message, "api")) }),
    ...(label(field(message, "provider")) === undefined
      ? {}
      : { provider: label(field(message, "provider")) }),
    ...(label(field(message, "responseModel") ?? field(message, "model")) ===
    undefined
      ? {}
      : {
          model: label(
            field(message, "responseModel") ?? field(message, "model"),
          ),
        }),
    class: cls,
    ...(status === undefined ? {} : { httpStatus: status }),
    ...(code === undefined ? {} : { code }),
    message: safeMessage(raw, cls),
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
 * {@link CHILD_PROVIDER_ERROR_REPLAY_FIELD}, and it is re-validated here so a
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
 * Project one assistant message into the bounded error model.
 *
 * `undefined` role is tolerated (some recorded shapes omit it), any other role
 * is not an authoritative terminal assistant message. A terminal message that
 * did not fail reports {@link PiChildProviderErrorAbsence} `ProviderErrorCleared`
 * so the holder can drop a stale error from an earlier turn.
 */
export function projectAssistantProviderError(
  message: unknown,
): Result<PiChildProviderError, PiChildProviderErrorAbsence> {
  const record = asRecord(message);
  if (record === undefined) return err(UNAVAILABLE);
  const role = field(record, "role");
  if (typeof role === "string" && role !== "assistant") return err(UNAVAILABLE);

  const carried = preProjected(record);
  if (carried !== undefined) return carried;

  const stopReason = field(record, "stopReason");
  if (typeof stopReason !== "string") return err(UNAVAILABLE);
  if (stopReason !== "error") return err(CLEARED);

  const raw = stringField(record, "errorMessage");
  return build(record, raw);
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
): Result<PiChildProviderError, PiChildProviderErrorAbsence> {
  if (event.type !== "message_end") return err(UNAVAILABLE);
  const record = event as unknown as Record<string, unknown>;
  return projectAssistantProviderError(field(record, "message"));
}

/**
 * Remove the raw provider error text from a terminal event and attach the
 * sanitized projection in its place.
 *
 * The controller stores parsed events in overlay entries and the transcript, so
 * an unredacted event would put `errorMessage` — and any credential, request
 * id, path, or payload inside it — straight into saved state. Redaction runs
 * before any downstream reduce, which makes the sanitized projection the only
 * error fact the overlay can ever hold. `rawStopReason` goes too: it is
 * unbounded provider text with no display value.
 *
 * Non-terminal events, and terminal events with no usable message, are
 * returned unchanged.
 */
export function redactProviderErrorFromEvent(
  event: PiChildSessionEvent,
): PiChildSessionEvent {
  if (event.type !== "message_end") return event;
  const record = event as unknown as Record<string, unknown>;
  const message = asRecord(field(record, "message"));
  if (message === undefined) return event;

  const copied = Result.fromThrowable(
    (): Record<string, unknown> => {
      const next: Record<string, unknown> = {};
      for (const key of Object.keys(message)) {
        if (key === "errorMessage" || key === "rawStopReason") continue;
        next[key] = field(message, key);
      }
      return next;
    },
    () => UNAVAILABLE,
  )();
  const projected = projectAssistantProviderError(message);
  const safeMessageRecord = copied.isOk()
    ? copied.value
    : // An exotic message that cannot even be enumerated keeps no host fields.
      { role: "assistant", stopReason: field(message, "stopReason") };

  return {
    ...event,
    message: {
      ...safeMessageRecord,
      ...(projected.isOk()
        ? { [CHILD_PROVIDER_ERROR_REPLAY_FIELD]: projected.value }
        : {}),
    },
  } as PiChildSessionEvent;
}

/**
 * The extra `message_end` fields a rebuilt historical assistant entry carries.
 *
 * One helper covers both projections a persisted assistant message can
 * contribute, so the rebuilt window reaches the same conclusions the live path
 * does: pi-ai usage accounting (`usage`, `model`) and the terminal outcome
 * (`stopReason` verbatim plus the sanitized error projection). The raw
 * `errorMessage` is deliberately left behind — it never enters overlay state.
 */
export function historicalAssistantMessageFields(
  message: unknown,
): Record<string, unknown> {
  const usage = projectAssistantUsageFacts(message);
  const facts = historicalProviderErrorFacts(message);
  return {
    ...(usage?.usage === undefined ? {} : { usage: usage.usage }),
    ...(usage?.model === undefined ? {} : { model: usage.model }),
    ...(facts === undefined ? {} : { stopReason: facts.stopReason }),
    ...(facts?.providerError === undefined
      ? {}
      : { [CHILD_PROVIDER_ERROR_REPLAY_FIELD]: facts.providerError }),
  };
}

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
 * Bounded, sanitized facts to attach to a rebuilt historical `message_end`.
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
  const record = asRecord(message);
  if (record === undefined) return undefined;
  const stopReason = StopReasonSchema.safeParse(field(record, "stopReason"));
  if (!stopReason.success) return undefined;
  const projected = projectAssistantProviderError(message);
  return {
    stopReason: stopReason.data,
    ...(projected.isOk() ? { providerError: projected.value } : {}),
  };
}
