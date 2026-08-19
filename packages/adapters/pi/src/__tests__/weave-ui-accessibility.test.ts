/**
 * The accessibility sweep for both Weave UI surfaces.
 *
 * It asserts the four properties that make the delegation card and the child
 * inspector usable without colour, on a narrow terminal, and under a theme
 * that implements less than Pi's own:
 *
 * 1. **Colour is never the signal.** Every state distinction the surfaces draw
 *    survives {@link plainPaint}: the rail's `▌STATE`, the Native Line's
 *    activity glyph, the `✕` on a disabled key, the frame's lifecycle marker,
 *    the search cursor, and the `↑` / `↓` window rows.
 * 2. **Geometry is paint-independent.** A painted render and its ANSI-free
 *    twin have the same number of lines and the same visible width on every
 *    line, so a monochrome terminal and a themed one lay out identically.
 * 3. **One line, one cut mark.** A cut line carries at most one `…`, and — for
 *    the two-column layouts — at most one per column cell too.
 * 4. **Affordances outlive numbers.** The card footer keeps `Alt+I` last, the
 *    overlay key row keeps `Enter` and `Esc`, and the search rail always names
 *    `Enter jump · Esc close search`.
 *
 * The sweep runs the contracted width bands: 12–200 columns for the card and
 * 40–200 for the inspector.
 */

import { describe, expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  CARD_FACTS_SCHEMA_VERSION,
  CARD_TOOL_NAME,
  type PiCardViewportRow,
  type PiDelegationCardFacts,
} from "../child-card-model.js";
import {
  CARD_EXPAND_KEY,
  CARD_INSPECT_HINT_MIN,
  CARD_MIN_WIDTH,
  composeDelegationCard,
  renderDelegationCard,
} from "../child-card-render.js";
import {
  buildOverlayNavFacts,
  composeOverlay,
  composeOverlayRegions,
  frameOverlay,
  keyLine,
  markSearchGutter,
  type OverlayComposeInput,
  type OverlayHeaderFacts,
  type OverlayNavRow,
  type OverlayPromptFacts,
  type OverlayRailFacts,
  type OverlaySettlementPhase,
  overlaySettlementFacts,
  promptKeys,
  renderPromptGroup,
  searchRailSections,
  transcriptWindow,
} from "../child-overlay-layout.js";
import { measureWidth } from "../render-width.js";
import type { PiUiThemePort } from "../types.js";
import { makePaint, type Paint, plainPaint } from "../ui-paint.js";
import { emit } from "../ui-rows.js";

// ---------------------------------------------------------------------------
// Paints
// ---------------------------------------------------------------------------

const PLAIN = plainPaint();

/** ANSI wrappers only: colour must never change a column count. */
const wrap = (text: string): string => `\u001B[38;5;42m${text}\u001B[39m`;

/** A theme that implements everything the port allows. */
const FULL_THEME: PiUiThemePort = {
  fg: (_color, text) => wrap(text),
  bold: (text) => `\u001B[1m${text}\u001B[22m`,
  inverse: (text) => `\u001B[7m${text}\u001B[27m`,
};

/** A stand-in with no `inverse()`. The documented degradation is `bold`. */
const NO_INVERSE_THEME: PiUiThemePort = {
  fg: FULL_THEME.fg,
  bold: FULL_THEME.bold,
};

/**
 * A stand-in that does not support `searchMatchText`.
 *
 * In Pi 0.83 `searchMatchText` is a `Theme.fg` TOKEN, not a method, and a
 * theme that omits it resolves it to ordinary text inside the host. This
 * models that: the token is accepted and painted as plain text.
 */
const NO_SEARCH_MATCH_THEME: PiUiThemePort = {
  fg: (color, text) => (color === "searchMatchText" ? text : wrap(text)),
  bold: FULL_THEME.bold,
  inverse: FULL_THEME.inverse,
};

const PAINTS: ReadonlyArray<{ readonly id: string; readonly paint: Paint }> = [
  { id: "full", paint: makePaint(FULL_THEME) },
  { id: "no-inverse", paint: makePaint(NO_INVERSE_THEME) },
  { id: "no-search-match", paint: makePaint(NO_SEARCH_MATCH_THEME) },
];

