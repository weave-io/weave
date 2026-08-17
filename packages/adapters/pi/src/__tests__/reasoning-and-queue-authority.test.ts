/**
 * Two invariants that live at the same boundary: what a retained fact may say
 * about the model's private reasoning, and what it may say about the child's
 * queue.
 *
 * Both are authority questions. Raw chain-of-thought is prose the adapter is
 * never allowed to publish, and a queue depth is a number only the child may
 * state. Every projection below is serialized WHOLE and searched for the
 * sentinel, so a leak into any nested replay step, message payload or preview
 * field fails the test rather than hiding behind a field-by-field assertion.
 */
import { describe, expect, it } from "bun:test";
import {
  mapNativeSessionEntryToOverlay,
  projectLiveEntry,
  transcriptFromOverlayEntries,
} from "../child-overlay-replay.js";
import {
  buildChildPickerEntries,
  childPickerPreview,
  type PiChildPickerNode,
} from "../child-picker.js";
import {
  type PiChildSessionEvent,
  parsePiChildSessionEvent,
} from "../child-session-events.js";
import {
  createPiChildTranscriptState,
  type PiChildTranscriptState,
  reducePiChildTranscript,
  renderPiChildTranscriptLines,
} from "../child-transcript.js";

/** Prose that only ever appears as raw chain-of-thought in these fixtures. */
const SENTINEL = "SECRET-CHAIN-OF-THOUGHT-a41f";
/** Prose the host itself published as a summary, which MAY be rendered. */
const SUMMARY = "TRUSTED-SUMMARY-9c02";

const parsed = (value: unknown): PiChildSessionEvent => {
  const result = parsePiChildSessionEvent(value);
  expect(result.success).toBe(true);
  if (!result.success) throw new Error("unreachable");
  return result.data;
};

const serialized = (value: unknown): string => JSON.stringify(value) ?? "";

const reduceAll = (events: readonly unknown[]): PiChildTranscriptState => {
  let state = createPiChildTranscriptState();
  for (const event of events) {
    const next = reducePiChildTranscript(state, {
      kind: "event",
      event: parsed(event),
    });
    expect(next.isOk()).toBe(true);
    if (next.isOk()) state = next.value;
  }
  return state;
};

describe("raw reasoning never survives into a retained projection", () => {
  it("keeps a standalone `thinking` event as a content-free marker", () => {
    const entry = projectLiveEntry(
      parsed({ type: "thinking", text: SENTINEL }),
      0,
      true,
    );
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe("thinking");
    expect(entry?.text).toBe("");
    // The whole entry, replay steps included.
    expect(serialized(entry)).not.toContain(SENTINEL);
  });

  it("keeps a streamed `thinking_delta` out of the live entry and its replay", () => {
    const entry = projectLiveEntry(
      parsed({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: SENTINEL },
      }),
      1,
      true,
    );
    expect(serialized(entry)).not.toContain(SENTINEL);
  });

  it("keeps a legacy `delta.thinking` out of the live entry and its replay", () => {
    const entry = projectLiveEntry(
      parsed({ type: "message_update", delta: { thinking: SENTINEL } }),
      1,
      true,
    );
    expect(serialized(entry)).not.toContain(SENTINEL);
  });

  it("blanks a reasoning content block carried by a terminal message", () => {
    const entry = projectLiveEntry(
      parsed({
        type: "message_end",
        message: {
          id: "m1",
          role: "assistant",
          content: [
            { type: "thinking", text: SENTINEL },
            { type: "text", text: "the answer" },
          ],
        },
      }),
      2,
      true,
    );
    expect(entry?.text).toContain("the answer");
    expect(serialized(entry)).not.toContain(SENTINEL);
  });

  it("blanks a reasoning block that names its prose in `thinking`", () => {
    const entry = projectLiveEntry(
      parsed({
        type: "message_end",
        message: {
          id: "m1",
          role: "assistant",
          content: [{ type: "reasoning", thinking: SENTINEL }],
        },
      }),
      2,
      true,
    );
    expect(serialized(entry)).not.toContain(SENTINEL);
  });

  it("keeps a historical persisted reasoning block out of the replay", () => {
    const mapped = mapNativeSessionEntryToOverlay(
      {
        type: "message",
        id: "entry-1",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", text: SENTINEL },
            { type: "reasoning_summary", text: SUMMARY },
            { type: "text", text: "done" },
          ],
        },
      },
      0,
    );
    expect(mapped.isOk()).toBe(true);
    const entry = mapped._unsafeUnwrap();
    expect(serialized(entry)).not.toContain(SENTINEL);
    // The one trusted surface still renders.
    expect(serialized(entry)).toContain(SUMMARY);
  });

  it("keeps the rebuilt transcript, its rows and its history free of reasoning", () => {
    const entries = [
      projectLiveEntry(parsed({ type: "thinking", text: SENTINEL }), 0, true),
      projectLiveEntry(
        parsed({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", delta: SENTINEL },
        }),
        1,
        true,
      ),
      projectLiveEntry(
        parsed({
          type: "message_end",
          message: {
            id: "m1",
            role: "assistant",
            content: [
              { type: "thinking", text: SENTINEL },
              { type: "text", text: "the answer" },
            ],
          },
        }),
        2,
        true,
      ),
    ].filter((entry) => entry !== undefined);

    const state = transcriptFromOverlayEntries(entries);
    expect(serialized(state)).not.toContain(SENTINEL);
    expect(renderPiChildTranscriptLines(state, 80).join("\n")).not.toContain(
      SENTINEL,
    );
  });

  it("keeps direct transcript reduction free of reasoning while recording that it happened", () => {
    const state = reduceAll([
      { type: "message_start", message: { id: "m1", role: "assistant" } },
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: SENTINEL },
      },
      { type: "thinking", text: SENTINEL },
      {
        type: "message_end",
        message: {
          id: "m1",
          role: "assistant",
          content: [
            { type: "thinking", text: SENTINEL },
            { type: "text", text: "the answer" },
          ],
        },
      },
    ]);
    expect(serialized(state)).not.toContain(SENTINEL);
    const assistant = state.entries.find((entry) => entry.kind === "assistant");
    expect(assistant?.kind === "assistant" && assistant.reasoningObserved).toBe(
      true,
    );
    expect(assistant?.kind === "assistant" && assistant.text).toContain(
      "the answer",
    );
  });

  it("renders an explicit reasoning summary through its own trusted event", () => {
    const entry = projectLiveEntry(
      parsed({ type: "reasoning_summary", text: SUMMARY }),
      0,
      true,
    );
    expect(entry?.text).toContain(SUMMARY);
    const state = reduceAll([
      { type: "message_start", message: { id: "m1", role: "assistant" } },
      { type: "reasoning_summary", text: SUMMARY },
    ]);
    expect(serialized(state)).toContain(SUMMARY);
  });
});

