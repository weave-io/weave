import {
  PI_LIVE_REASONING_INSPECTOR_MAX_ROWS,
  PI_LIVE_REASONING_INSPECTOR_ROW_MAX_CODE_POINTS,
  PI_LIVE_REASONING_MAX_BYTES,
  PI_LIVE_REASONING_PARENT_MAX_CODE_POINTS,
  PI_LIVE_REASONING_PARENT_PREFIX,
  PI_LIVE_REASONING_TRUNCATION_MARKER,
  PI_LIVE_REASONING_UNPRINTABLE_MARKER,
} from "./child-live-reasoning-types.js";

const textEncoder = new TextEncoder();

export interface PiLiveReasoningNormalizedText {
  readonly text: string;
  readonly hadInput: boolean;
  readonly hadPrintable: boolean;
}

function stripTerminalControls(value: string): string {
  // Build the expressions from code points so the source file contains no
  // control characters in regular-expression literals.
  const terminalEscape = String.fromCodePoint(0x1b);
  const bell = String.fromCodePoint(0x07);
  const withoutAnsi = value
    // OSC and CSI sequences, plus the short ESC forms used by terminals.
    .replace(
      new RegExp(
        String.raw`${terminalEscape}\][^${bell}]*(?:${bell}|${terminalEscape}\\)`,
        "g",
      ),
      "",
    )
    .replace(
      new RegExp(String.raw`${terminalEscape}\[[0-?]*[ -/]*[@-~]`, "g"),
      "",
    )
    .replace(new RegExp(`${terminalEscape}[()][0-2A-Z]`, "g"), "")
    .replace(new RegExp(String.raw`${terminalEscape}[\s\S]`, "g"), "");
  return Array.from(withoutAnsi)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        character === "\n" ||
        character === "\r" ||
        character === "\t" ||
        (codePoint >= 0x20 &&
          codePoint !== 0x7f &&
          !(codePoint >= 0x80 && codePoint <= 0x9f))
      );
    })
    .join("");
}

export function normalizeTerminalText(
  value: string,
): PiLiveReasoningNormalizedText {
  const hadInput = value.length > 0;
  const cleaned = stripTerminalControls(value)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ");
  const lines = cleaned
    .split("\n")
    .map((line) => line.replace(/[ \f\v]+/g, " ").trim());
  const text = lines
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  const hadPrintable = Array.from(text).some(
    (character) => !/\s/u.test(character),
  );
  return { text, hadInput, hadPrintable };
}

/** Normalize one streamed fragment without removing its join-space. */
export function normalizeTerminalFragment(
  value: string,
): PiLiveReasoningNormalizedText {
  const hadInput = value.length > 0;
  const cleaned = stripTerminalControls(value)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ");
  const text = cleaned
    .split("\n")
    .map((line) => line.replace(/[ \f\v]+/g, " "))
    .join("\n")
    .replace(/\n{2,}/g, "\n");
  const hadPrintable = Array.from(text).some(
    (character) => !/\s/u.test(character),
  );
  return { text: hadPrintable ? text : "", hadInput, hadPrintable };
}

function codePoints(value: string): readonly string[] {
  return Array.from(value);
}

export function newestWithMarker(value: string, maxCodePoints: number): string {
  const characters = codePoints(value);
  if (characters.length <= maxCodePoints) return value;
  const marker = codePoints(PI_LIVE_REASONING_TRUNCATION_MARKER);
  const keep = Math.max(0, maxCodePoints - marker.length);
  return `${characters.slice(-keep).join("")}${marker.join("")}`;
}

export function markerWithinCodePointBound(
  value: string,
  maxCodePoints: number,
): string {
  const marker = PI_LIVE_REASONING_TRUNCATION_MARKER;
  const characters = codePoints(value);
  const markerLength = codePoints(marker).length;
  const keep = Math.max(0, maxCodePoints - markerLength);
  return `${characters.slice(-keep).join("")}${marker}`;
}

