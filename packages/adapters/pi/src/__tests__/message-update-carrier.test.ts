/**
 * The `message_update` secrecy boundary.
 *
 * One frame states one thing. The regression this replaces was structural: two
 * independent readers each answered "is this answer text?" and "is this
 * reasoning?" for themselves, and the text reader looked at the legacy
 * `delta.text` carrier BEFORE the authoritative `assistantMessageEvent`. A
 * frame carrying both was therefore published as an answer by the delegation
 * card, the tree preview, the overlay window, its replay steps, the transcript
 * and every snapshot built from them.
 */

import { describe, expect, it } from "bun:test";
import { MAX_CHILD_EVENT_STRING } from "../child-session-events.js";
import {
  classifyPiMessageUpdate,
  MAX_MESSAGE_UPDATE_ANSWER_LENGTH,
  messageUpdateAnswerText,
  messageUpdateObservesRawReasoning,
} from "../message-update-carrier.js";

const RAW_COT = "SECRET-CHAIN-OF-THOUGHT-42";

it("pins its answer bound to the child event parser's string bound", () => {
  // The constant is declared locally so the parser can redact through this
  // module without a cycle. This is what keeps the two from drifting.
  expect(MAX_MESSAGE_UPDATE_ANSWER_LENGTH).toBe(MAX_CHILD_EVENT_STRING);
});

describe("classifyPiMessageUpdate · answer frames", () => {
  it("reads the legacy delta.text carrier", () => {
    expect(
      classifyPiMessageUpdate({
        type: "message_update",
        delta: { text: "hello" },
      }),
    ).toEqual({ kind: "answer", text: "hello" });
  });

  it("reads the assistantMessageEvent text delta", () => {
    expect(
      classifyPiMessageUpdate({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hello" },
      }),
    ).toEqual({ kind: "answer", text: "hello" });
  });

  it("accepts two carriers that agree", () => {
    expect(
      classifyPiMessageUpdate({
        type: "message_update",
        delta: { text: "hello" },
        assistantMessageEvent: { type: "text_delta", delta: "hello" },
      }),
    ).toEqual({ kind: "answer", text: "hello" });
  });

  it("keeps an empty delta as an answer frame, not framing", () => {
    expect(
      classifyPiMessageUpdate({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "" },
      }),
    ).toEqual({ kind: "answer", text: "" });
  });
});

describe("classifyPiMessageUpdate · reasoning frames", () => {
  it("reports the content-free fact for every raw-thinking event type", () => {
    for (const type of ["thinking_start", "thinking_delta", "thinking_end"]) {
      const carrier = classifyPiMessageUpdate({
        type: "message_update",
        assistantMessageEvent: { type, delta: RAW_COT, content: RAW_COT },
      });
      expect(carrier).toEqual({ kind: "reasoning" });
      expect(JSON.stringify(carrier)).not.toContain(RAW_COT);
    }
  });

  it("reports the legacy delta.thinking carrier", () => {
    expect(
      classifyPiMessageUpdate({
        type: "message_update",
        delta: { thinking: RAW_COT },
      }),
    ).toEqual({ kind: "reasoning" });
  });

  it("treats a non-string thinking payload as reasoning all the same", () => {
    expect(
      classifyPiMessageUpdate({
        type: "message_update",
        delta: { thinking: { redacted: RAW_COT } },
      }),
    ).toEqual({ kind: "reasoning" });
  });
});

describe("classifyPiMessageUpdate · framing frames", () => {
  it("states nothing for text and toolcall framing", () => {
    for (const type of [
      "text_start",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
    ]) {
      expect(
        classifyPiMessageUpdate({
          type: "message_update",
          assistantMessageEvent: { type, content: "whatever" },
        }),
      ).toEqual({ kind: "framing" });
    }
  });

  it("states nothing for an update with no carrier at all", () => {
    expect(classifyPiMessageUpdate({ type: "message_update" })).toEqual({
      kind: "framing",
    });
  });

  it("states nothing when delta is not an object", () => {
    expect(
      classifyPiMessageUpdate({
        type: "message_update",
        delta: "not-an-object",
      }),
    ).toEqual({ kind: "framing" });
  });

  it("states nothing for a non-object frame", () => {
    expect(classifyPiMessageUpdate(undefined)).toEqual({ kind: "framing" });
    expect(classifyPiMessageUpdate("message_update")).toEqual({
      kind: "framing",
    });
    expect(classifyPiMessageUpdate([{ delta: { text: "hello" } }])).toEqual({
      kind: "framing",
    });
  });
});

