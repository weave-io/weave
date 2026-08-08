import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  fitLinesToWidth,
  fitLineToWidth,
  fitLineWithSuffix,
  fitRuleToWidth,
} from "../render-width.js";

/** Exact crash shape: adapter-composed header of 115 columns on a 51-col TUI. */
const CRASH_HEADER_WIDTH = 115;
const CRASH_TERMINAL_WIDTH = 51;
const LIVE_SUFFIX = " · LIVE";

function headerOfWidth(targetWidth: number): {
  readonly head: string;
  readonly suffix: string;
  readonly composed: string;
} {
  const suffix = LIVE_SUFFIX;
  const prefix = "◆ ";
  const titleBudget = targetWidth - visibleWidth(prefix) - visibleWidth(suffix);
  const head = `${prefix}${"A".repeat(titleBudget)}`;
  const composed = `${head}${suffix}`;
  expect(visibleWidth(composed)).toBe(targetWidth);
  return { head, suffix, composed };
}

describe("fitLineToWidth", () => {
  it("returns empty for non-positive or non-finite widths", () => {
    expect(fitLineToWidth("hello", 0)).toBe("");
    expect(fitLineToWidth("hello", -3)).toBe("");
    expect(fitLineToWidth("hello", Number.NaN)).toBe("");
    expect(fitLineToWidth("hello", Number.POSITIVE_INFINITY)).toBe("");
  });

  it("preserves a line that already fits", () => {
    expect(fitLineToWidth("ok", 10)).toBe("ok");
  });

  it("cuts with a single ellipsis and stays inside the budget", () => {
    const cut = fitLineToWidth("ABCDEFGHIJKLMNOPQRSTUVWXYZ", 10);
    expect(visibleWidth(cut)).toBeLessThanOrEqual(10);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("ignores ANSI escapes when measuring and cutting", () => {
    const red = "\x1b[31m";
    const reset = "\x1b[0m";
    const line = `${red}${"X".repeat(40)}${reset}`;
    const cut = fitLineToWidth(line, 12);
    expect(visibleWidth(cut)).toBeLessThanOrEqual(12);
    expect(cut.includes(red) || cut.includes("X")).toBe(true);
  });

  it("counts emoji and CJK as wide columns", () => {
    const line = `${"漢".repeat(20)}${"😀".repeat(10)}`;
    const cut = fitLineToWidth(line, 16);
    expect(visibleWidth(cut)).toBeLessThanOrEqual(16);
  });

  it("does not treat combining marks as extra columns", () => {
    const line = `e\u0301`.repeat(40);
    const cut = fitLineToWidth(line, 10);
    expect(visibleWidth(cut)).toBeLessThanOrEqual(10);
    expect(visibleWidth(cut)).toBeGreaterThan(0);
  });
});

describe("fitLineWithSuffix", () => {
  it("keeps · LIVE on the exact 115-column crash header at width 51", () => {
    const { head, suffix, composed } = headerOfWidth(CRASH_HEADER_WIDTH);
    expect(visibleWidth(composed)).toBe(CRASH_HEADER_WIDTH);
    const fitted = fitLineWithSuffix(head, suffix, CRASH_TERMINAL_WIDTH);
    expect(visibleWidth(fitted)).toBeLessThanOrEqual(CRASH_TERMINAL_WIDTH);
    expect(fitted.endsWith(LIVE_SUFFIX)).toBe(true);
    expect(fitted.startsWith("◆")).toBe(true);
  });

  it("drops the reserved suffix only when the head cannot keep two columns", () => {
    const fitted = fitLineWithSuffix("◆ title", LIVE_SUFFIX, 2);
    expect(visibleWidth(fitted)).toBeLessThanOrEqual(2);
    expect(fitted.endsWith(LIVE_SUFFIX)).toBe(false);
  });
});

describe("fitLinesToWidth", () => {
  it("fits every line and returns empty strings for unsafe widths", () => {
    const lines = ["short", "X".repeat(80), "中文".repeat(30)];
    for (const width of [1, 2, 10, 20, 51] as const) {
      const fitted = fitLinesToWidth(lines, width);
      expect(fitted).toHaveLength(lines.length);
      for (const line of fitted) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
    expect(fitLinesToWidth(lines, 0)).toEqual(["", "", ""]);
    expect(fitLinesToWidth(lines, Number.NaN)).toEqual(["", "", ""]);
  });

  it("clamps an over-wide transcript or editor fallback line", () => {
    const transcript = `[assistant] ${"w".repeat(117)}…`;
    const editor = `> ${"d".repeat(200)}`;
    const fitted = fitLinesToWidth([transcript, editor], 20);
    expect(fitted).toHaveLength(2);
    expect(visibleWidth(fitted[0] ?? "")).toBeLessThanOrEqual(20);
    expect(visibleWidth(fitted[1] ?? "")).toBeLessThanOrEqual(20);
  });
});

describe("fitRuleToWidth", () => {
  it("respects both the terminal width and the cosmetic cap", () => {
    expect(visibleWidth(fitRuleToWidth("─", 51, 40))).toBe(40);
    expect(visibleWidth(fitRuleToWidth("─", 10, 40))).toBe(10);
    expect(fitRuleToWidth("─", 0, 40)).toBe("");
  });
});
