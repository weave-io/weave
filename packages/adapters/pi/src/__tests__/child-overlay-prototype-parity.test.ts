/**
 * Direct parity between the shipped child inspector and its normative
 * prototype, `prototypes/weave-pi-tui-grilling.ts`.
 *
 * The prototype is the design record: the inspector was settled there, region
 * by region, and production is a PORT of it rather than an interpretation. So
 * this file does what the width sweeps and the accessibility sweep cannot — it
 * pins the composition itself against ONE fixed wide fixture:
 *
 *   - the region boundaries (`composeSessionHeader` + rule, `bodyRightRail`,
 *     `renderPromptGroup`) and how many rows each one takes;
 *   - representative EXACT plain-text rows, so a drift in a label, a glyph, a
 *     separator, a key column or a cut mark fails here;
 *   - the rail geometry (`RAIL_GEOMETRY`, `MATRIX_KEY`) and the drop order the
 *     prototype's `stackSections` produces;
 *   - the search rail and marker gutter (`searchRailSections`,
 *     `markSearchGutter`, `SEARCH_INSET`);
 *   - the single outer frame and its state marker (`frameTop`, `frameBottom`,
 *     `FRAME_COLUMNS`).
 *
 * The fixture substitutes REAL production facts for the prototype's mock
 * values; nothing else about the composition is allowed to differ. Prototype
 * scaffolding — the demo banner, the demo footer, the `DEMO` mark and the
 * state-switch chips — is absent by design and is asserted absent here.
 *
 * The body deliberately takes the WHOLE canvas, exactly as `bodyRightRail`
 * composes it: the transcript window and the Status Matrix both pad to the
 * rows the header and the prompt did not reserve. Content-height shrinking is
 * not a prototype behaviour and must not reappear.
 */

import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  buildOverlayNavFacts,
  composeOverlayRegions,
  OVERLAY_FRAME_COLUMNS,
  OVERLAY_FRAME_TITLE,
  OVERLAY_MATRIX_KEY,
  OVERLAY_SEARCH_INSET,
  type OverlayComposeInput,
  type OverlayHeaderFacts,
  type OverlayNavRow,
  type OverlayPromptFacts,
  type OverlayRailFacts,
  overlayPaneGeometry,
  overlaySettlementFacts,
} from "../child-overlay-layout.js";
import { plainPaint } from "../ui-paint.js";
import { RAIL_GEOMETRY, TRANSCRIPT_MIN } from "../ui-rows.js";

/** The fixed fixture. One width, one height, one child, no randomness. */
const WIDTH = 120;
const HEIGHT = 30;
const TRANSCRIPT_ROWS = 18;

/** Identity and provenance, in the prototype's own fact order. */
const HEADER: OverlayHeaderFacts = {
  name: "shuttle",
  model: "gpt-5.6-sol",
  role: "implementer",
  boundedTitle: "reserve the trailing marker before truncating",
  parent: "LOOM",
  plan: "pi-child-overlay-ux-feedback",
  taskCrumb: "task 3/8 Child overlay rendering",
  subtask: "3.3 Transcript event rendering",
};

/** Lifecycle, work and spend, as the Status Matrix groups them. */
const RAIL: OverlayRailFacts = {
  status: "RUNNING",
  tone: "run",
  elapsed: "1m 44s",
  turn: "3",
  run: "run 1",
  branch: "main",
  live: "edit · child-overlay-component.ts",
  tool: "edit",
  target: "child-overlay-component.ts",
  args: "1 replacement · fitLineWithSuffix(line, suffix, width)",
  toolOutcome: "applied · +6 −3",
  toolTone: "ok",
  failed: false,
  queueCount: 1,
  firstQueued: "also assert the 200-column case",
  tokensIn: "18420",
  tokensOut: "2044",
  cost: "$0.19",
};

const PROMPT: OverlayPromptFacts = {
  target: "shuttle",
  turn: 3,
  settled: false,
  failed: false,
  queueCount: 1,
  draft: "also assert the 200-column case",
  stateWord: "RUNNING",
  confirmingCancel: false,
};

const NAV_ROWS: readonly OverlayNavRow[] = Array.from(
  { length: TRANSCRIPT_ROWS },
  (_unused, index) => ({
    painted: `  transcript row ${index} width`,
    plain: `  transcript row ${index} width`,
    label: index % 2 === 0 ? "assistant" : "tool",
    at: "run 1",
  }),
);

function regions(
  overrides: Partial<OverlayComposeInput> = {},
): ReturnType<typeof composeOverlayRegions> {
  const nav =
    overrides.nav ??
    buildOverlayNavFacts(NAV_ROWS, { query: "width", open: false });
  return composeOverlayRegions({
    width: WIDTH,
    height: HEIGHT,
    paint: plainPaint(),
    header: HEADER,
    rail: RAIL,
    prompt: PROMPT,
    settlement: overlaySettlementFacts("live"),
    transcript: NAV_ROWS.map((row) => row.painted),
    ...overrides,
    nav,
  });
}

