/**
 * Visual-fidelity regressions for the child inspector at a real wide terminal.
 *
 * A live Pi 0.83 screenshot passed every width-safety guard and still did not
 * read like the finalized prototype (`prototypes/weave-pi-tui-grilling.ts`,
 * design record `docs/specs/33-spec-pi-adapter/33-weave-ui-design.md` §2).
 * Three drifts produced it, and each one is pinned here:
 *
 * 1. The header's last identity slot printed the child's DURABLE STORAGE title
 *    (`thread-1d33e680`) — the agent name it already prints, plus an opaque id
 *    fragment the header may never print at all (§2.4, §2.20).
 * 2. The live prompt bypassed the locked panel and showed Pi's own editor
 *    chrome: one bare rule above the caret and one below, with no border, no
 *    label and no relationship to the surface above it (§2.10).
 * 3. The composed body drifted from the prototype's own budget. The locked
 *    composition (`bodyRightRail`) gives the body every row the header and the
 *    prompt did not reserve, and both the transcript window and the rail pad
 *    themselves to it, so the surface is one full frame at every height.
 *
 * The assertions are deliberately structural — order of facts, panel glyphs,
 * row budgets — rather than golden bytes, so they keep failing for the drift
 * and keep passing for ordinary copy changes.
 */

import { describe, expect, it } from "bun:test";
import {
  initTheme,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, TUI, visibleWidth } from "@earendil-works/pi-tui";
import {
  createChildOverlayController,
  createChildOverlayCustomComponent,
  createMemoryChildOverlaySource,
  type MemoryOverlaySourceChild,
  type MemoryOverlaySourceEntry,
} from "../child-overlay.js";
import { overlayUsableRows } from "../child-overlay-component.js";
import { childOverlayHeaderFacts } from "../child-overlay-facts.js";
import {
  OVERLAY_CHILD_BADGE,
  overlayEditorBodyRows,
  overlayPaneGeometry,
} from "../child-overlay-layout.js";
import type { PiUiThemePort } from "../types.js";

/** Pi native transcript components read the process-wide theme. */
initTheme("default");

const CHILD_ID = "visual-fidelity-child";
const THREAD_ID = "9c21f4b71d33e680";
/** What the screenshot's header wrongly printed as a semantic fact. */
const DURABLE_TITLE = "thread-1d33e680";

/** Colour is irrelevant here; every assertion is about structure. */
const THEME: PiUiThemePort = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function testTui(rows: number): TUI & { requestRender(): void } {
  return Object.assign(Object.create(TUI.prototype) as TUI, {
    terminal: { rows },
    requestRender: () => {},
  });
}

function entries(count: number): MemoryOverlaySourceEntry[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `e${index}`,
    payload: {
      type: "message",
      id: `e${index}`,
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: `transcript row ${index}`,
      },
    },
  })) as MemoryOverlaySourceEntry[];
}

function child(
  overrides: Partial<MemoryOverlaySourceChild> = {},
): MemoryOverlaySourceChild {
  return {
    childId: CHILD_ID,
    threadId: THREAD_ID,
    status: "live",
    title: DURABLE_TITLE,
    agentName: "thread",
    parentAgentName: "loom",
    model: "gpt-5.6-sol",
    generationId: "gen-1",
    parentChildId: undefined,
    runs: [{ run: 1, action: "start" }],
    branchIds: [],
    descendantChildIds: [],
    entries: entries(4),
    ...overrides,
  };
}

async function mount(
  overrides: Partial<MemoryOverlaySourceChild> = {},
  rows = 50,
) {
  const source = createMemoryChildOverlaySource([child(overrides)]);
  const controller = createChildOverlayController(source, { pageSize: 64 });
  expect((await controller.open(CHILD_ID)).isOk()).toBe(true);
  const component = createChildOverlayCustomComponent(
    testTui(rows),
    THEME,
    getKeybindings() as unknown as KeybindingsManager,
    controller,
    () => {},
    () => {},
    { cwd: "/workspace" },
  );
  return { component, controller };
}

