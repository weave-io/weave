/**
 * The width-safe row model shared by the delegation card and the child
 * inspector.
 *
 * Three structural guarantees live here, and each one is a property of the
 * types rather than a rule a reviewer has to remember:
 *
 * 1. **Untrusted text cannot forge a frame.** {@link seg} is the only
 *    constructor of a content segment and it runs {@link safeText}, which
 *    deletes the whole box-drawing and block-element range along with ANSI,
 *    OSC payloads and C0/C1 controls. {@link glyph} is the only constructor
 *    that may emit a box-drawing character, and child data can never call it.
 * 2. **Every emitted line obeys its width.** {@link emit} is the only function
 *    that turns rows into terminal output, and it clips and then clamps.
 * 3. **Measurement is separate from colour.** Nothing here decides a colour;
 *    it only names inks. Widths come from `render-width.ts`, which owns the
 *    grapheme and ANSI arithmetic, so this module never re-implements it.
 *
 * Fallible layout arithmetic returns a `Result` with a typed
 * {@link UiLayoutError}. A terminal that is too small is an expected
 * condition, so callers degrade rather than catch.
 *
 * See `docs/specs/33-spec-pi-adapter/33-weave-ui-design.md` §3.
 */

import { err, ok, type Result } from "neverthrow";
import {
  clampToWidth,
  fitLineToWidth,
  measureWidth,
  padLineToWidth,
  truncatePlainToWidth,
} from "./render-width.js";
import type { Ink, Paint } from "./ui-paint.js";

// ---------------------------------------------------------------------------
// Sanitizing
// ---------------------------------------------------------------------------

/**
 * Box drawing (U+2500–U+257F) and block elements (U+2580–U+259F).
 *
 * Deleting this whole range from every content segment is what makes "exactly
 * one frame, and it is ours" a structural property: a child cannot draw a
 * corner, a rail or a bar, so it cannot forge a second card or a fake overlay
 * boundary inside a real one.
 */
const BOX_DRAWING = /[\u2500-\u259F]/gu;

/** Every run of whitespace, including the Unicode line separators. */
const WHITESPACE_RUN = /\s+/gu;

/**
 * Sanitizes untrusted text into something that may safely become a segment.
 *
 * Removes, in order: ANSI CSI sequences, OSC sequences and their payloads,
 * raw C1 introducers, every remaining C0/C1 control byte and DEL, and the
 * box-drawing and block-element range. Whatever survives has its whitespace
 * runs — tabs, newlines, vertical tabs, form feeds, carriage returns, and runs
 * of spaces — collapsed to one space each.
 *
 * Collapsing whitespace means a sanitized segment can never carry layout of
 * its own. Fixed-width padding, indentation and rules are therefore built with
 * {@link fill}, {@link cell} or {@link padRow}, which do not sanitize, and
 * never by embedding spaces in untrusted text.
 *
 * The result is not trimmed, so a caller that deliberately spaces a separator
 * such as `" · "` keeps it. Use {@link safeTrim} for prose.
 */
export function safeText(raw: string): string {
  return stripTerminalControls(raw)
    .replace(BOX_DRAWING, "")
    .replace(WHITESPACE_RUN, " ");
}

/** {@link safeText} for prose: the same sanitizing, then trimmed. */
export function safeTrim(raw: string): string {
  return safeText(raw).trim();
}

/**
 * Removes terminal control sequences and control bytes.
 *
 * Whitespace-bearing controls become a single space rather than vanishing, so
 * `"a\nb"` reads as two words instead of one; every other control byte is
 * dropped outright.
 */
function stripTerminalControls(value: string): string {
  let result = "";
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === 0x1b || code === 0x9b) {
      if (code === 0x1b && value.charCodeAt(index + 1) === 0x5d) {
        // OSC: ESC ] … BEL or ST (ESC \).
        index = skipOscPayload(value, index + 2);
      } else {
        // CSI or any other ESC sequence: skip to a final byte 0x40–0x7e.
        index += code === 0x1b ? 2 : 1;
        while (index < value.length) {
          const terminator = value.charCodeAt(index);
          index += 1;
          if (terminator >= 0x40 && terminator <= 0x7e) break;
        }
      }
      continue;
    }
    if (code === 0x9d) {
      // Raw C1 OSC: skip payload through BEL or ST (C1 0x9c / ESC \).
      index = skipOscPayload(value, index + 1);
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
      // Tab, newline and carriage return survive as whitespace; the rest go.
      if (code === 0x09 || code === 0x0a || code === 0x0d) result += " ";
      index += 1;
      continue;
    }
    result += value[index];
    index += 1;
  }
  return result;
}

