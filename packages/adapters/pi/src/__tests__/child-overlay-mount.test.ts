/**
 * Overlay mount, framing, and editor-identity regressions.
 *
 * Three separate mistakes are guarded here, each of which has a silent
 * failure mode:
 *
 * 1. Mounting without `{ overlay: true }` looks fine in a unit test but tears
 *    down the conversation view and the primary editor at runtime.
 * 2. A border drawn without reserving its columns is exactly how an over-wide
 *    line reaches Pi, and an over-wide line aborts the process.
 * 3. Swapping the steering field to a `pi-tui` `Input` still renders, but
 *    loses multi-line follow-ups and app keybindings.
 */

import { describe, expect, it } from "bun:test";
import {
  CustomEditor,
  initTheme,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  Editor,
  getKeybindings,
  Input,
  TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  createChildOverlayController,
  createChildOverlayCustomComponent,
  createChildOverlayDraftEditor,
  createMemoryChildOverlaySource,
  type MemoryOverlaySourceChild,
  type MemoryOverlaySourceEntry,
  PI_CHILD_OVERLAY_CUSTOM_OPTIONS,
} from "../child-overlay.js";
import {
  formatChildOverlayTelemetryLine,
  overlayUsableRows,
} from "../child-overlay-component.js";
import {
  FRAME_EDGE_ROWS,
  frameLinesToWidth,
  overlayFrameGeometry,
} from "../render-width.js";
import type { PiUiThemePort } from "../types.js";

/** Pi native components read the process-wide theme. */
initTheme("default");

const CHILD_ID = "overlay-mount-1";
const EDITOR_BORDER_START = "\x1b[35m";
const EDITOR_BORDER_END = "\x1b[39m";
const TEST_THEME: PiUiThemePort = {
  fg: (color, text) =>
    color === "border"
      ? `${EDITOR_BORDER_START}${text}${EDITOR_BORDER_END}`
      : text,
  bold: (text) => text,
};

function testTui(rows = 40): TUI & { requestRender(): void } {
  return Object.assign(Object.create(TUI.prototype) as TUI, {
    terminal: { rows },
    requestRender: () => {},
  });
}

function testKeybindings(): KeybindingsManager {
  return getKeybindings() as unknown as KeybindingsManager;
}

function entries(count: number): MemoryOverlaySourceEntry[] {
  const result: MemoryOverlaySourceEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `e${i}`;
    result.push({
      id,
      payload: {
        type: "message",
        id,
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: {
          role: i % 2 === 0 ? "user" : "assistant",
          content: `line-${i}`,
        },
      },
    });
  }
  return result;
}

function child(
  overrides: Partial<MemoryOverlaySourceChild> = {},
): MemoryOverlaySourceChild {
  return {
    childId: CHILD_ID,
    threadId: CHILD_ID,
    status: "live",
    title: "mount-child",
    generationId: "gen-1",
    parentChildId: undefined,
    runs: [{ run: 1, action: "start" }],
    branchIds: ["main"],
    descendantChildIds: [],
    entries: entries(8),
    ...overrides,
  };
}

async function mount(
  overrides: Partial<MemoryOverlaySourceChild> = {},
  rows = 40,
) {
  const source = createMemoryChildOverlaySource([child(overrides)]);
  const controller = createChildOverlayController(source, { pageSize: 10 });
  const opened = await controller.open(CHILD_ID);
  expect(opened.isOk()).toBe(true);
  const component = createChildOverlayCustomComponent(
    testTui(rows),
    TEST_THEME,
    testKeybindings(),
    controller,
    () => {},
    () => {},
    { cwd: "/workspace" },
  );
  return { component, controller };
}

// ---------------------------------------------------------------------------
// 1. Mount options
// ---------------------------------------------------------------------------

describe("PI_CHILD_OVERLAY_CUSTOM_OPTIONS", () => {
  it("mounts as a true Pi overlay rather than replacement custom UI", () => {
    expect(PI_CHILD_OVERLAY_CUSTOM_OPTIONS.overlay).toBe(true);
  });

  it("sizes the floating surface inside the terminal on every side", () => {
    const options = PI_CHILD_OVERLAY_CUSTOM_OPTIONS.overlayOptions;
    expect(options.anchor).toBe("center");
    expect(options.width).toBe("90%");
    expect(options.maxHeight).toBe("90%");
    expect(options.margin).toBe(1);
  });

  it("declares no minimum width that a narrow terminal could not honor", () => {
    // A minWidth wider than the terminal forces Pi to pass a width the
    // component cannot satisfy, which is a process abort, not a layout bug.
    expect("minWidth" in PI_CHILD_OVERLAY_CUSTOM_OPTIONS.overlayOptions).toBe(
      false,
    );
  });

  it("is frozen so a caller cannot mutate the shared mount options", () => {
    expect(Object.isFrozen(PI_CHILD_OVERLAY_CUSTOM_OPTIONS)).toBe(true);
    expect(
      Object.isFrozen(PI_CHILD_OVERLAY_CUSTOM_OPTIONS.overlayOptions),
    ).toBe(true);
  });

  it("matches Pi's percentage floor and margin clamp", () => {
    expect(overlayUsableRows({ terminal: { rows: 40 } })).toBe(36);
    expect(overlayUsableRows({ terminal: { rows: 5 } })).toBe(3);
    expect(overlayUsableRows({ terminal: { rows: Number.NaN } })).toBe(36);
  });
});

