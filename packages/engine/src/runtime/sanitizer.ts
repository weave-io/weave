/**
 * Descriptor-safe contracts for Runtime Journal and SessionSnapshot payloads.
 *
 * Callers can reach these APIs from adapters, tests, and persistence readers, so
 * their TypeScript types are not a trust boundary. The parser snapshots own
 * property descriptors once, rejects accessors and hostile graph topology, and
 * returns a fresh engine-owned JSON value. It never asks JSON.stringify to
 * inspect caller-owned objects.
 */

import { err, ok, Result, type Result as NeverthrowResult } from "neverthrow";
import type { RuntimeStoreError } from "./errors.js";
import { journalWriteError } from "./errors.js";
import type {
  JsonObject,
  JsonValue,
  SnapshotMetadata,
  SnapshotMetadataValue,
} from "./types.js";

// ---------------------------------------------------------------------------
// Denylist and bounds
// ---------------------------------------------------------------------------

/** Maximum object/array nesting depth accepted by runtime payloads. */
export const MAX_SANITIZATION_DEPTH = 10;
/** Maximum number of graph values visited by one payload. */
export const MAX_SANITIZATION_NODES = 2_048;
/** Maximum number of own properties visited by one payload. */
export const MAX_SANITIZATION_PROPERTIES = 4_096;
/** Maximum number of own properties on one object or array. */
export const MAX_SANITIZATION_PROPERTIES_PER_OBJECT = 512;
/** Maximum number of elements in one array. */
export const MAX_SANITIZATION_ARRAY_LENGTH = 1_024;
/** Maximum aggregate UTF-16 string units, including property names. */
export const MAX_SANITIZATION_STRING_LENGTH = 256 * 1024;

const DEPTH_LIMIT_EXCEEDED = "depth";
const GRAPH_LIMIT_EXCEEDED = "bounds";
const UNSAFE_GRAPH = "unsafe_graph";
const DENIED_FIELD = "denied_field";
const INVALID_METADATA = "invalid_metadata";

const DENIED_FIELD_NAMES: ReadonlySet<string> = new Set([
  // Auth / credential fields
  "token",
  "apikey",
  "api_key",
  "password",
  "secret",
  "authorization",
  "cookie",
  "bearer",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "clientsecret",
  "client_secret",
  "privatekey",
  "private_key",
  "auth",
  "credentials",
  "credential",
  // Raw content fields
  "prompt",
  "completion",
  "transcript",
  "rawprompt",
  "raw_prompt",
  "rawcompletion",
  "raw_completion",
  "rawtranscript",
  "raw_transcript",
  "systemprompt",
  "system_prompt",
  "userprompt",
  "user_prompt",
  "assistantmessage",
  "assistant_message",
]);

type InputTag =
  | "null"
  | "undefined"
  | "string"
  | "number"
  | "boolean"
  | "bigint"
  | "symbol"
  | "object"
  | "array"
  | "callable"
  | "other";

type SanitizerFailure = {
  readonly kind:
    | typeof DEPTH_LIMIT_EXCEEDED
    | typeof GRAPH_LIMIT_EXCEEDED
    | typeof UNSAFE_GRAPH
    | typeof DENIED_FIELD
    | typeof INVALID_METADATA;
  readonly key?: string;
};

type SanitizerContext = {
  readonly seen: WeakSet<object>;
  nodes: number;
  properties: number;
  stringLength: number;
};

const failure = (
  kind: SanitizerFailure["kind"],
  key?: string,
): SanitizerFailure =>
  key === undefined ? { kind } : { kind, key };

const inputTag = <T>(value: T): InputTag => {
  if (value === null) return "null";
  if (Object(value) === value) {
    if (Array.isArray(value)) return "array";
    const callable = Result.fromThrowable(
      () => Function.prototype.toString.call(value),
      () => "not-callable",
    )();
    return callable.isOk() ? "callable" : "object";
  }

  const tag = Result.fromThrowable(
    () => Object.prototype.toString.call(value),
    () => "[object Other]",
  )();
  if (tag.isErr()) return "other";
  switch (tag.value) {
    case "[object Undefined]":
      return "undefined";
    case "[object String]":
      return "string";
    case "[object Number]":
      return "number";
    case "[object Boolean]":
      return "boolean";
    case "[object BigInt]":
      return "bigint";
    case "[object Symbol]":
      return "symbol";
    default:
      return "other";
  }
};

