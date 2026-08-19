/**
 * Bug A — streamed assistant text must reach the card's Native Line and the
 * inspector's live `streaming reply` row.
 *
 * Every case here drives the EXACT Pi 0.84 lifecycle the host emits, in the
 * order it emits it, through the real seams:
 *
 *   message_start
 *   message_update(assistantMessageEvent: thinking_start)
 *   message_update(assistantMessageEvent: thinking_delta)   ← raw CoT
 *   message_update(assistantMessageEvent: thinking_end)     ← raw CoT
 *   message_update(assistantMessageEvent: text_start)
 *   message_update(assistantMessageEvent: text_delta) × N
 *   message_update(assistantMessageEvent: text_end)
 *   … later …
 *   message_end
 *
 * The observed regressions were:
 *
 *   1. every structural `message_update` (text_start, text_end, thinking_end,
 *      toolcall_*) was mapped to the content-free `reasoning` card fact, so the
 *      Native Line said `↳ reasoning` while the child was answering, and said
 *      it AGAIN right after the last text delta (`text_end`) — permanently, up
 *      to settlement;
 *   2. an inspector opened after the deltas started had no bounded live source
 *      to recover the unfinished answer from, so it showed a content-free
 *      `shuttle · reply` header with no body.
 */

import { describe, expect, it } from "bun:test";
import {
  initTheme,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, TUI } from "@earendil-works/pi-tui";
import { PiChildCardProjection } from "../child-card-model.js";
import { renderDelegationCard } from "../child-card-render.js";
import {
  createChildOverlayController,
  createChildOverlayCustomComponent,
  createMemoryChildOverlaySource,
  type MemoryOverlaySourceChild,
} from "../child-overlay.js";
import { childOverlayTranscriptInput } from "../child-overlay-facts.js";
import { renderOverlayPiNative } from "../child-overlay-pi-native.js";
import { transcriptFromOverlayEntries } from "../child-overlay-replay.js";
import type { ChildOverlayView } from "../child-overlay-types.js";
import {
  type PiChildSessionEvent,
  parsePiChildSessionEvent,
} from "../child-session-events.js";
import { MAX_LATEST_OUTPUT_BYTES } from "../child-tree.js";
import type { PiUiThemePort } from "../types.js";
import { plainPaint } from "../ui-paint.js";

initTheme("default");

const CHILD_ID = "streamed-answer-child";
const GENERATION = "generation-1";
const WIDTH = 120;
const ROWS = 80;

/** The sentinel that must never appear on any surface. */
const RAW_COT = "SECRET-CHAIN-OF-THOUGHT-42";

const TEST_THEME: PiUiThemePort = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");

function stripAnsi(value: string): string {
  return value.replace(ANSI, "");
}

// ---------------------------------------------------------------------------
// The exact real Pi 0.84 wire lifecycle
// ---------------------------------------------------------------------------

/**
 * `AssistantMessage` as Pi 0.84 carries it on `message_start`. It has no `id`,
 * which is exactly why lifecycle identity has to be allocated by the reader.
 */
const assistantMessage = (text: string) => ({
  role: "assistant" as const,
  api: "anthropic-messages",
  provider: "anthropic",
  model: "test-model",
  content: text.length > 0 ? [{ type: "text", text }] : [],
  stopReason: "stop",
  usage: {
    input: 120,
    output: 340,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 460,
  },
});

const ANSWER_DELTAS = [
  "The reporter ",
  "drops rows ",
  "when the ",
  "window trims.",
] as const;

const FULL_ANSWER = ANSWER_DELTAS.join("");

/**
 * The wire form the RPC/JSON protocol actually sends: `message_update` carries
 * `usage` plus `assistantMessageEvent`, and the cumulative `partial` snapshot
 * is stripped (`toJsonEvent`). There is no `message` field, no message id, and
 * no per-delta sequence — `contentIndex` names the content BLOCK, which every
 * delta of one answer shares. That is the whole identity a reader ever gets.
 */
const update = (assistantMessageEvent: Record<string, unknown>) => ({
  type: "message_update",
  usage: { input: 120, output: 12, cacheRead: 0, cacheWrite: 0 },
  assistantMessageEvent,
});

