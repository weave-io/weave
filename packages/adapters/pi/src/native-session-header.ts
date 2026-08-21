/**
 * The one strict, complete Pi v3 session-header validator (Spec 33
 * path-session design §5.2).
 *
 * Every lifecycle path that trusts a session header - create, the reopen that
 * follows an exclusive header persist, the host-backed open used by thread
 * leaf establishment and restore, the descriptor-safe read of an on-disk
 * session file, and the launch-grant mint - validates through this module and
 * nothing else. Before it existed, three different checks disagreed: the host
 * adapter copied a header strictly, the store's `persistableHostHeader`
 * repeated a subset of those rules, and the read/reopen path accepted any
 * object whose `id` was a non-empty string. A hostile or merely unknown host
 * could therefore be refused at create and accepted at reopen.
 *
 * A header is accepted only when it is a *plain data object* carrying exactly
 * Pi's supported v3 fields:
 *
 * - the prototype is `Object.prototype` or `null` (no class instance, no
 *   exotic or proxied prototype chain, so no inherited field can be read as
 *   if the host had written it),
 * - it has no own symbol keys,
 * - every own key - enumerable or not - is a supported field, so a hidden
 *   non-enumerable `toJSON`, a shadowed `constructor`, or an unknown field
 *   this adapter has never validated is a refusal rather than a silent drop,
 * - every own key is a data descriptor; an accessor is never invoked,
 * - `type`, `version`, `id`, `timestamp`, and `cwd` are present with Pi's
 *   exact types and bounds, and `parentSession`, when present, is a bounded
 *   string.
 *
 * The returned header is a frozen plain object copied in the *host's own key
 * order*, so the deferred-header bridge can persist bytes identical to the
 * ones Pi generated. Nothing here repairs, renames, reorders, or invents a
 * field: an unusable header is a typed refusal.
 */

import { err, ok, Result } from "neverthrow";
import { z } from "zod";
import type { PiNativeSessionHeader } from "./child-native-session-contracts.js";

/**
 * Header fields this adapter reads from a native Pi v3 session, as reported
 * by a host that has not been validated yet. Every field is optional here
 * precisely because an unvalidated host may omit or mistype any of them;
 * {@link validatePiNativeSessionHeader} is what turns one of these into a
 * {@link PiValidatedSessionHeader}.
 */
export type { PiNativeSessionHeader } from "./child-native-session-contracts.js";

/** A field name in the host-owned Pi header contract. */
type PiNativeSessionHeaderFieldName = keyof PiNativeSessionHeader;

/**
 * A complete, strictly validated Pi v3 session header. Only
 * {@link validatePiNativeSessionHeader} produces one, and only from a header
 * that satisfied every rule in this module.
 */
export interface PiValidatedSessionHeader {
  readonly type: "session";
  readonly version: 3;
  readonly id: string;
  readonly timestamp: string;
  readonly cwd: string;
  readonly parentSession?: string;
}

/** Why one header was refused. Bounded and path-free. */
export type PiNativeSessionHeaderViolation =
  /**
   * Not an object, an array, carrying an exotic/class prototype, or an exotic
   * object whose own reflection traps (`getPrototypeOf`, `ownKeys`,
   * `getOwnPropertyDescriptor`) threw instead of answering.
   */
  | "not-plain-object"
  /** An own symbol key, an accessor, or a non-enumerable own property. */
  | "unsafe-descriptor"
  /** An own key outside Pi's supported v3 field set. */
  | "unknown-field"
  /** A required field is absent or explicitly `undefined`. */
  | "missing-field"
  | "invalid-type"
  | "unsupported-version"
  | "invalid-id"
  | "invalid-timestamp"
  | "invalid-cwd"
  | "invalid-parent-session";

/** Pi's supported v3 required fields, in Pi's own emission order. */
export const PI_SESSION_HEADER_REQUIRED_FIELDS = [
  "type",
  "version",
  "id",
  "timestamp",
  "cwd",
] as const;

/** The only field Pi may omit: a root session has no parent link. */
export const PI_SESSION_HEADER_OPTIONAL_FIELDS = ["parentSession"] as const;

const SUPPORTED_HEADER_FIELDS: ReadonlySet<string> = new Set<string>([
  ...PI_SESSION_HEADER_REQUIRED_FIELDS,
  ...PI_SESSION_HEADER_OPTIONAL_FIELDS,
]);

/** Bound on one header string value, so a hostile host cannot flood memory. */
export const MAX_SESSION_HEADER_STRING_LENGTH = 4_096;

