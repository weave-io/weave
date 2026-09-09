import { describe, expect, it } from "bun:test";
import {
  copySafeGraph,
  DEFAULT_SAFE_GRAPH_COPY_BUDGET,
} from "../safe-graph-copy.js";

describe("copySafeGraph", () => {
  it("copies plain data and prototype-named keys without prototype assignment", () => {
    const input = JSON.parse(
      '{"__proto__":{"polluted":true},"array":["text",1,null]}',
    );
    const copied = copySafeGraph(input)._unsafeUnwrap();
    expect(Object.getPrototypeOf(copied)).toBeNull();
    expect(Object.hasOwn(copied as object, "__proto__")).toBe(true);
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(copied).toEqual(input);
    expect(copied).not.toBe(input);
  });

  it("rejects getters without invoking them, and rejects callable and cyclic graphs", () => {
    let reads = 0;
    const getter = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => {
        reads++;
        return "secret";
      },
    });
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    for (const value of [
      getter,
      () => undefined,
      { nested: () => undefined },
      cycle,
      new Date(),
      Symbol("value"),
      1n,
      Infinity,
      NaN,
      Array(3),
    ]) {
      expect(copySafeGraph(value).isErr()).toBe(true);
    }
    expect(reads).toBe(0);
  });

  it("bounds depth, nodes, keys, arrays, and strings", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 70; i++) deep = { deep };
    expect(copySafeGraph(deep)._unsafeUnwrapErr().reason).toBe("limit");
    for (const [key, value] of Object.entries({
      maxNodes: { a: 1 },
      maxProperties: { a: 1 },
      maxPropertiesPerObject: { a: 1 },
      maxArrayLength: [1],
      maxStringLength: "abc",
    })) {
      expect(
        copySafeGraph(value, {
          ...DEFAULT_SAFE_GRAPH_COPY_BUDGET,
          [key]: 0,
        }).isErr(),
      ).toBe(true);
    }
    expect(
      copySafeGraph(
        {},
        { ...DEFAULT_SAFE_GRAPH_COPY_BUDGET, maxDepth: Infinity },
      ).isErr(),
    ).toBe(true);
  });

  it("captures reflection failures and accepts frozen plain data", () => {
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("private cause");
        },
      },
    );
    expect(copySafeGraph(proxy)._unsafeUnwrapErr()).toEqual({
      type: "UnsafeGraph",
      reason: "property",
    });
    expect(
      copySafeGraph(Object.freeze({ values: Object.freeze([1, 2]) })).isOk(),
    ).toBe(true);
  });
});
