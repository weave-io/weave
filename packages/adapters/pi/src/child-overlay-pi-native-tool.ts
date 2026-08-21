import {
  continuationRows,
  gutter,
  headRow,
  PI_NATIVE_BODY_ROWS,
} from "./child-overlay-pi-native-layout.js";
import {
  overlayToolArgs,
  overlayToolOutcome,
  overlayToolTone,
} from "./child-overlay-pi-native-values.js";
import type { PiChildTranscriptToolEntry } from "./child-transcript.js";
import { type Paint, paintTone } from "./ui-paint.js";
import { safeTrim } from "./ui-rows.js";

/** Renders one correlated native tool call and its latest outcome. */
export function renderToolEntry(
  paint: Paint,
  entry: PiChildTranscriptToolEntry,
  width: number,
): string[] {
  const tone = overlayToolTone(entry);
  const name = safeTrim(entry.toolName) || "tool";
  const args = overlayToolArgs(entry);
  const rows = [
    headRow(
      `${gutter(paint, "tool", tone)} ${tone === "bad" ? paint.bad(name) : paint.text(name)}${paint.dim(`(${args})`)}`,
      width,
    ),
  ];
  const outcome = overlayToolOutcome(entry);
  if (outcome !== undefined) {
    rows.push(
      ...continuationRows(outcome, width, PI_NATIVE_BODY_ROWS.tool, (value) =>
        paintTone(paint, tone, value),
      ),
    );
  }
  return rows;
}
