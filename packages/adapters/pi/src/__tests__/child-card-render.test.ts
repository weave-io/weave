import { describe, expect, it } from "bun:test";
import {
  CARD_FACTS_SCHEMA_VERSION,
  CARD_TOOL_NAME,
  CARD_VIEWPORT_ROWS,
  type PiDelegationCardFacts,
} from "../child-card-model.js";
import {
  assignmentRows,
  CARD_DETAIL_ROW_MAX,
  CARD_DETAIL_ROW_MIN,
  CARD_INSPECT_HINT_MIN,
  CARD_MIN_WIDTH,
  CARD_VIEWPORT_LIVE,
  CARD_VIEWPORT_SETTLED,
  cardFooter,
  composeDelegationCard,
  degradedDelegationCard,
  nativeLine,
  type PiCardRow,
  railPlan,
  renderDelegationCard,
} from "../child-card-render.js";
import { measureWidth } from "../render-width.js";
import { plainPaint } from "../ui-paint.js";
import { emit, type Row } from "../ui-rows.js";

const RAW_REASONING_SENTINEL = "RAW_REASONING_SENTINEL";
const LIVE_ASSISTANT_SENTINEL = "LIVE_ASSISTANT_SENTINEL";
const TOOL_ACTIVITY_SENTINEL = "TOOL_ACTIVITY_SENTINEL";
const STDOUT_STDERR_SENTINEL = "STDOUT_STDERR_SENTINEL";
const INSPECTOR_SENTINEL = "INSPECTOR_SENTINEL";
const LIVE_LINE = `↪ reasoning • ${RAW_REASONING_SENTINEL}`;
const PAINT = plainPaint();

function facts(
  overrides: Partial<PiDelegationCardFacts> = {},
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
    assignment: "Fix the parent card renderer.",
    activity: {
      kind: "say",
      text: LIVE_ASSISTANT_SENTINEL,
      live: true,
    },
    telemetry: { elapsed: "38s", tokens: "4.2k tok", cost: "$0.03" },
    viewport: {
      rows: [
        {
          kind: "tool",
          head: TOOL_ACTIVITY_SENTINEL,
          text: STDOUT_STDERR_SENTINEL,
        },
        { kind: "msg", head: "inspector", text: INSPECTOR_SENTINEL },
      ],
      above: 4,
      atBottom: true,
    },
    terminal: {
      outcome: "completed",
      verdict: "COMPLETED",
      glyph: "✓",
      headline: LIVE_ASSISTANT_SENTINEL,
      evidence: STDOUT_STDERR_SENTINEL,
    },
    ...overrides,
  };
}

function rowText(row: Row): string {
  return emit(row, 1_000, PAINT);
}

function cellText(rows: readonly PiCardRow[], slot: string): string[] {
  return rows.filter((row) => row.slot === slot).map((row) => rowText(row.row));
}

function card(
  over: Partial<PiDelegationCardFacts> = {},
  width = 80,
  expanded = false,
  liveReasoningLine?: string,
): string[] {
  return renderDelegationCard(facts(over), {
    width,
    expanded,
    paint: PAINT,
    liveReasoningLine,
  });
}

function assertNoActivitySentinels(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const sentinel of [
    RAW_REASONING_SENTINEL,
    LIVE_ASSISTANT_SENTINEL,
    TOOL_ACTIVITY_SENTINEL,
    STDOUT_STDERR_SENTINEL,
    INSPECTOR_SENTINEL,
  ]) {
    expect(serialized).not.toContain(sentinel);
  }
}

