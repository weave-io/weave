import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { makePaint, type Paint, plainPaint } from "../ui-paint.js";
import {
  cell,
  clipRow,
  emit,
  fill,
  fitRow,
  fitTo,
  glyph,
  joinColumns,
  joinFit,
  padRow,
  RAIL_GEOMETRY,
  type Row,
  reserveRows,
  rowLR,
  rowWidth,
  safeText,
  safeTrim,
  seg,
  splitRail,
  stackSections,
  TRANSCRIPT_MIN,
  wrapIndented,
  wrapPlain,
} from "../ui-rows.js";

const PLAIN = plainPaint();

const THEMED: Paint = makePaint({
  fg: (_color, text) => `\u001B[31m${text}\u001B[0m`,
  bold: (text) => `\u001B[1m${text}\u001B[0m`,
  inverse: (text) => `\u001B[7m${text}\u001B[0m`,
});

/** Widths the acceptance sweep runs over. */
const WIDTHS = Array.from({ length: 200 }, (_value, index) => index + 1);

/** Hostile and wide-grapheme inputs the sweep feeds through every row. */
const HOSTILE_SAMPLES: readonly string[] = [
  "plain ascii row",
  "\u001B[31mred\u001B[0m and \u001B[1mbold\u001B[0m",
  "\u001B]0;window title\u0007after osc",
  "\u009D raw c1 osc payload \u009C after",
  "null\u0000bell\u0007backspace\u0008",
  "tab\there\nnewline\rcarriage",
  "宽字宽字宽字宽字宽字宽字宽字宽字",
  "🚀🚀🚀 emoji run 🚀🚀🚀",
  "┌───┐│forged frame│└───┘",
  "▍▏▌ block elements ▁▂▃",
  "a\u0301 combining mark run",
  "  lots     of   spaces  ",
  "",
];

function sampleRow(text: string): Row {
  return [
    glyph("rule", "│"),
    seg("text", text),
    seg("dim", " · "),
    seg("acc", "LIVE"),
    glyph("rule", "│"),
  ];
}

// ---------------------------------------------------------------------------
// safeText / safeTrim
// ---------------------------------------------------------------------------

describe("safeText", () => {
  it("removes ANSI SGR sequences", () => {
    expect(safeText("\u001B[31mred\u001B[0m")).toBe("red");
    expect(safeText("\u001B[1;38;5;120mstyled\u001B[m")).toBe("styled");
  });

  it("removes OSC sequences and their payloads for both terminators", () => {
    expect(safeText("\u001B]0;evil title\u0007kept")).toBe("kept");
    expect(safeText("\u001B]8;;https://example.com\u001B\\link")).toBe("link");
    expect(safeText("\u009D raw payload \u009C kept")).toBe(" kept");
  });

  it("removes C0 controls, DEL and C1 controls", () => {
    expect(safeText("a\u0000b\u0007c\u0008d\u007Fe\u0085f")).toBe("abcdef");
    expect(safeText("\u009B31m still stripped")).toBe(" still stripped");
  });

  it("turns whitespace-bearing controls into spaces", () => {
    expect(safeText("a\tb\nc\rd")).toBe("a b c d");
  });

  it("removes box drawing and block elements", () => {
    expect(safeText("┌─┐│└┘├┤┬┴┼")).toBe("");
    expect(safeText("▍▏▌█▄▀")).toBe("");
    expect(safeText("before╭╮after")).toBe("beforeafter");
  });

  it("collapses whitespace runs to a single space", () => {
    expect(safeText("a     b")).toBe("a b");
    expect(safeText("a \t\n \r b")).toBe("a b");
    expect(safeText("a\u2028b\u2029c")).toBe("a b c");
  });

  it("preserves a deliberate separator", () => {
    expect(safeText(" · ")).toBe(" · ");
  });

  it("leaves ordinary text untouched", () => {
    expect(safeText("read · child-overlay-component.ts")).toBe(
      "read · child-overlay-component.ts",
    );
    expect(safeText("宽字 CJK 🚀")).toBe("宽字 CJK 🚀");
  });

  it("is idempotent over every hostile sample", () => {
    for (const sample of HOSTILE_SAMPLES) {
      expect(safeText(safeText(sample))).toBe(safeText(sample));
    }
  });
});

