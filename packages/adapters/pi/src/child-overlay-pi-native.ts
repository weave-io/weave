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
import {
  type PiChildProviderError,
  TOOL_ERROR_DETAILS_UNAVAILABLE,
  TOOL_RESULT_DETAILS_UNAVAILABLE,
} from "./child-provider-error.js";
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

/** Nesting depth {@link normalizeOverlayPayload} walks before it gives up. */
const PI_NATIVE_NORMALIZE_DEPTH = 6;

/**
 * The sentences the closed reducer projection substitutes for a value it may
 * not reproduce.
 *
 * They are a PRIVACY outcome, not a fact about the run, so they are dropped
 * here rather than printed: a reader learns nothing from
 * `bash(command: Tool result details unavailable.)`, and the row reads as if
 * the child had run that literal command.
 */
const PI_NATIVE_WITHHELD_TEXT: ReadonlySet<string> = new Set([
  TOOL_RESULT_DETAILS_UNAVAILABLE,
  TOOL_ERROR_DETAILS_UNAVAILABLE,
]);

/**
 * Keys of a real Pi tool answer that carry correlation, not information.
 *
 * A Pi 0.83/0.84 `tool_execution_end` reports a pi-ai `ToolResultMessage`:
 * `{ role, toolCallId, toolName, content, isError, timestamp }`. Every field
 * but `content` is bookkeeping the inspector already states in the call row
 * it hangs under, and printing them spends the whole result column on
 * `role: toolResult, toolCallId: …, toolName: bash, content: …`. They are
 * dropped from a RESULT only; a tool's arguments keep every key, because
 * there the shape is the information.
 */
const PI_NATIVE_RESULT_BOOKKEEPING_KEYS: ReadonlySet<string> = new Set([
  "role",
  "type",
  "id",
  "toolCallId",
  "tool_use_id",
  "toolUseId",
  "toolName",
  "name",
  "isError",
  "is_error",
  "timestamp",
  "addedToolNames",
]);

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
  /**
   * The ANSI-free text of those same rows, per entry: the search index the
   * controller matches queries against. It is produced here because only the
   * render knows what actually fit on screen.
   */
  readonly searchIndex: ReadonlyMap<string, string>;
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
/**
 * The text of one pi-ai content block, or `undefined` when it carries none.
 *
 * `content` on every real tool answer, assistant message and partial result is
 * an array of `{ type: "text"; text: string }` blocks. Summarizing the block
 * itself prints its SHAPE — `type: text, text: …` — which is the one thing a
 * reader cannot use, so a block is normalized to the prose it wraps.
 */
function contentBlockText(record: Record<string, unknown>): string | undefined {
  if (typeof record.type !== "string") return undefined;
  // `thinking` is deliberately absent: a raw reasoning block's prose is never
  // unwrapped for display.
  for (const key of ["text"] as const) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/**
 * A payload with its host wrappers removed and its withheld parts dropped.
 *
 * Returns `undefined` for a value with nothing left to say, which is how a
 * caller distinguishes "the child reported nothing readable" from "the child
 * reported an empty string". Bounded by construction: the parser already
 * capped the input's breadth, and the walk stops at
 * {@link PI_NATIVE_NORMALIZE_DEPTH}.
 */
export function normalizeOverlayPayload(
  value: unknown,
  stripBookkeeping = false,
  depth = 0,
): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const clean = safeTrim(value);
    if (clean.length === 0) return undefined;
    return PI_NATIVE_WITHHELD_TEXT.has(clean) ? undefined : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return undefined;
  if (depth >= PI_NATIVE_NORMALIZE_DEPTH) return undefined;
  if (Array.isArray(value)) {
    const items = value
      .map((item) => normalizeOverlayPayload(item, stripBookkeeping, depth + 1))
      .filter((item) => item !== undefined);
    if (items.length === 0) return undefined;
    // A normalized content-block array is prose, so it reads as prose.
    return items.every((item) => typeof item === "string")
      ? (items as string[]).join(" ")
      : items;
  }
  const record = value as Record<string, unknown>;
  const blockText = contentBlockText(record);
  if (blockText !== undefined) {
    return normalizeOverlayPayload(blockText, stripBookkeeping, depth + 1);
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (stripBookkeeping && PI_NATIVE_RESULT_BOOKKEEPING_KEYS.has(key))
      continue;
    const next = normalizeOverlayPayload(item, stripBookkeeping, depth + 1);
    if (next !== undefined) normalized[key] = next;
  }
  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

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
  return boundedPayloadText(normalizeOverlayPayload(value, false));
}

/**
 * A tool's ANSWER in one bounded line: content blocks resolved to their prose,
 * correlation bookkeeping dropped, withheld parts absent.
 */
export function overlayToolResultText(value: unknown): string {
  return boundedPayloadText(normalizeOverlayPayload(value, true));
}

