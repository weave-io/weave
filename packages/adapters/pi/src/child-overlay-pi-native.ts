/**
 * Stable façade for the native child overlay renderer.
 *
 * Family-specific renderers and bounded payload projection live in focused
 * modules. This file keeps the public imports and owns only pane composition,
 * search indexing, and the whole-view fallback.
 */

import { finalAssistantEntryId } from "./child-overlay-pi-native-assistant.js";
import { renderEntryRows } from "./child-overlay-pi-native-entry.js";
import {
  PI_NATIVE_CONTINUATION,
  renderLiveReasoningRows,
} from "./child-overlay-pi-native-layout.js";
import type {
  OverlayPiNativeInput,
  OverlayPiNativePane,
  OverlayPiNativeSpan,
  OverlayTranscriptInput,
  OverlayTranscriptRender,
} from "./child-overlay-pi-native-types.js";
import { boundText } from "./child-overlay-replay.js";
import type { ChildOverlayEntry } from "./child-overlay-types.js";
import { formatPiChildProviderError } from "./child-provider-error-render.js";
import { fitLineToWidth } from "./render-width.js";
import { type Paint, plainPaint } from "./ui-paint.js";
import { cell } from "./ui-rows.js";

export type { PiNativeFamily } from "./child-overlay-pi-native-layout.js";
export {
  PI_NATIVE_CONTINUATION,
  PI_NATIVE_GLYPH,
  PI_NATIVE_INDENT,
} from "./child-overlay-pi-native-layout.js";
export type {
  OverlayPiNativeInput,
  OverlayPiNativePane,
  OverlayPiNativeSpan,
  OverlayTranscriptInput,
  OverlayTranscriptRender,
} from "./child-overlay-pi-native-types.js";
export {
  normalizeOverlayPayload,
  overlayPayloadText,
  overlayToolArgs,
  overlayToolOutcome,
  overlayToolResultText,
  overlayToolTarget,
  overlayToolTone,
  summarizeOverlayValue,
} from "./child-overlay-pi-native-values.js";

/**
 * The transcript pane at one width, painted and plain, with its row spans.
 * Rendering is per-entry and stateless across entries, so the row → entry map
 * the search rail and viewport anchor need comes for free.
 */
export function renderOverlayPiNative(
  paint: Paint,
  input: OverlayPiNativeInput,
  width: number,
): OverlayPiNativePane {
  const columns = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  const bare = plainPaint();
  const finalId = finalAssistantEntryId(input);
  const transientLines = renderLiveReasoningRows(paint, input, columns);
  const transientPlainLines = renderLiveReasoningRows(bare, input, columns);
  const painted: string[] = [...transientLines];
  const plain: string[] = [...transientPlainLines];
  const spans: OverlayPiNativeSpan[] = [];
  for (const entry of input.entries) {
    const rows = renderEntryRows(paint, entry, input, columns, finalId);
    if (rows.length === 0) continue;
    const twin = renderEntryRows(bare, entry, input, columns, finalId);
    // Separator row, exactly as the prototype spaces its events apart.
    painted.push(...rows, "");
    plain.push(...twin, "");
    const entryId = entry.overlayEntryId ?? entry.id;
    const last = spans[spans.length - 1];
    if (last !== undefined && last.entryId === entryId) {
      spans[spans.length - 1] = {
        entryId,
        rows: last.rows + rows.length + 1,
      };
      continue;
    }
    spans.push({ entryId, rows: rows.length + 1 });
  }
  return { painted, plain, spans, transientLines: transientPlainLines };
}

/**
 * THE SEARCH INDEX: what the reader can actually read, per entry. It is
 * grouped straight out of the pane's ANSI-free twin, with the same width,
 * bounds, sanitization, and truncation as the painted rows.
 */
export function overlayTranscriptSearchIndex(
  pane: Pick<OverlayPiNativePane, "plain" | "spans" | "transientLines">,
): Map<string, string> {
  const index = new Map<string, string>();
  let row = pane.transientLines?.length ?? 0;
  for (const span of pane.spans) {
    const rows = pane.plain.slice(row, row + span.rows);
    row += span.rows;
    // Rows are joined with a space, not a newline: a newline separator would
    // silently glue the last word of one row to the first of the next.
    const text = rows
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join(" ");
    if (text.length === 0) continue;
    const existing = index.get(span.entryId);
    index.set(
      span.entryId,
      existing === undefined ? text : `${existing} ${text}`,
    );
  }
  return index;
}

/** Keeps the search index bounded to the current overlay window. */
function searchIndexForWindow(
  index: ReadonlyMap<string, string>,
  windowEntries: readonly ChildOverlayEntry[],
): Map<string, string> {
  const narrowed = new Map<string, string>();
  for (const entry of windowEntries) {
    const text = index.get(entry.id);
    if (text === undefined) continue;
    narrowed.set(entry.id, text);
  }
  return narrowed;
}

/**
 * The transcript block the inspector actually mounts. This adds the two
 * whole-view facts around the native pane and nothing else.
 */
export function renderOverlayTranscript(
  paint: Paint,
  input: OverlayTranscriptInput,
  width: number,
): OverlayTranscriptRender {
  const columns = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  const failureRow =
    input.terminalError === undefined
      ? undefined
      : cell(
          paint.bad(
            fitLineToWidth(
              `${PI_NATIVE_CONTINUATION} ${formatPiChildProviderError(input.terminalError)}`,
              columns,
            ),
          ),
          columns,
        );
  const rendered = renderOverlayPiNative(paint, input, columns);
  // The classified failure is already hung off the assistant message that
  // failed; appending it again would state one failure twice.
  const lines =
    failureRow === undefined || input.terminalErrorStated
      ? rendered.painted
      : [...rendered.painted, failureRow];
  if (lines.length > 0) {
    return {
      lines,
      spans: rendered.spans,
      transientLines: rendered.transientLines ?? [],
      searchIndex: searchIndexForWindow(
        overlayTranscriptSearchIndex(rendered),
        input.windowEntries,
      ),
    };
  }
  // Nothing the pane can draw yet. The bounded overlay entry text still names
  // the kinds, which beats an empty inspector.
  const fallback = input.windowEntries
    .filter((entry) => entry.kind !== "thinking")
    .map((entry) =>
      cell(
        paint.muted(
          fitLineToWidth(
            boundText(
              entry.expanded || entry.text.length <= 120
                ? `[${entry.kind}] ${entry.text}`
                : `[${entry.kind}] ${entry.text.slice(0, 117)}…`,
            ),
            columns,
          ),
        ),
        columns,
      ),
    );
  return {
    lines: failureRow === undefined ? fallback : [...fallback, failureRow],
    spans: input.windowEntries
      .filter((entry) => entry.kind !== "thinking")
      .map((entry) => ({ entryId: entry.id, rows: 1 })),
    transientLines: [],
    // The fallback prints the window entry's own text, which search already
    // matches directly, so it contributes no second index.
    searchIndex: new Map<string, string>(),
  };
}