describe("parent card renderer isolation", () => {
  it("renders only shell, identity, assignment, telemetry, and lifecycle framing", () => {
    for (const width of [12, 24, 40, 80, 160, 200]) {
      for (const expanded of [false, true]) {
        const lines = card({}, width, expanded);
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
          expect(measureWidth(line)).toBeLessThanOrEqual(
            Math.max(width, CARD_MIN_WIDTH),
          );
        }
        expect(lines[0]?.startsWith("╭")).toBe(true);
        expect(lines.at(-1)?.startsWith("╰")).toBe(true);
        assertNoActivitySentinels(lines);
      }
    }
  });

  it("ignores assistant, tool, stdout/stderr, inspector, and terminal payloads", () => {
    const collapsed = card({}, 100).join("\n");
    const expanded = card({}, 100, true).join("\n");
    expect(collapsed).toContain("Shuttle");
    expect(collapsed).toContain("Fix the parent card renderer.");
    expect(expanded).toContain(CARD_VIEWPORT_LIVE);
    for (const output of [collapsed, expanded]) {
      for (const sentinel of [
        LIVE_ASSISTANT_SENTINEL,
        TOOL_ACTIVITY_SENTINEL,
        STDOUT_STDERR_SENTINEL,
        INSPECTOR_SENTINEL,
      ]) {
        expect(output).not.toContain(sentinel);
      }
    }
  });

  it("omits the activity row when no printable reasoning line exists", () => {
    const rows = composeDelegationCard(facts(), 100, false);
    expect(cellText(rows, "activity")).toHaveLength(0);
    expect(cellText(rows, "activity-detail").length).toBeLessThanOrEqual(2);
    expect(nativeLine(facts(), 80)).toEqual([]);
    expect(nativeLine(facts(), 80, " \t\n ")).toEqual([]);
  });
});

describe("parent card live reasoning line", () => {
  it("renders exactly one raw-reasoning activity row with the required prefix", () => {
    const rows = composeDelegationCard(facts(), 120, false, LIVE_LINE);
    const activity = cellText(rows, "activity");
    expect(activity).toHaveLength(1);
    expect(activity[0]).toContain(LIVE_LINE);
    expect(cellText(rows, "activity-detail").length).toBeLessThanOrEqual(1);
    expect(activity[0]).not.toContain(LIVE_ASSISTANT_SENTINEL);
    expect(activity[0]).not.toContain(TOOL_ACTIVITY_SENTINEL);

    const direct = rowText(nativeLine(facts(), 100, LIVE_LINE)[0] as Row);
    expect(direct).toBe(LIVE_LINE);
    expect(direct).not.toContain("summary");
  });

  it("uses the body width and keeps honest truncation at narrow widths", () => {
    for (const width of [12, 24, 40, 80, 160]) {
      const lines = card({}, width, false, LIVE_LINE);
      for (const line of lines)
        expect(measureWidth(line)).toBeLessThanOrEqual(
          Math.max(width, CARD_MIN_WIDTH),
        );
      const body = lines.join("\n");
      expect(body).toContain("↪");
      if (width >= 40) expect(body).toContain("↪ reasoning");
      if (width < 40) expect(body).toContain("…");
    }
    const wide = rowText(nativeLine(facts(), 100, LIVE_LINE)[0] as Row);
    const narrower = rowText(nativeLine(facts(), 30, LIVE_LINE)[0] as Row);
    expect(wide).toBe(LIVE_LINE);
    expect(narrower.length).toBeLessThan(wide.length);
    expect(narrower).toContain("…");
  });

  it("keeps the live line out of the facts-derived payload", () => {
    const factsValue = facts();
    const rows = composeDelegationCard(factsValue, 100, true, LIVE_LINE);
    expect(JSON.stringify(factsValue)).not.toContain(RAW_REASONING_SENTINEL);
    expect(cellText(rows, "activity").join("\n")).toContain(
      RAW_REASONING_SENTINEL,
    );
    expect(cellText(rows, "detail").join("\n")).not.toContain(
      RAW_REASONING_SENTINEL,
    );
  });
});

