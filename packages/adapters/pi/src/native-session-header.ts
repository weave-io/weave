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

/**
 * Header fields this adapter reads from a native Pi v3 session, as reported
 * by a host that has not been validated yet. Every field is optional here
 * precisely because an unvalidated host may omit or mistype any of them;
 * {@link validatePiNativeSessionHeader} is what turns one of these into a
 * {@link PiValidatedSessionHeader}.
 */
export interface PiNativeSessionHeader {
  readonly id: string;
  readonly cwd: string;
  /** Native entry discriminator; Pi always emits `"session"`. */
  readonly type?: string;
  readonly version?: number;
  /** Host-generated ISO-8601 creation timestamp. Never synthesized here. */
  readonly timestamp?: string;
  readonly parentSession?: string;
}

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

/**
 * Every reflection this module performs runs through one of these throwing
 * boundaries. A hostile proxy can make `getPrototypeOf`, `ownKeys`,
 * `getOwnPropertyDescriptor`, or a descriptor's own accessors throw, and a
 * validator that reflects directly would propagate that throw out of a
 * `Result`-returning function. Here every trap failure is a typed refusal.
 */
const reflectPrototypeOf = Result.fromThrowable(
  (candidate: object): object | null =>
    Object.getPrototypeOf(candidate) as object | null,
  (): PiNativeSessionHeaderViolation => "not-plain-object",
);

const reflectOwnKeys = Result.fromThrowable(
  (candidate: object): readonly (string | symbol)[] =>
    Reflect.ownKeys(candidate),
  (): PiNativeSessionHeaderViolation => "not-plain-object",
);

const reflectOwnDescriptor = Result.fromThrowable(
  (candidate: object, key: string): PropertyDescriptor | undefined =>
    Object.getOwnPropertyDescriptor(candidate, key),
  (): PiNativeSessionHeaderViolation => "unsafe-descriptor",
);

const reflectIsArray = Result.fromThrowable(
  (candidate: object): boolean => Array.isArray(candidate),
  (): PiNativeSessionHeaderViolation => "not-plain-object",
);

/**
 * One own field, read from its own data descriptor and never by property
 * access. A caller property is never touched directly, so no `get` trap and
 * no inherited accessor can ever run.
 */
interface OwnDataField {
  readonly key: string;
  readonly value: unknown;
}

function isBoundedHeaderString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SESSION_HEADER_STRING_LENGTH &&
    !value.includes("\0")
  );
}

/** True for Pi's exact `toISOString()` shape and a real calendar instant. */
export function isHostIsoTimestamp(value: string): boolean {
  if (!HOST_ISO_TIMESTAMP.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

/**
 * Validates one candidate session header completely and returns a frozen copy
 * in the host's own key order.
 *
 * Accepts `unknown` on purpose: callers receive headers from an injected host
 * port, from `JSON.parse` of on-disk bytes, and from other adapter code, and
 * none of those sources may be trusted to have been checked already.
 */
export function validatePiNativeSessionHeader(
  candidate: unknown,
): Result<PiValidatedSessionHeader, PiNativeSessionHeaderViolation> {
  if (typeof candidate !== "object" || candidate === null) {
    return err("not-plain-object");
  }
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
  if (ownKeys.value.some((key) => typeof key === "symbol")) {
    return err("unsafe-descriptor");
  }
  const keys = ownKeys.value.filter(
    (key): key is string => typeof key === "string",
  );

  // Values come from the own data descriptors read here, never from property
  // access on the caller's object: no `get` trap and no accessor ever runs.
  const fields: OwnDataField[] = [];
  for (const key of keys) {
    const descriptor = reflectOwnDescriptor(candidate, key);
    if (descriptor.isErr()) return err(descriptor.error);
    const own = descriptor.value;
    if (own === undefined) return err("unsafe-descriptor");
    if (!("value" in own)) return err("unsafe-descriptor");
    if (!own.enumerable) return err("unsafe-descriptor");
    if (!SUPPORTED_HEADER_FIELDS.has(key)) return err("unknown-field");
    fields.push({ key, value: own.value });
  }

  const source = new Map<string, unknown>(
    fields.map((field) => [field.key, field.value]),
  );
  for (const field of PI_SESSION_HEADER_REQUIRED_FIELDS) {
    if (!source.has(field)) return err("missing-field");
    if (source.get(field) === undefined) return err("missing-field");
  }

  const timestamp = source.get("timestamp");
  if (source.get("type") !== "session") return err("invalid-type");
  if (source.get("version") !== 3) return err("unsupported-version");
  if (!isBoundedHeaderString(source.get("id"))) return err("invalid-id");
  if (!isBoundedHeaderString(timestamp)) return err("invalid-timestamp");
  if (!isHostIsoTimestamp(timestamp)) return err("invalid-timestamp");
  if (!isBoundedHeaderString(source.get("cwd"))) return err("invalid-cwd");
  if (
    source.has("parentSession") &&
    !isBoundedHeaderString(source.get("parentSession"))
  ) {
    return err("invalid-parent-session");
  }

  // Copied in the host's own key order so the persisted bytes stay identical
  // to the header Pi generated.
  const copied: Record<string, unknown> = {};
  for (const field of fields) copied[field.key] = field.value;
  return ok(Object.freeze(copied) as unknown as PiValidatedSessionHeader);
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