// ---------------------------------------------------------------------------
// Shared assertions
// ---------------------------------------------------------------------------

const CUT_MARK = "…";

function cutMarks(line: string): number {
  return line.split(CUT_MARK).length - 1;
}

/**
 * The column cells of one composed line.
 *
 * `│` is the only column separator either surface draws, so splitting on it
 * yields the frame rails plus one cell per column.
 */
function columnCells(line: string): readonly string[] {
  return line.split("│");
}

const CARD_WIDTHS: readonly number[] = Array.from(
  { length: 189 },
  (_unused, index) => index + CARD_MIN_WIDTH,
);

const OVERLAY_WIDTHS: readonly number[] = Array.from(
  { length: 161 },
  (_unused, index) => index + 40,
);

// ---------------------------------------------------------------------------
// Card fixtures
// ---------------------------------------------------------------------------

function viewportRows(count: number): readonly PiCardViewportRow[] {
  const kinds = ["boot", "msg", "think", "tool", "result"] as const;
  return Array.from({ length: count }, (_unused, index) => ({
    kind: kinds[index % kinds.length] as PiCardViewportRow["kind"],
    head: `head ${index}`,
    text: `transcript row ${index} with a reasonable amount of prose in it so that every width has something to cut`,
  }));
}

function cardFacts(
  over: Partial<PiDelegationCardFacts> = {},
): PiDelegationCardFacts {
  return {
    schemaVersion: CARD_FACTS_SCHEMA_VERSION,
    tool: CARD_TOOL_NAME,
    // Deliberately longer than the rail column: the rail must cut it without
    // spending the line's single cut mark on it.
    agentName: "shuttle-implementer",
    model: "gpt-5.6-sol",
    run: { number: 1, action: "start", phase: "reasoning" },
    status: "running",
    tone: "run",
    settled: false,
    assignment:
      "Sweep the delegation card and the child inspector for monochrome legibility at every contracted width.",
    activity: {
      kind: "think",
      text: "Reserving the trailing status suffix before the title truncates.",
      live: true,
    },
    telemetry: { elapsed: "38s", tokens: "4.2k tok", cost: "$0.03" },
    viewport: { rows: viewportRows(9), above: 12, atBottom: true },
    ...over,
  };
}

interface CardState {
  readonly id: string;
  readonly glyph: string;
  readonly word: string;
  readonly facts: PiDelegationCardFacts;
}

const CARD_STATES: readonly CardState[] = [
  {
    id: "bootstrap",
    glyph: "◇",
    word: "STARTING",
    facts: cardFacts({
      status: "starting",
      run: { number: 1, action: "start", phase: "bootstrap" },
      activity: {
        kind: "boot",
        text: "provisioning child thread · tool policy inherited",
        live: true,
      },
    }),
  },
  { id: "reasoning", glyph: "⤷", word: "RUNNING", facts: cardFacts() },
  {
    id: "tool-call",
    glyph: "⏵",
    word: "RUNNING",
    facts: cardFacts({
      run: { number: 1, action: "start", phase: "tool call" },
      activity: {
        kind: "tool",
        text: "edit · child-overlay-component.ts · 1 replacement · +6 −3",
        live: true,
      },
    }),
  },
  {
    id: "tool-error",
    glyph: "✕",
    word: "RUNNING",
    facts: cardFacts({
      tone: "bad",
      run: { number: 1, action: "start", phase: "tool error" },
      activity: {
        kind: "error",
        text: "bash · bun test --filter overlay · 23 pass · 1 fail at width 41",
        live: false,
      },
    }),
  },
  {
    id: "steered",
    glyph: "⇥",
    word: "STEERED",
    facts: cardFacts({
      status: "steered",
      tone: "warn",
      run: { number: 1, action: "start", phase: "steered" },
      activity: {
        kind: "queue",
        text: "1 queued · from LOOM: keep the 40 to 200 column sweep green",
        live: true,
      },
    }),
  },
  {
    id: "completed",
    glyph: "✓",
    word: "COMPLETED",
    facts: cardFacts({
      status: "completed",
      tone: "ok",
      settled: true,
      activity: {
        kind: "reply",
        text: "Reserved the trailing suffix. Width sweep green from 12 to 200 columns.",
        live: false,
      },
    }),
  },
  {
    id: "cancelled",
    glyph: "⊘",
    word: "CANCELLED",
    facts: cardFacts({
      status: "cancelled",
      tone: "mute",
      settled: true,
      activity: {
        kind: "cancel",
        text: "cancelled by the parent before the first tool call",
        live: false,
      },
    }),
  },
];

