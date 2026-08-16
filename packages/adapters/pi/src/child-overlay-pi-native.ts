/**
 * The child inspector's transcript pane: the prototype's `renderPiNative`,
 * ported, and fed from authoritative production transcript entries.
 *
 * `prototypes/weave-pi-tui-grilling.ts` settled this surface in round 3 and it
 * is the design record: a two-column role gutter, one glyph per event family,
 * a bare tool call signature with its result on a `⎿` continuation, a
 * deliberately understated reasoning SUMMARY, and a streaming caret that moves
 * to its own row rather than overflowing the column. Under Native Settlement
 * this pane is also the OUTCOME surface — the final response, the captured
 * failure and the retry record are ordinary rows in the same one style.
 *
 * What production changes, and why:
 *
 * - The prototype's mock `ChildEvent` list is replaced by
 *   {@link PiChildTranscriptEntry}, the reducer's own bounded projection. Live
 *   events and replayed history both land there, so a rebuilt window renders
 *   byte-identically to the live stream that produced it.
 * - Every body is BOUNDED. The prototype wraps freely because its fixtures are
 *   three lines long; a real child is not, so each family declares how many
 *   rows it may spend and `wrapIndented` states the loss with an ellipsis.
 * - Nothing untrusted reaches a row un-sanitized: prose goes through
 *   `safeTrim`, and any value that could carry a storage location goes through
 *   `stripPathLike` first. Raw provider payloads, image bytes, native shell
 *   markers and thought streams never reach a row at all.
 * - The prototype's per-event timestamp column has no authoritative production
 *   source, so it is absent rather than invented.
 *
 * The pane is rendered TWICE at one width — once with the caller's paint and
 * once ANSI-free — exactly as the prototype's `renderTranscriptPane` does.
 * Every primitive measures with `measureWidth`, so row `i` of the plain render
 * is the exact twin of row `i` of the painted one, which is what lets search
 * count matches and place its gutter without ever slicing a painted byte.
 */

import { boundText } from "./child-overlay-replay.js";
import { stripPathLike } from "./child-overlay-search.js";
import type { ChildOverlayEntry } from "./child-overlay-types.js";
import type { PiChildProviderError } from "./child-provider-error.js";
import { formatPiChildProviderError } from "./child-provider-error-render.js";
import type {
  PiChildTranscriptAssistantEntry,
  PiChildTranscriptEntry,
  PiChildTranscriptToolEntry,
} from "./child-transcript.js";
import { fitLineToWidth, measureWidth } from "./render-width.js";
import { type Paint, paintTone, plainPaint, type Tone } from "./ui-paint.js";
import { cell, safeTrim, wrapIndented } from "./ui-rows.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Two-column role gutter, mirroring Pi's own primary transcript. */
export const PI_NATIVE_INDENT = "  ";

/** The continuation mark a result, an outcome or a captured failure hangs on. */
export const PI_NATIVE_CONTINUATION = "⎿";

/** The event families the pane distinguishes, and their gutter glyphs. */
export const PI_NATIVE_GLYPH = Object.freeze({
  sys: "·",
  prompt: "❯",
  reason: "✻",
  tool: "⚙",
  assistant: "●",
  error: "✖",
  queue: "↯",
});

export type PiNativeFamily = keyof typeof PI_NATIVE_GLYPH;

/**
 * How many wrapped rows each family may spend on its body.
 *
 * The prototype has no ceiling because its fixtures are three lines long. A
 * real child's message, tool result or captured failure is unbounded, and a
 * transcript row budget that one entry can exhaust is not a transcript.
 */
const PI_NATIVE_BODY_ROWS = Object.freeze({
  prompt: 8,
  /** A SUMMARY, never a thought stream. */
  reason: 3,
  tool: 4,
  error: 4,
  assistant: 24,
  queue: 2,
  sys: 1,
});

/** Characters of one summarized argument, result or queue item. */
const PI_NATIVE_VALUE_CHARS = 240;

/** Nesting depth a summarized payload is walked to before it folds. */
const PI_NATIVE_VALUE_DEPTH = 2;

/** Keys of one summarized object. */
const PI_NATIVE_VALUE_KEYS = 4;

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

