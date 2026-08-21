import { err, ok, Result } from "neverthrow";
import { snapshotArrayOnce } from "./array-snapshot.js";
import type {
  GrantablePermissionRequest,
  JsonValue,
  PermissionCapability,
  PermissionDisplay,
  PermissionError,
  PermissionRequest,
  PermissionTarget,
} from "./types.js";

const encoder = new TextEncoder();
export const MAX_DEPTH = 64;
export const MAX_CANONICAL_BYTES = 1_048_576;
/** Fail-fast cap on array elements before any length-driven allocation. */
export const MAX_ARRAY_ELEMENTS = MAX_CANONICAL_BYTES;
const MAX_NODES = 16_384;
const MAX_PROPERTIES = 4_096;
const MAX_PROPERTIES_PER_OBJECT = 512;
const MAX_STRING_LENGTH = 256 * 1024;
const CONSTRAINT_BYTES = 16_384;

const capabilities: readonly PermissionCapability[] = [
  "read",
  "write",
  "execute",
  "delegate",
  "network",
];
const requestKeys = [
  "unresolved",
  "capability",
  "operation",
  "target",
  "constraints",
  "display",
] as const;

type JsonRecord = { readonly [key: string]: JsonValue };
type ObjectLike<T> = T & object;
type PrimitiveTag =
  | "null"
  | "undefined"
  | "string"
  | "number"
  | "boolean"
  | "bigint"
  | "symbol"
  | "object";
type CopyContext = {
  readonly seen: Set<object>;
  nodes: number;
  properties: number;
  stringLength: number;
};
type MutablePermissionDisplay = { summary: string; details?: string };
type MutableGrantableRequest = {
  unresolved: false;
  capability: PermissionCapability;
  operation: string;
  target: PermissionTarget;
  display: PermissionDisplay;
  constraints?: JsonValue;
};
type AuthorizationFields = {
  readonly unresolved: false;
  readonly capability: PermissionCapability;
  readonly operation: string;
  readonly target: PermissionTarget;
  readonly constraints?: JsonValue;
};
type MutableAuthorizationFields = {
  unresolved: false;
  capability: PermissionCapability;
  operation: string;
  target: PermissionTarget;
  constraints?: JsonValue;
};

const unsafe = (path: string, message: string): PermissionError => ({
  type: "unsafe_input",
  path,
  message,
});
const invalid = (message: string): PermissionError => ({
  type: "invalid_output",
  message,
});
const opaqueObjectPath = (path: string): string => `${path}.object`;
const compareCodeUnits = (a: string, b: string): number => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

const primitiveTag = <T>(value: T): PrimitiveTag => {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Object(value) === value) return "object";
  const tagged = Result.fromThrowable(
    () => Object.prototype.toString.call(value),
    () => "[object Object]",
  )();
  if (tagged.isErr()) return "object";
  if (tagged.value === "[object String]") return "string";
  if (tagged.value === "[object Number]") return "number";
  if (tagged.value === "[object Boolean]") return "boolean";
  if (tagged.value === "[object BigInt]") return "bigint";
  if (tagged.value === "[object Symbol]") return "symbol";
  return "object";
};

const isObjectLike = <T>(value: T): value is ObjectLike<T> =>
  value !== null && value !== undefined && Object(value) === value;

const isCallable = <T>(value: T): boolean =>
  Result.fromThrowable(
    () => Function.prototype.toString.call(value),
    () => false,
  )().isOk();

const isJsonRecord = (value: JsonValue): value is JsonRecord =>
  Object(value) === value && !Array.isArray(value);

const isCapability = <T>(value: T): value is T & PermissionCapability =>
  primitiveTag(value) === "string" &&
  capabilities.some((item) => item === String(value));

const loneSurrogate = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= value.length) return true;
      const next = value.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      i += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
};

const completed = (): Result<void, PermissionError> => ok(void 0);

const consumeNode = (
  depth: number,
  context: CopyContext,
): Result<void, PermissionError> => {
  if (depth > MAX_DEPTH || context.nodes >= MAX_NODES)
    return err(unsafe("$", "JSON graph exceeds its bounds"));
  context.nodes += 1;
  return completed();
};

const consumeProperties = (
  count: number,
  context: CopyContext,
): Result<void, PermissionError> => {
  if (count > MAX_PROPERTIES || context.properties > MAX_PROPERTIES - count)
    return err(unsafe("$", "JSON graph exceeds its bounds"));
  context.properties += count;
  return completed();
};