/** Pi `Date.prototype.toISOString()` shape; never synthesized by the adapter. */
const HOST_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const BOUNDED_HEADER_STRING = z
  .string()
  .min(1)
  .max(MAX_SESSION_HEADER_STRING_LENGTH)
  .refine((value) => !value.includes("\0"));

/** Values returned by a descriptor before the header field parser narrows it. */
type HeaderFieldValue =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | object;

/** A raw own data field captured without reading through the host object. */
interface RawHeaderField {
  readonly key: PiNativeSessionHeaderFieldName;
  readonly value: HeaderFieldValue;
}

interface ValidatedHeaderFields {
  readonly type: "session";
  readonly version: 3;
  readonly id: string;
  readonly timestamp: string;
  readonly cwd: string;
  readonly parentSession: string;
}

interface MutableHeaderCopy {
  type: "session";
  version: 3;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession: string;
}

type HeaderField = {
  [K in PiNativeSessionHeaderFieldName]: {
    readonly key: K;
    readonly value: ValidatedHeaderFields[K];
  };
}[PiNativeSessionHeaderFieldName];

/**
 * Every reflection this module performs runs through one of these throwing
 * boundaries. A hostile proxy can make `getPrototypeOf`, `ownKeys`,
 * `getOwnPropertyDescriptor`, or a descriptor's own accessors throw, and a
 * validator that reflects directly would propagate that throw out of a
 * `Result`-returning function. Here every trap failure is a typed refusal.
 */
function reflectPrototypeOf<TObject extends object>(
  candidate: TObject,
): Result<object | null, PiNativeSessionHeaderViolation> {
  return Result.fromThrowable(
    () => Object.getPrototypeOf(candidate),
    (): PiNativeSessionHeaderViolation => "not-plain-object",
  )();
}

function reflectOwnKeys<TObject extends object>(
  candidate: TObject,
): Result<readonly (string | symbol)[], PiNativeSessionHeaderViolation> {
  return Result.fromThrowable(
    () => Reflect.ownKeys(candidate),
    (): PiNativeSessionHeaderViolation => "not-plain-object",
  )();
}

function reflectOwnDescriptor<TObject extends object>(
  candidate: TObject,
  key: string,
): Result<PropertyDescriptor | undefined, PiNativeSessionHeaderViolation> {
  return Result.fromThrowable(
    () => Object.getOwnPropertyDescriptor(candidate, key),
    (): PiNativeSessionHeaderViolation => "unsafe-descriptor",
  )();
}

function reflectIsArray<TObject extends object>(
  candidate: TObject,
): Result<boolean, PiNativeSessionHeaderViolation> {
  return Result.fromThrowable(
    () => Array.isArray(candidate),
    (): PiNativeSessionHeaderViolation => "not-plain-object",
  )();
}

/**
 * A generic reference guard keeps the unparsed caller boundary intact while
 * giving the descriptor reflection helpers the object contract they need.
 */
function isObjectReference<TValue>(value: TValue): value is TValue & object {
  return value !== null && Object(value) === value;
}

/** Own property keys are strings or symbols; this preserves that distinction. */
function isStringPropertyKey(value: string | symbol): value is string {
  return String(value) === value;
}

function isSupportedHeaderFieldName(
  value: string,
): value is PiNativeSessionHeaderFieldName {
  return SUPPORTED_HEADER_FIELDS.has(value);
}

function boundedHeaderString<TValue>(value: TValue): string | undefined {
  const parsed = BOUNDED_HEADER_STRING.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** True for Pi's exact `toISOString()` shape and a real calendar instant. */
export function isHostIsoTimestamp(value: string): boolean {
  if (!HOST_ISO_TIMESTAMP.test(value)) return false;
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) return false;
  return new Date(milliseconds).toISOString() === value;
}

function parseHeaderField<TValue>(
  key: PiNativeSessionHeaderFieldName,
  value: TValue,
): Result<HeaderField, PiNativeSessionHeaderViolation> {
  switch (key) {
    case "type":
      return value === "session"
        ? ok({ key: "type", value: "session" })
        : err("invalid-type");
    case "version":
      return value === 3
        ? ok({ key: "version", value: 3 })
        : err("unsupported-version");
    case "id": {
      const id = boundedHeaderString(value);
      return id === undefined
        ? err("invalid-id")
        : ok({ key: "id", value: id });
    }
    case "timestamp": {
      const timestamp = boundedHeaderString(value);
      return timestamp === undefined || !isHostIsoTimestamp(timestamp)
        ? err("invalid-timestamp")
        : ok({ key: "timestamp", value: timestamp });
    }
    case "cwd": {
      const cwd = boundedHeaderString(value);
      return cwd === undefined
        ? err("invalid-cwd")
        : ok({ key: "cwd", value: cwd });
    }
    case "parentSession": {
      const parentSession = boundedHeaderString(value);
      return parentSession === undefined
        ? err("invalid-parent-session")
        : ok({ key: "parentSession", value: parentSession });
    }
    default:
      return err("unknown-field");
  }
}

