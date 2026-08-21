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

import { err, ok, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import { type JsonValue, parseStrictJson } from "../strict-json.js";
import type {
  CodexFastAttempt,
  CodexFastEvidenceOutcome,
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

/** Maximum URL text accepted at the local fetch seam. */
const MAX_FETCH_INPUT_LENGTH = 65_536;

/** The body field the mapping owns. */
const SERVICE_TIER_FIELD = "service_tier";

/** The body field the routing hint must echo. */
const MODEL_FIELD = "model";

/** The transport the mapping forces, because it is the only provable one. */
const FORCED_TRANSPORT = "sse";

/** Maximum own fields copied from one host-owned options object. */
const MAX_HOST_RECORD_KEYS = 512;

/** Maximum request header entries accepted at this seam. */
const MAX_HEADER_ENTRIES = 256;

/** Maximum request header name length. */
const MAX_HEADER_NAME_LENGTH = 1_024;

/** Maximum request header value length. */
const MAX_HEADER_VALUE_LENGTH = 65_536;

/** Maximum own fields inspected while wrapping a provider. */
const MAX_PROVIDER_KEYS = 512;

/**
 * The only option fields a mapped call replaces. Every other field the caller
 * set is copied through by value and never rewritten.
 */
const INJECTED_OPTION_KEYS = ["onPayload", "transport", "fetch"] as const;

type InjectedOptionKey = (typeof INJECTED_OPTION_KEYS)[number];

/** A value at a host-owned boundary before this module parses its meaning. */
const HOST_INPUT_BOUNDARY = z.unknown();
type HostInput = z.input<typeof HOST_INPUT_BOUNDARY>;

/** An object reference accepted only at a descriptor-safe host seam. */
interface HostObjectReference {
  readonly hostObjectMarker?: never;
}

/** A host record whose fields remain opaque until a field-specific parser. */
type HostRecord = HostObjectReference;

/** The options object the native host accepts, with its injected fields added. */
interface MutableHostRecord extends HostRecord, RequestInit {
  onPayload?: HostInput;
  transport?: HostInput;
  fetch?: HostInput;
}

function isHostRecordValue(value: HostInput): value is HostRecord {
  if (value === null || Object(value) !== value || Array.isArray(value)) {
    return false;
  }
  return value instanceof Function === false;
}

const HOST_RECORD_SCHEMA = z.custom<HostRecord>(isHostRecordValue);

/** What one injected field held before this wrapper replaced it. */
type NativeOptionField =
  | {
      readonly key: InjectedOptionKey;
      readonly present: true;
      /** The caller's own data-property value. */
      readonly value: HostInput;
    }
  | {
      readonly key: InjectedOptionKey;
      readonly present: false;
    };

/** A host provider's stream call, kept opaque at this adapter boundary. */
type NativeStreamCall = (
  model: HostInput,
  context: HostInput,
  options?: HostInput,
) => HostInput;

/** Test callability without replacing the host's original function. */
function isHostCallable(value: HostInput): boolean {
  return Result.fromThrowable(
    () => value instanceof Function,
    (): boolean => false,
  )().unwrapOr(false);
}

const NATIVE_STREAM_SCHEMA = z.custom<NativeStreamCall>(
  (value: HostInput): boolean => isHostCallable(value),
);

type NativeStreams = {
  readonly stream: NativeStreamCall;
  readonly streamSimple: NativeStreamCall;
};

/** The input accepted by the host's fetch contract. */
const FETCH_INPUT_SCHEMA = z.union([
  z.string().max(MAX_FETCH_INPUT_LENGTH),
  z.instanceof(Request),
  z.instanceof(URL),
]);
type FetchInput = z.infer<typeof FETCH_INPUT_SCHEMA>;

/** The host's fetch init record; fields are parsed at the request seam. */
const FETCH_INIT_SCHEMA = z.custom<RequestInit>(isHostRecordValue);
type FetchInit = z.infer<typeof FETCH_INIT_SCHEMA>;

/** Parse a caller hook while keeping its payload opaque to this module. */
type OnPayload = (payload: HostInput, model: HostInput) => HostInput;
const ON_PAYLOAD_SCHEMA = z.custom<OnPayload>((value: HostInput): boolean =>
  isHostCallable(value),
);

/** Mutable holder for the callback installed before its abandon closure runs. */
interface OnPayloadHolder {
  value?: OnPayload;
}

/** Parse a fetch while preserving the host's original function identity. */
type FetchLike = (input: FetchInput, init?: FetchInit) => Promise<Response>;
const FETCH_SCHEMA = z.custom<FetchLike>((value: HostInput): boolean =>
  isHostCallable(value),
);

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
  readonly fast: HostInput;
  /** The owner's resolved model id, which the request model must equal. */
  readonly modelId: HostInput;
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

/** The minimum provider contract this adapter owns at the host boundary. */
export type CodexWrappableProvider = {
  readonly id: string;
  readonly name?: string;
  readonly stream: (...args: never[]) => HostInput;
  readonly streamSimple: (...args: never[]) => HostInput;
};

/** The only way wrapping itself can fail. */
export type CodexFastWrapError = {
  readonly kind: "provider-not-wrappable";
};

/** JSON-shaped records produced by the strict parser. */
type JsonRecord = { readonly [key: string]: JsonValue };

/** JSON objects only: the credential parser inspects no host object. */
function isJsonRecord(value: JsonValue): value is JsonRecord {
  return (
    value !== null && Object(value) === value && Array.isArray(value) === false
  );
}

/**
 * The strict plain-object test collision rule 6 requires. A class instance, an
 * array, a `null`-returning exotic object, or anything with a foreign
 * prototype is not a payload this wrapper will touch.
 */
function isPlainObject(value: HostInput): value is HostRecord {
  return Result.fromThrowable(
    () => {
      const parsed = HOST_RECORD_SCHEMA.safeParse(value);
      if (!parsed.success) {
        return false;
      }
      const prototype = Object.getPrototypeOf(parsed.data);
      if (prototype !== Object.prototype && prototype !== null) {
        return false;
      }
      const keys = Reflect.ownKeys(parsed.data);
      if (keys.length > MAX_HOST_RECORD_KEYS) {
        return false;
      }
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(parsed.data, key);
        if (descriptor === undefined || !("value" in descriptor)) {
          return false;
        }
      }
      return true;
    },
    () => false,
  )().unwrapOr(false);
}

/** Read one own data property without invoking an accessor. */
type HostPropertyReadError = "host-property-unreadable";

type HostPropertyRead =
  | { readonly kind: "missing" }
  | { readonly kind: "value"; readonly value: HostInput };

function readHostProperty(
  source: HostInput,
  key: PropertyKey,
): HostInput | undefined {
  const read = Result.fromThrowable(
    (): HostPropertyRead => {
      const parsed = HOST_RECORD_SCHEMA.safeParse(source);
      if (!parsed.success) {
        return { kind: "missing" };
      }
      const descriptor = Object.getOwnPropertyDescriptor(parsed.data, key);
      if (descriptor === undefined) {
        return { kind: "missing" };
      }
      if (!("value" in descriptor)) {
        throw new Error("host-property-unreadable");
      }
      return { kind: "value", value: descriptor.value };
    },
    (): HostPropertyReadError => "host-property-unreadable",
  )();
  if (read.isErr()) {
    throw new Error(read.error);
  }
  if (read.value.kind === "value") {
    return read.value.value;
  }
  return;
}

interface HeaderEntry {
  readonly name: string;
  readonly value: string | null;
}

type HeaderEntries = readonly HeaderEntry[];

const HEADER_NAME_SCHEMA = z.string().min(1).max(MAX_HEADER_NAME_LENGTH);
const HEADER_VALUE_SCHEMA = z.string().max(MAX_HEADER_VALUE_LENGTH);
const HEADER_VALUE_OR_DELETE_SCHEMA = z.union([HEADER_VALUE_SCHEMA, z.null()]);
type HeaderParseError = "invalid-request-headers";

function parseHeaderPair(value: HostInput): HeaderEntry {
  if (!Array.isArray(value)) {
    throw new Error("invalid-request-headers");
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    lengthDescriptor.value !== 2
  ) {
    throw new Error("invalid-request-headers");
  }
  const nameDescriptor = Object.getOwnPropertyDescriptor(value, "0");
  const valueDescriptor = Object.getOwnPropertyDescriptor(value, "1");
  if (
    nameDescriptor === undefined ||
    !("value" in nameDescriptor) ||
    valueDescriptor === undefined ||
    !("value" in valueDescriptor)
  ) {
    throw new Error("invalid-request-headers");
  }
  const name = HEADER_NAME_SCHEMA.safeParse(nameDescriptor.value);
  const headerValue = HEADER_VALUE_SCHEMA.safeParse(valueDescriptor.value);
  if (!name.success || !headerValue.success) {
    throw new Error("invalid-request-headers");
  }
  return { name: name.data, value: headerValue.data };
}

/** Parse headers by own data descriptors, never by invoking host accessors. */
function parseHeaderSource(
  value: HostInput,
): Result<HeaderEntries, HeaderParseError> {
  return Result.fromThrowable(
    (): HeaderEntries => {
      if (value === undefined) {
        return [];
      }
      if (value instanceof Headers) {
        const entries: HeaderEntry[] = [];
        const copied = new Headers(value);
        copied.forEach((headerValue, name) => {
          if (entries.length >= MAX_HEADER_ENTRIES) {
            throw new Error("invalid-request-headers");
          }
          const parsedName = HEADER_NAME_SCHEMA.safeParse(name);
          const parsedValue = HEADER_VALUE_SCHEMA.safeParse(headerValue);
          if (!parsedName.success || !parsedValue.success) {
            throw new Error("invalid-request-headers");
          }
          entries.push({ name: parsedName.data, value: parsedValue.data });
        });
        return entries;
      }
      if (Array.isArray(value)) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(
          value,
          "length",
        );
        if (
          lengthDescriptor === undefined ||
          !("value" in lengthDescriptor) ||
          !Number.isSafeInteger(lengthDescriptor.value) ||
          lengthDescriptor.value < 0 ||
          lengthDescriptor.value > MAX_HEADER_ENTRIES
        ) {
          throw new Error("invalid-request-headers");
        }
        const entries: HeaderEntry[] = [];
        for (let index = 0; index < lengthDescriptor.value; index += 1) {
          const pairDescriptor = Object.getOwnPropertyDescriptor(
            value,
            String(index),
          );
          if (pairDescriptor === undefined || !("value" in pairDescriptor)) {
            throw new Error("invalid-request-headers");
          }
          entries.push(parseHeaderPair(pairDescriptor.value));
        }
        return entries;
      }
      const record = HOST_RECORD_SCHEMA.safeParse(value);
      if (!record.success) {
        throw new Error("invalid-request-headers");
      }
      const names = Object.keys(record.data);
      if (names.length > MAX_HEADER_ENTRIES) {
        throw new Error("invalid-request-headers");
      }
      const entries: HeaderEntry[] = [];
      for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(record.data, name);
        if (descriptor === undefined || !("value" in descriptor)) {
          throw new Error("invalid-request-headers");
        }
        const parsedName = HEADER_NAME_SCHEMA.safeParse(name);
        const parsedValue = HEADER_VALUE_OR_DELETE_SCHEMA.safeParse(
          descriptor.value,
        );
        if (!parsedName.success || !parsedValue.success) {
          throw new Error("invalid-request-headers");
        }
        entries.push({ name: parsedName.data, value: parsedValue.data });
      }
      return entries;
    },
    (): HeaderParseError => "invalid-request-headers",
  )();
}

