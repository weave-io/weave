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

/**
 * Rendered rows one loaded entry occupies in the layout that produced it.
 *
 * Compact renders exactly one row per entry; the full transcript can render
 * many. Only the component knows either number, so it reports the spans of the
 * layout it just painted and the controller uses them to translate between
 * rendered rows and logical entries.
 */
export interface OverlayLayoutSpan {
  readonly entryId: string;
  /** Rendered rows this entry occupies; at least one. */
  readonly rows: number;
}

/**
 * Ceiling on the remembered intra-entry row of a viewport anchor.
 *
 * A viewport anchor is carried across a layout change, so it must stay bounded
 * independently of how tall an entry rendered before the change.
 */
export const MAX_ANCHOR_LINE_OFFSET = 4_096;

/** Ceiling on remembered layout spans; matches the overlay window ceiling. */
export const MAX_LAYOUT_SPANS = 512;

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
  /**
   * Set when content was added or replaced on the newest side while the
   * viewport was scrolled away from the tail. The controller cannot measure
   * how many rendered rows that content occupies, so the adjustment waits for
   * the next `setScrollExtent` measurement and is applied exactly once.
   */
  pendingTailExtentAdjustment: boolean;
  entries: ChildOverlayEntry[];
  anchor: ChildOverlayAnchor | undefined;
  /**
   * Per-entry rendered row counts measured by the last component render, in
   * transcript order (oldest first). `undefined` until a layout is measured,
   * and cleared whenever the layout changes so a stale mapping is never used.
   */
  layoutSpans: readonly OverlayLayoutSpan[] | undefined;
  /**
   * Logical viewport captured before a layout change, waiting for the target
   * layout to be measured. Applied exactly once, by the next measurement.
   */
  pendingViewportAnchor: ChildOverlayAnchor | undefined;
  /** Live tail at capture time; re-followed instead of mapping an anchor. */
  pendingViewportLiveTail: boolean;
}

/** Adopt freshly measured per-entry row spans for the current layout. */
export function setLayoutSpans(
  state: OverlayScrollState,
  spans: readonly OverlayLayoutSpan[] | undefined,
): void {
  if (spans === undefined) {
    state.layoutSpans = undefined;
    return;
  }
  state.layoutSpans = spans
    .map((span) => ({
      entryId: span.entryId,
      rows: Math.max(0, Math.floor(span.rows)),
    }))
    // Entries that render nothing occupy no row and can hold no viewport.
    .filter((span) => span.rows > 0)
    .slice(0, MAX_LAYOUT_SPANS);
}

/** Total rendered rows described by a measured layout. */
function layoutRowTotal(spans: readonly OverlayLayoutSpan[]): number {
  let total = 0;
  for (const span of spans) total += span.rows;
  return total;
}

/**
 * Logical content at the viewport bottom, as an entry plus the row inside it.
 *
 * Offsets count rendered rows up from the newest row, so the bottom visible row
 * sits at `total - 1 - scrollOffset` from the oldest row. Without a measured
 * layout there is nothing to translate, so the legacy entry-indexed anchor is
 * the only available approximation.
 */
export function captureViewportAnchor(
  state: OverlayScrollState,
): ChildOverlayAnchor | undefined {
  const spans = state.layoutSpans;
  if (spans === undefined || spans.length === 0) return anchorFromScroll(state);
  const total = layoutRowTotal(spans);
  if (total === 0) return anchorFromScroll(state);
  const bottomRow = Math.max(
    0,
    Math.min(total - 1, total - 1 - Math.max(0, state.scrollOffset)),
  );
  let start = 0;
  for (const span of spans) {
    if (bottomRow < start + span.rows) {
      return {
        entryId: span.entryId,
        lineOffset: Math.min(bottomRow - start, MAX_ANCHOR_LINE_OFFSET),
      };
    }
    start += span.rows;
  }
  return anchorFromScroll(state);
}

/**
 * Park a logical viewport for the layout that has not been measured yet.
 *
 * The row counts of the target layout are unknown until it renders, so the
 * anchor is held and applied by the next measurement rather than converted now.
 * Following the tail is preserved as an intent instead of an anchor: the tail
 * is the newest row in every layout.
 */
export function captureViewportForLayoutChange(
  state: OverlayScrollState,
): void {
  state.pendingViewportLiveTail = state.liveTail;
  state.pendingViewportAnchor = state.liveTail
    ? undefined
    : captureViewportAnchor(state);
  state.layoutSpans = undefined;
}

/**
 * Place a logical viewport into the freshly measured layout.
 *
 * The anchored entry keeps the same intra-entry row when the target layout
 * renders it that tall, and otherwise degrades to that entry's last row. A row
 * offset from the previous layout is never reused directly.
 */
export function applyViewportAnchor(
  state: OverlayScrollState,
  anchor: ChildOverlayAnchor,
): void {
  const spans = state.layoutSpans;
  const total = spans === undefined ? 0 : layoutRowTotal(spans);
  if (spans === undefined || spans.length === 0 || total === 0) {
    // No measured layout to place the anchor in: clamp instead of leaving an
    // offset from the previous layout in force.
    state.scrollOffset = Math.min(state.scrollOffset, maxScrollRows(state));
    state.liveTail = state.scrollOffset === 0;
    state.anchor = anchorFromScroll(state);
    return;
  }
  let start = 0;
  for (const span of spans) {
    if (span.entryId === anchor.entryId) {
      const withinEntry = Math.min(
        Math.max(0, Math.floor(anchor.lineOffset)),
        span.rows - 1,
      );
      const bottomRow = start + withinEntry;
      const offset = total - 1 - bottomRow;
      state.scrollOffset = Math.min(Math.max(0, offset), maxScrollRows(state));
      state.liveTail = state.scrollOffset === 0;
      state.anchor = anchorFromScroll(state);
      return;
    }
    start += span.rows;
  }
  // Anchored entry left the window between the capture and the measurement:
  // clamp rather than reinterpret the stale offset.
  state.scrollOffset = Math.min(state.scrollOffset, maxScrollRows(state));
  state.liveTail = state.scrollOffset === 0;
  state.anchor = anchorFromScroll(state);
}