/**
 * Validates one candidate session header completely and returns a frozen copy
 * in the host's own key order.
 *
 * The generic input boundary intentionally accepts values from an injected
 * host port, `JSON.parse` of on-disk bytes, and other adapter code. None of
 * those sources may be trusted to have been checked already, so this module
 * performs the reference, prototype, descriptor, and field checks itself.
 */
export function validatePiNativeSessionHeader<TCandidate>(
  candidate: TCandidate,
): Result<PiValidatedSessionHeader, PiNativeSessionHeaderViolation> {
  if (!isObjectReference(candidate)) return err("not-plain-object");

  const array = reflectIsArray(candidate);
  if (array.isErr()) return err(array.error);
  if (array.value) return err("not-plain-object");
  const prototype = reflectPrototypeOf(candidate);
  if (prototype.isErr()) return err(prototype.error);
  if (prototype.value !== null && prototype.value !== Object.prototype) {
    return err("not-plain-object");
  }

  // `Reflect.ownKeys` also reports non-enumerable and symbol own keys, so a
  // hidden `toJSON`, a shadowed `constructor`, or any other invisible field
  // is a refusal instead of a field this adapter silently drops while
  // persisting bytes it believes it validated. One `ownKeys` call answers
  // both the symbol question and the string-key question, so a proxy cannot
  // report different key sets to two separate reflections.
  const ownKeys = reflectOwnKeys(candidate);
  if (ownKeys.isErr()) return err(ownKeys.error);
  const keys = ownKeys.value.filter(isStringPropertyKey);
  if (keys.length !== ownKeys.value.length) return err("unsafe-descriptor");

  // Values come from the own data descriptors read here, never from property
  // access on the caller's object: no `get` trap and no accessor ever runs.
  const rawFields: RawHeaderField[] = [];
  for (const key of keys) {
    const descriptor = reflectOwnDescriptor(candidate, key);
    if (descriptor.isErr()) return err(descriptor.error);
    const own = descriptor.value;
    if (own === undefined) return err("unsafe-descriptor");
    if (!Object.hasOwn(own, "value")) return err("unsafe-descriptor");
    if (!own.enumerable) return err("unsafe-descriptor");
    if (!isSupportedHeaderFieldName(key)) return err("unknown-field");
    rawFields.push({ key, value: own.value });
  }

  for (const field of PI_SESSION_HEADER_REQUIRED_FIELDS) {
    const raw = rawFields.find(
      (candidateField) => candidateField.key === field,
    );
    if (raw === undefined || raw.value === undefined)
      return err("missing-field");
  }

  const fields: HeaderField[] = [];
  for (const raw of rawFields) {
    const parsed = parseHeaderField(raw.key, raw.value);
    if (parsed.isErr()) return err(parsed.error);
    fields.push(parsed.value);
  }

  // Copied in the host's own key order so the persisted bytes stay identical
  // to the header Pi generated.
  const copied: Partial<MutableHeaderCopy> = {};
  for (const field of fields) {
    switch (field.key) {
      case "type":
        copied.type = field.value;
        break;
      case "version":
        copied.version = field.value;
        break;
      case "id":
        copied.id = field.value;
        break;
      case "timestamp":
        copied.timestamp = field.value;
        break;
      case "cwd":
        copied.cwd = field.value;
        break;
      case "parentSession":
        copied.parentSession = field.value;
        break;
    }
  }
  const frozenCopy = Object.freeze(copied);
  // SAFETY: the required-field loop and parseHeaderField prove that every
  // required property exists with its exact validated value; parentSession is
  // either a validated string or absent. The loop above copies each accepted
  // field in the host's own key order.
  return ok(frozenCopy as PiValidatedSessionHeader);
}

/**
 * True when two validated headers name the same session identity. Used to
 * prove a reopened session is still the one that was created, and that a
 * launch grant is minted against the identity the store validated.
 */
export function validatedHeadersMatch(
  left: PiValidatedSessionHeader,
  right: PiValidatedSessionHeader,
): boolean {
  return (
    left.type === right.type &&
    left.version === right.version &&
    left.id === right.id &&
    left.cwd === right.cwd &&
    left.timestamp === right.timestamp &&
    left.parentSession === right.parentSession
  );
}
