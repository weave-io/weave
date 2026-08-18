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
import {
  canonicalReasoningMessageUpdate,
  MAX_CHILD_EVENT_STRING,
  parsePiChildSessionEvent,
  redactRawReasoningFromEvent,
  retainedChildSessionEvent,
} from "../child-session-events.js";
import {
  classifyPiMessageUpdate,
  MAX_MESSAGE_UPDATE_ANSWER_LENGTH,
  messageUpdateAnswerText,
  messageUpdateObservesRawReasoning,
  RAW_REASONING_PROSE_KEYS,
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

// ---------------------------------------------------------------------------
// Hidden carriers: the declared type is not the whole statement
// ---------------------------------------------------------------------------

/** Nothing this boundary refused may survive into anything retained. */
function expectRetainsNoProse(frame: unknown): void {
  const parsed = parsePiChildSessionEvent(frame);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  const retained = JSON.stringify(redactRawReasoningFromEvent(parsed.data));
  expect(retained.includes(RAW_COT)).toBe(false);
}

/**
 * What the RETENTION boundary keeps for a frame, which is the rule that holds
 * for a member no carrier declared.
 *
 * Redaction blanks the fields a carrier declared, so it has nothing to say
 * about a thought parked under an undeclared member. Retention does: a
 * rejected frame is kept nowhere, and a reasoning frame is kept as the
 * adapter's own content-free fact.
 */
function retainedFrom(frame: unknown): unknown {
  const parsed = parsePiChildSessionEvent(frame);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return undefined;
  const retained = retainedChildSessionEvent(parsed.data);
  expect(JSON.stringify(retained ?? null).includes(RAW_COT)).toBe(false);
  return retained;
}

describe("classifyPiMessageUpdate · hidden reasoning carriers", () => {
  it("pins the prose keys the redaction boundary must blank", () => {
    expect([...RAW_REASONING_PROSE_KEYS]).toEqual(["thinking", "reasoning"]);
  });

  it("rejects a text_delta that carries a reasoning key beside its answer", () => {
    const frame = {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "hello",
        thinking: RAW_COT,
      },
    };
    expect(classifyPiMessageUpdate(frame)).toEqual({
      kind: "rejected",
      reason: "mixed-carriers",
    });
    expect(messageUpdateAnswerText(frame)).toBeUndefined();
    expect(messageUpdateObservesRawReasoning(frame)).toBe(false);
    expectRetainsNoProse(frame);
  });

  it("rejects a text_delta whose content holds a nested thinking block", () => {
    const frame = {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "hello",
        content: [
          { type: "text", text: "hello" },
          { type: "thinking", text: RAW_COT },
        ],
      },
    };
    expect(classifyPiMessageUpdate(frame)).toEqual({
      kind: "rejected",
      reason: "mixed-carriers",
    });
    expectRetainsNoProse(frame);
  });

  it("reads an answer-typed event carrying a reasoning key as reasoning", () => {
    // `answer` is not one of this module's answer carriers, so the frame
    // declares reasoning ALONE - the content-free fact, never the prose.
    const frame = {
      type: "message_update",
      assistantMessageEvent: { type: "answer", reasoning: RAW_COT },
    };
    expect(classifyPiMessageUpdate(frame)).toEqual({ kind: "reasoning" });
    expect(messageUpdateAnswerText(frame)).toBeUndefined();
    expectRetainsNoProse(frame);
  });

  it("reads an answer-typed event with a nested thinking block as reasoning", () => {
    const frame = {
      type: "message_update",
      assistantMessageEvent: {
        type: "answer",
        content: [{ type: "thinking", thinking: RAW_COT }],
      },
    };
    expect(classifyPiMessageUpdate(frame)).toEqual({ kind: "reasoning" });
    expectRetainsNoProse(frame);
  });

  it("rejects a legacy delta that hides reasoning beside its text", () => {
    const frame = {
      type: "message_update",
      delta: { text: "hello", reasoning: RAW_COT },
    };
    expect(classifyPiMessageUpdate(frame)).toEqual({
      kind: "rejected",
      reason: "mixed-carriers",
    });
    expectRetainsNoProse(frame);
  });

  it("rejects a frame that states reasoning prose beside an answer carrier", () => {
    const frame = {
      type: "message_update",
      thinking: RAW_COT,
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
    };
    expect(classifyPiMessageUpdate(frame)).toEqual({
      kind: "rejected",
      reason: "mixed-carriers",
    });
    expectRetainsNoProse(frame);
  });

  it("reads a frame-level thinking content block as reasoning", () => {
    const frame = {
      type: "message_update",
      content: [{ type: "thinking", text: RAW_COT }],
    };
    expect(classifyPiMessageUpdate(frame)).toEqual({ kind: "reasoning" });
    expectRetainsNoProse(frame);
  });

  it("finds prose a carrier buried several levels down", () => {
    const frame = {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "hello",
        meta: { trace: { thinking: [{ text: RAW_COT }] } },
      },
    };
    expect(classifyPiMessageUpdate(frame)).toEqual({
      kind: "rejected",
      reason: "mixed-carriers",
    });
  });

  it("finds a thought under a top-level member no carrier declares", () => {
    // The frame's own `metadata` is not a carrier this module knows, and
    // scanning only the carriers plus a couple of frame keys published this
    // exact frame as a clean answer with the thought still attached.
    const frame = {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "hello",
      },
      metadata: { trace: { content: [{ type: "thinking", text: RAW_COT }] } },
    };
    expect(classifyPiMessageUpdate(frame)).toEqual({
      kind: "rejected",
      reason: "mixed-carriers",
    });
    expect(messageUpdateAnswerText(frame)).toBeUndefined();
    expect(messageUpdateObservesRawReasoning(frame)).toBe(false);
    // A rejected frame is retained nowhere, prose and answer alike.
    expect(retainedFrom(frame)).toBeUndefined();
  });

  it("finds a prose key under a top-level member no carrier declares", () => {
    const frame = {
      type: "message_update",
      delta: { text: "hello" },
      provenance: { trace: { reasoning: RAW_COT } },
    };
    expect(classifyPiMessageUpdate(frame)).toEqual({
      kind: "rejected",
      reason: "mixed-carriers",
    });
    expect(retainedFrom(frame)).toBeUndefined();
  });

  it("reads a FRAMING frame with a hidden top-level thought as reasoning", () => {
    // Framing declares no answer, so the frame states the reasoning fact
    // alone - content-free, and never retained as the host's own object.
    const frame = {
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
      metadata: { trace: { content: [{ type: "reasoning", text: RAW_COT }] } },
    };
    expect(classifyPiMessageUpdate(frame)).toEqual({ kind: "reasoning" });
    expect(messageUpdateAnswerText(frame)).toBeUndefined();
    // Kept as the adapter's own fact, so the host's member is gone with it.
    expect(retainedFrom(frame)).toEqual(canonicalReasoningMessageUpdate());
  });

  it("leaves a benign top-level metadata frame an answer", () => {
    // Ordinary nested bookkeeping states no prose under a reasoning key and
    // declares no thinking block, so the wider scan finds nothing.
    expect(
      classifyPiMessageUpdate({
        type: "message_update",
        metadata: {
          trace: {
            requestId: "req-7",
            note: "retry after transport reset",
            tokens: { reasoning: 7, cached: 0 },
            content: [{ type: "text", text: "hello" }],
          },
        },
        assistantMessageEvent: { type: "text_delta", delta: "hello" },
      }),
    ).toEqual({ kind: "answer", text: "hello" });
  });

  it("keeps a numeric reasoning counter nested anywhere out of it", () => {
    // The count is the only `reasoning` member an ordinary answer carries, and
    // it is a NUMBER wherever the host parks it.
    expect(
      classifyPiMessageUpdate({
        type: "message_update",
        usage: { input: 2, output: 22, reasoning: 11 },
        metadata: { usage: { reasoning: 11, detail: { reasoning: 0 } } },
        assistantMessageEvent: { type: "text_delta", delta: "hello" },
      }),
    ).toEqual({ kind: "answer", text: "hello" });
  });

  it("keeps an ordinary answer frame an answer, usage counts included", () => {
    // `usage.reasoning` is a TOKEN COUNT, not chain-of-thought, and a
    // reasoning key with no prose under it declares nothing.
    expect(
      classifyPiMessageUpdate({
        type: "message_update",
        usage: { input: 2, output: 22, reasoning: 11 },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 1,
          delta: "hello",
          thinking: "",
          content: [{ type: "text", text: "hello" }],
        },
      }),
    ).toEqual({ kind: "answer", text: "hello" });
  });
});