/**
 * Record that the newest side of the transcript grew (or shrank) below a
 * manually scrolled viewport. Following the tail needs no adjustment: the
 * offset is already zero and new rows belong on screen.
 */
export function markTailGrowth(state: OverlayScrollState): void {
  if (state.liveTail) return;
  state.pendingTailExtentAdjustment = true;
}

/** Forget a pending adjustment whose extent delta is no longer attributable. */
export function clearTailGrowth(state: OverlayScrollState): void {
  state.pendingTailExtentAdjustment = false;
}

/**
 * Adopt a freshly measured rendered-row extent.
 *
 * Offsets count rows up from the newest rendered row, so rows appended at the
 * tail shift every older row further from the viewport bottom. Leaving the
 * offset alone therefore slides the viewport toward the tail and pushes the
 * anchored content off screen. When tail growth is pending, the measured
 * extent delta is exactly the number of rows the new content occupies, so
 * adding it to the offset holds the same rows on screen.
 *
 * Any number of live events between two renders coalesce into a single delta,
 * because the delta is measured against the extent of the last render.
 */
export function applyMeasuredExtent(
  state: OverlayScrollState,
  extent: number,
  spans?: readonly OverlayLayoutSpan[],
): void {
  const max = Math.max(0, Math.floor(extent));
  if (spans !== undefined) setLayoutSpans(state, spans);

  const parkedAnchor = state.pendingViewportAnchor;
  const parkedLiveTail = state.pendingViewportLiveTail;
  if (parkedAnchor !== undefined || parkedLiveTail) {
    // A layout change is being resolved: the stored offset belongs to the old
    // layout and carries no meaning here.
    state.pendingViewportAnchor = undefined;
    state.pendingViewportLiveTail = false;
    state.pendingTailExtentAdjustment = false;
    state.scrollExtent = max;
    if (parkedLiveTail || parkedAnchor === undefined) {
      state.scrollOffset = 0;
      state.liveTail = true;
      state.anchor = anchorFromScroll(state);
      return;
    }
    applyViewportAnchor(state, parkedAnchor);
    return;
  }

  const previous = state.scrollExtent;
  const pending = state.pendingTailExtentAdjustment;
  state.pendingTailExtentAdjustment = false;
  state.scrollExtent = max;

  if (
    pending &&
    !state.liveTail &&
    previous !== undefined &&
    previous !== max
  ) {
    // Signed: a newest-side replacement that renders fewer rows shrinks the
    // extent, and the viewport must move back down by the same amount.
    const next = state.scrollOffset + (max - previous);
    state.scrollOffset = Math.min(Math.max(0, next), max);
    state.liveTail = state.scrollOffset === 0;
    state.anchor = anchorFromScroll(state);
    return;
  }

  if (state.scrollOffset > max) {
    state.scrollOffset = max;
    state.liveTail = state.scrollOffset === 0;
    state.anchor = anchorFromScroll(state);
  }
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

/**
 * After older rows arrive on a fitting newest page, leave live tail.
 *
 * That page reports `scrollExtent` 0. Restoring the live-tail anchor against
 * that stale measurement keeps the viewport on the newest row, so PageUp and
 * Home never show the prepended history. Forget the measurement and park on
 * the oldest prepended entry until the next paint re-measures.
 */
export function parkFittingNewestPrepend(
  state: OverlayScrollState,
  prependedOldest: ChildOverlayAnchor | undefined,
  retainedCount: number,
): void {
  state.scrollExtent = undefined;
  state.layoutSpans = undefined;
  state.pendingViewportAnchor = undefined;
  state.pendingViewportLiveTail = false;
  state.liveTail = false;
  state.scrollOffset = Math.max(0, Math.floor(retainedCount) - 1);
  if (prependedOldest !== undefined) state.anchor = prependedOldest;
}

/** Place the viewport after older rows were prepended into the window. */
export function restoreAfterOlderPrepend(
  state: OverlayScrollState,
  priorAnchor: ChildOverlayAnchor | undefined,
  prependedOldest: ChildOverlayAnchor | undefined,
  retainedCount: number,
): void {
  if (prependedOldest !== undefined && state.liveTail) {
    parkFittingNewestPrepend(state, prependedOldest, retainedCount);
    return;
  }
  restoreScrollAnchor(state, priorAnchor);
}

/** Park prepended older rows, or restore the prior viewport when none arrived. */
export function restoreAfterOlderEntries(
  state: OverlayScrollState,
  priorAnchor: ChildOverlayAnchor | undefined,
  prependedOldest: { readonly id: string } | undefined,
  retainedCount: number,
): void {
  restoreAfterOlderPrepend(
    state,
    priorAnchor,
    prependedOldest === undefined
      ? undefined
      : { entryId: prependedOldest.id, lineOffset: 0 },
    retainedCount,
  );
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