function cardLines(
  facts: PiDelegationCardFacts,
  width: number,
  expanded: boolean,
  paint: Paint = PLAIN,
): readonly string[] {
  return renderDelegationCard(facts, { width, expanded, paint });
}

// ---------------------------------------------------------------------------
// Overlay fixtures
// ---------------------------------------------------------------------------

const OVERLAY_HEADER: OverlayHeaderFacts = {
  name: "shuttle",
  model: "gpt-5.6-sol",
  role: "implementer",
  boundedTitle: "sweep both surfaces for monochrome legibility",
  parent: "LOOM",
  plan: "pi weave ui redesign",
  taskCrumb: "task 13/19 accessibility and narrow terminals",
  subtask: "the width sweep",
};

const OVERLAY_RAIL: OverlayRailFacts = {
  status: "RUNNING",
  tone: "run",
  elapsed: "2m 14s",
  turn: "4",
  run: "run 2",
  branch: "weave/ui",
  live: "editing child-overlay-layout.ts near the fixed-field cutter",
  tool: "edit",
  target: "packages/adapters/pi/src/child-overlay-layout.ts",
  args: "range 40-96 with a deliberately long argument summary",
  toolOutcome: "applied 2 edits to the fixed-field cutter",
  toolTone: "ok",
  failed: false,
  queueCount: 1,
  firstQueued: "also assert the 200-column case end to end",
  tokensIn: "18420",
  tokensOut: "3120",
  cost: "$0.42",
};

const OVERLAY_FAILED_RAIL: OverlayRailFacts = {
  ...OVERLAY_RAIL,
  status: "TOOL ERROR",
  tone: "bad",
  toolTone: "bad",
  failed: true,
  toolOutcome: "exit 1",
  errorDetail: "the width assertion failed on the 200 column case",
};

const OVERLAY_PROMPT: OverlayPromptFacts = {
  target: "shuttle",
  turn: 4,
  settled: false,
  failed: false,
  queueCount: 1,
  draft: "also assert the 200-column case",
  stateWord: "RUNNING",
  confirmingCancel: false,
};

const OVERLAY_SETTLED_PROMPT: OverlayPromptFacts = {
  ...OVERLAY_PROMPT,
  settled: true,
  stateWord: "COMPLETED",
  queueCount: 0,
};

const OVERLAY_TRANSCRIPT: readonly string[] = [
  "· child session started",
  "❯ sweep both surfaces for monochrome legibility at every contracted width",
  "✻ summary · reading the prototype first and taking notes on the fitters",
  "⚙ read · prototypes/weave-pi-tui-grilling.ts",
  "  read 3678 lines",
  "⚙ edit · child-overlay-layout.ts",
  "  the width contract holds at every width from forty through two hundred columns",
  "● every emitted row respects its width",
  "● final response · both surfaces are legible without colour",
];

const OVERLAY_NAV_ROWS: readonly OverlayNavRow[] = OVERLAY_TRANSCRIPT.map(
  (line, index) => ({
    painted: line,
    plain: line,
    label: index % 2 === 0 ? "tool" : "assistant",
    at: `14:24:0${index}`,
  }),
);

const PHASES: readonly OverlaySettlementPhase[] = [
  "live",
  "queued",
  "failed",
  "completed",
  "cancelled",
  "recovering",
];

function overlayInput(
  overrides: Partial<OverlayComposeInput> = {},
): OverlayComposeInput {
  const nav =
    overrides.nav ??
    buildOverlayNavFacts(OVERLAY_NAV_ROWS, { query: "width", open: false });
  return {
    width: 120,
    height: 32,
    paint: PLAIN,
    header: OVERLAY_HEADER,
    rail: OVERLAY_RAIL,
    prompt: OVERLAY_PROMPT,
    settlement: overlaySettlementFacts("live"),
    transcript: OVERLAY_TRANSCRIPT,
    ...overrides,
    nav,
  };
}

