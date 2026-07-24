/**
 * A minimal, dependency-free strict JSON parser and RFC 8785-compatible
 * canonicalizer (Spec 33 §11.3-§11.4).
 *
 * `JSON.parse` cannot be reused for parsing: it silently *collapses*
 * duplicate object keys (keeping the last value) before a reviver ever
 * runs, so it cannot detect and reject the duplicate - a requirement of
 * both the private control-envelope protocol and the general RPC line
 * framing. This module hand-rolls a small recursive-descent parser instead.
 *
 * Canonicalization produces deterministic UTF-8 bytes for exactly one JSON
 * value, suitable for HMAC signing: object keys are sorted by UTF-16 code
 * unit (matching the default `Array.prototype.sort()` comparator for
 * strings, which is what RFC 8785 requires), numbers use ECMAScript's own
 * `Number-to-String` algorithm (RFC 8785 explicitly canonicalizes on top of
 * the ECMAScript algorithm), and values outside the interoperable I-JSON
 * domain (non-finite numbers, unsafe integers, lone surrogates) are
 * rejected rather than silently coerced.
 */
import { err, ok, type Result } from "neverthrow";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

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
  | { readonly type: "TrailingContent"; readonly position: number };

const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);

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

/** Parses exactly one JSON value from `text`, rejecting duplicate object keys and trailing content. */
export function parseStrictJson(
  text: string,
): Result<JsonValue, StrictJsonParseError> {
  const cursor = new JsonCursor(text);
  cursor.skipWhitespace();
  const valueResult = parseValue(cursor);
  if (valueResult.isErr()) return valueResult;
  cursor.skipWhitespace();
  if (cursor.pos !== text.length) {
    return err({ type: "TrailingContent", position: cursor.pos });
  }
  return valueResult;
}

function parseValue(
  cursor: JsonCursor,
): Result<JsonValue, StrictJsonParseError> {
  const ch = cursor.peek();
  if (ch === undefined)
    return err({ type: "UnexpectedEndOfInput", position: cursor.pos });
  if (ch === "{") return parseObject(cursor);
  if (ch === "[") return parseArray(cursor);
  if (ch === '"') return parseString(cursor);
  if (ch === "t") return parseLiteral(cursor, "true", true);
  if (ch === "f") return parseLiteral(cursor, "false", false);
  if (ch === "n") return parseLiteral(cursor, "null", null);
  if (ch === "-" || (ch >= "0" && ch <= "9")) return parseNumber(cursor);
  return err({ type: "UnexpectedToken", position: cursor.pos, found: ch });
}

function parseLiteral<T extends JsonValue>(
  cursor: JsonCursor,
  literal: string,
  value: T,
): Result<JsonValue, StrictJsonParseError> {
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
): Result<JsonValue, StrictJsonParseError> {
  const remainder = cursor.text.slice(cursor.pos);
  const match = NUMBER_PATTERN.exec(remainder);
  if (match === null || match[0].length === 0) {
    return err({ type: "InvalidNumber", position: cursor.pos });
  }
  cursor.pos += match[0].length;
  const literal = match[0];
  const parsed = Number(literal);
  // I-JSON/JCS domain: reject NaN/±Infinity (only reachable via an extreme
  // exponent, since the grammar itself cannot spell NaN/Infinity), and
  // reject any integer-shaped literal (no '.', no exponent) that cannot
  // round-trip as a JS safe integer - never silently truncate precision.
  if (!Number.isFinite(parsed)) {
    return err({ type: "InvalidNumber", position: cursor.pos });
  }
  const isIntegerShaped = !literal.includes(".") && !/[eE]/.test(literal);
  if (isIntegerShaped && !Number.isSafeInteger(parsed)) {
    return err({ type: "InvalidNumber", position: cursor.pos });
  }
  return ok(parsed);
}

function parseString(
  cursor: JsonCursor,
): Result<JsonValue, StrictJsonParseError> {
  const result = parseRawString(cursor);
  if (result.isErr()) return result;
  return ok(result.value);
}

function parseRawString(
  cursor: JsonCursor,
): Result<string, StrictJsonParseError> {
  const start = cursor.pos;
  if (cursor.peek() !== '"') {
    return err({
      type: "UnexpectedToken",
      position: cursor.pos,
      found: cursor.peek() ?? "",
    });
  }
  cursor.pos += 1;
  let out = "";
  for (;;) {
    const ch = cursor.text[cursor.pos];
    if (ch === undefined)
      return err({ type: "UnexpectedEndOfInput", position: start });
    if (ch === '"') {
      cursor.pos += 1;
      return ok(out);
    }
    if (ch === "\\") {
      const escapeResult = parseEscape(cursor);
      if (escapeResult.isErr()) return escapeResult;
      out += escapeResult.value;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      return err({ type: "UnexpectedToken", position: cursor.pos, found: ch });
    }
    out += ch;
    cursor.pos += 1;
  }
}

