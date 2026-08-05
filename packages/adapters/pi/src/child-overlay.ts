/**
 * Bounded full-screen child overlay model, source, and native custom component
 * (Spec 33 §7, plan Task 12 phases A–B1).
 *
 * Owns one overlay instance over injected ports: pagination, search, live-tail,
 * per-child LRU view state, input isolation, and typed fallback handoff for the
 * existing custom-editor path. The native component mounts via Pi public
 * `CustomEditor` + transcript factory seams without touching the primary editor
 * or registering extension keybindings (Task 13).
 *
 * Historical pages adapt Task 4 {@link PiNativeSessionStore.readSessionEntryPage}
 * output through {@link mapNativeSessionEntryToOverlay} without copying
 * transcript bytes into adapter storage and without ever materializing a full
 * transcript. Live events use the shared Task 11 parser + compact map / reduce
 * pipeline, then project into the overlay window via the existing
 * child-transcript reducer.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import type { PiChildOverlayKeyInterceptor } from "./child-overlay-keys.js";
import { z } from "zod";
import {
  createChildCompactState,
  mapPiChildSessionEventToCompactInput,
  reduceChildCompactSafe,
  type ChildCompactState,
} from "./child-compact-render.js";
import {
  createPiNativeTranscriptComponentFactory,
  type PiNativeTranscriptComponentDeps,
} from "./child-native-components.js";
import {
  parsePiChildSessionEvent,
  type PiChildSessionEvent,
} from "./child-session-events.js";
import {
  createPiChildTranscriptRenderer,
  createPiChildTranscriptState,
  MAX_TRANSCRIPT_INPUT_BYTES,
  reducePiChildTranscript,
  type PiChildTranscriptAction,
  type PiChildTranscriptEntry,
  type PiChildTranscriptState,
  type PiTranscriptComponentFactory,
} from "./child-transcript.js";
import type {
  PiNativeSessionEntryPage,
  PiNativeSessionEntryPageOptions,
  PiNativeSessionError,
} from "./child-native-sessions.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Admitted content-block ceiling for one native message entry.
 *
 * Replay framing needs headroom beyond this: `message_start`, an optional
 * standalone `text` step, and terminal `message_end` (tool call/result facts
 * expand 1:1 from admitted blocks and must not crowd out the terminal).
 */
const MAX_ENTRY_CONTENT_BLOCKS = 32;
/** `message_start` + `text` + `message_end` framing beside admitted blocks. */
const ENTRY_REPLAY_FRAME_STEPS = 3;

export const CHILD_OVERLAY_BOUNDS = Object.freeze({
  /** Entries loaded by one page request. */
  defaultPageSize: 50,
  /** Hard ceiling for one page request. */
  maxPageSize: 100,
  /** Maximum entries retained in the in-memory window. */
  defaultWindowCap: 200,
  /** Hard ceiling for the in-memory window. */
  maxWindowCap: 512,
  /** Per-child saved view states retained (LRU). */
  maxLruChildren: 8,
  /** Maximum older pages fetched during one search. */
  maxSearchPages: 4,
  /** Ceiling on opaque cursor characters. */
  maxCursorLength: 512,
  /** Ceiling on draft / search query characters. */
  maxTextLength: 16_384,
  /** Ceiling on child / thread / entry ids. */
  maxIdLength: 256,
  /** Ceiling on run-divider labels. */
  maxLabelLength: 128,
  /** Ceiling on run dividers retained per child descriptor. */
  maxRuns: 64,
  /** Ceiling on nested hierarchy depth reported in descriptors. */
  maxHierarchyDepth: 16,
  /** Ceiling on content blocks read from one native message entry. */
  maxEntryContentBlocks: MAX_ENTRY_CONTENT_BLOCKS,
  /**
   * Ceiling on replay steps retained per overlay entry.
   *
   * Derived so every admitted content block plus start/text/end framing fits;
   * mapping must fail typed when input would exceed either ceiling rather than
   * silently drop `message_end` (which leaves assistants falsely streaming).
   */
  maxEntryReplaySteps: MAX_ENTRY_CONTENT_BLOCKS + ENTRY_REPLAY_FRAME_STEPS,
});

const SCROLL_KEYS = {
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  shiftUp: "\x1b[1;2A",
  shiftDown: "\x1b[1;2B",
  home: "\x1b[H",
  end: "\x1b[F",
} as const;

const SCROLL_PAGE = 10;

// ---------------------------------------------------------------------------
// Schemas (persisted / opaque input)
// ---------------------------------------------------------------------------

const OpaqueIdSchema = z
  .string()
  .min(1)
  .max(CHILD_OVERLAY_BOUNDS.maxIdLength)
  .regex(/^[A-Za-z0-9._:-]+$/u);

const OpaqueCursorSchema = z
  .string()
  .min(1)
  .max(CHILD_OVERLAY_BOUNDS.maxCursorLength);

const OverlayTextSchema = z
  .string()
  .max(CHILD_OVERLAY_BOUNDS.maxTextLength);

const RunActionSchema = z.enum(["start", "retry", "continue"]);

export const ChildOverlayRunDividerSchema = z
  .object({
    run: z.number().int().min(1).max(CHILD_OVERLAY_BOUNDS.maxRuns),
    action: RunActionSchema,
    startedAt: z.number().int().nonnegative().optional(),
    priorOutcome: z.string().max(CHILD_OVERLAY_BOUNDS.maxLabelLength).optional(),
    initiator: z.string().max(CHILD_OVERLAY_BOUNDS.maxLabelLength).optional(),
    model: z.string().max(CHILD_OVERLAY_BOUNDS.maxLabelLength).optional(),
    reasoning: z.string().max(CHILD_OVERLAY_BOUNDS.maxLabelLength).optional(),
  })
  .strict();
export type ChildOverlayRunDivider = z.infer<
  typeof ChildOverlayRunDividerSchema
>;

export const ChildOverlayStatusSchema = z.enum(["live", "settled", "orphan"]);
export type ChildOverlayStatus = z.infer<typeof ChildOverlayStatusSchema>;

export const ChildOverlayChildSchema = z
  .object({
    childId: OpaqueIdSchema,
    threadId: OpaqueIdSchema,
    parentChildId: OpaqueIdSchema.optional(),
    status: ChildOverlayStatusSchema,
    title: z.string().max(CHILD_OVERLAY_BOUNDS.maxLabelLength).optional(),
    generationId: OpaqueIdSchema.optional(),
    runs: z
      .array(ChildOverlayRunDividerSchema)
      .max(CHILD_OVERLAY_BOUNDS.maxRuns)
      .default([]),
    branchIds: z
      .array(OpaqueIdSchema)
      .max(CHILD_OVERLAY_BOUNDS.maxRuns)
      .default([]),
    /** Nested descendant child ids, shallow and bounded (no paths). */
    descendantChildIds: z
      .array(OpaqueIdSchema)
      .max(CHILD_OVERLAY_BOUNDS.maxHierarchyDepth)
      .default([]),
  })
  .strict();
export type ChildOverlayChild = z.infer<typeof ChildOverlayChildSchema>;

// ---------------------------------------------------------------------------
// Overlay entries (UI-agnostic transcript facts)
// ---------------------------------------------------------------------------

export type ChildOverlayEntryKind =
  | "prompt"
  | "user"
  | "steering"
  | "follow-up"
  | "assistant"
  | "thinking"
  | "tool"
  | "error"
  | "retry"
  | "run-divider"
  | "image"
  | "status"
  | "unknown";

/**
 * One bounded transcript-reducer step retained beside an overlay entry.
 *
 * Replay steps are the fidelity contract between paged history and the live
 * reducer: every projected fact carries the schema-validated child events (or
 * input actions) that reproduce it, so {@link transcriptFromOverlayEntries}
 * rebuilds the same ordered transcript the live pipeline would have produced.
 * Steps never carry raw host payloads, image bytes, or filesystem paths.
 */
export type ChildOverlayReplayStep =
  | {
      readonly kind: "input";
      readonly input: "task" | "steering" | "follow_up";
      readonly text: string;
    }
  | { readonly kind: "event"; readonly event: PiChildSessionEvent };

export interface ChildOverlayEntry {
  readonly id: string;
  readonly sequence: number;
  readonly kind: ChildOverlayEntryKind;
  /** Searchable, sanitized text projection (never a filesystem path). */
  readonly text: string;
  readonly runNumber?: number;
  readonly branchId?: string;
  readonly expanded: boolean;
  /**
   * Bounded reducer steps that reproduce this fact. `undefined` means the
   * entry predates strict mapping and falls back to a kind heuristic; an empty
   * array means the fact is intentionally transcript-neutral (a streaming
   * delta already covered by its terminal message).
   */
  readonly replay?: readonly ChildOverlayReplayStep[];
}

export interface ChildOverlayPage {
  readonly entries: readonly ChildOverlayEntry[];
  readonly olderCursor: string | undefined;
  readonly newerCursor: string | undefined;
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
}

export type ChildOverlaySourceError =
  | { readonly type: "SourceUnavailable"; readonly operation: string }
  | { readonly type: "SourceCorrupt"; readonly operation: string }
  | { readonly type: "SourceInvalidCursor"; readonly operation: string }
  | { readonly type: "ChildNotFound"; readonly childId: string };

export interface ChildOverlaySourcePort {
  describe(
    childId: string,
  ): ResultAsync<ChildOverlayChild, ChildOverlaySourceError>;
  loadNewest(
    childId: string,
    pageSize: number,
  ): ResultAsync<ChildOverlayPage, ChildOverlaySourceError>;
  loadOlder(
    childId: string,
    cursor: string,
    pageSize: number,
  ): ResultAsync<ChildOverlayPage, ChildOverlaySourceError>;
  loadNewer(
    childId: string,
    cursor: string,
    pageSize: number,
  ): ResultAsync<ChildOverlayPage, ChildOverlaySourceError>;
}

export type ChildOverlayMutationPort = {
  steer(
    childId: string,
    generationId: string,
    text: string,
  ): ResultAsync<void, { readonly type: "MutationFailed" }>;
  followUp(
    childId: string,
    generationId: string,
    text: string,
  ): ResultAsync<void, { readonly type: "MutationFailed" }>;
};

export interface ChildOverlayConfig {
  readonly pageSize?: number;
  readonly windowCap?: number;
  readonly maxLruChildren?: number;
  readonly maxSearchPages?: number;
}

export type ChildOverlayFallbackReason =
  | "source-failed"
  | "render-failed"
  | "describe-failed";

/** Bounded safe metadata for custom-editor handoff — never paths or secrets. */
export interface ChildOverlayFallbackMetadata {
  readonly childId: string;
  readonly threadId: string;
  readonly status: ChildOverlayStatus;
  readonly entryCount: number;
  readonly reason: ChildOverlayFallbackReason;
  readonly readOnly: boolean;
}

export interface ChildOverlayFallbackRequired {
  readonly kind: "fallback-required";
  readonly metadata: ChildOverlayFallbackMetadata;
  readonly transcript: PiChildTranscriptState;
}

export type ChildOverlayMappingError = {
  readonly type: "OverlayCapacityExceeded";
  readonly operation: "entry-content-blocks" | "entry-replay-steps";
};

export type ChildOverlayError =
  | ChildOverlaySourceError
  | { readonly type: "OverlayNotOpen" }
  | { readonly type: "OverlayInvalidChild"; readonly issues: readonly string[] }
  | { readonly type: "OverlayCapacityExceeded"; readonly operation: string }
  | ChildOverlayFallbackRequired;

