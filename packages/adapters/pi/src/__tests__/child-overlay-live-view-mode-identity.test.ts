/**
 * Overlay entry identity across view-mode toggles for a *live* child.
 *
 * The settled/historical sibling of this file replays persisted entries, whose
 * transcript is rebuilt through `transcriptFromOverlayEntries` and therefore
 * always carries the overlay entry id. The live path is different: the
 * controller reduces one parser-approved event into the transcript and then
 * projects the window entry. Reducing first left full-layout rows labelled with
 * reducer-owned ids (`thinking-0`, `tool-1`) while the compact layout reported
 * overlay ids (`live-thinking-0`, `call-1`), so a live full <-> compact toggle
 * matched no anchor and moved the reader.
 *
 * These tests drive the real mounted component with real live-event ingestion:
 * real render, real Ctrl+O input path, real controller.
 */

import { describe, expect, it } from "bun:test";
import {
  initTheme,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, TUI } from "@earendil-works/pi-tui";
import {
  createChildOverlayController,
  createChildOverlayCustomComponent,
  createMemoryChildOverlaySource,
  type MemoryOverlaySourceChild,
} from "../child-overlay.js";
import { PI_CHILD_OVERLAY_VIEW_MODE_TRIGGER } from "../child-overlay-keys.js";
import { SCROLL_KEYS } from "../child-overlay-types.js";
import type { PiUiThemePort } from "../types.js";

initTheme("default");

const CHILD_ID = "live-identity-child-1";
const WIDTH = 60;
/** Live children paint extra steering help, so give both layouts scroll room. */
const ROWS = 34;
/** Live turns fed through `applyLiveEvent`; each turn emits several events. */
const TURN_COUNT = 8;

const TEST_THEME: PiUiThemePort = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function testTui(rows = ROWS): TUI & { requestRender(): void } {
  return Object.assign(Object.create(TUI.prototype) as TUI, {
    terminal: { rows },
    requestRender: () => {},
  });
}

function testKeybindings(): KeybindingsManager {
  return getKeybindings() as unknown as KeybindingsManager;
}

/**
 * Text whose every wrapped line still names its turn, so the bottom painted
 * line identifies the bottom turn even when the row's first line is scrolled
 * off the top. The marker leads the string so the width-truncated compact
 * summary keeps it too.
 */
function markedText(index: number, repeats: number): string {
  return Array.from({ length: repeats }, () => `#E${index}#`).join(" ");
}

/**
 * One live turn in the exact shape real Pi 0.84 emits: multi-line reasoning, a
 * tool call, the tool's result merged into that same call entry, and a streamed
 * assistant message whose framing carries **no message id**.
 *
 * Pi 0.84 `message_start` / `message_end` carry the pi-ai `AssistantMessage`
 * directly (`{ role, model, content: Block[], usage? }`), and that type has no
 * `id`. Lifecycle identity therefore comes only from the controller-allocated
 * overlay entry id.
 *
 * `tool_result` carries the same `toolCallId` as its `tool_call`, so the
 * overlay merges it into the existing entry instead of appending a new one.
 * It repeats `toolName` so the merged entry still names its turn.
 */
function liveTurnEvents(index: number): readonly unknown[] {
  const toolCallId = `call-${index}`;
  return [
    { type: "thinking", text: markedText(index, 8) },
    {
      type: "tool_call",
      toolCallId,
      toolName: `read#E${index}#`,
      arguments: { target: markedText(index, 3) },
    },
    {
      type: "tool_result",
      toolCallId,
      toolName: `read#E${index}#`,
      result: { content: markedText(index, 3), isError: false },
    },
    {
      type: "message_start",
      message: { role: "assistant", model: "test-model", content: [] },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        model: "test-model",
        content: [{ type: "text", text: markedText(index, 12) }],
        usage: { input: 10, output: 20 },
      },
    },
  ];
}

function liveChild(): MemoryOverlaySourceChild {
  return {
    childId: CHILD_ID,
    threadId: CHILD_ID,
    status: "live",
    title: "live-identity-child",
    generationId: "generation-1",
    parentChildId: undefined,
    runs: [{ run: 1, action: "start" }],
    branchIds: ["main"],
    descendantChildIds: [],
    // No persisted history: every entry below comes from live ingestion.
    entries: [],
  };
}

