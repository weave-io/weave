import { err, ok, Result } from "neverthrow";

export const UNSAFE_GRAPH_MESSAGE =
  "input must contain only own, enumerable, writable data properties on plain objects or arrays";

/** Maximum nesting depth accepted by the descriptor-safe graph boundary. */
export const MAX_SAFE_GRAPH_DEPTH = 64;

/** Maximum number of values visited by one graph copy. */
export const MAX_SAFE_GRAPH_NODES = 16_384;

/** Maximum number of own data properties visited by one graph copy. */
export const MAX_SAFE_GRAPH_PROPERTIES = 4_096;

/** Maximum number of own data properties on one object or array. */
export const MAX_SAFE_GRAPH_PROPERTIES_PER_OBJECT = 512;

/** Maximum number of elements accepted in one array. */
export const MAX_SAFE_GRAPH_ARRAY_LENGTH = 1_024;

/** Maximum aggregate string units in graph content and property names. */
export const MAX_SAFE_GRAPH_STRING_LENGTH = 256 * 1024;

/** Owner-supplied limits for one descriptor-safe graph snapshot. */
export type SafeGraphCopyBudget = {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxProperties: number;
  readonly maxPropertiesPerObject: number;
  readonly maxArrayLength: number;
  readonly maxStringLength: number;
};

/** Default limits for general-purpose graph snapshots. */
export const DEFAULT_SAFE_GRAPH_COPY_BUDGET: SafeGraphCopyBudget = {
  maxDepth: MAX_SAFE_GRAPH_DEPTH,
  maxNodes: MAX_SAFE_GRAPH_NODES,
  maxProperties: MAX_SAFE_GRAPH_PROPERTIES,
  maxPropertiesPerObject: MAX_SAFE_GRAPH_PROPERTIES_PER_OBJECT,
  maxArrayLength: MAX_SAFE_GRAPH_ARRAY_LENGTH,
  maxStringLength: MAX_SAFE_GRAPH_STRING_LENGTH,
};

export type SafeGraphCopyError = {
  type: "UnsafeGraph";
  message: typeof UNSAFE_GRAPH_MESSAGE;
};

export type SafeGraphPrimitive =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined;

export type SafeGraphObject = {
  [key: string]: SafeGraphValue;
};

export type SafeGraphValue =
  | SafeGraphPrimitive
  | SafeGraphValue[]
  | SafeGraphObject;

interface SafeGraphInputRecord {
  [key: PropertyKey]: SafeGraphInputValue;
}

type SafeGraphInputValue =
  | SafeGraphPrimitive
  | symbol
  | SafeGraphInputRecord
  | SafeGraphInputCallable;
type SafeGraphInputCallable = (...args: never[]) => SafeGraphInputValue;

type SafeGraphContext = {
  active: WeakSet<SafeGraphInputRecord>;
  /** Reject aliases instead of recursively copying shared subgraphs. */
  seen: WeakSet<SafeGraphInputRecord>;
  budget: SafeGraphCopyBudget;
  nodes: number;
  properties: number;
  stringLength: number;
};

function isSafeGraphPrimitive<T>(value: T): value is T & SafeGraphPrimitive {
  if (value === null || value === undefined) return true;
  if (Object(value) === value) return false;
  const primitiveTag = Object.prototype.toString.call(value);
  if (primitiveTag === "[object Number]") return Number.isFinite(Number(value));
  return (
    primitiveTag === "[object String]" ||
    primitiveTag === "[object Boolean]" ||
    primitiveTag === "[object BigInt]"
  );
}

function isSafeGraphString<T>(value: T): value is T & string {
  return (
    value !== null &&
    value !== undefined &&
    Object(value) !== value &&
    Object.prototype.toString.call(value) === "[object String]"
  );
}

function parseArrayLength<T>(value: T): number | null {
  if (
    Object(value) === value ||
    Object.prototype.toString.call(value) !== "[object Number]"
  ) {
    return null;
  }
  const numberValue = Number(value);
  return Number.isSafeInteger(numberValue) && numberValue >= 0
    ? numberValue
    : null;
}

function unsafeGraphError(): SafeGraphCopyError {
  return { type: "UnsafeGraph", message: UNSAFE_GRAPH_MESSAGE };
}

function emptySafeGraphObject(): SafeGraphObject {
  return Object.setPrototypeOf({}, null);
}

