import {
  PI_LIVE_REASONING_PARENT_PREFIX,
  PI_LIVE_REASONING_TRUNCATION_MARKER,
} from "./child-live-reasoning.js";
import type { OverlayPiNativeInput } from "./child-overlay-pi-native-types.js";
import {
  fitLineToWidth,
  measureWidth,
  truncatePlainToWidth,
} from "./render-width.js";
import { type Paint, paintTone, type Tone } from "./ui-paint.js";
import { cell, safeTrim, wrapIndented } from "./ui-rows.js";

/** Two-column role gutter, mirroring Pi's own primary transcript. */
export const PI_NATIVE_INDENT = "  ";

/** The continuation mark a result, an outcome or a captured failure hangs on. */
export const PI_NATIVE_CONTINUATION = "⎿";

/** The event families the pane distinguishes, and their gutter glyphs. */
export const PI_NATIVE_GLYPH = Object.freeze({
  sys: "·",
  prompt: "❯",
  reason: "✻",
  tool: "⚙",
  assistant: "●",
  error: "✖",
  queue: "↯",
});

export type PiNativeFamily = keyof typeof PI_NATIVE_GLYPH;

/** How many wrapped rows each family may spend on its body. */
export const PI_NATIVE_BODY_ROWS = Object.freeze({
  prompt: 8,
  /** A SUMMARY, never a thought stream. */
  reason: 3,
  tool: 4,
  error: 4,
  assistant: 24,
  queue: 2,
  sys: 1,
});

/** One full-width header row, clipped rather than wrapped. */
export function headRow(text: string, width: number): string {
  return cell(fitLineToWidth(text, width), width);
}

/** A body block: indented, wrapped, bounded, and painted one tone. */
export function bodyRows(
  text: string,
  width: number,
  maxRows: number,
  ink: (value: string) => string,
): string[] {
  const clean = safeTrim(text);
  if (clean.length === 0) return [];
  return wrapIndented(clean, width, PI_NATIVE_INDENT, maxRows).map((line) =>
    cell(ink(line), width),
  );
}

/** A `⎿` continuation block: the prototype's result / failure hanger. */
export function continuationRows(
  text: string,
  width: number,
  maxRows: number,
  ink: (value: string) => string,
): string[] {
  const clean = safeTrim(text);
  if (clean.length === 0) return [];
  return bodyRows(`${PI_NATIVE_CONTINUATION} ${clean}`, width, maxRows, ink);
}

/**
 * Appends the streaming caret without ever overflowing the column.
 * When the last wrapped row already fills the width, the caret takes a row of
 * its own rather than pushing a column past the pane.
 */
export function withCaret(
  paint: Paint,
  rows: readonly string[],
  width: number,
): string[] {
  if (rows.length === 0) {
    return [cell(`${PI_NATIVE_INDENT}${paint.acc("▍")}`, width)];
  }
  const head = rows.slice(0, -1);
  const last = (rows[rows.length - 1] ?? "").replace(/\s+$/u, "");
  if (measureWidth(last) + 1 <= width) {
    return [...head, cell(`${last}${paint.inv(" ")}`, width)];
  }
  return [
    ...head,
    cell(last, width),
    cell(`${PI_NATIVE_INDENT}${paint.acc("▍")}`, width),
  ];
}

/** A full-width rule carrying a centred label. The run divider's own shape. */
export function dividerRow(paint: Paint, label: string, width: number): string {
  const text = safeTrim(label);
  const lead = `── ${text} `;
  const tail = Math.max(0, width - measureWidth(lead));
  return cell(paint.rule(`${lead}${"─".repeat(tail)}`), width);
}

export function gutter(
  paint: Paint,
  family: PiNativeFamily,
  tone: Tone,
): string {
  return paintTone(paint, tone, PI_NATIVE_GLYPH[family]);
}

/**
 * Renders the only transient inspector reasoning surface. The projector has
 * already applied the three-row/content bounds; this final width fit keeps the
 * prefix and an honest truncation marker inside the pane without adding the
 * rows to transcript spans or search indexes.
 */
export function renderLiveReasoningRows(
  paint: Paint,
  input: OverlayPiNativeInput,
  width: number,
): string[] {
  const rows = (input.liveReasoningRows ?? [])
    .map((row) => safeTrim(row))
    .filter((row) => row.length > 0);
  return rows.map((row, index) => {
    const label =
      index === 0
        ? `${PI_LIVE_REASONING_PARENT_PREFIX}${row}`
        : `${PI_NATIVE_INDENT}${row}`;
    return cell(
      paint.text(
        truncatePlainToWidth(label, width, PI_LIVE_REASONING_TRUNCATION_MARKER),
      ),
      width,
    );
  });
}