interface MountedOverlay {
  readonly component: {
    render(width: number): string[];
    handleInput(data: string): void;
  };
  readonly controller: ReturnType<typeof createChildOverlayController>;
}

async function mount(turns = TURN_COUNT): Promise<MountedOverlay> {
  const source = createMemoryChildOverlaySource([liveChild()]);
  const controller = createChildOverlayController(source, { pageSize: 64 });
  const opened = await controller.open(CHILD_ID);
  expect(opened.isOk()).toBe(true);
  const component = createChildOverlayCustomComponent(
    testTui(),
    TEST_THEME,
    testKeybindings(),
    controller,
    () => {},
    () => {},
    { cwd: "/workspace" },
  );
  for (let index = 0; index < turns; index += 1) {
    for (const event of liveTurnEvents(index)) {
      const applied = controller.applyLiveEvent(event);
      expect(applied.isOk()).toBe(true);
    }
  }
  // First paint measures the layout and hands spans to the controller.
  component.render(WIDTH);
  return { component, controller };
}

/** Send a key through the real component input path and repaint. */
async function press(mounted: MountedOverlay, data: string): Promise<void> {
  mounted.component.handleInput(data);
  await new Promise((resolve) => setTimeout(resolve, 0));
  mounted.component.render(WIDTH);
}

const MARKER = /#E(\d+)#/g;

/** Index of the turn that owns the last painted line. */
function bottomTurnIndex(lines: readonly string[]): number {
  let last: number | undefined;
  for (const line of lines) {
    for (const match of line.matchAll(MARKER)) {
      const value = Number.parseInt(match[1] ?? "", 10);
      if (Number.isFinite(value)) last = value;
    }
  }
  expect(last).toBeDefined();
  return last as number;
}

interface Observation {
  readonly viewMode: string;
  readonly bottomTurn: number;
  readonly scrollOffset: number;
  readonly anchorEntryId: string | undefined;
}

function observe(mounted: MountedOverlay): Observation {
  const lines = mounted.component.render(WIDTH);
  const view = mounted.controller.view()._unsafeUnwrap();
  return {
    viewMode: view.viewMode,
    bottomTurn: bottomTurnIndex(lines),
    scrollOffset: view.scrollOffset,
    anchorEntryId: view.anchor?.entryId,
  };
}