function createHeaders(
  entries: HeaderEntries,
  allowDelete: boolean,
): Result<Headers, HeaderParseError> {
  return Result.fromThrowable(
    (): Headers => {
      const headers = new Headers();
      for (const entry of entries) {
        if (entry.value === null) {
          if (!allowDelete) {
            throw new Error("invalid-request-headers");
          }
          headers.delete(entry.name);
          continue;
        }
        headers.set(entry.name, entry.value);
      }
      return headers;
    },
    (): HeaderParseError => "invalid-request-headers",
  )();
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
function hasPreexistingRoutingHint(
  model: HostInput,
  options: HostInput,
): Result<boolean, HeaderParseError> {
  const modelSource = parseHeaderSource(readHostProperty(model, "headers"));
  if (modelSource.isErr()) {
    return err(modelSource.error);
  }
  const additionalSource = parseHeaderSource(
    readHostProperty(options, "headers"),
  );
  if (additionalSource.isErr()) {
    return err(additionalSource.error);
  }
  const headers = createHeaders(modelSource.value, false);
  if (headers.isErr()) {
    return err(headers.error);
  }
  // The pinned host merges this source with `Object.entries`, which sees
  // nothing on a `Headers` instance, so a hint held this way would not
  // reach the wire today. It counts anyway: over-detecting costs one
  // unmapped call, while under-detecting costs a blocked one.
  for (const entry of additionalSource.value) {
    if (entry.value === null) {
      headers.value.delete(entry.name);
      continue;
    }
    headers.value.set(entry.name, "");
  }
  return ok(headers.value.has(CODEX_ROUTING_HINT_HEADER));
}

/**
 * Decide whether the resolved credential is a ChatGPT subscription token that
 * carries an account claim, mirroring what the host's own codex OAuth code
 * checks. Only the boolean leaves this function: neither the token nor the
 * account id is returned, stored, or logged.
 */
export function hasCodexSubscriptionAccountClaim(apiKey: HostInput): boolean {
  const parsedApiKey = z.string().max(MAX_CREDENTIAL_LENGTH).safeParse(apiKey);
  if (!parsedApiKey.success || parsedApiKey.data.length === 0) {
    return false;
  }
  const parts = parsedApiKey.data.split(".");
  if (parts.length !== 3) {
    return false;
  }
  const segment = parts[1];
  if (segment === undefined || segment.length === 0) {
    return false;
  }
  const decoded = Result.fromThrowable(
    () => {
      const normalized = segment.replaceAll("-", "+").replaceAll("_", "/");
      const padding = (4 - (normalized.length % 4)) % 4;
      return parseStrictJson(atob(normalized + "=".repeat(padding)));
    },
    (): void => {},
  )();
  if (decoded.isErr() || decoded.value.isErr()) {
    return false;
  }
  const claims = decoded.value.value;
  if (!isJsonRecord(claims)) {
    return false;
  }
  const auth = claims[CODEX_JWT_CLAIM_PATH];
  if (!isJsonRecord(auth)) {
    return false;
  }
  const accountId = z.string().min(1).safeParse(auth.chatgpt_account_id);
  return accountId.success;
}

/**
 * Record what the caller's own options held at each field this wrapper is
 * about to replace, reading the already-copied values by descriptor so a
 * caller accessor is not invoked a second time.
 */
type HostRecordCopyError = "host-record-unreadable";

const HOST_RECORD_COPY_ERROR: HostRecordCopyError = "host-record-unreadable";

function copyHostRecord(
  value: HostInput,
): Result<MutableHostRecord, HostRecordCopyError> {
  return Result.fromThrowable(
    (): MutableHostRecord => {
      if (value === undefined || value === null) {
        return {};
      }
      const parsed = HOST_RECORD_SCHEMA.safeParse(value);
      if (!parsed.success) {
        throw new Error(HOST_RECORD_COPY_ERROR);
      }
      const copy: MutableHostRecord = {};
      const keys = Reflect.ownKeys(parsed.data);
      if (keys.length > MAX_HOST_RECORD_KEYS) {
        throw new Error(HOST_RECORD_COPY_ERROR);
      }
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(parsed.data, key);
        if (descriptor === undefined) {
          continue;
        }
        if (!("value" in descriptor)) {
          throw new Error(HOST_RECORD_COPY_ERROR);
        }
        Object.defineProperty(copy, key, {
          value: descriptor.value,
          writable: true,
          enumerable: descriptor.enumerable,
          configurable: true,
        });
      }
      return copy;
    },
    (): HostRecordCopyError => HOST_RECORD_COPY_ERROR,
  )();
}