export interface ChildOverlayAnchor {
  readonly entryId: string;
  readonly lineOffset: number;
}

export interface ChildOverlayView {
  readonly child: ChildOverlayChild;
  readonly entries: readonly ChildOverlayEntry[];
  readonly draft: string;
  readonly searchQuery: string;
  readonly searchMatches: readonly string[];
  readonly scrollOffset: number;
  readonly liveTail: boolean;
  readonly globalExpanded: boolean;
  readonly activeRun: number | undefined;
  readonly activeBranchId: string | undefined;
  readonly olderCursor: string | undefined;
  readonly newerCursor: string | undefined;
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
  readonly readOnly: boolean;
  readonly width: number;
  readonly height: number;
  readonly anchor: ChildOverlayAnchor | undefined;
  readonly compact: ChildCompactState;
  readonly transcript: PiChildTranscriptState;
}

export type ChildOverlayInputOutcome =
  | { readonly kind: "consumed" }
  | { readonly kind: "draft-updated"; readonly draft: string }
  | {
      readonly kind: "steer";
      readonly childId: string;
      readonly text: string;
    }
  | {
      readonly kind: "follow-up";
      readonly childId: string;
      readonly text: string;
    }
  | { readonly kind: "scroll"; readonly scrollOffset: number }
  | { readonly kind: "search"; readonly query: string }
  | { readonly kind: "expanded"; readonly globalExpanded: boolean }
  | {
      readonly kind: "navigate-run";
      readonly activeRun: number | undefined;
    }
  | {
      readonly kind: "navigate-branch";
      readonly activeBranchId: string | undefined;
    }
  | ChildOverlayFallbackRequired;

// ---------------------------------------------------------------------------
// Native entry mapping (Task 4 adapt / child-transcript projection)
// ---------------------------------------------------------------------------

const NativeMessageSchema = z.looseObject({
  type: z.literal("message"),
  id: z.string().min(1).max(CHILD_OVERLAY_BOUNDS.maxIdLength),
  message: z.unknown(),
});

const NativeCustomSchema = z.looseObject({
  type: z.literal("custom"),
  id: z.string().min(1).max(CHILD_OVERLAY_BOUNDS.maxIdLength),
  customType: z.string().max(CHILD_OVERLAY_BOUNDS.maxIdLength).optional(),
  data: z.unknown().optional(),
});

const RunDividerDataSchema = z.looseObject({
  run: z.number().int().min(1).max(CHILD_OVERLAY_BOUNDS.maxRuns).optional(),
  action: RunActionSchema.optional(),
  runNumber: z
    .number()
    .int()
    .min(1)
    .max(CHILD_OVERLAY_BOUNDS.maxRuns)
    .optional(),
});

/** C0 controls except TAB/LF/CR, plus DEL — built via String.raw for Biome. */
const BOUND_TEXT_CONTROL_PATTERN = new RegExp(
  String.raw`[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]`,
  "gu",
);

function boundText(value: string): string {
  const clean = value.replace(BOUND_TEXT_CONTROL_PATTERN, "");
  if (clean.length <= CHILD_OVERLAY_BOUNDS.maxTextLength) return clean;
  return [...clean].slice(0, CHILD_OVERLAY_BOUNDS.maxTextLength).join("");
}

function messageText(message: unknown): {
  readonly role: string | undefined;
  readonly text: string;
} {
  const record = recordOf(message);
  if (record === undefined) return { role: undefined, text: "" };
  const role = typeof record.role === "string" ? record.role : undefined;
  const content = record.content;
  if (typeof content === "string") return { role, text: boundText(content) };
  if (!Array.isArray(content)) return { role, text: "" };
  let text = "";
  for (const block of content) {
    if (typeof block === "string") {
      text += block;
      continue;
    }
    const b = recordOf(block);
    if (b === undefined) continue;
    if (typeof b.text === "string") text += b.text;
  }
  return { role, text: boundText(text) };
}

// ---------------------------------------------------------------------------
// Strict native content-block mapping
// ---------------------------------------------------------------------------

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boundLabel(value: string): string {
  return value.slice(0, CHILD_OVERLAY_BOUNDS.maxLabelLength);
}

/** Bounded normalized tool-result content: text and image presence only. */
interface NativeResultBlock {
  readonly type: string;
  readonly text?: string;
  readonly mimeType?: string;
}

interface NativeToolCallBlock {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: unknown;
}

interface NativeToolResultBlock {
  readonly toolCallId: string;
  readonly isError: boolean;
  readonly content: readonly NativeResultBlock[];
  readonly text: string;
}

interface NativeMessageParts {
  readonly role: string | undefined;
  readonly text: string;
  readonly thinking: readonly string[];
  readonly toolCalls: readonly NativeToolCallBlock[];
  readonly toolResults: readonly NativeToolResultBlock[];
  readonly images: readonly (string | undefined)[];
}

function imageMimeType(block: Record<string, unknown>): string | undefined {
  const source = recordOf(block.source);
  const mime =
    nonEmptyString(block.mimeType) ??
    nonEmptyString(block.mediaType) ??
    nonEmptyString(source?.mimeType) ??
    nonEmptyString(source?.media_type);
  return mime === undefined ? undefined : boundLabel(mime);
}

/**
 * Normalizes one tool result payload into bounded text/image blocks.
 *
 * Image bytes are deliberately dropped: the overlay never retains transcript
 * bytes, so an image result is preserved as a typed placeholder with its MIME
 * type. Text is bounded by {@link boundText}.
 */
function toolResultContent(
  value: unknown,
): Result<
  { readonly content: readonly NativeResultBlock[]; readonly text: string },
  ChildOverlayMappingError
> {
  if (typeof value === "string") {
    const text = boundText(value);
    return ok({ content: [{ type: "text", text }], text });
  }
  const record = recordOf(value);
  if (record !== undefined && Array.isArray(record.content))
    return toolResultContent(record.content);
  if (record !== undefined) {
    const text = boundText(nonEmptyString(record.text) ?? "");
    return ok({
      content: text.length > 0 ? [{ type: "text", text }] : [],
      text,
    });
  }
  if (!Array.isArray(value)) return ok({ content: [], text: "" });
  if (value.length > CHILD_OVERLAY_BOUNDS.maxEntryContentBlocks) {
    return err({
      type: "OverlayCapacityExceeded",
      operation: "entry-content-blocks",
    });
  }
  const content: NativeResultBlock[] = [];
  let text = "";
  for (const item of value) {
    if (typeof item === "string") {
      text += item;
      content.push({ type: "text", text: boundText(item) });
      continue;
    }
    const block = recordOf(item);
    if (block === undefined) continue;
    const type = nonEmptyString(block.type) ?? "text";
    if (type === "image") {
      content.push({ type: "image", mimeType: imageMimeType(block) });
      continue;
    }
    const blockText = nonEmptyString(block.text);
    if (blockText === undefined) {
      content.push({ type: boundLabel(type) });
      continue;
    }
    text += blockText;
    content.push({ type: "text", text: boundText(blockText) });
  }
  return ok({ content, text: boundText(text) });
}

/**
 * Splits one native message into the bounded fact families the transcript
 * reducer understands: assistant text, reasoning, tool calls, tool results
 * (text / error / image) and standalone images. Nothing is flattened into an
 * opaque `unknown` fact and no raw host payload is retained.
 */
function nativeMessageParts(
  message: unknown,
): Result<NativeMessageParts, ChildOverlayMappingError> {
  const record = recordOf(message);
  const role = nonEmptyString(record?.role);
  const content = record?.content;
  if (typeof content === "string") {
    return ok({
      role,
      text: boundText(content),
      thinking: [],
      toolCalls: [],
      toolResults: [],
      images: [],
    });
  }
  const thinking: string[] = [];
  const toolCalls: NativeToolCallBlock[] = [];
  const toolResults: NativeToolResultBlock[] = [];
  const images: (string | undefined)[] = [];
  let text = "";
  if (content !== undefined && !Array.isArray(content)) {
    return ok({
      role,
      text: "",
      thinking: [],
      toolCalls: [],
      toolResults: [],
      images: [],
    });
  }
  const blocks = Array.isArray(content) ? content : [];
  if (blocks.length > CHILD_OVERLAY_BOUNDS.maxEntryContentBlocks) {
    return err({
      type: "OverlayCapacityExceeded",
      operation: "entry-content-blocks",
    });
  }
  for (const item of blocks) {
    if (typeof item === "string") {
      text += item;
      continue;
    }
    const block = recordOf(item);
    if (block === undefined) continue;
    const type = nonEmptyString(block.type) ?? "";
    if (type === "thinking" || type === "reasoning") {
      const value =
        nonEmptyString(block.thinking) ?? nonEmptyString(block.text);
      if (value !== undefined) thinking.push(boundText(value));
      continue;
    }
    if (type === "toolCall" || type === "tool_use" || type === "tool_call") {
      const rawId =
        nonEmptyString(block.id) ??
        nonEmptyString(block.toolCallId) ??
        `tool-${toolCalls.length}`;
      toolCalls.push({
        toolCallId: safeEntryId(rawId, `tool-${toolCalls.length}`),
        toolName: boundLabel(
          nonEmptyString(block.name) ?? nonEmptyString(block.toolName) ?? "tool",
        ),
        arguments: block.arguments ?? block.input ?? block.args,
      });
      continue;
    }
    if (type === "toolResult" || type === "tool_result") {
      const rawId =
        nonEmptyString(block.toolCallId) ??
        nonEmptyString(block.toolUseId) ??
        nonEmptyString(block.tool_use_id) ??
        nonEmptyString(block.id) ??
        `tool-${toolResults.length}`;
      const normalized = toolResultContent(
        block.content ?? block.output ?? block.result,
      );
      if (normalized.isErr()) return err(normalized.error);
      toolResults.push({
        toolCallId: safeEntryId(rawId, `tool-${toolResults.length}`),
        isError: block.isError === true || block.is_error === true,
        content: normalized.value.content,
        text: normalized.value.text,
      });
      continue;
    }
    if (type === "image") {
      images.push(imageMimeType(block));
      continue;
    }
    const blockText = nonEmptyString(block.text);
    if (blockText !== undefined) text += blockText;
  }
  return ok({
    role,
    text: boundText(text),
    thinking,
    toolCalls,
    toolResults,
    images,
  });
}

/** Validates a synthesized child event through the shared bounded schema. */
function replayEvent(candidate: unknown): ChildOverlayReplayStep | undefined {
  const parsed = parsePiChildSessionEvent(candidate);
  if (!parsed.success) return undefined;
  return { kind: "event", event: parsed.data };
}

function pushReplayEvent(
  steps: ChildOverlayReplayStep[],
  candidate: unknown,
): Result<void, ChildOverlayMappingError> {
  if (steps.length >= CHILD_OVERLAY_BOUNDS.maxEntryReplaySteps) {
    return err({
      type: "OverlayCapacityExceeded",
      operation: "entry-replay-steps",
    });
  }
  const step = replayEvent(candidate);
  if (step !== undefined) steps.push(step);
  return ok(undefined);
}

function isReplayMessageStart(step: ChildOverlayReplayStep): boolean {
  return step.kind === "event" && step.event.type === "message_start";
}

function isReplayMessageEnd(step: ChildOverlayReplayStep): boolean {
  return step.kind === "event" && step.event.type === "message_end";
}