/**
 * Header facts for one descriptor, taken from a real opened view.
 *
 * Going through the source and the controller is the point: the drift was in
 * the projection of an authoritative descriptor, so a hand-built view would
 * test the wrong thing.
 */
async function headerFacts(overrides: {
  readonly title?: string;
  readonly agentName?: string;
  readonly assignment?: string;
}) {
  const source = createMemoryChildOverlaySource([
    child({
      ...(overrides.title === undefined ? {} : { title: overrides.title }),
      ...(overrides.agentName === undefined
        ? {}
        : { agentName: overrides.agentName }),
      ...(overrides.assignment === undefined
        ? {}
        : { assignment: overrides.assignment }),
    }),
  ]);
  const controller = createChildOverlayController(source, { pageSize: 8 });
  expect((await controller.open(CHILD_ID)).isOk()).toBe(true);
  return childOverlayHeaderFacts(controller.view()._unsafeUnwrap());
}

// ---------------------------------------------------------------------------
// 1. The header states semantic identity, never storage bookkeeping
// ---------------------------------------------------------------------------

describe("child inspector header identity", () => {
  it("drops a durable identity title instead of printing it as a fact", async () => {
    expect((await headerFacts({ title: DURABLE_TITLE })).boundedTitle).toBe("");
    // The same rule for the identity-only fallback and for the bare name.
    expect((await headerFacts({ title: "child-1d33e680" })).boundedTitle).toBe(
      "",
    );
    expect((await headerFacts({ title: "thread" })).boundedTitle).toBe("");
  });

  it("keeps an authoritative assignment and a genuinely different title", async () => {
    expect(
      (await headerFacts({ title: DURABLE_TITLE, assignment: "port the rail" }))
        .boundedTitle,
    ).toBe("port the rail");
    expect(
      (await headerFacts({ title: "overlay header width" })).boundedTitle,
    ).toBe("overlay header width");
  });

  it("prints badge · name · model in the locked order and no thread id", async () => {
    const { component } = await mount();
    const lines = component.render(220);
    const identity = lines[identityRow(lines)] ?? "";
    expect(identity.indexOf("thread")).toBeGreaterThan(-1);
    expect(identity.indexOf("thread")).toBeLessThan(
      identity.indexOf("gpt-5.6-sol"),
    );
    expect(lines.join("\n")).not.toContain(DURABLE_TITLE);
    expect(lines.join("\n")).not.toContain(THREAD_ID);
  });

  it("keeps the provenance row beneath the identity row", async () => {
    const { component } = await mount();
    const lines = component.render(220);
    const provenance = lines.findIndex((line) =>
      line.includes("delegated by loom"),
    );
    expect(provenance).toBe(identityRow(lines) + 1);
  });
});

/** The badge row inside the frame, never the frame title that names the surface. */
function identityRow(lines: readonly string[]): number {
  const index = lines.findIndex(
    (line, row) => row > 0 && line.includes(OVERLAY_CHILD_BADGE.trim()),
  );
  expect(index).toBeGreaterThan(0);
  return index;
}

// ---------------------------------------------------------------------------
// 2. The prompt is a panel, not an underline
// ---------------------------------------------------------------------------

describe("child inspector prompt panel", () => {
  it("wraps the live editor in the locked labelled panel", async () => {
    const { component } = await mount();
    component.handleInput("steer the child");
    const lines = component.render(220);
    const top = lines.findIndex((line) => line.includes("╭─ steer thread"));
    expect(top).toBeGreaterThan(0);
    // panel top, at least one body row, panel bottom, then the key row.
    const body = lines[top + 1] ?? "";
    expect(body).toContain("steer the child");
    expect(lines.slice(top).some((line) => line.includes("╰"))).toBe(true);
    expect(lines.at(-2) ?? "").toContain("Esc close");
    expect(lines.at(-1)?.startsWith("╰")).toBe(true);
  });

  it("never lets Pi's own editor rules become the prompt's border", () => {
    const rendered = ["─".repeat(20), "  draft text", "─".repeat(20)];
    expect(overlayEditorBodyRows(rendered, 20)).toEqual(["  draft text"]);
    // A scroll edge carries words, so it is content and survives.
    const scrolled = ["─── ↑ 3 more ───", " tail", "─".repeat(16)];
    expect(overlayEditorBodyRows(scrolled, 16)).toEqual([
      "─── ↑ 3 more ───",
      " tail",
    ]);
    // A degraded shape is never emptied.
    expect(overlayEditorBodyRows(["> only"], 16)).toEqual(["> only"]);
    expect(overlayEditorBodyRows(["─────"], 16)).toEqual(["─────"]);
  });

  it("gives a settled child the same panel, read-only", async () => {
    const { component } = await mount({ status: "settled" });
    const lines = component.render(220);
    expect(lines.some((line) => line.includes("╭─"))).toBe(true);
    expect(lines.join("\n").toLowerCase()).toContain("read-only");
  });
});

