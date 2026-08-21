/**
 * One-shot descriptor-safe array snapshot.
 *
 * Captures the outer array's own keys, length descriptor, and every indexed
 * data descriptor exactly once. Nested values remain opaque until the owner
 * validates them with its closed domain parser.
 */

import { err, ok, Result } from "neverthrow";

const MAX_ARRAY_ELEMENTS = 1_048_576;

type PrimitiveTag = "number" | "string" | "other";

export type ArraySnapshotError = {
  readonly type: "invalid_array";
  readonly message?: string;
};

const invalidArray = (message = "invalid array"): ArraySnapshotError => ({
  type: "invalid_array",
  message,
});

const primitiveTag = <T>(value: T): PrimitiveTag => {
  if (Object(value) === value) return "other";
  const tagged = Result.fromThrowable(
    () => Object.prototype.toString.call(value),
    () => "[object Object]",
  )();
  if (tagged.isErr()) return "other";
  if (tagged.value === "[object Number]") return "number";
  if (tagged.value === "[object String]") return "string";
  return "other";
};

const isIndexKey = (key: string): boolean => {
  if (!/^(0|[1-9]\d*)$/u.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && String(index) === key;
};

/**
 * Snapshot a dense plain array from own data descriptors only.
 *
 * Returns descriptors rather than values so the caller can parse each value
 * with its own closed contract. The descriptor values are captured once and
 * are never read from the source array again.
 */
export function snapshotArrayOnce<T>(
  value: T,
): Result<readonly PropertyDescriptor[], ArraySnapshotError> {
  return Result.fromThrowable(
    () => {
      if (!Array.isArray(value))
        return err(invalidArray("value is not an array"));
      if (Object.getPrototypeOf(value) !== Array.prototype)
        return err(invalidArray("array prototype must be Array.prototype"));

      const keys = Reflect.ownKeys(value);
      if (keys.length > MAX_ARRAY_ELEMENTS + 1)
        return err(invalidArray("array exceeds the element bound"));
      const descriptors = new Map<string | symbol, PropertyDescriptor>();
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined)
          return err(invalidArray("missing own descriptor"));
        descriptors.set(key, descriptor);
      }

      const lengthDescriptor = descriptors.get("length");
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        lengthDescriptor.enumerable
      )
        return err(invalidArray("length must be an own data property"));
      if (primitiveTag(lengthDescriptor.value) !== "number")
        return err(invalidArray("length must be a non-negative safe integer"));
      const length = Number(lengthDescriptor.value);
      if (!Number.isSafeInteger(length) || length < 0)
        return err(invalidArray("length must be a non-negative safe integer"));
      if (length > MAX_ARRAY_ELEMENTS)
        return err(invalidArray("array exceeds the element bound"));
      if (keys.length !== length + 1)
        return err(
          invalidArray("array keys must be dense indices plus length"),
        );

      const indexDescriptors = new Map<number, PropertyDescriptor>();
      for (const key of keys) {
        if (key === "length") continue;
        if (Object.prototype.toString.call(key) !== "[object String]")
          return err(invalidArray("array has non-index or symbol keys"));
        const text = String(key);
        if (!isIndexKey(text))
          return err(invalidArray("array has non-index or symbol keys"));
        const index = Number(text);
        if (index < 0 || index >= length)
          return err(invalidArray("array index out of range"));
        const descriptor = descriptors.get(text);
        if (
          descriptor === undefined ||
          descriptor.enumerable !== true ||
          !("value" in descriptor)
        )
          return err(
            invalidArray("array index must be an own enumerable data property"),
          );
        if (indexDescriptors.has(index))
          return err(invalidArray("array has duplicate index keys"));
        indexDescriptors.set(index, descriptor);
      }

      if (indexDescriptors.size !== length)
        return err(invalidArray("sparse or incomplete array indices"));
      const captured: PropertyDescriptor[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = indexDescriptors.get(index);
        if (descriptor === undefined)
          return err(invalidArray("sparse or incomplete array indices"));
        captured.push(descriptor);
      }
      return ok(Object.freeze(captured));
    },
    () => invalidArray("array snapshot failed"),
  )().andThen((result) => result);
}
