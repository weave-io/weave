import {
  bodyRows,
  continuationRows,
  gutter,
  headRow,
  PI_NATIVE_BODY_ROWS,
  withCaret,
} from "./child-overlay-pi-native-layout.js";
import type { OverlayPiNativeInput } from "./child-overlay-pi-native-types.js";
import { formatPiChildProviderError } from "./child-provider-error-render.js";
import type {
  PiChildTranscriptAssistantEntry,
  PiChildTranscriptInputEntry,
  PiChildTranscriptTextEntry,
} from "./child-transcript.js";
import type { Paint } from "./ui-paint.js";
import { safeTrim } from "./ui-rows.js";

function promptLabel(kind: "task" | "steering" | "follow_up"): string {
  if (kind === "steering") return "steering prompt";
  if (kind === "follow_up") return "follow-up prompt";
  return "delegation prompt";
}

/** Renders a delegation, steering, or follow-up prompt. */
export function renderPromptEntry(
  paint: Paint,
  entry: PiChildTranscriptInputEntry,
  input: OverlayPiNativeInput,
  width: number,
): string[] {
  const who =
    entry.kind === "task" && input.parentName !== undefined
      ? `${input.parentName} → ${input.childName}`
      : input.childName;
  return [
    headRow(
      `${gutter(paint, "prompt", "run")} ${paint.bold(paint.alt(who))} ${paint.dim(promptLabel(entry.kind))}`,
      width,
    ),
    ...bodyRows(entry.text, width, PI_NATIVE_BODY_ROWS.prompt, (value) =>
      paint.text(value),
    ),
  ];
}

/** Renders a plain text or markdown transcript entry. */
export function renderTextEntry(
  paint: Paint,
  entry: PiChildTranscriptTextEntry,
  input: OverlayPiNativeInput,
  width: number,
): string[] {
  if (entry.kind !== "text" && entry.kind !== "markdown") return [];
  const body = bodyRows(
    entry.text,
    width,
    PI_NATIVE_BODY_ROWS.assistant,
    (value) => paint.text(value),
  );
  if (body.length === 0) return [];
  return [headRow(paint.dim(`${input.childName} · reply`), width), ...body];
}

/** What an assistant message is called in its header. */
function replyLabel(
  entry: PiChildTranscriptAssistantEntry,
  finalResponse: boolean,
): string {
  if (entry.streaming) return "streaming reply";
  return finalResponse ? "final response" : "reply";
}

/** Does this assistant entry have anything for a reader to look at? */
function assistantEntryHasVisibleRows(
  entry: PiChildTranscriptAssistantEntry,
): boolean {
  if (entry.stopReason === "error") return true;
  return safeTrim(entry.text || entry.markdown).length > 0;
}

/** Renders an assistant reply, including its bounded provider failure. */
export function renderAssistantEntry(
  paint: Paint,
  entry: PiChildTranscriptAssistantEntry,
  input: OverlayPiNativeInput,
  width: number,
  finalAssistantId: string | undefined,
): string[] {
  // A tool-use turn is an assistant message with no prose of its own: the
  // reply IS the tool rows below it. A header over nothing states a message
  // the reader cannot read, so it renders nothing at all.
  if (!assistantEntryHasVisibleRows(entry)) return [];
  const rows: string[] = [];
  const streaming = entry.streaming && !input.settled;
  const label = replyLabel(
    entry,
    !entry.streaming && entry.id === finalAssistantId,
  );
  // Assistant rows use the same plain identity in both live and terminal
  // states. The status rail already carries the lifecycle glyph.
  rows.push(headRow(paint.dim(`${input.childName} · ${label}`), width));
  const body = bodyRows(
    entry.text || entry.markdown,
    width,
    PI_NATIVE_BODY_ROWS.assistant,
    (value) => paint.text(value),
  );
  rows.push(...(streaming ? withCaret(paint, body, width) : body));
  // Under Native Settlement this pane is the failure surface too: the
  // classified provider error hangs off the message that failed.
  if (entry.stopReason === "error") {
    rows.push(
      headRow(
        `${gutter(paint, "error", "bad")} ${paint.bad("provider error")}`,
        width,
      ),
      ...continuationRows(
        formatPiChildProviderError(entry.terminalError),
        width,
        PI_NATIVE_BODY_ROWS.error,
        (value) => paint.bad(value),
      ),
    );
  }
  return rows;
}

/** Newest non-streaming assistant entry in a settled pane. */
export function finalAssistantEntryId(
  input: OverlayPiNativeInput,
): string | undefined {
  if (!input.settled) return undefined;
  for (let i = input.entries.length - 1; i >= 0; i -= 1) {
    const entry = input.entries[i];
    if (entry?.kind === "assistant" && !entry.streaming) return entry.id;
  }
  return undefined;
}