// ---------------------------------------------------------------------------
// 3. Transcript and rail read as one composed body
// ---------------------------------------------------------------------------

describe("child inspector composed body", () => {
  it("joins the transcript and the rail on every body row", async () => {
    const { component } = await mount({ entries: entries(40) });
    const lines = component.render(220);
    const geometry = overlayPaneGeometry(220, false);
    expect(geometry.rail).toBeGreaterThan(0);
    const railStart = lines.findIndex((line) => line.includes("LIFECYCLE"));
    expect(railStart).toBeGreaterThan(0);
    // Every rail row sits in the same column of the same body, beside the
    // transcript, rather than under it.
    const column = (line: string): number =>
      visibleWidth(line.slice(0, line.indexOf("LIFECYCLE")));
    expect(column(lines[railStart] as string)).toBe(
      1 + (geometry.pane as number) + 1,
    );
  });

  it("keeps the prototype's rail band at every wide terminal", () => {
    for (const width of [120, 160, 220, 300] as const) {
      const geometry = overlayPaneGeometry(width, false);
      expect(geometry.rail).toBeGreaterThanOrEqual(30);
      expect(geometry.rail).toBeLessThanOrEqual(42);
      expect(geometry.pane).toBeGreaterThanOrEqual(38);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The body takes the whole canvas, exactly as the prototype composes it
// ---------------------------------------------------------------------------

describe("child inspector vertical budget", () => {
  it("fills the row budget even when the transcript is short", async () => {
    const rows = 50;
    const { component } = await mount({ entries: entries(2) }, rows);
    const rendered = component.render(220);
    // `bodyRightRail` budgets the CANVAS: the transcript window and the rail
    // both pad to the rows the header and the prompt left, so a short child is
    // one full frame rather than a shrunken one.
    expect(rendered.length).toBe(overlayUsableRows({ terminal: { rows } }));
    const key = rendered.findIndex((line) => line.includes("Esc close"));
    expect(key).toBe(rendered.length - 2);
    expect(rendered.at(-1)?.startsWith("╰")).toBe(true);
    expect(rendered[0]?.startsWith("╭")).toBe(true);
  });

  it("spends the same budget on a transcript that has the rows", async () => {
    const rows = 50;
    const { component } = await mount({ entries: entries(400) }, rows);
    const rendered = component.render(220);
    expect(rendered.length).toBe(overlayUsableRows({ terminal: { rows } }));
    expect(rendered.at(-1)?.startsWith("╰")).toBe(true);
  });

  it("keeps a usable reading window for a nearly empty child", async () => {
    const rows = 50;
    const { component } = await mount({ entries: entries(1) }, rows);
    const rendered = component.render(220);
    expect(rendered.length).toBe(overlayUsableRows({ terminal: { rows } }));
    for (const line of rendered) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(220);
    }
  });

  it("stays framed, fitted and actionable across wide terminals", async () => {
    const { component } = await mount({ entries: entries(24) });
    component.handleInput("wide draft");
    for (let width = 120; width <= 260; width += 20) {
      component.invalidate();
      const rendered = component.render(width);
      expect(rendered[0]?.startsWith("╭")).toBe(true);
      expect(rendered.at(-1)?.startsWith("╰")).toBe(true);
      expect(rendered.join("\n")).toContain("wide draft");
      for (const line of rendered) {
        expect(visibleWidth(line)).toBe(width);
      }
    }
  });
});