describe("parent card geometry and terminal framing", () => {
  it("keeps one frame and width-safe rows across the supported range", () => {
    for (const width of [12, 24, 40, 80, 120, 200]) {
      for (const expanded of [false, true]) {
        const lines = card({}, width, expanded, LIVE_LINE);
        expect(lines.filter((line) => line.startsWith("╭"))).toHaveLength(1);
        expect(lines.filter((line) => line.startsWith("╰"))).toHaveLength(1);
        for (const line of lines)
          expect(measureWidth(line)).toBeLessThanOrEqual(
            Math.max(width, CARD_MIN_WIDTH),
          );
      }
    }
  });

  it("keeps the expanded region fixed and free of viewport payload", () => {
    const rows = composeDelegationCard(facts(), 120, true, LIVE_LINE);
    const detail = cellText(rows, "detail");
    expect(detail).toHaveLength(CARD_VIEWPORT_ROWS + 1);
    expect(detail[0]).toContain(CARD_VIEWPORT_LIVE);
    expect(detail.slice(1).every((line) => !line.includes("transcript"))).toBe(
      true,
    );
    expect(detail.join("\n")).not.toContain(TOOL_ACTIVITY_SENTINEL);
    expect(detail.join("\n")).not.toContain(LIVE_LINE);

    const settledRows = composeDelegationCard(
      facts({ settled: true, status: "completed" }),
      120,
      true,
    );
    expect(cellText(settledRows, "detail")[0]).toContain(CARD_VIEWPORT_SETTLED);
  });

  it("keeps assignment and the final inspect affordance visible", () => {
    const assignment = cellText(
      composeDelegationCard(facts(), 80, false),
      "task",
    );
    expect(assignment).toHaveLength(1);
    expect(assignment[0]).toContain("Fix the parent card renderer.");
    const footer = rowText(cardFooter(120, facts(), false).row);
    expect(footer).toContain(CARD_INSPECT_HINT_MIN);
    expect(footer).not.toContain("retry");
    expect(footer).not.toContain("cancel");
  });

  it("renders a settled card without showing the authoritative output as activity", () => {
    const settled = facts({
      settled: true,
      status: "completed",
      tone: "ok",
      run: { number: 1, action: "start", phase: "settled" },
    });
    const output = card(settled, 100, false).join("\n");
    expect(output).toContain("COMPLETED");
    expect(output).not.toContain(LIVE_ASSISTANT_SENTINEL);
    expect(output).not.toContain(TOOL_ACTIVITY_SENTINEL);
  });
});

describe("degraded parent card", () => {
  it("claims no child state and remains bounded", () => {
    for (const width of [12, 40, 80, 200]) {
      const lines = degradedDelegationCard("details rejected", {
        width,
        paint: PAINT,
      });
      expect(lines).toHaveLength(4);
      for (const line of lines)
        expect(measureWidth(line)).toBeLessThanOrEqual(
          Math.max(width, CARD_MIN_WIDTH),
        );
      expect(lines.join("\n")).toContain("delegat");
    }
  });
});

describe("facts compatibility", () => {
  it("keeps the model's facts content-free even when old payload fields are present", () => {
    const value = facts({
      activity: { kind: "say", text: LIVE_ASSISTANT_SENTINEL, live: true },
      viewport: {
        rows: [{ kind: "msg", head: "x", text: INSPECTOR_SENTINEL }],
        above: 1,
        atBottom: false,
      },
    });
    const output = composeDelegationCard(value, 100, false)
      .map((row) => rowText(row.row))
      .join("\n");
    expect(output).not.toContain(LIVE_ASSISTANT_SENTINEL);
    expect(output).not.toContain(INSPECTOR_SENTINEL);
  });

  it("supports the body-only folded layout", () => {
    const rows = composeDelegationCard(facts(), 20, false, LIVE_LINE);
    expect(rows.some((row) => row.slot === "task")).toBe(true);
    expect(rows.some((row) => row.slot === "activity")).toBe(true);
    expect(railPlan(20).folded).toBe(true);
  });

  it("does not exceed the detail row bounds", () => {
    const rows = composeDelegationCard(facts(), 80, true);
    const details = rows.filter((row) => row.slot === "detail");
    expect(details.length).toBeGreaterThanOrEqual(CARD_DETAIL_ROW_MIN);
    expect(details.length).toBeLessThanOrEqual(CARD_DETAIL_ROW_MAX);
    expect(assignmentRows(facts(), 60)).toHaveLength(1);
  });
});