function replayStepKey(step: ChildOverlayReplayStep): string {
  if (step.kind === "input") return `input:${step.input}:${step.text}`;
  const event = step.event as unknown as Record<string, unknown>;
  const type = typeof event.type === "string" ? event.type : "event";
  const message = recordOf(event.message);
  const toolCallId = nonEmptyString(event.toolCallId) ?? "";
  const messageId = nonEmptyString(message?.id) ?? "";
  const text = nonEmptyString(event.text) ?? "";
  const mimeType = nonEmptyString(event.mimeType) ?? "";
  // Distinguish successive tool partial/result payloads so live merges keep
  // every admitted unique fact rather than collapsing them by toolCallId.
  const payload =
    event.partialResult !== undefined ||
    event.result !== undefined ||
    event.error !== undefined
      ? JSON.stringify({
          partialResult: event.partialResult ?? null,
          result: event.result ?? null,
          error: event.error ?? null,
        })
      : "";
  return `${type}:${messageId}:${toolCallId}:${text}:${mimeType}:${payload}`;
}

/**
 * Deduplicates replay steps while preserving first-seen order so live merges
 * keep every admitted unique fact (call → partial → result) once.
 */
function uniqueReplaySteps(
  steps: readonly ChildOverlayReplayStep[],
): ChildOverlayReplayStep[] {
  const seen = new Set<string>();
  const unique: ChildOverlayReplayStep[] = [];
  for (const step of steps) {
    const key = replayStepKey(step);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(step);
  }
  return unique;
}

/**
 * Explicit capacity degrade for live merge: keep `message_start`, as many
 * unique middle facts as fit, and always retain terminal `message_end` when
 * present so rebuild never leaves an assistant falsely streaming.
 */
function degradeReplaySteps(
  steps: readonly ChildOverlayReplayStep[],
  cap: number,
): readonly ChildOverlayReplayStep[] {
  if (cap <= 0) return [];
  const start = steps.find(isReplayMessageStart);
  const end = [...steps].reverse().find(isReplayMessageEnd);
  const middle = steps.filter(
    (step) => !isReplayMessageStart(step) && !isReplayMessageEnd(step),
  );
  if (end !== undefined && cap === 1) return [end];
  const reserved = (start !== undefined ? 1 : 0) + (end !== undefined ? 1 : 0);
  const middleBudget = Math.max(0, cap - reserved);
  // Prefer the most recent unique facts when the middle must shrink.
  const keptMiddle =
    middle.length <= middleBudget
      ? middle
      : middle.slice(middle.length - middleBudget);
  return [
    ...(start !== undefined ? [start] : []),
    ...keptMiddle,
    ...(end !== undefined ? [end] : []),
  ];
}

/**
 * Concatenates replay steps for an entry replaced in place (a tool call that
 * later gains partial results and a terminal result, or a message that ends).
 *
 * Under the bound every unique admitted fact is kept. Over the bound the merge
 * degrades explicitly while preserving start/end terminals — never silently
 * truncates away `message_end`.
 */
function mergeReplaySteps(
  existing: readonly ChildOverlayReplayStep[] | undefined,
  incoming: readonly ChildOverlayReplayStep[] | undefined,
): readonly ChildOverlayReplayStep[] | undefined {
  if (existing === undefined) return incoming;
  if (incoming === undefined) return existing;
  const merged = uniqueReplaySteps([...existing, ...incoming]);
  const cap = CHILD_OVERLAY_BOUNDS.maxEntryReplaySteps;
  if (merged.length <= cap) return merged;
  return degradeReplaySteps(merged, cap);
}


function safeEntryId(value: string, fallback: string): string {
  const parsed = OpaqueIdSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return fallback;
}

/**
 * Maps one host native session entry into zero or one overlay facts without
 * retaining the raw host payload. Paths and absolute locations are never
 * copied into the result.
 *
 * Capacity overflow (more content blocks or replay steps than the derived
 * bounds allow) fails typed via {@link ChildOverlayMappingError} instead of
 * silently truncating admitted facts or dropping `message_end`.
 */
export function mapNativeSessionEntryToOverlay(
  entry: unknown,
  sequence: number,
): Result<ChildOverlayEntry | undefined, ChildOverlayMappingError> {
  const message = NativeMessageSchema.safeParse(entry);
  if (message.success) {
    const id = safeEntryId(message.data.id, `entry-${sequence}`);
    const parts = nativeMessageParts(message.data.message);
    if (parts.isErr()) return err(parts.error);
    if (parts.value.role === "assistant")
      return assistantEntryFromParts(id, sequence, parts.value);
    if (parts.value.role === "user")
      return userEntryFromParts(id, sequence, parts.value);
    return ok({
      id,
      sequence,
      kind: "unknown",
      text: parts.value.role ? `message:${parts.value.role}` : "message",
      expanded: false,
      replay: [],
    });
  }

  const custom = NativeCustomSchema.safeParse(entry);
  if (custom.success) {
    const customType = custom.data.customType ?? "";
    const id = safeEntryId(custom.data.id, `custom-${sequence}`);
    if (
      customType === "weave.child.run-divider" ||
      customType === "run-divider" ||
      customType.endsWith(".run-divider")
    ) {
      const data = RunDividerDataSchema.safeParse(custom.data.data);
      const runNumber = data.success
        ? (data.data.run ?? data.data.runNumber)
        : undefined;
      const action = data.success ? data.data.action : undefined;
      const text = boundText(`run ${runNumber ?? "?"} · ${action ?? "start"}`);
      const dividerSteps: ChildOverlayReplayStep[] = [];
      const pushed = pushReplayEvent(dividerSteps, {
        type: "retry",
        attempt: runNumber,
        reason: text,
      });
      if (pushed.isErr()) return err(pushed.error);
      return ok({
        id,
        sequence,
        kind: "run-divider",
        text,
        runNumber,
        expanded: false,
        replay: dividerSteps,
      });
    }
    if (customType === "weave.child.thread") {
      return ok(undefined);
    }
    const inputKind = customInputKind(customType);
    if (inputKind !== undefined) {
      const data = recordOf(custom.data.data);
      const text = boundText(nonEmptyString(data?.text) ?? "");
      return ok({
        id,
        sequence,
        kind: inputKind === "steering" ? "steering" : "follow-up",
        text,
        expanded: false,
        replay: [{ kind: "input", input: inputKind, text }],
      });
    }
    const statusText = boundText(customType || "custom");
    const customSteps: ChildOverlayReplayStep[] = [];
    const pushed = pushReplayEvent(customSteps, {
      type: "status",
      status: statusText,
    });
    if (pushed.isErr()) return err(pushed.error);
    return ok({
      id,
      sequence,
      kind: "status",
      text: statusText,
      expanded: false,
      replay: customSteps,
    });
  }

  if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
    const record = entry as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "unknown";
    const id =
      typeof record.id === "string"
        ? safeEntryId(record.id, `entry-${sequence}`)
        : `entry-${sequence}`;
    if (type === "thinking_level_change" || type === "model_change") {
      return ok(undefined);
    }
    const unknownSteps: ChildOverlayReplayStep[] = [];
    const pushed = pushReplayEvent(unknownSteps, {
      type: "unknown",
      originalType: boundLabel(type),
    });
    if (pushed.isErr()) return err(pushed.error);
    return ok({
      id,
      sequence,
      kind: "unknown",
      text: boundText(type),
      expanded: false,
      replay: unknownSteps,
    });
  }
  return ok(undefined);
}

function customInputKind(
  customType: string,
): "steering" | "follow_up" | undefined {
  if (customType.endsWith("steering")) return "steering";
  if (customType.endsWith("follow-up") || customType.endsWith("follow_up"))
    return "follow_up";
  return undefined;
}

/**
 * Projects one assistant message: reasoning blocks, tool calls and the message
 * body each keep their own reducer step, so a rebuilt page renders the same
 * native components (thinking block, tool block, markdown) as the live view.
 *
 * Order is start → content facts → terminal `message_end` (carries final text)
 * → images. The terminal is pushed before images so `message_end` is never
 * crowded out of the derived replay bound.
 */
function assistantEntryFromParts(
  id: string,
  sequence: number,
  parts: NativeMessageParts,
): Result<ChildOverlayEntry, ChildOverlayMappingError> {
  const steps: ChildOverlayReplayStep[] = [];
  const start = pushReplayEvent(steps, {
    type: "message_start",
    message: { id, role: "assistant" },
  });
  if (start.isErr()) return err(start.error);
  for (const thinking of parts.thinking) {
    const pushed = pushReplayEvent(steps, { type: "thinking", text: thinking });
    if (pushed.isErr()) return err(pushed.error);
  }
  for (const call of parts.toolCalls) {
    const pushed = pushReplayEvent(steps, {
      type: "tool_call",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      arguments: call.arguments,
    });
    if (pushed.isErr()) return err(pushed.error);
  }
  const end = pushReplayEvent(steps, {
    type: "message_end",
    message: { id, role: "assistant", content: parts.text },
  });
  if (end.isErr()) return err(end.error);
  for (const mimeType of parts.images) {
    const pushed = pushReplayEvent(steps, {
      type: "image",
      ...(mimeType === undefined ? {} : { mimeType }),
    });
    if (pushed.isErr()) return err(pushed.error);
  }

  const hasText = parts.text.trim().length > 0;
  let kind: ChildOverlayEntryKind = "assistant";
  if (!hasText && parts.toolCalls.length > 0) kind = "tool";
  else if (!hasText && parts.thinking.length > 0) kind = "thinking";
  else if (!hasText && parts.images.length > 0) kind = "image";
  const text = hasText
    ? parts.text
    : boundText(
        [
          ...parts.toolCalls.map((call) => call.toolName),
          ...parts.thinking,
        ].join("\n"),
      );
  return ok({ id, sequence, kind, text, expanded: false, replay: steps });
}

/**
 * Projects one user message. Tool results, tool errors and images keep typed
 * reducer steps instead of collapsing into a flat user string, so a historical
 * page shows the tool block Pi itself would render.
 */
function userEntryFromParts(
  id: string,
  sequence: number,
  parts: NativeMessageParts,
): Result<ChildOverlayEntry, ChildOverlayMappingError> {
  const steps: ChildOverlayReplayStep[] = [];
  const hasText = parts.text.trim().length > 0;
  const hasOtherFacts =
    parts.toolResults.length > 0 || parts.images.length > 0;
  if (hasText || !hasOtherFacts) {
    if (steps.length >= CHILD_OVERLAY_BOUNDS.maxEntryReplaySteps) {
      return err({
        type: "OverlayCapacityExceeded",
        operation: "entry-replay-steps",
      });
    }
    steps.push({
      kind: "input",
      input: "task",
      text: parts.text,
    });
  }
  for (const result of parts.toolResults) {
    const pushed = result.isError
      ? pushReplayEvent(steps, {
          type: "tool_error",
          toolCallId: result.toolCallId,
          error: result.text,
        })
      : pushReplayEvent(steps, {
          type: "tool_result",
          toolCallId: result.toolCallId,
          result: { content: result.content, isError: false },
        });
    if (pushed.isErr()) return err(pushed.error);
  }
  for (const mimeType of parts.images) {
    const pushed = pushReplayEvent(steps, {
      type: "image",
      ...(mimeType === undefined ? {} : { mimeType }),
    });
    if (pushed.isErr()) return err(pushed.error);
  }

  let kind: ChildOverlayEntryKind = sequence === 0 ? "prompt" : "user";
  let text = parts.text;
  if (!hasText && parts.toolResults.length > 0) {
    kind = parts.toolResults.some((result) => result.isError)
      ? "error"
      : "tool";
    text = boundText(
      parts.toolResults
        .map((result) => (result.text.length > 0 ? result.text : "tool result"))
        .join("\n"),
    );
  } else if (!hasText && parts.images.length > 0) {
    kind = "image";
    text = "image";
  }
  return ok({ id, sequence, kind, text, expanded: false, replay: steps });
}