const isObjectLike = <T>(value: T): value is T & object =>
  value !== null && value !== undefined && Object(value) === value;

const isJsonObject = (value: JsonValue): value is JsonObject =>
  isObjectLike(value) && !Array.isArray(value);

const isJsonString = (value: JsonValue): value is string =>
  inputTag(value) === "string";

const isJsonNumber = (value: JsonValue): value is number =>
  inputTag(value) === "number";

const isJsonBoolean = (value: JsonValue): value is boolean =>
  inputTag(value) === "boolean";

const deniedKey = (key: string): boolean =>
  DENIED_FIELD_NAMES.has(key.toLowerCase());

/** Check whether a field key is denied by the runtime persistence policy. */
export function isDeniedKey(key: string): boolean {
  return deniedKey(key);
}

const hasLoneSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
};

const consumeNode = (
  depth: number,
  context: SanitizerContext,
): NeverthrowResult<void, SanitizerFailure> => {
  if (depth > MAX_SANITIZATION_DEPTH)
    return err(failure(DEPTH_LIMIT_EXCEEDED));
  if (context.nodes >= MAX_SANITIZATION_NODES)
    return err(failure(GRAPH_LIMIT_EXCEEDED));
  context.nodes += 1;
  return ok();
};

const consumeProperties = (
  count: number,
  context: SanitizerContext,
): NeverthrowResult<void, SanitizerFailure> => {
  if (
    count > MAX_SANITIZATION_PROPERTIES ||
    context.properties > MAX_SANITIZATION_PROPERTIES - count
  ) {
    return err(failure(GRAPH_LIMIT_EXCEEDED));
  }
  context.properties += count;
  return ok();
};

const consumeString = (
  value: string,
  context: SanitizerContext,
): NeverthrowResult<void, SanitizerFailure> => {
  if (
    hasLoneSurrogate(value) ||
    value.length > MAX_SANITIZATION_STRING_LENGTH ||
    context.stringLength > MAX_SANITIZATION_STRING_LENGTH - value.length
  ) {
    return err(failure(GRAPH_LIMIT_EXCEEDED));
  }
  context.stringLength += value.length;
  return ok();
};

type DataPropertyDescriptor = PropertyDescriptor & {
  readonly value: unknown;
};

const ownDataDescriptor = (
  descriptor: PropertyDescriptor | undefined,
): descriptor is DataPropertyDescriptor =>
  descriptor !== undefined &&
  "value" in descriptor &&
  descriptor.enumerable === true;

/**
 * Copy one value without invoking caller-owned getters or retaining aliases.
 * The generic input keeps this function usable at an untyped caller boundary;
 * the returned value is always the closed Runtime JSON contract.
 */
function copyValue<T>(
  value: T,
  depth: number,
  context: SanitizerContext,
): NeverthrowResult<JsonValue, SanitizerFailure> {
  const node = consumeNode(depth, context);
  if (node.isErr()) return err(node.error);

  const tag = inputTag(value);
  if (tag === "null") return ok(null);
  if (tag === "string") {
    const text = String(value);
    const consumed = consumeString(text, context);
    if (consumed.isErr()) return err(consumed.error);
    return ok(text);
  }
  if (tag === "number") {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) return err(failure(UNSAFE_GRAPH));
    return ok(Object.is(numberValue, -0) ? 0 : numberValue);
  }
  if (tag === "boolean") return ok(value === true);
  if (tag !== "object" && tag !== "array") return err(failure(UNSAFE_GRAPH));
  if (!isObjectLike(value)) return err(failure(UNSAFE_GRAPH));
  if (context.seen.has(value)) return err(failure(UNSAFE_GRAPH));

  const prototype = Object.getPrototypeOf(value);
  if (tag === "array") {
    if (prototype !== Array.prototype) return err(failure(UNSAFE_GRAPH));
    return copyArray(value, depth, context);
  }
  if (prototype !== Object.prototype && prototype !== null)
    return err(failure(UNSAFE_GRAPH));
  return copyObject(value, depth, context);
}