// ---------------------------------------------------------------------------
// 2. Border rendering and width safety
// ---------------------------------------------------------------------------

describe("overlayFrameGeometry", () => {
  it("reserves two columns and two rows once a border fits", () => {
    for (const width of [4, 10, 51, 200] as const) {
      const geometry = overlayFrameGeometry(width);
      expect(geometry.bordered).toBe(true);
      expect(geometry.innerWidth).toBe(width - 2);
      expect(geometry.reservedRows).toBe(FRAME_EDGE_ROWS);
    }
  });

  it("drops the border rather than squeeze it at unusable widths", () => {
    for (const width of [0, 1, 2, 3] as const) {
      const geometry = overlayFrameGeometry(width);
      expect(geometry.bordered).toBe(false);
      expect(geometry.reservedRows).toBe(0);
      expect(geometry.innerWidth).toBeLessThanOrEqual(width);
    }
  });

  it("treats non-finite widths as unbordered and zero-width", () => {
    for (const width of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const geometry = overlayFrameGeometry(width);
      expect(geometry.bordered).toBe(false);
      expect(geometry.innerWidth).toBe(0);
      expect(geometry.reservedRows).toBe(0);
    }
  });
});

describe("frameLinesToWidth", () => {
  it("draws a visible border with corners and rails", () => {
    const framed = frameLinesToWidth(["alpha", "beta"], 20);
    expect(framed).toHaveLength(2 + FRAME_EDGE_ROWS);
    expect(framed[0]?.startsWith("┌")).toBe(true);
    expect(framed[0]?.endsWith("┐")).toBe(true);
    expect(framed.at(-1)?.startsWith("└")).toBe(true);
    expect(framed.at(-1)?.endsWith("┘")).toBe(true);
    for (const line of framed.slice(1, -1)) {
      expect(line.startsWith("│")).toBe(true);
      expect(line.endsWith("│")).toBe(true);
    }
  });

  it("makes every row exactly the outer width so the frame is straight", () => {
    const framed = frameLinesToWidth(["short", "a bit longer"], 24);
    for (const line of framed) {
      expect(visibleWidth(line)).toBe(24);
    }
  });

  it("keeps content inside the rails when the content overflows", () => {
    const framed = frameLinesToWidth(["X".repeat(200)], 20);
    for (const line of framed) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(20);
    }
    const body = framed[1] ?? "";
    expect(body.startsWith("│")).toBe(true);
    expect(body.endsWith("│")).toBe(true);
    expect(body.includes("…")).toBe(true);
  });

  it("never exceeds the outer width for ANSI, CJK, or emoji content", () => {
    const lines = [
      `\x1b[31m${"漢".repeat(40)}\x1b[0m`,
      "😀".repeat(30),
      `e\u0301${"z".repeat(80)}`,
    ];
    for (const width of [4, 5, 12, 20, 51, 80] as const) {
      for (const line of frameLinesToWidth(lines, width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("returns unframed fitted content when the width cannot carry a border", () => {
    for (const width of [0, 1, 2, 3] as const) {
      const framed = frameLinesToWidth(["alpha", "beta"], width);
      expect(framed).toHaveLength(2);
      for (const line of framed) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(0, width));
        expect(line.startsWith("┌")).toBe(false);
        expect(line.startsWith("│")).toBe(false);
      }
    }
  });
});

describe("child overlay border rendering", () => {
  it("frames the mounted overlay without exceeding the width Pi passed", async () => {
    const { component } = await mount();
    for (const width of [4, 10, 20, 51, 120] as const) {
      const lines = component.render(width);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0]?.startsWith("┌")).toBe(true);
      expect(lines.at(-1)?.startsWith("└")).toBe(true);
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("lays content out against the inner width, not the outer width", async () => {
    const { component } = await mount({ title: "T".repeat(200) });
    const lines = component.render(60);
    const body = lines.slice(1, -1);
    expect(body.length).toBeGreaterThan(0);
    for (const line of body) {
      // rail + inner + rail
      expect(visibleWidth(line)).toBe(60);
      expect(visibleWidth(line.slice(1, -1))).toBe(58);
    }
  });

  it("drops the frame instead of overflowing a terminal too narrow for it", async () => {
    const { component } = await mount();
    for (const width of [1, 2, 3] as const) {
      const lines = component.render(width);
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        expect(line.startsWith("┌")).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Editor identity and input behavior
// ---------------------------------------------------------------------------

describe("child overlay steering field", () => {
  it("is a real Pi CustomEditor, never a pi-tui Input", () => {
    const editor = createChildOverlayDraftEditor(
      testTui(),
      TEST_THEME,
      testKeybindings(),
    );
    expect(editor).toBeInstanceOf(CustomEditor);
    expect(editor).toBeInstanceOf(Editor);
    expect(editor).not.toBeInstanceOf(Input);
  });

  it("exposes the editor text surface the overlay drives", () => {
    const editor = createChildOverlayDraftEditor(
      testTui(),
      TEST_THEME,
      testKeybindings(),
    );
    expect(typeof editor.getText).toBe("function");
    expect(typeof editor.setText).toBe("function");
    expect(typeof editor.render).toBe("function");
    editor.setText("follow-up");
    expect(editor.getText()).toBe("follow-up");
    editor.setText("first\nsecond");
    // Multi-line follow-ups are exactly what an `Input` could not carry.
    expect(editor.getText()).toBe("first\nsecond");
  });

  it("renders the live draft inside the framed overlay", async () => {
    const { component, controller } = await mount();
    component.handleInput("steer the child");
    expect(controller.view()._unsafeUnwrap().draft).toBe("steer the child");
    const lines = component.render(80);
    const joined = lines.join("\n");
    expect(joined.includes("steer the child")).toBe(true);
    expect(joined).toContain(EDITOR_BORDER_START);
    expect(joined).not.toContain("> steer the child");
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    }
  });

  it("keeps the native editor and bottom border on a short terminal", async () => {
    const { component } = await mount({}, 8);
    component.handleInput("short draft");
    const lines = component.render(80);
    expect(lines).toHaveLength(6);
    expect(lines.join("\n")).toContain("short draft");
    expect(lines.at(-1)?.startsWith("└")).toBe(true);
  });

  it("keeps draft editor and bottom border at the shortest supported height with telemetry", async () => {
    // rows=8 is the shortest height this suite treats as keeping draft text
    // visible (usableRows 6 → 4 inner rows after the frame). The extra
    // telemetry header row must not steal those editor/border rows.
    const rows = 8;
    const { component, controller } = await mount({}, rows);
    controller
      .applyLiveEvent({
        type: "usage",
        usage: {
          input: 12_300,
          output: 4_100,
          context: { tokens: 4_200, contextWindow: 10_000 },
        },
        model: "openai/gpt-5.6",
      })
      ._unsafeUnwrap();
    component.handleInput("shortest draft");
    component.invalidate();
    const lines = component.render(80);
    expect(lines.length).toBeLessThanOrEqual(
      overlayUsableRows({ terminal: { rows } }),
    );
    expect(lines.join("\n")).toContain("shortest draft");
    expect(lines.at(-1)?.startsWith("└")).toBe(true);
    expect(lines[0]?.startsWith("┌")).toBe(true);
    // At this height the meta line is budgeted away; taller renders show it.
    expect(
      formatChildOverlayTelemetryLine(
        controller.view()._unsafeUnwrap().telemetry,
      ),
    ).toBe("openai · openai/gpt-5.6 · ctx 42% · 12.3k in / 4.1k out");
  });

  it("never renders more rows than Pi keeps from rows 4 through 80", async () => {
    for (let rows = 4; rows <= 80; rows += 1) {
      const { component } = await mount({}, rows);
      component.handleInput("bounded draft");
      const rendered = component.render(80);
      expect(rendered.length).toBeLessThanOrEqual(
        overlayUsableRows({ terminal: { rows } }),
      );
      expect(rendered[0]?.startsWith("┌")).toBe(true);
      expect(rendered.at(-1)?.startsWith("└")).toBe(true);
    }
  });

  it("keeps the editor visible with the tall-terminal 90% budget", async () => {
    const { component } = await mount({}, 60);
    component.handleInput("tall draft");
    const rendered = component.render(100);
    expect(rendered.length).toBeLessThanOrEqual(54);
    expect(rendered.join("\n")).toContain("tall draft");
    expect(rendered.at(-1)?.startsWith("└")).toBe(true);
  });

  it("propagates overlay focus to the native editor", async () => {
    const { component } = await mount();
    component.focused = true;
    expect(component.focused).toBe(true);
    component.focused = false;
    expect(component.focused).toBe(false);
  });

  it("uses the bounded text fallback only when native rendering fails", async () => {
    const originalRender = CustomEditor.prototype.render;
    CustomEditor.prototype.render = () => {
      throw new Error("expected test render failure");
    };
    try {
      const { component } = await mount();
      component.handleInput("fallback draft");
      expect(component.render(80).join("\n")).toContain("> fallback draft");
    } finally {
      CustomEditor.prototype.render = originalRender;
    }
  });

  it("hides the steering field for a read-only settled child", async () => {
    const { component, controller } = await mount({ status: "settled" });
    controller.updateDraft("ignored")._unsafeUnwrap();
    component.invalidate();
    const lines = component.render(80);
    expect(lines.join("\n").includes("ignored")).toBe(false);
    expect(lines.join("\n").includes("Read-only")).toBe(true);
  });
});