/** The whole lifecycle up to (but excluding) `message_end`. */
function streamingLifecycle(): readonly Record<string, unknown>[] {
  return [
    { type: "message_start", message: assistantMessage("") },
    update({ type: "thinking_start", contentIndex: 0 }),
    update({ type: "thinking_delta", contentIndex: 0, delta: RAW_COT }),
    update({ type: "thinking_end", contentIndex: 0, content: RAW_COT }),
    update({ type: "text_start", contentIndex: 1 }),
    ...ANSWER_DELTAS.map((delta) =>
      update({ type: "text_delta", contentIndex: 1, delta }),
    ),
    update({ type: "text_end", contentIndex: 1, content: FULL_ANSWER }),
  ];
}

function terminalEvent(): Record<string, unknown> {
  return { type: "message_end", message: assistantMessage(FULL_ANSWER) };
}

function parsed(raw: Record<string, unknown>): PiChildSessionEvent {
  const result = parsePiChildSessionEvent(raw);
  expect(result.success).toBe(true);
  if (!result.success) throw new Error("unreachable");
  return result.data;
}

// ---------------------------------------------------------------------------
// 1. The delegation card
// ---------------------------------------------------------------------------

function projection(): PiChildCardProjection {
  let clock = 1_700_000_000_000;
  return new PiChildCardProjection({
    threadId: CHILD_ID,
    agentName: "shuttle",
    assignment: "summarize the failing suite",
    model: "test-model",
    runNumber: 1,
    action: "start",
    now: () => {
      clock += 10;
      return clock;
    },
  });
}

/** Every ANSI-free row the rendered card paints. */
function cardRows(card: PiChildCardProjection): string[] {
  return renderDelegationCard(card.facts(), {
    width: WIDTH,
    paint: plainPaint(),
  }).map((row) => stripAnsi(row).replace(/\s+$/u, ""));
}

describe("Task 5 · the parent card has reasoning-only live activity", () => {
  it("keeps assistant and generic thinking streams out of facts and the card", () => {
    const card = projection();
    for (const raw of streamingLifecycle()) card.applySessionEvent(parsed(raw));

    const facts = card.facts();
    expect(facts.activity).toEqual({ kind: "boot", text: "", live: false });
    expect(facts.viewport).toEqual({ rows: [], above: 0, atBottom: true });
    expect(JSON.stringify(facts)).not.toContain(FULL_ANSWER.trim());
    expect(JSON.stringify(facts)).not.toContain(RAW_COT);
    expect(cardRows(card).join("\n")).not.toContain(FULL_ANSWER.trim());
    expect(cardRows(card).join("\n")).not.toContain(RAW_COT);
  });

  it("does not create a reasoning row from a content-free structural thinking frame", () => {
    const card = projection();
    for (const raw of streamingLifecycle().slice(0, 4))
      card.applySessionEvent(parsed(raw));
    expect(card.facts().activity).toEqual({
      kind: "boot",
      text: "",
      live: false,
    });
    expect(card.facts().viewport.rows).toEqual([]);
  });

  it("keeps settled output authoritative but never renders it as child activity", () => {
    const card = projection();
    for (const raw of streamingLifecycle()) card.applySessionEvent(parsed(raw));
    card.applySessionEvent(parsed(terminalEvent()));
    const settled = card.settle({
      outcome: "completed",
      assistantOutput: FULL_ANSWER,
    });
    expect(settled.terminal?.headline).toBe("child completed");
    expect(settled.activity).toEqual({ kind: "boot", text: "", live: false });
    expect(settled.viewport.rows).toEqual([]);
    expect(cardRows(card).join("\n")).not.toContain(FULL_ANSWER.trim());
    expect(cardRows(card).join("\n")).not.toContain(RAW_COT);
  });
});

// ---------------------------------------------------------------------------
// 2. The inspector overlay
// ---------------------------------------------------------------------------

/**
 * The child's own live-answer fact: the message it is writing NOW, stamped
 * with that message's own lifecycle id. Presence is the stream-open state, so
 * a child that is between messages simply has none.
 */
function liveChild(streamedAnswer?: {
  readonly id: number;
  readonly text: string;
}): MemoryOverlaySourceChild {
  return {
    childId: CHILD_ID,
    threadId: CHILD_ID,
    status: "live",
    title: "streamed answer child",
    generationId: GENERATION,
    parentChildId: undefined,
    agentName: "shuttle",
    parentAgentName: "loom",
    model: "test-model",
    ...(streamedAnswer === undefined ? {} : { streamedAnswer }),
    runs: [{ run: 1, action: "start" }],
    branchIds: ["main"],
    descendantChildIds: [],
    entries: [
      {
        id: "entry-0",
        payload: {
          type: "message",
          id: "entry-0",
          parentId: null,
          timestamp: new Date(1_700_000_000_000).toISOString(),
          message: {
            role: "user",
            content: [{ type: "text", text: "summarize the failing suite" }],
          },
        },
      },
    ],
  };
}

