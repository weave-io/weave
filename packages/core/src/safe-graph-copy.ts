import { err, ok, Result } from "neverthrow";

export interface SafeGraphCopyBudget {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxProperties: number;
  readonly maxPropertiesPerObject: number;
  readonly maxArrayLength: number;
  readonly maxStringLength: number;
}

export const DEFAULT_SAFE_GRAPH_COPY_BUDGET: SafeGraphCopyBudget = {
  maxDepth: 64,
  maxNodes: 16_384,
  maxProperties: 16_384,
  maxPropertiesPerObject: 1024,
  maxArrayLength: 4096,
  maxStringLength: 1024 * 1024,
};

export type SafeGraphValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | SafeGraphValue[]
  | { [key: string]: SafeGraphValue };
export type SafeGraphCopyError = {
  type: "UnsafeGraph";
  reason: "value" | "prototype" | "property" | "cycle" | "limit";
};

/** Copy only data descriptors. Never invoke getters or coerce source values. */
class GraphCopy {
  private nodes = 0;
  private properties = 0;
  private stringLength = 0;
  private readonly active = new WeakSet<object>();

  constructor(private readonly budget: SafeGraphCopyBudget) {}

  copy(value: unknown, depth = 0): Result<SafeGraphValue, SafeGraphCopyError> {
    if (++this.nodes > this.budget.maxNodes || depth > this.budget.maxDepth)
      return err({ type: "UnsafeGraph", reason: "limit" });
    if (typeof value === "string") {
      this.stringLength += value.length;
      if (this.stringLength > this.budget.maxStringLength)
        return err({ type: "UnsafeGraph", reason: "limit" });
      return ok(value);
    }
    if (value === null || value === undefined || typeof value === "boolean")
      return ok(value);
    if (typeof value === "number" && Number.isFinite(value)) return ok(value);
    if (typeof value !== "object")
      return err({ type: "UnsafeGraph", reason: "value" });
    if (this.active.has(value))
      return err({ type: "UnsafeGraph", reason: "cycle" });
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== null && prototype !== Object.prototype
    )
      return err({ type: "UnsafeGraph", reason: "prototype" });
    const keys = Reflect.ownKeys(value);
    this.properties += keys.length;
    if (this.properties > this.budget.maxProperties)
      return err({ type: "UnsafeGraph", reason: "limit" });
    if (!array && keys.length > this.budget.maxPropertiesPerObject)
      return err({ type: "UnsafeGraph", reason: "limit" });
    let length = 0;
    if (array) {
      const descriptor = Object.getOwnPropertyDescriptor(value, "length");
      length = descriptor?.value;
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > this.budget.maxArrayLength
      )
        return err({ type: "UnsafeGraph", reason: "limit" });
      if (keys.length !== length + 1)
        return err({ type: "UnsafeGraph", reason: "property" });
    }
    const output: SafeGraphValue[] | { [key: string]: SafeGraphValue } = array
      ? []
      : Object.create(null);
    this.active.add(value);
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index];
      if (array && key === "length" && index === length) continue;
      if (typeof key !== "string" || (array && key !== String(index)))
        return err({ type: "UnsafeGraph", reason: "property" });
      this.stringLength += key.length;
      if (this.stringLength > this.budget.maxStringLength)
        return err({ type: "UnsafeGraph", reason: "limit" });
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      )
        return err({ type: "UnsafeGraph", reason: "property" });
      const copied = this.copy(descriptor.value, depth + 1);
      if (copied.isErr()) return copied;
      Object.defineProperty(output, key, {
        value: copied.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    this.active.delete(value);
    return ok(output);
  }
}

/** Bounded snapshot of plain data. Reflection failures stay inside the Result. */
export function copySafeGraph(
  value: unknown,
  budget: SafeGraphCopyBudget = DEFAULT_SAFE_GRAPH_COPY_BUDGET,
): Result<SafeGraphValue, SafeGraphCopyError> {
  return Result.fromThrowable(
    () => {
      if (
        Object.values(budget).some(
          (limit) => !Number.isSafeInteger(limit) || limit < 0,
        )
      )
        return err<SafeGraphValue, SafeGraphCopyError>({
          type: "UnsafeGraph",
          reason: "limit",
        });
      return new GraphCopy(budget).copy(value);
    },
    (): SafeGraphCopyError => ({ type: "UnsafeGraph", reason: "property" }),
  )().andThen((result) => result);
}
