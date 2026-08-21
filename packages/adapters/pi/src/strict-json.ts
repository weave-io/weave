/**
 * A bounded strict JSON parser and RFC 8785-compatible canonicalizer.
 *
 * `JSON.parse` cannot be used at this boundary: it collapses duplicate object
 * keys before a reviver can inspect them. The parser below keeps duplicate-key
 * rejection, validates the I-JSON number/string domain, and bounds the input
 * graph before any value becomes retained JSON data.
 */
import { err, type Result as NeverthrowResult, ok, Result } from "neverthrow";
import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type JsonContainer = JsonValue[] | JsonObject;

export type StrictJsonParseError =
  | { readonly type: "UnexpectedEndOfInput"; readonly position: number }
  | {
      readonly type: "UnexpectedToken";
      readonly position: number;
      readonly found: string;
    }
  | {
      readonly type: "DuplicateObjectKey";
      readonly position: number;
      readonly key: string;
    }
  | { readonly type: "InvalidNumber"; readonly position: number }
  | { readonly type: "InvalidEscape"; readonly position: number }
  | { readonly type: "TrailingContent"; readonly position: number }
  | {
      readonly type: "LimitExceeded";
      readonly position: number;
      readonly limit: "bytes" | "depth" | "nodes" | "properties" | "string";
    };

const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
const MAX_JSON_TEXT_BYTES = 64 * 1024 * 1024;
const MAX_JSON_DEPTH = 128;
const MAX_JSON_NODES = 16_384;
const MAX_JSON_PROPERTIES = 4_096;
const MAX_JSON_PROPERTIES_PER_CONTAINER = 512;
// Native Pi records are bounded at 8 MiB, so the parser must accept one
// nearly full-size assistant string while still keeping its own aggregate cap.
const MAX_JSON_STRING_UNITS = 8 * 1024 * 1024;

type JsonLimit = "bytes" | "depth" | "nodes" | "properties" | "string";

const StringValueSchema = z.string();
const NumberValueSchema = z.custom<number>(
  (value) =>
    Object(value) !== value &&
    (Number.isNaN(value) ||
      value === Number.POSITIVE_INFINITY ||
      value === Number.NEGATIVE_INFINITY ||
      z.number().safeParse(value).success),
);
const BooleanValueSchema = z.boolean();
const JsonInputBoundary = z.preprocess((value) => value, z.json());

