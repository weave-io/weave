/**
 * One-shot descriptor-based array snapshot.
 *
 * Captures prototype, Reflect.ownKeys, the own data `length` descriptor, and
 * every indexed data descriptor exactly once inside `Result.fromThrowable`.
 * Callers must normalize only the frozen captured elements and must never
 * reread live length or indices from the original value.
 *
 * Used by permission resolver-output normalization and coverage inventory
 * capture so changing proxies cannot TOCTOU deny/required arrays into empty
 * success paths.
 */

import { err, ok, Result } from "neverthrow";

export type ArraySnapshotError = {
  readonly type: "invalid_array";
  readonly message?: string;
};

const invalidArray = (message = "invalid array"): ArraySnapshotError => ({
  type: "invalid_array",
  message,
});

const isIndexKey = (key: string): boolean => {
  if (!/^(0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && String(index) === key;
};

/**
 * Snapshot a dense plain array from own data descriptors only.
 *
 * Rejects accessors, symbol keys, sparse holes, non-index extras, out-of-range
 * indices, non-safe lengths, non-Array prototypes, and reflection traps.
 * Returns a frozen dense array of the captured element values.
 */
export function snapshotArrayOnce(
  value: unknown,
): Result<readonly unknown[], ArraySnapshotError> {
  return Result.fromThrowable(
    () => {
      if (!Array.isArray(value))
        return err(invalidArray("value is not an array"));

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Array.prototype)
        return err(invalidArray("array prototype must be Array.prototype"));

      // Capture own keys exactly once. Later validation uses only this list.
      const keys = Reflect.ownKeys(value);

      // Capture every own descriptor exactly once from the key snapshot.
      const descriptors = new Map<string | symbol, PropertyDescriptor>();
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor) return err(invalidArray("missing own descriptor"));
        descriptors.set(key, descriptor);
      }

      const lengthDescriptor = descriptors.get("length");
      if (!lengthDescriptor || !("value" in lengthDescriptor))
        return err(invalidArray("length must be an own data property"));
      if (lengthDescriptor.enumerable)
        return err(invalidArray("length must not be enumerable"));
      const length = lengthDescriptor.value;
      if (
        typeof length !== "number" ||
        !Number.isSafeInteger(length) ||
        length < 0
      )
        return err(invalidArray("length must be a non-negative safe integer"));

      // No symbols, no extras beyond dense indices + length.
      if (keys.length !== length + 1)
        return err(
          invalidArray("array keys must be dense indices plus length"),
        );

      const indexKeys = new Set<string>();
      for (const key of keys) {
        if (key === "length") continue;
        if (typeof key !== "string" || !isIndexKey(key))
          return err(invalidArray("array has non-index or symbol keys"));
        const index = Number(key);
        if (index < 0 || index >= length)
          return err(invalidArray("array index out of range"));
        if (indexKeys.has(key))
          return err(invalidArray("array has duplicate index keys"));
        indexKeys.add(key);
      }

      if (indexKeys.size !== length)
        return err(invalidArray("sparse or incomplete array indices"));

      const values: unknown[] = new Array(length);
      for (let index = 0; index < length; index += 1) {
        const key = String(index);
        const descriptor = descriptors.get(key);
        if (
          !descriptor ||
          descriptor.enumerable !== true ||
          !("value" in descriptor)
        )
          return err(
            invalidArray("array index must be an own enumerable data property"),
          );
        values[index] = descriptor.value;
      }

      return ok(Object.freeze(values) as readonly unknown[]);
    },
    () => invalidArray("array snapshot failed"),
  )().andThen((result) => result);
}