/** One rendered entry's row span, in the identity space the viewport anchors on. */
export interface OverlayPiNativeSpan {
  readonly entryId: string;
  readonly rows: number;
}

/** The transcript pane, painted and plain, with its row → entry map. */
export interface OverlayPiNativePane {
  readonly painted: readonly string[];
  readonly plain: readonly string[];
  readonly spans: readonly OverlayPiNativeSpan[];
}

/**
 * Everything the pane may print about a child, and nothing else.
 *
 * There is no child id, no thread id, no session path and no descriptor here:
 * the pane names the two agents in a delegation and prints the reducer's own
 * bounded facts.
 */
export interface OverlayPiNativeInput {
  readonly entries: readonly PiChildTranscriptEntry[];
  /** What the header calls this child. Never an id. */
  readonly childName: string;
  /** The dispatching agent, when an authoritative source named one. */
  readonly parentName?: string;
  /**
   * The child has settled. A settled pane is frozen: the streaming caret is
   * gone and the newest assistant message is the final response, because
   * settlement is the only completion authority the overlay has.
   */
  readonly settled: boolean;
}

/**
 * The pane's facts plus the two things only the whole view knows: the run's
 * classified terminal failure, and the bounded overlay window that still names
 * the kinds when the reducer has produced nothing drawable yet.
 */
export interface OverlayTranscriptInput extends OverlayPiNativeInput {
  /** Latest classified provider failure for the RUN, already sanitized. */
  readonly terminalError?: PiChildProviderError;
  /** The bounded overlay window, used only when the pane renders nothing. */
  readonly windowEntries: readonly ChildOverlayEntry[];
  /** True when an assistant message already carries the classified failure. */
  readonly terminalErrorStated: boolean;
}

/** Painted transcript rows plus the per-entry row spans that produced them. */
export interface OverlayTranscriptRender {
  readonly lines: readonly string[];
  readonly spans: readonly OverlayPiNativeSpan[];
}

// ---------------------------------------------------------------------------
// Bounded value summaries
// ---------------------------------------------------------------------------

/**
 * A bounded, path-free, one-line rendering of an opaque payload.
 *
 * Tool arguments, tool results and queued items are host JSON. They are shown
 * because a reader cannot follow a run without them, and they are shown ONLY
 * like this: depth-limited, key-limited, character-limited, sanitized, and
 * with anything that looks like a storage location replaced.
 */
export function summarizeOverlayValue(value: unknown, depth = 0): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "string") return safeTrim(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value !== "object") return "";
  if (depth >= PI_NATIVE_VALUE_DEPTH) return "…";
  if (Array.isArray(value)) {
    const shown = value
      .slice(0, PI_NATIVE_VALUE_KEYS)
      .map((item) => summarizeOverlayValue(item, depth + 1))
      .filter((item) => item.length > 0);
    const rest = value.length - shown.length;
    return `${shown.join(", ")}${rest > 0 ? ` …+${rest}` : ""}`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).slice(0, PI_NATIVE_VALUE_KEYS);
  const shown = keys
    .map((key) => {
      const item = summarizeOverlayValue(record[key], depth + 1);
      return item.length === 0 ? "" : `${safeTrim(key)}: ${item}`;
    })
    .filter((item) => item.length > 0);
  const rest = Object.keys(record).length - keys.length;
  return `${shown.join(", ")}${rest > 0 ? ` …+${rest}` : ""}`;
}

/** {@link summarizeOverlayValue}, bounded and stripped of storage locations. */
export function overlayPayloadText(value: unknown): string {
  const summary = summarizeOverlayValue(unwrapSoleContent(value));
  if (summary.length === 0) return "";
  return stripPathLike(summary).slice(0, PI_NATIVE_VALUE_CHARS).trim();
}

/**
 * Pi wraps a tool's answer in `{ content: … }`. Printing the wrapper spends a
 * scarce transcript column on a key that carries no information, so a payload
 * whose ONLY surviving key is `content` is shown as that value. Any payload
 * with a second key keeps its keys, because then the shape is the information.
 */
function unwrapSoleContent(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "content") return value;
  return (value as Record<string, unknown>).content;
}