export function newestUtf8(
  value: string,
  maxBytes: number,
): {
  readonly text: string;
  readonly omitted: boolean;
} {
  const bytes = textEncoder.encode(value).byteLength;
  if (bytes <= maxBytes) return { text: value, omitted: false };
  const characters = codePoints(value);
  let used = 0;
  let start = characters.length;
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const width = textEncoder.encode(characters[index] ?? "").byteLength;
    if (used + width > maxBytes) break;
    used += width;
    start = index;
  }
  return { text: characters.slice(start).join(""), omitted: true };
}

export function reconcileEnd(current: string, ending: string): string {
  if (ending.length === 0 || current === ending) return current;
  if (current.length === 0) return ending;
  if (ending.startsWith(current)) return ending;
  if (current.startsWith(ending) || current.endsWith(ending)) return current;

  const maxOverlap = Math.min(current.length, ending.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (current.endsWith(ending.slice(0, size))) {
      return `${current}${ending.slice(size)}`;
    }
  }
  return `${current}${ending}`;
}

export function parentDisplay(
  text: string,
  omitted: boolean,
  unprintable: boolean,
): string {
  if (text.length === 0)
    return unprintable ? PI_LIVE_REASONING_UNPRINTABLE_MARKER : "";
  const oneLine = text.replace(/\s+/gu, " ").trim();
  if (oneLine.length === 0) {
    return unprintable ? PI_LIVE_REASONING_UNPRINTABLE_MARKER : "";
  }
  const bounded = newestWithMarker(
    oneLine,
    PI_LIVE_REASONING_PARENT_MAX_CODE_POINTS,
  );
  const clipped = bounded !== oneLine;
  if (omitted || clipped) {
    return clipped
      ? bounded
      : markerWithinCodePointBound(
          bounded,
          PI_LIVE_REASONING_PARENT_MAX_CODE_POINTS,
        );
  }
  return bounded;
}

export function inspectorDisplay(
  text: string,
  omitted: boolean,
  unprintable: boolean,
): readonly string[] {
  if (text.length === 0) {
    return unprintable ? [PI_LIVE_REASONING_UNPRINTABLE_MARKER] : [];
  }
  const normalized = text
    .split("\n")
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter((line) => line.length > 0);
  if (normalized.length === 0) {
    return unprintable ? [PI_LIVE_REASONING_UNPRINTABLE_MARKER] : [];
  }

  let lines = normalized.map((line) =>
    newestWithMarker(line, PI_LIVE_REASONING_INSPECTOR_ROW_MAX_CODE_POINTS),
  );
  const lineClipped = lines.some((line, index) => line !== normalized[index]);
  let droppedLines = false;
  if (lines.length > PI_LIVE_REASONING_INSPECTOR_MAX_ROWS) {
    lines = lines.slice(-PI_LIVE_REASONING_INSPECTOR_MAX_ROWS);
    droppedLines = true;
  }
  if (omitted || lineClipped || droppedLines) {
    const last = lines.length - 1;
    if (
      last >= 0 &&
      !lines[last]?.endsWith(PI_LIVE_REASONING_TRUNCATION_MARKER)
    ) {
      lines[last] = markerWithinCodePointBound(
        lines[last] ?? "",
        PI_LIVE_REASONING_INSPECTOR_ROW_MAX_CODE_POINTS,
      );
    }
  }
  return lines;
}

/** Terminal-safe parent one-line projection. */
export function formatPiLiveReasoningParentLine(text: string): string {
  const normalized = normalizeTerminalText(text);
  const value = parentDisplay(
    normalized.text,
    newestUtf8(normalized.text, PI_LIVE_REASONING_MAX_BYTES).omitted,
    normalized.hadInput && !normalized.hadPrintable,
  );
  return value.length === 0 ? "" : `${PI_LIVE_REASONING_PARENT_PREFIX}${value}`;
}

/** Terminal-safe focused-inspector projection. */
export function formatPiLiveReasoningInspectorRows(
  text: string,
): readonly string[] {
  const normalized = normalizeTerminalText(text);
  return inspectorDisplay(
    normalized.text,
    newestUtf8(normalized.text, PI_LIVE_REASONING_MAX_BYTES).omitted,
    normalized.hadInput && !normalized.hadPrintable,
  );
}

/** Exposed for tests that need to prove UTF-8, not UTF-16, accounting. */
export function piLiveReasoningUtf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}
