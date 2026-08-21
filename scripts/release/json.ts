import { err, ok, Result } from "neverthrow";

export type JsonPrimitive = string | number | boolean | null;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonParseError {
  readonly type: "JsonParseError";
  readonly message: string;
}

export type JsonCanonicalizationReason =
  | "unsupported-value"
  | "non-finite-number"
  | "cyclic-value"
  | "unsafe-object"
  | "canonicalization-failed"
  | "digest-failed";

export interface JsonCanonicalizationError {
  readonly type: "JsonCanonicalizationError";
  readonly reason: JsonCanonicalizationReason;
  readonly message: string;
}

function canonicalizationMessage(reason: JsonCanonicalizationReason): string {
  switch (reason) {
    case "unsupported-value":
      return "value is not representable as JSON";
    case "non-finite-number":
      return "number is not finite";
    case "cyclic-value":
      return "value contains a cycle";
    case "unsafe-object":
      return "object is not a bounded JSON object";
    case "canonicalization-failed":
      return "canonical JSON serialization failed";
    case "digest-failed":
      return "JSON digest failed";
  }
}

const canonicalizationError = (
  reason: JsonCanonicalizationReason,
): JsonCanonicalizationError => ({
  type: "JsonCanonicalizationError",
  reason,
  message: canonicalizationMessage(reason),
});

/**
 * Parses JSON into the bounded value contract used by release boundaries.
 *
 * JSON.parse returns an unchecked value. The validation pass below also rejects
 * non-finite numbers (for example, JSON.parse("1e400") produces Infinity),
 * unsafe object graphs, and values that cannot be represented by JsonValue.
 */
export function parseJsonValue(
  text: string,
): Result<JsonValue, JsonParseError | JsonCanonicalizationError> {
  return Result.fromThrowable(
    () => JSON.parse(text),
    (cause): JsonParseError => ({
      type: "JsonParseError",
      message: cause instanceof Error ? cause.message : String(cause),
    }),
  )().andThen((value) => validateJsonValue(value));
}

type PrimitiveTag =
  | "null"
  | "undefined"
  | "string"
  | "number"
  | "boolean"
  | "bigint"
  | "symbol"
  | "function"
  | "object";

type ObjectLike<T> = T & object;

function isObjectLike<T>(value: T): value is ObjectLike<T> {
  return value !== null && value !== undefined && Object(value) === value;
}

function isCallable<T>(value: T): boolean {
  return Result.fromThrowable(
    () => Function.prototype.toString.call(value),
    () => false,
  )().isOk();
}

function primitiveTag<T>(value: T): PrimitiveTag {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (isObjectLike(value)) return isCallable(value) ? "function" : "object";
  const tagged = Result.fromThrowable(
    () => Object.prototype.toString.call(value),
    () => "[object Unknown]",
  )();
  const text = tagged.isOk() ? tagged.value : "[object Unknown]";
  if (text === "[object String]") return "string";
  if (text === "[object Number]") return "number";
  if (text === "[object Boolean]") return "boolean";
  if (text === "[object BigInt]") return "bigint";
  if (text === "[object Symbol]") return "symbol";
  return "object";
}

/** Validates and copies a value into the bounded JsonValue contract. */
export function validateJsonValue<T>(
  value: T,
): Result<JsonValue, JsonCanonicalizationError> {
  return validateValue(value, new Set<object>());
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return primitiveTag(value) === "object" && !Array.isArray(value);
}

export function isJsonString(value: JsonValue): value is string {
  return primitiveTag(value) === "string";
}

export function isJsonBoolean(value: JsonValue): value is boolean {
  return primitiveTag(value) === "boolean";
}