/**
 * The single argument a tool row leads with, when one reads as its target.
 *
 * A `read` call is about a file and a `bash` call is about a command; naming
 * that value is what makes a call signature readable at a glance. It is the
 * first string-valued argument, sanitized like every other payload, and it is
 * absent when the arguments carry no such value — never guessed from the name.
 */
export function overlayToolTarget(entry: PiChildTranscriptToolEntry): string {
  if (!entry.argumentsKnown) return "";
  const args = entry.arguments;
  if (typeof args === "string") return overlayPayloadText(args);
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return "";
  }
  for (const value of Object.values(args as Record<string, unknown>)) {
    if (typeof value === "string" && safeTrim(value).length > 0) {
      return overlayPayloadText(value);
    }
  }
  return "";
}

/** Every argument of a tool call, as the call signature prints them. */
export function overlayToolArgs(entry: PiChildTranscriptToolEntry): string {
  return entry.argumentsKnown ? overlayPayloadText(entry.arguments) : "";
}

/**
 * What the latest phase of a tool call produced, in one bounded line.
 *
 * `undefined` means the call has produced nothing yet, which the rail prints
 * as unknown rather than as an empty success.
 */
export function overlayToolOutcome(
  entry: PiChildTranscriptToolEntry,
): string | undefined {
  if (entry.error !== undefined) {
    const detail = safeTrim(entry.error);
    return detail.length === 0 ? "failed" : stripPathLike(detail);
  }
  if (entry.result !== undefined) {
    const text = overlayPayloadText(entry.result);
    return text.length === 0 ? "done" : text;
  }
  const partial = entry.partialResults[entry.partialResults.length - 1];
  if (partial !== undefined) {
    const text = overlayPayloadText(partial);
    return text.length === 0 ? "running" : text;
  }
  if (entry.state === "called") return "running";
  return undefined;
}