/**
 * Builds a transcript state suitable for custom-editor handoff from overlay
 * entries already loaded in the window. Does not persist anything.
 */
export function transcriptFromOverlayEntries(
  entries: readonly ChildOverlayEntry[],
): PiChildTranscriptState {
  let state = createPiChildTranscriptState();
  for (const entry of entries) {
    const steps = entry.replay ?? legacyReplaySteps(entry);
    for (const step of steps) {
      const action: PiChildTranscriptAction =
        step.kind === "event"
          ? { kind: "event", event: step.event }
          : {
              kind: step.input,
              text: step.text.slice(0, MAX_TRANSCRIPT_INPUT_BYTES),
            };
      const next = reducePiChildTranscript(state, action);
      if (next.isOk()) state = next.value;
    }
  }
  return state;
}

/**
 * Reproduces the pre-strict-mapping projection for entries that carry no
 * replay steps (older persisted windows and hand-built test fixtures).
 */
function legacyReplaySteps(
  entry: ChildOverlayEntry,
): readonly ChildOverlayReplayStep[] {
  if (entry.kind === "prompt" || entry.kind === "user")
    return [{ kind: "input", input: "task", text: entry.text }];
  if (entry.kind === "steering")
    return [{ kind: "input", input: "steering", text: entry.text }];
  if (entry.kind === "follow-up")
    return [{ kind: "input", input: "follow_up", text: entry.text }];
  if (entry.kind === "assistant") {
    const steps: ChildOverlayReplayStep[] = [];
    // Legacy fixtures are two framing steps; capacity failure is impossible.
    void pushReplayEvent(steps, {
      type: "message_start",
      message: { id: entry.id, role: "assistant" },
    });
    void pushReplayEvent(steps, {
      type: "message_end",
      message: { id: entry.id, role: "assistant", content: entry.text },
    });
    return steps;
  }
  if (entry.kind === "retry" || entry.kind === "run-divider") {
    const steps: ChildOverlayReplayStep[] = [];
    void pushReplayEvent(steps, {
      type: "retry",
      attempt: entry.runNumber,
      reason: entry.text,
    });
    return steps;
  }
  return [];
}

/** Explicit degrade for page mapping when a native entry exceeds overlay bounds. */
function degradedCapacityEntry(
  id: string,
  sequence: number,
  error: ChildOverlayMappingError,
): ChildOverlayEntry {
  return {
    id,
    sequence,
    kind: "unknown",
    text: boundText(`capacity:${error.operation}`),
    expanded: false,
    replay: [],
  };
}

// ---------------------------------------------------------------------------
// In-memory source helper (tests + adapters that already hold entry pages)
// ---------------------------------------------------------------------------

export interface MemoryOverlaySourceEntry {
  readonly id: string;
  readonly payload: unknown;
}

export interface MemoryOverlaySourceChild extends ChildOverlayChild {
  readonly entries: readonly MemoryOverlaySourceEntry[];
}

/**
 * Creates a {@link ChildOverlaySourcePort} over an in-memory child catalog.
 * Pagination uses opaque cursors that encode entry ids only (never paths).
 */
export function createMemoryChildOverlaySource(
  children: readonly MemoryOverlaySourceChild[],
): ChildOverlaySourcePort {
  const byId = new Map(children.map((child) => [child.childId, child]));

  const pageFrom = (
    child: MemoryOverlaySourceChild,
    startInclusive: number,
    endExclusive: number,
  ): ChildOverlayPage => {
    const slice = child.entries.slice(startInclusive, endExclusive);
    const mapped: ChildOverlayEntry[] = [];
    for (let i = 0; i < slice.length; i += 1) {
      const item = slice[i];
      if (item === undefined) continue;
      const mappedEntry = mapNativeSessionEntryToOverlay(
        item.payload,
        startInclusive + i,
      );
      if (mappedEntry.isErr()) {
        mapped.push({
          ...degradedCapacityEntry(item.id, startInclusive + i, mappedEntry.error),
          id: item.id,
        });
        continue;
      }
      if (mappedEntry.value === undefined) continue;
      mapped.push({ ...mappedEntry.value, id: item.id });
    }
    // Cursors address the oldest/newest entry already in the page so the next
    // loadOlder/loadNewer call continues contiguously (exclusive of that edge).
    const olderCursor =
      startInclusive > 0
        ? child.entries[startInclusive]?.id
        : undefined;
    const newerCursor =
      endExclusive < child.entries.length && endExclusive > startInclusive
        ? child.entries[endExclusive - 1]?.id
        : undefined;
    return {
      entries: mapped,
      olderCursor,
      newerCursor,
      hasOlder: startInclusive > 0,
      hasNewer: endExclusive < child.entries.length,
    };
  };

  const indexOf = (
    child: MemoryOverlaySourceChild,
    cursor: string,
  ): Result<number, ChildOverlaySourceError> => {
    const parsed = OpaqueCursorSchema.safeParse(cursor);
    if (!parsed.success) {
      return err({ type: "SourceInvalidCursor", operation: "page" });
    }
    const index = child.entries.findIndex((entry) => entry.id === parsed.data);
    if (index < 0) {
      return err({ type: "SourceInvalidCursor", operation: "page" });
    }
    return ok(index);
  };

  return {
    describe(childId) {
      const child = byId.get(childId);
      if (child === undefined) {
        return errAsync({ type: "ChildNotFound", childId });
      }
      const parsed = ChildOverlayChildSchema.safeParse({
        childId: child.childId,
        threadId: child.threadId,
        parentChildId: child.parentChildId,
        status: child.status,
        title: child.title,
        generationId: child.generationId,
        runs: child.runs,
        branchIds: child.branchIds,
        descendantChildIds: child.descendantChildIds,
      });
      if (!parsed.success) {
        return errAsync({
          type: "SourceCorrupt",
          operation: "describe",
        });
      }
      return okAsync(parsed.data);
    },
    loadNewest(childId, pageSize) {
      const child = byId.get(childId);
      if (child === undefined) {
        return errAsync({ type: "ChildNotFound", childId });
      }
      const size = clampPageSize(pageSize);
      const end = child.entries.length;
      const start = Math.max(0, end - size);
      return okAsync(pageFrom(child, start, end));
    },
    loadOlder(childId, cursor, pageSize) {
      const child = byId.get(childId);
      if (child === undefined) {
        return errAsync({ type: "ChildNotFound", childId });
      }
      const index = indexOf(child, cursor);
      if (index.isErr()) return errAsync(index.error);
      const size = clampPageSize(pageSize);
      // Cursor is the oldest entry already loaded; load strictly older than it.
      const end = index.value;
      const start = Math.max(0, end - size);
      return okAsync(pageFrom(child, start, end));
    },
    loadNewer(childId, cursor, pageSize) {
      const child = byId.get(childId);
      if (child === undefined) {
        return errAsync({ type: "ChildNotFound", childId });
      }
      const index = indexOf(child, cursor);
      if (index.isErr()) return errAsync(index.error);
      const size = clampPageSize(pageSize);
      // Cursor is the newest entry already loaded; load strictly newer than it.
      const start = index.value + 1;
      const end = Math.min(child.entries.length, start + size);
      return okAsync(pageFrom(child, start, end));
    },
  };
}

/**
 * Maps one Task 4 bounded native entry page into an overlay page.
 *
 * Opaque older/newer cursors pass through unchanged. Corrupt lines become
 * bounded `unknown` facts. No full transcript is retained.
 */
export function mapNativeSessionEntryPageToOverlay(
  page: PiNativeSessionEntryPage,
): ChildOverlayPage {
  const mapped: ChildOverlayEntry[] = [];
  for (const item of page.entries) {
    if (item.kind === "corrupt") {
      const corruptSteps: ChildOverlayReplayStep[] = [];
      void pushReplayEvent(corruptSteps, {
        type: "unknown",
        originalType: "corrupt",
        payload: { reason: boundLabel(item.reason) },
      });
      mapped.push({
        id: safeEntryId(`corrupt-${item.offset}`, `corrupt-${item.offset}`),
        sequence: item.offset,
        kind: "unknown",
        text: boundText(`corrupt:${item.reason}`),
        expanded: false,
        replay: corruptSteps,
      });
      continue;
    }
    const entry = mapNativeSessionEntryToOverlay(item.value, item.offset);
    if (entry.isErr()) {
      mapped.push(
        degradedCapacityEntry(
          safeEntryId(`capacity-${item.offset}`, `capacity-${item.offset}`),
          item.offset,
          entry.error,
        ),
      );
      continue;
    }
    if (entry.value !== undefined) mapped.push(entry.value);
  }
  return {
    entries: mapped,
    olderCursor: page.olderCursor,
    newerCursor: page.newerCursor,
    hasOlder: page.olderCursor !== undefined,
    hasNewer: page.newerCursor !== undefined,
  };
}

function mapNativePageError(
  error: PiNativeSessionError,
  operation: string,
): ChildOverlaySourceError {
  if (
    error.type === "SessionCorrupt" &&
    (error.reason === "invalid-cursor" || error.reason === "stale-cursor")
  ) {
    return { type: "SourceInvalidCursor", operation };
  }
  if (error.type === "SessionMissing") {
    return { type: "SourceCorrupt", operation };
  }
  return { type: "SourceCorrupt", operation };
}

/**
 * Adapts Task 4 `readSessionEntryPage` into a paginated overlay source.
 *
 * Each page request performs one injected bounded native page read — never
 * `readSessionEntries`, `SessionManager.getEntries`, or a full-file cache.
 * Opaque older/newer cursors are forwarded verbatim. The overlay controller
 * still retains only its hard in-memory window.
 */
export function createReadSessionEntryPageOverlaySource(deps: {
  readonly describe: (
    childId: string,
  ) => ResultAsync<ChildOverlayChild, ChildOverlaySourceError>;
  readonly readSessionEntryPage: (
    childId: string,
    options: PiNativeSessionEntryPageOptions,
  ) => ResultAsync<PiNativeSessionEntryPage, PiNativeSessionError>;
}): ChildOverlaySourcePort {
  const loadPage = (
    childId: string,
    options: PiNativeSessionEntryPageOptions,
    operation: string,
  ): ResultAsync<ChildOverlayPage, ChildOverlaySourceError> =>
    deps
      .readSessionEntryPage(childId, options)
      .map(mapNativeSessionEntryPageToOverlay)
      .mapErr((error) => mapNativePageError(error, operation));

  return {
    describe: deps.describe,
    loadNewest(childId, pageSize) {
      return loadPage(
        childId,
        { direction: "newest", limit: clampPageSize(pageSize) },
        "loadNewest",
      );
    },
    loadOlder(childId, cursor, pageSize) {
      const parsed = OpaqueCursorSchema.safeParse(cursor);
      if (!parsed.success) {
        return errAsync({ type: "SourceInvalidCursor", operation: "loadOlder" });
      }
      return loadPage(
        childId,
        {
          direction: "older",
          cursor: parsed.data,
          limit: clampPageSize(pageSize),
        },
        "loadOlder",
      );
    },
    loadNewer(childId, cursor, pageSize) {
      const parsed = OpaqueCursorSchema.safeParse(cursor);
      if (!parsed.success) {
        return errAsync({ type: "SourceInvalidCursor", operation: "loadNewer" });
      }
      return loadPage(
        childId,
        {
          direction: "newer",
          cursor: parsed.data,
          limit: clampPageSize(pageSize),
        },
        "loadNewer",
      );
    },
  };
}