function boundedPayloadText(normalized: unknown): string {
  if (normalized === undefined) return "";
  const summary = summarizeOverlayValue(unwrapSoleContent(normalized));
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
    if (typeof value !== "string") continue;
    const text = overlayPayloadText(value);
    if (text.length > 0) return text;
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
  // A TERMINAL phase always states an outcome, and never states `running`.
  // The reducer settles a call the moment its own terminal event lands, so a
  // row that still says `running` after one is the surest sign the inspector
  // is describing a call it lost track of.
  if (entry.state === "error" || entry.error !== undefined) {
    const detail = overlayToolResultText(entry.error ?? entry.result);
    return detail.length === 0 ? "failed" : stripPathLike(detail);
  }
  if (entry.state === "result" || entry.result !== undefined) {
    const text = overlayToolResultText(entry.result);
    return text.length === 0 ? "done" : text;
  }
  const partial = entry.partialResults[entry.partialResults.length - 1];
  if (partial !== undefined) {
    const text = overlayToolResultText(partial);
    return text.length === 0 ? "running" : text;
  }
  if (entry.state === "called" || entry.state === "partial") return "running";
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

/**
 * Does this assistant entry have anything for a reader to look at?
 *
 * Streaming is visible even while empty, because the caret is the message: it
 * is what says the child is answering right now. A settled pane has no caret,
 * so the same entry becomes invisible once its lifecycle produced no prose.
 */
function assistantEntryHasVisibleRows(
  entry: PiChildTranscriptAssistantEntry,
  settled: boolean,
): boolean {
  if (entry.streaming && !settled) return true;
  if (entry.stopReason === "error") return true;
  if (
    entry.thinkingVisible &&
    (safeTrim(entry.reasoningSummary).length > 0 || entry.reasoningObserved)
  )
    return true;
  return safeTrim(entry.text || entry.markdown).length > 0;
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

    // A raw reasoning entry has no body: the transcript reducer stored none.
    // The row states that the child reasoned and stops there.
    case "thinking": {
      if (!entry.thinkingVisible) {
        return [
          headRow(
            `${gutter(paint, "reason", "mute")} ${paint.muted("reasoning")} ${dim("[hidden]")}`,
            width,
          ),
        ];
      }
      return [
        headRow(
          `${gutter(paint, "reason", "mute")} ${paint.muted("reasoning")}`,
          width,
        ),
      ];
    }

    // The host published an explicit summary. This is the ONE reasoning
    // surface that may print prose.
    case "reasoning_summary": {
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
      // A tool-use turn is an assistant message with no prose of its own: the
      // reply IS the tool rows below it. A bare `● shuttle · reply` header over
      // nothing states a message the reader cannot read, so an entry with no
      // visible text, no visible reasoning, no caret and no classified failure
      // renders nothing at all.
      if (!assistantEntryHasVisibleRows(entry, input.settled)) return [];
      const rows: string[] = [];
      // The reasoning that produced this reply is stated above it, exactly as
      // the prototype orders them. Prose appears ONLY when the host itself
      // published a summary; observed raw chain-of-thought is announced as a
      // bare fact and its text is never held, let alone printed.
      if (entry.thinkingVisible) {
        if (safeTrim(entry.reasoningSummary).length > 0) {
          rows.push(
            headRow(
              `${gutter(paint, "reason", "mute")} ${paint.muted("reasoning · SUMMARY")}`,
              width,
            ),
            ...bodyRows(
              entry.reasoningSummary,
              width,
              PI_NATIVE_BODY_ROWS.reason,
              dim,
            ),
          );
        } else if (entry.reasoningObserved) {
          rows.push(
            headRow(
              `${gutter(paint, "reason", "mute")} ${paint.muted("reasoning")}`,
              width,
            ),
          );
        }
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
      // An unreported depth prints as `unknown`: the row may not invent a
      // number the child never stated.
      const first = overlayPayloadText(entry.queue?.[0]);
      return [
        headRow(
          `${gutter(paint, "queue", "warn")} ${paint.warn(`queue ${entry.size ?? "unknown"}`)}`,
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

    // A child's status line, working indicator or notification is a request to
    // paint the HOST's chrome. It is not conversation, and `· child ui widget`
    // is bookkeeping wearing a transcript row, so it is kept out of the
    // product transcript entirely. The reducer still retains the request in
    // `extensionUi`, where the response correlation needs it.
    case "extension_ui":
      return [];

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
 * THE SEARCH INDEX: what the reader can actually read, per entry.
 *
 * Search used to match the overlay WINDOW entry's `text`, which is a short
 * projection — a tool entry carries only its tool name there. A reader who
 * searched for text plainly on screen (`bash(timeout: 180)`, a tool result, a
 * queued item) was told `no match in this transcript`, because the rows they
 * were reading had never been indexed.
 *
 * The index is therefore grouped straight out of the pane's own ANSI-FREE
 * twin, which {@link renderOverlayPiNative} already produces beside the
 * painted rows: same renderer, same width, same bounds, same sanitization, no
 * second render. Text the pane truncated is text the reader cannot see, so it
 * is deliberately absent from the index too.
 *
 * Keys are the entry identity the viewport anchor and the search gutter
 * already use (`overlayEntryId ?? id`), so a match maps straight onto a window
 * entry and a rendered row span.
 */
export function overlayTranscriptSearchIndex(
  pane: Pick<OverlayPiNativePane, "plain" | "spans">,
): Map<string, string> {
  const index = new Map<string, string>();
  let row = 0;
  for (const span of pane.spans) {
    const rows = pane.plain.slice(row, row + span.rows);
    row += span.rows;
    // Rows are joined with a space, not a newline: the shared `boundText`
    // sanitizer drops control characters, so a newline separator would
    // silently glue the last word of one row to the first of the next and
    // invent a match that is nowhere on screen.
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
  if (lines.length > 0) {
    return {
      lines,
      spans: rendered.spans,
      searchIndex: overlayTranscriptSearchIndex(rendered),
    };
  }
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
    // The fallback prints the window entry's own text, which search already
    // matches directly, so it contributes no second index.
    searchIndex: new Map<string, string>(),
  };
}
