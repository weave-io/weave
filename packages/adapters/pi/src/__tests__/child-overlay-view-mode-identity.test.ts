/**
 * Overlay entry identity across view-mode toggles, in the mounted component.
 *
 * The compact layout paints one row per {@link ChildOverlayEntry} and reports
 * spans keyed by the overlay entry id. The full layout paints native transcript
 * rows, and one overlay entry can fan out into several transcript entries (an
 * assistant message plus its tool calls), each with its own renderer-owned id.
 * When the two layouts report spans in different identity spaces, the anchor
 * captured before a toggle matches nothing in the target layout, the controller
 * clamps instead of placing it, and the reader is moved to unrelated content
 * (the observed bottom entry jumped 28 → 23 on Ctrl+O).
 *
 * These tests drive the real mounted component: real render, real Ctrl+O input
 * path, real controller. The assertions read the bottom entry out of the
 * painted rows, so they measure what a reader actually sees rather than
 * internal bookkeeping.
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
  type MemoryOverlaySourceEntry,
} from "../child-overlay.js";
import { PI_CHILD_OVERLAY_VIEW_MODE_TRIGGER } from "../child-overlay-keys.js";
import { SCROLL_KEYS } from "../child-overlay-types.js";
import type { PiUiThemePort } from "../types.js";

initTheme("default");

const CHILD_ID = "identity-child-1";
const WIDTH = 60;
/**
 * Short terminal: both layouts keep real scroll room at this height.
 *
 * The inspector's header, folded rail and prompt reserve their rows before the
 * transcript, so this is the shortest height that still leaves a transcript
 * window worth comparing across a layout toggle.
 */
const ROWS = 28;
const ENTRY_COUNT = 30;

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
 * Text whose every wrapped line still names its entry, so the bottom painted
 * line identifies the bottom entry even when the row's first line is scrolled
 * off the top.
 */
function markedText(index: number, repeats: number): string {
  return Array.from({ length: repeats }, () => `#E${index}#`).join(" ");
}

/**
 * Assistant message with reasoning and a tool call.
 *
 * The tool call is what makes the full layout emit rows under a second,
 * renderer-owned transcript entry id, which is exactly the case the compact
 * layout cannot see.
 */
function assistantPayload(id: string, index: number): unknown {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: markedText(index, 8) },
        {
          type: "toolCall",
          id: `call-${index}`,
          // Unknown tool name: the native tool component then paints the
          // bounded arguments, so every tool row also names its entry.
          name: `read#E${index}#`,
          arguments: { target: markedText(index, 4) },
        },
        { type: "text", text: markedText(index, 16) },
      ],
    },
  };
}

function userPayload(id: string, index: number): unknown {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: markedText(index, 12) },
  };
}

function sourceEntries(count: number): MemoryOverlaySourceEntry[] {
  const result: MemoryOverlaySourceEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `e${index}`;
    result.push({
      id,
      payload:
        index % 2 === 0 ? userPayload(id, index) : assistantPayload(id, index),
    });
  }
  return result;
}

function child(entryCount: number): MemoryOverlaySourceChild {
  return {
    childId: CHILD_ID,
    threadId: CHILD_ID,
    status: "settled",
    title: "identity-child",
    generationId: undefined,
    parentChildId: undefined,
    runs: [{ run: 1, action: "start" }],
    branchIds: ["main"],
    descendantChildIds: [],
    entries: sourceEntries(entryCount),
  };
}

interface MountedOverlay {
  readonly component: {
    render(width: number): string[];
    handleInput(data: string): void;
  };
  readonly controller: ReturnType<typeof createChildOverlayController>;
}