const consumeString = (
  value: string,
  context: CopyContext,
): Result<void, PermissionError> => {
  if (
    value.length > MAX_STRING_LENGTH ||
    context.stringLength > MAX_STRING_LENGTH - value.length
  )
    return err(unsafe("$", "JSON graph exceeds its bounds"));
  context.stringLength += value.length;
  return completed();
};

function copyJson<T>(
  value: T,
  path: string,
  context: CopyContext,
  depth: number,
): Result<JsonValue, PermissionError> {
  const node = consumeNode(depth, context);
  if (node.isErr()) return err(node.error);
  const tag = primitiveTag(value);
  if (tag === "undefined" || tag === "bigint" || tag === "symbol")
    return err(unsafe(path, "unsupported value"));
  if (tag === "string") {
    const text = String(value);
    if (loneSurrogate(text)) return err(unsafe(path, "lone surrogate"));
    const consumed = consumeString(text, context);
    if (consumed.isErr())
      return err(unsafe(path, "JSON graph exceeds its bounds"));
    return ok(text);
  }
  if (tag === "number") {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue))
      return err(unsafe(path, "non-finite number"));
    return ok(Object.is(numberValue, -0) ? 0 : numberValue);
  }
  if (tag === "boolean") return ok(value === true);
  if (tag === "null") return ok(null);
  if (!isObjectLike(value)) return err(unsafe(path, "unsupported value"));
  if (isCallable(value)) return err(unsafe(path, "unsupported callable"));
  if (context.seen.has(value))
    return err(unsafe(path, "cyclic or aliased value"));

  const prototype = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  if (prototype !== Object.prototype && prototype !== null && !array)
    return err(unsafe(path, "unsupported object prototype"));

  if (array) {
    const snapshot = snapshotArrayOnce(value);
    if (snapshot.isErr()) return err(unsafe(path, "invalid array"));
    const properties = consumeProperties(snapshot.value.length + 1, context);
    if (properties.isErr()) return err(properties.error);
    context.seen.add(value);
    const result: JsonValue[] = [];
    for (let index = 0; index < snapshot.value.length; index += 1) {
      const descriptor = snapshot.value[index];
      if (descriptor === undefined) return err(unsafe(path, "invalid array"));
      const child = copyJson(
        descriptor.value,
        `${path}[${index}]`,
        context,
        depth + 1,
      );
      if (child.isErr()) return err(child.error);
      result.push(child.value);
    }
    return ok(Object.freeze(result));
  }

  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_PROPERTIES_PER_OBJECT)
    return err(unsafe(path, "object exceeds its property bound"));
  const properties = consumeProperties(keys.length, context);
  if (properties.isErr()) return err(properties.error);
  context.seen.add(value);

  const result: JsonRecord = Object.create(null);
  const descriptors = new Map<string, PropertyDescriptor>();
  for (const key of keys) {
    if (Object.prototype.toString.call(key) !== "[object String]")
      return err(unsafe(path, "unexpected symbol key"));
    const text = String(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, text);
    if (descriptor === undefined)
      return err(unsafe(path, "missing own descriptor"));
    descriptors.set(text, descriptor);
  }
  const stringKeys = [...descriptors.keys()].sort(compareCodeUnits);
  for (const key of stringKeys) {
    const descriptor = descriptors.get(key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    )
      return err(unsafe(path, "accessor or non-enumerable property"));
    const child = copyJson(
      descriptor.value,
      opaqueObjectPath(path),
      context,
      depth + 1,
    );
    if (child.isErr()) return err(child.error);
    Object.defineProperty(result, key, {
      value: child.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return ok(Object.freeze(result));
}

/** Clone untrusted JSON without invoking accessors or retaining its prototype. */
export function cloneAndFreezeJson<T>(
  value: T,
): Result<JsonValue, PermissionError> {
  return Result.fromThrowable(
    () =>
      copyJson(
        value,
        "$",
        {
          seen: new Set<object>(),
          nodes: 0,
          properties: 0,
          stringLength: 0,
        },
        0,
      ),
    () => unsafe("$", "unsafe JSON input"),
  )().andThen((result) => result);
}
export const cloneAndFreeze = cloneAndFreezeJson;
export const cloneFreeze = cloneAndFreezeJson;

export function utf8Bytes(
  value: string,
  max: number,
): Result<Uint8Array, PermissionError> {
  const bytes = encoder.encode(value);
  return bytes.byteLength > max
    ? err(invalid(`value exceeds ${max} UTF-8 bytes`))
    : ok(bytes);
}

function serialize(value: JsonValue): string {
  if (value === null) return "null";
  const tag = primitiveTag(value);
  if (tag === "boolean") return value === true ? "true" : "false";
  if (tag === "number") return JSON.stringify(value === 0 ? 0 : value);
  if (tag === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  if (!isJsonRecord(value)) return "null";
  const keys = Object.keys(value).sort(compareCodeUnits);
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${serialize(value[key])}`)
    .join(",")}}`;
}

export function canonicalizeJson<T>(value: T): Result<string, PermissionError> {
  return Result.fromThrowable(
    () => {
      const safe = cloneAndFreezeJson(value);
      if (safe.isErr()) return err(safe.error);
      const text = serialize(safe.value);
      return encoder.encode(text).byteLength > MAX_CANONICAL_BYTES
        ? err(
            unsafe("$", `canonical input exceeds ${MAX_CANONICAL_BYTES} bytes`),
          )
        : ok(text);
    },
    () => unsafe("$", "unsafe JSON input"),
  )().andThen((result) => result);
}

export const canonicalPermissionJson = <T>(
  value: T,
): Result<string, PermissionError> => canonicalizeJson(value);

export function permissionDigest<T>(value: T): Result<string, PermissionError> {
  return canonicalPermissionJson(value).andThen((json) =>
    Result.fromThrowable(
      () =>
        new Bun.CryptoHasher("sha256")
          .update(encoder.encode(json))
          .digest("hex"),
      () => invalid("SHA-256 digest failed"),
    )(),
  );
}

const stringField = <T>(
  value: T,
  max: number,
  path: string,
): Result<string, PermissionError> => {
  if (primitiveTag(value) !== "string")
    return err(invalid(`${path} must be a valid non-empty string`));
  const text = String(value);
  if (text.length === 0 || loneSurrogate(text))
    return err(invalid(`${path} must be a valid non-empty string`));
  return utf8Bytes(text, max).map(() => text);
};

const defaultIgnorable = /^\p{Default_Ignorable_Code_Point}$/u;
const unsafeDisplayCodePoint = (character: string, code: number): boolean =>
  code <= 0x1f ||
  (code >= 0x7f && code <= 0x9f) ||
  code === 0x2028 ||
  code === 0x2029 ||
  defaultIgnorable.test(character) ||
  code === 0x115f ||
  code === 0x1160 ||
  code === 0x3164 ||
  code === 0xffa0 ||
  code === 0x2800;

function safeDisplayText<T>(
  value: T,
  max: number,
  field: string,
): Result<string, PermissionError> {
  if (primitiveTag(value) !== "string")
    return err(invalid(`invalid permission display ${field}`));
  const text = String(value);
  if ((text.length === 0 && field === "summary") || loneSurrogate(text))
    return err(invalid(`invalid permission display ${field}`));
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code === undefined || unsafeDisplayCodePoint(character, code))
      return err(invalid(`invalid permission display ${field}`));
  }
  return utf8Bytes(text, max).map(() => text);
}

function snapshotRecord<T>(
  value: T,
  path: string,
  allowed: readonly string[],
  required: readonly string[],
): Result<JsonRecord, PermissionError> {
  return cloneAndFreezeJson(value).andThen((copied) => {
    if (!isJsonRecord(copied))
      return err(unsafe(path, "value must be a plain object"));
    const keys = Object.keys(copied);
    if (keys.length < required.length || keys.length > allowed.length)
      return err(unsafe(path, "unexpected property"));
    const allowedSet = new Set(allowed);
    for (const key of keys) {
      if (!allowedSet.has(key)) return err(unsafe(path, "unexpected property"));
    }
    for (const key of required) {
      if (!Object.hasOwn(copied, key))
        return err(unsafe(path, "missing property"));
    }
    return ok(copied);
  });
}

/** Validate and copy user-facing permission text without invoking accessors. */
export function sanitizePermissionDisplay<T>(
  value: T,
): Result<PermissionDisplay, PermissionError> {
  return snapshotRecord(
    value,
    "display",
    ["summary", "details"],
    ["summary"],
  ).andThen((fields) => {
    const summary = safeDisplayText(fields.summary, 256, "summary");
    if (summary.isErr()) return err(summary.error);
    const details = Object.hasOwn(fields, "details")
      ? safeDisplayText(fields.details, 2048, "details")
      : ok("");
    if (details.isErr()) return err(details.error);
    const display: MutablePermissionDisplay = { summary: summary.value };
    if (details.value.length > 0) display.details = details.value;
    return ok(Object.freeze(display));
  });
}

function normalizeCapturedRequests(
  input: readonly PropertyDescriptor[],
): Result<readonly PermissionRequest[], PermissionError> {
  if (input.length === 0)
    return err({
      type: "empty_output",
      message: "at least one permission request is required",
    });
  const output: PermissionRequest[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const raw = input[i].value;
    const rd = snapshotRecord(raw, `requests[${i}]`, requestKeys, []);
    if (rd.isErr()) return err(rd.error);
    const display = sanitizePermissionDisplay(rd.value.display);
    if (display.isErr()) return err(display.error);
    if (rd.value.unresolved === true) {
      if (
        Object.hasOwn(rd.value, "capability") ||
        Object.hasOwn(rd.value, "operation") ||
        Object.hasOwn(rd.value, "target") ||
        Object.hasOwn(rd.value, "constraints")
      )
        return err(invalid("unresolved request has grantable fields"));
      output.push(Object.freeze({ unresolved: true, display: display.value }));
      continue;
    }
    const capability = rd.value.capability;
    if (rd.value.unresolved !== false || !isCapability(capability))
      return err(invalid("invalid capability or unresolved flag"));
    const target = snapshotRecord(
      rd.value.target,
      "target",
      ["kind", "identifier"],
      ["kind", "identifier"],
    );
    if (target.isErr()) return err(target.error);
    const operation = stringField(rd.value.operation, 128, "operation");
    const kind = stringField(target.value.kind, 64, "kind");
    const identifier = stringField(target.value.identifier, 2048, "identifier");
    if (operation.isErr()) return err(operation.error);
    if (kind.isErr()) return err(kind.error);
    if (identifier.isErr()) return err(identifier.error);
    let constraints: JsonValue | undefined;
    if (Object.hasOwn(rd.value, "constraints")) {
      const cloned = cloneAndFreezeJson(rd.value.constraints);
      if (cloned.isErr()) return err(invalid("invalid permission constraints"));
      const canonical = canonicalPermissionJson(cloned.value);
      if (canonical.isErr())
        return err(invalid("invalid permission constraints"));
      if (encoder.encode(canonical.value).byteLength > CONSTRAINT_BYTES)
        return err(invalid("constraints exceed 16384 UTF-8 bytes"));
      constraints = cloned.value;
    }
    const request: MutableGrantableRequest = {
      unresolved: false,
      capability,
      operation: operation.value,
      target: {
        kind: kind.value,
        identifier: identifier.value,
      },
      display: display.value,
    };
    if (constraints !== undefined) request.constraints = constraints;
    output.push(Object.freeze(request));
  }
  return ok(Object.freeze(output));
}

/** Normalize resolver output after a one-shot descriptor array snapshot. */
export function normalizePermissionRequests<T>(
  input: readonly T[],
): Result<readonly PermissionRequest[], PermissionError> {
  const snapshotted = snapshotArrayOnce(input).mapErr(() =>
    invalid("invalid permission resolver output"),
  );
  if (snapshotted.isErr()) return err(snapshotted.error);
  if (snapshotted.value.length < 1)
    return err({
      type: "empty_output",
      message: "at least one permission request is required",
    });
  return Result.fromThrowable(
    () => normalizeCapturedRequests(snapshotted.value),
    () => invalid("invalid permission resolver output"),
  )()
    .andThen((result) => result)
    .mapErr((error) => {
      if (error.type === "empty_output" || error.type === "invalid_output")
        return error;
      return invalid("invalid permission resolver output");
    });
}

export const validateRequests = normalizePermissionRequests;
export const validateRequest = <T>(
  request: T,
): Result<PermissionRequest, PermissionError> =>
  normalizePermissionRequests([request]).andThen((items) => {
    const first = items[0];
    if (first !== undefined) return ok(first);
    return err({
      type: "empty_output" as const,
      message: "request missing",
    });
  });

const authorizationFields = (
  request: GrantablePermissionRequest,
): AuthorizationFields => {
  const fields: MutableAuthorizationFields = {
    unresolved: false,
    capability: request.capability,
    operation: request.operation,
    target: request.target,
  };
  if (request.constraints !== undefined)
    fields.constraints = request.constraints;
  return fields;
};

export const requestKey = (
  request: PermissionRequest,
): Result<string, PermissionError> =>
  validateRequest(request).andThen((normalized) => {
    if (normalized.unresolved)
      return err(invalid("unresolved request has no grant key"));
    return permissionDigest(authorizationFields(normalized));
  });

export const requestBindingKey = (
  request: PermissionRequest,
): Result<string, PermissionError> =>
  validateRequest(request).andThen((normalized) =>
    permissionDigest(
      normalized.unresolved
        ? { unresolved: true, display: normalized.display }
        : authorizationFields(normalized),
    ),
  );