describe("mounted live-child overlay identity across view modes", () => {
  it("labels live transcript entries with the overlay entry ids the window holds", async () => {
    const mounted = await mount();
    const view = mounted.controller.view()._unsafeUnwrap();

    const windowIds = new Set(view.entries.map((entry) => entry.id));
    expect(windowIds.size).toBeGreaterThan(0);
    // Live ingestion must not leave transcript entries in the reducer's own
    // identity space; every one of them names the overlay entry it belongs to.
    for (const entry of view.transcript.entries) {
      expect(entry.overlayEntryId).toBeDefined();
      expect(windowIds.has(entry.overlayEntryId as string)).toBe(true);
    }

    // Spot-check the derived ids for the paths the regression named. Assistant
    // identity is the controller-allocated lifecycle id: Pi 0.84 sends no
    // message id at all, and the first turn's lifecycle is slot 0.
    expect(windowIds.has("live-thinking-0")).toBe(true);
    expect(windowIds.has("call-0")).toBe(true);
    expect(windowIds.has("live-assistant-0")).toBe(true);

    // One overlay entry per assistant lifecycle, and one lifecycle per turn.
    const assistantIds = view.entries
      .filter((entry) => entry.kind === "assistant")
      .map((entry) => entry.id);
    expect(assistantIds.length).toBe(TURN_COUNT);
    expect(new Set(assistantIds).size).toBe(TURN_COUNT);
    expect(assistantIds).toEqual(
      Array.from({ length: TURN_COUNT }, (_, i) => `live-assistant-${i}`),
    );
  });

  it("keeps a merged tool result under the entry identity its call created", async () => {
    const source = createMemoryChildOverlaySource([liveChild()]);
    const controller = createChildOverlayController(source, { pageSize: 64 });
    expect((await controller.open(CHILD_ID)).isOk()).toBe(true);

    controller.applyLiveEvent({
      type: "tool_call",
      toolCallId: "call-merge",
      toolName: "read",
      arguments: { target: "a" },
    });
    const afterCall = controller.view()._unsafeUnwrap();
    const callEntries = afterCall.entries.filter(
      (entry) => entry.id === "call-merge",
    );
    expect(callEntries.length).toBe(1);
    const transcriptAfterCall = afterCall.transcript.entries.map((entry) => ({
      id: entry.id,
      overlayEntryId: entry.overlayEntryId,
    }));
    expect(transcriptAfterCall.length).toBeGreaterThan(0);
    for (const entry of transcriptAfterCall) {
      expect(entry.overlayEntryId).toBe("call-merge");
    }

    controller.applyLiveEvent({
      type: "tool_result",
      toolCallId: "call-merge",
      toolName: "read",
      result: { content: "b", isError: false },
    });
    const afterResult = controller.view()._unsafeUnwrap();
    // The update merges: no second window entry, and the transcript entries
    // the call created keep the identity they already had.
    expect(
      afterResult.entries.filter((entry) => entry.id === "call-merge").length,
    ).toBe(1);
    for (const before of transcriptAfterCall) {
      const after = afterResult.transcript.entries.find(
        (entry) => entry.id === before.id,
      );
      expect(after?.overlayEntryId).toBe(before.overlayEntryId);
    }
    for (const entry of afterResult.transcript.entries) {
      expect(entry.overlayEntryId).toBe("call-merge");
    }

    // A streamed assistant message keeps one identity across start and end,
    // with the real Pi 0.84 framing that carries no message id.
    controller.applyLiveEvent({
      type: "message_start",
      message: { role: "assistant", model: "test-model", content: [] },
    });
    controller.applyLiveEvent({
      type: "message_end",
      message: {
        role: "assistant",
        model: "test-model",
        content: [{ type: "text", text: "done" }],
      },
    });
    const afterMessage = controller.view()._unsafeUnwrap();
    expect(
      afterMessage.entries.filter((entry) => entry.kind === "assistant").length,
    ).toBe(1);
    expect(
      afterMessage.entries.filter((entry) => entry.id === "live-assistant-0")
        .length,
    ).toBe(1);
    const assistantTranscript = afterMessage.transcript.entries.filter(
      (entry) => entry.overlayEntryId === "live-assistant-0",
    );
    expect(assistantTranscript.length).toBeGreaterThan(0);
    // Both lifecycle terminals reduced under one overlay identity.
    expect(
      new Set(assistantTranscript.map((entry) => entry.overlayEntryId)).size,
    ).toBe(1);
  });

  it("keeps the same bottom turn through full → compact → full while live", async () => {
    const mounted = await mount();

    // Scroll away from the tail through the real component input path.
    await press(mounted, SCROLL_KEYS.pageUp);
    await press(mounted, SCROLL_KEYS.pageUp);

    const full = observe(mounted);
    expect(full.viewMode).toBe("full");
    expect(full.scrollOffset).toBeGreaterThan(0);
    // Mid-window: far enough from both ends that neither layout has to clamp.
    expect(full.bottomTurn).toBeGreaterThan(0);
    expect(full.bottomTurn).toBeLessThan(TURN_COUNT - 1);
    expect(full.anchorEntryId).toBeDefined();

    await press(mounted, PI_CHILD_OVERLAY_VIEW_MODE_TRIGGER);
    const compact = observe(mounted);
    expect(compact.viewMode).toBe("compact");
    // The live regression: full-layout spans reported reducer-owned ids the
    // compact layout never uses, so the anchor matched nothing and the
    // viewport silently clamped toward the tail.
    expect(compact.bottomTurn).toBe(full.bottomTurn);
    expect(compact.scrollOffset).toBeGreaterThan(0);

    await press(mounted, PI_CHILD_OVERLAY_VIEW_MODE_TRIGGER);
    const back = observe(mounted);
    expect(back.viewMode).toBe("full");
    expect(back.bottomTurn).toBe(full.bottomTurn);
    expect(back.scrollOffset).toBeGreaterThan(0);
  });

  it("holds the bottom turn across repeated live toggles", async () => {
    const mounted = await mount();
    await press(mounted, SCROLL_KEYS.pageUp);
    await press(mounted, SCROLL_KEYS.pageUp);

    const start = observe(mounted);
    expect(start.bottomTurn).toBeGreaterThan(0);

    for (let round = 0; round < 3; round += 1) {
      await press(mounted, PI_CHILD_OVERLAY_VIEW_MODE_TRIGGER);
      expect(observe(mounted).bottomTurn).toBe(start.bottomTurn);
      await press(mounted, PI_CHILD_OVERLAY_VIEW_MODE_TRIGGER);
      expect(observe(mounted).bottomTurn).toBe(start.bottomTurn);
    }
  });

  it("keeps following the live tail across a toggle", async () => {
    const mounted = await mount();
    const before = observe(mounted);
    expect(before.scrollOffset).toBe(0);
    expect(before.bottomTurn).toBe(TURN_COUNT - 1);

    await press(mounted, PI_CHILD_OVERLAY_VIEW_MODE_TRIGGER);
    const compact = observe(mounted);
    expect(compact.viewMode).toBe("compact");
    expect(compact.scrollOffset).toBe(0);
    expect(compact.bottomTurn).toBe(TURN_COUNT - 1);

    await press(mounted, PI_CHILD_OVERLAY_VIEW_MODE_TRIGGER);
    const back = observe(mounted);
    expect(back.viewMode).toBe("full");
    expect(back.scrollOffset).toBe(0);
    expect(back.bottomTurn).toBe(TURN_COUNT - 1);
  });
});

