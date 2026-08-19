import { describe, expect, test } from "bun:test";
import {
  canonicalizeJson,
  cloneAndFreezeJson,
  MAX_ARRAY_ELEMENTS,
  normalizePermissionRequests,
  permissionDigest,
  sanitizePermissionDisplay,
  validateRequest,
} from "../permissions/canonical.js";

describe("permission canonicalization", () => {
  test("supports JSON values and UTF-16 key order", () => {
    expect(
      canonicalizeJson({ "10": "a", "2": "b", é: "c" })._unsafeUnwrap(),
    ).toBe('{"10":"a","2":"b","é":"c"}');
    expect(canonicalizeJson([null, true, 1, "x"]).isOk()).toBe(true);
  });
  test("normalizes negative zero and rejects unsafe values", () => {
    expect(canonicalizeJson(-0)._unsafeUnwrap()).toBe("0");
    expect(canonicalizeJson(Infinity).isErr()).toBe(true);
    expect(canonicalizeJson(Symbol("x")).isErr()).toBe(true);
  });
  test("clones without touching or freezing source", () => {
    const source = { nested: { value: 1 } };
    const result = cloneAndFreezeJson(source);
    expect(result.isOk()).toBe(true);
    expect(Object.isFrozen(source)).toBe(false);
    const copied = result._unsafeUnwrap();
    if (copied === null || Array.isArray(copied)) throw new Error("fixture");
    // SAFETY: cloneAndFreezeJson returns a closed JSON object for this plain object fixture.
    const copiedObject = copied as { readonly nested: object };
    expect(Object.isFrozen(copiedObject.nested)).toBe(true);
  });
  test("never invokes accessors and rejects extra request fields", () => {
    let called = false;
    const value = Object.defineProperty({}, "summary", {
      get: () => {
        called = true;
        return "x";
      },
      enumerable: true,
    });
    expect(cloneAndFreezeJson(value).isErr()).toBe(true);
    expect(called).toBe(false);
    const request = {
      unresolved: true,
      display: { summary: "x" },
      capability: "read",
    };
    expect(validateRequest(request).isErr()).toBe(true);
  });
  test("keeps hostile keys out of unsafe paths and supports prototype-like keys", () => {
    const hostileKey = { TOP_SECRET: Symbol("secret") };
    const rejected = cloneAndFreezeJson(hostileKey);
    expect(rejected.isErr()).toBe(true);
    expect(JSON.stringify(rejected._unsafeUnwrapErr())).not.toContain(
      "TOP_SECRET",
    );

    type PrototypeFixture = {
      readonly [key: string]: string | { readonly safe: boolean };
    };
    const value: PrototypeFixture = Object.create(null);
    Object.defineProperty(value, "__proto__", {
      value: "safe",
      enumerable: true,
      writable: true,
    });
    Object.defineProperty(value, "constructor", {
      value: { safe: true },
      enumerable: true,
      writable: true,
    });
    const copiedValue = cloneAndFreezeJson(value)._unsafeUnwrap();
    if (copiedValue === null || Array.isArray(copiedValue))
      throw new Error("fixture");
    // SAFETY: cloneAndFreezeJson returns a closed JSON object for this plain fixture.
    const copy = copiedValue as PrototypeFixture;
    expect(Object.getOwnPropertyDescriptor(copy, "__proto__")?.value).toBe(
      "safe",
    );
    expect(Object.getOwnPropertyDescriptor(copy, "constructor")?.value).toEqual(
      { safe: true },
    );
    expect(Object.getPrototypeOf(copy)).toBeNull();
  });
  test("maps reflection traps and unsafe resolver constraints to closed results", () => {
    const traps = [
      "getPrototypeOf",
      "ownKeys",
      "getOwnPropertyDescriptor",
      "get",
    ] as const;
    for (const trap of traps) {
      const handler: ProxyHandler<object> = {};
      if (trap === "getPrototypeOf")
        handler.getPrototypeOf = () => {
          throw new Error(`TOP_SECRET_${trap}`);
        };
      if (trap === "ownKeys")
        handler.ownKeys = () => {
          throw new Error(`TOP_SECRET_${trap}`);
        };
      if (trap === "getOwnPropertyDescriptor")
        handler.getOwnPropertyDescriptor = () => {
          throw new Error(`TOP_SECRET_${trap}`);
        };
      if (trap === "get")
        handler.get = () => {
          throw new Error(`TOP_SECRET_${trap}`);
        };
      const value = new Proxy({ x: 1 }, handler);
      const result = cloneAndFreezeJson(value);
      if (trap === "get") {
        expect(result.isOk()).toBe(true);
        continue;
      }
      expect(result.isErr()).toBe(true);
      expect(JSON.stringify(result._unsafeUnwrapErr())).not.toContain(
        "TOP_SECRET",
      );
    }
    const constraints = new Proxy(
      { secret: 1 },
      {
        getOwnPropertyDescriptor: () => {
          throw new Error("TOP_SECRET_constraint");
        },
      },
    );
    const result = normalizePermissionRequests([
      {
        unresolved: false,
        capability: "read",
        operation: "read",
        target: { kind: "file", identifier: "x" },
        display: { summary: "read" },
        constraints,
      },
    ]);
    expect(result._unsafeUnwrapErr().type).toBe("invalid_output");
    expect(JSON.stringify(result._unsafeUnwrapErr())).not.toContain(
      "TOP_SECRET",
    );
  });
  test("sanitizes display text at UTF-8 and hostile-character boundaries", () => {
    expect(sanitizePermissionDisplay({ summary: "é".repeat(128) }).isOk()).toBe(
      true,
    );
    expect(
      sanitizePermissionDisplay({ summary: "é".repeat(129) }).isErr(),
    ).toBe(true);
    expect(sanitizePermissionDisplay({ summary: "\ud800" }).isErr()).toBe(true);
    expect(
      sanitizePermissionDisplay({
        summary: "ok",
        details: "é".repeat(1024),
      }).isOk(),
    ).toBe(true);
    expect(
      sanitizePermissionDisplay({
        summary: "ok",
        details: "é".repeat(1025),
      }).isErr(),
    ).toBe(true);
    for (const value of [
      "line\nfeed",
      "tab\tvalue",
      "escape\u001b",
      "\u202ehidden",
      "\u2066hidden",
      "\u2028break",
      "\u034f",
    ]) {
      const result = sanitizePermissionDisplay({ summary: value });
      expect(result.isErr()).toBe(true);
      expect(JSON.stringify(result._unsafeUnwrapErr())).not.toContain(value);
    }
    expect(
      sanitizePermissionDisplay({ summary: "ok", details: "" })._unsafeUnwrap(),
    ).toEqual({ summary: "ok" });
  });
  test("stable request digest", () => {
    const a = { b: 2, a: 1 };
    const b = { a: 1, b: 2 };
    expect(permissionDigest(a)._unsafeUnwrap()).toBe(
      permissionDigest(b)._unsafeUnwrap(),
    );
  });

  test("normalizes plain dense resolver arrays unchanged", () => {
    const requests = [
      {
        unresolved: false as const,
        capability: "read" as const,
        operation: "read",
        target: { kind: "file", identifier: "a.txt" },
        display: { summary: "read a.txt" },
      },
      {
        unresolved: true as const,
        display: { summary: "needs human" },
      },
    ];
    const result = normalizePermissionRequests(requests);
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value).toHaveLength(2);
    expect(value[0]).toMatchObject({
      unresolved: false,
      capability: "read",
      operation: "read",
    });
    expect(value[1]).toMatchObject({ unresolved: true });
    expect(Object.isFrozen(value)).toBe(true);
  });

  test("changing get-length proxy cannot empty deny resolver output", () => {
    const denyRequest = {
      unresolved: false as const,
      capability: "write" as const,
      operation: "write",
      target: { kind: "file", identifier: "secret" },
      display: { summary: "write secret" },
    };
    let lengthReads = 0;
    const changing = new Proxy([denyRequest], {
      get(_target, prop, _receiver) {
        if (prop === "length") {
          lengthReads += 1;
          // Classic TOCTOU: first live length read passes non-empty, later
          // reads return 0 and skip elements. Descriptor snapshot keeps deny.
          return lengthReads <= 1 ? 1 : 0;
        }
        return void 0;
      },
    });
    const result = normalizePermissionRequests(changing);
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value).toHaveLength(1);
    expect(value[0]).toMatchObject({
      unresolved: false,
      capability: "write",
      operation: "write",
    });
  });

  test("rejects inconsistent ownKeys/length descriptor proxy for resolver arrays", () => {
    const denyRequest = {
      unresolved: false as const,
      capability: "execute" as const,
      operation: "run",
      target: { kind: "cmd", identifier: "rm" },
      display: { summary: "run rm" },
    };
    const changing = new Proxy([denyRequest], {
      ownKeys() {
        // Claim a dense index key exists...
        return ["0", "length"];
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (prop === "length") {
          // ...but length says empty. One-shot consistency check rejects.
          return {
            value: 0,
            writable: true,
            enumerable: false,
            configurable: false,
          };
        }
        if (prop === "0") {
          return {
            value: denyRequest,
            writable: true,
            enumerable: true,
            configurable: true,
          };
        }
        return;
      },
    });
    const result = normalizePermissionRequests(changing);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("invalid_output");
    expect(JSON.stringify(result._unsafeUnwrapErr())).not.toContain("run rm");
    expect(JSON.stringify(result._unsafeUnwrapErr())).not.toContain(
      '"identifier":"rm"',
    );
  });

  test("maps throwing array traps on resolver output to closed invalid_output", () => {
    const traps = [
      "getPrototypeOf",
      "ownKeys",
      "getOwnPropertyDescriptor",
    ] as const;
    for (const trap of traps) {
      type ResolverFixture = {
        readonly unresolved: boolean;
        readonly capability: string;
        readonly operation: string;
        readonly target: { readonly kind: string; readonly identifier: string };
        readonly display: { readonly summary: string };
      };
      const handler: ProxyHandler<ResolverFixture[]> = {};
      if (trap === "getPrototypeOf")
        handler.getPrototypeOf = () => {
          throw new Error(`TOP_SECRET_ARRAY_${trap}`);
        };
      if (trap === "ownKeys")
        handler.ownKeys = () => {
          throw new Error(`TOP_SECRET_ARRAY_${trap}`);
        };
      if (trap === "getOwnPropertyDescriptor")
        handler.getOwnPropertyDescriptor = () => {
          throw new Error(`TOP_SECRET_ARRAY_${trap}`);
        };
      const value = new Proxy(
        [
          {
            unresolved: false,
            capability: "read",
            operation: "read",
            target: { kind: "file", identifier: "x" },
            display: { summary: "read" },
          },
        ],
        handler,
      );
      const result = normalizePermissionRequests(value);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe("invalid_output");
      expect(JSON.stringify(result._unsafeUnwrapErr())).not.toContain(
        "TOP_SECRET",
      );
    }
  });

  test("rejects empty captured resolver arrays as empty_output", () => {
    const result = normalizePermissionRequests([]);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("empty_output");
  });

  test("fail-fast rejects hostile sparse array lengths without length-driven allocation", () => {
    const sparseLength = (length: number) =>
      new Proxy([], {
        ownKeys: () => ["length"],
        getOwnPropertyDescriptor(_target, prop) {
          if (prop === "length") {
            return {
              value: length,
              writable: true,
              enumerable: false,
              configurable: false,
            };
          }
          return;
        },
        get(_target, prop, _receiver) {
          if (prop === "length") return length;
          return void 0;
        },
      });

    const started = performance.now();
    // Classic sparse DoS: length near 2^32-1 with no index keys. Must reject
    // from the ownKeys/length consistency bound without Array.from(length).
    const result = cloneAndFreezeJson(sparseLength(2 ** 32 - 1));
    const elapsed = performance.now() - started;
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("unsafe_input");
    expect(elapsed).toBeLessThan(50);

    const bound = cloneAndFreezeJson(sparseLength(MAX_ARRAY_ELEMENTS + 1));
    expect(bound.isErr()).toBe(true);
    expect(bound._unsafeUnwrapErr().type).toBe("unsafe_input");
  });

  test("array clone captures descriptors once and does not reread mutable length", () => {
    const base = ["a", "b"];
    let lengthReads = 0;
    let ownKeysReads = 0;
    const proxy = new Proxy(base, {
      ownKeys(target) {
        ownKeysReads += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, prop) {
        if (prop === "length") {
          lengthReads += 1;
          // After the first capture, pretend length exploded. Snapshot must
          // keep the first data-descriptor value and never reallocate from it.
          return {
            value: lengthReads === 1 ? 2 : 2 ** 32 - 2,
            writable: true,
            enumerable: false,
            configurable: false,
          };
        }
        return Object.getOwnPropertyDescriptor(target, prop);
      },
    });
    const result = cloneAndFreezeJson(proxy);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(["a", "b"]);
    expect(ownKeysReads).toBe(1);
    expect(lengthReads).toBe(1);
  });
});
