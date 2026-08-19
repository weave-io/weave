import { Result } from "neverthrow";
import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonParseError {
  readonly type: "JsonParseError";
  readonly message: string;
}

/** Parses JSON into the bounded value contract used by release boundaries. */
export function parseJsonValue(
  text: string,
): Result<JsonValue, JsonParseError> {
  return Result.fromThrowable(
    () => JSON.parse(text),
    (cause): JsonParseError => ({
      type: "JsonParseError",
      message: cause instanceof Error ? cause.message : String(cause),
    }),
  )().map((value): JsonValue => value);
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return z.record(z.string(), z.unknown()).safeParse(value).success;
}

export function isJsonString(value: JsonValue): value is string {
  return z.string().safeParse(value).success;
}

export function isJsonBoolean(value: JsonValue): value is boolean {
  return z.boolean().safeParse(value).success;
}

function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJsonValue(value[key])]),
  );
}

/** Sorts a typed value after a JSON round trip at the boundary. */
export function sortJsonInput<T>(value: T): JsonValue {
  return Result.fromThrowable(
    () => JSON.stringify(value) ?? "null",
    () => "serialization failed",
  )()
    .andThen(parseJsonValue)
    .map(sortJsonValue)
    .unwrapOr(null);
}

/** Canonicalizes a typed value after a JSON round trip at the boundary. */
export function canonicalizeJson<T>(value: T): string {
  return JSON.stringify(sortJsonInput(value)) ?? "null";
}