describe("classifyPiMessageUpdate · hidden carriers, hostile shapes", () => {
  it("never invokes an accessor that would state hidden reasoning", () => {
    let invoked = 0;
    const event = { type: "text_delta", delta: "hello" };
    Object.defineProperty(event, "thinking", {
      enumerable: true,
      get() {
        invoked += 1;
        return RAW_COT;
      },
    });
    // An accessor states nothing: it would run the payload's own code. The
    // frame is the answer it declared, and the parser drops the accessor, so
    // nothing retains the prose either.
    const frame = { type: "message_update", assistantMessageEvent: event };
    expect(classifyPiMessageUpdate(frame)).toEqual({
      kind: "answer",
      text: "hello",
    });
    expect(invoked).toBe(0);
    expectRetainsNoProse(frame);
  });

  it("ignores a non-enumerable hidden carrier", () => {
    const event: Record<string, unknown> = {
      type: "text_delta",
      delta: "hello",
    };
    Object.defineProperty(event, "thinking", {
      value: RAW_COT,
      enumerable: false,
    });
    expect(
      classifyPiMessageUpdate({
        type: "message_update",
        assistantMessageEvent: event,
      }),
    ).toEqual({ kind: "answer", text: "hello" });
  });

  it("ignores an inherited hidden carrier", () => {
    const event = Object.create({ thinking: RAW_COT }) as Record<
      string,
      unknown
    >;
    Object.defineProperties(event, {
      type: { value: "text_delta", enumerable: true },
      delta: { value: "hello", enumerable: true },
    });
    expect(
      classifyPiMessageUpdate({
        type: "message_update",
        assistantMessageEvent: event,
      }),
    ).toEqual({ kind: "answer", text: "hello" });
  });

  it("rejects a prototype-polluted carrier that still holds the prose", () => {
    // `JSON.parse` puts `__proto__` on the carrier as own DATA, so the prose
    // is genuinely there under a reasoning key. The frame is ambiguous and
    // moves nothing; the parser then drops the key before anything retains it.
    const frame = JSON.parse(
      `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hello","__proto__":{"thinking":"${RAW_COT}"}}}`,
    ) as object;
    expect(classifyPiMessageUpdate(frame)).toEqual({
      kind: "rejected",
      reason: "mixed-carriers",
    });
    expectRetainsNoProse(frame);
  });

  it("rejects a nested proxy whose key enumeration throws", () => {
    const hostile = new Proxy(
      { type: "text_delta", delta: "hello" },
      {
        ownKeys() {
          throw new Error("hostile ownKeys trap");
        },
      },
    );
    expect(
      classifyPiMessageUpdate({
        type: "message_update",
        assistantMessageEvent: hostile,
      }),
    ).toEqual({ kind: "rejected", reason: "unreadable" });
  });

  it("rejects a carrier whose deep member's reflection throws", () => {
    const hostile = new Proxy(
      { thinking: RAW_COT },
      {
        getOwnPropertyDescriptor() {
          throw new Error("hostile descriptor trap");
        },
      },
    );
    expect(
      classifyPiMessageUpdate({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: "hello",
          meta: hostile,
        },
      }),
    ).toEqual({ kind: "rejected", reason: "unreadable" });
  });

  it("rejects a carrier nested deeper than the scan describes", () => {
    let nested: Record<string, unknown> = { thinking: RAW_COT };
    for (let depth = 0; depth < 24; depth += 1) nested = { nested };
    expect(
      classifyPiMessageUpdate({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: "hello",
          ...nested,
        },
      }),
    ).toEqual({ kind: "rejected", reason: "unreadable" });
  });

  it("rejects a carrier with more members than one scan may read", () => {
    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 700; index += 1) wide[`k${index}`] = { index };
    expect(
      classifyPiMessageUpdate({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: "hello",
          wide,
        },
      }),
    ).toEqual({ kind: "rejected", reason: "unreadable" });
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
