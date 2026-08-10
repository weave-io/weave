/**
 * Logical viewport preservation across compact-mode toggles (Spec 33 §7).
 *
 * Full and compact are two layouts of the same entries with different row
 * counts: full can paint many rendered rows for an entry that compact paints in
 * one. A rendered-row offset therefore means nothing in the other layout, and
 * reusing it as if it were an entry index moves the reader to unrelated
 * content. These tests pin the mapping at the component/controller seam: spans
 * measured by the render, a logical anchor captured before the layout change,
 * and the anchor re-placed once the target layout is measured.
 */

import { describe, expect, it } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  createChildOverlayController,
  createMemoryChildOverlaySource,
  type MemoryOverlaySourceChild,
  type MemoryOverlaySourceEntry,
} from "../child-overlay.js";
import { spansFromRows } from "../child-overlay-component.js";
import type { OverlayLayoutSpan } from "../child-overlay-scroll.js";

initTheme("default");

function message(id: string, role: "user" | "assistant", content: string) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role, content },
  };
}

function sourceEntries(count: number): MemoryOverlaySourceEntry[] {
  const result: MemoryOverlaySourceEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    result.push({
      id: `e${i}`,
      payload: message(
        `e${i}`,
        i % 2 === 0 ? "user" : "assistant",
        `text-${i}`,
      ),
    });
  }
  return result;
}

function child(
  entries: MemoryOverlaySourceEntry[],
  live = false,
): MemoryOverlaySourceChild {
  return {
    threadId: "vp-1",
    childId: "vp-1",
    status: live ? "live" : "settled",
    title: undefined,
    generationId: live ? "gen-1" : undefined,
    parentChildId: undefined,
    runs: [{ run: 1, action: "start" }],
    branchIds: ["main"],
    descendantChildIds: [],
    entries,
  };
}

const ENTRY_COUNT = 12;
/** Rows the full transcript paints per entry; `e3` wraps to five rows. */
const FULL_ROWS: readonly number[] = [1, 1, 1, 5, 1, 1, 1, 1, 1, 1, 1, 1];
/** Rows the visible transcript area can hold. */
const CONTENT_BUDGET = 3;

function fullSpans(): readonly OverlayLayoutSpan[] {
  return FULL_ROWS.map((rows, index) => ({ entryId: `e${index}`, rows }));
}

function compactSpans(): readonly OverlayLayoutSpan[] {
  return Array.from({ length: ENTRY_COUNT }, (_unused, index) => ({
    entryId: `e${index}`,
    rows: 1,
  }));
}

/** The rendered rows a layout paints, one label per row. */
function layoutRows(spans: readonly OverlayLayoutSpan[]): string[] {
  const rows: string[] = [];
  for (const span of spans) {
    for (let line = 0; line < span.rows; line += 1) {
      rows.push(`${span.entryId}#${line}`);
    }
  }
  return rows;
}

/** Extent the component reports for a layout: total rows minus the budget. */
function extentOf(spans: readonly OverlayLayoutSpan[]): number {
  return Math.max(0, layoutRows(spans).length - CONTENT_BUDGET);
}

/**
 * The rows the component would paint, using the same slice arithmetic as
 * `render`: offsets count hidden rows up from the newest row.
 */
function visibleRows(
  spans: readonly OverlayLayoutSpan[],
  scrollOffset: number,
): string[] {
  const rows = layoutRows(spans);
  const end = rows.length - scrollOffset;
  return rows.slice(Math.max(0, end - CONTENT_BUDGET), end);
}

function bottomRow(
  spans: readonly OverlayLayoutSpan[],
  scrollOffset: number,
): string {
  const visible = visibleRows(spans, scrollOffset);
  const last = visible.at(-1);
  expect(last).toBeDefined();
  return last ?? "";
}

function bottomEntryId(
  spans: readonly OverlayLayoutSpan[],
  scrollOffset: number,
): string {
  return bottomRow(spans, scrollOffset).split("#")[0] ?? "";
}

async function openOverlay(live = false) {
  const source = createMemoryChildOverlaySource([
    child(sourceEntries(ENTRY_COUNT), live),
  ]);
  const overlay = createChildOverlayController(source, { pageSize: 50 });
  const opened = await overlay.open("vp-1");
  expect(opened.isOk()).toBe(true);
  expect(opened._unsafeUnwrap().entries.length).toBe(ENTRY_COUNT);
  return overlay;
}

/** Report a rendered full layout, as the component does after each paint. */
function measureFull(overlay: Awaited<ReturnType<typeof openOverlay>>) {
  return overlay
    .setScrollExtent(extentOf(fullSpans()), fullSpans())
    ._unsafeUnwrap();
}

function measureCompact(overlay: Awaited<ReturnType<typeof openOverlay>>) {
  return overlay
    .setScrollExtent(extentOf(compactSpans()), compactSpans())
    ._unsafeUnwrap();
}

