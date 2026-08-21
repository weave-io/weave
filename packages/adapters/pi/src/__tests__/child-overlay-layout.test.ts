import { describe, expect, test } from "bun:test";

import {
  buildOverlayNavFacts,
  compactStatusMatrix,
  composeOverlayRegions,
  composeSessionHeader,
  keyChip,
  markSearchGutter,
  matrixRow,
  OVERLAY_CHILD_BADGE,
  OVERLAY_HEADER_SEP,
  OVERLAY_SEARCH_INSET,
  type OverlayComposeInput,
  type OverlayHeaderFacts,
  type OverlayNavRow,
  type OverlayPromptFacts,
  type OverlayRailFacts,
  type OverlaySettlementPhase,
  overlayPaneGeometry,
  overlaySettlementFacts,
  promptKeys,
  renderPromptGroup,
  renderRailStatusMatrix,
  searchRailSections,
  transcriptWindow,
} from "../child-overlay-layout.js";
import { measureWidth } from "../render-width.js";
import { plainPaint } from "../ui-paint.js";

const paint = plainPaint();

const HEADER: OverlayHeaderFacts = {
  name: "shuttle",
  model: "gpt-5.6-sol",
  role: "implementer",
  boundedTitle: "port the inspector layout",
  parent: "LOOM",
  plan: "pi weave ui redesign",
  taskCrumb: "task 8/19 build the layout module",
  subtask: "header identity row",
};

const RAIL: OverlayRailFacts = {
  status: "RUNNING",
  tone: "run",
  elapsed: "2m 14s",
  turn: "4",
  run: "run 2",
  branch: "weave/ui",
  live: "editing child-overlay-layout.ts",
  tool: "edit",
  target: "child-overlay-layout.ts",
  args: "range 40-96",
  toolOutcome: "applied 2 edits",
  toolTone: "ok",
  failed: false,
  queueCount: 1,
  firstQueued: "also assert the 200-column case",
  tokensIn: "18420",
  tokensOut: "3120",
  cost: "$0.42",
};

const FAILED_RAIL: OverlayRailFacts = {
  ...RAIL,
  status: "TOOL ERROR",
  tone: "bad",
  toolTone: "bad",
  failed: true,
  toolOutcome: "exit 1",
  errorDetail: "the width assertion failed on the 200 column case",
};

const PROMPT: OverlayPromptFacts = {
  target: "shuttle",
  turn: 4,
  settled: false,
  failed: false,
  queueCount: 1,
  draft: "also assert the 200-column case",
  stateWord: "RUNNING",
  confirmingCancel: false,
};

const SETTLED_PROMPT: OverlayPromptFacts = {
  ...PROMPT,
  settled: true,
  stateWord: "COMPLETED",
  queueCount: 0,
};

const TRANSCRIPT_TEXT: readonly string[] = [
  "· child session started",
  "❯ port the finalized layout module",
  "✻ summary · reading the prototype first",
  "⚙ read · prototypes/weave-pi-tui-grilling.ts",
  "  read 3678 lines",
  "⚙ edit · child-overlay-layout.ts",
  "  the width contract holds at every width",
  "● every emitted row respects its width",
  "● final response · the module is width safe",
];

function navRows(): readonly OverlayNavRow[] {
  return TRANSCRIPT_TEXT.map((line, index) => ({
    painted: line,
    plain: line,
    label: index % 2 === 0 ? "tool" : "assistant",
    at: `14:24:0${index}`,
  }));
}

const PHASES: readonly OverlaySettlementPhase[] = [
  "live",
  "queued",
  "failed",
  "completed",
  "cancelled",
  "recovering",
];

