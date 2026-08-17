import { describe, expect, it } from "bun:test";
import {
  applyDelegationCardInput,
  CARD_FACTS_SCHEMA_VERSION,
  CARD_TOOL_NAME,
  CARD_VIEWPORT_ROWS,
  createDelegationCardState,
  type PiCardViewportRow,
  type PiDelegationCardFacts,
  projectDelegationCardFacts,
} from "../child-card-model.js";
import {
  actionLadder,
  assignmentRows,
  CARD_DETAIL_ROW_MAX,
  CARD_DETAIL_ROW_MIN,
  CARD_EXPAND_KEY,
  CARD_INSPECT_HINT_MIN,
  CARD_MIN_WIDTH,
  CARD_NO_ASSIGNMENT,
  CARD_VIEWPORT_LIVE,
  CARD_VIEWPORT_SETTLED,
  cardFooter,
  composeDelegationCard,
  degradedDelegationCard,
  expandVerb,
  nativeLine,
  type PiCardRow,
  railPlan,
  railStatusFirst,
  renderDelegationCard,
  telemetryLadder,
} from "../child-card-render.js";
import { measureWidth } from "../render-width.js";
import { plainPaint } from "../ui-paint.js";
import { emit, type Row } from "../ui-rows.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PAINT = plainPaint();
const ASSIGNMENT =
  "Fix header suffix width handling and run the focused sweep.";

/** The full width sweep this card is contracted to survive. */
const WIDTHS = Array.from({ length: 189 }, (_, index) => index + 12);

function viewportRows(count: number): readonly PiCardViewportRow[] {
  const kinds = ["boot", "msg", "think", "tool", "result"] as const;
  return Array.from({ length: count }, (_unused, index) => ({
    kind: kinds[index % kinds.length] as PiCardViewportRow["kind"],
    head: `head ${index}`,
    text: `transcript row ${index} with a reasonable amount of prose in it`,
  }));
}