function captureNativeOptionFields(
  source: MutableHostRecord,
): readonly NativeOptionField[] {
  return INJECTED_OPTION_KEYS.map((key): NativeOptionField => {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return { key, present: false };
    }
    return { key, present: true, value: descriptor.value };
  });
}

/** Read one captured field without assuming the array's order. */
function nativeFieldValue(
  fields: readonly NativeOptionField[],
  key: InjectedOptionKey,
): HostInput | undefined {
  const field = fields.find((candidate) => candidate.key === key);
  if (field?.present === true) {
    return field.value;
  }
  return;
}

type InstalledOptionFields = {
  readonly onPayload: OnPayload;
  readonly transport: typeof FORCED_TRANSPORT;
  readonly fetch: FetchLike;
};

/**
 * Put one options view back to what the native path would have seen.
 *
 * The guard is identity, not shape: a target is considered this call's view
 * only while it still carries this call's own fetch wrapper, and each field is
 * rewritten only while it still carries that field's injected value. A caller
 * hook may use its receiver to replace or delete one of these fields; leaving
 * that field alone preserves the native callback semantics. A field the caller
 * never had is deleted
 * rather than set to `undefined`, because the host reads both the same way and
 * deleting is the one that leaves no trace of this wrapper behind.
 */
function restoreNativeOptionFields(
  target: HostInput,
  installed: InstalledOptionFields,
  fields: readonly NativeOptionField[],
): void {
  const parsed = HOST_RECORD_SCHEMA.safeParse(target);
  if (!parsed.success) {
    return;
  }
  const installedFetch = Object.getOwnPropertyDescriptor(parsed.data, "fetch");
  if (
    installedFetch === undefined ||
    !("value" in installedFetch) ||
    installedFetch.value !== installed.fetch
  ) {
    return;
  }
  for (const field of fields) {
    const current = Object.getOwnPropertyDescriptor(parsed.data, field.key);
    if (current === undefined || !("value" in current)) {
      continue;
    }
    let installedValue: HostInput;
    if (field.key === "onPayload") {
      installedValue = installed.onPayload;
    } else if (field.key === "transport") {
      installedValue = installed.transport;
    } else {
      installedValue = installed.fetch;
    }
    if (current.value !== installedValue) {
      continue;
    }
    if (field.present) {
      Object.defineProperty(parsed.data, field.key, {
        value: field.value,
        writable: true,
        enumerable: current.enumerable,
        configurable: true,
      });
      continue;
    }
    Reflect.deleteProperty(parsed.data, field.key);
  }
}