/** The tone the latest phase of a tool call carries on every surface. */
export function overlayToolTone(entry: PiChildTranscriptToolEntry): Tone {
  if (entry.error !== undefined || entry.state === "error") return "bad";
  if (entry.state === "result") return "ok";
  if (entry.state === "placeholder") return "mute";
  return "run";
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

/** One full-width header row, clipped rather than wrapped. */
function headRow(text: string, width: number): string {
  return cell(fitLineToWidth(text, width), width);
}

/** A body block: indented, wrapped, bounded, and painted one tone. */
function bodyRows(
  text: string,
  width: number,
  maxRows: number,
  ink: (value: string) => string,
): string[] {
  const clean = safeTrim(text);
  if (clean.length === 0) return [];
  return wrapIndented(clean, width, PI_NATIVE_INDENT, maxRows).map((line) =>
    cell(ink(line), width),
  );
}

/**
 * A `⎿` continuation block: the prototype's result / failure hanger.
 *
 * The mark belongs to the first row only; the rest align under it, so a long
 * result reads as one hanging paragraph instead of a column of marks.
 */
function continuationRows(
  text: string,
  width: number,
  maxRows: number,
  ink: (value: string) => string,
): string[] {
  const clean = safeTrim(text);
  if (clean.length === 0) return [];
  return bodyRows(`${PI_NATIVE_CONTINUATION} ${clean}`, width, maxRows, ink);
}

/**
 * Appends the streaming caret without ever overflowing the column.
 *
 * Ported from the prototype's `withCaret`: when the last wrapped row already
 * fills the width, the caret takes a row of its own rather than pushing a
 * column past the pane.
 */
function withCaret(
  paint: Paint,
  rows: readonly string[],
  width: number,
): string[] {
  if (rows.length === 0) {
    return [cell(`${PI_NATIVE_INDENT}${paint.acc("▍")}`, width)];
  }
  const head = rows.slice(0, -1);
  const last = (rows[rows.length - 1] ?? "").replace(/\s+$/u, "");
  if (measureWidth(last) + 1 <= width) {
    return [...head, cell(`${last}${paint.inv(" ")}`, width)];
  }
  return [
    ...head,
    cell(last, width),
    cell(`${PI_NATIVE_INDENT}${paint.acc("▍")}`, width),
  ];
}

/** A full-width rule carrying a centred label. The run divider's own shape. */
function dividerRow(paint: Paint, label: string, width: number): string {
  const text = safeTrim(label);
  const lead = `── ${text} `;
  const tail = Math.max(0, width - measureWidth(lead));
  return cell(paint.rule(`${lead}${"─".repeat(tail)}`), width);
}

function gutter(paint: Paint, family: PiNativeFamily, tone: Tone): string {
  return paintTone(paint, tone, PI_NATIVE_GLYPH[family]);
}

// ---------------------------------------------------------------------------
// Per-entry rendering
// ---------------------------------------------------------------------------

/** What an assistant message is called in its header. */
function replyLabel(
  entry: PiChildTranscriptAssistantEntry,
  finalResponse: boolean,
): string {
  if (entry.streaming) return "streaming reply";
  return finalResponse ? "final response" : "reply";
}

function promptLabel(kind: "task" | "steering" | "follow_up"): string {
  if (kind === "steering") return "steering prompt";
  if (kind === "follow_up") return "follow-up prompt";
  return "delegation prompt";
}

/**
 * One transcript entry, in the one style the pane owns.
 *
 * Entries that carry nothing a reader can act on — an unknown host event, an
 * empty text fragment — render no rows at all, which is how the pane stays
 * free of the bookkeeping the reducer legitimately keeps.
 */
function renderEntryRows(
  paint: Paint,
  entry: PiChildTranscriptEntry,
  input: OverlayPiNativeInput,
  width: number,
  finalAssistantId: string | undefined,
): string[] {
  const dim = (value: string): string => paint.dim(value);
  const text = (value: string): string => paint.text(value);
  const bad = (value: string): string => paint.bad(value);

  switch (entry.kind) {
    case "task":
    case "steering":
    case "follow_up": {
      const who =
        entry.kind === "task" && input.parentName !== undefined
          ? `${input.parentName} → ${input.childName}`
          : input.childName;
      return [
        headRow(
          `${gutter(paint, "prompt", "run")} ${paint.bold(paint.alt(who))} ${dim(promptLabel(entry.kind))}`,
          width,
        ),
        ...bodyRows(entry.text, width, PI_NATIVE_BODY_ROWS.prompt, text),
      ];
    }

    case "thinking": {
      if (!entry.thinkingVisible) {
        return [
          headRow(
            `${gutter(paint, "reason", "mute")} ${paint.muted("reasoning · SUMMARY")} ${dim("[hidden]")}`,
            width,
          ),
        ];
      }
      return [
        headRow(
          `${gutter(paint, "reason", "mute")} ${paint.muted("reasoning · SUMMARY")}`,
          width,
        ),
        ...bodyRows(entry.text, width, PI_NATIVE_BODY_ROWS.reason, dim),
      ];
    }

    case "text":
    case "markdown": {
      const body = bodyRows(
        entry.text,
        width,
        PI_NATIVE_BODY_ROWS.assistant,
        text,
      );
      if (body.length === 0) return [];
      return [
        headRow(
          `${gutter(paint, "assistant", "run")} ${dim(`${input.childName} · reply`)}`,
          width,
        ),
        ...body,
      ];
    }

    case "assistant": {
      const rows: string[] = [];
      // The reasoning that produced this reply is stated as a SUMMARY line
      // above it, exactly as the prototype orders them, and it is bounded so a
      // long chain can never become a thought stream on screen.
      if (entry.thinkingVisible && safeTrim(entry.thinking).length > 0) {
        rows.push(
          headRow(
            `${gutter(paint, "reason", "mute")} ${paint.muted("reasoning · SUMMARY")}`,
            width,
          ),
          ...bodyRows(entry.thinking, width, PI_NATIVE_BODY_ROWS.reason, dim),
        );
      }
      const streaming = entry.streaming && !input.settled;
      const label = replyLabel(
        entry,
        !entry.streaming && entry.id === finalAssistantId,
      );
      rows.push(
        headRow(
          `${gutter(paint, "assistant", "run")} ${dim(`${input.childName} · ${label}`)}`,
          width,
        ),
      );
      const body = bodyRows(
        entry.text || entry.markdown,
        width,
        PI_NATIVE_BODY_ROWS.assistant,
        text,
      );
      rows.push(...(streaming ? withCaret(paint, body, width) : body));
      // Under Native Settlement this pane is the failure surface too: the
      // classified provider error hangs off the message that failed.
      if (entry.stopReason === "error") {
        rows.push(
          headRow(
            `${gutter(paint, "error", "bad")} ${bad("provider error")}`,
            width,
          ),
          ...continuationRows(
            formatPiChildProviderError(entry.terminalError),
            width,
            PI_NATIVE_BODY_ROWS.error,
            bad,
          ),
        );
      }
      return rows;
    }

    case "tool": {
      const tone = overlayToolTone(entry);
      const name = safeTrim(entry.toolName) || "tool";
      const args = overlayToolArgs(entry);
      const rows = [
        headRow(
          `${gutter(paint, "tool", tone)} ${tone === "bad" ? bad(name) : text(name)}${dim(`(${args})`)}`,
          width,
        ),
      ];
      const outcome = overlayToolOutcome(entry);
      if (outcome !== undefined) {
        rows.push(
          ...continuationRows(
            outcome,
            width,
            PI_NATIVE_BODY_ROWS.tool,
            (value) => paintTone(paint, tone, value),
          ),
        );
      }
      return rows;
    }

    case "queue": {
      const first = overlayPayloadText(entry.queue[0]);
      return [
        headRow(
          `${gutter(paint, "queue", "warn")} ${paint.warn(`queue ${entry.size}`)}`,
          width,
        ),
        ...(first.length === 0
          ? []
          : bodyRows(`next · ${first}`, width, PI_NATIVE_BODY_ROWS.queue, dim)),
      ];
    }

    case "status": {
      const note = safeTrim(entry.message ?? "");
      const label = safeTrim(entry.status) || "status";
      return [
        headRow(
          `${gutter(paint, "sys", "mute")} ${dim("status")} ${paint.muted(note.length === 0 ? label : `${label} · ${note}`)}`,
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
          `${gutter(paint, "sys", "mute")} ${dim("usage")} ${paint.muted(summary)}`,
          width,
        ),
      ];
    }

    case "image": {
      return [
        headRow(
          `${gutter(paint, "sys", "mute")} ${dim("image")} ${paint.muted("binary data omitted")}`,
          width,
        ),
      ];
    }

    case "extension_ui": {
      return [
        headRow(
          `${gutter(paint, "sys", "mute")} ${dim("child ui")} ${paint.muted(safeTrim(entry.requestType))}`,
          width,
        ),
      ];
    }

    // An unrecognised host event carries nothing a reader can act on, and its
    // payload is exactly the raw shape this pane may not print.
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------

/**
 * Newest non-streaming assistant entry, which a settled child's pane calls the
 * final response. Settlement is the only completion authority: a live child
 * has a newest reply, never a final one.
 */
function finalAssistantEntryId(
  input: OverlayPiNativeInput,
): string | undefined {
  if (!input.settled) return undefined;
  for (let i = input.entries.length - 1; i >= 0; i -= 1) {
    const entry = input.entries[i];
    if (entry?.kind === "assistant" && !entry.streaming) return entry.id;
  }
  return undefined;
}

/**
 * The transcript pane at one width, painted and plain, with its row spans.
 *
 * Rendering is per-entry and stateless across entries — the property the
 * prototype's `renderTranscriptPane` depends on — so concatenating per-entry
 * renders is byte-identical to rendering the whole list, and the row → entry
 * map the search rail and the viewport anchor need comes for free.
 */
export function renderOverlayPiNative(
  paint: Paint,
  input: OverlayPiNativeInput,
  width: number,
): OverlayPiNativePane {
  const columns = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  const bare = plainPaint();
  const finalId = finalAssistantEntryId(input);
  const painted: string[] = [];
  const plain: string[] = [];
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
  return { painted, plain, spans };
}

/**
 * The transcript block the inspector actually mounts.
 *
 * `renderOverlayPiNative` owns the design; this adds the two whole-view facts
 * around it and nothing else, so the pane stays a pure function of entries.
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
  if (lines.length > 0) return { lines, spans: rendered.spans };
  // Nothing the pane can draw yet (a window of bookkeeping-only entries, or
  // history that predates strict replay mapping). The bounded overlay entry
  // text still names the kinds, which beats an empty inspector.
  const fallback = input.windowEntries.map((entry) =>
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
    spans: input.windowEntries.map((entry) => ({ entryId: entry.id, rows: 1 })),
  };
}
