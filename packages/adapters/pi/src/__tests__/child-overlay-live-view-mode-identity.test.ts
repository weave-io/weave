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
 * One live turn: multi-line reasoning, a tool call, the tool's result merged
 * into that same call entry, and a streamed assistant message.
 *
 * `tool_result` carries the same `toolCallId` as its `tool_call`, so the
 * overlay merges it into the existing entry instead of appending a new one.
 * It repeats `toolName` so the merged entry still names its turn.
 */
function liveTurnEvents(index: number): readonly unknown[] {
  const messageId = `msg-${index}`;
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
      message: { id: messageId, role: "assistant" },
    },
    {
      type: "message_end",
      message: {
        id: messageId,
        role: "assistant",
        content: markedText(index, 12),
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

    // Spot-check the derived ids for the paths the regression named.
    expect(windowIds.has("live-thinking-0")).toBe(true);
    expect(windowIds.has("call-0")).toBe(true);
    expect(windowIds.has("msg-0")).toBe(true);
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

    // A streamed assistant message keeps one identity across start and end.
    controller.applyLiveEvent({
      type: "message_start",
      message: { id: "msg-merge", role: "assistant" },
    });
    controller.applyLiveEvent({
      type: "message_end",
      message: { id: "msg-merge", role: "assistant", content: "done" },
    });
    const afterMessage = controller.view()._unsafeUnwrap();
    expect(
      afterMessage.entries.filter((entry) => entry.id === "msg-merge").length,
    ).toBe(1);
    const assistantTranscript = afterMessage.transcript.entries.filter(
      (entry) => entry.overlayEntryId === "msg-merge",
    );
    expect(assistantTranscript.length).toBeGreaterThan(0);
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