function testTui(): TUI & { requestRender(): void } {
  return Object.assign(Object.create(TUI.prototype) as TUI, {
    terminal: { rows: ROWS },
    requestRender: () => {},
  });
}

function open(child: MemoryOverlaySourceChild) {
  const source = createMemoryChildOverlaySource([child]);
  const controller = createChildOverlayController(source);
  const component = createChildOverlayCustomComponent(
    testTui(),
    TEST_THEME,
    getKeybindings() as unknown as KeybindingsManager,
    controller,
    () => {},
    () => {},
  );
  return { controller, component, source };
}

function transcriptRows(component: {
  render(width: number): readonly string[];
}): string[] {
  return component
    .render(WIDTH)
    .map(stripAnsi)
    .slice(1, -1)
    .map((line) => line.slice(1, -1))
    .map((line) => {
      const split = line.indexOf("│");
      return (split === -1 ? line : line.slice(0, split)).replace(/\s+$/u, "");
    });
}

function paneRows(view: ChildOverlayView, width = 76): readonly string[] {
  return renderOverlayPiNative(
    plainPaint(),
    childOverlayTranscriptInput(view),
    width,
  ).plain.map((line) => line.replace(/\s+$/u, ""));
}

function currentView(controller: {
  view(): { isOk(): boolean; _unsafeUnwrap(): ChildOverlayView };
}): ChildOverlayView {
  const view = controller.view();
  expect(view.isOk()).toBe(true);
  return view._unsafeUnwrap();
}