function defineOwn(
  target: SafeGraphObject | SafeGraphValue[],
  key: string,
  value: SafeGraphValue,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function isSymbolKey(key: string | symbol): key is symbol {
  return Result.fromThrowable(
    () => Symbol.prototype.valueOf.call(key),
    () => "not-symbol",
  )().isOk();
}

function isCallable<T>(value: T): boolean {
  return Result.fromThrowable(
    () => Function.prototype.toString.call(value),
    () => "not-callable",
  )().isOk();
}

function consumeString(
  value: string,
  context: SafeGraphContext,
): Result<void, SafeGraphCopyError> {
  if (
    value.length > context.budget.maxStringLength ||
    context.stringLength > context.budget.maxStringLength - value.length
  ) {
    return err(unsafeGraphError());
  }
  context.stringLength += value.length;
  return ok();
}

function consumeNode(
  depth: number,
  context: SafeGraphContext,
): Result<void, SafeGraphCopyError> {
  if (
    depth > context.budget.maxDepth ||
    context.nodes >= context.budget.maxNodes
  ) {
    return err(unsafeGraphError());
  }
  context.nodes += 1;
  return ok();
}

function consumeProperties(
  count: number,
  context: SafeGraphContext,
): Result<void, SafeGraphCopyError> {
  if (context.properties > context.budget.maxProperties - count) {
    return err(unsafeGraphError());
  }
  context.properties += count;
  return ok();
}

function requireWritableDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { value: unknown } {
  return (
    descriptor !== undefined &&
    "value" in descriptor &&
    descriptor.enumerable === true &&
    descriptor.configurable === true &&
    descriptor.writable === true
  );
}

function copyArray<T extends SafeGraphInputRecord>(
  source: T,
  context: SafeGraphContext,
  depth: number,
): Result<SafeGraphValue[], SafeGraphCopyError> {
  const lengthDescriptor = Object.getOwnPropertyDescriptor(source, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    lengthDescriptor.enumerable !== false ||
    lengthDescriptor.configurable !== false ||
    lengthDescriptor.writable !== true
  ) {
    return err(unsafeGraphError());
  }
  const length = parseArrayLength(lengthDescriptor.value);
  if (length === null) return err(unsafeGraphError());
  if (length > context.budget.maxArrayLength) return err(unsafeGraphError());
  const ownKeys = Reflect.ownKeys(source);
  if (ownKeys.length !== length + 1) return err(unsafeGraphError());

  const propertiesConsumed = consumeProperties(ownKeys.length, context);
  if (propertiesConsumed.isErr()) return err(propertiesConsumed.error);

  const copy: SafeGraphValue[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (ownKeys[index] !== key) return err(unsafeGraphError());
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!requireWritableDataDescriptor(descriptor)) {
      return err(unsafeGraphError());
    }
    const copiedValue = copyGraph(descriptor.value, context, depth + 1);
    if (copiedValue.isErr()) return err(copiedValue.error);
    defineOwn(copy, key, copiedValue.value);
  }
  if (ownKeys[length] !== "length") return err(unsafeGraphError());
  return ok(copy);
}

function copyRecord<T extends SafeGraphInputRecord>(
  source: T,
  context: SafeGraphContext,
  depth: number,
): Result<SafeGraphObject, SafeGraphCopyError> {
  const ownKeys = Reflect.ownKeys(source);
  if (ownKeys.length > context.budget.maxPropertiesPerObject) {
    return err(unsafeGraphError());
  }
  const propertiesConsumed = consumeProperties(ownKeys.length, context);
  if (propertiesConsumed.isErr()) return err(propertiesConsumed.error);

  const copy = emptySafeGraphObject();
  for (const key of ownKeys) {
    if (isSymbolKey(key)) return err(unsafeGraphError());
    const keyConsumed = consumeString(key, context);
    if (keyConsumed.isErr()) return err(keyConsumed.error);
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!requireWritableDataDescriptor(descriptor)) {
      return err(unsafeGraphError());
    }
    const copiedValue = copyGraph(descriptor.value, context, depth + 1);
    if (copiedValue.isErr()) return err(copiedValue.error);
    defineOwn(copy, key, copiedValue.value);
  }
  return ok(copy);
}

function isGraphObject<T>(value: T): value is T & SafeGraphInputRecord {
  return Object(value) === value;
}

function copyGraph<T>(
  value: T,
  context: SafeGraphContext,
  depth: number,
): Result<SafeGraphValue, SafeGraphCopyError> {
  if (isSafeGraphPrimitive(value)) {
    if (isSafeGraphString(value)) {
      const stringConsumed = consumeString(value, context);
      if (stringConsumed.isErr()) return err(stringConsumed.error);
    }
    const nodeConsumed = consumeNode(depth, context);
    if (nodeConsumed.isErr()) return err(nodeConsumed.error);
    return ok(value);
  }

  if (isCallable(value)) return err(unsafeGraphError());
  const nodeConsumed = consumeNode(depth, context);
  if (nodeConsumed.isErr()) return err(nodeConsumed.error);
  if (!isGraphObject(value)) return err(unsafeGraphError());
  if (context.active.has(value)) return err(unsafeGraphError());
  if (context.seen.has(value)) return err(unsafeGraphError());

  const prototype = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (isArray) {
    if (prototype !== Array.prototype) return err(unsafeGraphError());
    context.seen.add(value);
    context.active.add(value);
    const copied = copyArray(value, context, depth);
    context.active.delete(value);
    return copied;
  }

  if (prototype !== Object.prototype && prototype !== null) {
    return err(unsafeGraphError());
  }

  context.seen.add(value);
  context.active.add(value);
  const copied = copyRecord(value, context, depth);
  context.active.delete(value);
  return copied;
}

function runCopyGraph<T>(
  value: T,
  budget: SafeGraphCopyBudget,
): Result<SafeGraphValue, SafeGraphCopyError> {
  return copyGraph(
    value,
    {
      active: new WeakSet<SafeGraphInputRecord>(),
      seen: new WeakSet<SafeGraphInputRecord>(),
      budget,
      nodes: 0,
      properties: 0,
      stringLength: 0,
    },
    0,
  );
}

const safelyCopyGraph = Result.fromThrowable(runCopyGraph, () =>
  unsafeGraphError(),
);

/** Copy a descriptor-safe object graph without reading source property values. */
export function copySafeGraph<T>(
  value: T,
  budget: SafeGraphCopyBudget = DEFAULT_SAFE_GRAPH_COPY_BUDGET,
): Result<SafeGraphValue, SafeGraphCopyError> {
  return safelyCopyGraph(value, budget).andThen((result) =>
    result.andThen((copied) => ok<SafeGraphValue, SafeGraphCopyError>(copied)),
  );
}
