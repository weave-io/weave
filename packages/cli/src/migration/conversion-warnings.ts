/**
 * Conversion warning rendering.
 *
 * Builds the human-readable warning summary block shown after a migration
 * that skipped one or more legacy fields.
 */

import type { ConversionWarning } from "./types.js";

/**
 * Render a warning summary block for skipped legacy fields.
 * Returns an empty string when there are no warnings.
 */
export function renderConversionWarnings(
  warnings: ConversionWarning[],
): string {
  if (warnings.length === 0) return "";
  const lines = [
    "",
    "⚠  Migration warnings — the following legacy fields were skipped:",
    "",
  ];
  for (const w of warnings) {
    lines.push(`  • ${w.field}: ${w.reason}`);
  }
  lines.push("");
  return lines.join("\n");
}