describe("Bug A · the inspector renders one growing live assistant row", () => {
  it("grows a single `streaming reply` body in place from text deltas", async () => {
    const { controller, component } = open(liveChild());
    (await controller.open(CHILD_ID))._unsafeUnwrap();

    for (const raw of streamingLifecycle()) {
      controller.applyLiveEvent(raw)._unsafeUnwrap();
    }

    const rows = transcriptRows(component);
    const heads = rows.filter((row) =>
      row.includes("shuttle · streaming reply"),
    );
    expect(heads).toHaveLength(1);
    expect(rows.some((row) => row.includes(FULL_ANSWER.trim()))).toBe(true);
    expect(rows.join("\n")).not.toContain(RAW_COT);

    // The sentinel is absent from every retained surface, not just the paint:
    // transcript state, window entries, replay steps and the shared compact
    // reducer state all cross into snapshots, search and persistence.
    const view = currentView(controller);
    expect(JSON.stringify(view.transcript)).not.toContain(RAW_COT);
    expect(JSON.stringify(view.entries)).not.toContain(RAW_COT);
    expect(JSON.stringify(view.compact)).not.toContain(RAW_COT);
  });

  it("never re-adopts the lifecycle it already adopted", async () => {
    // The child finished its message; a repeated read still reports the same
    // lifecycle id. Adopting it again would print the same answer twice, and
    // the window refuses on IDENTITY, never by comparing the answer's words.
    const { controller } = open(liveChild({ id: 7, text: FULL_ANSWER }));
    (await controller.open(CHILD_ID))._unsafeUnwrap();
    for (const raw of streamingLifecycle()) {
      controller.applyLiveEvent(raw)._unsafeUnwrap();
    }
    controller.applyLiveEvent(terminalEvent())._unsafeUnwrap();
    (await controller.refreshOpenChild())._unsafeUnwrap();

    const rows = paneRows(currentView(controller));
    expect(rows.filter((row) => row.includes("shuttle ·"))).toHaveLength(1);
    expect(
      rows.filter((row) => row.includes("The reporter drops rows")),
    ).toHaveLength(1);
  });

  it("drops the provisional row once the child stops writing that message", async () => {
    // The catch-up row is a claim about a message in flight. When the child
    // reports no open message, that claim expires - post-`message_end`
    // duplication is impossible because the fact itself is gone, not because
    // some text matched.
    const child = liveChild({ id: 3, text: FULL_ANSWER });
    const { controller } = open(child);
    (await controller.open(CHILD_ID))._unsafeUnwrap();
    expect(
      paneRows(currentView(controller)).some((row) =>
        row.includes("streaming reply"),
      ),
    ).toBe(true);

    (child as { streamedAnswer?: unknown }).streamedAnswer = undefined;
    (await controller.refreshOpenChild())._unsafeUnwrap();

    const rows = paneRows(currentView(controller));
    expect(rows.some((row) => row.includes("streaming reply"))).toBe(false);
    expect(rows.some((row) => row.includes("The reporter drops rows"))).toBe(
      false,
    );
  });

  it("adopts a later message whose text equals an older terminal answer", async () => {
    // Two consecutive messages with identical text. Content correlation hid
    // the second one entirely; lifecycle identity shows both.
    const child = liveChild();
    const { controller } = open(child);
    (await controller.open(CHILD_ID))._unsafeUnwrap();
    for (const raw of streamingLifecycle()) {
      controller.applyLiveEvent(raw)._unsafeUnwrap();
    }
    controller.applyLiveEvent(terminalEvent())._unsafeUnwrap();

    (child as { streamedAnswer?: unknown }).streamedAnswer = {
      id: 2,
      text: FULL_ANSWER,
    };
    (await controller.refreshOpenChild())._unsafeUnwrap();

    const rows = paneRows(currentView(controller));
    expect(rows.filter((row) => row.includes("shuttle · reply"))).toHaveLength(
      1,
    );
    expect(
      rows.filter((row) => row.includes("shuttle · streaming reply")),
    ).toHaveLength(1);
    expect(
      rows.filter((row) => row.includes("The reporter drops rows")),
    ).toHaveLength(2);
  });

  it("never adopts a settled child's snapshot", async () => {
    const settled = {
      ...liveChild({ id: 1, text: FULL_ANSWER }),
      status: "settled" as const,
    };
    const { controller } = open(settled);
    (await controller.open(CHILD_ID))._unsafeUnwrap();

    const rows = paneRows(currentView(controller));
    expect(rows.some((row) => row.includes("streaming reply"))).toBe(false);
    expect(rows.some((row) => row.includes("The reporter drops rows"))).toBe(
      false,
    );
  });

  it("recovers the unfinished answer when opened after the deltas", async () => {
    // The reader opened the inspector mid-stream: the live events already
    // happened and this controller never saw them. The only authoritative
    // bounded live source is the child's answer-only snapshot.
    const { controller } = open(liveChild({ id: 1, text: FULL_ANSWER }));
    (await controller.open(CHILD_ID))._unsafeUnwrap();

    const rows = paneRows(currentView(controller));
    expect(rows.some((row) => row.includes("streaming reply"))).toBe(true);
    expect(rows.some((row) => row.includes("The reporter drops rows"))).toBe(
      true,
    );
    expect(rows.join("\n")).not.toContain(RAW_COT);
  });

  it("grows the adopted row in place while the same message keeps streaming", async () => {
    const child = liveChild({ id: 4, text: ANSWER_DELTAS[0] });
    const { controller } = open(child);
    (await controller.open(CHILD_ID))._unsafeUnwrap();

    (child as { streamedAnswer?: unknown }).streamedAnswer = {
      id: 4,
      text: FULL_ANSWER,
    };
    (await controller.refreshOpenChild())._unsafeUnwrap();

    const rows = paneRows(currentView(controller));
    expect(
      rows.filter((row) => row.includes("shuttle · streaming reply")),
    ).toHaveLength(1);
    expect(rows.some((row) => row.includes(FULL_ANSWER))).toBe(true);
  });

  it("keeps the adopted row through the rebuild every trim runs", async () => {
    const { controller } = open(liveChild({ id: 9, text: FULL_ANSWER }));
    (await controller.open(CHILD_ID))._unsafeUnwrap();

    const rebuilt = transcriptFromOverlayEntries(
      currentView(controller).entries,
    );
    const streamed = rebuilt.entries.filter(
      (entry) => entry.kind === "assistant",
    );
    expect(streamed).toHaveLength(1);
    expect(streamed[0]?.text).toBe(FULL_ANSWER);
  });

  it("does not duplicate the answer when live deltas follow the catch-up seed", async () => {
    const { controller } = open(liveChild({ id: 1, text: ANSWER_DELTAS[0] }));
    (await controller.open(CHILD_ID))._unsafeUnwrap();

    for (const raw of streamingLifecycle()) {
      controller.applyLiveEvent(raw)._unsafeUnwrap();
    }
    controller.applyLiveEvent(terminalEvent())._unsafeUnwrap();

    const rows = paneRows(currentView(controller));
    const body = rows.filter((row) => row.includes("The reporter drops rows"));
    expect(body).toHaveLength(1);
    const heads = rows.filter((row) => row.includes("shuttle ·"));
    expect(heads).toHaveLength(1);
  });

  it("keeps the unfinished answer across a live window rebuild", async () => {
    const { controller } = open(liveChild());
    (await controller.open(CHILD_ID))._unsafeUnwrap();
    for (const raw of streamingLifecycle()) {
      controller.applyLiveEvent(raw)._unsafeUnwrap();
    }

    // The exact reconstruction every trim, page merge and search fetch runs:
    // the retained window is replayed back into a transcript. An unfinished
    // answer that only ever lived in incremental reducer state disappears here.
    const rebuilt = transcriptFromOverlayEntries(
      currentView(controller).entries,
    );
    const streamed = rebuilt.entries.filter(
      (entry) => entry.kind === "assistant",
    );
    expect(streamed).toHaveLength(1);
    expect(streamed[0]?.text).toBe(FULL_ANSWER);
    expect(JSON.stringify(rebuilt)).not.toContain(RAW_COT);
  });

  it("survives a window trim that rebuilds the transcript mid-stream", async () => {
    // A control event arriving between two answer deltas pushes the window
    // past its cap, and the trim rebuilds the transcript from the retained
    // entries while the answer is still unfinished.
    const trimming = createChildOverlayController(
      createMemoryChildOverlaySource([liveChild()]),
      { windowCap: 2 },
    );
    (await trimming.open(CHILD_ID))._unsafeUnwrap();
    const lifecycle = streamingLifecycle();
    const interrupted = [
      ...lifecycle.slice(0, 7),
      { type: "status", status: "working", message: "still answering" },
      ...lifecycle.slice(7),
    ];
    for (const raw of interrupted) {
      trimming.applyLiveEvent(raw)._unsafeUnwrap();
    }

    const rows = paneRows(currentView(trimming));
    expect(rows.some((row) => row.includes("streaming reply"))).toBe(true);
    expect(rows.some((row) => row.includes(FULL_ANSWER))).toBe(true);
    expect(rows.join("\n")).not.toContain(RAW_COT);
  });

  it("replaces the streamed body with the terminal text exactly once", async () => {
    const { controller } = open(liveChild());
    (await controller.open(CHILD_ID))._unsafeUnwrap();
    for (const raw of streamingLifecycle()) {
      controller.applyLiveEvent(raw)._unsafeUnwrap();
    }
    controller.applyLiveEvent(terminalEvent())._unsafeUnwrap();

    const rows = paneRows(currentView(controller));
    expect(rows.some((row) => row.includes("shuttle · reply"))).toBe(true);
    expect(rows.some((row) => row.includes("streaming reply"))).toBe(false);
    const body = rows.filter((row) => row.includes("The reporter drops rows"));
    expect(body).toHaveLength(1);
    expect(rows.join("\n")).not.toContain(RAW_COT);
  });
});

