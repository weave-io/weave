import {
  renderAssistantEntry,
  renderPromptEntry,
  renderTextEntry,
} from "./child-overlay-pi-native-assistant.js";
import {
  bodyRows,
  dividerRow,
  gutter,
  headRow,
  PI_NATIVE_BODY_ROWS,
} from "./child-overlay-pi-native-layout.js";
import { renderToolEntry } from "./child-overlay-pi-native-tool.js";
import type { OverlayPiNativeInput } from "./child-overlay-pi-native-types.js";
import { overlayPayloadText } from "./child-overlay-pi-native-values.js";
import type { PiChildTranscriptEntry } from "./child-transcript.js";
import {
  isPiModelFailoverHiddenMarker,
  PI_MODEL_FAILOVER_ENTRY_TYPE,
} from "./model-failover-record.js";
import { renderModelFallbackEvent } from "./model-fallback-event-render.js";
import type { Paint } from "./ui-paint.js";
import { safeTrim } from "./ui-rows.js";

/**
 * Renders one transcript entry. Family-specific details live beside their
 * seams; this dispatcher owns only the complete event vocabulary and the
 * bookkeeping families that have no dedicated renderer.
 */
export function renderEntryRows(
  paint: Paint,
  entry: PiChildTranscriptEntry,
  input: OverlayPiNativeInput,
  width: number,
  finalAssistantId: string | undefined,
): string[] {
  switch (entry.kind) {
    case "task":
    case "steering":
    case "follow_up":
      return renderPromptEntry(paint, entry, input, width);

    // Retained generic-thinking and legacy summary entries are structural
    // compatibility markers only. Live raw reasoning is rendered separately
    // from the mounted projector and never from transcript entries.
    case "thinking":
    case "reasoning_summary":
      return [];

    case "text":
    case "markdown":
      return renderTextEntry(paint, entry, input, width);

    case "assistant":
      return renderAssistantEntry(paint, entry, input, width, finalAssistantId);

    case "tool":
      return renderToolEntry(paint, entry, width);

    case "queue": {
      // An unreported depth prints as unknown: the row may not invent a number
      // the child never stated.
      const first = overlayPayloadText(entry.queue?.[0]);
      return [
        headRow(
          `${gutter(paint, "queue", "warn")} ${paint.warn(`queue ${entry.size ?? "unknown"}`)}`,
          width,
        ),
        ...(first.length === 0
          ? []
          : bodyRows(
              `next · ${first}`,
              width,
              PI_NATIVE_BODY_ROWS.queue,
              (value) => paint.dim(value),
            )),
      ];
    }

    case "status": {
      const note = safeTrim(entry.message ?? "");
      const label = safeTrim(entry.status) || "status";
      return [
        headRow(
          `${gutter(paint, "sys", "mute")} ${paint.dim("status")} ${paint.muted(note.length === 0 ? label : `${label} · ${note}`)}`,
          width,
        ),
      ];
    }

    case "retry": {
      // A retry starts a new attempt of the same work, so it reads as a run
      // divider rather than as one more event in the stream.
      const attempt =
        entry.attempt === undefined ? "" : ` · attempt ${entry.attempt}`;
      const reason = safeTrim(entry.reason ?? "");
      return [
        dividerRow(
          paint,
          `retry${attempt}${reason.length === 0 ? "" : ` · ${reason}`}`,
          width,
        ),
      ];
    }

    case "usage": {
      const summary = overlayPayloadText(entry.usage);
      if (summary.length === 0) return [];
      return [
        headRow(
          `${gutter(paint, "sys", "mute")} ${paint.dim("usage")} ${paint.muted(summary)}`,
          width,
        ),
      ];
    }

    case "image":
      return [
        headRow(
          `${gutter(paint, "sys", "mute")} ${paint.dim("image")} ${paint.muted("binary data omitted")}`,
          width,
        ),
      ];

    // A child's status line, working indicator or notification is a request to
    // paint the HOST's chrome. It is not conversation, so it stays out of the
    // product transcript entirely.
    case "extension_ui":
      return [];

    case "unknown":
      if (isPiModelFailoverHiddenMarker(entry)) return [];
      return entry.originalType === PI_MODEL_FAILOVER_ENTRY_TYPE
        ? [...renderModelFallbackEvent(entry.payload, width, paint)]
        : [];

    // An unrecognised host event carries nothing a reader can act on, and its
    // payload is exactly the raw shape this pane may not print.
    default:
      return [];
  }
}