/**
 * Real Pi 0.84 assistant lifecycle identity, with the exact event shapes the
 * host emits: `message_start` / `message_end` carry the pi-ai
 * `AssistantMessage` (`{ role, model, content: Block[] }`) and nothing carries a
 * message id. Identity is the overlay id the controller allocates at
 * `message_start` and reuses until the lifecycle ends.
 */
describe("real Pi 0.84 assistant lifecycle identity", () => {
  const startEvent = {
    type: "message_start",
    message: { role: "assistant", model: "test-model", content: [] },
  } as const;

  const endEvent = (text: string) =>
    ({
      type: "message_end",
      message: {
        role: "assistant",
        model: "test-model",
        content: [{ type: "text", text }],
        usage: { input: 12, output: 34 },
      },
    }) as const;

  async function openLive(childId = CHILD_ID) {
    const source = createMemoryChildOverlaySource([
      { ...liveChild(), childId, threadId: childId },
    ]);
    const controller = createChildOverlayController(source, { pageSize: 64 });
    expect((await controller.open(childId)).isOk()).toBe(true);
    return controller;
  }

  it("keeps one assistant entry when tool and thinking entries interleave", async () => {
    const controller = await openLive();
    const events: readonly unknown[] = [
      startEvent,
      { type: "thinking", text: "weighing options" },
      { type: "tool_call", toolCallId: "call-x", toolName: "read" },
      {
        type: "tool_result",
        toolCallId: "call-x",
        toolName: "read",
        result: { content: [{ type: "text", text: "file body" }] },
      },
      endEvent("final answer"),
    ];
    for (const event of events) {
      expect(controller.applyLiveEvent(event).isOk()).toBe(true);
    }

    const view = controller.view()._unsafeUnwrap();
    const assistant = view.entries.filter(
      (entry) => entry.kind === "assistant",
    );
    // Exactly one assistant entry, though start and end were separated by two
    // appended entries: the length-derived id would have differed by two.
    expect(assistant.length).toBe(1);
    expect(assistant[0]?.id).toBe("live-assistant-0");
    expect(assistant[0]?.text).toBe("final answer");
    // Ordering is preserved: thinking and the tool sit between nothing; the
    // assistant entry was created at `message_start`, so it precedes neither.
    expect(view.entries.map((entry) => entry.id)).toEqual([
      "live-assistant-0",
      "live-thinking-1",
      "call-x",
    ]);
    // Both lifecycle terminals reduced under the one overlay identity.
    const assistantRows = view.transcript.entries.filter(
      (entry) => entry.kind === "assistant",
    );
    expect(assistantRows.length).toBeGreaterThan(0);
    for (const row of assistantRows) {
      expect(row.overlayEntryId).toBe("live-assistant-0");
    }
    // Real usage from the terminal message reaches telemetry.
    expect(view.telemetry?.inputTokens).toBe(12);
    expect(view.telemetry?.outputTokens).toBe(34);
  });

  it("allocates a fresh identity per lifecycle and never reuses a closed one", async () => {
    const controller = await openLive();
    for (const event of [startEvent, endEvent("first")]) {
      expect(controller.applyLiveEvent(event).isOk()).toBe(true);
    }
    for (const event of [startEvent, endEvent("second")]) {
      expect(controller.applyLiveEvent(event).isOk()).toBe(true);
    }
    const view = controller.view()._unsafeUnwrap();
    const assistant = view.entries.filter(
      (entry) => entry.kind === "assistant",
    );
    expect(assistant.map((entry) => entry.id)).toEqual([
      "live-assistant-0",
      "live-assistant-1",
    ]);
    expect(assistant.map((entry) => entry.text)).toEqual(["first", "second"]);
  });

  it("handles an update/end lifecycle whose start never arrived", async () => {
    const controller = await openLive();
    // Truncated or historical stream: the first event seen is an update.
    expect(
      controller
        .applyLiveEvent({
          type: "message_update",
          delta: { text: "partial " },
        })
        .isOk(),
    ).toBe(true);
    expect(
      controller
        .applyLiveEvent({
          type: "message_update",
          delta: { text: "more" },
        })
        .isOk(),
    ).toBe(true);
    expect(controller.applyLiveEvent(endEvent("recovered")).isOk()).toBe(true);

    const view = controller.view()._unsafeUnwrap();
    const assistant = view.entries.filter(
      (entry) => entry.kind === "assistant",
    );
    // One entry allocated on first sight, reused by the later update and end.
    expect(assistant.length).toBe(1);
    expect(assistant[0]?.id).toBe("live-assistant-0");
    expect(assistant[0]?.text).toBe("recovered");

    // The lifecycle closed, so the next start allocates the next slot.
    expect(controller.applyLiveEvent(startEvent).isOk()).toBe(true);
    expect(controller.applyLiveEvent(endEvent("next")).isOk()).toBe(true);
    const after = controller.view()._unsafeUnwrap();
    expect(
      after.entries
        .filter((entry) => entry.kind === "assistant")
        .map((entry) => entry.id),
    ).toEqual(["live-assistant-0", "live-assistant-1"]);
  });

  it("does not grow without bound when ends arrive with no starts at all", async () => {
    const controller = await openLive();
    for (let index = 0; index < 40; index += 1) {
      expect(controller.applyLiveEvent(endEvent(`end-${index}`)).isOk()).toBe(
        true,
      );
    }
    const view = controller.view()._unsafeUnwrap();
    const assistant = view.entries.filter(
      (entry) => entry.kind === "assistant",
    );
    // Each bare end is its own closed lifecycle: one entry each, ids in order,
    // and nothing accumulates outside the bounded window.
    expect(assistant.length).toBe(40);
    expect(assistant[0]?.id).toBe("live-assistant-0");
    expect(assistant[39]?.id).toBe("live-assistant-39");
    expect(new Set(assistant.map((entry) => entry.id)).size).toBe(40);
  });

  it("isolates in-flight lifecycles between two interleaved children", async () => {
    const source = createMemoryChildOverlaySource([
      { ...liveChild(), childId: "live-a", threadId: "live-a" },
      { ...liveChild(), childId: "live-b", threadId: "live-b" },
    ]);
    const controller = createChildOverlayController(source, { pageSize: 64 });

    expect((await controller.open("live-a")).isOk()).toBe(true);
    expect(controller.applyLiveEvent(startEvent).isOk()).toBe(true);

    // Focus moves to B while A's lifecycle is still open.
    expect((await controller.open("live-b")).isOk()).toBe(true);
    expect(controller.applyLiveEvent(startEvent).isOk()).toBe(true);
    expect(controller.applyLiveEvent(endEvent("b done")).isOk()).toBe(true);
    const viewB = controller.view()._unsafeUnwrap();
    const assistantB = viewB.entries.filter(
      (entry) => entry.kind === "assistant",
    );
    expect(assistantB.length).toBe(1);
    expect(assistantB[0]?.id).toBe("live-assistant-0");
    expect(assistantB[0]?.text).toBe("b done");

    // Back to A: its own open lifecycle is still the one the end belongs to.
    expect((await controller.open("live-a")).isOk()).toBe(true);
    expect(controller.applyLiveEvent(endEvent("a done")).isOk()).toBe(true);
    const viewA = controller.view()._unsafeUnwrap();
    const assistantA = viewA.entries.filter(
      (entry) => entry.kind === "assistant",
    );
    expect(assistantA.length).toBe(1);
    expect(assistantA[0]?.id).toBe("live-assistant-0");
    expect(assistantA[0]?.text).toBe("a done");
  });

  it("resets lifecycle state on controller teardown", async () => {
    const first = await openLive();
    expect(first.applyLiveEvent(startEvent).isOk()).toBe(true);
    expect(first.applyLiveEvent(endEvent("first")).isOk()).toBe(true);
    expect(first.applyLiveEvent(startEvent).isOk()).toBe(true);

    // A new controller is the teardown boundary: nothing survives it.
    const second = await openLive();
    expect(second.applyLiveEvent(startEvent).isOk()).toBe(true);
    expect(second.applyLiveEvent(endEvent("fresh")).isOk()).toBe(true);
    const view = second.view()._unsafeUnwrap();
    const assistant = view.entries.filter(
      (entry) => entry.kind === "assistant",
    );
    expect(assistant.length).toBe(1);
    expect(assistant[0]?.id).toBe("live-assistant-0");
  });
});