// ---------------------------------------------------------------------------
// 3. Repeated identical deltas
// ---------------------------------------------------------------------------

/**
 * Bug B — a streamed delta must never be discarded because an earlier delta
 * said the same thing.
 *
 * Deltas were keyed by their own sanitized text, so the second ` the` of an
 * answer was read as the first ` the` delivered twice and silently dropped.
 * The card then printed a sentence the child never produced.
 *
 * There is nothing on the wire to key a delta by: `toJsonEvent` strips the
 * cumulative `partial` snapshot, so a `text_delta` arrives as
 * `{ type, usage, assistantMessageEvent: { type, contentIndex, delta } }` —
 * `contentIndex` names the content block every delta of one answer shares, and
 * the JSONL pipe carrying them has no retransmission. A repeated delta is a
 * repeated token.
 *
 * Identity a host DOES state is still honoured: `message_start` happens once
 * per message, and a repeat of it must not erase the answer already streamed.
 */

/** An answer whose words genuinely repeat, split on word boundaries. */
const REPEAT_DELTAS = [
  "the ",
  "cat ",
  "and ",
  "the ",
  "hat ",
  "and ",
  "the ",
  "cat",
] as const;

const REPEAT_ANSWER = REPEAT_DELTAS.join("");

/** What content-keyed dedup produced instead: every repeat deleted. */
const DEDUPED_ANSWER = "the cat and hat";