function clampPageSize(pageSize: number): number {
  if (!Number.isFinite(pageSize)) return CHILD_OVERLAY_BOUNDS.defaultPageSize;
  return Math.max(
    1,
    Math.min(CHILD_OVERLAY_BOUNDS.maxPageSize, Math.floor(pageSize)),
  );
}

function clampWindowCap(windowCap: number): number {
  if (!Number.isFinite(windowCap)) return CHILD_OVERLAY_BOUNDS.defaultWindowCap;
  return Math.max(
    1,
    Math.min(CHILD_OVERLAY_BOUNDS.maxWindowCap, Math.floor(windowCap)),
  );
}

// ---------------------------------------------------------------------------
// Per-child saved state (LRU)
// ---------------------------------------------------------------------------

interface SavedChildState {
  draft: string;
  searchQuery: string;
  scrollOffset: number;
  liveTail: boolean;
  globalExpanded: boolean;
  activeRun: number | undefined;
  activeBranchId: string | undefined;
  olderCursor: string | undefined;
  newerCursor: string | undefined;
  hasOlderFlag: boolean;
  hasNewerFlag: boolean;
  entries: ChildOverlayEntry[];
  compact: ChildCompactState;
  transcript: PiChildTranscriptState;
  anchor: ChildOverlayAnchor | undefined;
  width: number;
  height: number;
  lastTouched: number;
}

