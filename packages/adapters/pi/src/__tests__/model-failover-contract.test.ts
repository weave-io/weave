import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import {
  canAdvancePiFailover,
  classifyPiFailure,
  classifyPiProviderFailure,
  classifyPiRecoveryFailure,
  consumePiFailureAdvance,
  createPiCandidateCursor,
  isPiCandidateContextEligible,
  isPiFailureAdvanceEligible,
  MAX_PI_ERROR_MESSAGE_PREFIX_LENGTH,
  MAX_PI_OBSERVED_ATTEMPT_COUNT,
  PI_FAILOVER_FAILURE_CLASSES,
  type PiCandidatePreflightPort,
  type PiFailoverFailureClass,
} from "../model-failover-contract.js";
import type { PiModelInfo } from "../model-resolution.js";

const failedMessage = (errorMessage: string, stopReason = "error") => ({
  stopReason,
  errorMessage,
});

const classify = (errorMessage: string, nativeRetryAttempts = 0) =>
  classifyPiFailure(failedMessage(errorMessage), { nativeRetryAttempts });

describe("Pi failover failure contract", () => {
  it("keeps the failure class set closed and exact", () => {
    expect(PI_FAILOVER_FAILURE_CLASSES).toEqual([
      "authentication_failed",
      "authorization_failed",
      "rate_limited",
      "provider_unavailable",
      "timeout",
      "context_overflow_unrecovered",
      "unknown_provider_failure",
    ]);
  });

  it.each([
    ["401 invalid api key", "authentication_failed"],
    ["403 forbidden", "authorization_failed"],
    ["429 too many requests", "rate_limited"],
    ["503 service unavailable", "provider_unavailable"],
    ["request timed out", "timeout"],
    ["context window exceeded", "context_overflow_unrecovered"],
    ["provider returned an unrecognized failure", "unknown_provider_failure"],
  ] as const)("classifies %s as %s", (message, failureClass) => {
    expect(classify(message)).toEqual({
      failureClass,
      observedAttemptCount: 0,
    });
  });

  it("classifies the hook payload and keeps only a bounded attempt count", () => {
    const result = classifyPiRecoveryFailure({
      type: "agent_recovery_exhausted",
      message: failedMessage("503 upstream unavailable"),
      nativeRetryAttempts: Number.MAX_SAFE_INTEGER,
      overflowRecoveryAttempted: false,
    });
    expect(result).toEqual({
      failureClass: "provider_unavailable",
      observedAttemptCount: MAX_PI_OBSERVED_ATTEMPT_COUNT,
    });
    expect(JSON.stringify(result)).not.toContain("upstream");
    expect(JSON.stringify(result)).not.toContain("503");
  });

  it("accepts the provider spelling without exposing another result shape", () => {
    expect(
      classifyPiProviderFailure(failedMessage("429 rate limited")),
    ).toEqual({
      failureClass: "rate_limited",
      observedAttemptCount: 0,
    });
  });

  it("recognizes a failed overflow recovery without needing provider text", () => {
    expect(
      classifyPiFailure({
        type: "agent_recovery_exhausted",
        message: { stopReason: "length" },
        nativeRetryAttempts: 2,
        overflowRecoveryAttempted: true,
      }),
    ).toEqual({
      failureClass: "context_overflow_unrecovered",
      observedAttemptCount: 2,
    });
  });

  it("defensively refuses to classify an aborted assistant", () => {
    expect(
      classifyPiFailure({ stopReason: "aborted", errorMessage: "401" }),
    ).toBe(undefined);
    expect(
      classifyPiFailure({
        type: "agent_recovery_exhausted",
        message: { stopReason: "aborted", errorMessage: "401" },
        nativeRetryAttempts: 3,
      }),
    ).toBeUndefined();
  });

  it("returns unknown for missing or non-error message shapes", () => {
    expect(classifyPiFailure(undefined)).toEqual({
      failureClass: "unknown_provider_failure",
      observedAttemptCount: 0,
    });
    expect(
      classifyPiFailure({ stopReason: "stop", errorMessage: "503" }),
    ).toEqual({
      failureClass: "unknown_provider_failure",
      observedAttemptCount: 0,
    });
    expect(classifyPiFailure({ stopReason: "error" })).toEqual({
      failureClass: "unknown_provider_failure",
      observedAttemptCount: 0,
    });
    expect(classifyPiFailure({ stopReason: "error", statusCode: 401 })).toEqual(
      {
        failureClass: "unknown_provider_failure",
        observedAttemptCount: 0,
      },
    );
  });

  it("reads only enumerable data properties and never invokes accessors", () => {
    let getterCalls = 0;
    const accessor = { stopReason: "error" } as {
      stopReason: string;
      errorMessage?: string;
    };
    Object.defineProperty(accessor, "errorMessage", {
      enumerable: true,
      configurable: true,
      get: () => {
        getterCalls += 1;
        throw new Error("must not run");
      },
    });
    expect(classifyPiFailure(accessor)).toEqual({
      failureClass: "unknown_provider_failure",
      observedAttemptCount: 0,
    });
    expect(getterCalls).toBe(0);

    const inherited = Object.create({
      stopReason: "error",
      errorMessage: "401 inherited",
    }) as object;
    expect(classifyPiFailure(inherited)).toEqual({
      failureClass: "unknown_provider_failure",
      observedAttemptCount: 0,
    });
  });

  it("fails closed for throwing proxies and oversized messages", () => {
    const throwingProxy = new Proxy(
      { stopReason: "error", errorMessage: "401" },
      {
        getOwnPropertyDescriptor: () => {
          throw new Error("hostile descriptor");
        },
      },
    );
    expect(() => classifyPiFailure(throwingProxy)).not.toThrow();
    expect(classifyPiFailure(throwingProxy)).toEqual({
      failureClass: "unknown_provider_failure",
      observedAttemptCount: 0,
    });

    expect(
      classifyPiFailure(
        failedMessage(`401 ${"x".repeat(MAX_PI_ERROR_MESSAGE_PREFIX_LENGTH)}`),
      ),
    ).toEqual({
      failureClass: "unknown_provider_failure",
      observedAttemptCount: 0,
    });
  });

  it("does not retain raw text even when the prefix contains secrets", () => {
    const secret = "SECRET_PROVIDER_PAYLOAD_123";
    const result = classify(`${secret} timeout`);
    expect(result).toEqual({
      failureClass: "timeout",
      observedAttemptCount: 0,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("saturates malformed and negative attempt counts to a safe value", () => {
    expect(classify("503", -1)).toEqual({
      failureClass: "provider_unavailable",
      observedAttemptCount: 0,
    });
    expect(classify("503", Number.POSITIVE_INFINITY)).toEqual({
      failureClass: "provider_unavailable",
      observedAttemptCount: 0,
    });
    expect(classify("503", MAX_PI_OBSERVED_ATTEMPT_COUNT + 10)).toEqual({
      failureClass: "provider_unavailable",
      observedAttemptCount: MAX_PI_OBSERVED_ATTEMPT_COUNT,
    });
  });

  it("allows known failures and only one unknown advance per prompt cycle", () => {
    const known = PI_FAILOVER_FAILURE_CLASSES.filter(
      (failureClass) => failureClass !== "unknown_provider_failure",
    );
    for (const failureClass of known) {
      expect(isPiFailureAdvanceEligible(failureClass, 99)).toBe(true);
      expect(canAdvancePiFailover(failureClass, 99)).toBe(true);
    }
    expect(isPiFailureAdvanceEligible("unknown_provider_failure", 0)).toBe(
      true,
    );
    expect(isPiFailureAdvanceEligible("unknown_provider_failure", 1)).toBe(
      false,
    );
    expect(consumePiFailureAdvance("unknown_provider_failure", 0)).toEqual({
      advance: true,
      unknownAdvancesUsed: 1,
    });
    expect(consumePiFailureAdvance("unknown_provider_failure", 1)).toEqual({
      advance: false,
      unknownAdvancesUsed: 1,
    });
  });
});

describe("Pi failover candidate cursor and eligibility", () => {
  const models: PiModelInfo[] = [
    { provider: "one", id: "a", name: "A", contextWindow: 8 },
    { provider: "two", id: "b", name: "B", contextWindow: 16 },
    { provider: "three", id: "c", name: "C", contextWindow: 32 },
  ];

  it("starts after the failed identity, advances monotonically, and never wraps", () => {
    const cursor = createPiCandidateCursor(models, "two/b");
    expect(cursor.cap).toBe(models.length);
    expect(cursor.position).toBe(2);
    expect(cursor.next()).toBe(models[2]);
    expect(cursor.position).toBe(3);
    expect(cursor.advanced).toBe(1);
    expect(cursor.next()).toBeUndefined();
    expect(cursor.position).toBe(3);
    expect(cursor.next()).toBeUndefined();
    expect(cursor.position).toBe(3);
  });

  it("uses the complete bounded list when the failed identity is absent", () => {
    const cursor = createPiCandidateCursor(models, "missing/model");
    expect([
      cursor.next(),
      cursor.next(),
      cursor.next(),
      cursor.next(),
    ]).toEqual([models[0], models[1], models[2], undefined]);
    expect(cursor.advanced).toBe(models.length);
    expect(cursor.cap).toBe(models.length);
  });

  it("uses a model object failed identity and clamps an end position", () => {
    const cursor = createPiCandidateCursor(models, models[2]);
    expect(cursor.position).toBe(models.length);
    expect(cursor.exhausted).toBe(true);
    expect(cursor.next()).toBeUndefined();
  });

  it("requires a strictly larger context window only for overflow", () => {
    expect(
      isPiCandidateContextEligible(
        models[1],
        models[0],
        "context_overflow_unrecovered",
      ),
    ).toBe(true);
    expect(
      isPiCandidateContextEligible(
        { ...models[0], contextWindow: 8 },
        models[0],
        "context_overflow_unrecovered",
      ),
    ).toBe(false);
    expect(
      isPiCandidateContextEligible(
        { ...models[0], contextWindow: 7 },
        models[0],
        "context_overflow_unrecovered",
      ),
    ).toBe(false);
    expect(
      isPiCandidateContextEligible(
        { provider: "unknown", id: "unknown" },
        models[0],
        "context_overflow_unrecovered",
      ),
    ).toBe(false);
  });

  it("ignores context windows for every non-overflow class", () => {
    for (const failureClass of [
      "authentication_failed",
      "authorization_failed",
      "rate_limited",
      "provider_unavailable",
      "timeout",
      "unknown_provider_failure",
    ] as const) {
      expect(
        isPiCandidateContextEligible(
          { provider: "unknown", id: "unknown" },
          undefined,
          failureClass,
        ),
      ).toBe(true);
    }
  });

  it("keeps preflight outcomes typed and credential-free", async () => {
    const port: PiCandidatePreflightPort = {
      preflight: (candidate) =>
        candidate.model.provider === "one"
          ? okAsync({ status: "eligible" })
          : errAsync({ type: "ProviderCredentialsUnavailable" }),
    };
    const eligible = await port.preflight({
      resolved: true,
      model: models[0],
      intentEntry: "one/a",
      source: "canonical",
    });
    const skipped = await port.preflight({
      resolved: true,
      model: models[1],
      intentEntry: "two/b",
      source: "canonical",
    });
    expect(eligible._unsafeUnwrap()).toEqual({ status: "eligible" });
    expect(skipped._unsafeUnwrapErr()).toEqual({
      type: "ProviderCredentialsUnavailable",
    });
  });

  it("keeps the failure class union usable as a closed input", () => {
    const failureClass: PiFailoverFailureClass = "timeout";
    expect(isPiFailureAdvanceEligible(failureClass)).toBe(true);
  });
});
