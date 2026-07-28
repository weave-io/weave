import { describe, expect, it } from "bun:test";
import {
  MAX_NATIVE_RECORD_BYTES,
  PiLineFramer,
} from "../child-framing.js";

const enc = new TextEncoder();

describe("PiLineFramer", () => {
  it("parses a single complete record from one chunk", () => {
    const framer = new PiLineFramer();
    const result = framer.push(enc.encode('{"a":1}\n'));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([
      { raw: '{"a":1}', json: { a: 1 } },
    ]);
  });

  it("parses multiple records delivered in a single chunk", () => {
    const framer = new PiLineFramer();
    const result = framer.push(enc.encode('{"a":1}\n{"b":2}\n'));
    expect(result.isOk()).toBe(true);
    const frames = result._unsafeUnwrap();
    expect(frames.map((f) => f.json)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("reassembles one record split across multiple chunks, including mid-multibyte-UTF-8 splits", () => {
    const framer = new PiLineFramer();
    const bytes = enc.encode('{"name":"caf\u00e9"}\n'); // "é" is 2 bytes in UTF-8
    // Split the é's two-byte sequence apart.
    const splitAt = bytes.indexOf(0xc3) + 1;
    const first = framer.push(bytes.slice(0, splitAt));
    expect(first._unsafeUnwrap()).toEqual([]);
    const second = framer.push(bytes.slice(splitAt));
    expect(second._unsafeUnwrap()).toEqual([
      { raw: '{"name":"café"}', json: { name: "café" } },
    ]);
  });

  it("accepts an optional CR before the LF", () => {
    const framer = new PiLineFramer();
    const result = framer.push(enc.encode('{"a":1}\r\n'));
    expect(result._unsafeUnwrap()).toEqual([
      { raw: '{"a":1}', json: { a: 1 } },
    ]);
  });

  it("never mistakes U+2028/U+2029 inside a JSON string for a record boundary", () => {
    const framer = new PiLineFramer();
    const record = JSON.stringify({ text: "line\u2028sep\u2029end" });
    const result = framer.push(enc.encode(`${record}\n`));
    expect(result.isOk()).toBe(true);
    const frames = result._unsafeUnwrap();
    expect(frames).toHaveLength(1);
    expect((frames[0]?.json as { text: string }).text).toBe(
      "line\u2028sep\u2029end",
    );
  });

  it("silently drops an empty line", () => {
    const framer = new PiLineFramer();
    const result = framer.push(enc.encode('\n{"a":1}\n'));
    expect(result._unsafeUnwrap()).toEqual([
      { raw: '{"a":1}', json: { a: 1 } },
    ]);
  });

  it("rejects a complete record exceeding the native cap and poisons the framer", () => {
    const framer = new PiLineFramer();
    const oversized = `{"pad":"${"x".repeat(MAX_NATIVE_RECORD_BYTES)}"}\n`;
    const result = framer.push(enc.encode(oversized));
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("RecordTooLarge");
    if (error.type === "RecordTooLarge") {
      expect(error.byteLength).toBeGreaterThan(MAX_NATIVE_RECORD_BYTES);
    }
    expect(JSON.stringify(error)).not.toContain("x");
    expect(framer.isPoisoned()).toBe(true);
    // Once poisoned, further input is fatally rejected without further parsing.
    expect(framer.push(enc.encode('{"a":1}\n')).isErr()).toBe(true);
  });

  it("rejects invalid UTF-8 fatally", () => {
    const framer = new PiLineFramer();
    const invalid = new Uint8Array([0xff, 0xfe, 0x0a]); // invalid UTF-8 followed by LF
    const result = framer.push(invalid);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("InvalidUtf8");
    expect(framer.isPoisoned()).toBe(true);
  });

  it("rejects duplicate JSON object keys within one record", () => {
    const framer = new PiLineFramer();
    const result = framer.push(enc.encode('{"a":1,"a":2}\n'));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("InvalidJson");
  });

  it("accepts a record that lands exactly at the native cap, including the LF", () => {
    const framer = new PiLineFramer();
    const fixedOverhead = '{"p":""}'.length + 1;
    const padLength = MAX_NATIVE_RECORD_BYTES - fixedOverhead;
    const line = `{"p":"${"x".repeat(padLength)}"}\n`;
    expect(enc.encode(line).byteLength).toBe(MAX_NATIVE_RECORD_BYTES);
    const result = framer.push(enc.encode(line));
    expect(result.isOk()).toBe(true);
    expect(framer.isPoisoned()).toBe(false);
  });

  it("rejects a complete native record exactly one byte over the cap", () => {
    const framer = new PiLineFramer();
    const fixedOverhead = '{"p":""}'.length + 1;
    const padLength = MAX_NATIVE_RECORD_BYTES + 1 - fixedOverhead;
    const line = `{"p":"${"x".repeat(padLength)}"}\n`;
    expect(enc.encode(line).byteLength).toBe(MAX_NATIVE_RECORD_BYTES + 1);

    const result = framer.push(enc.encode(line));
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error).toEqual({
      type: "RecordTooLarge",
      byteLength: MAX_NATIVE_RECORD_BYTES + 1,
    });
    expect(framer.isPoisoned()).toBe(true);
  });

  it("accepts a split exact-bound native record and later records", () => {
    const framer = new PiLineFramer();
    const fixedOverhead = '{"p":""}'.length + 1;
    const padLength = MAX_NATIVE_RECORD_BYTES - fixedOverhead;
    const nativeLine = `{"p":"${"x".repeat(padLength)}"}\n`;
    const input = enc.encode(`${nativeLine}{"next":true}\n`);

    const first = framer.push(input.slice(0, 17));
    expect(first.isOk()).toBe(true);
    if (first.isOk()) expect(first.value).toHaveLength(0);

    const rest = framer.push(input.slice(17));
    expect(rest.isOk()).toBe(true);
    if (rest.isOk()) {
      expect(rest.value).toHaveLength(2);
      expect(rest.value[0]?.raw.length).toBeGreaterThan(1_000_000);
      expect(rest.value[1]?.json).toEqual({ next: true });
    }
    expect(framer.isPoisoned()).toBe(false);
  });

  it("rejects an unterminated record before it can grow past the native cap", () => {
    const framer = new PiLineFramer();
    const atBoundary = new Uint8Array(MAX_NATIVE_RECORD_BYTES - 1);
    expect(framer.push(atBoundary).isOk()).toBe(true);

    const result = framer.push(new Uint8Array([0x78]));
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("RecordTooLarge");
    if (error.type === "RecordTooLarge") {
      expect(error.byteLength).toBe(MAX_NATIVE_RECORD_BYTES + 1);
    }
    expect(JSON.stringify(error)).not.toContain("x");
    expect(framer.isPoisoned()).toBe(true);
  });
});