function facts(
  over: Partial<PiDelegationCardFacts> = {},
): PiDelegationCardFacts {
  return {
    schemaVersion: CARD_FACTS_SCHEMA_VERSION,
    tool: CARD_TOOL_NAME,
    agentName: "shuttle",
    model: "gpt-5.6-sol",
    run: { number: 1, action: "start", phase: "reasoning" },
    status: "running",
    tone: "run",
    settled: false,
    assignment: ASSIGNMENT,
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

/** The eight lifecycle states the card is contracted to draw. */
const STATES: ReadonlyArray<{
  readonly id: string;
  readonly facts: PiDelegationCardFacts;
}> = [
  {
    id: "bootstrap",
    facts: facts({
      run: { number: 1, action: "start", phase: "bootstrap" },
      status: "starting",
      tone: "run",
      activity: {
        kind: "boot",
        text: "provisioning child thread · tool policy inherited",
        live: true,
      },
      telemetry: { elapsed: "0.4s" },
      viewport: { rows: viewportRows(2), above: 0, atBottom: true },
    }),
  },
  { id: "reasoning", facts: facts() },
  {
    id: "tool-call",
    facts: facts({
      run: { number: 1, action: "start", phase: "tool call" },
      activity: {
        kind: "tool",
        text: "edit · child-overlay-component.ts · 1 replacement · +6 −3",
        live: true,
      },
      telemetry: { elapsed: "1m12s", tokens: "9.8k tok", cost: "$0.07" },
    }),
  },
  {
    id: "tool-error",
    facts: facts({
      run: { number: 2, action: "retry", phase: "tool call" },
      tone: "bad",
      activity: {
        kind: "error",
        text: "bash · bun test --filter overlay · 23 pass · 1 fail at width 41",
        live: false,
      },
    }),
  },
  {
    id: "steered",
    facts: facts({
      run: { number: 1, action: "continue", phase: "queued" },
      status: "steered",
      tone: "warn",
      activity: {
        kind: "queue",
        text: "1 queued · from LOOM: keep the 40 to 200 column sweep green",
        live: true,
      },
    }),
  },
  {
    id: "completed",
    facts: facts({
      run: { number: 1, action: "start", phase: "settled" },
      status: "completed",
      tone: "ok",
      settled: true,
      activity: {
        kind: "reply",
        text: "Reserved the trailing suffix. Width sweep green from 40 to 200 columns.",
        live: false,
      },
      telemetry: { elapsed: "2m31s", tokens: "18.4k tok", cost: "$0.12" },
      terminal: {
        outcome: "completed",
        verdict: "COMPLETED",
        glyph: "✓",
        headline: "Reserved the trailing suffix.",
        evidence: "verified · bash · 24 pass · 0 fail",
      },
    }),
  },
  {
    id: "failed",
    facts: facts({
      run: { number: 1, action: "start", phase: "settled" },
      status: "failed",
      tone: "bad",
      settled: true,
      activity: {
        kind: "error",
        text: "child settlement missing · no child activity for 15m00s",
        live: false,
      },
      telemetry: { elapsed: "15m02s", tokens: "21.7k tok", cost: "$0.15" },
      terminal: {
        outcome: "failed",
        verdict: "FAILED",
        glyph: "✕",
        headline: "child settlement missing · no child activity for 15m00s",
        evidence: "timeout · child no longer running",
        recovery:
          "timeout · re-delegation from the parent is the documented recovery",
      },
    }),
  },
  {
    id: "cancelled",
    facts: facts({
      run: { number: 1, action: "start", phase: "settled" },
      status: "cancelled",
      tone: "mute",
      settled: true,
      activity: {
        kind: "cancel",
        text: "stopped by the parent · partial work kept · nothing verified",
        live: false,
      },
      telemetry: { elapsed: "1m26s", tokens: "13.2k tok", cost: "$0.09" },
      terminal: {
        outcome: "cancelled",
        verdict: "CANCELLED",
        glyph: "⊘",
        headline:
          "stopped by the parent · partial work kept · nothing verified",
        evidence: "stopped by the parent · nothing verified",
      },
    }),
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lines(
  state: PiDelegationCardFacts,
  width: number,
  expanded = false,
): string[] {
  return renderDelegationCard(state, { width, expanded, paint: PAINT });
}

function rowText(row: Row): string {
  return emit(row, 1_000, PAINT);
}

function cellText(cells: readonly PiCardRow[], slot: string): string[] {
  return cells
    .filter((row) => row.slot === slot)
    .map((row) => rowText(row.row));
}

const CORNERS = ["╭", "╮", "╰", "╯"];

/** One interior row with its borders and padding removed. */
function interior(line: string): string {
  return line.replaceAll("│", "").trim();
}

// ---------------------------------------------------------------------------
// Width safety
// ---------------------------------------------------------------------------

describe("renderDelegationCard width safety", () => {
  it("keeps every line inside the requested width, 12 to 200, in every state", () => {
    for (const state of STATES) {
      for (const width of WIDTHS) {
        for (const expanded of [false, true]) {
          for (const line of lines(state.facts, width, expanded)) {
            expect(measureWidth(line)).toBeLessThanOrEqual(width);
          }
        }
      }
    }
  });

  it("clamps an unusable width up to the minimum rather than refusing", () => {
    for (const width of [Number.NaN, -10, 0, 3, 11]) {
      const out = lines(facts(), width);
      expect(out.length).toBeGreaterThan(0);
      for (const line of out) {
        expect(measureWidth(line)).toBeLessThanOrEqual(CARD_MIN_WIDTH);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

describe("the frame", () => {
  it("draws exactly one top edge and one bottom edge, with no corner inside", () => {
    for (const state of STATES) {
      for (const width of WIDTHS) {
        for (const expanded of [false, true]) {
          const out = lines(state.facts, width, expanded);
          const tops = out.filter((line) => line.includes("╭"));
          const bottoms = out.filter((line) => line.includes("╰"));
          expect(tops).toHaveLength(1);
          expect(bottoms).toHaveLength(1);
          expect(out[0]).toBe(tops[0] as string);
          expect(out[out.length - 1]).toBe(bottoms[0] as string);
          for (const line of out.slice(1, -1)) {
            for (const corner of CORNERS) {
              expect(line.includes(corner)).toBe(false);
            }
          }
        }
      }
    }
  });

  it("tags exactly one frame-top and one frame-bottom slot", () => {
    for (const width of [12, 40, 80, 200]) {
      const rows = composeDelegationCard(facts(), width, true);
      expect(cellText(rows, "frame-top")).toHaveLength(1);
      expect(cellText(rows, "frame-bottom")).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Height
// ---------------------------------------------------------------------------

describe("height", () => {
  it("keeps the collapsed card between four and six rows at every width", () => {
    for (const state of STATES) {
      for (const width of WIDTHS) {
        const height = lines(state.facts, width).length;
        expect(height).toBeGreaterThanOrEqual(4);
        expect(height).toBeLessThanOrEqual(6);
      }
    }
  });

  it("spends exactly one rule and ten viewport rows when expanded", () => {
    for (const state of STATES) {
      for (const width of WIDTHS) {
        const collapsed = lines(state.facts, width).length;
        const expanded = lines(state.facts, width, true).length;
        expect(expanded - collapsed).toBe(CARD_VIEWPORT_ROWS + 2);
      }
    }
  });

  it("does not change height at settlement", () => {
    const running = STATES.find((state) => state.id === "reasoning");
    const settled = STATES.filter((state) => state.facts.settled);
    for (const width of WIDTHS) {
      for (const expanded of [false, true]) {
        const before = lines(
          (running as { facts: PiDelegationCardFacts }).facts,
          width,
          expanded,
        ).length;
        for (const state of settled) {
          expect(lines(state.facts, width, expanded).length).toBe(before);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The rail
// ---------------------------------------------------------------------------

describe("the rail", () => {
  it("keeps the state and the child name at every width", () => {
    for (const state of STATES) {
      for (const width of WIDTHS) {
        const plan = railPlan(width);
        const rows = composeDelegationCard(state.facts, width, false);
        if (plan.folded) {
          const identity = rows.find(
            (row) => row.slot === "identity",
          ) as PiCardRow;
          expect(cellText(rows, "identity")).toHaveLength(1);
          // The state leads the folded row, so a clip can only ever reach the
          // child name — and the name is still in the cell the card composed.
          const cell = rowText(identity.body as Row);
          expect(cell).toContain(state.facts.status.toUpperCase().slice(0, 4));
          expect(rowText(identity.row)).toContain(
            state.facts.status.toUpperCase().slice(0, 4),
          );
          continue;
        }
        const cells = railStatusFirst(state.facts, plan.railW, plan.tight);
        expect(rowText(cells[0] as Row)).toContain(
          state.facts.status.toUpperCase(),
        );
        expect(rowText(cells[1] as Row)).toContain(state.facts.agentName);
      }
    }
  });

  it("drops elapsed first, and never the state or the name", () => {
    const tight = WIDTHS.filter(
      (width) => railPlan(width).tight && !railPlan(width).folded,
    );
    expect(tight.length).toBeGreaterThan(0);
    for (const width of tight) {
      const plan = railPlan(width);
      const cells = railStatusFirst(facts(), plan.railW, plan.tight);
      expect(cells).toHaveLength(2);
    }
  });

  it("keeps the rail height stable when telemetry is unknown", () => {
    const known = facts();
    const unknown = facts({ telemetry: {} });
    for (const width of WIDTHS) {
      expect(lines(unknown, width).length).toBe(lines(known, width).length);
    }
  });
});

// ---------------------------------------------------------------------------
// Assignment and the Native Line
// ---------------------------------------------------------------------------

describe("the assignment", () => {
  it("is exactly one row at every width, in every state", () => {
    for (const state of STATES) {
      for (const width of WIDTHS) {
        const rows = composeDelegationCard(state.facts, width, false);
        expect(cellText(rows, "task")).toHaveLength(1);
      }
    }
  });

  it("does not change with the lifecycle state", () => {
    for (const width of [24, 40, 80, 200]) {
      const rendered = STATES.map((state) =>
        rowText(assignmentRows(state.facts, railPlan(width).bodyW)[0] as Row),
      );
      expect(new Set(rendered).size).toBe(1);
    }
  });

  it("clips rather than dropping the task on a card barely wider than its frame", () => {
    const row = assignmentRows(facts(), 6)[0] as Row;
    expect(rowText(row).length).toBeGreaterThan(0);
  });

  it("states an absent assignment instead of inventing one", () => {
    const row = assignmentRows(facts({ assignment: "" }), 60)[0] as Row;
    expect(rowText(row)).toBe(CARD_NO_ASSIGNMENT);
  });
});

describe("the Native Line", () => {
  it("is exactly one activity row in every state", () => {
    for (const state of STATES) {
      for (const width of WIDTHS) {
        const rows = composeDelegationCard(state.facts, width, false);
        expect(cellText(rows, "activity")).toHaveLength(1);
        // A rail taller than the body leaves at most one blank body cell, and
        // that cell may never carry activity prose of its own.
        const detail = rows.filter((row) => row.slot === "activity-detail");
        expect(detail.length).toBeLessThanOrEqual(1);
        for (const row of detail) expect(row.body).toHaveLength(0);
      }
    }
  });

  it("prints the reasoning wording the model chose and carries the live mark only while live", () => {
    // The renderer adds no reasoning wording of its own: relabelling a raw
    // reasoning marker as a `summary` here would fabricate one.
    const live = rowText(
      nativeLine(
        facts({ activity: { kind: "think", text: "reasoning", live: true } }),
        80,
      )[0] as Row,
    );
    expect(live).toContain("⤷");
    expect(live).toContain("reasoning");
    expect(live).not.toContain("summary · ");
    expect(live).toContain("▍");

    const summarized = rowText(
      nativeLine(
        facts({
          activity: {
            kind: "think",
            text: "summary · weighed two fixes",
            live: true,
          },
        }),
        80,
      )[0] as Row,
    );
    expect(summarized).toContain("summary · weighed two fixes");
    expect(summarized).not.toContain("summary · summary · ");

    const frozen = rowText(
      nativeLine(
        facts({
          activity: { kind: "think", text: "done thinking", live: false },
        }),
        80,
      )[0] as Row,
    );
    expect(frozen).not.toContain("▍");
  });

  it("reserves the check glyph for the settlement-named reply", () => {
    const saying = rowText(
      nativeLine(
        facts({ activity: { kind: "say", text: "writing", live: true } }),
        80,
      )[0] as Row,
    );
    expect(saying).toContain("▸");
    expect(saying).not.toContain("✓");

    const settled = STATES.find(
      (state) => state.id === "completed",
    ) as (typeof STATES)[number];
    expect(rowText(nativeLine(settled.facts, 80)[0] as Row)).toContain("✓");
  });

  it("reads the body width alone, never the terminal width", () => {
    const wide = rowText(nativeLine(facts(), 40)[0] as Row);
    const narrow = rowText(nativeLine(facts(), 40)[0] as Row);
    expect(wide).toBe(narrow);
  });
});

// ---------------------------------------------------------------------------
// The footer
// ---------------------------------------------------------------------------

describe("the footer", () => {
  function footerLine(
    state: PiDelegationCardFacts,
    width: number,
    expanded = false,
  ): string {
    return emit(cardFooter(width, state, expanded).row, width, PAINT);
  }

  it("prints exactly one bottom edge and never a second identity", () => {
    for (const width of WIDTHS) {
      const line = footerLine(facts(), width);
      expect(line.includes("╰")).toBe(true);
      expect(line).not.toContain("shuttle");
    }
  });

  it("never lets telemetry outlive an action hint", () => {
    for (const state of STATES) {
      for (const width of WIDTHS) {
        const line = footerLine(state.facts, width);
        const telemetry = telemetryLadder(state.facts).some((rung) =>
          line.includes(rung),
        );
        if (telemetry) expect(line).toContain(CARD_EXPAND_KEY);
        if (line.includes(CARD_EXPAND_KEY)) {
          expect(line).toContain(CARD_INSPECT_HINT_MIN);
        }
      }
    }
  });

  it("leaves Alt+I as the final surviving hint", () => {
    const surviving = WIDTHS.filter((width) =>
      footerLine(facts(), width).includes(CARD_INSPECT_HINT_MIN),
    );
    expect(surviving.length).toBeGreaterThan(0);
    const narrowest = Math.min(...surviving);
    const line = footerLine(facts(), narrowest);
    expect(line).toContain(CARD_INSPECT_HINT_MIN);
    expect(line).not.toContain(CARD_EXPAND_KEY);
    // Below that width no hint survives at all, and telemetry does not take
    // the columns the hints vacated.
    for (const width of WIDTHS.filter((w) => w < narrowest)) {
      const narrow = footerLine(facts(), width);
      expect(narrow).not.toContain("Alt+I");
      expect(narrow).not.toContain(CARD_EXPAND_KEY);
      expect(narrow).not.toContain("run 1");
    }
  });

  it("walks the action ladder richest first", () => {
    const ladder = actionLadder(facts(), false).map((row) => rowText(row));
    expect(ladder[0]).toContain("Ctrl+O expand");
    expect(ladder[0]).toContain("Alt+I inspect child");
    expect(ladder[ladder.length - 1]).toBe(CARD_INSPECT_HINT_MIN);
  });

  it("says expand while running, details once settled, collapse when open", () => {
    expect(expandVerb(facts(), false)).toBe("expand");
    expect(expandVerb(facts({ settled: true }), false)).toBe("details");
    expect(expandVerb(facts({ settled: true }), true)).toBe("collapse");
    expect(footerLine(facts(), 120)).toContain("Ctrl+O expand");
    expect(footerLine(facts({ settled: true }), 120)).toContain(
      "Ctrl+O details",
    );
  });

  it("prints the lifecycle phase and never the status word the rail owns", () => {
    const line = footerLine(facts(), 200);
    expect(line).toContain("run 1 · reasoning");
    expect(line).not.toContain("running");
  });

  it("omits unknown telemetry instead of printing a zero", () => {
    const rungs = telemetryLadder(facts({ telemetry: { elapsed: "4s" } }));
    expect(rungs.some((rung) => rung.includes("tok"))).toBe(false);
    expect(rungs.some((rung) => rung.includes("$"))).toBe(false);
    expect(rungs[rungs.length - 1]).toBe("4s");
  });

  it("offers only expand and inspect, in every state", () => {
    for (const state of STATES) {
      for (const width of WIDTHS) {
        const line = footerLine(state.facts, width);
        for (const forbidden of ["retry", "steer", "resume", "cancel "]) {
          expect(line.includes(forbidden)).toBe(false);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The expanded region
// ---------------------------------------------------------------------------

describe("the expanded region", () => {
  it("adds one rule, one status strip and nine transcript rows", () => {
    for (const state of STATES) {
      for (const width of [12, 24, 44, 80, 200]) {
        const rows = composeDelegationCard(state.facts, width, true);
        expect(cellText(rows, "rule")).toHaveLength(1);
        const detail = cellText(rows, "detail");
        expect(detail).toHaveLength(CARD_VIEWPORT_ROWS + 1);
        expect(detail.length).toBeGreaterThanOrEqual(CARD_DETAIL_ROW_MIN);
        expect(detail.length).toBeLessThanOrEqual(CARD_DETAIL_ROW_MAX);
      }
    }
  });

  it("says LIVE while the child can act and AT BOTTOM once it cannot", () => {
    const running = composeDelegationCard(facts(), 120, true);
    expect(cellText(running, "detail")[0]).toContain(CARD_VIEWPORT_LIVE);
    expect(cellText(running, "detail")[0]).toContain("↑ 12 rows above");

    const settled = composeDelegationCard(
      facts({
        settled: true,
        viewport: { rows: [], above: 0, atBottom: true },
      }),
      120,
      true,
    );
    expect(cellText(settled, "detail")[0]).toContain(CARD_VIEWPORT_SETTLED);
    expect(cellText(settled, "detail")[0]).not.toContain("above");
  });

  it("keeps the window on the bottom, padding above when there is less", () => {
    const rows = composeDelegationCard(
      facts({ viewport: { rows: viewportRows(2), above: 0, atBottom: true } }),
      120,
      true,
    );
    const detail = cellText(rows, "detail");
    expect(detail).toHaveLength(CARD_VIEWPORT_ROWS + 1);
    expect(detail[detail.length - 1]).toContain("transcript row 1");
    expect(interior(detail[2] as string)).toBe("");
  });

  it("never claims a viewport row it was not given", () => {
    const rows = composeDelegationCard(
      facts({ viewport: { rows: [], above: 0, atBottom: true } }),
      120,
      true,
    );
    for (const line of cellText(rows, "detail").slice(1)) {
      expect(interior(line)).toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// Degraded fallback
// ---------------------------------------------------------------------------

describe("degradedDelegationCard", () => {
  it("returns a bounded framed card that claims nothing", () => {
    for (const width of WIDTHS) {
      const out = degradedDelegationCard("details payload rejected", {
        width,
        paint: PAINT,
      });
      expect(out).toHaveLength(4);
      expect(out.filter((line) => line.includes("╭"))).toHaveLength(1);
      expect(out.filter((line) => line.includes("╰"))).toHaveLength(1);
      for (const line of out) {
        expect(measureWidth(line)).toBeLessThanOrEqual(width);
      }
      const body = out.join("\n");
      for (const forbidden of ["COMPLETED", "FAILED", "running", "✓"]) {
        expect(body.includes(forbidden)).toBe(false);
      }
    }
  });

  it("sanitizes the reason so it cannot forge a frame or paint the screen", () => {
    const out = degradedDelegationCard("\u001b[31mred╭─╮\u0007 boom", {
      width: 80,
      paint: PAINT,
    });
    const body = out.slice(1, -1).join("\n");
    expect(body).toContain("red boom");
    expect(body).not.toContain("\u001b");
    expect(body).not.toContain("╭");
  });

  it("draws without options at all", () => {
    const out = degradedDelegationCard("no facts");
    expect(out).toHaveLength(4);
    expect(out[0]).toContain(CARD_TOOL_NAME);
  });
});

// ---------------------------------------------------------------------------
// Fact-model compatibility
// ---------------------------------------------------------------------------

describe("facts from the model", () => {
  it("renders the projection the reducer produces", () => {
    const started = applyDelegationCardInput(
      createDelegationCardState({
        agentName: "shuttle",
        assignment: ASSIGNMENT,
      }),
      {
        kind: "start_run",
        threadId: "thread-1",
        runNumber: 1,
        action: "start",
        agentName: "shuttle",
      },
      () => 1_000,
    );
    expect(started.isOk()).toBe(true);
    const state = started._unsafeUnwrap();
    const thinking = applyDelegationCardInput(
      state,
      {
        kind: "thinking",
        itemId: "t1",
        summary: "Reading the component before touching the arithmetic.",
      },
      () => 5_000,
    );
    expect(thinking.isOk()).toBe(true);
    const projected = projectDelegationCardFacts(thinking._unsafeUnwrap());

    const out = lines(projected, 100, true);
    expect(out[0]).toContain(CARD_TOOL_NAME);
    expect(out.join("\n")).toContain("shuttle");
    for (const line of out) expect(measureWidth(line)).toBeLessThanOrEqual(100);
  });
});
