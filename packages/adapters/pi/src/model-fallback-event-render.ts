import type { PiModelFailoverRecord } from "./model-failover-record.js";
import {
  PI_MODEL_FAILOVER_ENTRY_TYPE,
  parsePiModelFailoverRecord,
} from "./model-failover-record.js";
import { measureWidth } from "./render-width.js";
import type { Ink, Paint } from "./ui-paint.js";
import { clipRow, emit, fill, glyph, type Row, seg } from "./ui-rows.js";

/** Measured Model Fallback width bands from the approved prototype. */
export const MODEL_FALLBACK_WIDE_MIN = 77;
export const MODEL_FALLBACK_ORIGIN_MIN = 55;
export const MODEL_FALLBACK_DESTINATION_MIN = 27;
export const MODEL_FALLBACK_TITLE_MIN = 16;
export const MODEL_FALLBACK_MIN_WIDTH = 10;

export type ModelFallbackWidthBand =
  | "wide"
  | "secondary-dropped"
  | "origin-dropped"
  | "fallback-title"
  | "short-title"
  | "micro";

export function modelFallbackWidthBand(width: number): ModelFallbackWidthBand {
  const value = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  if (value >= MODEL_FALLBACK_WIDE_MIN) return "wide";
  if (value >= MODEL_FALLBACK_ORIGIN_MIN) return "secondary-dropped";
  if (value >= MODEL_FALLBACK_DESTINATION_MIN) return "origin-dropped";
  if (value >= MODEL_FALLBACK_TITLE_MIN) return "fallback-title";
  if (value >= MODEL_FALLBACK_MIN_WIDTH) return "short-title";
  return "micro";
}

export interface PiReadOnlyEntryRenderer {
  readonly customType: typeof PI_MODEL_FAILOVER_ENTRY_TYPE;
  readonly readOnly: true;
  readonly render: (
    data: unknown,
    width: number,
    paint: Paint,
  ) => readonly string[];
}

function identityText(identity: PiModelFailoverRecord["from"]): string {
  return `${identity.provider}/${identity.id}`;
}

function failureText(record: PiModelFailoverRecord): string {
  return record.failureClass.replaceAll("_", " ");
}

function clipEmit(row: Row, width: number, paint: Paint): string {
  return emit(row, width, paint);
}

function titleRow(ink: Ink, width: number, small: boolean): Row {
  const title = small ? "FALLBACK" : "MODEL FALLBACK";
  return clipRow(
    [glyph(ink, "▌"), fill("bold", " ", 1), seg("bold", title)],
    width,
  );
}

function identityRow(record: PiModelFailoverRecord, width: number): Row {
  return clipRow(
    [
      seg("text", identityText(record.from)),
      seg("dim", " → "),
      seg("acc", identityText(record.to)),
    ],
    width,
  );
}

function destinationRow(record: PiModelFailoverRecord, width: number): Row {
  return clipRow(
    [glyph("acc", "→"), seg("acc", ` ${identityText(record.to)}`)],
    width,
  );
}

function secondaryRow(record: PiModelFailoverRecord, width: number): Row {
  return clipRow(
    [
      seg(
        "dim",
        `${failureText(record)} · native recovery exhausted · continuing in this session`,
      ),
    ],
    width,
  );
}

function ellipsisRow(width: number): Row {
  return clipRow([seg("dim", "…")], width);
}

function rowsForRecord(
  record: PiModelFailoverRecord,
  width: number,
): readonly Row[] {
  const band = modelFallbackWidthBand(width);
  switch (band) {
    case "wide":
      return [
        titleRow("warn", width, false),
        identityRow(record, width),
        secondaryRow(record, width),
      ];
    case "secondary-dropped":
      return [
        titleRow("warn", width, false),
        identityRow(record, width),
        ellipsisRow(width),
      ];
    case "origin-dropped":
      return [
        titleRow("warn", width, false),
        destinationRow(record, width),
        ellipsisRow(width),
      ];
    case "fallback-title":
      return [
        titleRow("warn", width, false),
        destinationRow(record, width),
        ellipsisRow(width),
      ];
    case "short-title":
      return [
        titleRow("warn", width, true),
        destinationRow(record, width),
        ellipsisRow(width),
      ];
    case "micro":
      return [
        titleRow("warn", width, true),
        destinationRow(record, width),
        ellipsisRow(width),
      ];
  }
}

/** Render a validated durable fallback fact through the shared row pipeline. */
export function renderModelFallbackEvent(
  value: unknown,
  width: number,
  paint: Paint,
): readonly string[] {
  const parsed = parsePiModelFailoverRecord(value);
  if (parsed.isErr()) return [];
  const columns = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  return rowsForRecord(parsed.value, columns).map((row) =>
    clipEmit(row, columns, paint),
  );
}

/** Compatibility spelling used by primary and child overlay renderers. */
export const renderPiModelFailoverRecord = renderModelFallbackEvent;

/** One read-only renderer descriptor for the primary native entry path. */
export const modelFallbackEntryRenderer: PiReadOnlyEntryRenderer =
  Object.freeze({
    customType: PI_MODEL_FAILOVER_ENTRY_TYPE,
    readOnly: true,
    render: renderModelFallbackEvent,
  });

export const primaryModelFallbackRenderer = modelFallbackEntryRenderer;

/** Useful for geometry tests without involving ANSI paint. */
export function modelFallbackRowWidths(
  value: unknown,
  width: number,
): readonly number[] {
  const parsed = parsePiModelFailoverRecord(value);
  if (parsed.isErr()) return [];
  const columns = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  return rowsForRecord(parsed.value, columns).map((row) =>
    measureWidth(
      emit(row, columns, {
        text: (text) => text,
        muted: (text) => text,
        dim: (text) => text,
        acc: (text) => text,
        alt: (text) => text,
        frame: (text) => text,
        ok: (text) => text,
        warn: (text) => text,
        bad: (text) => text,
        rule: (text) => text,
        think: (text) => text,
        match: (text) => text,
        bold: (text) => text,
        inv: (text) => text,
      } as Paint),
    ),
  );
}
