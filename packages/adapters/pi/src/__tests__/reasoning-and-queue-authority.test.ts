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
  MAX_CHILD_EVENT_STRING,
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

/**
 * Every `queue_update` shape whose queues cannot be read as the host's own
 * complete statement. None of them may ever state a depth.
 *
 * They are rebuilt per call because some carry one-shot state (a revoked
 * proxy, an accessor with a side-effect counter).
 */
const rejectedQueueReports = (): readonly unknown[] => {
  const accessorField: Record<string, unknown> = {
    type: "queue_update",
    followUp: [],
  };
  Object.defineProperty(accessorField, "steering", {
    enumerable: true,
    configurable: true,
    get: () => [],
  });

  const hiddenField: Record<string, unknown> = {
    type: "queue_update",
    steering: [],
  };
  Object.defineProperty(hiddenField, "followUp", {
    enumerable: false,
    configurable: true,
    writable: true,
    value: [],
  });

  const accessorIndex: unknown[] = [];
  Object.defineProperty(accessorIndex, "0", {
    enumerable: true,
    configurable: true,
    get: () => "steer",
  });

  const hiddenIndex: unknown[] = [];
  Object.defineProperty(hiddenIndex, "0", {
    enumerable: false,
    configurable: true,
    writable: true,
    value: "steer",
  });

  const sparse: unknown[] = [];
  sparse.length = 2;

  const decorated: unknown[] = ["steer"];
  (decorated as unknown as Record<string, unknown>).note = "extra";

  const revocable = Proxy.revocable(["steer"], {});
  revocable.revoke();

  return [
    accessorField,
    hiddenField,
    { type: "queue_update", steering: accessorIndex, followUp: [] },
    { type: "queue_update", steering: hiddenIndex, followUp: [] },
    { type: "queue_update", steering: sparse, followUp: [] },
    { type: "queue_update", steering: decorated, followUp: [] },
    { type: "queue_update", steering: revocable.proxy, followUp: [] },
    {
      type: "queue_update",
      steering: new Proxy(["steer"], {
        getOwnPropertyDescriptor: () => {
          throw new Error("hostile descriptor trap");
        },
      }),
      followUp: [],
    },
    {
      type: "queue_update",
      steering: ["q".repeat(MAX_CHILD_EVENT_STRING + 1)],
      followUp: [],
    },
    { type: "queue_update", steering: [7], followUp: [] },
    { type: "queue_update", steering: [] },
  ];
};

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

  const expectNoQueueAuthority = (value: unknown): void => {
    expect(() => parsePiChildSessionEvent(value)).not.toThrow();
    const result = parsePiChildSessionEvent(value);
    if (result.success) {
      expect(result.data.type).not.toBe("queue_change");
      expect(serialized(result.data)).not.toContain("queue_change");
      const state = reduceAll([value]);
      expect(state.queue).toBeUndefined();
      expect(
        state.entries.find((candidate) => candidate.kind === "queue"),
      ).toBeUndefined();
      expect(renderPiChildTranscriptLines(state, 80).join("\n")).not.toContain(
        "queue:",
      );
      const entry = projectLiveEntry(result.data, 0, false);
      expect(entry?.kind).not.toBe("queue");
      const rebuilt = transcriptFromOverlayEntries(
        entry === undefined ? [] : [entry],
      );
      expect(rebuilt.queue).toBeUndefined();
      expect(
        rebuilt.entries.find((candidate) => candidate.kind === "queue"),
      ).toBeUndefined();
      return;
    }
    expect(result.success).toBe(false);
    const empty = transcriptFromOverlayEntries([]);
    expect(empty.queue).toBeUndefined();
  };

  it("does not invoke a type getter and never states a queue from it", () => {
    let reads = 0;
    const value: Record<string, unknown> = {
      steering: ["steer"],
      followUp: ["later"],
    };
    Object.defineProperty(value, "type", {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        return "queue_update";
      },
    });
    expectNoQueueAuthority(value);
    expect(reads).toBe(0);
  });

  it("does not accept an inherited queue_update type as a queue report", () => {
    const inherited = Object.create({ type: "queue_update" }) as Record<
      string,
      unknown
    >;
    inherited.steering = ["steer"];
    inherited.followUp = ["later"];
    expectNoQueueAuthority(inherited);
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

  it("never invokes an accessor while reading a report, and states nothing for one", () => {
    // A getter is the payload's own CODE, not a value the host stated. Running
    // it to decide a queue depth would execute observed private-protocol data
    // inside the parser.
    let fieldReads = 0;
    const accessorField: Record<string, unknown> = {
      type: "queue_update",
      followUp: [],
    };
    Object.defineProperty(accessorField, "steering", {
      enumerable: true,
      configurable: true,
      get: () => {
        fieldReads += 1;
        return [];
      },
    });
    expect(parsed(accessorField).type).toBe("unknown");
    expect(fieldReads).toBe(0);

    let elementReads = 0;
    const accessorElement: unknown[] = [];
    Object.defineProperty(accessorElement, "0", {
      enumerable: true,
      configurable: true,
      get: () => {
        elementReads += 1;
        return "steer";
      },
    });
    expect(
      parsed({
        type: "queue_update",
        steering: accessorElement,
        followUp: [],
      }).type,
    ).toBe("unknown");
    expect(elementReads).toBe(0);
  });

  it("states nothing for a non-enumerable field or a non-enumerable index", () => {
    const hiddenField: Record<string, unknown> = {
      type: "queue_update",
      steering: [],
    };
    Object.defineProperty(hiddenField, "followUp", {
      enumerable: false,
      configurable: true,
      writable: true,
      value: [],
    });
    expect(parsed(hiddenField).type).toBe("unknown");

    const hiddenIndex: unknown[] = [];
    Object.defineProperty(hiddenIndex, "0", {
      enumerable: false,
      configurable: true,
      writable: true,
      value: "steer",
    });
    expect(hiddenIndex.length).toBe(1);
    expect(
      parsed({ type: "queue_update", steering: hiddenIndex, followUp: [] })
        .type,
    ).toBe("unknown");
  });

  it("states nothing for an array carrying an extra own enumerable property", () => {
    const decorated: unknown[] = ["steer"];
    (decorated as unknown as Record<string, unknown>).note = "extra";
    expect(
      parsed({ type: "queue_update", steering: decorated, followUp: [] }).type,
    ).toBe("unknown");
  });

  it("states nothing for an array subclass", () => {
    class QueueList extends Array<string> {}
    const subclass = QueueList.from(["steer"]);
    expect(Array.isArray(subclass)).toBe(true);
    expect(
      parsed({ type: "queue_update", steering: subclass, followUp: [] }).type,
    ).toBe("unknown");
  });

  it("rejects an overbound entry rather than truncating it", () => {
    const overbound = "q".repeat(MAX_CHILD_EVENT_STRING + 1);
    const event = parsed({
      type: "queue_update",
      steering: [overbound],
      followUp: [],
    });
    // A shortened entry would be a queue fact the host never stated.
    expect(event.type).toBe("unknown");
    expect(serialized(event)).not.toContain("queue_change");

    // The exact bound is still admitted, unchanged.
    const exact = "q".repeat(MAX_CHILD_EVENT_STRING);
    expect(
      parsed({ type: "queue_update", steering: [exact], followUp: [] }),
    ).toMatchObject({ type: "queue_change", size: 1, queue: [exact] });
  });

  it("states nothing for a boxed string entry", () => {
    expect(
      parsed({
        type: "queue_update",
        // An intentionally boxed String object, which is not a primitive.
        steering: [new String("steer")],
        followUp: [],
      }).type,
    ).toBe("unknown");
  });

  it("states nothing when a descriptor read throws, and never throws itself", () => {
    const hostile = new Proxy(["steer"], {
      getOwnPropertyDescriptor: () => {
        throw new Error("hostile descriptor trap");
      },
    });
    expect(() =>
      parsePiChildSessionEvent({
        type: "queue_update",
        steering: hostile,
        followUp: [],
      }),
    ).not.toThrow();
    expect(
      parsed({ type: "queue_update", steering: hostile, followUp: [] }).type,
    ).toBe("unknown");

    const revocable = Proxy.revocable(["steer"], {});
    revocable.revoke();
    expect(
      parsed({
        type: "queue_update",
        steering: revocable.proxy,
        followUp: [],
      }).type,
    ).toBe("unknown");

    const lying = new Proxy(["steer"], {
      getOwnPropertyDescriptor: (target, key) =>
        key === "0"
          ? { get: () => "steer", enumerable: true, configurable: true }
          : Object.getOwnPropertyDescriptor(target, key),
    });
    expect(
      parsed({ type: "queue_update", steering: lying, followUp: [] }).type,
    ).toBe("unknown");
  });

  it("never runs a proxy's `get` trap while reading a report", () => {
    let trapped = 0;
    const watched = new Proxy(["steer"], {
      get: (target, key, receiver) => {
        trapped += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    parsed({ type: "queue_update", steering: watched, followUp: [] });
    expect(trapped).toBe(0);
  });

  it("carries every rejected report shape as unknown through the transcript, its render and a rebuilt replay", () => {
    for (const rejected of rejectedQueueReports()) {
      const state = reduceAll([rejected]);
      expect(state.queue).toBeUndefined();
      expect(
        state.entries.find((candidate) => candidate.kind === "queue"),
      ).toBeUndefined();
      const rendered = renderPiChildTranscriptLines(state, 80).join("\n");
      expect(rendered).not.toContain("size=");
      expect(rendered).not.toContain("queue:");

      const entry = projectLiveEntry(parsed(rejected), 0, false);
      expect(entry?.kind).not.toBe("queue");
      const rebuilt = transcriptFromOverlayEntries(
        entry === undefined ? [] : [entry],
      );
      expect(rebuilt.queue).toBeUndefined();
      expect(
        rebuilt.entries.find((candidate) => candidate.kind === "queue"),
      ).toBeUndefined();
    }
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

  it("preserves the exact queued strings and size of a `queue_update` report", () => {
    const exact = "q".repeat(MAX_CHILD_EVENT_STRING);
    const state = reduceAll([
      { type: "queue_update", steering: ["steer"], followUp: [exact] },
    ]);
    const entry = state.entries.find((candidate) => candidate.kind === "queue");
    expect(entry?.kind === "queue" && entry.size).toBe(2);
    // Byte for byte: nothing was sliced on the way in.
    expect(state.queue).toEqual(["steer", exact]);
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
