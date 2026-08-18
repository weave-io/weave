/**
 * Raw chain-of-thought must not survive in ANY retained state.
 *
 * Pi 0.84 splits one reasoning block across three frames and does not put the
 * prose in one field:
 *
 *   message_update(assistantMessageEvent: { type: "thinking_start" })
 *   message_update(assistantMessageEvent: { type: "thinking_delta", delta })
 *   message_update(assistantMessageEvent: { type: "thinking_end", content })
 *
 * The redaction boundary previously blanked `thinking_delta.delta` alone, so
 * the COMPLETED thought - `thinking_end.content`, which may be a string or an
 * array of content blocks - stayed in the transcript's bounded history, in the
 * overlay's retained replay steps, and in everything serialized, searched, or
 * rebuilt from them.
 *
 * Every case below drives one of the three real retention paths:
 *
 *   1. `reducePiChildTranscript` - the transcript reducer's history append;
 *   2. `projectLiveEntry`        - the live overlay projection's replay step;
 *   3. `pushReplayEvent`         - the rebuilt/historical replay-step builder.
 *
 * The assertion is always the same: the sentinel appears nowhere in the
 * serialized retained state. The event's SHAPE survives, so a reader still
 * learns that the child reasoned.
 */
import { describe, expect, it } from "bun:test";
import {
  projectLiveEntry,
  pushReplayEvent,
  transcriptFromOverlayEntries,
} from "../child-overlay-replay.js";
import type { ChildOverlayReplayStep } from "../child-overlay-types.js";
import {
  type PiChildSessionEvent,
  parsePiChildSessionEvent,
  redactRawReasoningFromEvent,
} from "../child-session-events.js";
import {
  createPiChildTranscriptState,
  reducePiChildTranscript,
} from "../child-transcript.js";

/**
 * One sentinel per carrier, so a failure names the exact field that leaked
 * rather than only proving that something did.
 */
const COT = {
  start: "SENTINEL-THINKING-START-PROSE",
  delta: "SENTINEL-THINKING-DELTA-PROSE",
  end: "SENTINEL-THINKING-END-PROSE",
  block: "SENTINEL-THINKING-BLOCK-PROSE",
  partial: "SENTINEL-THINKING-PARTIAL-PROSE",
  legacy: "SENTINEL-LEGACY-DELTA-PROSE",
  message: "SENTINEL-MESSAGE-REASONING-PROSE",
  frame: "SENTINEL-FRAME-PROSE",
  hiddenKey: "SENTINEL-HIDDEN-KEY-PROSE",
  hiddenBlock: "SENTINEL-HIDDEN-BLOCK-PROSE",
  hiddenLegacy: "SENTINEL-HIDDEN-LEGACY-PROSE",
  hiddenFrame: "SENTINEL-HIDDEN-FRAME-PROSE",
} as const;

const ALL_SENTINELS = Object.values(COT);

/** The visible answer, which must NOT be redacted by any of this. */
const ANSWER = "The reporter drops rows when the window trims.";

function parsed(raw: unknown): PiChildSessionEvent {
  const result = parsePiChildSessionEvent(raw);
  expect(result.success).toBe(true);
  if (!result.success) throw new Error("unparseable fixture");
  return result.data;
}

/** Every carrier a real `thinking_*` lifecycle can put prose in, at once. */
function hostileThinkingLifecycle(): readonly Record<string, unknown>[] {
  return [
    { type: "message_start", message: { role: "assistant", content: [] } },
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_start",
        contentIndex: 0,
        content: COT.start,
      },
    },
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: COT.delta,
        partial: COT.partial,
      },
    },
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 0,
        content: [
          { type: "thinking", text: COT.block },
          { type: "reasoning", reasoning: COT.block },
        ],
        text: COT.end,
      },
      partial: COT.frame,
    },
    { type: "message_update", delta: { thinking: COT.legacy } },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 1 },
    },
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: ANSWER,
      },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        reasoning: COT.message,
        content: [
          { type: "thinking", text: COT.block },
          { type: "text", text: ANSWER },
        ],
      },
    },
  ];
}

/**
 * The same disclosure, hidden UNDER an answer-shaped carrier.
 *
 * Every frame here declares `text_delta` or `answer` - the two types a reader
 * treats as "this is the child's visible reply" - while burying the thought in
 * a `thinking` / `reasoning` member or in a nested thinking content block. A
 * classifier that trusts the declared type published these as pure answers and
 * retained the prose in full.
 */
function hiddenCarrierLifecycle(): readonly Record<string, unknown>[] {
  return [
    { type: "message_start", message: { role: "assistant", content: [] } },
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: ANSWER,
        thinking: COT.hiddenKey,
      },
    },
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "answer",
        contentIndex: 0,
        content: [
          { type: "thinking", text: COT.hiddenBlock },
          { type: "reasoning", reasoning: COT.hiddenBlock },
        ],
      },
    },
    {
      type: "message_update",
      delta: { text: ANSWER, reasoning: COT.hiddenLegacy },
    },
    {
      type: "message_update",
      thinking: COT.hiddenFrame,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: ANSWER,
      },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", text: COT.hiddenBlock },
          { type: "text", text: ANSWER },
        ],
      },
    },
  ];
}

