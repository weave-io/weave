/**
 * Descriptor-safe, bounded copy of untrusted legacy JSONC values.
 *
 * JSON.parse and jsonc-parser normally create plain objects, but conversion
 * must not trust that. This copier reads only own enumerable writable data
 * descriptors, never executes getters, and rejects inherited fields, accessors,
 * symbols, unsafe prototypes, cycles, callables, sparse arrays, and oversized
 * graphs. Copied objects use a null prototype.
 */

import { err, ok, Result } from "neverthrow";

export const UNSAFE_LEGACY_GRAPH_MESSAGE =
  "legacy JSONC input must contain only own, enumerable, writable data properties on plain objects or arrays";

export const LEGACY_GRAPH_TOO_LARGE_MESSAGE =
  "legacy JSONC input exceeds conversion size bounds";

export const MAX_LEGACY_GRAPH_NODES = 4096;
export const MAX_LEGACY_GRAPH_DEPTH = 32;
export const MAX_LEGACY_STRING_LENGTH = 16 * 1024;
export const MAX_LEGACY_ARRAY_LENGTH = 512;
export const MAX_LEGACY_OBJECT_KEYS = 512;
/** Raw JSONC source length bound applied before parse/visit. */
export const MAX_LEGACY_SOURCE_LENGTH = 256 * 1024;

/** Values that may arrive at the crafted-object conversion seam. */
export type LegacyInputValue =
  | LegacyInputRecord
  | LegacyInputValue[]
  | LegacyInputCallable
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined;

/** A record accepted at the crafted-object conversion seam. */
export interface LegacyInputRecord {
  readonly [key: string]: LegacyInputValue;
}

/** A callable accepted at the crafted-object conversion seam. */
export type LegacyInputCallable = (
  ...args: readonly LegacyInputValue[]
) => LegacyInputValue;

/** Values returned after descriptor-safe graph copying. */
export type LegacyGraphValue =
  | LegacyGraphObject
  | LegacyGraphValue[]
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined;

/** A copied record with a null prototype and recursively copied values. */
export interface LegacyGraphObject {
  readonly [key: string]: LegacyGraphValue;
}

export type LegacyGraphCopyError =
  | {
      type: "UnsafeGraph";
      message: typeof UNSAFE_LEGACY_GRAPH_MESSAGE;
    }
  | {
      type: "GraphTooLarge";
      message: typeof LEGACY_GRAPH_TOO_LARGE_MESSAGE;
    };

type CopyBudget = {
  nodes: number;
};

type LegacyValueKind =
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

function unsafeGraphError(): LegacyGraphCopyError {
  return { type: "UnsafeGraph", message: UNSAFE_LEGACY_GRAPH_MESSAGE };
}

function graphTooLargeError(): LegacyGraphCopyError {
  return { type: "GraphTooLarge", message: LEGACY_GRAPH_TOO_LARGE_MESSAGE };
}

/** Classify a crafted value without using an unchecked representation check. */
export function legacyValueKind(value: LegacyInputValue): LegacyValueKind {
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
}

export const isLegacyString = (value: LegacyInputValue): value is string =>
  legacyValueKind(value) === "string";

export const isLegacyNumber = (value: LegacyInputValue): value is number =>
  legacyValueKind(value) === "number";

export const isLegacyBoolean = (value: LegacyInputValue): value is boolean =>
  legacyValueKind(value) === "boolean";

export const isLegacyUndefined = (
  value: LegacyInputValue,
): value is undefined => legacyValueKind(value) === "undefined";

export const isLegacyBigInt = (value: LegacyInputValue): value is bigint =>
  legacyValueKind(value) === "bigint";

export const isLegacySymbol = (value: LegacyInputValue): value is symbol =>
  legacyValueKind(value) === "symbol";

export const isLegacyRecord = (
  value: LegacyInputValue,
): value is LegacyInputRecord => legacyValueKind(value) === "object";

export const isLegacyGraphRecord = (
  value: LegacyInputValue,
): value is LegacyGraphObject => legacyValueKind(value) === "object";

function isStringPropertyKey(key: PropertyKey): key is string {
  return Object.prototype.toString.call(key) === "[object String]";
}