const SIMPLE_ESCAPES = new Map<string, string>([
  ['"', '"'],
  ["\\", "\\"],
  ["/", "/"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);

interface JsonBudget {
  nodes: number;
  properties: number;
  stringUnits: number;
}

function newJsonBudget(): JsonBudget {
  return { nodes: 0, properties: 0, stringUnits: 0 };
}

class JsonCursor {
  pos = 0;

  constructor(readonly text: string) {}

  peek(): string | undefined {
    return this.text[this.pos];
  }

  skipWhitespace(): void {
    while (this.pos < this.text.length) {
      const code = this.text.charCodeAt(this.pos);
      if (!WHITESPACE.has(code)) return;
      this.pos += 1;
    }
  }
}

function limitError(
  cursor: JsonCursor,
  limit: JsonLimit,
): StrictJsonParseError {
  return { type: "LimitExceeded", position: cursor.pos, limit };
}

function consumeNode(
  cursor: JsonCursor,
  budget: JsonBudget,
  depth: number,
): NeverthrowResult<void, StrictJsonParseError> {
  if (depth > MAX_JSON_DEPTH) return err(limitError(cursor, "depth"));
  if (budget.nodes >= MAX_JSON_NODES) return err(limitError(cursor, "nodes"));
  budget.nodes += 1;
  return ok();
}

function consumeProperty(
  cursor: JsonCursor,
  budget: JsonBudget,
): NeverthrowResult<void, StrictJsonParseError> {
  if (budget.properties >= MAX_JSON_PROPERTIES) {
    return err(limitError(cursor, "properties"));
  }
  budget.properties += 1;
  return ok();
}

function appendStringPart(
  cursor: JsonCursor,
  budget: JsonBudget,
  output: string,
  part: string,
): NeverthrowResult<string, StrictJsonParseError> {
  if (
    part.length > MAX_JSON_STRING_UNITS ||
    budget.stringUnits > MAX_JSON_STRING_UNITS - part.length
  ) {
    return err(limitError(cursor, "string"));
  }
  budget.stringUnits += part.length;
  return ok(output + part);
}

/** Parses exactly one bounded JSON value, rejecting duplicate keys and trailing content. */
export function parseStrictJson(
  text: string,
): NeverthrowResult<JsonValue, StrictJsonParseError> {
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength > MAX_JSON_TEXT_BYTES) {
    return err({ type: "LimitExceeded", position: 0, limit: "bytes" });
  }

  const cursor = new JsonCursor(text);
  const budget = newJsonBudget();
  cursor.skipWhitespace();
  const valueResult = parseValue(cursor, budget, 0);
  if (valueResult.isErr()) return valueResult;
  cursor.skipWhitespace();
  if (cursor.pos !== text.length) {
    return err({ type: "TrailingContent", position: cursor.pos });
  }
  return valueResult;
}

function parseValue(
  cursor: JsonCursor,
  budget: JsonBudget,
  depth: number,
): NeverthrowResult<JsonValue, StrictJsonParseError> {
  const nodeResult = consumeNode(cursor, budget, depth);
  if (nodeResult.isErr()) return err(nodeResult.error);

  const ch = cursor.peek();
  if (ch === undefined) {
    return err({ type: "UnexpectedEndOfInput", position: cursor.pos });
  }
  if (ch === "{") return parseObject(cursor, budget, depth);
  if (ch === "[") return parseArray(cursor, budget, depth);
  if (ch === '"') return parseString(cursor, budget);
  if (ch === "t") return parseLiteral(cursor, "true", true);
  if (ch === "f") return parseLiteral(cursor, "false", false);
  if (ch === "n") return parseLiteral(cursor, "null", null);
  if (ch === "-" || (ch >= "0" && ch <= "9")) {
    return parseNumber(cursor);
  }
  return err({ type: "UnexpectedToken", position: cursor.pos, found: ch });
}

function parseLiteral(
  cursor: JsonCursor,
  literal: string,
  value: JsonValue,
): NeverthrowResult<JsonValue, StrictJsonParseError> {
  if (cursor.text.slice(cursor.pos, cursor.pos + literal.length) !== literal) {
    return err({
      type: "UnexpectedToken",
      position: cursor.pos,
      found: cursor.peek() ?? "",
    });
  }
  cursor.pos += literal.length;
  return ok(value);
}

const NUMBER_PATTERN = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/;

function parseNumber(
  cursor: JsonCursor,
): NeverthrowResult<JsonValue, StrictJsonParseError> {
  const remainder = cursor.text.slice(cursor.pos);
  const match = NUMBER_PATTERN.exec(remainder);
  if (match === null || match[0].length === 0) {
    return err({ type: "InvalidNumber", position: cursor.pos });
  }
  cursor.pos += match[0].length;
  const literal = match[0];
  const parsed = Number(literal);
  const hasPlainIntegerSyntax = !literal.includes(".") && !/[eE]/.test(literal);
  if (
    !Number.isFinite(parsed) ||
    (hasPlainIntegerSyntax && !Number.isSafeInteger(parsed))
  ) {
    return err({ type: "InvalidNumber", position: cursor.pos });
  }
  return ok(parsed);
}

function parseString(
  cursor: JsonCursor,
  budget: JsonBudget,
): NeverthrowResult<JsonValue, StrictJsonParseError> {
  const result = parseRawString(cursor, budget);
  if (result.isErr()) return err(result.error);
  return ok(result.value);
}

function parseRawString(
  cursor: JsonCursor,
  budget: JsonBudget,
): NeverthrowResult<string, StrictJsonParseError> {
  const start = cursor.pos;
  if (cursor.peek() !== '"') {
    return err({
      type: "UnexpectedToken",
      position: cursor.pos,
      found: cursor.peek() ?? "",
    });
  }
  cursor.pos += 1;
  let output = "";
  for (;;) {
    const ch = cursor.text[cursor.pos];
    if (ch === undefined) {
      return err({ type: "UnexpectedEndOfInput", position: start });
    }
    if (ch === '"') {
      cursor.pos += 1;
      if (hasLoneSurrogate(output)) {
        return err({ type: "InvalidEscape", position: start });
      }
      return ok(output);
    }
    if (ch === "\\") {
      const escapeResult = parseEscape(cursor);
      if (escapeResult.isErr()) return err(escapeResult.error);
      const appended = appendStringPart(
        cursor,
        budget,
        output,
        escapeResult.value,
      );
      if (appended.isErr()) return err(appended.error);
      output = appended.value;
      continue;
    }
    if (ch.charCodeAt(0) < 0x20) {
      return err({ type: "UnexpectedToken", position: cursor.pos, found: ch });
    }
    const appended = appendStringPart(cursor, budget, output, ch);
    if (appended.isErr()) return err(appended.error);
    output = appended.value;
    cursor.pos += 1;
  }
}

function parseEscape(
  cursor: JsonCursor,
): NeverthrowResult<string, StrictJsonParseError> {
  const escapePos = cursor.pos;
  cursor.pos += 1;
  const marker = cursor.text[cursor.pos];
  if (marker === undefined) {
    return err({ type: "UnexpectedEndOfInput", position: escapePos });
  }
  const simple = SIMPLE_ESCAPES.get(marker);
  if (simple !== undefined) {
    cursor.pos += 1;
    return ok(simple);
  }
  if (marker === "u") {
    const hex = cursor.text.slice(cursor.pos + 1, cursor.pos + 5);
    if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
      return err({ type: "InvalidEscape", position: escapePos });
    }
    cursor.pos += 5;
    return ok(String.fromCharCode(Number.parseInt(hex, 16)));
  }
  return err({ type: "InvalidEscape", position: escapePos });
}