async function mount(entryCount = ENTRY_COUNT): Promise<MountedOverlay> {
  const source = createMemoryChildOverlaySource([child(entryCount)]);
  const controller = createChildOverlayController(source, {
    pageSize: entryCount,
  });
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

/** Index of the entry that owns the last painted transcript line. */
function bottomEntryIndex(lines: readonly string[]): number {
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
  readonly bottomEntry: number;
  readonly scrollOffset: number;
  readonly anchorLineOffset: number | undefined;
}

function observe(mounted: MountedOverlay): Observation {
  const lines = mounted.component.render(WIDTH);
  const view = mounted.controller.view()._unsafeUnwrap() as unknown as {
    viewMode: string;
    scrollOffset: number;
    anchor?: { entryId: string; lineOffset: number };
  };
  return {
    viewMode: view.viewMode,
    bottomEntry: bottomEntryIndex(lines),
    scrollOffset: view.scrollOffset,
    anchorLineOffset: view.anchor?.lineOffset,
  };
}

describe("mounted overlay entry identity across view modes", () => {
  it("keeps the same bottom entry through full → compact → full", async () => {
    const mounted = await mount();

    // Scroll away from the tail through the real component input path.
    await press(mounted, SCROLL_KEYS.pageUp);
    await press(mounted, SCROLL_KEYS.pageUp);

    const full = observe(mounted);
    expect(full.viewMode).toBe("full");
    expect(full.scrollOffset).toBeGreaterThan(0);
    // Mid-window: far enough from both ends that neither layout has to clamp.
    expect(full.bottomEntry).toBeGreaterThan(0);
    expect(full.bottomEntry).toBeLessThan(ENTRY_COUNT - 1);

    await press(mounted, PI_CHILD_OVERLAY_VIEW_MODE_TRIGGER);
    const compact = observe(mounted);
    expect(compact.viewMode).toBe("compact");
    // The 28 → 23 regression: full-layout spans reported renderer-owned ids the
    // compact layout never uses, the anchor matched nothing, and the viewport
    // silently clamped toward the tail.
    expect(compact.bottomEntry).toBe(full.bottomEntry);
    expect(compact.scrollOffset).toBeGreaterThan(0);
    // Compact paints one row per entry, so row 0 is the only representable
    // intra-entry row and it must be exactly that, not a stale full-layout row.
    expect(compact.anchorLineOffset).toBe(0);

    await press(mounted, PI_CHILD_OVERLAY_VIEW_MODE_TRIGGER);
    const back = observe(mounted);
    expect(back.viewMode).toBe("full");
    expect(back.bottomEntry).toBe(full.bottomEntry);
    expect(back.scrollOffset).toBeGreaterThan(0);
    expect(back.anchorLineOffset).toBeGreaterThanOrEqual(0);
  });

  it("holds the bottom entry across repeated toggles", async () => {
    const mounted = await mount();
    await press(mounted, SCROLL_KEYS.pageUp);
    await press(mounted, SCROLL_KEYS.pageUp);
    await press(mounted, SCROLL_KEYS.shiftUp);

    const start = observe(mounted);
    expect(start.bottomEntry).toBeGreaterThan(0);

    for (let round = 0; round < 3; round += 1) {
      await press(mounted, PI_CHILD_OVERLAY_VIEW_MODE_TRIGGER);
      expect(observe(mounted).bottomEntry).toBe(start.bottomEntry);
      await press(mounted, PI_CHILD_OVERLAY_VIEW_MODE_TRIGGER);
      expect(observe(mounted).bottomEntry).toBe(start.bottomEntry);
    }
  });

  it("keeps following the tail across a toggle when the viewport is live", async () => {
    const mounted = await mount();
    const before = observe(mounted);
    expect(before.scrollOffset).toBe(0);
    expect(before.bottomEntry).toBe(ENTRY_COUNT - 1);

    await press(mounted, PI_CHILD_OVERLAY_VIEW_MODE_TRIGGER);
    const compact = observe(mounted);
    expect(compact.viewMode).toBe("compact");
    expect(compact.scrollOffset).toBe(0);
    expect(compact.bottomEntry).toBe(ENTRY_COUNT - 1);

    await press(mounted, PI_CHILD_OVERLAY_VIEW_MODE_TRIGGER);
    const back = observe(mounted);
    expect(back.viewMode).toBe("full");
    expect(back.scrollOffset).toBe(0);
    expect(back.bottomEntry).toBe(ENTRY_COUNT - 1);
  });
});