describe("child overlay view-mode viewport", () => {
  it("keeps the same logical entry visible across both toggle directions", async () => {
    const overlay = await openOverlay();
    measureFull(overlay);

    // Park the viewport bottom on the third rendered row of `e3`, the entry
    // that wraps to five rows in the full layout.
    const fullRows = layoutRows(fullSpans());
    const anchoredRow = fullRows.indexOf("e3#2");
    expect(anchoredRow).toBeGreaterThan(0);
    const parkedOffset = fullRows.length - 1 - anchoredRow;
    const parked = overlay.setScrollOffset(parkedOffset)._unsafeUnwrap();
    expect(parked.scrollOffset).toBe(parkedOffset);
    expect(bottomRow(fullSpans(), parked.scrollOffset)).toBe("e3#2");
    expect(parked.liveTail).toBe(false);

    // full → compact: the target layout is measured after the toggle.
    const toggled = overlay.toggleViewMode()._unsafeUnwrap();
    expect(toggled.viewMode).toBe("compact");
    const inCompact = measureCompact(overlay);
    expect(bottomEntryId(compactSpans(), inCompact.scrollOffset)).toBe("e3");
    expect(visibleRows(compactSpans(), inCompact.scrollOffset)).toContain(
      "e3#0",
    );
    // The full-layout row offset must never be reused as a compact position.
    expect(inCompact.scrollOffset).not.toBe(parkedOffset);
    expect(inCompact.liveTail).toBe(false);

    // compact → full: the same logical entry comes back.
    const back = overlay.toggleViewMode()._unsafeUnwrap();
    expect(back.viewMode).toBe("full");
    const inFull = measureFull(overlay);
    expect(bottomEntryId(fullSpans(), inFull.scrollOffset)).toBe("e3");
    expect(visibleRows(fullSpans(), inFull.scrollOffset)).toContain("e3#0");
    expect(inFull.liveTail).toBe(false);
  });

  it("restores the same rendered rows on a full → compact → full round trip", async () => {
    const overlay = await openOverlay();
    measureFull(overlay);

    // Anchor on the first row of the tall entry, a position both layouts can
    // represent, so the round trip is exact rather than degraded.
    const fullRows = layoutRows(fullSpans());
    const anchoredRow = fullRows.indexOf("e3#0");
    const parkedOffset = fullRows.length - 1 - anchoredRow;
    overlay.setScrollOffset(parkedOffset)._unsafeUnwrap();
    const before = visibleRows(fullSpans(), parkedOffset);
    expect(before.at(-1)).toBe("e3#0");

    overlay.toggleViewMode()._unsafeUnwrap();
    measureCompact(overlay);
    overlay.toggleViewMode()._unsafeUnwrap();
    const roundTripped = measureFull(overlay);

    expect(roundTripped.viewMode).toBe("full");
    expect(roundTripped.scrollOffset).toBe(parkedOffset);
    expect(visibleRows(fullSpans(), roundTripped.scrollOffset)).toEqual(before);
  });

  it("degrades an unrepresentable intra-entry row to the same entry", async () => {
    const overlay = await openOverlay();
    measureFull(overlay);
    const fullRows = layoutRows(fullSpans());
    const parkedOffset = fullRows.length - 1 - fullRows.indexOf("e3#4");
    overlay.setScrollOffset(parkedOffset)._unsafeUnwrap();

    overlay.toggleViewMode()._unsafeUnwrap();
    const inCompact = measureCompact(overlay);
    // Compact paints one row per entry, so row four of `e3` cannot be held;
    // the entry itself still is.
    expect(bottomEntryId(compactSpans(), inCompact.scrollOffset)).toBe("e3");

    overlay.toggleViewMode()._unsafeUnwrap();
    const inFull = measureFull(overlay);
    expect(bottomRow(fullSpans(), inFull.scrollOffset)).toBe("e3#0");
  });

  it("keeps following the tail across both toggle directions", async () => {
    const overlay = await openOverlay();
    const measured = measureFull(overlay);
    expect(measured.liveTail).toBe(true);
    expect(measured.scrollOffset).toBe(0);

    overlay.toggleViewMode()._unsafeUnwrap();
    const inCompact = measureCompact(overlay);
    expect(inCompact.liveTail).toBe(true);
    expect(inCompact.scrollOffset).toBe(0);
    expect(bottomEntryId(compactSpans(), inCompact.scrollOffset)).toBe(
      `e${ENTRY_COUNT - 1}`,
    );

    overlay.toggleViewMode()._unsafeUnwrap();
    const inFull = measureFull(overlay);
    expect(inFull.liveTail).toBe(true);
    expect(inFull.scrollOffset).toBe(0);
    expect(bottomEntryId(fullSpans(), inFull.scrollOffset)).toBe(
      `e${ENTRY_COUNT - 1}`,
    );
  });

  it("preserves draft, search and per-entry state across the toggle", async () => {
    // A settled child is read-only, so the draft is exercised on a live one.
    const overlay = await openOverlay(true);
    measureFull(overlay);
    overlay.updateDraft("keep me")._unsafeUnwrap();
    const searched = await overlay.search("text-3");
    expect(searched.isOk()).toBe(true);

    const before = overlay.view()._unsafeUnwrap();
    overlay.toggleViewMode()._unsafeUnwrap();
    const after = measureCompact(overlay);

    expect(after.draft).toBe("keep me");
    expect(after.searchQuery).toBe(before.searchQuery);
    expect(after.searchMatches).toEqual(before.searchMatches);
    expect(after.entries.map((entry) => entry.id)).toEqual(
      before.entries.map((entry) => entry.id),
    );
  });

  it("derives full-layout spans from the renderer's per-entry rows", () => {
    const spans = spansFromRows([
      {
        id: "r0",
        entryId: "a",
        factId: "a:0",
        sequence: 0,
        kind: "text",
        lines: ["one", "two"],
        provenance: "fallback",
      },
      {
        id: "r1",
        entryId: "a",
        factId: "a:1",
        sequence: 1,
        kind: "text",
        lines: ["three"],
        provenance: "fallback",
      },
      {
        id: "r2",
        entryId: "b",
        factId: "b:0",
        sequence: 2,
        kind: "text",
        lines: ["four"],
        provenance: "fallback",
      },
    ]);
    expect(spans).toEqual([
      { entryId: "a", rows: 3 },
      { entryId: "b", rows: 1 },
    ]);
  });
});