describe("classifyPiMessageUpdate · mixed carriers are rejected", () => {
  it("rejects a thinking_delta carrying a legacy delta.text beside it", () => {
    const carrier = classifyPiMessageUpdate({
      type: "message_update",
      delta: { text: RAW_COT },
      assistantMessageEvent: { type: "thinking_delta", delta: RAW_COT },
    });
    expect(carrier).toEqual({ kind: "rejected", reason: "mixed-carriers" });
    expect(messageUpdateAnswerText).toBeDefined();
  });

  it("publishes neither text nor a reasoning claim for a mixed frame", () => {
    const frame = {
      type: "message_update",
      delta: { text: "looks like an answer", thinking: RAW_COT },
    };
    expect(messageUpdateAnswerText(frame)).toBeUndefined();
    expect(messageUpdateObservesRawReasoning(frame)).toBe(false);
  });

  it("rejects a text_delta beside a legacy thinking carrier", () => {
    expect(
      classifyPiMessageUpdate({
        type: "message_update",
        delta: { thinking: RAW_COT },
        assistantMessageEvent: { type: "text_delta", delta: "hello" },
      }),
    ).toEqual({ kind: "rejected", reason: "mixed-carriers" });
  });

  it("rejects a mixed frame even when the answer carrier is malformed", () => {
    expect(
      classifyPiMessageUpdate({
        type: "message_update",
        delta: { text: 42, thinking: RAW_COT },
      }),
    ).toEqual({ kind: "rejected", reason: "mixed-carriers" });
  });

  it("rejects two answer carriers that disagree", () => {
    expect(
      classifyPiMessageUpdate({
        type: "message_update",
        delta: { text: "one" },
        assistantMessageEvent: { type: "text_delta", delta: "another" },
      }),
    ).toEqual({ kind: "rejected", reason: "conflicting-answers" });
  });

  it("rejects a declared answer carrier that states no string", () => {
    expect(
      classifyPiMessageUpdate({
        type: "message_update",
        delta: { text: 42 },
      }),
    ).toEqual({ kind: "rejected", reason: "malformed-answer" });
    expect(
      classifyPiMessageUpdate({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta" },
      }),
    ).toEqual({ kind: "rejected", reason: "malformed-answer" });
  });

  it("rejects an answer carrier beyond the event string bound", () => {
    expect(
      classifyPiMessageUpdate({
        type: "message_update",
        delta: { text: "x".repeat(MAX_MESSAGE_UPDATE_ANSWER_LENGTH + 1) },
      }),
    ).toEqual({ kind: "rejected", reason: "oversized-answer" });
  });
});

describe("classifyPiMessageUpdate · hostile shapes", () => {
  it("never invokes an accessor to find answer text", () => {
    let invoked = 0;
    const frame = {
      type: "message_update",
      get delta() {
        invoked += 1;
        return { text: RAW_COT };
      },
    };
    expect(classifyPiMessageUpdate(frame)).toEqual({ kind: "framing" });
    expect(invoked).toBe(0);
  });

  it("never invokes a nested accessor either", () => {
    let invoked = 0;
    const delta = {
      get text() {
        invoked += 1;
        return RAW_COT;
      },
    };
    expect(classifyPiMessageUpdate({ type: "message_update", delta })).toEqual({
      kind: "framing",
    });
    expect(invoked).toBe(0);
  });

  it("ignores an inherited carrier: only the frame's own statement counts", () => {
    const frame = Object.create({ delta: { text: RAW_COT } }) as object;
    Object.defineProperty(frame, "type", {
      value: "message_update",
      enumerable: true,
    });
    expect(classifyPiMessageUpdate(frame)).toEqual({ kind: "framing" });
  });

  it("ignores a non-enumerable carrier", () => {
    const frame: Record<string, unknown> = { type: "message_update" };
    Object.defineProperty(frame, "delta", {
      value: { text: RAW_COT },
      enumerable: false,
    });
    expect(classifyPiMessageUpdate(frame)).toEqual({ kind: "framing" });
  });

  it("rejects a frame whose reflection throws instead of propagating", () => {
    const hostile = new Proxy(
      { type: "message_update", delta: { text: "hello" } },
      {
        getOwnPropertyDescriptor() {
          throw new Error("hostile trap");
        },
      },
    );
    expect(classifyPiMessageUpdate(hostile)).toEqual({
      kind: "rejected",
      reason: "unreadable",
    });
    expect(messageUpdateAnswerText(hostile)).toBeUndefined();
    expect(messageUpdateObservesRawReasoning(hostile)).toBe(false);
  });

  it("rejects a revoked proxy rather than throwing", () => {
    const revocable = Proxy.revocable({ type: "message_update" }, {});
    revocable.revoke();
    expect(classifyPiMessageUpdate(revocable.proxy)).toEqual({
      kind: "rejected",
      reason: "unreadable",
    });
  });

  it("rejects a nested carrier whose reflection throws", () => {
    const delta = new Proxy(
      { text: "hello" },
      {
        getOwnPropertyDescriptor() {
          throw new Error("hostile trap");
        },
      },
    );
    expect(classifyPiMessageUpdate({ type: "message_update", delta })).toEqual({
      kind: "rejected",
      reason: "unreadable",
    });
  });

  it("does not treat a prototype-polluted carrier as the frame's own", () => {
    const frame = JSON.parse(
      '{"type":"message_update","__proto__":{"delta":{"text":"injected"}}}',
    ) as object;
    expect(classifyPiMessageUpdate(frame)).toEqual({ kind: "framing" });
  });
});
