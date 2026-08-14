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

function unsafeGraphError(): LegacyGraphCopyError {
  return { type: "UnsafeGraph", message: UNSAFE_LEGACY_GRAPH_MESSAGE };
}

function graphTooLargeError(): LegacyGraphCopyError {
  return { type: "GraphTooLarge", message: LEGACY_GRAPH_TOO_LARGE_MESSAGE };
}

function defineOwn(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
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
  return ok(undefined);
}

function copyArray(
  source: unknown[],
  active: WeakSet<object>,
  budget: CopyBudget,
  depth: number,
): Result<unknown[], LegacyGraphCopyError> {
  const lengthDescriptor = Object.getOwnPropertyDescriptor(source, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    typeof lengthDescriptor.value !== "number" ||
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

  const copy: unknown[] = [];
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
  source: object,
  active: WeakSet<object>,
  budget: CopyBudget,
  depth: number,
): Result<Record<string, unknown>, LegacyGraphCopyError> {
  const ownKeys = Reflect.ownKeys(source);
  if (ownKeys.length > MAX_LEGACY_OBJECT_KEYS) {
    return err(graphTooLargeError());
  }
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys) {
    if (typeof key === "symbol") return err(unsafeGraphError());
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
  value: unknown,
  active: WeakSet<object>,
  budget: CopyBudget,
  depth: number,
): Result<unknown, LegacyGraphCopyError> {
  if (depth > MAX_LEGACY_GRAPH_DEPTH) return err(graphTooLargeError());
  const consumed = consumeNode(budget);
  if (consumed.isErr()) return err(consumed.error);

  if (typeof value === "function") return err(unsafeGraphError());
  if (typeof value === "string") {
    if (value.length > MAX_LEGACY_STRING_LENGTH) {
      return err(graphTooLargeError());
    }
    return ok(value);
  }
  if (value === null || typeof value !== "object") return ok(value);
  if (active.has(value)) return err(unsafeGraphError());

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    isArray
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  ) {
    return err(unsafeGraphError());
  }

  active.add(value);
  const copied = isArray
    ? copyArray(value, active, budget, depth)
    : copyRecord(value, active, budget, depth);
  active.delete(value);
  return copied;
}

const safelyCopyLegacyGraph = Result.fromThrowable(
  (value: unknown) => copyGraph(value, new WeakSet<object>(), { nodes: 0 }, 0),
  (): LegacyGraphCopyError => unsafeGraphError(),
);

/** Copy a descriptor-safe, size-bounded legacy JSONC graph. */
export function copyLegacyGraph(
  value: unknown,
): Result<unknown, LegacyGraphCopyError> {
  return safelyCopyLegacyGraph(value).andThen((result) => result);
}