/** Advances past an OSC payload starting at `start`, returning the next index. */
function skipOscPayload(value: string, start: number): number {
  let index = start;
  while (index < value.length && value.charCodeAt(index) !== 0x07) {
    if (value.charCodeAt(index) === 0x9c) return index + 1;
    if (
      value.charCodeAt(index) === 0x1b &&
      value.charCodeAt(index + 1) === 0x5c
    ) {
      return index + 2;
    }
    index += 1;
  }
  if (index < value.length && value.charCodeAt(index) === 0x07)
    return index + 1;
  return index;
}

// ---------------------------------------------------------------------------
// Segments and rows
// ---------------------------------------------------------------------------

/** One inked run of text. Always ANSI-free; colour is applied only by `emit`. */
export interface Seg {
  readonly ink: Ink;
  readonly t: string;
}

/** An ordered list of segments that together make one terminal line. */
export type Row = readonly Seg[];

/**
 * The only content segment constructor.
 *
 * Sanitizes with {@link safeText}, so any string that reached this adapter
 * from a child, a model, a tool result or a config file is safe by the time it
 * is a segment.
 */
export function seg(ink: Ink, text: string): Seg {
  return { ink, t: safeText(text) };
}

/**
 * The only constructor that may emit box-drawing and block-element glyphs.
 *
 * The card frame, the overlay frame, the rail divider and the active-block bar
 * call it. Untrusted text cannot, because it only ever reaches {@link seg},
 * whose sanitizer deletes that entire range.
 *
 * The caller is responsible for passing a literal glyph, never interpolated
 * data.
 */
export function glyph(ink: Ink, text: string): Seg {
  return { ink, t: text };
}

/**
 * A repeated-character segment: rules, gutters and exact padding.
 *
 * Not sanitized, because its whole purpose is exact repetition. `character`
 * must be a one-column literal.
 */
export function fill(ink: Ink, character: string, count: number): Seg {
  const repeats = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return { ink, t: repeats > 0 ? character.repeat(repeats) : "" };
}

/** Visible width of a row, in terminal columns. */
export function rowWidth(row: Row): number {
  let total = 0;
  for (const segment of row) total += measureWidth(segment.t);
  return total;
}

/**
 * Clips a row to `width` columns, marking the cut with an ellipsis.
 *
 * Segments are kept whole while they fit; the first segment that does not is
 * truncated and the rest are dropped. Inks are preserved, so a clipped row
 * still reads as the same row.
 */
export function clipRow(row: Row, width: number): Row {
  const limit = normalizeWidth(width);
  if (limit === 0) return [];
  if (rowWidth(row) <= limit) return row;

  const out: Seg[] = [];
  let used = 0;
  for (const segment of row) {
    const room = limit - used;
    if (room <= 0) break;
    const segmentWidth = measureWidth(segment.t);
    if (segmentWidth <= room) {
      out.push(segment);
      used += segmentWidth;
      continue;
    }
    const piece = truncatePlainToWidth(segment.t, room);
    if (measureWidth(piece) > 0) out.push({ ink: segment.ink, t: piece });
    break;
  }
  return out;
}

/**
 * Clips, then pads a row on the right to exactly `width` columns.
 *
 * The pad ink matters: a padded row is often the left column of a joined pair,
 * and padding painted in a background-bearing ink would draw a visible block.
 */
export function padRow(row: Row, width: number, ink: Ink = "dim"): Row {
  const limit = normalizeWidth(width);
  const clipped = clipRow(row, limit);
  const gap = Math.max(0, limit - rowWidth(clipped));
  return gap > 0 ? [...clipped, fill(ink, " ", gap)] : clipped;
}

/**
 * The only function that turns rows into terminal output.
 *
 * Clips first, paints second, and clamps the painted result last. The final
 * clamp is not redundant: a paint may in principle return something wider than
 * it was given, and one over-wide line aborts the whole Pi process.
 */
export function emit(row: Row, width: number, paint: Paint): string {
  const limit = normalizeWidth(width);
  if (limit === 0) return "";
  let out = "";
  for (const segment of clipRow(row, limit)) {
    if (segment.t.length === 0) continue;
    out += paint[segment.ink](segment.t);
  }
  return clampToWidth(out, limit);
}

/**
 * Picks the first candidate row that fits `budget`.
 *
 * Candidates are ordered richest-first, so a ladder states its own drop order
 * and a narrowing terminal walks it deterministically. Returns an empty row
 * when even the poorest candidate does not fit: a ladder's floor is a design
 * decision, not something this helper may guess at by clipping.
 */