/** The frame writes one reset before each edge; regions never carry any. */
const RESET = `${String.fromCharCode(27)}[0m`;
function bare(line: string): string {
  return line.split(RESET).join("");
}

// ---------------------------------------------------------------------------
// 1. Region boundaries
// ---------------------------------------------------------------------------

describe("inspector region boundaries", () => {
  it("splits into header + rule, body, prompt, inside one frame", () => {
    const out = regions();
    // Session Header: identity row, provenance row, muted rule.
    expect(out.head.length).toBe(3);
    // The primary-like editor: panel top, field, panel bottom, key row.
    expect(out.prompt.length).toBe(4);
    // The body owns every remaining row of the canvas.
    const inner = HEIGHT - 2;
    expect(out.main.length).toBe(inner - out.head.length - out.prompt.length);
    expect(out.lines.length).toBe(HEIGHT);
  });

  it("emits exactly one frame and the live state marker", () => {
    const out = regions();
    const top = bare(out.lines[0] as string);
    const bottom = bare(out.lines.at(-1) as string);
    expect(top.startsWith(`╭─${OVERLAY_FRAME_TITLE}`)).toBe(true);
    expect(top.endsWith(" ● RUNNING ─╮")).toBe(true);
    expect(bottom.startsWith("╰")).toBe(true);
    expect(bottom.endsWith("╯")).toBe(true);
    // One frame: no inner row opens a second high-contrast corner.
    for (const line of out.lines.slice(1, -1)) {
      expect(bare(line).startsWith("│")).toBe(true);
      expect(bare(line).endsWith("│")).toBe(true);
    }
    for (const line of out.lines) expect(visibleWidth(line)).toBe(WIDTH);
  });

  it("carries no prototype scaffolding", () => {
    const all = regions().lines.join("\n");
    for (const scaffolding of [
      "DEMO",
      "demo",
      "CHILD STATE",
      "FINAL PROTOTYPE",
      "Tab / Shift+Tab",
      "nothing is cancelled",
    ]) {
      expect(all).not.toContain(scaffolding);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The Session Header
// ---------------------------------------------------------------------------

describe("session header parity", () => {
  it("prints badge · agent · model · role · bounded assignment, then provenance", () => {
    const out = regions();
    expect(out.head[0]?.trimEnd()).toBe(
      " CHILD  shuttle · gpt-5.6-sol · implementer · reserve the trailing marker before truncating",
    );
    expect(out.head[1]?.trimEnd()).toBe(
      "delegated by LOOM · pi-child-overlay-ux-feedback › task 3/8 Child overlay rendering › 3.3 Transcript event rendering",
    );
    expect(out.head[2]).toBe("─".repeat(WIDTH - OVERLAY_FRAME_COLUMNS));
  });

  it("never prints a durable thread title or id", () => {
    const all = regions({
      header: { ...HEADER, boundedTitle: "" },
    }).lines.join("\n");
    expect(all).not.toContain("thread-");
    expect(all).not.toMatch(/\b[0-9a-f]{8,}\b/);
  });
});

// ---------------------------------------------------------------------------
// 3. The body: transcript left, Status Matrix right
// ---------------------------------------------------------------------------

describe("body and rail parity", () => {
  it("keeps the prototype's rail band and transcript floor", () => {
    const geometry = overlayPaneGeometry(WIDTH, false);
    expect(RAIL_GEOMETRY).toEqual({ min: 30, max: 42, ratio: 0.34 });
    expect(TRANSCRIPT_MIN).toBe(38);
    expect(geometry.rail).toBe(40);
    expect(geometry.pane).toBe(WIDTH - OVERLAY_FRAME_COLUMNS - 40 - 1);
  });

  it("joins every body row at the same rail column", () => {
    const out = regions();
    const geometry = overlayPaneGeometry(WIDTH, false);
    for (const line of out.main) {
      expect(visibleWidth(line)).toBe(WIDTH - OVERLAY_FRAME_COLUMNS);
      expect(line[geometry.pane]).toBe("│");
    }
  });

  it("stacks LIFECYCLE, WORK and SPEND with the locked key column", () => {
    const rail = regions().main.map((line) =>
      line.slice((overlayPaneGeometry(WIDTH, false).pane as number) + 1),
    );
    expect(rail.map((line) => line.trimEnd())).toEqual([
      "LIFECYCLE ──────────────────────────────",
      "status   RUNNING",
      "elapsed  1m 44s",
      "turn     3",
      "run      run 1 · main",
      "live     edit · child-overlay-component…",
      "",
      "WORK ───────────────────────────────────",
      "tool     edit",
      "result   applied · +6 −3",
      "target   child-overlay-component.ts",
      "queue    1",
      "next     also assert the 200-column case",
      "args     1 replacement · fitLineWithSuf…",
      "",
      "SPEND ──────────────────────────────────",
      "cost     $0.19",
      "in       18420",
      "out      2044",
      "",
      "",
    ]);
    // Every value starts on the one column the key width fixes.
    for (const line of rail) {
      if (!line.includes("─") && line.trim().length > 0) {
        expect(line[OVERLAY_MATRIX_KEY]).toBe(" ");
      }
    }
  });

  it("fills the canvas rather than shrinking to its content", () => {
    const short = regions({ transcript: ["  only row"] });
    expect(short.lines.length).toBe(HEIGHT);
    expect(short.main.length).toBe(regions().main.length);
    // The prompt is still the four rows above the closing edge.
    expect(bare(short.lines.at(-2) as string)).toContain("Esc close");
  });
});

// ---------------------------------------------------------------------------
// 4. The primary-like prompt
// ---------------------------------------------------------------------------

describe("prompt group parity", () => {
  it("draws the muted bordered panel, the field, and the key ladder", () => {
    const out = regions();
    const inner = WIDTH - OVERLAY_FRAME_COLUMNS;
    expect(
      out.prompt[0]?.startsWith("╭─ steer shuttle · turn 3 · 1 queued"),
    ).toBe(true);
    expect(out.prompt[0]).toContain("Alt+Enter queues instead");
    expect(out.prompt[0]?.endsWith("╮")).toBe(true);
    expect(out.prompt[1]).toBe(
      `│ ❯ also assert the 200-column case${" ".repeat(inner - 36)}│`,
    );
    expect(out.prompt[2]).toBe(`╰${"─".repeat(inner - 2)}╯`);
    expect(out.prompt[3]?.trimEnd()).toBe(
      "Enter steer · Alt+Enter queue · q cancel (confirm) · / search · Esc close",
    );
  });

  it("gives a settled child the same panel, read-only and caretless", () => {
    const out = regions({
      prompt: { ...PROMPT, settled: true, stateWord: "COMPLETED" },
      settlement: overlaySettlementFacts("completed"),
    });
    expect(
      out.prompt[0]?.startsWith("╭─ shuttle · completed · read-only "),
    ).toBe(true);
    expect(out.prompt[1]).toContain("▪ read-only — this child has settled");
    expect(out.prompt[1]).not.toContain("❯");
    expect(out.prompt[3]?.trimEnd()).toBe(
      "✕ Enter steer · ✕ Alt+Enter queue · ✕ q cancel (confirm) · / search · Esc close",
    );
  });

  it("replaces the editor with the cancel confirmation, and nothing else", () => {
    const out = regions({ prompt: { ...PROMPT, confirmingCancel: true } });
    expect(out.prompt.length).toBe(1);
    expect(out.prompt[0]?.trimEnd()).toBe(
      "cancel shuttle at turn 3? y yes · n no · Esc keep running",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Rail search and the marker gutter
// ---------------------------------------------------------------------------

describe("inspector width bounds", () => {
  it("keeps every framed row within the requested width at and beyond limits", () => {
    for (const width of [27, 54, 76, 77, 120, 200, 512]) {
      const out = regions({ width });
      expect(out.lines).toHaveLength(HEIGHT);
      for (const line of out.lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe("search parity", () => {
  const open = buildOverlayNavFacts(NAV_ROWS, {
    query: "width",
    open: true,
    current: 2,
  });

  it("prepends the SEARCH section above LIFECYCLE and lists three matches", () => {
    const out = regions({
      nav: open,
      transcript: NAV_ROWS.map((row) => row.painted),
    });
    const pane = overlayPaneGeometry(WIDTH, true).pane as number;
    const rail = out.main.map((line) => line.slice(pane + 1).trimEnd());
    expect(rail.slice(0, 6)).toEqual([
      "SEARCH ─────────────────────────────────",
      "query    width",
      "match    2/18",
      "kinds    assistant 9 · tool 9",
      "  1. assistant · run 1",
      " ▸ 2. tool · run 1",
    ]);
    expect(rail[6]?.startsWith("LIFECYCLE")).toBe(true);
  });

  it("gives the transcript exactly two columns of marker gutter", () => {
    const out = regions({
      nav: open,
      transcript: NAV_ROWS.map((row) => row.painted),
    });
    const pane = overlayPaneGeometry(WIDTH, true).pane as number;
    const closedPane = overlayPaneGeometry(WIDTH, false).pane as number;
    expect(closedPane - overlayPaneGeometry(WIDTH, true).transcript).toBe(
      OVERLAY_SEARCH_INSET,
    );
    expect(pane).toBe(closedPane);
    const gutter = out.main.slice(0, 3).map((line) => line.slice(0, 2));
    // `·` marks a match, `▌` marks the current one.
    expect(gutter).toEqual(["· ", "▌ ", "· "]);
  });

  it("leaves the prompt byte-identical with search open and closed", () => {
    const withSearch = regions({ nav: open });
    expect(withSearch.prompt.join("\n")).toBe(regions().prompt.join("\n"));
    expect(withSearch.head.join("\n")).toBe(regions().head.join("\n"));
  });
});