describe("the child picker previews activity, never reasoning", () => {
  it("prefers answer text", () => {
    expect(
      childPickerPreview({
        latestOutput: "the answer",
        currentTool: "bash",
        reasoningObserved: true,
      }),
    ).toBe("the answer");
  });

  it("falls back to the canonical tool fact, then to a content-free marker", () => {
    expect(
      childPickerPreview({ currentTool: "bash", reasoningObserved: true }),
    ).toBe("running bash");
    expect(childPickerPreview({ reasoningObserved: true })).toBe("reasoning");
    expect(childPickerPreview({})).toBe("");
  });

  it("keeps reasoning out of the serialized picker entries", () => {
    // The snapshot fields a reasoning child actually carries: no answer text,
    // no tool, and the marker set. Nothing here may become the sentinel.
    const node: PiChildPickerNode = {
      childId: "child-1",
      name: "shuttle",
      kind: "ordinary",
      status: "running",
      preview: childPickerPreview({
        latestOutput: "",
        reasoningObserved: true,
      }),
      live: true,
    };
    const entries = buildChildPickerEntries({ live: [node] });
    expect(entries.isOk()).toBe(true);
    const serializedEntries = serialized(entries._unsafeUnwrap());
    expect(serializedEntries).not.toContain(SENTINEL);
    expect(serializedEntries).toContain("reasoning");
  });
});