function copyArray<T extends object>(
  source: T,
  depth: number,
  context: SanitizerContext,
): NeverthrowResult<JsonValue[], SanitizerFailure> {
  const keys = Reflect.ownKeys(source);
  if (keys.length > MAX_SANITIZATION_ARRAY_LENGTH + 1)
    return err(failure(GRAPH_LIMIT_EXCEEDED));

  const properties = consumeProperties(keys.length, context);
  if (properties.isErr()) return err(properties.error);
  const descriptors = new Map<string | symbol, PropertyDescriptor>();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined) return err(failure(UNSAFE_GRAPH));
    descriptors.set(key, descriptor);
  }

  const lengthDescriptor = descriptors.get("length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    lengthDescriptor.enumerable ||
    lengthDescriptor.configurable ||
    inputTag(lengthDescriptor.value) !== "number"
  ) {
    return err(failure(UNSAFE_GRAPH));
  }
  const length = Number(lengthDescriptor.value);
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_SANITIZATION_ARRAY_LENGTH ||
    keys.length !== length + 1
  ) {
    return err(failure(GRAPH_LIMIT_EXCEEDED));
  }

  const copy: JsonValue[] = [];
  context.seen.add(source);
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    const descriptor = descriptors.get(key);
    if (!ownDataDescriptor(descriptor)) return err(failure(UNSAFE_GRAPH));
    const child = copyValue(descriptor.value, depth + 1, context);
    if (child.isErr()) return err(child.error);
    copy.push(child.value);
  }
  for (const key of keys) {
    if (key === "length") continue;
    if (Object.prototype.toString.call(key) !== "[object String]")
      return err(failure(UNSAFE_GRAPH));
    if (!descriptors.has(key)) return err(failure(UNSAFE_GRAPH));
  }
  if (copy.length !== length) return err(failure(UNSAFE_GRAPH));
  return ok(copy);
}

