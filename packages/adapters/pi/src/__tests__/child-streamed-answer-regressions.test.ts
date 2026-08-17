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
 * is stripped (`toJsonEvent`). There is no `message` field and no message id.
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
    ...ANSWER_DELTAS.map((delta, index) =>
      update({ type: "text_delta", contentIndex: 1, delta, sequence: index }),
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

describe("Bug A · the delegation card's Native Line carries streamed answer text", () => {
  it("accumulates only text deltas and never relabels them reasoning", () => {
    const card = projection();
    for (const raw of streamingLifecycle()) card.applySessionEvent(parsed(raw));

    const facts = card.facts();
    expect(facts.activity.kind).toBe("say");
    expect(facts.activity.text).toBe(FULL_ANSWER.trim());
    expect(facts.activity.live).toBe(true);
    expect(facts.activity.text).not.toContain("reasoning");
  });

  it("keeps the accumulated answer on the rendered pre-settlement card", () => {
    const card = projection();
    for (const raw of streamingLifecycle()) card.applySessionEvent(parsed(raw));

    const rows = cardRows(card);
    expect(rows.some((row) => row.includes(FULL_ANSWER.trim()))).toBe(true);
    expect(rows.some((row) => row.includes("reasoning"))).toBe(false);
  });

  it("still reports a content-free reasoning fact while only thinking has arrived", () => {
    const card = projection();
    const events = streamingLifecycle().slice(0, 4);
    for (const raw of events) card.applySessionEvent(parsed(raw));

    const facts = card.facts();
    expect(facts.activity.kind).toBe("think");
    expect(facts.activity.text).toBe("reasoning");
  });

  it("reconciles the terminal message onto the same lifecycle without duplication", () => {
    const card = projection();
    for (const raw of streamingLifecycle()) card.applySessionEvent(parsed(raw));
    card.applySessionEvent(parsed(terminalEvent()));

    const facts = card.facts();
    expect(facts.activity.text).toBe(FULL_ANSWER.trim());
    expect(facts.activity.live).toBe(false);
    const messageRows = facts.viewport.rows.filter((row) => row.kind === "msg");
    expect(messageRows).toHaveLength(1);
    expect(messageRows[0]?.text).toBe(FULL_ANSWER.trim());
  });

  it("never prints raw chain-of-thought on any card surface", () => {
    const card = projection();
    for (const raw of streamingLifecycle()) card.applySessionEvent(parsed(raw));
    card.applySessionEvent(parsed(terminalEvent()));

    const serialized = JSON.stringify(card.facts());
    expect(serialized).not.toContain(RAW_COT);
    expect(cardRows(card).join("\n")).not.toContain(RAW_COT);
  });
});

// ---------------------------------------------------------------------------
// 2. The inspector overlay
// ---------------------------------------------------------------------------

function liveChild(streamedAnswer = ""): MemoryOverlaySourceChild {
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
    streamedAnswer,
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

  it("never adopts a snapshot the window already states", async () => {
    // The child finished its message; its answer snapshot still holds the same
    // text. Adopting it would print the same answer twice.
    const { controller } = open(liveChild(FULL_ANSWER));
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

  it("never adopts a settled child's snapshot", async () => {
    const settled = { ...liveChild(FULL_ANSWER), status: "settled" as const };
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
    const { controller } = open(liveChild(FULL_ANSWER));
    (await controller.open(CHILD_ID))._unsafeUnwrap();

    const rows = paneRows(currentView(controller));
    expect(rows.some((row) => row.includes("streaming reply"))).toBe(true);
    expect(rows.some((row) => row.includes("The reporter drops rows"))).toBe(
      true,
    );
    expect(rows.join("\n")).not.toContain(RAW_COT);
  });

  it("does not duplicate the answer when live deltas follow the catch-up seed", async () => {
    const { controller } = open(liveChild(ANSWER_DELTAS[0]));
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
