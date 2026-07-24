import { describe, expect, it } from "bun:test";
import {
  bytesToHex,
  ErasableSecret,
  generateChildSecret,
  generateNonceHex,
  hexToBytes,
  timingSafeEqualHex,
  WebCryptoHmacPort,
  WebCryptoRandomPort,
} from "../child-crypto.js";

const randomPort = new WebCryptoRandomPort();
const hmacPort = new WebCryptoHmacPort();

describe("WebCryptoRandomPort", () => {
  it("produces the requested number of bytes", () => {
    expect(randomPort.randomBytes(32).length).toBe(32);
    expect(randomPort.randomBytes(16).length).toBe(16);
  });

  it("does not produce identical output on successive calls (statistically)", () => {
    const a = randomPort.randomBytes(32);
    const b = randomPort.randomBytes(32);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });
});

describe("generateChildSecret / generateNonceHex", () => {
  it("generates a 256-bit (32-byte) secret", () => {
    const secret = generateChildSecret(randomPort);
    expect(secret.peek()?.length).toBe(32);
    secret.dispose();
  });

  it("generates a 128-bit (32 hex char) nonce", () => {
    const nonce = generateNonceHex(randomPort);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("ErasableSecret", () => {
  it("zero-fills and clears the reference on dispose()", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const secret = new ErasableSecret(bytes);
    expect(secret.peek()).toBe(bytes);
    secret.dispose();
    expect(secret.peek()).toBeUndefined();
    expect(Array.from(bytes)).toEqual([0, 0, 0, 0]);
  });

  it("dispose() is idempotent", () => {
    const secret = new ErasableSecret(new Uint8Array([9, 9]));
    secret.dispose();
    expect(() => secret.dispose()).not.toThrow();
    expect(secret.peek()).toBeUndefined();
  });
});

describe("bytesToHex / hexToBytes", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 255, 16, 128]);
    const hex = bytesToHex(bytes);
    expect(hex).toBe("0001ff1080");
    expect(Array.from(hexToBytes(hex) ?? [])).toEqual(Array.from(bytes));
  });

  it("rejects malformed hex (odd length or non-hex chars)", () => {
    expect(hexToBytes("abc")).toBeUndefined();
    expect(hexToBytes("zz")).toBeUndefined();
  });
});

describe("timingSafeEqualHex", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqualHex("abcd1234", "abcd1234")).toBe(true);
  });

  it("returns false for differing strings of the same length", () => {
    expect(timingSafeEqualHex("abcd1234", "abcd1235")).toBe(false);
  });

  it("returns false for strings of different lengths", () => {
    expect(timingSafeEqualHex("abcd", "abcd1234")).toBe(false);
  });
});

describe("WebCryptoHmacPort", () => {
  it("produces a deterministic lowercase-hex HMAC-SHA-256 for the same key/data", async () => {
    const key = new Uint8Array(32).fill(1);
    const data = new TextEncoder().encode("hello world");
    const a = await hmacPort.signHex(key, data);
    const b = await hmacPort.signHex(key, data);
    expect(a.isOk()).toBe(true);
    expect(a._unsafeUnwrap()).toBe(b._unsafeUnwrap());
    expect(a._unsafeUnwrap()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces a different MAC for different data", async () => {
    const key = new Uint8Array(32).fill(1);
    const a = await hmacPort.signHex(key, new TextEncoder().encode("one"));
    const b = await hmacPort.signHex(key, new TextEncoder().encode("two"));
    expect(a._unsafeUnwrap()).not.toBe(b._unsafeUnwrap());
  });

  it("produces a different MAC for a different key", async () => {
    const data = new TextEncoder().encode("same data");
    const a = await hmacPort.signHex(new Uint8Array(32).fill(1), data);
    const b = await hmacPort.signHex(new Uint8Array(32).fill(2), data);
    expect(a._unsafeUnwrap()).not.toBe(b._unsafeUnwrap());
  });
});