function expectNoSentinel(serialized: string): void {
  for (const sentinel of ALL_SENTINELS) {
    expect({ sentinel, present: serialized.includes(sentinel) }).toEqual({
      sentinel,
      present: false,
    });
  }
}

// ---------------------------------------------------------------------------
// 1. The redaction boundary itself
// ---------------------------------------------------------------------------

describe("redactRawReasoningFromEvent · every reasoning carrier", () => {
  it("blanks thinking_start, thinking_delta and thinking_end prose", () => {
    for (const raw of hostileThinkingLifecycle()) {
      const redacted = redactRawReasoningFromEvent(parsed(raw));
      expectNoSentinel(JSON.stringify(redacted));
    }
  });

  it("keeps an explicit thinking_start content sentinel out of the event", () => {
    const redacted = redactRawReasoningFromEvent(
      parsed({
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_start",
          contentIndex: 0,
          content: COT.start,
        },
      }),
    );
    expect(redacted).toEqual({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_start",
        contentIndex: 0,
        content: "",
      },
    } as unknown as PiChildSessionEvent);
  });

  it("keeps an explicit thinking_end content sentinel out of the event", () => {
    const redacted = redactRawReasoningFromEvent(
      parsed({
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_end",
          contentIndex: 0,
          content: COT.end,
        },
      }),
    );
    expect(redacted).toEqual({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 0,
        content: "",
      },
    } as unknown as PiChildSessionEvent);
  });

  it("preserves the shape and the block kinds it redacts", () => {
    // The reader must still learn THAT the child reasoned, and in what shape.
    const redacted = redactRawReasoningFromEvent(
      parsed({
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_end",
          contentIndex: 3,
          content: [{ type: "thinking", text: COT.block }],
        },
      }),
    );
    expect(redacted).toEqual({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 3,
        content: [{ type: "thinking", text: "" }],
      },
    } as unknown as PiChildSessionEvent);
  });

  it("blanks every carrier of a MIXED frame, answer text included", () => {
    // No reader can tell which carrier held the chain-of-thought, so neither
    // carrier may be published.
    const redacted = redactRawReasoningFromEvent(
      parsed({
        type: "message_update",
        delta: { text: ANSWER, thinking: COT.legacy },
        assistantMessageEvent: {
          type: "thinking_delta",
          delta: COT.delta,
          content: COT.end,
        },
      }),
    );
    const serialized = JSON.stringify(redacted);
    expectNoSentinel(serialized);
    expect(serialized).not.toContain(ANSWER);
  });

  it("blanks the legacy delta's other carriers beside `thinking`", () => {
    const redacted = redactRawReasoningFromEvent(
      parsed({
        type: "message_update",
        delta: {
          thinking: COT.legacy,
          content: [{ type: "thinking", text: COT.block }],
          partial: COT.partial,
        },
      }),
    );
    expectNoSentinel(JSON.stringify(redacted));
  });

  it("blanks a hidden reasoning carrier a text_delta declared as an answer", () => {
    const redacted = redactRawReasoningFromEvent(
      parsed({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: ANSWER,
          thinking: COT.hiddenKey,
        },
      }),
    );
    const serialized = JSON.stringify(redacted);
    expectNoSentinel(serialized);
    // Mixed carriers: the answer beside the hidden thought is emptied too,
    // because no reader can tell which carrier held the chain-of-thought.
    expect(serialized).not.toContain(ANSWER);
  });

  it("blanks a nested thinking block an answer-typed carrier hid", () => {
    const redacted = redactRawReasoningFromEvent(
      parsed({
        type: "message_update",
        assistantMessageEvent: {
          type: "answer",
          contentIndex: 0,
          content: [{ type: "thinking", text: COT.hiddenBlock }],
        },
      }),
    );
    expect(redacted).toEqual({
      type: "message_update",
      assistantMessageEvent: {
        type: "answer",
        contentIndex: 0,
        content: [{ type: "thinking", text: "" }],
      },
    } as unknown as PiChildSessionEvent);
  });

  it("blanks reasoning prose the FRAME states beside an answer carrier", () => {
    const redacted = redactRawReasoningFromEvent(
      parsed({
        type: "message_update",
        thinking: COT.hiddenFrame,
        assistantMessageEvent: { type: "text_delta", delta: ANSWER },
      }),
    );
    expectNoSentinel(JSON.stringify(redacted));
  });

  it("leaves an unambiguous answer frame exactly as it was", () => {
    const answerFrame = parsed({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: ANSWER,
      },
    });
    expect(redactRawReasoningFromEvent(answerFrame)).toBe(answerFrame);
  });

  it("leaves the host's own reasoning SUMMARY untouched", () => {
    // `reasoning_summary` is the one trusted reasoning surface: the host chose
    // to produce it for the reader, and nothing derives it from raw prose.
    const summary = parsed({
      type: "reasoning_summary",
      text: "Checked the reporter's window trimming.",
    });
    expect(redactRawReasoningFromEvent(summary)).toBe(summary);
  });

  it("leaves framing frames identical rather than rewriting them", () => {
    for (const raw of [
      { type: "message_update", assistantMessageEvent: { type: "text_start" } },
      { type: "message_update", assistantMessageEvent: { type: "text_end" } },
      {
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_start" },
      },
      { type: "message_update" },
    ]) {
      const event = parsed(raw);
      expect(redactRawReasoningFromEvent(event)).toBe(event);
    }
  });

  it("never throws on a hostile carrier, and never invokes its accessors", () => {
    let invoked = 0;
    const hostile = {
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        get delta() {
          invoked += 1;
          return COT.delta;
        },
      },
    };
    // The parser drops the accessor before redaction ever sees it, so the
    // getter is not run and the retained event carries no prose either way.
    const redacted = redactRawReasoningFromEvent(parsed(hostile));
    expect(invoked).toBe(0);
    expectNoSentinel(JSON.stringify(redacted));

    const revocable = Proxy.revocable(
      { type: "thinking_delta", delta: COT.delta },
      {},
    );
    revocable.revoke();
    const withRevoked = parsePiChildSessionEvent({
      type: "message_update",
      assistantMessageEvent: revocable.proxy,
    });
    if (withRevoked.success) {
      expectNoSentinel(
        JSON.stringify(redactRawReasoningFromEvent(withRevoked.data)),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The three retention paths
// ---------------------------------------------------------------------------

describe("retained history carries no raw chain-of-thought", () => {
  it("keeps the transcript reducer's bounded history clean", () => {
    let state = createPiChildTranscriptState();
    hostileThinkingLifecycle().forEach((raw, index) => {
      const next = reducePiChildTranscript(state, {
        kind: "event",
        event: parsed(raw),
      });
      expect({ index, ok: next.isOk() }).toEqual({ index, ok: true });
      if (next.isOk()) state = next.value;
    });

    const serialized = JSON.stringify(state);
    expectNoSentinel(serialized);
    // The answer the child actually produced is still there.
    expect(serialized).toContain("The reporter drops rows");
    // And the transcript still records that the child reasoned.
    expect(
      state.entries.some(
        (entry) => entry.kind === "assistant" && entry.reasoningObserved,
      ),
    ).toBe(true);
  });

  it("keeps the live overlay projection's replay steps clean", () => {
    const serialized = hostileThinkingLifecycle()
      .map((raw, index) => projectLiveEntry(parsed(raw), index, false))
      .filter((entry) => entry !== undefined)
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    expectNoSentinel(serialized);
  });

  it("keeps the rebuilt replay-step builder clean, and its rebuild too", () => {
    const steps: ChildOverlayReplayStep[] = [];
    for (const raw of hostileThinkingLifecycle()) {
      expect(pushReplayEvent(steps, raw).isOk()).toBe(true);
    }
    expectNoSentinel(JSON.stringify(steps));

    // Everything a search, a page merge, or a snapshot would read back.
    const entries = hostileThinkingLifecycle()
      .map((raw, index) => projectLiveEntry(parsed(raw), index, false))
      .filter((entry) => entry !== undefined);
    expectNoSentinel(JSON.stringify(transcriptFromOverlayEntries(entries)));
  });
});

// ---------------------------------------------------------------------------
// 3. The same three paths, for carriers that call themselves answers
// ---------------------------------------------------------------------------

describe("retained history carries no HIDDEN chain-of-thought", () => {
  it("keeps the transcript reducer's bounded history clean", () => {
    let state = createPiChildTranscriptState();
    hiddenCarrierLifecycle().forEach((raw, index) => {
      const next = reducePiChildTranscript(state, {
        kind: "event",
        event: parsed(raw),
      });
      expect({ index, ok: next.isOk() }).toEqual({ index, ok: true });
      if (next.isOk()) state = next.value;
    });
    expectNoSentinel(JSON.stringify(state));
  });

  it("keeps the live overlay projection's replay steps clean", () => {
    const serialized = hiddenCarrierLifecycle()
      .map((raw, index) => projectLiveEntry(parsed(raw), index, false))
      .filter((entry) => entry !== undefined)
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    expectNoSentinel(serialized);
  });

  it("keeps the rebuilt replay-step builder clean, and its rebuild too", () => {
    const steps: ChildOverlayReplayStep[] = [];
    for (const raw of hiddenCarrierLifecycle()) {
      expect(pushReplayEvent(steps, raw).isOk()).toBe(true);
    }
    expectNoSentinel(JSON.stringify(steps));

    const entries = hiddenCarrierLifecycle()
      .map((raw, index) => projectLiveEntry(parsed(raw), index, false))
      .filter((entry) => entry !== undefined);
    expectNoSentinel(JSON.stringify(transcriptFromOverlayEntries(entries)));
  });
});
