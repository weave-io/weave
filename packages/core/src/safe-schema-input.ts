import { Result } from "neverthrow";
import { z } from "zod";

const UNSAFE_INPUT_MESSAGE =
  "input must contain only own, enumerable, writable data properties on plain objects or arrays";

function inspectInput(value: unknown, active: WeakSet<object>): boolean {
  if (value === null || typeof value !== "object") return true;
  if (active.has(value)) return false;
  active.add(value);

  const prototype = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (
    isArray
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  ) {
    active.delete(value);
    return false;
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      active.delete(value);
      return false;
    }
    if (isArray && key === "length") continue;

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      descriptor.configurable !== true ||
      descriptor.writable !== true
    ) {
      active.delete(value);
      return false;
    }
    if (!inspectInput(descriptor.value, active)) {
      active.delete(value);
      return false;
    }
  }
  active.delete(value);
  return true;
}

const safelyInspectInput = Result.fromThrowable(
  (value: unknown) => inspectInput(value, new WeakSet<object>()),
  () => false,
);

/** Reject unsafe object graphs before a composed Zod schema reads any value. */
export function safeSchemaInput<T extends z.ZodType>(
  schema: T,
): z.ZodType<z.output<T>, z.input<T>> {
  return z.preprocess((input, ctx) => {
    const safe = safelyInspectInput(input).unwrapOr(false);
    if (safe) return input;
    ctx.issues.push({
      code: "custom",
      input,
      message: UNSAFE_INPUT_MESSAGE,
    });
    return z.NEVER;
  }, schema) as z.ZodType<z.output<T>, z.input<T>>;
}
