import { err, ok, Result } from "neverthrow";
import { z } from "zod";

export const UNSAFE_GRAPH_MESSAGE =
  "input must contain only own, enumerable, writable data properties on plain objects or arrays";

export type SafeGraphCopyError = {
  type: "UnsafeGraph";
  message: typeof UNSAFE_GRAPH_MESSAGE;
};

export type SafeGraphPrimitive =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined;

export type SafeGraphObject = {
  [key: string]: SafeGraphValue;
};

export type SafeGraphValue =
  | SafeGraphPrimitive
  | SafeGraphValue[]
  | SafeGraphObject;

const SafeGraphPrimitiveSchema = z.custom<SafeGraphPrimitive>((value) => {
  if (value === null || value === undefined) return true;
  if (value instanceof Object || value instanceof Function) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === Number.prototype ||
    prototype === String.prototype ||
    prototype === Boolean.prototype ||
    prototype === BigInt.prototype ||
    prototype === Symbol.prototype
  );
});

const SafeArrayLengthSchema = z
  .number()
  .refine((value) => Number.isSafeInteger(value) && value >= 0);

function unsafeGraphError(): SafeGraphCopyError {
  return { type: "UnsafeGraph", message: UNSAFE_GRAPH_MESSAGE };
}

function emptySafeGraphObject(): SafeGraphObject {
  return Object.setPrototypeOf({}, null);
}

function defineOwn(
  target: SafeGraphObject,
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
  return Object.prototype.toString.call(key) === "[object Symbol]";
}

function isGraphObject<T>(value: T): value is T & object {
  return value instanceof Object || Object.getPrototypeOf(value) === null;
}

function copyArray<T extends object>(
  source: T,
  active: WeakSet<object>,
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
  const lengthParsed = SafeArrayLengthSchema.safeParse(lengthDescriptor.value);
  if (!lengthParsed.success) return err(unsafeGraphError());
  const length = lengthParsed.data;
  const ownKeys = Reflect.ownKeys(source);
  if (ownKeys.length !== length + 1) return err(unsafeGraphError());

  const copy: SafeGraphValue[] = [];
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
    const copiedValue = copyGraph(descriptor.value, active);
    if (copiedValue.isErr()) return err(copiedValue.error);
    copy.push(copiedValue.value);
  }
  if (ownKeys[length] !== "length") return err(unsafeGraphError());
  return ok(copy);
}

function copyRecord<T extends object>(
  source: T,
  active: WeakSet<object>,
): Result<SafeGraphObject, SafeGraphCopyError> {
  const copy = emptySafeGraphObject();
  for (const key of Reflect.ownKeys(source)) {
    if (isSymbolKey(key)) return err(unsafeGraphError());
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
    const copiedValue = copyGraph(descriptor.value, active);
    if (copiedValue.isErr()) return err(copiedValue.error);
    defineOwn(copy, key, copiedValue.value);
  }
  return ok(copy);
}

function copyGraph<T>(
  value: T,
  active: WeakSet<object>,
): Result<SafeGraphValue, SafeGraphCopyError> {
  if (value === null || value === undefined) {
    const parsed = SafeGraphPrimitiveSchema.safeParse(value);
    if (!parsed.success) return err(unsafeGraphError());
    return ok(parsed.data);
  }
  if (value instanceof Function) return err(unsafeGraphError());

  const prototype = Object.getPrototypeOf(value);
  if (
    prototype === Number.prototype ||
    prototype === String.prototype ||
    prototype === Boolean.prototype ||
    prototype === BigInt.prototype ||
    prototype === Symbol.prototype
  ) {
    const parsed = SafeGraphPrimitiveSchema.safeParse(value);
    if (!parsed.success) return err(unsafeGraphError());
    return ok(parsed.data);
  }

  if (!isGraphObject(value)) return err(unsafeGraphError());
  if (active.has(value)) return err(unsafeGraphError());

  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) return err(unsafeGraphError());
    active.add(value);
    const copied = copyArray(value, active);
    active.delete(value);
    return copied;
  }

  if (prototype !== Object.prototype && prototype !== null) {
    return err(unsafeGraphError());
  }

  active.add(value);
  const copied = copyRecord(value, active);
  active.delete(value);
  return copied;
}

function runCopyGraph<T>(value: T): Result<SafeGraphValue, SafeGraphCopyError> {
  return copyGraph(value, new WeakSet<object>());
}

const safelyCopyGraph = Result.fromThrowable(runCopyGraph, () =>
  unsafeGraphError(),
);

function copiedGraphResult(
  copied: SafeGraphValue,
): Result<unknown, SafeGraphCopyError> {
  return ok(copied);
}

/** Copy a descriptor-safe object graph without reading source property values. */
export function copySafeGraph<T>(
  value: T,
): Result<unknown, SafeGraphCopyError> {
  return safelyCopyGraph(value).andThen((result) =>
    result.andThen(copiedGraphResult),
  );
}