function repeatingLifecycle(): readonly Record<string, unknown>[] {
  return [
    { type: "message_start", message: assistantMessage("") },
    update({ type: "thinking_start", contentIndex: 0 }),
    update({ type: "thinking_delta", contentIndex: 0, delta: RAW_COT }),
    update({ type: "thinking_end", contentIndex: 0, content: RAW_COT }),
    update({ type: "text_start", contentIndex: 1 }),
    ...REPEAT_DELTAS.map((delta) =>
      update({ type: "text_delta", contentIndex: 1, delta }),
    ),
    update({ type: "text_end", contentIndex: 1, content: REPEAT_ANSWER }),
  ];
}

describe("Bug B · repeated identical deltas all reach the answer", () => {
  it("keeps repeated assistant deltas out of the parent card", () => {
    const card = projection();
    for (const raw of repeatingLifecycle()) card.applySessionEvent(parsed(raw));

    expect(card.facts().activity).toEqual({
      kind: "boot",
      text: "",
      live: false,
    });
    expect(card.facts().viewport.rows).toEqual([]);
    expect(cardRows(card).join("\n")).not.toContain(REPEAT_ANSWER);
    expect(cardRows(card).join("\n")).not.toContain(RAW_COT);
  });

  it("does not turn repeated message starts into a parent-card row", () => {
    const named = (text: string) => ({
      ...assistantMessage(text),
      id: "asst-77",
    });
    const card = projection();
    card.applySessionEvent(
      parsed({ type: "message_start", message: named("") }),
    );
    for (const delta of REPEAT_DELTAS)
      card.applySessionEvent(
        parsed(update({ type: "text_delta", contentIndex: 1, delta })),
      );
    card.applySessionEvent(
      parsed({ type: "message_start", message: named("") }),
    );
    expect(card.facts().activity).toEqual({
      kind: "boot",
      text: "",
      live: false,
    });
    expect(card.facts().viewport.rows).toEqual([]);
  });

  it("keeps every repeat in the inspector's live row and its rebuild", async () => {
    const { controller, component } = open(liveChild());
    (await controller.open(CHILD_ID))._unsafeUnwrap();

    for (const raw of repeatingLifecycle()) {
      controller.applyLiveEvent(raw)._unsafeUnwrap();
    }

    const rows = transcriptRows(component);
    expect(rows.some((row) => row.includes(REPEAT_ANSWER))).toBe(true);
    expect(rows.some((row) => row.includes(DEDUPED_ANSWER))).toBe(false);

    // The same answer must survive the reconstruction every trim, page merge
    // and search fetch runs.
    const view = currentView(controller);
    const rebuilt = transcriptFromOverlayEntries(view.entries);
    const streamed = rebuilt.entries.filter(
      (entry) => entry.kind === "assistant",
    );
    expect(streamed).toHaveLength(1);
    expect(streamed[0]?.text).toBe(REPEAT_ANSWER);
    expect(JSON.stringify(view.entries)).not.toContain(RAW_COT);
    expect(JSON.stringify(rebuilt)).not.toContain(RAW_COT);
  });
});

// ---------------------------------------------------------------------------
// 4. Exact delta accumulation, and card/inspector parity
// ---------------------------------------------------------------------------

/**
 * A streamed delta is a FRAGMENT. A model splits `hello` into `hel` + `lo`
 * whenever its tokenizer feels like it, and the wire owns every space between
 * words.
 *
 * The card and the compact block used to sanitize each fragment on arrival and
 * then join the results with a space, so `["hel", "lo"]` was painted as
 * `hel lo` while the inspector, which concatenated, said `hello`. Two surfaces
 * reading the same wire disagreed about what the child had said, and neither
 * was quoting it.
 *
 * Both now accumulate the raw answer with the same primitive and sanitize only
 * the projection, so the card's text is exactly the inspector's text with the
 * card's own documented whitespace normalization applied.
 */

