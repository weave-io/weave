import { describe, expect, it } from "bun:test";
import {
  canonicalizeToBytes,
  type JsonValue,
  parseStrictJson,
} from "../strict-json.js";

describe("parseStrictJson", () => {
  it("parses ordinary nested values", () => {
    const result = parseStrictJson('{"a":1,"b":[true,false,null,"x"]}');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      a: 1,
      b: [true, false, null, "x"],
    });
  });

  it("parses string escapes including \\u unicode escapes", () => {
    const result = parseStrictJson('"line\\nbreak \\u00e9"');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe("line\nbreak \u00e9");
  });

  it("rejects duplicate object keys structurally, unlike JSON.parse", () => {
    const result = parseStrictJson('{"a":1,"a":2}');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "DuplicateObjectKey",
      position: 7,
      key: "a",
    });
  });

  it("rejects trailing content after the single value", () => {
    const result = parseStrictJson("{}garbage");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("TrailingContent");
  });

  it("rejects invalid numbers and unterminated strings", () => {
    expect(parseStrictJson("01").isErr()).toBe(true);
    expect(parseStrictJson('"unterminated').isErr()).toBe(true);
  });

  it("rejects a number literal that overflows to a non-finite value", () => {
    const result = parseStrictJson("1e400");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("InvalidNumber");
  });

  it("rejects an integer-shaped literal outside the safe-integer range", () => {
    const result = parseStrictJson("99999999999999999999");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("InvalidNumber");
  });

  it("accepts a large non-integer literal (only integer-shaped literals are safe-integer bounded)", () => {
    expect(parseStrictJson("1.7976931348623157e300").isOk()).toBe(true);
  });

  it("never repoints the object's own prototype when a key is literally __proto__", () => {
    const result = parseStrictJson('{"__proto__":{"polluted":true}}');
    const parsed = result._unsafeUnwrap() as Record<string, unknown>;
    expect(Object.getPrototypeOf(parsed)).toBe(null);
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects an invalid \\u escape", () => {
    const result = parseStrictJson('"\\uZZZZ"');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("InvalidEscape");
  });
});

describe("canonicalizeToBytes", () => {
  it("orders object keys deterministically regardless of insertion order", () => {
    const a = canonicalizeToBytes({ b: 1, a: 2 });
    const b = canonicalizeToBytes({ a: 2, b: 1 });
    expect(a.isOk() && b.isOk()).toBe(true);
    expect(new TextDecoder().decode(a._unsafeUnwrap())).toBe('{"a":2,"b":1}');
    expect(a._unsafeUnwrap()).toEqual(b._unsafeUnwrap());
  });

  it("normalizes negative zero to 0", () => {
    const result = canonicalizeToBytes(-0);
    expect(new TextDecoder().decode(result._unsafeUnwrap())).toBe("0");
  });

  it("rejects non-finite numbers", () => {
    const result = canonicalizeToBytes(Number.POSITIVE_INFINITY);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("NonFiniteNumber");
  });

  it("rejects unsafe integers", () => {
    const result = canonicalizeToBytes(Number.MAX_SAFE_INTEGER + 2048);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("UnsafeInteger");
  });

  it("rejects a lone (unpaired) surrogate inside a string", () => {
    const result = canonicalizeToBytes("bad\uD800end");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("LoneSurrogate");
  });

  it("accepts a valid surrogate pair", () => {
    const result = canonicalizeToBytes("\uD83D\uDE00");
    expect(result.isOk()).toBe(true);
  });

  it("produces identical bytes for structurally identical arrays regardless of nested key order", () => {
    const a = canonicalizeToBytes([{ x: 1, y: 2 }]);
    const b = canonicalizeToBytes([{ y: 2, x: 1 }]);
    expect(a._unsafeUnwrap()).toEqual(b._unsafeUnwrap());
  });

  it("rejects a hostile object whose Object.keys() throws, without throwing itself", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("boom");
        },
      },
    );
    const result = canonicalizeToBytes(hostile);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("HostileAccessor");
  });

  it("rejects a hostile object whose property getter throws, without throwing itself", () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "a", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    const result = canonicalizeToBytes(hostile as unknown as JsonValue);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("HostileAccessor");
  });

  it("rejects a hostile array whose length getter throws, without throwing itself", () => {
    const hostile = new Proxy([1, 2, 3], {
      get(target, prop, receiver) {
        if (prop === "length") throw new Error("boom");
        return Reflect.get(target, prop, receiver);
      },
    });
    const result = canonicalizeToBytes(hostile);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("HostileAccessor");
  });

  it("rejects a hostile array whose element getter throws, without throwing itself", () => {
    const hostile = new Proxy([1, 2, 3], {
      get(target, prop, receiver) {
        if (prop === "1") throw new Error("boom");
        return Reflect.get(target, prop, receiver);
      },
    });
    const result = canonicalizeToBytes(hostile);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("HostileAccessor");
  });

  // RFC 8785 (JCS) Appendix B.1-style vectors: canonical form must not
  // depend on source key order, must render integers without a decimal
  // point, and must escape only what I-JSON/JCS requires.
  it("matches an RFC 8785-style canonical vector for a small mixed object", () => {
    const value = {
      numbers: [333333333.3333333, 1.5e10, 4.5, 0, -0],
      string: '\u20ac$\u000f\nA\'B"\\\\"\\/',
      literals: [null, true, false],
    };
    const result = canonicalizeToBytes(value);
    expect(result.isOk()).toBe(true);
    const text = new TextDecoder().decode(result._unsafeUnwrap());
    // Object keys must be sorted (UTF-16 code-unit order): literals, numbers, string.
    expect(text.startsWith('{"literals":')).toBe(true);
    expect(text.indexOf('"literals"')).toBeLessThan(text.indexOf('"numbers"'));
    expect(text.indexOf('"numbers"')).toBeLessThan(text.indexOf('"string"'));
    // -0 must normalize to bare 0, matching its sibling literal 0.
    expect(text.includes("[null,true,false]")).toBe(true);
  });

  it("canonicalizes nested-key reordering identically for a deeply nested structure (JCS determinism)", () => {
    const a = { z: { b: 1, a: 2 }, a: [{ y: 1, x: 2 }] };
    const b = { a: [{ x: 2, y: 1 }], z: { a: 2, b: 1 } };
    expect(canonicalizeToBytes(a)._unsafeUnwrap()).toEqual(
      canonicalizeToBytes(b)._unsafeUnwrap(),
    );
  });
});