function validateValue<T>(
  value: T,
  ancestors: Set<object>,
): Result<JsonValue, JsonCanonicalizationError> {
  const tag = primitiveTag(value);
  if (tag === "null") return ok(null);
  if (tag === "string") return ok(String(value));
  if (tag === "boolean") return ok(value === true);
  if (tag === "number") {
    const numberValue = Number(value);
    return Number.isFinite(numberValue)
      ? ok(Object.is(numberValue, -0) ? 0 : numberValue)
      : err(canonicalizationError("non-finite-number"));
  }
  if (
    tag === "undefined" ||
    tag === "bigint" ||
    tag === "symbol" ||
    tag === "function"
  )
    return err(canonicalizationError("unsupported-value"));
  if (!isObjectLike(value)) return err(canonicalizationError("unsafe-object"));
  if (ancestors.has(value)) return err(canonicalizationError("cyclic-value"));

  return Result.fromThrowable(
    () => {
      ancestors.add(value);
      const result = Array.isArray(value)
        ? validateArray(value, ancestors)
        : validateObject(value, ancestors);
      ancestors.delete(value);
      return result;
    },
    () => canonicalizationError("unsafe-object"),
  )().andThen((result) => result);
}

function validateArray<T>(
  value: readonly T[],
  ancestors: Set<object>,
): Result<JsonValue, JsonCanonicalizationError> {
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    primitiveTag(lengthDescriptor.value) !== "number" ||
    !Number.isSafeInteger(Number(lengthDescriptor.value)) ||
    Number(lengthDescriptor.value) < 0
  )
    return err(canonicalizationError("unsafe-object"));

  const length = Number(lengthDescriptor.value);
  const keys = Reflect.ownKeys(value);
  const entries = new Map<number, T>();
  for (const key of keys) {
    if (key === "length") continue;
    if (primitiveTag(key) !== "string")
      return err(canonicalizationError("unsafe-object"));
    const index = Number(key);
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      String(index) !== key ||
      index >= length
    )
      return err(canonicalizationError("unsafe-object"));
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    )
      return err(canonicalizationError("unsafe-object"));
    entries.set(index, descriptor.value);
  }

  if (entries.size !== length)
    return err(canonicalizationError("unsafe-object"));

  const copied: JsonValue[] = [];
  for (let index = 0; index < length; index += 1) {
    const child = validateValue(entries.get(index), ancestors);
    if (child.isErr()) return err(child.error);
    copied.push(child.value);
  }
  return ok(Object.freeze(copied));
}

function validateObject<T extends object>(
  value: T,
  ancestors: Set<object>,
): Result<JsonValue, JsonCanonicalizationError> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return err(canonicalizationError("unsafe-object"));

  const entries: Array<[string, JsonValue]> = [];
  for (const key of Reflect.ownKeys(value)) {
    if (primitiveTag(key) !== "string")
      return err(canonicalizationError("unsafe-object"));
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    )
      return err(canonicalizationError("unsafe-object"));
    const child = validateValue(descriptor.value, ancestors);
    if (child.isErr()) return err(child.error);
    entries.push([String(key), child.value]);
  }
  return ok(copyJsonObject(entries));
}

function copyJsonObject(entries: readonly [string, JsonValue][]): JsonObject {
  const copy: JsonObject = Object.create(null);
  for (const [key, child] of entries)
    Object.defineProperty(copy, key, {
      value: child,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  return copy;
}

function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isJsonObject(value)) return value;
  return copyJsonObject(
    Object.keys(value)
      .sort()
      .map((key): [string, JsonValue] => [key, sortJsonValue(value[key])]),
  );
}

/** Sorts an already bounded JSON value and returns a copied JSON value. */
export function sortJsonInput(
  value: JsonValue,
): Result<JsonValue, JsonCanonicalizationError> {
  return validateJsonValue(value).map(sortJsonValue);
}

/** Canonicalizes an already bounded JSON value. */
export function canonicalizeJson(
  value: JsonValue,
): Result<string, JsonCanonicalizationError> {
  return sortJsonInput(value).andThen((sorted) =>
    Result.fromThrowable(
      () => JSON.stringify(sorted),
      () => canonicalizationError("canonicalization-failed"),
    )().andThen((encoded) =>
      encoded === undefined
        ? err(canonicalizationError("canonicalization-failed"))
        : ok(encoded),
    ),
  );
}

/** Computes a content digest over canonical bounded JSON. */
export function digestJson(
  value: JsonValue,
): Result<string, JsonCanonicalizationError> {
  return canonicalizeJson(value).andThen((canonical) =>
    Result.fromThrowable(
      () => `sha256:${Bun.CryptoHasher.hash("sha256", canonical, "hex")}`,
      () => canonicalizationError("digest-failed"),
    )(),
  );
}