function parseArray(
  cursor: JsonCursor,
  budget: JsonBudget,
  depth: number,
): NeverthrowResult<JsonValue, StrictJsonParseError> {
  cursor.pos += 1;
  const items: JsonValue[] = [];
  cursor.skipWhitespace();
  if (cursor.peek() === "]") {
    cursor.pos += 1;
    return ok(items);
  }
  for (;;) {
    const propertyResult = consumeProperty(cursor, budget);
    if (propertyResult.isErr()) return err(propertyResult.error);
    cursor.skipWhitespace();
    const itemResult = parseValue(cursor, budget, depth + 1);
    if (itemResult.isErr()) return err(itemResult.error);
    items.push(itemResult.value);
    cursor.skipWhitespace();
    const ch = cursor.peek();
    if (ch === ",") {
      cursor.pos += 1;
      cursor.skipWhitespace();
      continue;
    }
    if (ch === "]") {
      cursor.pos += 1;
      return ok(items);
    }
    return err({
      type: "UnexpectedToken",
      position: cursor.pos,
      found: ch ?? "",
    });
  }
}

function parseObject(
  cursor: JsonCursor,
  budget: JsonBudget,
  depth: number,
): NeverthrowResult<JsonValue, StrictJsonParseError> {
  cursor.pos += 1;
  const entries: JsonObject = Object.create(null);
  const seenKeys = new Set<string>();
  cursor.skipWhitespace();
  if (cursor.peek() === "}") {
    cursor.pos += 1;
    return ok(entries);
  }
  for (;;) {
    const propertyResult = consumeProperty(cursor, budget);
    if (propertyResult.isErr()) return err(propertyResult.error);
    cursor.skipWhitespace();
    const keyStart = cursor.pos;
    const keyResult = parseRawString(cursor, budget);
    if (keyResult.isErr()) return err(keyResult.error);
    const key = keyResult.value;
    if (seenKeys.has(key)) {
      return err({ type: "DuplicateObjectKey", position: keyStart, key });
    }
    if (seenKeys.size >= MAX_JSON_PROPERTIES_PER_CONTAINER) {
      return err(limitError(cursor, "properties"));
    }
    seenKeys.add(key);
    cursor.skipWhitespace();
    if (cursor.peek() !== ":") {
      return err({
        type: "UnexpectedToken",
        position: cursor.pos,
        found: cursor.peek() ?? "",
      });
    }
    cursor.pos += 1;
    cursor.skipWhitespace();
    const valueResult = parseValue(cursor, budget, depth + 1);
    if (valueResult.isErr()) return err(valueResult.error);
    Object.defineProperty(entries, key, {
      value: valueResult.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    cursor.skipWhitespace();
    const ch = cursor.peek();
    if (ch === ",") {
      cursor.pos += 1;
      cursor.skipWhitespace();
      continue;
    }
    if (ch === "}") {
      cursor.pos += 1;
      return ok(entries);
    }
    return err({
      type: "UnexpectedToken",
      position: cursor.pos,
      found: ch ?? "",
    });
  }
}

export type CanonicalizeError =
  | { readonly type: "NonFiniteNumber"; readonly path: string }
  | { readonly type: "UnsafeInteger"; readonly path: string }
  | { readonly type: "LoneSurrogate"; readonly path: string }
  | { readonly type: "UnsupportedValue"; readonly path: string }
  | { readonly type: "HostileAccessor"; readonly path: string };

function hostileAccessorError(path: string): CanonicalizeError {
  return { type: "HostileAccessor", path };
}

function safely<T>(
  operation: () => T,
  path: string,
): NeverthrowResult<T, CanonicalizeError> {
  return Result.fromThrowable(operation, () => hostileAccessorError(path))();
}

function isJsonContainer(
  value: z.input<typeof JsonInputBoundary>,
): value is JsonContainer {
  return Object(value) === value;
}

/** Serializes a JSON value to deterministic UTF-8 bytes using RFC 8785-style JCS. */
export function canonicalizeToBytes(
  value: JsonValue,
): NeverthrowResult<Uint8Array, CanonicalizeError> {
  const stringResult = canonicalizeToString(value, "$");
  if (stringResult.isErr()) return err(stringResult.error);
  return ok(new TextEncoder().encode(stringResult.value));
}

function canonicalizeToString(
  value: z.input<typeof JsonInputBoundary>,
  path: string,
): NeverthrowResult<string, CanonicalizeError> {
  if (value === null) return ok("null");

  const stringResult = StringValueSchema.safeParse(value);
  if (stringResult.success) return canonicalizeString(stringResult.data, path);

  const numberResult = NumberValueSchema.safeParse(value);
  if (numberResult.success) return canonicalizeNumber(numberResult.data, path);

  const booleanResult = BooleanValueSchema.safeParse(value);
  if (booleanResult.success) return ok(booleanResult.data ? "true" : "false");

  if (!isJsonContainer(value)) {
    return err({ type: "UnsupportedValue", path });
  }
  if (Array.isArray(value)) return canonicalizeArray(value, path);
  return canonicalizeObject(value, path);
}

function canonicalizeArray(
  value: JsonContainer,
  path: string,
): NeverthrowResult<string, CanonicalizeError> {
  if (!Array.isArray(value)) return err({ type: "UnsupportedValue", path });

  const prototype = safely(() => Object.getPrototypeOf(value), path);
  if (prototype.isErr()) return err(prototype.error);
  if (prototype.value !== Array.prototype) {
    return err({ type: "UnsupportedValue", path });
  }

  const lengthDescriptor = safely(
    () => Object.getOwnPropertyDescriptor(value, "length"),
    path,
  );
  if (lengthDescriptor.isErr()) return err(lengthDescriptor.error);
  const descriptor = lengthDescriptor.value;
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    descriptor.enumerable !== false ||
    descriptor.configurable !== false ||
    descriptor.writable !== true
  ) {
    return err({ type: "HostileAccessor", path });
  }
  const lengthResult = NumberValueSchema.safeParse(descriptor.value);
  if (
    !lengthResult.success ||
    !Number.isSafeInteger(lengthResult.data) ||
    lengthResult.data < 0 ||
    lengthResult.data > MAX_JSON_PROPERTIES_PER_CONTAINER
  ) {
    return err({ type: "UnsupportedValue", path });
  }
  const length = lengthResult.data;
  const observedLength = safely(() => value.length, path);
  if (observedLength.isErr()) return err(observedLength.error);
  if (observedLength.value !== length) {
    return err({ type: "HostileAccessor", path });
  }

  const ownKeys = safely(() => Reflect.ownKeys(value), path);
  if (ownKeys.isErr()) return err(ownKeys.error);
  if (ownKeys.value.length !== length + 1) {
    return err({ type: "HostileAccessor", path });
  }

  const parts: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (ownKeys.value[index] !== key) {
      return err({ type: "HostileAccessor", path });
    }
    const itemDescriptor = safely(
      () => Object.getOwnPropertyDescriptor(value, key),
      `${path}[${index}]`,
    );
    if (itemDescriptor.isErr()) return err(itemDescriptor.error);
    const item = readOwnDataValue(itemDescriptor.value, `${path}[${index}]`);
    if (item.isErr()) return err(item.error);
    const observedItem = safely(() => value[index], `${path}[${index}]`);
    if (observedItem.isErr()) return err(observedItem.error);
    if (!Object.is(observedItem.value, item.value)) {
      return err({
        type: "HostileAccessor",
        path: `${path}[${index}]`,
      });
    }
    const itemResult = canonicalizeToString(item.value, `${path}[${index}]`);
    if (itemResult.isErr()) return err(itemResult.error);
    parts.push(itemResult.value);
  }
  if (ownKeys.value[length] !== "length") {
    return err({ type: "HostileAccessor", path });
  }
  return ok(`[${parts.join(",")}]`);
}