function defineOwn(
  target: LegacyGraphObject,
  key: string,
  value: LegacyGraphValue,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function consumeNode(budget: CopyBudget): Result<void, LegacyGraphCopyError> {
  budget.nodes += 1;
  if (budget.nodes > MAX_LEGACY_GRAPH_NODES) {
    return err(graphTooLargeError());
  }
  return ok();
}

function copyArray(
  source: LegacyInputValue[],
  active: WeakSet<object>,
  budget: CopyBudget,
  depth: number,
): Result<LegacyGraphValue[], LegacyGraphCopyError> {
  const lengthDescriptor = Object.getOwnPropertyDescriptor(source, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !isLegacyNumber(lengthDescriptor.value) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.enumerable !== false ||
    lengthDescriptor.configurable !== false ||
    lengthDescriptor.writable !== true
  ) {
    return err(unsafeGraphError());
  }
  const length = lengthDescriptor.value;
  if (length > MAX_LEGACY_ARRAY_LENGTH) return err(graphTooLargeError());
  const ownKeys = Reflect.ownKeys(source);
  if (ownKeys.length !== length + 1) return err(unsafeGraphError());

  const copy: LegacyGraphValue[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (ownKeys[index] !== key) return err(unsafeGraphError());
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      descriptor.configurable !== true ||
      descriptor.writable !== true
    ) {
      return err(unsafeGraphError());
    }
    const copiedValue = copyGraph(descriptor.value, active, budget, depth + 1);
    if (copiedValue.isErr()) return err(copiedValue.error);
    copy.push(copiedValue.value);
  }
  if (ownKeys[length] !== "length") return err(unsafeGraphError());
  return ok(copy);
}

function copyRecord(
  source: LegacyInputRecord,
  active: WeakSet<object>,
  budget: CopyBudget,
  depth: number,
): Result<LegacyGraphObject, LegacyGraphCopyError> {
  const ownKeys = Reflect.ownKeys(source);
  if (ownKeys.length > MAX_LEGACY_OBJECT_KEYS) {
    return err(graphTooLargeError());
  }
  const copy: LegacyGraphObject = Object.create(null);
  for (const key of ownKeys) {
    if (!isStringPropertyKey(key)) return err(unsafeGraphError());
    if (key.length > MAX_LEGACY_STRING_LENGTH) {
      return err(graphTooLargeError());
    }
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      descriptor.configurable !== true ||
      descriptor.writable !== true
    ) {
      return err(unsafeGraphError());
    }
    const copiedValue = copyGraph(descriptor.value, active, budget, depth + 1);
    if (copiedValue.isErr()) return err(copiedValue.error);
    defineOwn(copy, key, copiedValue.value);
  }
  return ok(copy);
}

function copyGraph(
  value: LegacyInputValue,
  active: WeakSet<object>,
  budget: CopyBudget,
  depth: number,
): Result<LegacyGraphValue, LegacyGraphCopyError> {
  if (depth > MAX_LEGACY_GRAPH_DEPTH) return err(graphTooLargeError());
  const consumed = consumeNode(budget);
  if (consumed.isErr()) return err(consumed.error);

  const kind = legacyValueKind(value);
  if (kind === "callable" || kind === "other") return err(unsafeGraphError());
  if (isLegacyString(value)) {
    if (value.length > MAX_LEGACY_STRING_LENGTH) {
      return err(graphTooLargeError());
    }
    return ok(value);
  }
  if (value === null) return ok(null);
  if (isLegacyUndefined(value)) return ok(value);
  if (isLegacyNumber(value)) return ok(value);
  if (isLegacyBoolean(value)) return ok(value);
  if (isLegacyBigInt(value)) return ok(value);
  if (isLegacySymbol(value)) return ok(value);

  if (kind === "array") {
    if (!Array.isArray(value)) return err(unsafeGraphError());
    if (active.has(value)) return err(unsafeGraphError());
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Array.prototype) return err(unsafeGraphError());
    active.add(value);
    const copied = copyArray(value, active, budget, depth);
    active.delete(value);
    return copied;
  }

  if (!isLegacyRecord(value)) return err(unsafeGraphError());
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return err(unsafeGraphError());
  }
  if (active.has(value)) return err(unsafeGraphError());

  active.add(value);
  const copied = copyRecord(value, active, budget, depth);
  active.delete(value);
  return copied;
}

const safelyCopyLegacyGraph = Result.fromThrowable(
  (value: LegacyInputValue): Result<LegacyGraphValue, LegacyGraphCopyError> =>
    copyGraph(value, new WeakSet<object>(), { nodes: 0 }, 0),
  (): LegacyGraphCopyError => unsafeGraphError(),
);

/** Copy a descriptor-safe, size-bounded legacy JSONC graph. */
export function copyLegacyGraph(
  value: LegacyInputValue,
): Result<LegacyGraphValue, LegacyGraphCopyError> {
  return safelyCopyLegacyGraph(value).andThen((result) => result);
}