/**
 * A verdict shape the attempt machine cannot recognize, which is exactly how
 * rule 12 is expressed: a broken wrapper invariant terminates as `unsupported`
 * / `wrapper-degraded` instead of relaxing into a guess.
 */
const DEGRADED_VERDICT = Object.freeze({
  kind: "wrapper-degraded",
} as const);

/** One stream call's mutable, request-scoped facts. */
type CallState = {
  /** The final body's model id, once the payload step proved it. */
  finalModelId?: string;
  /** Whether that same body ended at `service_tier: "priority"`. */
  tierProven: boolean;
  /**
   * Whether *this wrapper* wrote that tier, as opposed to preserving one the
   * caller had already set. Only the former is unrollbackable damage: a tier
   * the caller owns is what the native path would have sent anyway.
   */
  tierWritten: boolean;
};

export function wrapCodexProviderForFast(
  native: CodexWrappableProvider,
  intentPort: CodexFastIntentPort,
  attemptSink: CodexFastAttemptSink,
): Result<CodexWrappableProvider, CodexFastWrapError> {
  const parsedStreams = Result.fromThrowable(
    (): NativeStreams => {
      const stream = NATIVE_STREAM_SCHEMA.safeParse(native.stream);
      const streamSimple = NATIVE_STREAM_SCHEMA.safeParse(native.streamSimple);
      if (!stream.success || !streamSimple.success) {
        throw new Error("provider-streams-unavailable");
      }
      return { stream: stream.data, streamSimple: streamSimple.data };
    },
    (): CodexFastWrapError => ({ kind: "provider-not-wrappable" }),
  )();
  if (parsedStreams.isErr()) {
    return err<CodexWrappableProvider, CodexFastWrapError>(parsedStreams.error);
  }
  const nativeStream = parsedStreams.value.stream;
  const nativeStreamSimple = parsedStreams.value.streamSimple;

  /** Report a snapshot. A throwing sink can never reach the stream. */
  function emit(attempt: CodexFastAttempt): void {
    Result.fromThrowable(
      () => {
        const snapshot = attempt.snapshot();
        if (snapshot !== undefined) {
          attemptSink.record(snapshot);
        }
      },
      (): void => {},
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
      (): void => {},
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
    model: HostInput,
    options: HostInput,
  ): Result<{ verdict: CodexFastEligibility; modelId: string }, void> {
    return Result.fromThrowable(
      () => {
        const intent = intentPort.readIntent();
        const fast = readHostProperty(intent, "fast");
        const modelId = readHostProperty(model, "id");
        const input = {
          providerId: native.id,
          fast,
          modelId,
          ownerModelId: readHostProperty(intent, "modelId"),
          baseUrl: readHostProperty(model, "baseUrl"),
          subscriptionAuthProven:
            fast === true &&
            hasCodexSubscriptionAccountClaim(
              readHostProperty(options, "apiKey"),
            ),
          collisionObserved: false,
        };
        const verdict = classifyCodexFastEligibility(input);
        let decided = verdict;
        if (verdict.kind === "eligible") {
          const preflight = hasPreexistingRoutingHint(model, options);
          if (preflight.isErr()) {
            throw new Error("codex-fast-header-preflight-failed");
          }
          if (preflight.value) {
            decided = classifyCodexFastEligibility({
              ...input,
              collisionObserved: true,
            });
          }
        }
        const parsedModelId = z.string().safeParse(modelId);
        return {
          verdict: decided,
          modelId: parsedModelId.success ? parsedModelId.data : "",
        };
      },
      (): void => {},
    )();
  }

  /**
   * Apply collision rule 6 to the final body. Nothing here reads a value
   * through an accessor: every field is examined by descriptor, so a getter
   * trap planted by another extension is detected instead of invoked.
   */
  type PayloadDecision =
    | { readonly decision: "collision" }
    | {
        readonly decision: "priority-set" | "priority-preserved";
        readonly modelId: string;
      };

  function decidePayload(
    payload: HostInput,
    expectedModelId: string,
  ): PayloadDecision {
    const decided = Result.fromThrowable(
      (): PayloadDecision => {
        if (!isPlainObject(payload)) {
          return { decision: "collision" };
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
          return { decision: "collision" };
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
            return {
              decision: "priority-preserved",
              modelId: expectedModelId,
            };
          }
          return { decision: "collision" };
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
          return { decision: "collision" };
        }
        return { decision: "priority-set", modelId: expectedModelId };
      },
      (): void => {},
    )();
    if (decided.isErr()) {
      return { decision: "collision" };
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
    | { readonly kind: "activated"; readonly init: MutableHostRecord };

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
    init: FetchInit | undefined,
    state: CallState,
  ): Result<HeaderPlan, void> {
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
        const copied = copyHostRecord(init);
        if (copied.isErr()) {
          return { kind: "unavailable" };
        }
        const headerSource = parseHeaderSource(
          readHostProperty(init, "headers"),
        );
        if (headerSource.isErr()) {
          return { kind: "unavailable" };
        }
        const parsedHeaders = createHeaders(headerSource.value, false);
        if (parsedHeaders.isErr()) {
          return { kind: "unavailable" };
        }
        const headers = parsedHeaders.value;
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
        copied.value.headers = headers;
        return { kind: "activated", init: copied.value };
      },
      (): void => {},
    )();
  }

  /** Whether a rejection is the caller's abort rather than a transport fault. */
  function isAbort(error: HostInput, init: FetchInit | undefined): boolean {
    return Result.fromThrowable(
      (): boolean => {
        const signal = z
          .instanceof(AbortSignal)
          .safeParse(readHostProperty(init, "signal"));
        if (signal.success && signal.data.aborted) {
          return true;
        }
        return z
          .literal("AbortError")
          .safeParse(readHostProperty(error, "name")).success;
      },
      () => false,
    )().unwrapOr(false);
  }

  function isTimeout(error: HostInput): boolean {
    return Result.fromThrowable(
      (): boolean =>
        z.literal("TimeoutError").safeParse(readHostProperty(error, "name"))
          .success,
      () => false,
    )().unwrapOr(false);
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
    const observed = Result.fromThrowable(
      (): Response => {
        const body = response.body;
        if (
          body === null ||
          body.locked ||
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
            // response is this call's final attempt and its evidence is the
            // one the terminal snapshot must carry.
            emitTerminal(attempt);
          },
        });
        if (sniffer.isErr()) {
          record("inaccessible");
          emit(attempt);
          return response;
        }
        return new Response(body.pipeThrough(sniffer.value), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
      (): Response => {
        record("inaccessible");
        emit(attempt);
        return response;
      },
    )();
    if (observed.isErr()) {
      return observed.error;
    }
    return observed.value;
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
    async function decline(
      input: FetchInput,
      init?: FetchInit,
    ): Promise<Response> {
      if (state.tierWritten) {
        throw blockedRequestError();
      }
      const sent = await ResultAsync.fromThrowable(
        () => baseFetch(input, init),
        (error: HostInput) => error,
      )();
      if (sent.isErr()) {
        throw sent.error;
      }
      return sent.value;
    }

    return async (input: FetchInput, init?: FetchInit): Promise<Response> => {
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
        return decline(input, init);
      }
      if (plan.value.kind !== "activated") {
        attempt.degrade();
        emit(attempt);
        return decline(input, init);
      }
      attempt.activateHeaders({ originator: true, routingHint: true });
      emit(attempt);
      const activatedPlan = plan.value;
      const sent = await ResultAsync.fromThrowable(
        () => baseFetch(input, activatedPlan.init),
        (error: HostInput) => error,
      )();
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
    callerOnPayload: OnPayload | undefined,
    attempt: CodexFastAttempt,
    state: CallState,
    modelId: string,
    abandon: (receiver: HostInput) => void,
  ): OnPayload {
    // A method, not an arrow: the host calls the hook as
    // `options?.onPayload?.(body, model)`, so `this` is the options object it
    // is reading from, which on the `streamSimple` path is not the object
    // this wrapper prepared.
    return async function chainedOnPayload(
      this: HostInput,
      payload: HostInput,
      model: HostInput,
    ): Promise<HostInput> {
      let next = payload;
      if (callerOnPayload !== undefined) {
        // `fromThrowable`, not `fromPromise`: the caller's hook may throw
        // synchronously before any promise exists.
        const called = await ResultAsync.fromThrowable(
          async (
            nextPayload: HostInput,
            nextModel: HostInput,
          ): Promise<HostInput> =>
            await callerOnPayload.call(this, nextPayload, nextModel),
          (error: HostInput) => error,
        )(payload, model);
        if (called.isErr()) {
          // The native path would have failed here too. Abandon the mapping
          // and let the caller's own failure through unchanged.
          attempt.degrade();
          emit(attempt);
          abandon(this);
          throw called.error;
        }
        if (called.value !== undefined) {
          next = called.value;
        }
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

  function parseOnPayload(value: HostInput): OnPayload | undefined {
    if (value === undefined || value === null) {
      return;
    }
    const parsed = ON_PAYLOAD_SCHEMA.safeParse(value);
    if (parsed.success) {
      return parsed.data;
    }
    throw new Error("host-on-payload-unavailable");
  }

  function parseFetch(value: HostInput): FetchLike | undefined {
    if (value === undefined || value === null) {
      return;
    }
    const parsed = FETCH_SCHEMA.safeParse(value);
    if (parsed.success) {
      return parsed.data;
    }
    throw new Error("host-fetch-unavailable");
  }

  /** One wrapped entry point. `stream` and `streamSimple` differ only here. */
  function wrapCall(nativeCall: NativeStreamCall): NativeStreamCall {
    return (
      model: HostInput,
      context: HostInput,
      options?: HostInput,
    ): HostInput => {
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
      const prepared = copyHostRecord(options).andThen((source) =>
        Result.fromThrowable(
          (): MutableHostRecord => {
            const state: CallState = {
              tierProven: false,
              tierWritten: false,
            };
            const nativeFields = captureNativeOptionFields(source);
            const callerFetch = nativeFieldValue(nativeFields, "fetch");
            const baseFetch =
              callerFetch === undefined || callerFetch === null
                ? parseFetch(globalThis.fetch)
                : parseFetch(callerFetch);
            if (baseFetch === undefined) {
              throw new Error(HOST_RECORD_COPY_ERROR);
            }
            const wrapperFetch = createWrapperFetch(baseFetch, attempt, state);
            const onPayloadHolder: OnPayloadHolder = {};
            const abandon = (receiver: HostInput): void => {
              // Restoring is best effort by construction: a host that read the
              // transport before the hook, or handed the hook a receiver this
              // wrapper never prepared, leaves nothing to put back. Each
              // injected field is restored only if the caller hook left the
              // wrapper's value in place.
              const installedOnPayload = onPayloadHolder.value;
              if (installedOnPayload === undefined) {
                return;
              }
              const installed: InstalledOptionFields = {
                onPayload: installedOnPayload,
                transport: FORCED_TRANSPORT,
                fetch: wrapperFetch,
              };
              Result.fromThrowable(
                () => {
                  restoreNativeOptionFields(source, installed, nativeFields);
                  if (receiver !== source) {
                    restoreNativeOptionFields(
                      receiver,
                      installed,
                      nativeFields,
                    );
                  }
                },
                (): void => {},
              )();
            };
            const chainedOnPayload = createChainedOnPayload(
              parseOnPayload(nativeFieldValue(nativeFields, "onPayload")),
              attempt,
              state,
              modelId,
              abandon,
            );
            onPayloadHolder.value = chainedOnPayload;
            source.onPayload = chainedOnPayload;
            source.transport = FORCED_TRANSPORT;
            source.fetch = wrapperFetch;
            return source;
          },
          (): HostRecordCopyError => HOST_RECORD_COPY_ERROR,
        )(),
      );
      if (prepared.isErr()) {
        attempt.degrade();
        emitTerminal(attempt);
        return nativeCall.call(native, model, context, options);
      }
      return nativeCall.call(native, model, context, prepared.value);
    };
  }

  return Result.fromThrowable(
    (): CodexWrappableProvider => {
      const shell: CodexWrappableProvider = {
        id: native.id,
        stream: wrapCall(nativeStream),
        streamSimple: wrapCall(nativeStreamSimple),
      };
      Object.setPrototypeOf(shell, Object.getPrototypeOf(native));
      const keys = Reflect.ownKeys(native);
      if (keys.length > MAX_PROVIDER_KEYS) {
        throw new Error("provider-keys-unbounded");
      }
      for (const key of keys) {
        if (key === "stream" || key === "streamSimple") {
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(native, key);
        if (descriptor === undefined) {
          continue;
        }
        Object.defineProperty(shell, key, descriptor);
      }
      return shell;
    },
    (): CodexFastWrapError => ({ kind: "provider-not-wrappable" }),
  )();
}