function overlayForPhase(
  phase: OverlaySettlementPhase,
  width: number,
  paint: Paint,
  searchOpen: boolean,
): readonly string[] {
  const settlement = overlaySettlementFacts(phase);
  return composeOverlay(
    overlayInput({
      width,
      paint,
      settlement,
      rail: phase === "failed" ? OVERLAY_FAILED_RAIL : OVERLAY_RAIL,
      prompt: settlement.settled ? OVERLAY_SETTLED_PROMPT : OVERLAY_PROMPT,
      nav: buildOverlayNavFacts(OVERLAY_NAV_ROWS, {
        query: "width",
        open: searchOpen,
      }),
    }),
  );
}

// ---------------------------------------------------------------------------
// 1. Monochrome legibility
// ---------------------------------------------------------------------------

describe("monochrome legibility", () => {
  test("the card rail states the state word behind a printed bar", () => {
    for (const state of CARD_STATES) {
      for (const width of CARD_WIDTHS) {
        const text = cardLines(state.facts, width, false).join("\n");
        // The bar is the state's only colour-free signal, so it survives every
        // width, including the folded identity row below the rail's floor.
        expect(text).toContain("▌");
        // The word itself survives every width that can hold it: the rail cuts
        // the child name and elapsed long before it touches the state.
        if (width >= 16) expect(text).toContain(state.word);
      }
    }
  });

  test("the renderer-only reasoning line names its activity with a glyph", () => {
    const liveReasoningLine = "↪ reasoning • bounded raw reasoning";
    for (const state of CARD_STATES) {
      for (const width of [24, 40, 60, 96, 140, 200]) {
        const output = renderDelegationCard(state.facts, {
          width,
          expanded: false,
          paint: PLAIN,
          liveReasoningLine,
        }).join("\n");
        expect(output).toContain("↪");
        if (width >= 40) expect(output).toContain("↪ reasoning");
      }
    }
  });

  test("the card states live reasoning with a printed marker", () => {
    const live = cardFacts();
    const settled = cardFacts({
      settled: true,
      activity: { kind: "reply", text: "done", live: false },
    });
    for (const width of [40, 60, 96, 140, 200]) {
      expect(
        renderDelegationCard(live, {
          width,
          expanded: false,
          paint: PLAIN,
          liveReasoningLine: "↪ reasoning • live",
        }).join("\n"),
      ).toContain("↪");
      expect(
        renderDelegationCard(settled, {
          width,
          expanded: false,
          paint: PLAIN,
        }).join("\n"),
      ).not.toContain("↪");
    }
  });

  test("every card lifecycle state remains legible in plain text", () => {
    for (const width of [40, 80, 120, 200]) {
      const rendered = CARD_STATES.map((state) =>
        cardLines(state.facts, width, false).join("\n"),
      );
      // At the narrow rail width the three ordinary running phases share the
      // same visible shell; wider cards retain their distinct footer phase.
      const expectedStates = width < 80 ? 5 : CARD_STATES.length;
      expect(new Set(rendered).size).toBe(expectedStates);
    }
  });

  test("the overlay frame marks its lifecycle with a glyph and a word", () => {
    for (const phase of PHASES) {
      const settlement = overlaySettlementFacts(phase);
      const top = overlayForPhase(phase, 120, PLAIN, false)[0] as string;
      expect(top).toContain(settlement.glyph);
      expect(top).toContain(settlement.word);
    }
  });

  test("every overlay lifecycle reads differently in plain text", () => {
    for (const width of [44, 80, 120, 200]) {
      const rendered = PHASES.map((phase) =>
        overlayForPhase(phase, width, PLAIN, false).join("\n"),
      );
      expect(new Set(rendered).size).toBe(PHASES.length);
    }
  });

  test("a disabled key carries a printed ✕, not only a dim colour", () => {
    for (const width of [40, 60, 96, 140, 200]) {
      const settled = renderPromptGroup(
        PLAIN,
        OVERLAY_SETTLED_PROMPT,
        width,
      ).join("\n");
      expect(settled).toContain("✕");
      const live = renderPromptGroup(PLAIN, OVERLAY_PROMPT, width).join("\n");
      expect(live).not.toContain("✕");
    }
  });

  test("the search gutter marks the current match with a printed cursor", () => {
    const nav = buildOverlayNavFacts(OVERLAY_NAV_ROWS, {
      query: "width",
      open: true,
    });
    const gutter = markSearchGutter(PLAIN, nav, [...OVERLAY_TRANSCRIPT], 60);
    const current = nav.currentMatch?.row as number;
    expect(gutter[current]?.startsWith("▌ ")).toBe(true);
    const other = [...nav.rows].find((row) => row !== current);
    if (other !== undefined) expect(gutter[other]?.startsWith("· ")).toBe(true);
    const unmatched = gutter.findIndex((_line, row) => !nav.rows.has(row));
    expect(gutter[unmatched]?.startsWith("  ")).toBe(true);
  });

  test("the transcript window states both directions with ↑ and ↓ rows", () => {
    const lines = Array.from({ length: 40 }, (_u, i) => `row ${i}`);
    const anchored = transcriptWindow(PLAIN, lines, 60, 9, 20);
    expect(anchored[0]).toContain("↑");
    expect(anchored[anchored.length - 1]).toContain("↓");
    const tail = transcriptWindow(PLAIN, lines, 60, 9, undefined);
    expect(tail[0]).toContain("↑");
  });

  test("the expanded card keeps the parent boundary free of child scrollback", () => {
    const text = cardLines(cardFacts(), 96, true).join("\n");
    expect(text).toContain("LIVE · following bottom");
    expect(text).not.toContain("↑");
    expect(text).not.toContain("transcript row");
  });
});

