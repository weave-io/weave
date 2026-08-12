import { err, ok, Result } from "neverthrow";

export const UNSAFE_GRAPH_MESSAGE =
  "input must contain only own, enumerable, writable data properties on plain objects or arrays";

export type SafeGraphCopyError = {
  type: "UnsafeGraph";
  message: typeof UNSAFE_GRAPH_MESSAGE;
};

function unsafeGraphError(): SafeGraphCopyError {
  return { type: "UnsafeGraph", message: UNSAFE_GRAPH_MESSAGE };
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

function copyArray(
  source: unknown[],
  active: WeakSet<object>,
): Result<unknown[], SafeGraphCopyError> {
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
    const copiedValue = copyGraph(descriptor.value, active);
    if (copiedValue.isErr()) return err(copiedValue.error);
    copy.push(copiedValue.value);
  }
  if (ownKeys[length] !== "length") return err(unsafeGraphError());
  return ok(copy);
}

function copyRecord(
  source: object,
  active: WeakSet<object>,
): Result<Record<string, unknown>, SafeGraphCopyError> {
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key === "symbol") return err(unsafeGraphError());
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

function copyGraph(
  value: unknown,
  active: WeakSet<object>,
): Result<unknown, SafeGraphCopyError> {
  if (typeof value === "function") return err(unsafeGraphError());
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
  const copied = isArray ? copyArray(value, active) : copyRecord(value, active);
  active.delete(value);
  return copied;
}

const safelyCopyGraph = Result.fromThrowable(
  (value: unknown) => copyGraph(value, new WeakSet<object>()),
  () => unsafeGraphError(),
);

/** Copy a descriptor-safe object graph without reading source property values. */
export function copySafeGraph(
  value: unknown,
): Result<unknown, SafeGraphCopyError> {
  return safelyCopyGraph(value).andThen((result) => result);
}
