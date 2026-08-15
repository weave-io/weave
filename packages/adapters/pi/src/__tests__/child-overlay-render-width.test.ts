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
/** The frame marker the inspector prints for a live child. */
const LIVE_MARKER = "LIVE";

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

/** A title far wider than any tested terminal. */
function crashTitle(): string {
  return "A".repeat(CRASH_HEADER_WIDTH);
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

/** ANSI-free twin of a rendered row, for content assertions. */
function plain(line: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes.
  return line.replace(/\u001B\[[0-9;]*[A-Za-z]|\u001B\][^\u0007]*\u0007/gu, "");
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

describe("child overlay render width", () => {
  it("fits a 115-column title into a 51-column terminal", async () => {
    const title = crashTitle();
    expect(visibleWidth(title)).toBe(CRASH_HEADER_WIDTH);
    const { component } = await mount(title);
    const lines = component.render(CRASH_TERMINAL_WIDTH);
    expect(lines.length).toBeGreaterThan(0);
    assertLinesFit(lines, CRASH_TERMINAL_WIDTH);
    // The identity row names the child; the frame carries the state marker,
    // so a narrow terminal never has to choose between them.
    const identity = contentLines(lines, CRASH_TERMINAL_WIDTH)[0] ?? "";
    expect(identity).toContain("CHILD");
    expect(lines[0]).toContain(LIVE_MARKER);
  });

  it("keeps every line inside widths 1, 2, 10, 20, and 51", async () => {
    const { component } = await mount(crashTitle());
    for (const width of [1, 2, 10, 20, 51] as const) {
      component.invalidate();
      const lines = component.render(width);
      assertLinesFit(lines, width);
    }
  });

  it("keeps every line inside every width from 40 to 200", async () => {
    const { component } = await mount(crashTitle(), 40);
    for (let width = 40; width <= 200; width += 1) {
      component.invalidate();
      const lines = component.render(width);
      assertLinesFit(lines, width);
      expect(lines[0]?.startsWith("╭")).toBe(true);
      expect(lines.at(-1)?.startsWith("╰")).toBe(true);
    }
  });

  it("re-fits after a live shrink and grow", async () => {
    const { component } = await mount(crashTitle(), 40);
    assertLinesFit(component.render(80), 80);
    assertLinesFit(component.render(20), 20);
    const grown = component.render(51);
    assertLinesFit(grown, 51);
    expect(grown[0]).toContain(LIVE_MARKER);
  });

  it("fits ANSI, emoji, CJK, and combining-mark titles", async () => {
    const title = `\x1b[31m${"漢".repeat(40)}${"😀".repeat(20)}e\u0301\x1b[0m`;
    const { component } = await mount(title);
    for (const width of [10, 20, 51] as const) {
      component.invalidate();
      const lines = component.render(width);
      assertLinesFit(lines, width);
    }
    // The state marker rides the frame, so it survives every width whose frame
    // still has room for it beside the title.
    component.invalidate();
    expect(component.render(51)[0]).toContain(LIVE_MARKER);
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

describe("child overlay telemetry placement", () => {
  const usageEvent = (usage: unknown, extra: Record<string, unknown> = {}) => ({
    type: "usage",
    usage,
    ...extra,
  });

  it("reports host usage on the rail and never in the header", async () => {
    const { component, controller } = await mount("telemetry-child");
    controller
      .applyLiveEvent(
        usageEvent(
          {
            input: 12_300,
            output: 4_100,
            context: { tokens: 4_200, contextWindow: 10_000 },
          },
          { model: "openai/gpt-5.6" },
        ),
      )
      ._unsafeUnwrap();
    component.invalidate();
    const lines = component.render(120);
    assertLinesFit(lines, 120);
    const content = contentLines(lines, 120).map(plain);
    expect(content.some((line) => /\bin\b.*12\.3k/u.test(line))).toBe(true);
    expect(content.some((line) => /\bout\b.*4\.1k/u.test(line))).toBe(true);
    // The header is identity only: no token count and no context percentage.
    const header = content[0] ?? "";
    expect(header).not.toContain("12.3k");
    expect(header).not.toContain("ctx");
  });

  it("prints — for unreported spend instead of a fabricated zero", async () => {
    const { component } = await mount("no-telemetry");
    const lines = component.render(120);
    assertLinesFit(lines, 120);
    const joined = contentLines(lines, 120).map(plain).join("\n");
    expect(joined).toContain("—");
    expect(joined).not.toContain("ctx 0%");
    expect(joined).not.toContain("0%");
  });

  it("keeps the rail readable at ~40 columns", async () => {
    const { component, controller } = await mount("narrow-telemetry");
    controller
      .applyLiveEvent(
        usageEvent(
          {
            input: 12_300,
            output: 4_100,
            context: { tokens: 4_200, contextWindow: 10_000 },
          },
          { model: "openai/gpt-5.6" },
        ),
      )
      ._unsafeUnwrap();
    for (const width of [40, 41, 42] as const) {
      component.invalidate();
      const lines = component.render(width);
      assertLinesFit(lines, width);
      const spend = contentLines(lines, width).find((line) =>
        plain(line).trim().startsWith("spend"),
      );
      expect(spend).toBeDefined();
    }
  });
});