function parseEscape(cursor: JsonCursor): Result<string, StrictJsonParseError> {
  const escapePos = cursor.pos;
  cursor.pos += 1; // consume backslash
  const marker = cursor.text[cursor.pos];
  if (marker === undefined)
    return err({ type: "UnexpectedEndOfInput", position: escapePos });
  const simple: Record<string, string> = {
    '"': '"',
    "\\": "\\",
    "/": "/",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
  };
  if (marker in simple) {
    cursor.pos += 1;
    return ok(simple[marker] as string);
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
): Result<JsonValue, StrictJsonParseError> {
  cursor.pos += 1; // consume [
  const items: JsonValue[] = [];
  cursor.skipWhitespace();
  if (cursor.peek() === "]") {
    cursor.pos += 1;
    return ok(items);
  }
  for (;;) {
    cursor.skipWhitespace();
    const itemResult = parseValue(cursor);
    if (itemResult.isErr()) return itemResult;
    items.push(itemResult.value);
    cursor.skipWhitespace();
    const ch = cursor.peek();
    if (ch === ",") {
      cursor.pos += 1;
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
): Result<JsonValue, StrictJsonParseError> {
  cursor.pos += 1; // consume {
  // A null-prototype record: a plain `{}` literal inherits an accessor for
  // `__proto__` from `Object.prototype`, so `entries["__proto__"] = value`
  // would silently repoint the object's prototype instead of creating an
  // own `"__proto__"` data property (classic prototype-pollution footgun).
  // `Object.create(null)` has no such accessor, so every key - including
  // `__proto__`, `constructor`, `toString`, etc. - always becomes a plain
  // own data property.
  const entries: Record<string, JsonValue> = Object.create(null);
  const seenKeys = new Set<string>();
  cursor.skipWhitespace();
  if (cursor.peek() === "}") {
    cursor.pos += 1;
    return ok(entries);
  }
  for (;;) {
    cursor.skipWhitespace();
    const keyStart = cursor.pos;
    const keyResult = parseRawString(cursor);
    if (keyResult.isErr()) return keyResult;
    const key = keyResult.value;
    if (seenKeys.has(key)) {
      return err({ type: "DuplicateObjectKey", position: keyStart, key });
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
    const valueResult = parseValue(cursor);
    if (valueResult.isErr()) return valueResult;
    entries[key] = valueResult.value;
    cursor.skipWhitespace();
    const ch = cursor.peek();
    if (ch === ",") {
      cursor.pos += 1;
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

/** Serializes `value` to deterministic canonical JSON bytes (RFC 8785-style JCS), or rejects I-JSON domain violations. */
export function canonicalizeToBytes(
  value: JsonValue,
): Result<Uint8Array, CanonicalizeError> {
  const stringResult = canonicalizeToString(value, "$");
  if (stringResult.isErr()) return err(stringResult.error);
  return ok(new TextEncoder().encode(stringResult.value));
}

function canonicalizeToString(
  value: JsonValue,
  path: string,
): Result<string, CanonicalizeError> {
  if (value === null) return ok("null");
  if (typeof value === "boolean") return ok(value ? "true" : "false");
  if (typeof value === "number") return canonicalizeNumber(value, path);
  if (typeof value === "string") return canonicalizeString(value, path);
  if (Array.isArray(value)) return canonicalizeArray(value, path);
  if (typeof value === "object") return canonicalizeObject(value, path);
  return err({ type: "UnsupportedValue", path });
}

function canonicalizeArray(
  value: readonly JsonValue[],
  path: string,
): Result<string, CanonicalizeError> {
  let length: number;
  try {
    length = value.length;
  } catch {
    return err({ type: "HostileAccessor", path });
  }
  const parts: string[] = [];
  for (let i = 0; i < length; i++) {
    let itemValue: JsonValue;
    try {
      itemValue = value[i] as JsonValue;
    } catch {
      return err({ type: "HostileAccessor", path: `${path}[${i}]` });
    }
    const itemResult = canonicalizeToString(itemValue, `${path}[${i}]`);
    if (itemResult.isErr()) return itemResult;
    parts.push(itemResult.value);
  }
  return ok(`[${parts.join(",")}]`);
}

function canonicalizeObject(
  value: { readonly [key: string]: JsonValue },
  path: string,
): Result<string, CanonicalizeError> {
  // Never let a hostile `ownKeys`/getter trap (a Proxy, or a property
  // defined with a throwing accessor) escape as an uncaught exception -
  // every property read on an untrusted `JsonValue`-typed input must
  // resolve to a `Result`, never a thrown error.
  let keys: string[];
  try {
    keys = Object.keys(value).sort();
  } catch {
    return err({ type: "HostileAccessor", path });
  }
  const parts: string[] = [];
  for (const key of keys) {
    const keyResult = canonicalizeString(key, `${path}.${key}`);
    if (keyResult.isErr()) return keyResult;
    let propertyValue: JsonValue;
    try {
      propertyValue = value[key] as JsonValue;
    } catch {
      return err({ type: "HostileAccessor", path: `${path}.${key}` });
    }
    const valueResult = canonicalizeToString(propertyValue, `${path}.${key}`);
    if (valueResult.isErr()) return valueResult;
    parts.push(`${keyResult.value}:${valueResult.value}`);
  }
  return ok(`{${parts.join(",")}}`);
}

function canonicalizeNumber(
  value: number,
  path: string,
): Result<string, CanonicalizeError> {
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
): Result<string, CanonicalizeError> {
  if (hasLoneSurrogate(value)) return err({ type: "LoneSurrogate", path });
  return ok(JSON.stringify(value));
}

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
    const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff;
    if (isHighSurrogate) {
      const next = value.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      i += 1; // consumed the low half of the pair
      continue;
    }
    if (isLowSurrogate) return true;
  }
  return false;
}