/** The card's answer text after a delta script. */
function cardAnswerFrom(deltas: readonly string[]): string {
  const card = projection();
  card.applySessionEvent(
    parsed({ type: "message_start", message: assistantMessage("") }),
  );
  for (const delta of deltas) {
    card.applySessionEvent(
      parsed(update({ type: "text_delta", contentIndex: 1, delta })),
    );
  }
  return card.facts().activity.text;
}

/** The inspector's live assistant row text after the same script. */
async function inspectorAnswerFrom(deltas: readonly string[]): Promise<string> {
  const { controller } = open(liveChild());
  (await controller.open(CHILD_ID))._unsafeUnwrap();
  controller
    .applyLiveEvent({
      type: "message_start",
      message: assistantMessage(""),
    })
    ._unsafeUnwrap();
  for (const delta of deltas) {
    controller
      .applyLiveEvent(update({ type: "text_delta", contentIndex: 1, delta }))
      ._unsafeUnwrap();
  }
  const rebuilt = transcriptFromOverlayEntries(currentView(controller).entries);
  const assistant = rebuilt.entries.filter(
    (entry) => entry.kind === "assistant",
  );
  expect(assistant).toHaveLength(1);
  return assistant[0]?.text ?? "";
}

describe("Bug B · deltas are concatenated exactly on every surface", () => {
  const scripts: readonly {
    readonly name: string;
    readonly deltas: readonly string[];
    readonly answer: string;
  }[] = [
    { name: "intra-word split", deltas: ["hel", "lo"], answer: "hello" },
    {
      name: "a whitespace-only delta between words",
      deltas: ["Hello", " ", "world"],
      answer: "Hello world",
    },
    {
      name: "punctuation split from its word",
      deltas: ["done", ".", " ", "next"],
      answer: "done. next",
    },
    {
      name: "a repeated token",
      deltas: ["the ", "the ", "the ", "end"],
      answer: "the the the end",
    },
    {
      name: "a single character at a time",
      deltas: [..."streaming"],
      answer: "streaming",
    },
  ];

  for (const script of scripts) {
    it(`accumulates ${script.name} identically on card and inspector`, async () => {
      const card = cardAnswerFrom(script.deltas);
      const inspector = await inspectorAnswerFrom(script.deltas);
      expect(card).toBe("");
      expect(inspector).toBe(script.answer);
    });
  }

  it("keeps a multi-line answer whole, and normalizes it only for the card", async () => {
    const deltas = ["line one", "\n", "line two"];
    const inspector = await inspectorAnswerFrom(deltas);
    expect(inspector).toBe("line one\nline two");
    // The parent card deliberately has no assistant activity row at all.
    expect(cardAnswerFrom(deltas)).toBe("");
  });

  it("bounds a long stream on both surfaces without inventing separators", async () => {
    // Well past the shared 4 KiB preview budget, and split mid-word so a
    // joined-with-spaces accumulator would be obvious.
    const deltas = Array.from({ length: 4_000 }, (_, index) =>
      index % 2 === 0 ? "ab" : "cd",
    );
    const card = cardAnswerFrom(deltas);
    const inspector = await inspectorAnswerFrom(deltas);
    expect(card).toBe("");
    expect(inspector.length).toBeLessThanOrEqual(MAX_LATEST_OUTPUT_BYTES);
    // No separator was invented in the inspector's authoritative answer.
    expect(inspector).not.toContain(" ");
    expect(inspector.startsWith("abcdabcd")).toBe(true);
  });

  it("replaces the accumulation with the terminal message, exactly once", async () => {
    const deltas = ["par", "tial ans", "wer"];
    const card = projection();
    card.applySessionEvent(
      parsed({ type: "message_start", message: assistantMessage("") }),
    );
    for (const delta of deltas) {
      card.applySessionEvent(
        parsed(update({ type: "text_delta", contentIndex: 1, delta })),
      );
    }
    expect(card.facts().activity).toEqual({
      kind: "boot",
      text: "",
      live: false,
    });
    expect(card.facts().viewport.rows).toEqual([]);
    card.applySessionEvent(
      parsed({
        type: "message_end",
        message: assistantMessage("partial answer, completed"),
      }),
    );
    const facts = card.facts();
    expect(facts.activity).toEqual({
      kind: "boot",
      text: "",
      live: false,
    });
    expect(facts.viewport.rows).toEqual([]);

    const { controller } = open(liveChild());
    (await controller.open(CHILD_ID))._unsafeUnwrap();
    controller
      .applyLiveEvent({
        type: "message_start",
        message: assistantMessage(""),
      })
      ._unsafeUnwrap();
    for (const delta of deltas) {
      controller
        .applyLiveEvent(update({ type: "text_delta", contentIndex: 1, delta }))
        ._unsafeUnwrap();
    }
    controller
      .applyLiveEvent({
        type: "message_end",
        message: assistantMessage("partial answer, completed"),
      })
      ._unsafeUnwrap();
    const rebuilt = transcriptFromOverlayEntries(
      currentView(controller).entries,
    );
    const assistant = rebuilt.entries.filter(
      (entry) => entry.kind === "assistant",
    );
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.text).toBe("partial answer, completed");
  });

  it("starts a fresh answer for the next message instead of extending", () => {
    const card = projection();
    card.applySessionEvent(
      parsed({ type: "message_start", message: assistantMessage("") }),
    );
    card.applySessionEvent(
      parsed(update({ type: "text_delta", contentIndex: 1, delta: "first" })),
    );
    card.applySessionEvent(
      parsed({ type: "message_end", message: assistantMessage("first") }),
    );
    card.applySessionEvent(
      parsed({ type: "message_start", message: assistantMessage("") }),
    );
    card.applySessionEvent(
      parsed(update({ type: "text_delta", contentIndex: 1, delta: "second" })),
    );
    expect(card.facts().activity).toEqual({
      kind: "boot",
      text: "",
      live: false,
    });
    expect(card.facts().viewport.rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. A frame that carries both an answer and raw reasoning states nothing
// ---------------------------------------------------------------------------

/**
 * The wire has two carriers for the same facts: a legacy `delta: { text } |
 * { thinking }` object, and the authoritative `assistantMessageEvent`. Nothing
 * promises a frame carries only one of them, and every reader used to answer
 * "is this answer text?" for itself by looking at `delta.text` FIRST.
 *
 * A single frame carrying `delta: { text: <cot> }` beside
 * `assistantMessageEvent: { type: "thinking_delta" }` was therefore published
 * as the child's answer on every surface at once.
 */
const MIXED_CARRIER_FRAME = {
  type: "message_update",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  delta: { text: RAW_COT },
  assistantMessageEvent: {
    type: "thinking_delta",
    contentIndex: 0,
    delta: RAW_COT,
  },
} as const;

describe("Bug A · a mixed-carrier frame reaches no surface at all", () => {
  it("moves nothing on the card, and claims no reasoning either", () => {
    const card = projection();
    card.applySessionEvent(
      parsed({ type: "message_start", message: assistantMessage("") }),
    );
    card.applySessionEvent(
      parsed(update({ type: "text_delta", contentIndex: 1, delta: "real " })),
    );
    const before = card.facts();
    card.applySessionEvent(parsed({ ...MIXED_CARRIER_FRAME }));
    const after = card.facts();

    expect(after.activity).toEqual({ kind: "boot", text: "", live: false });
    expect(after.viewport.rows).toEqual([]);
    expect(after.viewport.rows).toEqual(before.viewport.rows);
    expect(JSON.stringify(after)).not.toContain(RAW_COT);
    expect(cardRows(card).join("\n")).not.toContain(RAW_COT);
  });

  it("reaches no overlay entry, replay step, transcript or compact state", async () => {
    const { controller, component } = open(liveChild());
    (await controller.open(CHILD_ID))._unsafeUnwrap();
    controller
      .applyLiveEvent({
        type: "message_start",
        message: assistantMessage(""),
      })
      ._unsafeUnwrap();
    controller
      .applyLiveEvent(
        update({ type: "text_delta", contentIndex: 1, delta: "real answer" }),
      )
      ._unsafeUnwrap();
    controller.applyLiveEvent({ ...MIXED_CARRIER_FRAME })._unsafeUnwrap();

    const view = currentView(controller);
    expect(JSON.stringify(view.entries)).not.toContain(RAW_COT);
    expect(JSON.stringify(view.transcript)).not.toContain(RAW_COT);
    expect(JSON.stringify(view.compact)).not.toContain(RAW_COT);
    expect(
      JSON.stringify(transcriptFromOverlayEntries(view.entries)),
    ).not.toContain(RAW_COT);
    expect(transcriptRows(component).join("\n")).not.toContain(RAW_COT);
    expect(
      transcriptRows(component).some((row) => row.includes("real answer")),
    ).toBe(true);
  });
});