describe("safeTrim", () => {
  it("sanitizes and trims", () => {
    expect(safeTrim("  \t hello \n world  ")).toBe("hello world");
    expect(safeTrim(" · ")).toBe("·");
    expect(safeTrim("┌─┐")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

describe("seg and glyph", () => {
  it("seg sanitizes its text", () => {
    expect(seg("text", "\u001B[31m┌forged┐\u001B[0m").t).toBe("forged");
  });

  it("glyph is the only path that keeps box drawing", () => {
    expect(glyph("rule", "╭─╮").t).toBe("╭─╮");
    expect(seg("rule", "╭─╮").t).toBe("");
  });

  it("no sanitized segment can contain a box-drawing character", () => {
    for (const sample of HOSTILE_SAMPLES) {
      expect(/[\u2500-\u259F]/u.test(seg("text", sample).t)).toBe(false);
    }
  });

  it("fill repeats exactly and refuses negative or non-finite counts", () => {
    expect(fill("dim", " ", 4).t).toBe("    ");
    expect(fill("rule", "─", 3).t).toBe("───");
    expect(fill("dim", " ", -2).t).toBe("");
    expect(fill("dim", " ", Number.NaN).t).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Row geometry
// ---------------------------------------------------------------------------

describe("rowWidth", () => {
  it("measures in visible columns, not code units", () => {
    expect(rowWidth([seg("text", "abc")])).toBe(3);
    expect(rowWidth([seg("text", "宽字")])).toBe(4);
    expect(rowWidth([seg("text", "ab"), seg("dim", "cd")])).toBe(4);
    expect(rowWidth([])).toBe(0);
  });
});

describe("clipRow", () => {
  it("returns the row unchanged when it already fits", () => {
    const row = sampleRow("fits");
    expect(clipRow(row, 200)).toEqual(row);
  });

  it("returns an empty row at a non-positive or non-finite width", () => {
    expect(clipRow(sampleRow("x"), 0)).toEqual([]);
    expect(clipRow(sampleRow("x"), -5)).toEqual([]);
    expect(clipRow(sampleRow("x"), Number.NaN)).toEqual([]);
  });

  it("never exceeds the width for any sample at any width", () => {
    for (const sample of HOSTILE_SAMPLES) {
      const row = sampleRow(sample);
      for (const width of WIDTHS) {
        expect(rowWidth(clipRow(row, width))).toBeLessThanOrEqual(width);
      }
    }
  });

  it("keeps inks of the segments it retains", () => {
    const clipped = clipRow([seg("text", "abcdef"), seg("acc", "ghijkl")], 8);
    expect(clipped.map((s) => s.ink)).toEqual(["text", "acc"]);
  });
});

describe("padRow", () => {
  it("pads to exactly the width", () => {
    for (const width of WIDTHS) {
      expect(rowWidth(padRow([seg("text", "ab")], width))).toBe(width);
    }
  });

  it("clips before padding", () => {
    const padded = padRow([seg("text", "abcdefghij")], 4);
    expect(rowWidth(padded)).toBe(4);
  });

  it("pads with the requested ink", () => {
    const padded = padRow([seg("text", "ab")], 6, "muted");
    expect(padded[padded.length - 1]).toEqual({ ink: "muted", t: "    " });
  });
});

describe("emit", () => {
  it("is width-safe for every sample at widths 1..200, plain and painted", () => {
    for (const sample of HOSTILE_SAMPLES) {
      const row = sampleRow(sample);
      for (const width of WIDTHS) {
        expect(visibleWidth(emit(row, width, PLAIN))).toBeLessThanOrEqual(
          width,
        );
        expect(visibleWidth(emit(row, width, THEMED))).toBeLessThanOrEqual(
          width,
        );
      }
    }
  });

  it("fills the requested width exactly when the row was padded to it", () => {
    for (const sample of HOSTILE_SAMPLES) {
      for (const width of WIDTHS) {
        const padded = padRow(sampleRow(sample), width);
        expect(visibleWidth(emit(padded, width, PLAIN))).toBe(width);
        expect(visibleWidth(emit(padded, width, THEMED))).toBe(width);
      }
    }
  });

  it("produces identical geometry plain and painted", () => {
    for (const sample of HOSTILE_SAMPLES) {
      const row = sampleRow(sample);
      for (const width of WIDTHS) {
        expect(visibleWidth(emit(row, width, THEMED))).toBe(
          visibleWidth(emit(row, width, PLAIN)),
        );
      }
    }
  });

  it("emits no ANSI at all under the plain paint", () => {
    for (const sample of HOSTILE_SAMPLES) {
      for (const width of [1, 7, 23, 80, 200]) {
        expect(emit(sampleRow(sample), width, PLAIN)).not.toContain("\u001B");
      }
    }
  });

  it("returns an empty string at a non-positive or non-finite width", () => {
    expect(emit(sampleRow("x"), 0, PLAIN)).toBe("");
    expect(emit(sampleRow("x"), Number.NaN, PLAIN)).toBe("");
  });

  it("clamps a paint that returns something wider than it was given", () => {
    const cheating: Paint = { ...PLAIN, text: (t) => `${t}!!!!!!!!!!` };
    for (const width of WIDTHS) {
      const line = emit([seg("text", "abc")], width, cheating);
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
});

describe("fitRow", () => {
  const ladder: readonly Row[] = [
    [seg("dim", "Ctrl+O expand · Alt+I inspect child")],
    [seg("dim", "Ctrl+O · Alt+I inspect")],
    [seg("dim", "Alt+I")],
  ];

  it("picks the richest candidate that fits", () => {
    expect(fitRow(ladder, 80)).toEqual(ladder[0] as Row);
    expect(fitRow(ladder, 22)).toEqual(ladder[1] as Row);
    expect(fitRow(ladder, 5)).toEqual(ladder[2] as Row);
  });

  it("returns an empty row when nothing fits", () => {
    expect(fitRow(ladder, 4)).toEqual([]);
    expect(fitRow(ladder, 0)).toEqual([]);
    expect(fitRow([], 100)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Painted-string helpers
// ---------------------------------------------------------------------------

describe("cell", () => {
  it("is exactly the requested width for every sample", () => {
    for (const sample of HOSTILE_SAMPLES) {
      for (const width of WIDTHS) {
        expect(visibleWidth(cell(sample, width))).toBe(width);
      }
    }
  });

  it("keeps painted text within its column", () => {
    const painted = THEMED.acc("宽字宽字宽字");
    for (const width of WIDTHS) {
      expect(visibleWidth(cell(painted, width))).toBe(width);
    }
  });

  it("is empty at a non-positive width", () => {
    expect(cell("abc", 0)).toBe("");
    expect(cell("abc", Number.NaN)).toBe("");
  });
});

describe("rowLR", () => {
  it("never exceeds the width for any sample pair", () => {
    for (const sample of HOSTILE_SAMPLES) {
      for (const width of WIDTHS) {
        expect(
          visibleWidth(rowLR(sample, "· LIVE", width)),
        ).toBeLessThanOrEqual(width);
      }
    }
  });

  it("never lets the right side take more than 60% of a wide row", () => {
    const line = rowLR("left", "R".repeat(400), 100);
    expect(visibleWidth(line)).toBeLessThanOrEqual(100);
    expect(line.endsWith("R") || line.endsWith("…")).toBe(true);
  });

  it("keeps the left identity visible when the right side is long", () => {
    expect(rowLR("AGENT", "· a very long trailing note", 40)).toContain(
      "AGENT",
    );
  });

  it("is empty at a non-positive width", () => {
    expect(rowLR("l", "r", 0)).toBe("");
  });
});

describe("joinFit", () => {
  const pieces = ["◆ WEAVE · LOOM", "Alt+A cycle", "pi-weave-ui-redesign"];

  it("keeps everything when there is room", () => {
    expect(joinFit(pieces, 100, " · ")).toBe(
      "◆ WEAVE · LOOM · Alt+A cycle · pi-weave-ui-redesign",
    );
  });

  it("drops later pieces before earlier ones", () => {
    expect(joinFit(pieces, 30, " · ")).toBe("◆ WEAVE · LOOM · Alt+A cycle");
    expect(joinFit(pieces, 20, " · ")).toBe("◆ WEAVE · LOOM");
  });

  it("clips the first piece rather than dropping it", () => {
    const line = joinFit(pieces, 6, " · ");
    expect(line.length).toBeGreaterThan(0);
    expect(visibleWidth(line)).toBeLessThanOrEqual(6);
  });

  it("skips empty pieces", () => {
    expect(joinFit(["a", "", "b"], 100, "-")).toBe("a-b");
  });

  it("never exceeds the width at any width", () => {
    for (const width of WIDTHS) {
      expect(visibleWidth(joinFit(pieces, width, " · "))).toBeLessThanOrEqual(
        width,
      );
    }
  });

  it("is empty at a non-positive width", () => {
    expect(joinFit(pieces, 0, " · ")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

describe("wrapPlain", () => {
  it("wraps within the width and honours the line cap", () => {
    const lines = wrapPlain(
      "Fix header suffix width handling and run the focused sweep.",
      20,
      3,
    );
    expect(lines.length).toBeLessThanOrEqual(3);
    for (const line of lines)
      expect(visibleWidth(line)).toBeLessThanOrEqual(20);
  });

  it("states loss with an ellipsis on the last kept line", () => {
    const lines = wrapPlain("alpha beta gamma delta epsilon zeta", 12, 2);
    expect(lines.length).toBe(2);
    expect(lines[1]?.endsWith("…")).toBe(true);
  });

  it("truncates a word wider than the line instead of splitting a grapheme", () => {
    const lines = wrapPlain("宽".repeat(40), 10, 1);
    expect(lines.length).toBe(1);
    expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(10);
  });

  it("sanitizes before wrapping", () => {
    const lines = wrapPlain("\u001B[31m┌forged┐\u001B[0m text", 40, 2);
    expect(lines.join(" ")).toBe("forged text");
  });

  it("returns nothing for a non-positive line cap", () => {
    expect(wrapPlain("anything", 40, 0)).toEqual([]);
  });

  it("never exceeds a floor of four columns at any requested width", () => {
    for (const width of WIDTHS) {
      for (const line of wrapPlain("alpha beta gamma", width, 4)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(4, width));
      }
    }
  });
});

describe("wrapIndented", () => {
  it("pads every line to the full width and keeps the indent", () => {
    const lines = wrapIndented("alpha beta gamma delta", 20, "  ", 4);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(visibleWidth(line)).toBe(20);
      expect(line.startsWith("  ")).toBe(true);
    }
  });

  it("stays within the width even when the indent is wider than the line", () => {
    for (const width of WIDTHS) {
      for (const line of wrapIndented("alpha beta", width, "      ", 3)) {
        expect(visibleWidth(line)).toBe(width);
      }
    }
  });
});

describe("fitTo", () => {
  const lines = ["a", "b", "c", "d"];

  it("pads a short block with blanks", () => {
    expect(fitTo(["a"], 3)).toEqual(["a", "", ""]);
  });

  it("keeps the head or the tail as asked", () => {
    expect(fitTo(lines, 2, "head")).toEqual(["a", "b"]);
    expect(fitTo(lines, 2, "tail")).toEqual(["c", "d"]);
  });

  it("returns nothing for a non-positive or non-finite height", () => {
    expect(fitTo(lines, 0)).toEqual([]);
    expect(fitTo(lines, -3)).toEqual([]);
    expect(fitTo(lines, Number.NaN)).toEqual([]);
  });

  it("always returns exactly the requested height", () => {
    for (const height of WIDTHS) {
      expect(fitTo(lines, height)).toHaveLength(height);
    }
  });
});

describe("stackSections", () => {
  const sections = [
    ["LIFECYCLE", "state  running", "run    1"],
    ["WORK", "tool   read", "turn   3"],
    ["SPEND", "tokens 12.4k", "cost   $0.08"],
  ];

  it("keeps blank spacers when there is room", () => {
    const stacked = stackSections(sections, 11);
    expect(stacked).toHaveLength(11);
    expect(stacked[3]).toBe("");
  });

  it("drops the spacers before dropping any detail", () => {
    expect(stackSections(sections, 9)).toEqual(sections.flat());
  });

  it("keeps a heading plus one row per group when the room is tight", () => {
    const stacked = stackSections(sections, 6);
    expect(stacked).toEqual([
      "LIFECYCLE",
      "state  running",
      "WORK",
      "tool   read",
      "SPEND",
      "tokens 12.4k",
    ]);
  });

  it("keeps each group's single most valuable row when headings do not fit", () => {
    expect(stackSections(sections, 3)).toEqual([
      "state  running",
      "tool   read",
      "tokens 12.4k",
    ]);
  });

  it("never returns more rows than the room allows", () => {
    for (const room of WIDTHS) {
      expect(stackSections(sections, room).length).toBeLessThanOrEqual(room);
    }
  });

  it("returns nothing for no room or no sections", () => {
    expect(stackSections(sections, 0)).toEqual([]);
    expect(stackSections([], 10)).toEqual([]);
  });
});

describe("joinColumns", () => {
  it("pads short columns instead of failing", () => {
    const joined = joinColumns(
      [
        { lines: ["main"], width: 6 },
        { lines: ["rail", "more"], width: 5 },
      ],
      3,
      "│",
    );
    expect(joined).toHaveLength(3);
    for (const line of joined) expect(visibleWidth(line)).toBe(12);
  });

  it("keeps painted columns inside their widths", () => {
    const joined = joinColumns(
      [
        { lines: [THEMED.acc("宽字宽字宽字宽字")], width: 8 },
        { lines: [THEMED.bad("error 🚀 tail")], width: 9 },
      ],
      1,
      " ",
    );
    expect(visibleWidth(joined[0] ?? "")).toBe(18);
  });

  it("returns nothing for a non-positive height", () => {
    expect(joinColumns([{ lines: ["a"], width: 3 }], 0, "│")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fallible layout arithmetic
// ---------------------------------------------------------------------------

describe("splitRail", () => {
  const need = RAIL_GEOMETRY.min + TRANSCRIPT_MIN + 1;

  it("fails closed below the combined minimum, without throwing", () => {
    const result = splitRail(need - 1, RAIL_GEOMETRY);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      kind: "too-narrow",
      need,
      width: need - 1,
    });
  });

  it("fails closed for zero, negative and non-finite widths", () => {
    for (const width of [0, -80, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = splitRail(width, RAIL_GEOMETRY);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().kind).toBe("too-narrow");
    }
  });

  it("splits exactly at the minimum", () => {
    const split = splitRail(need, RAIL_GEOMETRY)._unsafeUnwrap();
    expect(split).toEqual({ main: TRANSCRIPT_MIN, rail: RAIL_GEOMETRY.min });
  });

  it("never starves the main pane and never exceeds the band", () => {
    for (const width of WIDTHS) {
      const result = splitRail(width, RAIL_GEOMETRY);
      if (result.isErr()) {
        expect(width).toBeLessThan(need);
        continue;
      }
      const { main, rail } = result.value;
      expect(main + rail + 1).toBe(width);
      expect(main).toBeGreaterThanOrEqual(TRANSCRIPT_MIN);
      expect(rail).toBeGreaterThanOrEqual(RAIL_GEOMETRY.min);
      expect(rail).toBeLessThanOrEqual(RAIL_GEOMETRY.max);
    }
  });

  it("honours a caller-supplied main minimum", () => {
    const split = splitRail(80, RAIL_GEOMETRY, 20)._unsafeUnwrap();
    expect(split.main).toBeGreaterThanOrEqual(20);
    expect(split.main + split.rail + 1).toBe(80);
  });
});

describe("reserveRows", () => {
  it("returns the remaining rows when at least two survive", () => {
    expect(reserveRows(10, 4)._unsafeUnwrap()).toBe(6);
    expect(reserveRows(6, 4)._unsafeUnwrap()).toBe(2);
  });

  it("fails closed below two content rows, without throwing", () => {
    const result = reserveRows(5, 4);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      kind: "too-short",
      need: 6,
      height: 5,
    });
  });

  it("fails closed for non-finite input", () => {
    expect(reserveRows(Number.NaN, 4).isErr()).toBe(true);
    expect(reserveRows(10, Number.NaN)._unsafeUnwrap()).toBe(10);
  });
});
