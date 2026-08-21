import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import {
  canAdvancePiFailover,
  classifyPiFailure,
  classifyPiMessageEndFailure,
  consumePiFailureAdvance,
  createPiCandidateCursor,
  createPiModelFailoverMarker,
  fingerprintPiAssistantMessage,
  isPiAssistantFingerprintEqual,
  isPiCandidateContextEligible,
  isPiFailureAdvanceEligible,
  isPiModelFailoverMarker,
  isPiPayloadlessAgentSettledEvent,
  isPiUuidV4,
  MAX_PI_ASSISTANT_FINGERPRINT_CONTENT_BLOCKS,
  MAX_PI_ASSISTANT_FINGERPRINT_DEPTH,
  MAX_PI_ASSISTANT_FINGERPRINT_PROPERTIES,
  MAX_PI_ERROR_MESSAGE_BYTES,
  MAX_PI_FAILOVER_CANDIDATES,
  MAX_PI_MODEL_FAILOVER_MARKER_CONTENT_BYTES,
  PI_FAILOVER_FAILURE_CLASSES,
  PI_MODEL_FAILOVER_MARKER_CONTENT,
  PI_MODEL_FAILOVER_MARKER_TYPE,
  type PiCandidatePreflightPort,
  type PiFailoverFailureClass,
} from "../model-failover-contract.js";
import type { PiModelInfo } from "../model-resolution.js";

const failed = (fields: Record<string, unknown> = {}) => ({
  role: "assistant",
  stopReason: "error",
  ...fields,
});