function emptySaved(
  threadId: string,
  touched: number,
): SavedChildState {
  return {
    draft: "",
    searchQuery: "",
    scrollOffset: 0,
    liveTail: true,
    globalExpanded: false,
    activeRun: undefined,
    activeBranchId: undefined,
    olderCursor: undefined,
    newerCursor: undefined,
    hasOlderFlag: false,
    hasNewerFlag: false,
    entries: [],
    compact: createChildCompactState(threadId),
    transcript: createPiChildTranscriptState(),
    anchor: undefined,
    width: 80,
    height: 24,
    lastTouched: touched,
  };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class ChildOverlayController {
  private readonly source: ChildOverlaySourcePort;
  private readonly mutations: ChildOverlayMutationPort | undefined;
  private readonly pageSize: number;
  private readonly windowCap: number;
  private readonly maxLruChildren: number;
  private readonly maxSearchPages: number;
  private readonly saved = new Map<string, SavedChildState>();
  private openChild: ChildOverlayChild | undefined;
  private clock = 0;

  constructor(
    source: ChildOverlaySourcePort,
    config: ChildOverlayConfig = {},
    mutations?: ChildOverlayMutationPort,
  ) {
    this.source = source;
    this.mutations = mutations;
    this.pageSize = clampPageSize(
      config.pageSize ?? CHILD_OVERLAY_BOUNDS.defaultPageSize,
    );
    this.windowCap = clampWindowCap(
      config.windowCap ?? CHILD_OVERLAY_BOUNDS.defaultWindowCap,
    );
    this.maxLruChildren = Math.max(
      1,
      Math.min(
        CHILD_OVERLAY_BOUNDS.maxLruChildren,
        config.maxLruChildren ?? CHILD_OVERLAY_BOUNDS.maxLruChildren,
      ),
    );
    this.maxSearchPages = Math.max(
      1,
      Math.min(
        CHILD_OVERLAY_BOUNDS.maxSearchPages,
        config.maxSearchPages ?? CHILD_OVERLAY_BOUNDS.maxSearchPages,
      ),
    );
  }

  isOpen(): boolean {
    return this.openChild !== undefined;
  }

  currentChildId(): string | undefined {
    return this.openChild?.childId;
  }

  view(): Result<ChildOverlayView, ChildOverlayError> {
    const child = this.openChild;
    if (child === undefined) return err({ type: "OverlayNotOpen" });
    const state = this.saved.get(child.childId);
    if (state === undefined) return err({ type: "OverlayNotOpen" });
    return ok(this.toView(child, state));
  }

  open(
    childInput: ChildOverlayChild | string,
  ): ResultAsync<ChildOverlayView, ChildOverlayError> {
    const childId =
      typeof childInput === "string" ? childInput : childInput.childId;
    if (this.openChild !== undefined && this.openChild.childId !== childId) {
      this.persistOpen();
    }
    return this.source
      .describe(childId)
      .mapErr(
        (error): ChildOverlayError =>
          error.type === "SourceUnavailable" ||
          error.type === "SourceCorrupt" ||
          error.type === "ChildNotFound"
            ? this.fallbackFromError(childId, "describe-failed", error)
            : error,
      )
      .andThen((described) => {
        const parsed = ChildOverlayChildSchema.safeParse(
          typeof childInput === "string"
            ? described
            : { ...described, ...childInput, childId },
        );
        if (!parsed.success) {
          return errAsync<ChildOverlayView, ChildOverlayError>({
            type: "OverlayInvalidChild",
            issues: parsed.error.issues.map((issue) => issue.path.join(".")),
          });
        }
        const child = parsed.data;
        this.touch(child.childId);
        const existing = this.saved.get(child.childId);
        const state =
          existing ??
          emptySaved(child.threadId, this.clock);
        if (existing === undefined) this.saved.set(child.childId, state);
        this.openChild = child;
        this.evictLru();
        if (state.entries.length > 0) {
          return okAsync(this.toView(child, state));
        }
        return this.source
          .loadNewest(child.childId, this.pageSize)
          .mapErr(
            (error): ChildOverlayError =>
              this.fallbackFromError(child.childId, "source-failed", error),
          )
          .map((page) => {
            this.applyPage(state, page, "replace");
            state.liveTail = true;
            state.scrollOffset = 0;
            state.activeRun =
              child.runs.length > 0
                ? child.runs[child.runs.length - 1]?.run
                : undefined;
            state.activeBranchId = child.branchIds[0];
            return this.toView(child, state);
          });
      });
  }

  close(): Result<void, ChildOverlayError> {
    if (this.openChild === undefined) return err({ type: "OverlayNotOpen" });
    this.persistOpen();
    this.openChild = undefined;
    return ok(undefined);
  }

  loadOlder(): ResultAsync<ChildOverlayView, ChildOverlayError> {
    return this.withOpen((child, state) => {
      if (state.olderCursor === undefined) {
        return okAsync(this.toView(child, state));
      }
      return this.source
        .loadOlder(child.childId, state.olderCursor, this.pageSize)
        .mapErr(
          (error): ChildOverlayError =>
            this.fallbackFromError(child.childId, "source-failed", error),
        )
        .map((page) => {
          this.applyPage(state, page, "prepend");
          return this.toView(child, state);
        });
    });
  }

  loadNewer(): ResultAsync<ChildOverlayView, ChildOverlayError> {
    return this.withOpen((child, state) => {
      if (state.newerCursor === undefined) {
        return okAsync(this.toView(child, state));
      }
      return this.source
        .loadNewer(child.childId, state.newerCursor, this.pageSize)
        .mapErr(
          (error): ChildOverlayError =>
            this.fallbackFromError(child.childId, "source-failed", error),
        )
        .map((page) => {
          this.applyPage(state, page, "append");
          if (state.liveTail) state.scrollOffset = 0;
          return this.toView(child, state);
        });
    });
  }

  search(
    query: string,
  ): ResultAsync<ChildOverlayView, ChildOverlayError> {
    const bounded = OverlayTextSchema.safeParse(query);
    const text = bounded.success
      ? bounded.data
      : query.slice(0, CHILD_OVERLAY_BOUNDS.maxTextLength);
    return this.withOpen((child, state) => {
      state.searchQuery = text;
      if (text.length === 0) {
        return okAsync(this.toView(child, state));
      }
      const needle = text.toLowerCase();
      if (
        state.entries.some((entry) =>
          entry.text.toLowerCase().includes(needle),
        )
      ) {
        return okAsync(this.toView(child, state));
      }
      return this.searchFetchPages(child, state, needle, 0);
    });
  }

  private searchFetchPages(
    child: ChildOverlayChild,
    state: SavedChildState,
    needle: string,
    pagesFetched: number,
  ): ResultAsync<ChildOverlayView, ChildOverlayError> {
    if (
      pagesFetched >= this.maxSearchPages ||
      state.olderCursor === undefined ||
      state.entries.some((entry) => entry.text.toLowerCase().includes(needle))
    ) {
      return okAsync(this.toView(child, state));
    }
    return this.source
      .loadOlder(child.childId, state.olderCursor, this.pageSize)
      .mapErr(
        (error): ChildOverlayError =>
          this.fallbackFromError(child.childId, "source-failed", error),
      )
      .andThen((page) => {
        this.applyPage(state, page, "prepend");
        if (!page.hasOlder) return okAsync(this.toView(child, state));
        return this.searchFetchPages(child, state, needle, pagesFetched + 1);
      });
  }

  /**
   * Applies one parser-approved live child event through the Task 11 map /
   * reduce pipeline and projects a window entry when meaningful.
   */
  applyLiveEvent(
    event: unknown,
  ): Result<ChildOverlayView, ChildOverlayError> {
    const child = this.openChild;
    if (child === undefined) return err({ type: "OverlayNotOpen" });
    const state = this.saved.get(child.childId);
    if (state === undefined) return err({ type: "OverlayNotOpen" });
    if (child.status !== "live") {
      return ok(this.toView(child, state));
    }

    const parsed = parsePiChildSessionEvent(event);
    if (!parsed.success) return ok(this.toView(child, state));
    const sessionEvent = parsed.data;

    const mapped = mapPiChildSessionEventToCompactInput(sessionEvent);
    if (mapped.isOk() && mapped.value !== undefined) {
      state.compact = reduceChildCompactSafe(state.compact, mapped.value);
    }

    const transcriptNext = reducePiChildTranscript(state.transcript, {
      kind: "event",
      event: sessionEvent,
    });
    if (transcriptNext.isOk()) state.transcript = transcriptNext.value;

    const projected = projectLiveEntry(
      sessionEvent,
      state.entries.length,
      state.globalExpanded,
    );
    if (projected !== undefined) {
      this.mergeEntry(state, projected);
    }
    if (state.liveTail) state.scrollOffset = 0;
    return ok(this.toView(child, state));
  }

  setScrollOffset(
    offset: number,
  ): Result<ChildOverlayView, ChildOverlayError> {
    return this.mutateOpen((child, state) => {
      const max = Math.max(0, state.entries.length);
      const next = Math.min(Math.max(0, Math.floor(offset)), max);
      state.scrollOffset = next;
      state.liveTail = next === 0;
      state.anchor = anchorFromScroll(state);
      return this.toView(child, state);
    });
  }

  scrollBy(delta: number): Result<ChildOverlayView, ChildOverlayError> {
    return this.mutateOpen((child, state) => {
      const max = Math.max(0, state.entries.length);
      const next = Math.min(
        Math.max(0, state.scrollOffset + Math.trunc(delta)),
        max,
      );
      state.scrollOffset = next;
      state.liveTail = next === 0;
      state.anchor = anchorFromScroll(state);
      return this.toView(child, state);
    });
  }

  resize(
    width: number,
    height: number,
  ): Result<ChildOverlayView, ChildOverlayError> {
    return this.mutateOpen((child, state) => {
      const anchor = state.anchor ?? anchorFromScroll(state);
      state.width = Math.max(1, Math.floor(width));
      state.height = Math.max(1, Math.floor(height));
      state.anchor = anchor;
      if (anchor !== undefined) {
        const index = state.entries.findIndex(
          (entry) => entry.id === anchor.entryId,
        );
        if (index >= 0) {
          state.scrollOffset = Math.max(0, state.entries.length - 1 - index);
          state.liveTail = state.scrollOffset === 0;
        }
      }
      return this.toView(child, state);
    });
  }

  toggleGlobalExpansion(): Result<ChildOverlayView, ChildOverlayError> {
    return this.mutateOpen((child, state) => {
      state.globalExpanded = !state.globalExpanded;
      state.entries = state.entries.map((entry) => ({
        ...entry,
        expanded: state.globalExpanded,
      }));
      // Keep the rendered transcript visibility in lockstep with the overlay
      // window without rebuilding (live thinking/tool rows must stay).
      state.transcript = {
        ...state.transcript,
        entries: state.transcript.entries.map((entry) => ({
          ...entry,
          expanded: state.globalExpanded,
        })),
      };
      return this.toView(child, state);
    });
  }

  navigateRun(
    delta: number,
  ): Result<ChildOverlayView, ChildOverlayError> {
    return this.mutateOpen((child, state) => {
      const runs = child.runs;
      if (runs.length === 0) return this.toView(child, state);
      const currentIndex = Math.max(
        0,
        runs.findIndex((run) => run.run === state.activeRun),
      );
      const nextIndex = Math.min(
        runs.length - 1,
        Math.max(0, currentIndex + Math.trunc(delta)),
      );
      state.activeRun = runs[nextIndex]?.run;
      return this.toView(child, state);
    });
  }

  navigateBranch(
    delta: number,
  ): Result<ChildOverlayView, ChildOverlayError> {
    return this.mutateOpen((child, state) => {
      const branches = child.branchIds;
      if (branches.length === 0) return this.toView(child, state);
      const currentIndex = Math.max(
        0,
        branches.findIndex((id) => id === state.activeBranchId),
      );
      const nextIndex = Math.min(
        branches.length - 1,
        Math.max(0, currentIndex + Math.trunc(delta)),
      );
      state.activeBranchId = branches[nextIndex];
      return this.toView(child, state);
    });
  }

  updateDraft(draft: string): Result<ChildOverlayView, ChildOverlayError> {
    const bounded = OverlayTextSchema.safeParse(draft);
    const text = bounded.success
      ? bounded.data
      : draft.slice(0, CHILD_OVERLAY_BOUNDS.maxTextLength);
    return this.mutateOpen((child, state) => {
      if (isReadOnly(child)) return this.toView(child, state);
      state.draft = text;
      return this.toView(child, state);
    });
  }

  /**
   * Consumes every key while mounted. Never routes text or keys to a primary
   * editor. Settled/orphan children are read-only for mutation actions.
   */
  handleInput(
    data: string,
  ): ResultAsync<ChildOverlayInputOutcome, ChildOverlayError> {
    const child = this.openChild;
    if (child === undefined) {
      return errAsync({ type: "OverlayNotOpen" });
    }
    const state = this.saved.get(child.childId);
    if (state === undefined) {
      return errAsync({ type: "OverlayNotOpen" });
    }

    const scroll = scrollDelta(data);
    if (scroll !== undefined) {
      if (scroll === "oldest") {
        state.scrollOffset = Math.max(0, state.entries.length);
        state.liveTail = false;
      } else if (scroll === "follow") {
        state.scrollOffset = 0;
        state.liveTail = true;
      } else {
        state.scrollOffset = Math.min(
          Math.max(0, state.scrollOffset + scroll),
          Math.max(0, state.entries.length),
        );
        state.liveTail = state.scrollOffset === 0;
      }
      state.anchor = anchorFromScroll(state);
      return okAsync({ kind: "scroll", scrollOffset: state.scrollOffset });
    }

    if (matchesKey(data, "enter")) {
      if (isReadOnly(child) || !child.generationId) {
        return okAsync({ kind: "consumed" });
      }
      const text = state.draft.trim();
      if (text.length === 0) return okAsync({ kind: "consumed" });
      state.draft = "";
      const mutation = this.mutations;
      if (mutation === undefined) {
        return okAsync({
          kind: "steer",
          childId: child.childId,
          text,
        });
      }
      return mutation
        .steer(child.childId, child.generationId, text)
        .map(() => ({
          kind: "steer" as const,
          childId: child.childId,
          text,
        }))
        .mapErr((): ChildOverlayError =>
          this.fallbackFromError(child.childId, "render-failed", {
            type: "SourceUnavailable",
            operation: "steer",
          }),
        );
    }

    if (matchesKey(data, "alt+enter")) {
      if (isReadOnly(child) || !child.generationId) {
        return okAsync({ kind: "consumed" });
      }
      const text = state.draft.trim();
      if (text.length === 0) return okAsync({ kind: "consumed" });
      state.draft = "";
      const mutation = this.mutations;
      if (mutation === undefined) {
        return okAsync({
          kind: "follow-up",
          childId: child.childId,
          text,
        });
      }
      return mutation
        .followUp(child.childId, child.generationId, text)
        .map(() => ({
          kind: "follow-up" as const,
          childId: child.childId,
          text,
        }))
        .mapErr((): ChildOverlayError =>
          this.fallbackFromError(child.childId, "render-failed", {
            type: "SourceUnavailable",
            operation: "follow-up",
          }),
        );
    }

    if (matchesKey(data, "ctrl+e") || data === "\x05") {
      const toggled = this.toggleGlobalExpansion();
      if (toggled.isErr()) return errAsync(toggled.error);
      return okAsync({
        kind: "expanded",
        globalExpanded: toggled.value.globalExpanded,
      });
    }

    if (data === "\x1b[1;3D" || matchesKey(data, "alt+left")) {
      const nav = this.navigateRun(-1);
      if (nav.isErr()) return errAsync(nav.error);
      return okAsync({ kind: "navigate-run", activeRun: nav.value.activeRun });
    }
    if (data === "\x1b[1;3C" || matchesKey(data, "alt+right")) {
      const nav = this.navigateRun(1);
      if (nav.isErr()) return errAsync(nav.error);
      return okAsync({ kind: "navigate-run", activeRun: nav.value.activeRun });
    }
    if (data === "\x1b[1;3A" || matchesKey(data, "alt+up")) {
      const nav = this.navigateBranch(-1);
      if (nav.isErr()) return errAsync(nav.error);
      return okAsync({
        kind: "navigate-branch",
        activeBranchId: nav.value.activeBranchId,
      });
    }
    if (data === "\x1b[1;3B" || matchesKey(data, "alt+down")) {
      const nav = this.navigateBranch(1);
      if (nav.isErr()) return errAsync(nav.error);
      return okAsync({
        kind: "navigate-branch",
        activeBranchId: nav.value.activeBranchId,
      });
    }

    // All other input updates the overlay draft (or is swallowed). Never leak.
    if (!isReadOnly(child) && data.length > 0 && !data.startsWith("\x1b")) {
      if (data === "\x7f" || data === "\b") {
        state.draft = state.draft.slice(0, -1);
      } else if (!data.includes("\x00")) {
        const next = boundText(state.draft + data);
        state.draft = next;
      }
      return okAsync({ kind: "draft-updated", draft: state.draft });
    }

    return okAsync({ kind: "consumed" });
  }

  /**
   * Explicit render-boundary failure used by a later TUI layer. Returns only
   * bounded metadata + transcript model — never exception text or paths.
   */
  requireFallback(
    reason: ChildOverlayFallbackReason = "render-failed",
  ): ChildOverlayFallbackRequired {
    const child = this.openChild;
    const state =
      child !== undefined ? this.saved.get(child.childId) : undefined;
    return {
      kind: "fallback-required",
      metadata: {
        childId: child?.childId ?? "unknown",
        threadId: child?.threadId ?? "unknown",
        status: child?.status ?? "settled",
        entryCount: state?.entries.length ?? 0,
        reason,
        readOnly: child === undefined ? true : isReadOnly(child),
      },
      transcript: state?.transcript ?? createPiChildTranscriptState(),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private withOpen(
    fn: (
      child: ChildOverlayChild,
      state: SavedChildState,
    ) => ResultAsync<ChildOverlayView, ChildOverlayError>,
  ): ResultAsync<ChildOverlayView, ChildOverlayError> {
    const child = this.openChild;
    if (child === undefined) return errAsync({ type: "OverlayNotOpen" });
    const state = this.saved.get(child.childId);
    if (state === undefined) return errAsync({ type: "OverlayNotOpen" });
    this.touch(child.childId);
    return fn(child, state);
  }

  private mutateOpen(
    fn: (
      child: ChildOverlayChild,
      state: SavedChildState,
    ) => ChildOverlayView,
  ): Result<ChildOverlayView, ChildOverlayError> {
    const child = this.openChild;
    if (child === undefined) return err({ type: "OverlayNotOpen" });
    const state = this.saved.get(child.childId);
    if (state === undefined) return err({ type: "OverlayNotOpen" });
    this.touch(child.childId);
    return ok(fn(child, state));
  }

  private persistOpen(): void {
    const child = this.openChild;
    if (child === undefined) return;
    const state = this.saved.get(child.childId);
    if (state !== undefined) state.lastTouched = ++this.clock;
  }

  private touch(childId: string): void {
    const state = this.saved.get(childId);
    if (state !== undefined) state.lastTouched = ++this.clock;
  }

  private evictLru(): void {
    while (this.saved.size > this.maxLruChildren) {
      let victim: string | undefined;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [id, state] of this.saved) {
        if (id === this.openChild?.childId) continue;
        if (state.lastTouched < oldest) {
          oldest = state.lastTouched;
          victim = id;
        }
      }
      if (victim === undefined) break;
      this.saved.delete(victim);
    }
  }

  private applyPage(
    state: SavedChildState,
    page: ChildOverlayPage,
    mode: "replace" | "prepend" | "append",
  ): void {
    const incoming = page.entries.map((entry) => ({
      ...entry,
      expanded: state.globalExpanded,
      text: stripPathLike(entry.text),
    }));
    const priorAnchor = state.anchor ?? anchorFromScroll(state);

    if (mode === "replace") {
      state.entries = dedupEntries(incoming).slice(-this.windowCap);
      state.olderCursor = page.olderCursor;
      state.newerCursor = page.newerCursor;
      state.hasOlderFlag = page.hasOlder;
      state.hasNewerFlag = page.hasNewer;
      syncTranscriptFromEntries(state);
      return;
    }

    if (mode === "prepend") {
      // Prepend only entries not already retained. Middle-overlapping pages
      // (resume from a page newer/older boundary inside the window) must not
      // reorder the chronological window via naive [...incoming, ...state].
      const existingIds = new Set(state.entries.map((entry) => entry.id));
      const uniqueOlder = incoming.filter((entry) => !existingIds.has(entry.id));
      const merged = dedupEntries([...uniqueOlder, ...state.entries]);
      // Keep fetched older entries; trim the newest tail when over cap.
      const retained = merged.slice(0, this.windowCap);
      const trimmedNewest = merged.length - retained.length;

      state.entries = retained;
      // Always adopt the page older boundary. Overlapping pages must still
      // advance the opaque cursor so loadOlder can reach the start.
      state.olderCursor = page.olderCursor;
      state.hasOlderFlag = page.hasOlder;
      if (trimmedNewest > 0) {
        // Never substitute retained entry ids for source opaque cursors.
        // The page newer cursor is the boundary that can reload trimmed newer
        // entries; when nothing was trimmed, keep the existing newer cursor.
        state.newerCursor = page.newerCursor;
        state.hasNewerFlag = true;
        state.liveTail = false;
      }
      restoreScrollAnchor(state, priorAnchor);
      syncTranscriptFromEntries(state);
      return;
    }

    const existingIds = new Set(state.entries.map((entry) => entry.id));
    const uniqueNewer = incoming.filter((entry) => !existingIds.has(entry.id));
    const merged = dedupEntries([...state.entries, ...uniqueNewer]);
    // Append keeps the newest side; trim the oldest head when over cap.
    const retained = merged.slice(-this.windowCap);
    const trimmedOldest = merged.length - retained.length;

    state.entries = retained;
    if (trimmedOldest > 0) {
      // Never substitute retained entry ids for source opaque cursors.
      // The page older cursor reloads trimmed older entries; when nothing was
      // trimmed, keep the existing older cursor.
      state.olderCursor = page.olderCursor;
      state.hasOlderFlag = true;
    }
    // Always adopt the page newer boundary. Overlapping pages (common after
    // prepend trim, which resumes from the older page's newer cursor) must
    // still advance the opaque cursor so loadNewer can reach the tip.
    state.newerCursor = page.newerCursor;
    state.hasNewerFlag = page.hasNewer;
    restoreScrollAnchor(state, priorAnchor);
    syncTranscriptFromEntries(state);
  }

  private mergeEntry(state: SavedChildState, entry: ChildOverlayEntry): void {
    const index = state.entries.findIndex((item) => item.id === entry.id);
    if (index >= 0) {
      const existing = state.entries[index];
      const next = [...state.entries];
      next[index] = {
        ...entry,
        expanded: state.globalExpanded,
        replay: mergeReplaySteps(existing?.replay, entry.replay),
      };
      state.entries = next;
      return;
    }
    const merged = dedupEntries([
      ...state.entries,
      { ...entry, expanded: state.globalExpanded },
    ]);
    const retained = merged.slice(-this.windowCap);
    const trimmed = retained.length < merged.length;
    state.entries = retained;
    // Live append keeps the incremental transcript reduce; only rebuild when
    // the window trims so stale older transcript rows cannot outlive entries.
    if (trimmed) syncTranscriptFromEntries(state);
  }

  private toView(
    child: ChildOverlayChild,
    state: SavedChildState,
  ): ChildOverlayView {
    const needle = state.searchQuery.trim().toLowerCase();
    const searchMatches =
      needle.length === 0
        ? []
        : state.entries
            .filter((entry) => entry.text.toLowerCase().includes(needle))
            .map((entry) => entry.id);
    return {
      child,
      entries: state.entries,
      draft: state.draft,
      searchQuery: state.searchQuery,
      searchMatches,
      scrollOffset: state.scrollOffset,
      liveTail: state.liveTail,
      globalExpanded: state.globalExpanded,
      activeRun: state.activeRun,
      activeBranchId: state.activeBranchId,
      olderCursor: state.olderCursor,
      newerCursor: state.newerCursor,
      hasOlder: state.hasOlderFlag,
      hasNewer: state.hasNewerFlag,
      readOnly: isReadOnly(child),
      width: state.width,
      height: state.height,
      anchor: state.anchor,
      compact: state.compact,
      transcript: state.transcript,
    };
  }

  private fallbackFromError(
    childId: string,
    reason: ChildOverlayFallbackReason,
    _error: ChildOverlaySourceError,
  ): ChildOverlayFallbackRequired {
    void _error;
    const child = this.openChild;
    const state = this.saved.get(childId);
    const metadata: ChildOverlayFallbackMetadata = {
      childId,
      threadId: child?.threadId ?? childId,
      status: child?.status ?? "settled",
      entryCount: state?.entries.length ?? 0,
      reason,
      readOnly: child === undefined ? true : isReadOnly(child),
    };
    // Ensure no path-like strings leak through error channels.
    return {
      kind: "fallback-required",
      metadata,
      transcript: state?.transcript ?? createPiChildTranscriptState(),
    };
  }
}

function isReadOnly(child: ChildOverlayChild): boolean {
  return child.status === "settled" || child.status === "orphan";
}

function dedupEntries(
  entries: readonly ChildOverlayEntry[],
): ChildOverlayEntry[] {
  const seen = new Set<string>();
  const result: ChildOverlayEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push(entry);
  }
  return result;
}

/**
 * Rebuilds {@link SavedChildState.transcript} from the retained overlay window
 * so paged merges (older/newer/search/replace) cannot leave the render model
 * pointing at a stale tip-only transcript. Preserves expanded IDs that still
 * resolve after the rebuild; scroll anchors are owned by {@link restoreScrollAnchor}.
 */
function syncTranscriptFromEntries(state: SavedChildState): void {
  const priorExpandedIds = new Set<string>();
  const priorExpandedTexts = new Set<string>();
  for (const entry of state.transcript.entries) {
    if (!entry.expanded) continue;
    priorExpandedIds.add(entry.id);
    if ("messageId" in entry && typeof entry.messageId === "string") {
      priorExpandedIds.add(entry.messageId);
    }
    if ("text" in entry && typeof entry.text === "string") {
      priorExpandedTexts.add(entry.text);
    }
  }
  for (const entry of state.entries) {
    if (!entry.expanded) continue;
    priorExpandedIds.add(entry.id);
    priorExpandedTexts.add(entry.text);
  }

  const rebuilt = transcriptFromOverlayEntries(state.entries);
  if (priorExpandedIds.size === 0 && !state.globalExpanded) {
    state.transcript = rebuilt;
    return;
  }

  state.transcript = {
    ...rebuilt,
    entries: rebuilt.entries.map((entry) => {
      const messageId =
        "messageId" in entry && typeof entry.messageId === "string"
          ? entry.messageId
          : undefined;
      const text =
        "text" in entry && typeof entry.text === "string"
          ? entry.text
          : undefined;
      const expanded =
        state.globalExpanded ||
        priorExpandedIds.has(entry.id) ||
        (messageId !== undefined && priorExpandedIds.has(messageId)) ||
        (text !== undefined && priorExpandedTexts.has(text));
      return expanded === entry.expanded ? entry : { ...entry, expanded };
    }),
  };
}

function stripPathLike(value: string): string {
  // Drop absolute path prefixes that would leak storage locations.
  return boundText(
    value
      .replace(/(?:^|[\s"])(?:\/(?:Users|home|var|tmp|private)\/\S+)/gu, " [path]")
      .replace(/(?:[A-Za-z]:\\[^\s"]+)/gu, " [path]"),
  );
}

function anchorFromScroll(state: SavedChildState): ChildOverlayAnchor | undefined {
  if (state.entries.length === 0) return undefined;
  const index = Math.max(
    0,
    Math.min(
      state.entries.length - 1,
      state.entries.length - 1 - state.scrollOffset,
    ),
  );
  const entry = state.entries[index];
  if (entry === undefined) return undefined;
  return { entryId: entry.id, lineOffset: 0 };
}

/** Recompute scrollOffset so a retained entry stays the logical viewport anchor. */
function restoreScrollAnchor(
  state: SavedChildState,
  anchor: ChildOverlayAnchor | undefined,
): void {
  if (anchor === undefined || state.entries.length === 0) {
    state.anchor = anchorFromScroll(state);
    return;
  }
  const index = state.entries.findIndex((entry) => entry.id === anchor.entryId);
  if (index < 0) {
    // Anchor was trimmed; clamp to the nearest retained edge.
    state.scrollOffset = Math.min(
      state.scrollOffset,
      Math.max(0, state.entries.length - 1),
    );
    state.liveTail = state.scrollOffset === 0;
    state.anchor = anchorFromScroll(state);
    return;
  }
  state.scrollOffset = Math.max(0, state.entries.length - 1 - index);
  state.liveTail = state.scrollOffset === 0;
  state.anchor = { entryId: anchor.entryId, lineOffset: anchor.lineOffset };
}

function scrollDelta(
  data: string,
): number | "oldest" | "follow" | undefined {
  if (data === SCROLL_KEYS.pageUp) return SCROLL_PAGE;
  if (data === SCROLL_KEYS.pageDown) return -SCROLL_PAGE;
  if (data === SCROLL_KEYS.shiftUp) return 1;
  if (data === SCROLL_KEYS.shiftDown) return -1;
  if (data === SCROLL_KEYS.home) return "oldest";
  if (data === SCROLL_KEYS.end) return "follow";
  return undefined;
}

function projectLiveEntry(
  event: PiChildSessionEvent,
  sequence: number,
  expanded: boolean,
): ChildOverlayEntry | undefined {
  const replay: readonly ChildOverlayReplayStep[] = [{ kind: "event", event }];
  switch (event.type) {
    case "message_start":
    case "message_update":
    case "message_end": {
      let text = "";
      if (event.type === "message_end") {
        text = messageText(event.message).text;
      } else if (event.type === "message_update") {
        const deltaText = (event as { delta?: { text?: string } }).delta?.text;
        if (typeof deltaText === "string") {
          text = boundText(deltaText);
        }
      }
      const id = liveAssistantEntryId(event, sequence);
      if (event.type === "message_update" && text.length === 0) return undefined;
      return {
        id,
        sequence,
        kind: "assistant",
        text,
        expanded,
        // A streaming delta is transcript-neutral on rebuild: its terminal
        // `message_end` carries the whole message, so replaying the delta too
        // would append the same text twice.
        replay: event.type === "message_update" ? [] : replay,
      };
    }
    case "text":
    case "markdown":
      return {
        id: `live-text-${sequence}`,
        sequence,
        kind: "assistant",
        text: boundText(typeof event.text === "string" ? event.text : ""),
        expanded,
        replay,
      };
    case "thinking":
      return {
        id: `live-thinking-${sequence}`,
        sequence,
        kind: "thinking",
        text: boundText(typeof event.text === "string" ? event.text : ""),
        expanded,
        replay,
      };
    case "tool_call":
    case "tool_partial_result":
    case "tool_result":
    case "tool_error": {
      const toolId =
        typeof event.toolCallId === "string" && event.toolCallId.length > 0
          ? safeEntryId(event.toolCallId, `live-tool-${sequence}`)
          : `live-tool-${sequence}`;
      return {
        id: toolId,
        sequence,
        kind: event.type === "tool_error" ? "error" : "tool",
        text: boundText(
          typeof event.toolName === "string" ? event.toolName : event.type,
        ),
        expanded,
        replay,
      };
    }
    case "retry":
      return {
        id: `live-retry-${sequence}`,
        sequence,
        kind: "retry",
        text: boundText(
          `retry ${event.attempt ?? "?"} ${event.reason ?? ""}`.trim(),
        ),
        runNumber:
          typeof event.attempt === "number" ? event.attempt : undefined,
        expanded,
        replay,
      };
    case "image":
      return {
        id: `live-image-${sequence}`,
        sequence,
        kind: "image",
        text: "image",
        expanded,
        replay,
      };
    case "status":
      return {
        id: `live-status-${sequence}`,
        sequence,
        kind: "status",
        text: boundText(
          typeof event.status === "string" ? event.status : "status",
        ),
        expanded,
        replay,
      };
    default:
      return undefined;
  }
}

/**
 * Resolves the assistant entry id from the message the event carries so a
 * `message_start` and its `message_end` project one window entry instead of
 * two, matching the single assistant entry the transcript reducer keeps.
 */
function liveAssistantEntryId(
  event: PiChildSessionEvent,
  sequence: number,
): string {
  const record = event as unknown as Record<string, unknown>;
  const message = recordOf(record.message);
  const delta = recordOf(record.delta);
  const assistantEvent = recordOf(record.assistantMessageEvent);
  const id =
    nonEmptyString(message?.id) ??
    nonEmptyString(delta?.messageId) ??
    nonEmptyString(delta?.id) ??
    nonEmptyString(assistantEvent?.messageId);
  return id === undefined
    ? `live-assistant-${sequence}`
    : safeEntryId(id, `live-assistant-${sequence}`);
}

export function createChildOverlayController(
  source: ChildOverlaySourcePort,
  config?: ChildOverlayConfig,
  mutations?: ChildOverlayMutationPort,
): ChildOverlayController {
  return new ChildOverlayController(source, config, mutations);
}

// ---------------------------------------------------------------------------
// Native custom component (Task 12 phase B1)
// ---------------------------------------------------------------------------

/** Rows Pi keeps for its own footer, status, and padding around the overlay. */
const OVERLAY_RESERVED_HOST_ROWS = 6;

export interface PiChildOverlayCustomComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}

function isOverlayFallbackRequired(
  error: ChildOverlayError,
): error is ChildOverlayFallbackRequired {
  return "kind" in error && error.kind === "fallback-required";
}

/**
 * Builds the Spec 33 §7 full-screen overlay as a Pi `ui.custom` component.
 *
 * One component wraps one {@link ChildOverlayController}. Escape closes only
 * this overlay. Renderer/theme/source failures emit typed fallback once and
 * never throw into Pi. Input never reaches a primary-editor callback.
 */
export function createChildOverlayCustomComponent(
  tui: TUI & { readonly width?: number; requestRender(): void },
  theme: EditorTheme,
  keybindings: ConstructorParameters<typeof CustomEditor>[2],
  controller: ChildOverlayController,
  done: () => void,
  onFallback: (fallback: ChildOverlayFallbackRequired) => void,
  nativeDeps?: Omit<PiNativeTranscriptComponentDeps, "tui">,
  /**
   * Task 13 owns the keyboard first. Anything it consumes never reaches the
   * Task 12 input path below, and nothing here ever forwards a key to Pi or
   * the primary editor while the overlay is mounted.
   */
  keyInterceptor?: PiChildOverlayKeyInterceptor,
): PiChildOverlayCustomComponent {
  const draftEditor = new CustomEditor(tui, theme, keybindings);
  const transcriptRenderer = createPiChildTranscriptRenderer();
  let componentFactory: PiTranscriptComponentFactory | undefined;
  let dirty = true;
  let lines: string[] = [];
  let lastWidth = -1;
  let finished = false;
  let fallbackEmitted = false;
  let inputBusy = false;

  const finish = (): void => {
    if (finished) return;
    finished = true;
    Result.fromThrowable(
      () => {
        done();
      },
      () => "overlay_done_failed" as const,
    )().match(
      () => undefined,
      () => undefined,
    );
  };

  const emitFallback = (
    reason: ChildOverlayFallbackReason | ChildOverlayFallbackRequired,
  ): void => {
    if (fallbackEmitted) return;
    fallbackEmitted = true;
    const payload =
      typeof reason === "string" ? controller.requireFallback(reason) : reason;
    Result.fromThrowable(
      () => {
        onFallback(payload);
      },
      () => "overlay_fallback_callback_failed" as const,
    )().match(
      () => undefined,
      () => undefined,
    );
    finish();
  };

  const factory = (): PiTranscriptComponentFactory => {
    componentFactory ??= createPiNativeTranscriptComponentFactory({
      ...nativeDeps,
      cwd: nativeDeps?.cwd ?? ".",
      tui,
    });
    return componentFactory;
  };

  const visibleHeight = (): number => {
    const rows = Result.fromThrowable(
      () => tui.terminal?.rows,
      () => "terminal_rows_unavailable" as const,
    )().unwrapOr(undefined);
    const usable = typeof rows === "number" && rows > 0 ? rows : 40;
    return Math.max(8, usable - OVERLAY_RESERVED_HOST_ROWS);
  };

  const syncDraftEditor = (view: ChildOverlayView): void => {
    if (view.readOnly) {
      if (draftEditor.getText() !== "") draftEditor.setText("");
      return;
    }
    if (draftEditor.getText() !== view.draft) draftEditor.setText(view.draft);
  };

  const renderEditorLines = (width: number, readOnly: boolean): string[] => {
    if (readOnly) return [];
    const rendered = Result.fromThrowable(
      () => draftEditor.render(width),
      () => "editor_render_failed" as const,
    )().unwrapOr([]);
    return Array.isArray(rendered) && rendered.length > 0
      ? rendered
      : [`> ${draftEditor.getText()}`];
  };

  const headerLines = (view: ChildOverlayView, width: number): string[] => {
    const title = view.child.title ?? view.child.childId;
    const status = view.child.status.toUpperCase();
    const run =
      view.activeRun !== undefined ? `run ${view.activeRun}` : undefined;
    const branch =
      view.activeBranchId !== undefined
        ? `branch ${view.activeBranchId}`
        : undefined;
    const meta = [run, branch].filter((part) => part !== undefined).join(" · ");
    const header = [
      boundText(`◆ ${title} · ${status}`),
      ...(meta.length > 0 ? [boundText(meta)] : []),
    ];
    if (view.readOnly) {
      header.push(
        boundText(
          view.child.status === "orphan"
            ? "Read-only orphan — mutations disabled"
            : "Read-only — settled child",
        ),
      );
    }
    if (view.searchQuery.length > 0) {
      header.push(
        boundText(
          `Search: ${view.searchQuery} (${view.searchMatches.length} match${view.searchMatches.length === 1 ? "" : "es"})`,
        ),
      );
    }
    header.push("─".repeat(Math.min(width, 40)));
    return header;
  };

  const renderTranscriptLines = (
    view: ChildOverlayView,
    width: number,
  ): Result<readonly string[], ChildOverlayFallbackRequired> => {
    return Result.fromThrowable(
      () => {
        const rendered = transcriptRenderer.render(view.transcript, width, {
          componentFactory: factory(),
        });
        if (rendered.lines.length > 0) return rendered.lines;
        // Native factory may suppress bookkeeping rows; fall back to overlay
        // entry text so kinds remain visible in the bounded window.
        return view.entries.map((entry) =>
          boundText(
            entry.expanded || entry.text.length <= 120
              ? `[${entry.kind}] ${entry.text}`
              : `[${entry.kind}] ${entry.text.slice(0, 117)}…`,
          ),
        );
      },
      (): ChildOverlayFallbackRequired =>
        controller.requireFallback("render-failed"),
    )();
  };

  const requestPaint = (): void => {
    dirty = true;
    Result.fromThrowable(
      () => {
        tui.requestRender();
      },
      () => "overlay_request_render_failed" as const,
    )().match(
      () => undefined,
      () => undefined,
    );
  };

  const afterControllerOutcome = (
    outcome: Result<ChildOverlayInputOutcome, ChildOverlayError>,
  ): void => {
    if (outcome.isErr()) {
      if (isOverlayFallbackRequired(outcome.error)) {
        emitFallback(outcome.error);
        return;
      }
      emitFallback("source-failed");
      return;
    }
    if (outcome.value.kind === "fallback-required") {
      emitFallback(outcome.value);
      return;
    }
    const view = controller.view();
    if (view.isOk()) syncDraftEditor(view.value);
    requestPaint();
  };

  const handlePaginationEdge = (
    data: string,
  ): ResultAsync<void, ChildOverlayError> => {
    const viewResult = controller.view();
    if (viewResult.isErr()) return errAsync(viewResult.error);
    const view = viewResult.value;
    if (data === SCROLL_KEYS.pageUp && view.hasOlder) {
      const nearOldest =
        view.scrollOffset >= Math.max(0, view.entries.length - 1);
      if (nearOldest || view.entries.length === 0) {
        return controller.loadOlder().map(() => undefined);
      }
    }
    if (
      (data === SCROLL_KEYS.pageDown || data === SCROLL_KEYS.end) &&
      view.hasNewer &&
      (view.liveTail || view.scrollOffset === 0)
    ) {
      return controller.loadNewer().map(() => undefined);
    }
    return okAsync(undefined);
  };

  return {
    render(width) {
      return Result.fromThrowable(
        (): string[] => {
          if (finished) return lines;
          const resized = controller.resize(width, visibleHeight());
          if (resized.isErr()) {
            if (isOverlayFallbackRequired(resized.error)) {
              emitFallback(resized.error);
            } else if (
              !("type" in resized.error) ||
              resized.error.type !== "OverlayNotOpen"
            ) {
              emitFallback("render-failed");
            }
            return lines;
          }
          const view = resized.value;
          if (dirty || width !== lastWidth) {
            syncDraftEditor(view);
            const header = headerLines(view, width);
            const editorLines = renderEditorLines(width, view.readOnly);
            const transcript = renderTranscriptLines(view, width);
            if (transcript.isErr()) {
              emitFallback(transcript.error);
              return lines;
            }
            const budget = Math.max(
              1,
              visibleHeight() - editorLines.length - header.length - 1,
            );
            const scrollMax = Math.max(0, transcript.value.length - budget);
            const scrollOffset = Math.min(view.scrollOffset, scrollMax);
            const end = transcript.value.length - scrollOffset;
            lines = [
              ...header,
              ...transcript.value.slice(Math.max(0, end - budget), end),
              ...(scrollOffset > 0
                ? [
                    boundText(
                      `${scrollOffset} newer line(s) below — End follows output`,
                    ),
                  ]
                : []),
              ...editorLines,
            ];
            dirty = false;
            lastWidth = width;
          }
          return lines;
        },
        (): string[] => {
          emitFallback("render-failed");
          return lines;
        },
      )().unwrapOr(lines);
    },
    handleInput(data) {
      if (finished || inputBusy) return;
      Result.fromThrowable(
        () => {
          if (keyInterceptor !== undefined) {
            const consumed = Result.fromThrowable(
              () => keyInterceptor(data),
              () => "overlay_key_interceptor_failed" as const,
              // A failing interceptor must not leak the key onward, so an
              // exception is treated as "consumed" rather than "ignored".
            )().unwrapOr(true);
            if (consumed) return;
          } else if (
            keybindings.matches(data, "tui.select.cancel") ||
            data === "\x1b"
          ) {
            // Without Task 13 mounted, Escape keeps its Task 12 meaning.
            finish();
            return;
          }
          inputBusy = true;
          void handlePaginationEdge(data)
            .andThen(() => controller.handleInput(data))
            .match(
              (value) => {
                inputBusy = false;
                afterControllerOutcome(ok(value));
              },
              (error) => {
                inputBusy = false;
                afterControllerOutcome(err(error));
              },
            );
        },
        () => "overlay_input_failed" as const,
      )().match(
        () => undefined,
        () => {
          inputBusy = false;
          emitFallback("render-failed");
        },
      );
    },
    invalidate() {
      dirty = true;
    },
  };
}

/** Re-export transcript entry type for handoff consumers. */
export type { PiChildTranscriptEntry, PiChildTranscriptState };
