import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import {
  MODEL_REGISTRY_THREW_REASON,
  safelyAwaitPortResult,
  safelyListAvailableModels,
} from "../port-safety.js";

/**
 * A "hostile" thrown value whose `toString`/`valueOf`/`Symbol.toPrimitive`
 * all throw - if any code path ever tried to stringify or template-
 * interpolate this value (e.g. `String(cause)` or `` `${cause}` ``), it
 * would itself throw. Used to prove nothing in this module's failure paths
 * ever attempts that.
 */
function hostileThrowable(): unknown {
  return {
    toString(): string {
      throw new Error("toString exploded");
    },
    valueOf(): never {
      throw new Error("valueOf exploded");
    },
    [Symbol.toPrimitive](): never {
      throw new Error("toPrimitive exploded");
    },
  };
}

describe("safelyListAvailableModels", () => {
  it("never throws for a hostile thrown object and reports the fixed, sanitized reason", () => {
    const result = safelyListAvailableModels({
      getAvailable: () => {
        throw hostileThrowable();
      },
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe(MODEL_REGISTRY_THREW_REASON);
  });

  it("never surfaces a thrown Error's message, even when it contains sensitive-looking content", () => {
    const result = safelyListAvailableModels({
      getAvailable: () => {
        throw new Error(
          "leaked: /Users/attacker/.ssh/id_rsa token=sk-super-secret-123",
        );
      },
    });
    expect(result.isErr()).toBe(true);
    const reason = result._unsafeUnwrapErr();
    expect(reason).toBe(MODEL_REGISTRY_THREW_REASON);
    expect(reason).not.toContain("id_rsa");
    expect(reason).not.toContain("sk-super-secret-123");
  });

  it("never surfaces a thrown plain string's content", () => {
    const result = safelyListAvailableModels({
      getAvailable: () => {
        throw "raw string with a secret: sk-abcdef";
      },
    });
    expect(result.isErr()).toBe(true);
    const reason = result._unsafeUnwrapErr();
    expect(reason).toBe(MODEL_REGISTRY_THREW_REASON);
    expect(reason).not.toContain("sk-abcdef");
  });

  it("passes the available models through unchanged on success", () => {
    const models = [{ provider: "anthropic", id: "claude-sonnet-4-5" }];
    const result = safelyListAvailableModels({ getAvailable: () => models });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(models);
  });
});

describe("safelyAwaitPortResult", () => {
  it("never throws when the wrapped call throws a hostile object synchronously", async () => {
    const result = await safelyAwaitPortResult<string, never, string>(
      () => {
        throw hostileThrowable();
      },
      () => "sanitized-reason",
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe("sanitized-reason");
  });

  it("never throws when the wrapped call rejects with a hostile object", async () => {
    const result = await safelyAwaitPortResult<string, never, string>(
      () => Promise.reject(hostileThrowable()),
      () => "sanitized-reason",
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe("sanitized-reason");
  });

  it("surfaces a genuine Err from the port unchanged, without invoking onThrow", async () => {
    let onThrowCalls = 0;
    const result = await safelyAwaitPortResult<string, string, string>(
      () => errAsync("real domain error"),
      () => {
        onThrowCalls += 1;
        return "sanitized-reason";
      },
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe("real domain error");
    expect(onThrowCalls).toBe(0);
  });

  it("surfaces a genuine Ok from the port unchanged", async () => {
    const result = await safelyAwaitPortResult<string, never, string>(
      () => okAsync("value"),
      () => "unused",
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe("value");
  });
});
