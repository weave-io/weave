import { describe, expect, it } from "bun:test";
import {
  canonicalizeJson,
  digestJson,
  parseJsonValue,
  validateJsonValue,
} from "../json.js";

interface CyclicInput {
  self?: CyclicInput;
}

describe("release JSON boundaries", () => {
  it("validates parsed values before canonicalization", () => {
    const parsed = parseJsonValue('{"b":1,"a":[true,null]}');
    expect(parsed.isOk()).toBe(true);
    if (parsed.isErr()) return;
    const canonical = canonicalizeJson(parsed.value);
    expect(canonical.isOk()).toBe(true);
    if (canonical.isOk())
      expect(canonical.value).toBe('{"a":[true,null],"b":1}');
  });

  it("rejects non-finite numbers produced by JSON.parse", () => {
    const parsed = parseJsonValue("1e400");
    expect(parsed.isErr()).toBe(true);
    if (parsed.isErr() && parsed.error.type === "JsonCanonicalizationError")
      expect(parsed.error.reason).toBe("non-finite-number");
  });

  it.each([
    ["undefined", undefined],
    ["bigint", BigInt(1)],
    ["symbol", Symbol("secret")],
    ["function", () => "not JSON"],
  ])("rejects %s instead of converting it to null", (_name, value) => {
    const canonical = validateJsonValue(value).andThen((bounded) =>
      canonicalizeJson(bounded),
    );
    const digest = validateJsonValue(value).andThen((bounded) =>
      digestJson(bounded),
    );
    expect(canonical.isErr()).toBe(true);
    expect(digest.isErr()).toBe(true);
    expect(canonical.isErr() ? canonical.error.reason : "").toBe(
      "unsupported-value",
    );
    expect(digest.isErr() ? digest.error.reason : "").toBe("unsupported-value");
  });

  it("rejects cyclic values instead of collapsing them", () => {
    const value: CyclicInput = {};
    value.self = value;
    const canonical = validateJsonValue(value).andThen((bounded) =>
      canonicalizeJson(bounded),
    );
    const digest = validateJsonValue(value).andThen((bounded) =>
      digestJson(bounded),
    );
    expect(canonical.isErr()).toBe(true);
    expect(digest.isErr()).toBe(true);
    if (canonical.isErr()) expect(canonical.error.reason).toBe("cyclic-value");
    if (digest.isErr()) expect(digest.error.reason).toBe("cyclic-value");
  });

  it("keeps canonical identity stable across object insertion order", () => {
    const left = validateJsonValue({ a: 1, b: [true, null] });
    const right = validateJsonValue({ b: [true, null], a: 1 });
    expect(left.isOk()).toBe(true);
    expect(right.isOk()).toBe(true);
    if (left.isErr() || right.isErr()) return;
    const leftDigest = digestJson(left.value);
    const rightDigest = digestJson(right.value);
    expect(leftDigest.isOk()).toBe(true);
    expect(rightDigest.isOk()).toBe(true);
    if (leftDigest.isOk() && rightDigest.isOk())
      expect(leftDigest.value).toBe(rightDigest.value);
  });
});