export function fitRow(candidates: readonly Row[], budget: number): Row {
  const limit = normalizeWidth(budget);
  for (const candidate of candidates) {
    if (rowWidth(candidate) <= limit) return candidate;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Painted-string helpers
// ---------------------------------------------------------------------------

/**
 * Fits already-painted text to exactly `width` columns, padding on the right.
 *
 * Used for column cells, where a short line must still occupy its column so
 * the next column starts where the header said it would.
 */
export function cell(text: string, width: number): string {
  return padLineToWidth(text, width);
}

/**
 * A left/right row: `left` flush left, `right` flush right, one line.
 *
 * The right side may never take more than 60% of the row, so a long trailing
 * note can never squeeze the leading identity out of view.
 */
export function rowLR(left: string, right: string, width: number): string {
  const limit = normalizeWidth(width);
  if (limit === 0) return "";
  const rightWidth = Math.min(
    measureWidth(right),
    Math.max(0, limit - 2),
    Math.max(8, Math.floor(limit * 0.6)),
  );
  const fittedRight = fitLineToWidth(right, rightWidth);
  const leftWidth = Math.max(0, limit - measureWidth(fittedRight));
  const fittedLeft = cell(
    fitLineToWidth(left, Math.max(0, leftWidth - 1)),
    leftWidth,
  );
  return clampToWidth(`${fittedLeft}${fittedRight}`, limit);
}

/**
 * Joins pieces in priority order, dropping every piece that does not fit —
 * except the first, which is clipped instead.
 *
 * The first piece carries whatever the surface has declared it may never lose,
 * so it degrades rather than disappears. Everything after it is optional by
 * construction.
 */
export function joinFit(
  pieces: readonly string[],
  width: number,
  separator: string,
): string {
  const limit = normalizeWidth(width);
  if (limit === 0) return "";
  const separatorWidth = measureWidth(separator);
  const kept: string[] = [];
  let used = 0;
  for (const piece of pieces) {
    if (piece.length === 0) continue;
    const cost = (kept.length === 0 ? 0 : separatorWidth) + measureWidth(piece);
    if (used + cost > limit) {
      if (kept.length === 0) return fitLineToWidth(piece, limit);
      break;
    }
    kept.push(piece);
    used += cost;
  }
  return kept.join(separator);
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/**
 * Word-wraps already-sanitized single-line text into at most `maxLines` lines.
 *
 * A word wider than the line is truncated rather than broken mid-grapheme, and
 * loss is stated: when anything was dropped, the last kept line ends in an
 * ellipsis. Silent truncation is the one thing a bounded region may not do.
 */
export function wrapPlain(
  text: string,
  width: number,
  maxLines: number,
): string[] {
  const limit = Math.max(4, normalizeWidth(width));
  const rows = Number.isFinite(maxLines) ? Math.floor(maxLines) : 0;
  if (rows <= 0) return [];

  const source = safeTrim(text);
  const words = source.split(" ").filter((word) => word.length > 0);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line.length === 0 ? word : `${line} ${word}`;
    if (measureWidth(next) <= limit) {
      line = next;
      continue;
    }
    if (line.length > 0) lines.push(line);
    if (lines.length >= rows) {
      line = "";
      break;
    }
    line =
      measureWidth(word) <= limit ? word : truncatePlainToWidth(word, limit);
  }
  if (line.length > 0 && lines.length < rows) lines.push(line);
  if (lines.length > rows) lines.length = rows;

  const kept = lines.join(" ");
  if (lines.length > 0 && measureWidth(kept) < measureWidth(source)) {
    const last = lines[lines.length - 1] ?? "";
    lines[lines.length - 1] = truncatePlainToWidth(`${last} …`, limit);
  }
  return lines;
}

/**
 * Word-wraps text into `width` columns with every line carrying `indent`.
 *
 * The indent is applied before fitting, so a continuation line is exactly as
 * wide as the first and hanging text stays aligned under its label.
 */
export function wrapIndented(
  text: string,
  width: number,
  indent: string,
  maxLines: number,
): string[] {
  const limit = normalizeWidth(width);
  const inner = Math.max(1, limit - measureWidth(indent));
  return wrapPlain(text, inner, maxLines).map((line) =>
    cell(`${indent}${line}`, limit),
  );
}

/**
 * Forces a block to exactly `height` lines.
 *
 * Too many lines are cut from whichever end `keep` names; too few are padded
 * with blanks, so a caller that reserved rows always gets the rows it paid
 * for and the region below it never moves.
 */
export function fitTo(
  lines: readonly string[],
  height: number,
  keep: "head" | "tail" = "head",
): string[] {
  const rows = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
  if (rows === 0) return [];
  if (lines.length >= rows) {
    return keep === "head"
      ? lines.slice(0, rows)
      : lines.slice(lines.length - rows);
  }
  return [...lines, ...Array.from({ length: rows - lines.length }, () => "")];
}

/**
 * Stacks grouped sections into exactly `room` lines, dropping detail before
 * dropping a group.
 *
 * The ladder, in order: blank spacers between groups go first; then, if the
 * room is still short, every group keeps its heading plus one row and the
 * remainder is grown round-robin so no group is starved for another's benefit;
 * and only when there is not even room for a heading per group does each group
 * fall back to its single most valuable row.
 *
 * A group is never dropped outright while any group survives, because a
 * missing group reads as "nothing to report" rather than "no room".
 */
export function stackSections(
  sections: ReadonlyArray<readonly string[]>,
  room: number,
): string[] {
  const rows = Number.isFinite(room) ? Math.max(0, Math.floor(room)) : 0;
  if (rows === 0 || sections.length === 0) return [];

  const spaced = sections.flatMap((section, index) =>
    index === 0 ? [...section] : ["", ...section],
  );
  if (spaced.length <= rows) return spaced;

  const tight = sections.flatMap((section) => [...section]);
  if (tight.length <= rows) return tight;

  const count = sections.length;
  if (rows < count * 2) {
    return sections
      .map((section) => section[1] ?? section[0] ?? "")
      .slice(0, rows);
  }

  const take = sections.map((section) => Math.min(2, section.length));
  let used = take.reduce((sum, value) => sum + value, 0);
  let grew = true;
  while (used < rows && grew) {
    grew = false;
    for (let index = 0; index < count && used < rows; index += 1) {
      const section = sections[index] as readonly string[];
      const current = take[index] as number;
      if (current < section.length) {
        take[index] = current + 1;
        used += 1;
        grew = true;
      }
    }
  }
  return sections.flatMap((section, index) => section.slice(0, take[index]));
}

/**
 * Lays painted columns side by side for exactly `height` rows.
 *
 * Short columns are padded rather than refused: a column that ran out of
 * content is normal, and failing the whole join over it would take down a
 * surface that had something to say.
 */
export function joinColumns(
  columns: ReadonlyArray<{
    readonly lines: readonly string[];
    readonly width: number;
  }>,
  height: number,
  separator: string,
): string[] {
  const rows = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
  const out: string[] = [];
  for (let index = 0; index < rows; index += 1) {
    out.push(
      columns
        .map((column) => cell(column.lines[index] ?? "", column.width))
        .join(separator),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fallible layout arithmetic
// ---------------------------------------------------------------------------

/**
 * A terminal that cannot carry the requested layout.
 *
 * Expected, not exceptional: terminals get resized. `need` states the
 * smallest value that would have worked, so a caller can report the shortfall
 * instead of guessing at one.
 */
export type UiLayoutError =
  | {
      readonly kind: "too-narrow";
      readonly need: number;
      readonly width: number;
    }
  | {
      readonly kind: "too-short";
      readonly need: number;
      readonly height: number;
    };

/** Rail sizing band. Width is part of the rail's design, not a bare constant. */
export interface RailGeometry {
  readonly min: number;
  readonly max: number;
  readonly ratio: number;
}

/** The inspector's rail band. */
export const RAIL_GEOMETRY: RailGeometry = Object.freeze({
  min: 30,
  max: 42,
  ratio: 0.34,
});

/**
 * Narrowest transcript pane the inspector is allowed to keep.
 *
 * Below this the rail folds into its compact form instead of squeezing the
 * reading column, so the rail can never buy room by starving the transcript.
 */
export const TRANSCRIPT_MIN = 38;

/**
 * Splits an inner width into a main pane and a right rail, with one separator
 * column between them.
 *
 * Fails closed below `geometry.min + minMain + 1` so the caller degrades to a
 * single-column layout rather than receiving a rail too narrow to read.
 */
export function splitRail(
  width: number,
  geometry: RailGeometry,
  minMain: number = TRANSCRIPT_MIN,
): Result<{ main: number; rail: number }, UiLayoutError> {
  const columns = normalizeWidth(width);
  const need = geometry.min + minMain + 1;
  if (columns < need) {
    return err({ kind: "too-narrow", need, width: columns });
  }
  const preferred = Math.max(
    geometry.min,
    Math.min(geometry.max, Math.round(columns * geometry.ratio)),
  );
  // Never let rail sizing eat into the main pane's minimum.
  const rail = Math.min(preferred, columns - minMain - 1);
  return ok({ main: columns - rail - 1, rail });
}

/**
 * Reserves `chrome` rows out of `height` and returns what is left for content.
 *
 * Fails closed below two content rows: a region with one row cannot show both
 * a thing and the fact that there is more of it, and a caller that knows it
 * has no room can say so instead of drawing a misleading single row.
 */
export function reserveRows(
  height: number,
  chrome: number,
): Result<number, UiLayoutError> {
  const rows = Number.isFinite(height) ? Math.floor(height) : 0;
  const reserved = Number.isFinite(chrome)
    ? Math.max(0, Math.floor(chrome))
    : 0;
  const left = rows - reserved;
  if (left < 2) {
    return err({ kind: "too-short", need: reserved + 2, height: rows });
  }
  return ok(left);
}

/** Floors a caller-supplied width into a usable, non-negative column count. */
function normalizeWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 0;
  return Math.floor(width);
}