// ---------------------------------------------------------------------------
// 2. Paint-independent geometry
// ---------------------------------------------------------------------------

describe("paint-independent geometry", () => {
  test("card widths 12–200 render identically painted and plain", () => {
    for (const state of CARD_STATES) {
      for (const width of CARD_WIDTHS) {
        for (const expanded of [false, true]) {
          const plain = cardLines(state.facts, width, expanded, PLAIN);
          for (const { id, paint } of PAINTS) {
            const painted = cardLines(state.facts, width, expanded, paint);
            expect(`${id} ${state.id} ${width} ${painted.length}`).toBe(
              `${id} ${state.id} ${width} ${plain.length}`,
            );
            painted.forEach((line, index) => {
              expect(measureWidth(line)).toBe(
                measureWidth(plain[index] as string),
              );
              expect(measureWidth(line)).toBeLessThanOrEqual(width);
            });
          }
        }
      }
    }
  });

  test("overlay widths 40–200 render identically painted and plain", () => {
    for (const phase of PHASES) {
      for (const width of OVERLAY_WIDTHS) {
        const plain = overlayForPhase(phase, width, PLAIN, false);
        for (const { id, paint } of PAINTS) {
          const painted = overlayForPhase(phase, width, paint, false);
          expect(`${id} ${phase} ${width} ${painted.length}`).toBe(
            `${id} ${phase} ${width} ${plain.length}`,
          );
          painted.forEach((line, index) => {
            expect(measureWidth(line)).toBe(
              measureWidth(plain[index] as string),
            );
            expect(measureWidth(line)).toBeLessThanOrEqual(width);
          });
        }
      }
    }
  });

  test("an open search keeps the same geometry under every paint", () => {
    for (const width of OVERLAY_WIDTHS) {
      const plain = overlayForPhase("live", width, PLAIN, true);
      for (const { paint } of PAINTS) {
        const painted = overlayForPhase("live", width, paint, true);
        expect(painted.length).toBe(plain.length);
        painted.forEach((line, index) => {
          expect(measureWidth(line)).toBe(measureWidth(plain[index] as string));
        });
      }
    }
  });

  test("the missing-inverse degradation changes ink, never columns", () => {
    const full = makePaint(FULL_THEME);
    const degraded = makePaint(NO_INVERSE_THEME);
    expect(measureWidth(degraded.inv(" CHILD "))).toBe(
      measureWidth(full.inv(" CHILD ")),
    );
    expect(degraded.inv("x")).toBe(degraded.bold("x"));
  });

  test("the searchMatchText token is asked for unconditionally", () => {
    const asked: string[] = [];
    const paint = makePaint({
      fg: (color, text) => {
        asked.push(color);
        return text;
      },
      bold: (text) => text,
    });
    expect(paint.match("hit")).toBe("hit");
    expect(asked).toContain("searchMatchText");
  });
});

