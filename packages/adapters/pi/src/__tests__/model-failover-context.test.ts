import { describe, expect, it } from "bun:test";
import {
  MAX_PI_FAILOVER_CONTEXT_MESSAGES,
  type PiFailoverContextRepairInput,
  repairPiFailoverContext,
} from "../model-failover-context.js";
import {
  createPiModelFailoverMarker,
  fingerprintPiAssistantMessage,
  type PiAssistantFingerprint,
} from "../model-failover-contract.js";

const token = "550e8400-e29b-41d4-a716-446655440000";

const failedAssistant = {
  role: "assistant",
  id: "failed-assistant-1",
  stopReason: "error",
  content: [{ type: "text", text: "partial failed output" }],
};

function retainedFingerprint(): PiAssistantFingerprint {
  const result = fingerprintPiAssistantMessage(failedAssistant);
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

function marker() {
  return createPiModelFailoverMarker(token)._unsafeUnwrap();
}

function validInput(
  messages: readonly unknown[],
  overrides: Partial<PiFailoverContextRepairInput> = {},
): PiFailoverContextRepairInput {
  return {
    messages,
    token,
    fingerprint: retainedFingerprint(),
    ...overrides,
  };
}

describe("Pi failover provider-context repair", () => {
  it("removes only the exact assistant-marker pair and preserves every other entry", () => {
    const user = { role: "user", content: "task" };
    const tool = {
      role: "toolResult",
      toolCallId: "call-1",
      content: "result",
    };
    const unrelatedCustom = {
      role: "custom",
      customType: "other-extension",
      content: "keep me",
      display: false,
      details: { value: 1 },
    };
    const followUp = { role: "user", content: "follow up" };
    const messages = [
      user,
      tool,
      failedAssistant,
      marker(),
      unrelatedCustom,
      followUp,
    ];

    const result = repairPiFailoverContext(validInput(messages));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([
      user,
      tool,
      unrelatedCustom,
      followUp,
    ]);
    expect(result._unsafeUnwrap()[0]).toBe(user);
    expect(result._unsafeUnwrap()[1]).toBe(tool);
    expect(result._unsafeUnwrap()[2]).toBe(unrelatedCustom);
    expect(result._unsafeUnwrap()[3]).toBe(followUp);
    expect(messages).toHaveLength(6);
    expect(messages[2]).toBe(failedAssistant);
  });

  it("supports the positional and markerToken/failedAssistantFingerprint forms", () => {
    const positional = repairPiFailoverContext(
      [failedAssistant, marker()],
      token,
      retainedFingerprint(),
    );
    expect(positional.isOk()).toBe(true);
    expect(positional._unsafeUnwrap()).toEqual([]);

    const alternate = repairPiFailoverContext({
      messages: [failedAssistant, marker()],
      markerToken: token,
      failedAssistantFingerprint: retainedFingerprint(),
    });
    expect(alternate.isOk()).toBe(true);
    expect(alternate._unsafeUnwrap()).toEqual([]);
  });

  it.each([
    ["missing marker", [failedAssistant]],
    ["marker before assistant", [marker(), failedAssistant]],
    ["wrong role", [{ ...failedAssistant, role: "user" }, marker()]],
    [
      "wrong token",
      [
        failedAssistant,
        createPiModelFailoverMarker(
          "550e8400-e29b-41d4-a716-446655440001",
        )._unsafeUnwrap(),
      ],
    ],
    ["wrong type", [failedAssistant, { ...marker(), customType: "other" }]],
    [
      "loose text only",
      [failedAssistant, { role: "custom", content: PI_TEXT }],
    ],
  ] as const)("fails closed for %s", (_label, messages) => {
    const result = repairPiFailoverContext(validInput(messages));
    expect(result.isErr()).toBe(true);
  });

  it("fails closed for duplicate, malformed, and nonadjacent markers", () => {
    expect(
      repairPiFailoverContext(
        validInput([failedAssistant, marker(), marker()]),
      ).isErr(),
    ).toBe(true);
    expect(
      repairPiFailoverContext(
        validInput([
          failedAssistant,
          { ...marker(), details: { schemaVersion: 1, token, extra: "no" } },
        ]),
      ).isErr(),
    ).toBe(true);
    expect(
      repairPiFailoverContext(
        validInput([
          failedAssistant,
          { role: "user", content: "interposed" },
          marker(),
        ]),
      ).isErr(),
    ).toBe(true);
    expect(
      repairPiFailoverContext(
        validInput([
          { ...failedAssistant, id: "same-looking-but-distinct" },
          marker(),
        ]),
      ).isErr(),
    ).toBe(true);
  });

  it("requires the exact retained fingerprint, not loose text", () => {
    const changed = {
      ...failedAssistant,
      id: "different",
      content: failedAssistant.content,
    };
    const result = repairPiFailoverContext(validInput([changed, marker()]));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "FailedAssistantMismatch",
    });

    const extraFingerprint = {
      ...retainedFingerprint(),
      extra: "not part of the strict fingerprint",
    };
    expect(
      repairPiFailoverContext(
        validInput([failedAssistant, marker()], {
          fingerprint: extraFingerprint as PiAssistantFingerprint,
        }),
      )._unsafeUnwrapErr(),
    ).toEqual({ type: "RetainedFingerprintMalformed" });
  });

  it("rejects malformed/accessor-backed messages without throwing", () => {
    const accessor = { ...failedAssistant } as Record<string, unknown>;
    Object.defineProperty(accessor, "content", {
      enumerable: true,
      get: () => {
        throw new Error("must not run");
      },
    });
    expect(() =>
      repairPiFailoverContext(validInput([accessor, marker()])),
    ).not.toThrow();
    expect(
      repairPiFailoverContext(validInput([accessor, marker()])).isErr(),
    ).toBe(true);

    const hostile = new Proxy([failedAssistant, marker()], {
      getOwnPropertyDescriptor: () => {
        throw new Error("hostile list");
      },
    });
    expect(() => repairPiFailoverContext(validInput(hostile))).not.toThrow();
    expect(repairPiFailoverContext(validInput(hostile)).isErr()).toBe(true);
  });

  it("bounds context inspection", () => {
    const tooMany = Array.from(
      { length: MAX_PI_FAILOVER_CONTEXT_MESSAGES + 1 },
      () => ({
        role: "user",
        content: "keep",
      }),
    );
    expect(repairPiFailoverContext(validInput(tooMany)).isErr()).toBe(true);
  });
});

const PI_TEXT = "the fixed marker words are not correlation";
