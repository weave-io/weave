import { describe, expect, it } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import {
  createChildOverlayController,
  createChildOverlayCustomComponent,
  createMemoryChildOverlaySource,
  type MemoryOverlaySourceChild,
  type MemoryOverlaySourceEntry,
} from "../child-overlay.js";
import { overlayFrameGeometry } from "../render-width.js";

/** Pi native components read the process-wide theme. */
initTheme("default");

const CRASH_HEADER_WIDTH = 115;
const CRASH_TERMINAL_WIDTH = 51;
const LIVE_SUFFIX = " · LIVE";

function message(
  id: string,
  role: "user" | "assistant",
  content: string,
): unknown {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role, content },
  };
}

function entries(count: number, prefix = "e"): MemoryOverlaySourceEntry[] {
  const result: MemoryOverlaySourceEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `${prefix}${i}`;
    result.push({
      id,
      payload: message(
        id,
        i % 2 === 0 ? "user" : "assistant",
        `${prefix}-text-${i}`,
      ),
    });
  }
  return result;
}

function child(
  partial: Partial<MemoryOverlaySourceChild> &
    Pick<MemoryOverlaySourceChild, "childId" | "entries">,
): MemoryOverlaySourceChild {
  return {
    threadId: partial.threadId ?? partial.childId,
    status: partial.status ?? "live",
    title: partial.title,
    generationId: partial.generationId,
    parentChildId: partial.parentChildId,
    runs: partial.runs ?? [{ run: 1, action: "start" }],
    branchIds: partial.branchIds ?? ["main"],
    descendantChildIds: partial.descendantChildIds ?? [],
    childId: partial.childId,
    entries: partial.entries,
  };
}

/** Title that makes `◆ <title> · LIVE` exactly 115 visible columns. */
function crashTitle(): string {
  const prefix = "◆ ";
  const suffix = LIVE_SUFFIX;
  return "A".repeat(
    CRASH_HEADER_WIDTH - visibleWidth(prefix) - visibleWidth(suffix),
  );
}

async function mount(title: string, entryCount = 8) {
  const source = createMemoryChildOverlaySource([
    child({
      childId: "overlay-width-1",
      status: "live",
      title,
      generationId: "gen-1",
      entries: entries(entryCount),
    }),
  ]);
  const controller = createChildOverlayController(source, { pageSize: 10 });
  const opened = await controller.open("overlay-width-1");
  expect(opened.isOk()).toBe(true);
  const component = createChildOverlayCustomComponent(
    { requestRender: () => {} } as never,
    {} as never,
    getKeybindings() as never,
    controller,
    () => {},
    () => {},
    { cwd: "/workspace" },
  );
  return { component, controller };
}

function assertLinesFit(lines: readonly string[], width: number): void {
  for (const line of lines) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(
      Number.isFinite(width) && width > 0 ? Math.floor(width) : 0,
    );
  }
}

/**
 * Strips the overlay frame so content assertions read the component's own
 * rows. The frame is an overlay affordance, not content, and every assertion
 * below is about what the reader sees inside it.
 */
function contentLines(lines: readonly string[], outerWidth: number): string[] {
  const geometry = overlayFrameGeometry(outerWidth);
  if (!geometry.bordered) return [...lines];
  return lines
    .slice(1, -1)
    .map((line) => line.slice(1, -1).replace(/ +$/u, ""));
}

describe("child overlay render width (Task 20(f))", () => {
  it("keeps · LIVE when the 115-column header is rendered at width 51", async () => {
    const title = crashTitle();
    expect(visibleWidth(`◆ ${title}${LIVE_SUFFIX}`)).toBe(CRASH_HEADER_WIDTH);
    const { component } = await mount(title);
    const lines = component.render(CRASH_TERMINAL_WIDTH);
    expect(lines.length).toBeGreaterThan(0);
    assertLinesFit(lines, CRASH_TERMINAL_WIDTH);
    const header = contentLines(lines, CRASH_TERMINAL_WIDTH)[0] ?? "";
    expect(header.endsWith(LIVE_SUFFIX)).toBe(true);
    expect(header.startsWith("◆")).toBe(true);
    expect(visibleWidth(header)).toBeLessThanOrEqual(CRASH_TERMINAL_WIDTH);
  });

  it("keeps every line inside widths 1, 2, 10, 20, and 51", async () => {
    const { component } = await mount(crashTitle());
    for (const width of [1, 2, 10, 20, 51] as const) {
      const lines = component.render(width);
      assertLinesFit(lines, width);
    }
  });

  it("re-fits after a live shrink and grow", async () => {
    const { component } = await mount(crashTitle(), 40);
    assertLinesFit(component.render(80), 80);
    assertLinesFit(component.render(20), 20);
    const grown = component.render(51);
    assertLinesFit(grown, 51);
    expect((contentLines(grown, 51)[0] ?? "").endsWith(LIVE_SUFFIX)).toBe(true);
  });

  it("fits ANSI, emoji, CJK, and combining-mark titles", async () => {
    const title = `\x1b[31m${"漢".repeat(40)}${"😀".repeat(20)}e\u0301\x1b[0m`;
    const { component } = await mount(title);
    for (const width of [10, 20, 51] as const) {
      const lines = component.render(width);
      assertLinesFit(lines, width);
    }
    // The status suffix is reserved only while the framed inner width can
    // still carry a title beside it. At width 10 the frame leaves 8 columns
    // and ` · LIVE` alone costs 7, so a bare status is correctly dropped in
    // favor of naming the child.
    for (const width of [20, 51] as const) {
      const lines = component.render(width);
      expect((contentLines(lines, width)[0] ?? "").endsWith(LIVE_SUFFIX)).toBe(
        true,
      );
    }
  });

  it("clamps an over-wide draft editor fallback line", async () => {
    const { component, controller } = await mount("short-title");
    controller.updateDraft(`d`.repeat(240))._unsafeUnwrap();
    // Force a re-render that syncs the draft into the editor path.
    const lines = component.render(20);
    assertLinesFit(lines, 20);
    expect(lines.some((line) => line.includes("d") || line.includes("…"))).toBe(
      true,
    );
  });

  it("returns only empty lines for non-positive or non-finite widths", async () => {
    const { component } = await mount(crashTitle());
    // Prime a cached frame so the early-return paths still have content.
    component.render(51);
    for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const lines = component.render(width);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).toBe("");
      }
    }
  });
});