function fingerprint(message: unknown) {
  const result = fingerprintPiAssistantMessage(message);
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe("Pi public-lifecycle failover contract", () => {
  it("keeps the failure class set closed", () => {
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
    [{ statusCode: 401 }, "authentication_failed"],
    [{ httpStatus: 403 }, "authorization_failed"],
    [{ responseStatus: 429 }, "rate_limited"],
    [{ status: 503 }, "provider_unavailable"],
    [{ errorMessage: "request timed out" }, "timeout"],
    [
      { errorMessage: "context window exceeded" },
      "context_overflow_unrecovered",
    ],
    [
      { errorMessage: "provider returned an unrecognized failure" },
      "unknown_provider_failure",
    ],
  ] as const)("classifies bounded own data %#", (fields, failureClass) => {
    expect(classifyPiFailure(failed(fields))).toEqual({ failureClass });
  });

  it("classifies the public message_end wrapper and no stale recovery payload", () => {
    const event = {
      type: "message_end",
      message: failed({ errorMessage: "429 too many requests" }),
    };
    expect(classifyPiMessageEndFailure(event)).toEqual({
      failureClass: "rate_limited",
    });
    expect(classifyPiFailure(event)).toEqual({
      failureClass: "rate_limited",
    });
    expect(
      classifyPiMessageEndFailure({
        type: "agent_recovery_exhausted",
        message: failed({ errorMessage: "401" }),
      }),
    ).toBeUndefined();
  });

  it("accepts only the payloadless public agent_settled event", () => {
    expect(isPiPayloadlessAgentSettledEvent({ type: "agent_settled" })).toBe(
      true,
    );
    expect(
      isPiPayloadlessAgentSettledEvent({
        type: "agent_settled",
        message: failed(),
      }),
    ).toBe(false);
    expect(isPiPayloadlessAgentSettledEvent({ type: "turn_end" })).toBe(false);
    expect(
      isPiPayloadlessAgentSettledEvent({
        type: "agent_settled",
        details: undefined,
      }),
    ).toBe(false);
  });

  it("never recovers abort, normal completion, or length alone", () => {
    expect(
      classifyPiFailure({ ...failed(), stopReason: "aborted" }),
    ).toBeUndefined();
    expect(
      classifyPiFailure({
        ...failed(),
        stopReason: "stop",
        errorMessage: "503",
      }),
    ).toBeUndefined();
    expect(
      classifyPiFailure({
        ...failed({ errorMessage: "context window exceeded" }),
        stopReason: "length",
      }),
    ).toBeUndefined();
    expect(
      classifyPiFailure({ role: "assistant", stopReason: "length" }),
    ).toBeUndefined();
    expect(classifyPiFailure({ role: "assistant" })).toBeUndefined();
  });

  it("rejects adversarial descriptors without invoking accessors", () => {
    let getterCalls = 0;
    const accessor = failed();
    Object.defineProperty(accessor, "errorMessage", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error("must not run");
      },
    });
    expect(() => classifyPiFailure(accessor)).not.toThrow();
    expect(classifyPiFailure(accessor)).toEqual({
      failureClass: "unknown_provider_failure",
    });
    expect(getterCalls).toBe(0);

    const proxy = new Proxy(failed({ errorMessage: "401" }), {
      getOwnPropertyDescriptor: () => {
        throw new Error("hostile descriptor");
      },
    });
    expect(() => classifyPiFailure(proxy)).not.toThrow();
    expect(classifyPiFailure(proxy)).toBeUndefined();
  });

  it("bounds error text and retains no provider text", () => {
    const secret = "SECRET_PROVIDER_PAYLOAD_123";
    const result = classifyPiFailure(
      failed({ errorMessage: `${secret} timeout` }),
    );
    expect(result).toEqual({ failureClass: "timeout" });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(
      classifyPiFailure(
        failed({
          errorMessage: `401 ${"x".repeat(MAX_PI_ERROR_MESSAGE_BYTES)}`,
        }),
      ),
    ).toEqual({ failureClass: "unknown_provider_failure" });
  });

  it("allows known classes and one unknown advance per prompt epoch", () => {
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

describe("strict recovery marker", () => {
  const token = "550e8400-e29b-41d4-a716-446655440000";

  it("creates fixed bounded hidden content and strict UUID-v4 details", () => {
    const marker = createPiModelFailoverMarker(token);
    expect(marker.isOk()).toBe(true);
    const value = marker._unsafeUnwrap();
    expect(value).toEqual({
      role: "custom",
      customType: PI_MODEL_FAILOVER_MARKER_TYPE,
      content: PI_MODEL_FAILOVER_MARKER_CONTENT,
      details: { schemaVersion: 1, token },
      display: false,
    });
    expect(isPiUuidV4(token)).toBe(true);
    expect(isPiModelFailoverMarker(value, token)).toBe(true);
    expect(
      new TextEncoder().encode(PI_MODEL_FAILOVER_MARKER_CONTENT).byteLength,
    ).toBeLessThanOrEqual(MAX_PI_MODEL_FAILOVER_MARKER_CONTENT_BYTES);
    expect(JSON.stringify(value)).not.toContain("failed provider output");
  });

  it("rejects malformed marker tokens and marker details", () => {
    expect(createPiModelFailoverMarker("not-a-uuid").isErr()).toBe(true);
    const marker = createPiModelFailoverMarker(token)._unsafeUnwrap();
    expect(
      isPiModelFailoverMarker(
        { ...marker, details: { schemaVersion: 2, token } },
        token,
      ),
    ).toBe(false);
    expect(
      isPiModelFailoverMarker(
        { ...marker, details: { schemaVersion: 1, token, extra: true } },
        token,
      ),
    ).toBe(false);
  });
});

describe("bounded failed-assistant fingerprint", () => {
  const assistant = {
    role: "assistant",
    id: "failed-1",
    stopReason: "error",
    content: [{ type: "text", text: "provider secret output" }],
    usage: { input: 10, output: 2 },
  };

  it("hashes the complete assistant without retaining content", () => {
    const value = fingerprint(assistant);
    expect(value.algorithm).toBe("sha256");
    expect(value.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(value.contentBlockCount).toBe(1);
    expect(JSON.stringify(value)).not.toContain("provider secret output");
    expect(isPiAssistantFingerprintEqual(assistant, value)).toBe(true);
    expect(
      isPiAssistantFingerprintEqual(
        { ...assistant, id: "different-failed-1" },
        value,
      ),
    ).toBe(false);
  });

  it("fails closed for accessors, proxies, unsupported values, and bounds", () => {
    const accessor = { ...assistant } as Record<string, unknown>;
    Object.defineProperty(accessor, "usage", {
      enumerable: true,
      get: () => {
        throw new Error("must not run");
      },
    });
    expect(() => fingerprintPiAssistantMessage(accessor)).not.toThrow();
    expect(fingerprintPiAssistantMessage(accessor).isErr()).toBe(true);

    const proxy = new Proxy(assistant, {
      ownKeys: () => {
        throw new Error("hostile proxy");
      },
    });
    expect(() => fingerprintPiAssistantMessage(proxy)).not.toThrow();
    expect(fingerprintPiAssistantMessage(proxy).isErr()).toBe(true);

    expect(
      fingerprintPiAssistantMessage({
        ...assistant,
        unsupported: undefined,
      }).isErr(),
    ).toBe(true);
    expect(
      fingerprintPiAssistantMessage({
        ...assistant,
        content: Array.from(
          { length: MAX_PI_ASSISTANT_FINGERPRINT_CONTENT_BLOCKS + 1 },
          () => ({ type: "text", text: "x" }),
        ),
      }).isErr(),
    ).toBe(true);
    let deep: Record<string, unknown> = { value: "x" };
    for (
      let index = 0;
      index <= MAX_PI_ASSISTANT_FINGERPRINT_DEPTH;
      index += 1
    ) {
      deep = { nested: deep };
    }
    expect(fingerprintPiAssistantMessage({ ...assistant, deep }).isErr()).toBe(
      true,
    );
    expect(
      fingerprintPiAssistantMessage({
        ...assistant,
        properties: Object.fromEntries(
          Array.from(
            { length: MAX_PI_ASSISTANT_FINGERPRINT_PROPERTIES + 1 },
            (_, index) => [`p${index}`, index],
          ),
        ),
      }).isErr(),
    ).toBe(true);

    const nonCanonicalArray = ["x"] as unknown[] & Record<string, unknown>;
    Object.defineProperty(nonCanonicalArray, "01", {
      enumerable: true,
      value: "duplicate index",
    });
    expect(
      fingerprintPiAssistantMessage({
        ...assistant,
        content: nonCanonicalArray,
      }).isErr(),
    ).toBe(true);
  });
});

describe("Pi failover candidate cursor and eligibility", () => {
  const models: PiModelInfo[] = [
    { provider: "origin", id: "a", name: "A", contextWindow: 8 },
    { provider: "current", id: "b", name: "B", contextWindow: 16 },
    { provider: "next", id: "c", name: "C", contextWindow: 32 },
  ];

  it("keeps canonical distinct order and starts after the failed current model", () => {
    const duplicate = { ...models[1], name: "alias" };
    const cursor = createPiCandidateCursor(
      [models[0], models[1], duplicate, models[2]],
      models[1],
    );
    expect(cursor.cap).toBe(3);
    expect(cursor.position).toBe(2);
    expect(cursor.next()).toBe(models[2]);
    expect(cursor.next()).toBeUndefined();
    expect(cursor.position).toBe(3);
    expect(cursor.advanced).toBe(1);
  });

  it("uses the origin when the failed model is absent, never wraps, and exhausts boundedly", () => {
    const cursor = createPiCandidateCursor(models, "missing/model");
    expect([
      cursor.next(),
      cursor.next(),
      cursor.next(),
      cursor.next(),
    ]).toEqual([models[0], models[1], models[2], undefined]);
    expect(cursor.next()).toBeUndefined();
    expect(cursor.advanced).toBe(3);
    expect(cursor.cap).toBe(3);
    expect(cursor.exhausted).toBe(true);

    const many = Array.from(
      { length: MAX_PI_FAILOVER_CANDIDATES + 5 },
      (_, index) => ({
        provider: "p",
        id: String(index),
      }),
    );
    expect(createPiCandidateCursor(many, undefined).cap).toBe(
      MAX_PI_FAILOVER_CANDIDATES,
    );
  });

  it("requires a strictly larger context window only for overflow", () => {
    expect(
      isPiCandidateContextEligible(
        models[2],
        models[1],
        "context_overflow_unrecovered",
      ),
    ).toBe(true);
    expect(
      isPiCandidateContextEligible(
        { ...models[1], contextWindow: 16 },
        models[1],
        "context_overflow_unrecovered",
      ),
    ).toBe(false);
    expect(
      isPiCandidateContextEligible(
        { ...models[0], contextWindow: 8 },
        models[1],
        "context_overflow_unrecovered",
      ),
    ).toBe(false);
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
        candidate.model.provider === "origin"
          ? okAsync({ status: "eligible" })
          : errAsync({ type: "ProviderCredentialsUnavailable" }),
    };
    const eligible = await port.preflight({
      resolved: true,
      model: models[0],
      intentEntry: "origin/a",
      source: "canonical",
    });
    const skipped = await port.preflight({
      resolved: true,
      model: models[1],
      intentEntry: "current/b",
      source: "canonical",
    });
    expect(eligible._unsafeUnwrap()).toEqual({ status: "eligible" });
    expect(skipped._unsafeUnwrapErr()).toEqual({
      type: "ProviderCredentialsUnavailable",
    });

    const failureClass: PiFailoverFailureClass = "timeout";
    expect(isPiFailureAdvanceEligible(failureClass)).toBe(true);
  });
});