// ---------------------------------------------------------------------------
// 3. One line, one cut mark
// ---------------------------------------------------------------------------

describe("truncation", () => {
  test("no card line carries more than one cut mark", () => {
    for (const state of CARD_STATES) {
      for (const width of CARD_WIDTHS) {
        for (const expanded of [false, true]) {
          for (const line of cardLines(state.facts, width, expanded)) {
            expect(`${state.id} ${width} ${line}`).toBe(
              cutMarks(line) <= 1 ? `${state.id} ${width} ${line}` : "",
            );
          }
        }
      }
    }
  });

  test("no overlay line carries more than one cut mark", () => {
    for (const phase of PHASES) {
      for (const searchOpen of [false, true]) {
        for (const width of OVERLAY_WIDTHS) {
          for (const line of overlayForPhase(phase, width, PLAIN, searchOpen)) {
            expect(`${phase} ${width} ${line}`).toBe(
              cutMarks(line) <= 1 ? `${phase} ${width} ${line}` : "",
            );
            for (const region of columnCells(line)) {
              expect(cutMarks(region)).toBeLessThanOrEqual(1);
            }
          }
        }
      }
    }
  });

  test("the card rail cuts flush so the body keeps the line's mark", () => {
    // 34 columns: the rail is present, the child name is longer than the rail,
    // and the assignment beside it must be cut in the body column.
    const rows = composeDelegationCard(cardFacts(), 34, false);
    const taskRow = rows.find((row) => row.slot === "task");
    const line = emit(taskRow?.row ?? [], 34, PLAIN);
    expect(line).toContain("…");
    expect(cutMarks(line)).toBe(1);
  });

  test("the live reasoning mark is reserved, never cut away", () => {
    for (const width of CARD_WIDTHS) {
      const line = renderDelegationCard(cardFacts(), {
        width,
        expanded: false,
        paint: PLAIN,
        liveReasoningLine: "↪ reasoning • live",
      }).find((candidate) => candidate.includes("↪"));
      expect(line).toBeDefined();
      expect(line as string).toContain("↪");
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Borders
// ---------------------------------------------------------------------------

describe("borders", () => {
  test("the card draws exactly one frame and never nests a second", () => {
    for (const state of CARD_STATES) {
      for (const width of CARD_WIDTHS) {
        for (const expanded of [false, true]) {
          const text = cardLines(state.facts, width, expanded).join("\n");
          expect(text.split("╭").length - 1).toBe(1);
          expect(text.split("╮").length - 1).toBe(1);
          expect(text.split("╰").length - 1).toBe(1);
          expect(text.split("╯").length - 1).toBe(1);
        }
      }
    }
  });

  test("the overlay keeps one outer frame at every contracted width", () => {
    for (const width of OVERLAY_WIDTHS) {
      const lines = overlayForPhase("live", width, PLAIN, false);
      expect((lines[0] as string).startsWith("╭")).toBe(true);
      expect((lines[lines.length - 1] as string).startsWith("╰")).toBe(true);
      // The inner editor panel is the only other box, and it is drawn in the
      // muted rule ink rather than the frame ink.
      const outer = lines.filter((line) => line.startsWith("╭")).length;
      expect(outer).toBe(1);
    }
  });

  test("a border is dropped rather than allowed to overflow", () => {
    for (const width of [0, 1, 2, 3]) {
      const framed = frameOverlay(PLAIN, ["content"], width, {
        title: " WEAVE ",
        marker: " ● RUNNING ",
        markerTone: "run",
      });
      for (const line of framed) {
        expect(measureWidth(line)).toBeLessThanOrEqual(Math.max(0, width));
        expect(line).not.toContain("╭");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Discoverability
// ---------------------------------------------------------------------------

describe("discoverability", () => {
  test("Alt+I is the last hint standing in the card footer", () => {
    for (const state of CARD_STATES) {
      for (const width of CARD_WIDTHS) {
        const footer = cardLines(state.facts, width, false).at(-1) as string;
        if (footer.includes(CARD_EXPAND_KEY)) {
          expect(footer).toContain(CARD_INSPECT_HINT_MIN);
        }
      }
    }
    const surviving = CARD_WIDTHS.filter((width) =>
      (cardLines(cardFacts(), width, false).at(-1) as string).includes(
        CARD_INSPECT_HINT_MIN,
      ),
    );
    expect(surviving.length).toBeGreaterThan(0);
    const narrowest = Math.min(...surviving);
    const line = cardLines(cardFacts(), narrowest, false).at(-1) as string;
    expect(line).not.toContain(CARD_EXPAND_KEY);
  });

  test("the overlay key row keeps Enter and Esc at every width", () => {
    for (const width of OVERLAY_WIDTHS) {
      for (const facts of [OVERLAY_PROMPT, OVERLAY_SETTLED_PROMPT]) {
        const row = keyLine(PLAIN, promptKeys(facts), width);
        expect(row).toContain("Enter");
        expect(row).toContain("Esc");
      }
    }
  });

  test("the search rail always names Enter jump · Esc close search", () => {
    const nav = buildOverlayNavFacts(OVERLAY_NAV_ROWS, {
      query: "width",
      open: true,
    });
    for (const rail of [30, 34, 38, 42]) {
      const section = searchRailSections(PLAIN, nav, rail)
        .flatMap((rows) => [...rows])
        .join("\n");
      expect(section).toContain("Enter jump · Esc close search");
    }
  });

  test("an open search never removes the prompt's own keys", () => {
    for (const width of [80, 120, 200]) {
      const open = composeOverlayRegions(
        overlayInput({
          width,
          nav: buildOverlayNavFacts(OVERLAY_NAV_ROWS, {
            query: "width",
            open: true,
          }),
        }),
      );
      const closed = composeOverlayRegions(overlayInput({ width }));
      expect(open.prompt.join("\n")).toBe(closed.prompt.join("\n"));
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Focus
// ---------------------------------------------------------------------------

describe("focus", () => {
  test("the overlay editor is focused on mount", async () => {
    initTheme("default");
    const { createChildOverlayController, createMemoryChildOverlaySource } =
      await import("../child-overlay.js");
    const { createChildOverlayCustomComponent } = await import(
      "../child-overlay-component.js"
    );
    const { TUI, getKeybindings } = await import("@earendil-works/pi-tui");

    const source = createMemoryChildOverlaySource([
      {
        childId: "a11y-child",
        threadId: "a11y-child",
        status: "live",
        title: "accessibility sweep",
        generationId: "gen-1",
        parentChildId: undefined,
        runs: [{ run: 1, action: "start" }],
        branchIds: ["main"],
        descendantChildIds: [],
        entries: [
          {
            id: "e0",
            payload: {
              type: "message",
              id: "e0",
              parentId: null,
              timestamp: "2026-01-01T00:00:00.000Z",
              message: { role: "user", content: "sweep the surfaces" },
            },
          },
        ],
      },
    ]);
    const controller = createChildOverlayController(source, { pageSize: 10 });
    const opened = await controller.open("a11y-child");
    expect(opened.isOk()).toBe(true);
    const tui = Object.assign(
      Object.create(TUI.prototype) as InstanceType<typeof TUI>,
      { terminal: { rows: 40 }, requestRender: () => {} },
    );
    const component = createChildOverlayCustomComponent(
      tui,
      FULL_THEME,
      getKeybindings() as never,
      controller,
      () => {},
      () => {},
      { cwd: "/workspace" },
    );
    expect(component.focused).toBe(true);
  });

  test("closing never touches the host's editor component", async () => {
    // The mounted overlay owns input through `ui.custom`; installing an editor
    // component would displace whatever primary editor the host already had.
    const source = await Bun.file(
      new URL("../child-overlay-component.ts", import.meta.url),
    ).text();
    expect(source).not.toContain("setEditorComponent");
  });
});
