/**
 * Terminal width fitting for adapter-owned Pi custom components.
 *
 * Pi's TUI asserts that every line a `ui.custom` component returns has a
 * visible width no greater than the width it passed in. A single over-wide
 * line aborts the whole Pi process, so this module is the one place that
 * decides how a line is cut.
 *
 * Rules this module keeps:
 *
 * - Width is measured with Pi's own `visibleWidth`, so ANSI escapes cost
 *   nothing and wide CJK / emoji graphemes cost two columns.
 * - Cutting uses Pi's `truncateToWidth`, never `String.prototype.slice`, so a
 *   grapheme cluster or an escape sequence is never split in half.
 * - The result is re-measured and hard-clamped. If a styling or ellipsis path
 *   ever produces one column too many, the clamp removes it instead of letting
 *   Pi abort.
 *
 * Nothing here catches or suppresses Pi's width assertion; it makes the
 * assertion unreachable by construction.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Single-column ellipsis. A three-dot `...` would itself cost three columns,
 * which is unusable at the narrow widths Pi can legitimately pass.
 */
const ELLIPSIS = "…";

/**
 * Narrowest width at which an ellipsis still leaves room for real content.
 * Below this the line is cut flush, because `…` alone carries no information.
 */
const MIN_WIDTH_FOR_ELLIPSIS = 2;

/**
 * Columns a suffix must leave for the head before reserving it is worthwhile.
 * One column plus an ellipsis is the least that still names the subject.
 */
const MIN_HEAD_COLUMNS = 2;

/**
 * Fits one line into `width` visible columns.
 *
 * Returns `""` for a non-positive or non-finite width, because Pi can pass a
 * zero width during a resize and an empty line always satisfies the assertion.
 */
export function fitLineToWidth(line: string, width: number): string {
  if (!Number.isFinite(width) || width <= 0) return "";
  const max = Math.floor(width);
  if (visibleWidth(line) <= max) return line;

  const cut =
    max >= MIN_WIDTH_FOR_ELLIPSIS
      ? `${truncateToWidth(line, max - 1, "")}${ELLIPSIS}`
      : truncateToWidth(line, max, "");

  return clampToWidth(cut, max);
}

/**
 * Fits `head + suffix` into `width` columns while keeping `suffix` intact.
 *
 * The overlay header ends in a status the reader needs (`· LIVE`, a settled
 * or read-only marker). Cutting the composed line from the right would drop
 * exactly that, so the suffix reserves its columns first and only the head is
 * truncated.
 *
 * When the suffix cannot keep at least {@link MIN_HEAD_COLUMNS} columns for
 * the head, the suffix stops being affordable and the whole line is cut as an
 * ordinary line: a bare status with no subject is not more useful than a
 * truncated title.
 */
export function fitLineWithSuffix(
  head: string,
  suffix: string,
  width: number,
): string {
  if (!Number.isFinite(width) || width <= 0) return "";
  const max = Math.floor(width);
  const composed = `${head}${suffix}`;
  if (visibleWidth(composed) <= max) return composed;

  const suffixWidth = visibleWidth(suffix);
  const headBudget = max - suffixWidth;
  if (suffixWidth === 0 || headBudget < MIN_HEAD_COLUMNS)
    return fitLineToWidth(composed, max);

  return clampToWidth(`${fitLineToWidth(head, headBudget)}${suffix}`, max);
}

/**
 * Fits every line of a rendered block into `width` visible columns.
 *
 * Line count and order are preserved: a component's scroll and layout maths
 * already ran against these rows, so dropping or splitting one here would move
 * content the caller believes it placed.
 */
export function fitLinesToWidth(
  lines: readonly string[],
  width: number,
): string[] {
  return lines.map((line) => fitLineToWidth(line, width));
}

/**
 * Fits a horizontal rule to at most `width` columns.
 *
 * `cap` keeps short rules short on wide terminals; the width bound always
 * wins over the cap.
 */
export function fitRuleToWidth(
  rule: string,
  width: number,
  cap: number,
): string {
  if (!Number.isFinite(width) || width <= 0) return "";
  const columns = Math.max(0, Math.min(Math.floor(width), Math.floor(cap)));
  if (columns === 0) return "";
  return rule.repeat(columns);
}

/**
 * Last-resort cut used after truncation and after any styling is applied.
 *
 * `truncateToWidth` is trusted for grapheme and ANSI correctness, but the
 * result is verified rather than assumed: a mis-measured grapheme would
 * otherwise reach Pi as a fatal line. Each pass removes one column of budget,
 * so this terminates.
 */
function clampToWidth(text: string, max: number): string {
  let result = text;
  let budget = max;
  while (budget > 0 && visibleWidth(result) > max) {
    budget -= 1;
    result = truncateToWidth(result, budget, "");
  }
  return visibleWidth(result) <= max ? result : "";
}
