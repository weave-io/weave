/**
 * Child overlay scroll model (Spec 33 §7, plan Task 20).
 *
 * Scroll offsets are rendered rows counted up from the newest rendered row,
 * matching what the component paints. Entry counts undercount multi-line
 * entries, so clamping by entry pins the viewport near the tail and makes the
 * oldest rows unreachable. Only the component can measure wrapped row counts,
 * so it reports the extent and the controller clamps against it.
 *
 * Depends on `child-overlay-types.js` only; it never imports the controller,
 * the native component, or the `child-overlay.js` facade.
 */

import {
  type ChildOverlayAnchor,
  type ChildOverlayEntry,
  SCROLL_KEYS,
  SCROLL_PAGE,
} from "./child-overlay-types.js";

/** Scroll-relevant slice of the controller's saved per-child state. */
export interface OverlayScrollState {
  /** Hidden rendered rows between the viewport bottom and the newest row. */
  scrollOffset: number;
  /**
   * Largest valid `scrollOffset` in rendered rows, as
   * measured by the last component render. `undefined` until the first render
   * reports a layout, where the entry count is the only bound available.
   */
  scrollExtent: number | undefined;
  liveTail: boolean;
  entries: ChildOverlayEntry[];
  anchor: ChildOverlayAnchor | undefined;
}

/** Largest valid scroll offset in rendered rows. */
export function maxScrollRows(state: OverlayScrollState): number {
  return Math.max(0, state.scrollExtent ?? state.entries.length);
}

/** Entry that sits at the viewport bottom for the current scroll offset. */
export function anchorFromScroll(
  state: OverlayScrollState,
): ChildOverlayAnchor | undefined {
  if (state.entries.length === 0) return undefined;
  const index = Math.max(
    0,
    Math.min(
      state.entries.length - 1,
      state.entries.length - 1 - state.scrollOffset,
    ),
  );
  const entry = state.entries[index];
  if (entry === undefined) return undefined;
  return { entryId: entry.id, lineOffset: 0 };
}

/** Keep a retained entry as the logical viewport anchor after a window change. */
export function restoreScrollAnchor(
  state: OverlayScrollState,
  anchor: ChildOverlayAnchor | undefined,
): void {
  if (anchor === undefined || state.entries.length === 0) {
    state.anchor = anchorFromScroll(state);
    return;
  }
  const index = state.entries.findIndex((entry) => entry.id === anchor.entryId);
  if (index < 0) {
    // Anchor was trimmed; clamp to the nearest retained edge.
    state.scrollOffset = Math.min(
      state.scrollOffset,
      Math.max(0, state.entries.length - 1),
    );
    state.liveTail = state.scrollOffset === 0;
    state.anchor = anchorFromScroll(state);
    return;
  }
  // Anchor retained: older pages are prepended above the viewport, so the rows
  // below it are unchanged and the row offset still points at the same content.
  state.scrollOffset = Math.min(state.scrollOffset, maxScrollRows(state));
  state.liveTail = state.scrollOffset === 0;
  state.anchor = { entryId: anchor.entryId, lineOffset: anchor.lineOffset };
}

/** Scroll intent for a key press, in rendered rows or as an edge command. */
export function scrollDelta(
  data: string,
): number | "oldest" | "follow" | undefined {
  if (data === SCROLL_KEYS.pageUp) return SCROLL_PAGE;
  if (data === SCROLL_KEYS.pageDown) return -SCROLL_PAGE;
  if (data === SCROLL_KEYS.shiftUp) return 1;
  if (data === SCROLL_KEYS.shiftDown) return -1;
  if (data === SCROLL_KEYS.home) return "oldest";
  if (data === SCROLL_KEYS.end) return "follow";
  return undefined;
}
