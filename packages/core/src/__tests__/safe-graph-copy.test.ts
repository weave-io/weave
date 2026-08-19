import { describe, expect, it } from "bun:test";
import type { SafeGraphValue } from "../safe-graph-copy.js";
import {
  copySafeGraph,
  MAX_SAFE_GRAPH_ARRAY_LENGTH,
  MAX_SAFE_GRAPH_DEPTH,
  MAX_SAFE_GRAPH_PROPERTIES_PER_OBJECT,
  MAX_SAFE_GRAPH_STRING_LENGTH,
} from "../safe-graph-copy.js";

type NestedRecord = {
  next?: NestedRecord;
};

type BooleanRecord = {
  [key: string]: boolean;
};

function expectUnsafe<T>(value: T) {
  const result = copySafeGraph(value);
  expect(result.isErr()).toBe(true);
  if (result.isErr()) expect(result.error.type).toBe("UnsafeGraph");
}

describe("copySafeGraph hostile graph boundary", () => {
  it("rejects callable proxies before inspecting their properties", () => {
    let ownKeysTrapCalls = 0;
    const callable = (): void => {};
    const callableProxy = new Proxy(callable, {
      ownKeys() {
        ownKeysTrapCalls += 1;
        return [];
      },
    });

    expectUnsafe(callableProxy);
    expect(ownKeysTrapCalls).toBe(0);
  });

  it("rejects function-backed spoof values without executing accessors", () => {
    let getterExecutions = 0;
    const spoof = Object.create(Function.prototype);
    Object.defineProperty(spoof, "value", {
      configurable: true,
      enumerable: true,
      get() {
        getterExecutions += 1;
        return "unsafe";
      },
    });

    expectUnsafe(spoof);
    expect(getterExecutions).toBe(0);
  });

  it("rejects callable functions even after their prototype is spoofed", () => {
    const callable = (): void => {};
    Object.setPrototypeOf(callable, Object.prototype);

    expectUnsafe(callable);
  });

  it("rejects accessors, symbols, sparse arrays, cycles, and unexpected prototypes", () => {
    let getterExecutions = 0;
    const accessor = {};
    Object.defineProperty(accessor, "value", {
      configurable: true,
      enumerable: true,
      get() {
        getterExecutions += 1;
        return "unsafe";
      },
    });

    const symbolKey = {};
    Object.defineProperty(symbolKey, Symbol("unsafe"), {
      configurable: true,
      enumerable: true,
      writable: true,
      value: true,
    });

    const sparse: boolean[] = [];
    sparse.length = 1;

    const cycle: NestedRecord = {};
    cycle.next = cycle;

    class HostileRecord {}
    const unexpectedPrototype = new HostileRecord();

    expectUnsafe(accessor);
    expectUnsafe(symbolKey);
    expectUnsafe(Symbol("unsafe"));
    expectUnsafe(sparse);
    expectUnsafe(cycle);
    expectUnsafe(unexpectedPrototype);
    expect(getterExecutions).toBe(0);
  });

  it("accepts a dense array at the element bound", () => {
    const boundedArray = Array.from(
      { length: MAX_SAFE_GRAPH_ARRAY_LENGTH },
      () => false,
    );
    const result = copySafeGraph(boundedArray);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual(boundedArray);
  });

  it("rejects sibling and deeper aliases", () => {
    const sibling = { leaf: true };
    const deeper = [{ child: sibling }, { child: sibling }];

    expectUnsafe([sibling, sibling]);
    expectUnsafe(deeper);
  });

  it("rejects a depth-16 shared AST array without exponential recopying", () => {
    let ownKeysCalls = 0;
    const sharedLeaf = new Proxy([true], {
      ownKeys(target) {
        ownKeysCalls += 1;
        return Reflect.ownKeys(target);
      },
    });

    let nested: SafeGraphValue = sharedLeaf;
    for (let depth = 0; depth < 16; depth += 1) {
      nested = [nested, nested];
    }

    const result = copySafeGraph(nested);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("UnsafeGraph");
    expect(ownKeysCalls).toBe(1);
  });

  it("defines copied array indexes without invoking inherited numeric setters", () => {
    const nested = ["nested"];
    const source = [nested, "outer"];
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, "0");
    let setterExecutions = 0;
    try {
      Object.defineProperty(Array.prototype, "0", {
        configurable: true,
        set() {
          setterExecutions += 1;
        },
      });

      const result = copySafeGraph(source);
      const observedSetterExecutions = setterExecutions;

      expect(result.isOk()).toBe(true);
      expect(observedSetterExecutions).toBe(0);
      if (result.isOk() && Array.isArray(result.value)) {
        for (const [index, value] of result.value.entries()) {
          const descriptor = Object.getOwnPropertyDescriptor(
            result.value,
            String(index),
          );
          expect(descriptor).toEqual({
            value,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
        const copiedNested = result.value[0];
        expect(Array.isArray(copiedNested)).toBe(true);
        if (Array.isArray(copiedNested)) {
          expect(Object.getOwnPropertyDescriptor(copiedNested, "0")).toEqual({
            value: "nested",
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
      }
    } finally {
      if (previous === undefined) Reflect.deleteProperty(Array.prototype, "0");
      else Object.defineProperty(Array.prototype, "0", previous);
    }
  });

  it("rejects oversized depth, entry, aggregate property, array, and content bounds", () => {
    const deepRoot: NestedRecord = {};
    let current = deepRoot;
    for (let index = 0; index <= MAX_SAFE_GRAPH_DEPTH; index += 1) {
      const next: NestedRecord = {};
      current.next = next;
      current = next;
    }

    const wide: BooleanRecord = {};
    for (
      let index = 0;
      index <= MAX_SAFE_GRAPH_PROPERTIES_PER_OBJECT;
      index += 1
    ) {
      wide[`property-${index}`] = true;
    }

    const aggregate: BooleanRecord[] = [];
    for (let index = 0; index < MAX_SAFE_GRAPH_ARRAY_LENGTH; index += 1) {
      const entry: BooleanRecord = {};
      for (let field = 0; field < 9; field += 1) {
        entry[`field-${field}`] = true;
      }
      aggregate.push(entry);
    }

    const oversizedArray = Array.from(
      { length: MAX_SAFE_GRAPH_ARRAY_LENGTH + 1 },
      () => false,
    );
    const oversizedContent = {
      content: "x".repeat(MAX_SAFE_GRAPH_STRING_LENGTH + 1),
    };

    expectUnsafe(deepRoot);
    expectUnsafe(wide);
    expectUnsafe(aggregate);
    expectUnsafe(oversizedArray);
    expectUnsafe(oversizedContent);
  });
});