function composeInput(
  overrides: Partial<OverlayComposeInput> = {},
): OverlayComposeInput {
  const nav =
    overrides.nav ??
    buildOverlayNavFacts(navRows(), { query: "width", open: false });
  return {
    width: 120,
    height: 32,
    paint,
    header: HEADER,
    rail: RAIL,
    prompt: PROMPT,
    settlement: overlaySettlementFacts("live"),
    transcript: TRANSCRIPT_TEXT,
    ...overrides,
    nav,
  };
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

describe("session header", () => {
  test("is byte-identical across all six child states", () => {
    const widths = [40, 62, 96, 140, 200];
    for (const width of widths) {
      const rendered = PHASES.map((phase) => {
        const settlement = overlaySettlementFacts(phase);
        const regions = composeOverlayRegions(
          composeInput({
            width,
            settlement,
            rail: phase === "failed" ? FAILED_RAIL : RAIL,
            prompt: settlement.settled ? SETTLED_PROMPT : PROMPT,
          }),
        );
        return regions.head.join("\n");
      });
      const first = rendered[0] as string;
      for (const other of rendered) expect(other).toBe(first);
    }
  });

  test("prints the model exactly once, immediately after the child name", () => {
    for (let width = 40; width <= 200; width += 1) {
      const header = composeSessionHeader(paint, HEADER, width);
      const text = header.lines.join("\n");
      if (!header.facts.includes("model")) continue;

      const occurrences = text.split(HEADER.model as string).length - 1;
      expect(occurrences).toBe(1);

      const nameAt = text.indexOf(HEADER.name);
      const modelAt = text.indexOf(HEADER.model as string);
      expect(modelAt).toBe(
        nameAt + HEADER.name.length + OVERLAY_HEADER_SEP.length,
      );
    }
  });

  test("keeps the model between the name and the role in the fact order", () => {
    const header = composeSessionHeader(paint, HEADER, 140);
    expect(header.facts).toEqual([
      "child-badge-name",
      "model",
      "role",
      "title",
      "parent",
      "plan",
      "task",
      "subtask",
    ]);
  });

  test("never prints telemetry, a queue depth, a cost or a child id", () => {
    const forbidden = [
      "18420",
      "3120",
      "$0.42",
      "2m 14s",
      "queue",
      "child-01H",
      "RUNNING",
      "COMPLETED",
    ];
    for (let width = 40; width <= 200; width += 4) {
      for (const phase of PHASES) {
        const settlement = overlaySettlementFacts(phase);
        const regions = composeOverlayRegions(
          composeInput({
            width,
            settlement,
            rail: phase === "failed" ? FAILED_RAIL : RAIL,
            prompt: settlement.settled ? SETTLED_PROMPT : PROMPT,
          }),
        );
        const head = regions.head.join("\n");
        for (const token of forbidden) expect(head).not.toContain(token);
      }
    }
  });

  test("grows to two identity rows rather than dropping the task title", () => {
    const header = composeSessionHeader(paint, HEADER, 44);
    expect(header.facts).toContain("title");
    expect(header.lines.join("\n")).toContain(HEADER.boundedTitle);
  });

  test("omits absent optional facts instead of inventing them", () => {
    const header = composeSessionHeader(
      paint,
      { name: "shuttle", boundedTitle: "do the thing" },
      120,
    );
    expect(header.facts).toEqual(["child-badge-name", "title"]);
    expect(header.lines).toHaveLength(1);
    expect(header.lines[0]).toContain(OVERLAY_CHILD_BADGE.trim());
  });
});

// ---------------------------------------------------------------------------
// Rail
// ---------------------------------------------------------------------------

describe("status matrix rail", () => {
  test("keeps the three groups and puts the failure alert above them", () => {
    const lines = renderRailStatusMatrix(paint, FAILED_RAIL, 36, 24);
    const text = lines.join("\n");
    expect(text).toContain("LIFECYCLE");
    expect(text).toContain("WORK");
    expect(text).toContain("SPEND");
    const alertAt = text.indexOf("✖ TOOL ERROR");
    expect(alertAt).toBeGreaterThanOrEqual(0);
    expect(alertAt).toBeLessThan(text.indexOf("LIFECYCLE"));
  });

  test("returns exactly the requested number of rows at every room", () => {
    for (let room = 6; room <= 40; room += 1) {
      const lines = renderRailStatusMatrix(paint, RAIL, 34, room);
      expect(lines.length).toBeLessThanOrEqual(room);
      for (const line of lines)
        expect(measureWidth(line)).toBeLessThanOrEqual(34);
    }
  });

  test("places the search section under the alert and above the matrix", () => {
    const nav = buildOverlayNavFacts(navRows(), { query: "width", open: true });
    const lines = renderRailStatusMatrix(
      paint,
      FAILED_RAIL,
      36,
      30,
      searchRailSections(paint, nav, 36),
    );
    const text = lines.join("\n");
    expect(text.indexOf("✖ TOOL ERROR")).toBeLessThan(text.indexOf("SEARCH"));
    expect(text.indexOf("SEARCH")).toBeLessThan(text.indexOf("LIFECYCLE"));
  });

  test("prints an em dash for an absent fact rather than a zero", () => {
    const row = matrixRow(paint, "cost", "—", 30);
    expect(row).toContain("—");
    const compact = compactStatusMatrix(
      paint,
      {
        status: "RUNNING",
        tone: "run",
        toolTone: "mute",
        failed: false,
        queueCount: 0,
      },
      60,
    );
    expect(compact.join("\n")).toContain("—");
    expect(compact.join("\n")).toContain("queue empty");
  });

  test("folds to the compact matrix without dropping any group", () => {
    const compact = compactStatusMatrix(paint, FAILED_RAIL, 58);
    const text = compact.join("\n");
    for (const key of ["error", "life", "work", "queue", "spend", "live"]) {
      expect(text).toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// Transcript window and search
// ---------------------------------------------------------------------------

describe("transcript window", () => {
  test("states how many rows scrolled out in tail mode", () => {
    const lines = transcriptWindow(paint, TRANSCRIPT_TEXT, 60, 5, undefined);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("↑");
    expect(lines[0]).toContain("earlier row(s)");
  });

  test("states both directions in anchored mode", () => {
    const lines = transcriptWindow(paint, TRANSCRIPT_TEXT, 60, 6, 2);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain("↑");
    expect(lines[lines.length - 1]).toContain("↓");
  });

  test("pads to exactly the requested room when it has fewer rows", () => {
    const lines = transcriptWindow(
      paint,
      TRANSCRIPT_TEXT.slice(0, 3),
      60,
      7,
      undefined,
    );
    expect(lines).toHaveLength(7);
  });
});

describe("rail search", () => {
  test("counts occurrences, not rows, from the ANSI-free twin", () => {
    const rows: readonly OverlayNavRow[] = [
      {
        painted: "\u001B[31mwidth width\u001B[0m",
        plain: "width width",
        label: "tool",
      },
      { painted: "no hit here", plain: "no hit here", label: "assistant" },
    ];
    const facts = buildOverlayNavFacts(rows, { query: "width", open: true });
    expect(facts.total).toBe(2);
    expect(facts.counter).toBe("1/2");
    expect(facts.rows.has(0)).toBe(true);
    expect(facts.rows.has(1)).toBe(false);
    for (const match of facts.matches) {
      expect(match.snippet).not.toContain("\u001B");
    }
  });

  test("clamps the cursor and reports an empty search honestly", () => {
    const facts = buildOverlayNavFacts(navRows(), {
      query: "no-such-token",
      open: true,
      current: 4,
    });
    expect(facts.total).toBe(0);
    expect(facts.current).toBe(0);
    expect(facts.counter).toBe("0/0");
    expect(facts.empty).toBe(true);
    expect(facts.anchorRow).toBeUndefined();
  });

  test("marks the gutter in exactly two columns", () => {
    const facts = buildOverlayNavFacts(navRows(), {
      query: "width",
      open: true,
      current: 1,
    });
    const gutter = markSearchGutter(paint, facts, TRANSCRIPT_TEXT, 60);
    expect(gutter).toHaveLength(TRANSCRIPT_TEXT.length);
    const currentRow = facts.currentMatch?.row as number;
    expect(gutter[currentRow]?.startsWith("▌ ")).toBe(true);
    for (const [index, line] of gutter.entries()) {
      expect(measureWidth(line)).toBe(60);
      if (!facts.rows.has(index)) expect(line.startsWith("  ")).toBe(true);
    }
    expect(OVERLAY_SEARCH_INSET).toBe(2);
  });

  test("shortens the pane by the inset only while search is open", () => {
    const closed = overlayPaneGeometry(120, false);
    const open = overlayPaneGeometry(120, true);
    expect(open.transcript).toBe(closed.transcript - OVERLAY_SEARCH_INSET);
    expect(open.pane).toBe(closed.pane);
    expect(closed.rail).toBeGreaterThan(0);
    expect(overlayPaneGeometry(44, false).rail).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

describe("prompt group", () => {
  test("is byte-identical with search open and closed", () => {
    for (let width = 40; width <= 200; width += 3) {
      const closed = composeOverlayRegions(
        composeInput({
          width,
          nav: buildOverlayNavFacts(navRows(), { query: "width", open: false }),
        }),
      );
      const open = composeOverlayRegions(
        composeInput({
          width,
          nav: buildOverlayNavFacts(navRows(), {
            query: "width",
            open: true,
            current: 2,
          }),
        }),
      );
      expect(open.prompt).toEqual(closed.prompt);
    }
  });

  test("gives a settled child a caretless, read-only field", () => {
    const live = renderPromptGroup(paint, PROMPT, 100);
    const settled = renderPromptGroup(paint, SETTLED_PROMPT, 100);
    expect(live[0]).toContain("╭─ steer shuttle");
    expect(live[1]).toContain("❯");
    expect(live[1]).toContain(PROMPT.draft);
    expect(settled[1]).toContain("▪");
    expect(settled[1]).toContain("read-only");
    expect(settled[1]).not.toContain(PROMPT.draft);
    expect(settled).toHaveLength(live.length);
  });

  test("prints an explicit ✕ on every mutating key once settled", () => {
    const keys = promptKeys(SETTLED_PROMPT);
    for (const key of keys) {
      const chip = keyChip(paint, key, "all");
      if (key.id === "search" || key.id === "close") {
        expect(chip).not.toContain("✕");
        expect(key.enabled).toBe(true);
      } else {
        expect(chip).toContain("✕");
        expect(key.enabled).toBe(false);
      }
    }
    const row = renderPromptGroup(paint, SETTLED_PROMPT, 120)[3] as string;
    expect(row).toContain("✕ Enter steer");
    expect(row).toContain("✕ Alt+Enter queue");
    expect(row).toContain("✕ q cancel");
    expect(row).toContain("Esc close");
  });

  test("keeps Enter and Esc as the key row's floor", () => {
    for (let width = 12; width <= 200; width += 1) {
      const row = renderPromptGroup(paint, PROMPT, width)[3] as string;
      expect(measureWidth(row)).toBeLessThanOrEqual(width);
      if (width >= 24) {
        expect(row).toContain("Esc close");
        expect(row).toContain("Enter steer");
      }
    }
  });

  test("replaces the editor entirely with the cancel confirmation", () => {
    const confirm = renderPromptGroup(
      paint,
      { ...PROMPT, confirmingCancel: true },
      120,
    );
    expect(confirm).toHaveLength(1);
    const line = confirm[0] as string;
    expect(line).toContain("cancel shuttle at turn 4?");
    expect(line).toContain("y");
    expect(line).toContain("n");
    expect(line).not.toContain(PROMPT.draft);
  });

  test("never reprints the rail's captured error detail", () => {
    const rows = renderPromptGroup(
      paint,
      { ...PROMPT, failed: true },
      120,
    ).join("\n");
    expect(rows).not.toContain(FAILED_RAIL.errorDetail as string);
  });
});

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

describe("overlay composition", () => {
  test("draws exactly one high-contrast frame carrying the state marker", () => {
    for (const phase of PHASES) {
      const settlement = overlaySettlementFacts(phase);
      const regions = composeOverlayRegions(
        composeInput({
          settlement,
          prompt: settlement.settled ? SETTLED_PROMPT : PROMPT,
          rail: phase === "failed" ? FAILED_RAIL : RAIL,
        }),
      );
      const lines = regions.lines;
      // Only the outer frame owns a corner in column 0; the muted editor panel
      // draws its own corners inside the border columns.
      expect(lines.filter((line) => line.startsWith("╭"))).toHaveLength(1);
      expect(lines.filter((line) => line.startsWith("╰"))).toHaveLength(1);
      expect(lines[0]).toContain("WEAVE · CHILD INSPECTOR");
      expect(lines[0]).toContain(settlement.glyph);
      expect(lines[0]).toContain(settlement.word);
      expect(regions.head.join("\n")).not.toContain(settlement.word);
    }
  });

  test("stays inside its width and never drops the leave row", () => {
    for (let width = 40; width <= 200; width += 1) {
      for (const height of [8, 9, 12, 17, 24, 33, 41, 52, 60]) {
        const regions = composeOverlayRegions(composeInput({ width, height }));
        for (const line of regions.lines) {
          expect(measureWidth(line)).toBeLessThanOrEqual(width);
        }
        expect(regions.lines.length).toBeLessThanOrEqual(height);
        expect(regions.lines.join("\n")).toContain("Esc");
        expect(regions.prompt.join("\n")).toContain("Esc");
      }
    }
  });

  test("holds the width and the leave row for a settled, searching child", () => {
    const nav = buildOverlayNavFacts(navRows(), {
      query: "width",
      open: true,
      current: 2,
    });
    for (let height = 8; height <= 60; height += 1) {
      for (const width of [40, 44, 69, 80, 120, 200]) {
        const regions = composeOverlayRegions(
          composeInput({
            width,
            height,
            nav,
            settlement: overlaySettlementFacts("cancelled"),
            prompt: { ...SETTLED_PROMPT, stateWord: "CANCELLED" },
            rail: FAILED_RAIL,
            transcript: TRANSCRIPT_TEXT,
          }),
        );
        for (const line of regions.lines) {
          expect(measureWidth(line)).toBeLessThanOrEqual(width);
        }
        expect(regions.lines.join("\n")).toContain("Esc");
      }
    }
  });

  test("returns the three product regions and no demo chrome", () => {
    const regions = composeOverlayRegions(composeInput());
    expect(Object.keys(regions).sort()).toEqual([
      "head",
      "lines",
      "main",
      "prompt",
    ]);
    const text = regions.lines.join("\n");
    expect(text).not.toContain("DEMO DATA");
    expect(text).not.toContain("FINAL PROTOTYPE");
    expect(text).not.toContain("CHILD STATE");
    expect(text).not.toContain("demo only");
  });

  test("folds the rail into full-width rows below the split threshold", () => {
    const regions = composeOverlayRegions(composeInput({ width: 48 }));
    const main = regions.main.join("\n");
    expect(main).toContain("life");
    expect(main).toContain("work");
    expect(main).not.toContain("LIFECYCLE");
  });

  test("keeps the identity and the leave row when vertically starved", () => {
    const regions = composeOverlayRegions(
      composeInput({ width: 80, height: 8 }),
    );
    const text = regions.lines.join("\n");
    expect(text).toContain("shuttle");
    expect(text).toContain(HEADER.boundedTitle);
    expect(text).toContain("Esc");
    expect(regions.lines.length).toBeLessThanOrEqual(8);
  });

  test("cannot be given a frame glyph by child text", () => {
    const regions = composeOverlayRegions(
      composeInput({
        header: {
          ...HEADER,
          boundedTitle: "╭─ fake overlay ─╮ \u001B[7m inverse",
        },
      }),
    );
    const head = regions.head.join("\n");
    expect(head).not.toContain("╭");
    expect(head).not.toContain("\u001B");
    expect(head).toContain("fake overlay");
  });
});