/**
 * The mounted full <-> compact proof for a real Pi 0.84 lifecycle: one compact
 * assistant row, the same span identity in both layouts, and a viewport that
 * does not move across a round trip.
 */
describe("mounted real Pi 0.84 lifecycle across view modes", () => {
  it("shares span identity and holds the viewport through full → compact → full", async () => {
    const mounted = await mount();

    await press(mounted, SCROLL_KEYS.pageUp);
    await press(mounted, SCROLL_KEYS.pageUp);

    const full = observe(mounted);
    expect(full.viewMode).toBe("full");
    expect(full.scrollOffset).toBeGreaterThan(0);
    expect(full.anchorEntryId).toBeDefined();

    // The full-layout anchor is an id the compact layout also holds: compact
    // spans come from the same overlay entries.
    const view = mounted.controller.view()._unsafeUnwrap();
    const overlayIds = new Set(view.entries.map((entry) => entry.id));
    expect(overlayIds.has(full.anchorEntryId as string)).toBe(true);

    // One compact row per assistant lifecycle, under the allocated id.
    const assistantIds = view.entries
      .filter((entry) => entry.kind === "assistant")
      .map((entry) => entry.id);
    expect(assistantIds).toEqual(
      Array.from({ length: TURN_COUNT }, (_, i) => `live-assistant-${i}`),
    );

    await press(mounted, PI_CHILD_OVERLAY_VIEW_MODE_TRIGGER);
    const compact = observe(mounted);
    expect(compact.viewMode).toBe("compact");
    expect(compact.bottomTurn).toBe(full.bottomTurn);
    expect(compact.anchorEntryId).toBeDefined();
    expect(overlayIds.has(compact.anchorEntryId as string)).toBe(true);

    await press(mounted, PI_CHILD_OVERLAY_VIEW_MODE_TRIGGER);
    const back = observe(mounted);
    expect(back.viewMode).toBe("full");
    expect(back.bottomTurn).toBe(full.bottomTurn);
    expect(back.scrollOffset).toBeGreaterThan(0);
  });
});