function copyObject<T extends object>(
  source: T,
  depth: number,
  context: SanitizerContext,
): NeverthrowResult<JsonObject, SanitizerFailure> {
  const keys = Reflect.ownKeys(source);
  if (keys.length > MAX_SANITIZATION_PROPERTIES_PER_OBJECT)
    return err(failure(GRAPH_LIMIT_EXCEEDED));
  const properties = consumeProperties(keys.length, context);
  if (properties.isErr()) return err(properties.error);

  const copy: JsonObject = Object.create(null);
  context.seen.add(source);
  for (const key of keys) {
    if (Object.prototype.toString.call(key) !== "[object String]")
      return err(failure(UNSAFE_GRAPH));
    const text = String(key);
    const keyConsumed = consumeString(text, context);
    if (keyConsumed.isErr()) return err(keyConsumed.error);
    if (deniedKey(text)) return err(failure(DENIED_FIELD, text));
    const descriptor = Object.getOwnPropertyDescriptor(source, text);
    if (!ownDataDescriptor(descriptor)) return err(failure(UNSAFE_GRAPH));
    const child = copyValue(descriptor.value, depth + 1, context);
    if (child.isErr()) return err(child.error);
    Object.defineProperty(copy, text, {
      value: child.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return ok(copy);
}

const copyPayload = <T>(value: T): NeverthrowResult<JsonValue, SanitizerFailure> =>
  Result.fromThrowable(
    () =>
      copyValue(value, 0, {
        seen: new WeakSet<object>(),
        nodes: 0,
        properties: 0,
        stringLength: 0,
      }),
    () => failure(UNSAFE_GRAPH),
  )().andThen((result) => result);

const toJournalError = (
  label: string,
  problem: SanitizerFailure,
): RuntimeStoreError => {
  if (problem.kind === DENIED_FIELD) {
    return journalWriteError(
      `${label} contains a denied field: "${problem.key ?? "unknown"}". ` +
        "Raw prompts, completions, credentials, tokens, and secret-like fields must not be stored.",
    );
  }
  if (problem.kind === DEPTH_LIMIT_EXCEEDED) {
    return journalWriteError(
      `${label} exceeds the maximum nesting depth (${MAX_SANITIZATION_DEPTH}).`,
    );
  }
  if (problem.kind === GRAPH_LIMIT_EXCEEDED) {
    return journalWriteError(`${label} exceeds the bounded JSON graph limits.`);
  }
  if (problem.kind === INVALID_METADATA) {
    return journalWriteError(
      "Session snapshot metadata must contain only string, number, or boolean values.",
    );
  }
  return journalWriteError(`${label} contains an unsafe JSON value.`);
};

// ---------------------------------------------------------------------------
// Public owner contracts
// ---------------------------------------------------------------------------

/** Validate and copy a journal data payload at the persistence owner seam. */
export function sanitizeJournalData<T>(
  data: T,
): NeverthrowResult<JsonObject, RuntimeStoreError> {
  return copyPayload(data)
    .mapErr((problem) => toJournalError("Journal entry data", problem))
    .andThen((copied) => {
      if (!isJsonObject(copied)) {
        return err(journalWriteError("Journal entry data must be a JSON object."));
      }
      return ok(copied);
    });
}

/**
 * Validate and copy flat SessionSnapshot metadata.
 *
 * The graph parser still traverses nested values before the flat-contract
 * check. This makes aliases, cycles, accessors, proxies, and bounds fail
 * closed even when a hostile caller bypasses the TypeScript type.
 */
export function sanitizeSnapshotMetadata<T>(
  metadata: T,
): NeverthrowResult<SnapshotMetadata, RuntimeStoreError> {
  return copyPayload(metadata)
    .mapErr((problem) => toJournalError("Session snapshot metadata", problem))
    .andThen((copied) => {
      if (!isJsonObject(copied)) {
        return err(
          journalWriteError("Session snapshot metadata must be an object."),
        );
      }
      interface MutableSnapshotMetadata {
        [key: string]: SnapshotMetadataValue;
      }
      const output: MutableSnapshotMetadata = {};
      for (const key of Object.keys(copied)) {
        const value = copied[key];
        if (
          !isJsonString(value) &&
          !isJsonNumber(value) &&
          !isJsonBoolean(value)
        ) {
          return err(
            toJournalError("Session snapshot metadata", {
              kind: INVALID_METADATA,
            }),
          );
        }
        Object.defineProperty(output, key, {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return ok(output);
    });
}

// ---------------------------------------------------------------------------
// Safe size accounting
// ---------------------------------------------------------------------------

const escapeJsonString = (value: string): string => {
  let escaped = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22) escaped += '\\"';
    else if (code === 0x5c) escaped += "\\\\";
    else if (code === 0x08) escaped += "\\b";
    else if (code === 0x0c) escaped += "\\f";
    else if (code === 0x0a) escaped += "\\n";
    else if (code === 0x0d) escaped += "\\r";
    else if (code === 0x09) escaped += "\\t";
    else if (code < 0x20) {
      escaped += `\\u${code.toString(16).padStart(4, "0")}`;
    } else escaped += value[index];
  }
  return `${escaped}"`;
};

/** Measure a sanitized journal payload without touching caller-owned values. */
export function jsonUtf8ByteLength(value: JsonValue): number {
  if (value === null) return 4;
  if (isJsonString(value)) {
    return new TextEncoder().encode(escapeJsonString(value)).byteLength;
  }
  if (isJsonNumber(value)) return String(value).length;
  if (isJsonBoolean(value)) return value ? 4 : 5;
  if (Array.isArray(value)) {
    let total = 2;
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) total += 1;
      total += jsonUtf8ByteLength(value[index]);
    }
    return total;
  }
  if (!isJsonObject(value)) return 0;
  let total = 2;
  const keys = Object.keys(value);
  for (let index = 0; index < keys.length; index += 1) {
    if (index > 0) total += 1;
    const key = keys[index];
    total += new TextEncoder().encode(escapeJsonString(key)).byteLength;
    total += 1;
    total += jsonUtf8ByteLength(value[key]);
  }
  return total;
}