describe("queue depth is reported, never inferred", () => {
  it("leaves a `queue_update` that names no list unknown", () => {
    const event = parsed({ type: "queue_update" });
    expect(event.type).toBe("unknown");
    expect(serialized(event)).not.toContain("queue_change");
  });

  it("leaves a malformed `queue_update` unknown", () => {
    expect(parsed({ type: "queue_update", steering: "nope" }).type).toBe(
      "unknown",
    );
    expect(parsed({ type: "queue_update", followUp: { a: 1 } }).type).toBe(
      "unknown",
    );
    expect(parsed({ type: "queue_update", steering: [7] }).type).toBe(
      "unknown",
    );
  });

  it("leaves an oversized `queue_update` unknown rather than truncating its depth", () => {
    const oversized = Array.from({ length: 200 }, (_, index) => `q${index}`);
    expect(parsed({ type: "queue_update", followUp: oversized }).type).toBe(
      "unknown",
    );
  });

  it("leaves a report that names only one of the two queues unknown", () => {
    // `queue_update` is the host's complete statement of BOTH queues. One
    // empty list proves nothing about the other, so a depth may not be
    // derived from it - least of all the authoritative zero of a child the
    // parent has just steered.
    for (const partial of [
      { type: "queue_update", steering: [] },
      { type: "queue_update", followUp: [] },
      { type: "queue_update", steering: ["steer"] },
      { type: "queue_update", followUp: ["later"] },
    ]) {
      const event = parsed(partial);
      expect(event.type).toBe("unknown");
      expect(serialized(event)).not.toContain("queue_change");
    }
  });

  it("leaves a report unknown when either list is malformed, sparse or oversized", () => {
    const sparse: unknown[] = [];
    sparse.length = 2;
    const oversized = Array.from({ length: 200 }, (_, index) => `q${index}`);
    for (const malformed of [
      { type: "queue_update", steering: [], followUp: "nope" },
      { type: "queue_update", steering: "nope", followUp: [] },
      { type: "queue_update", steering: [], followUp: [7] },
      { type: "queue_update", steering: [{}], followUp: [] },
      { type: "queue_update", steering: [], followUp: sparse },
      { type: "queue_update", steering: sparse, followUp: [] },
      { type: "queue_update", steering: [], followUp: oversized },
      { type: "queue_update", steering: oversized, followUp: [] },
    ]) {
      expect(parsed(malformed).type).toBe("unknown");
    }
  });

  it("does not accept an inherited list as the host's own statement", () => {
    const inherited = Object.create({ followUp: [] }) as Record<
      string,
      unknown
    >;
    inherited.type = "queue_update";
    inherited.steering = [];
    expect(parsed(inherited).type).toBe("unknown");
  });

  it("carries a partial report as unknown through the transcript, its render and a rebuilt replay", () => {
    const partial = { type: "queue_update", steering: [] };
    const state = reduceAll([partial]);

    // Nothing in the transcript may state a depth for it.
    expect(state.queue).toBeUndefined();
    expect(
      state.entries.find((candidate) => candidate.kind === "queue"),
    ).toBeUndefined();
    const rendered = renderPiChildTranscriptLines(state, 80).join("\n");
    expect(rendered).not.toContain("size=0");
    expect(rendered).not.toContain("queue: 0");

    // The live replay row states no queue fact either, so a rebuilt replay
    // cannot invent one.
    const entry = projectLiveEntry(parsed(partial), 0, false);
    expect(entry?.kind).not.toBe("queue");
    expect(serialized(entry)).not.toContain("queue: 0");
    const rebuilt = transcriptFromOverlayEntries(
      entry === undefined ? [] : [entry],
    );
    expect(
      rebuilt.entries.find((candidate) => candidate.kind === "queue"),
    ).toBeUndefined();
    expect(rebuilt.queue).toBeUndefined();
  });

  it("accepts a complete empty report as an authoritative zero", () => {
    const event = parsed({
      type: "queue_update",
      steering: [],
      followUp: [],
    });
    expect(event).toMatchObject({ type: "queue_change", size: 0, queue: [] });
  });

  it("accepts a positive report", () => {
    const event = parsed({
      type: "queue_update",
      steering: ["steer"],
      followUp: ["later"],
    });
    expect(event).toMatchObject({
      type: "queue_change",
      size: 2,
      queue: ["steer", "later"],
    });
  });

  it("keeps a fieldless `queue_change` unknown through the transcript reducer", () => {
    const state = reduceAll([{ type: "queue_change" }]);
    const entry = state.entries.find((candidate) => candidate.kind === "queue");
    expect(entry?.kind).toBe("queue");
    expect(entry?.kind === "queue" && entry.size).toBeUndefined();
    expect(entry?.kind === "queue" && entry.queue).toBeUndefined();
    expect(state.queue).toBeUndefined();
    expect(renderPiChildTranscriptLines(state, 80).join("\n")).toContain(
      "size=unknown",
    );
  });

  it("keeps an explicit zero and a complete empty list authoritative in the transcript", () => {
    const explicitZero = reduceAll([{ type: "queue_change", size: 0 }]);
    const zeroEntry = explicitZero.entries.find(
      (candidate) => candidate.kind === "queue",
    );
    expect(zeroEntry?.kind === "queue" && zeroEntry.size).toBe(0);

    const emptyList = reduceAll([{ type: "queue_change", queue: [] }]);
    const listEntry = emptyList.entries.find(
      (candidate) => candidate.kind === "queue",
    );
    expect(listEntry?.kind === "queue" && listEntry.size).toBe(0);
  });

  it("keeps a positive report in the transcript", () => {
    const state = reduceAll([
      { type: "queue_change", size: 2, queue: ["a", "b"] },
    ]);
    const entry = state.entries.find((candidate) => candidate.kind === "queue");
    expect(entry?.kind === "queue" && entry.size).toBe(2);
    expect(state.queue).toEqual(["a", "b"]);
  });

  it("states `unknown` rather than zero on the live replay row", () => {
    const unknown = projectLiveEntry(
      parsed({ type: "queue_change" }),
      0,
      false,
    );
    expect(unknown?.text).toBe("queue: unknown");

    const zero = projectLiveEntry(
      parsed({ type: "queue_change", size: 0 }),
      1,
      false,
    );
    expect(zero?.text).toBe("queue: 0");

    const empty = projectLiveEntry(
      parsed({ type: "queue_change", queue: [] }),
      2,
      false,
    );
    expect(empty?.text).toBe("queue: 0");

    const positive = projectLiveEntry(
      parsed({ type: "queue_change", size: 3 }),
      3,
      false,
    );
    expect(positive?.text).toBe("queue: 3");
  });

  it("preserves the unknown depth through a rebuilt replay", () => {
    const entry = projectLiveEntry(parsed({ type: "queue_change" }), 0, false);
    expect(entry).toBeDefined();
    const state = transcriptFromOverlayEntries(
      entry === undefined ? [] : [entry],
    );
    const queueEntry = state.entries.find(
      (candidate) => candidate.kind === "queue",
    );
    expect(queueEntry?.kind === "queue" && queueEntry.size).toBeUndefined();
  });
});