function canonicalizeObject(
  value: JsonContainer,
  path: string,
): NeverthrowResult<string, CanonicalizeError> {
  if (Array.isArray(value) || !isJsonContainer(value)) {
    return err({ type: "UnsupportedValue", path });
  }

  const prototype = safely(() => Object.getPrototypeOf(value), path);
  if (prototype.isErr()) return err(prototype.error);
  if (prototype.value !== Object.prototype && prototype.value !== null) {
    return err({ type: "UnsupportedValue", path });
  }

  const ownKeys = safely(() => Reflect.ownKeys(value), path);
  if (ownKeys.isErr()) return err(ownKeys.error);
  if (ownKeys.value.length > MAX_JSON_PROPERTIES_PER_CONTAINER) {
    return err({ type: "UnsupportedValue", path });
  }

  const keys: string[] = [];
  for (const key of ownKeys.value) {
    const stringKey = StringValueSchema.safeParse(key);
    if (!stringKey.success) return err({ type: "HostileAccessor", path });
    keys.push(stringKey.data);
  }
  keys.sort();

  const parts: string[] = [];
  for (const key of keys) {
    const keyResult = canonicalizeString(key, `${path}.${key}`);
    if (keyResult.isErr()) return err(keyResult.error);
    const descriptor = safely(
      () => Object.getOwnPropertyDescriptor(value, key),
      `${path}.${key}`,
    );
    if (descriptor.isErr()) return err(descriptor.error);
    const propertyValue = readOwnDataValue(descriptor.value, `${path}.${key}`);
    if (propertyValue.isErr()) return err(propertyValue.error);
    const observedValue = safely(() => value[key], `${path}.${key}`);
    if (observedValue.isErr()) return err(observedValue.error);
    if (!Object.is(observedValue.value, propertyValue.value)) {
      return err({ type: "HostileAccessor", path: `${path}.${key}` });
    }
    const valueResult = canonicalizeToString(
      propertyValue.value,
      `${path}.${key}`,
    );
    if (valueResult.isErr()) return err(valueResult.error);
    parts.push(`${keyResult.value}:${valueResult.value}`);
  }
  return ok(`{${parts.join(",")}}`);
}

function readOwnDataValue(
  descriptor: PropertyDescriptor | undefined,
  path: string,
): NeverthrowResult<z.input<typeof JsonInputBoundary>, CanonicalizeError> {
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    descriptor.enumerable !== true
  ) {
    return err({ type: "HostileAccessor", path });
  }
  return ok(descriptor.value);
}

function canonicalizeNumber(
  value: number,
  path: string,
): NeverthrowResult<string, CanonicalizeError> {
  if (!Number.isFinite(value)) return err({ type: "NonFiniteNumber", path });
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    return err({ type: "UnsafeInteger", path });
  }
  if (Object.is(value, -0)) return ok("0");
  return ok(`${value}`);
}

function canonicalizeString(
  value: string,
  path: string,
): NeverthrowResult<string, CanonicalizeError> {
  if (hasLoneSurrogate(value)) return err({ type: "LoneSurrogate", path });
  return ok(JSON.stringify(value));
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
    const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff;
    if (isHighSurrogate) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
      continue;
    }
    if (isLowSurrogate) return true;
  }
  return false;
}
