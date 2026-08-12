import { err, ok, Result } from "neverthrow";
import {
  historicalProviderErrorFacts,
  type PiChildProviderError,
} from "./child-provider-error.js";
import { formatPiChildProviderError } from "./child-provider-error-render.js";
import type { PiChildSessionEvent } from "./child-session-events.js";
/** Maximum size of one private transcript event, measured as UTF-8 JSON bytes. */
export const MAX_TRANSCRIPT_HISTORY_EVENT_BYTES = 2 * 1024 * 1024;
/** Maximum total bytes retained by the in-memory event history. */
export const MAX_TRANSCRIPT_HISTORY_BYTES = 8 * 1024 * 1024;
export const MAX_TRANSCRIPT_ENTRIES = 4_096;
export const MAX_TRANSCRIPT_INPUT_BYTES = 64 * 1024;

const DEFAULT_BRANCH_ID = "main";
const KNOWN_TOOL_NAMES = new Set([
  "bash",
  "edit",
  "find",
  "glob",
  "grep",
  "ls",
  "question",
  "read",
  "search",
  "task",
  "web_fetch",
  "web_search",
  "write",
]);

export type PiChildTranscriptError =
  | {
      readonly type: "TranscriptInputTooLarge";
      readonly operation: string;
    }
  | {
      readonly type: "TranscriptEventTooLarge";
      readonly operation: string;
    }
  | {
      readonly type: "TranscriptEventNotCloneable";
      readonly operation: string;
    }
  | {
      readonly type: "TranscriptCapacityExceeded";
      readonly operation: string;
    }
  | {
      readonly type: "TranscriptEntryNotFound";
      readonly operation: string;
    }
  | {
      readonly type: "TranscriptBranchNotFound";
      readonly operation: string;
    }
  | {
      readonly type: "TranscriptInvalidAction";
      readonly operation: string;
    };

export interface PiChildTranscriptVisibility {
  readonly expanded: boolean;
  readonly thinkingVisible: boolean;
  readonly imagesVisible: boolean;
}

export interface PiChildTranscriptBaseEntry
  extends PiChildTranscriptVisibility {
  readonly id: string;
  readonly sequence: number;
  readonly branchId: string;
  readonly eventTypes: readonly PiChildSessionEvent["type"][];
  /**
   * Stable identity of the overlay entry that produced this transcript entry,
   * when the caller replayed one. One overlay entry can fan out into several
   * transcript entries (an assistant message plus its tool calls), so this is
   * the only id that means the same thing in both the compact and the full
   * layout. Absent for live transcripts that were never replayed from overlay
   * entries.
   */
  readonly overlayEntryId?: string;
}

export interface PiChildTranscriptInputEntry
  extends PiChildTranscriptBaseEntry {
  readonly kind: "task" | "steering" | "follow_up";
  readonly text: string;
  readonly queued: boolean;
}

export interface PiChildTranscriptAssistantEntry
  extends PiChildTranscriptBaseEntry {
  readonly kind: "assistant";
  readonly messageId: string;
  readonly text: string;
  readonly thinking: string;
  readonly markdown: string;
  readonly streaming: boolean;
  readonly stopReason?: string;
  readonly terminalError?: PiChildProviderError;
  readonly usage?: PiChildTranscriptUsage;
  readonly imageIds: readonly string[];
}

export interface PiChildTranscriptToolEntry extends PiChildTranscriptBaseEntry {
  readonly kind: "tool";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly knownTool: boolean;
  readonly argumentsKnown: boolean;
  readonly arguments?: unknown;
  readonly partialResults: readonly unknown[];
  readonly result?: unknown;
  readonly error?: string;
  readonly imageIds: readonly string[];
  readonly state: "placeholder" | "called" | "partial" | "result" | "error";
}

export interface PiChildTranscriptTextEntry extends PiChildTranscriptBaseEntry {
  readonly kind: "text" | "thinking" | "markdown";
  readonly text: string;
}

export interface PiChildTranscriptImageEntry
  extends PiChildTranscriptBaseEntry {
  readonly kind: "image";
  readonly imageId: string;
  readonly data?: string;
  readonly mimeType?: string;
  readonly source?: unknown;
}

export interface PiChildTranscriptUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cost?: number;
  readonly [key: string]: unknown;
}

export interface PiChildTranscriptUsageEntry
  extends PiChildTranscriptBaseEntry {
  readonly kind: "usage";
  readonly usage: PiChildTranscriptUsage;
}

export interface PiChildTranscriptQueueEntry
  extends PiChildTranscriptBaseEntry {
  readonly kind: "queue";
  readonly queue: readonly unknown[];
  readonly size: number;
}

export interface PiChildTranscriptStatusEntry
  extends PiChildTranscriptBaseEntry {
  readonly kind: "status";
  readonly status: string;
  readonly message?: string;
}

export interface PiChildTranscriptRetryEntry
  extends PiChildTranscriptBaseEntry {
  readonly kind: "retry";
  readonly attempt?: number;
  readonly reason?: string;
}

export interface PiChildTranscriptExtensionUiEntry
  extends PiChildTranscriptBaseEntry {
  readonly kind: "extension_ui";
  readonly requestType: "notification" | "widget" | "dialog";
  readonly requestId: string;
  readonly message?: string;
  readonly widget?: unknown;
  readonly dialog?: unknown;
}

export interface PiChildTranscriptUnknownEntry
  extends PiChildTranscriptBaseEntry {
  readonly kind: "unknown";
  readonly originalType: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export type PiChildTranscriptEntry =
  | PiChildTranscriptInputEntry
  | PiChildTranscriptAssistantEntry
  | PiChildTranscriptToolEntry
  | PiChildTranscriptTextEntry
  | PiChildTranscriptImageEntry
  | PiChildTranscriptUsageEntry
  | PiChildTranscriptQueueEntry
  | PiChildTranscriptStatusEntry
  | PiChildTranscriptRetryEntry
  | PiChildTranscriptExtensionUiEntry
  | PiChildTranscriptUnknownEntry;

/** The exact bounded event retained for private local inspection. */
export interface PiChildTranscriptHistoryEvent {
  readonly sequence: number;
  readonly byteLength: number;
  readonly event: PiChildSessionEvent;
}

export interface PiChildTranscriptBranch {
  readonly id: string;
  readonly order: number;
}

export interface PiChildTranscriptState {
  readonly nextSequence: number;
  readonly entries: readonly PiChildTranscriptEntry[];
  readonly historyEvents: readonly PiChildTranscriptHistoryEvent[];
  readonly historyBytes: number;
  readonly historyTrimmedCount: number;
  readonly branchOrder: readonly PiChildTranscriptBranch[];
  readonly selectedBranchId: string;
  readonly activeMessageId?: string;
  readonly selectedMessageId?: string;
  readonly usage: PiChildTranscriptUsage;
  readonly queue: readonly unknown[];
  readonly status?: string;
  readonly statusMessage?: string;
  readonly retry?: { readonly attempt?: number; readonly reason?: string };
  readonly extensionUi: readonly PiChildTranscriptExtensionUiEntry[];
}

export type PiChildTranscriptAction =
  | {
      readonly kind: "event";
      readonly event: PiChildSessionEvent;
      readonly overlayEntryId?: string;
    }
  | {
      readonly kind: "task";
      readonly text: string;
      readonly overlayEntryId?: string;
    }
  | {
      readonly kind: "steering";
      readonly text: string;
      readonly overlayEntryId?: string;
    }
  | {
      readonly kind: "follow_up";
      readonly text: string;
      readonly overlayEntryId?: string;
    }
  | { readonly kind: "toggle_expanded"; readonly entryId: string }
  | {
      readonly kind: "set_thinking_visible";
      readonly entryId: string;
      readonly visible: boolean;
    }
  | {
      readonly kind: "set_images_visible";
      readonly entryId: string;
      readonly visible: boolean;
    }
  | { readonly kind: "select_branch"; readonly branchId: string }
  | { readonly kind: "select_message"; readonly messageId: string };

export const EMPTY_PI_CHILD_TRANSCRIPT_STATE: PiChildTranscriptState = {
  nextSequence: 0,
  entries: [],
  historyEvents: [],
  historyBytes: 0,
  historyTrimmedCount: 0,
  branchOrder: [{ id: DEFAULT_BRANCH_ID, order: 0 }],
  selectedBranchId: DEFAULT_BRANCH_ID,
  usage: {},
  queue: [],
  extensionUi: [],
};

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): RecordValue | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function boundedText(value: string): boolean {
  return (
    new TextEncoder().encode(value).byteLength <= MAX_TRANSCRIPT_INPUT_BYTES
  );
}

function messageIdFrom(value: unknown): string | undefined {
  const record = recordValue(value);
  if (record === undefined) return undefined;
  return stringValue(record.messageId) ?? stringValue(record.id);
}

function toolIdFrom(value: unknown): string | undefined {
  const record = recordValue(value);
  if (record === undefined) return undefined;
  return stringValue(record.toolCallId) ?? stringValue(record.id);
}

/**
 * Concatenates the text of a pi-ai content-block array.
 *
 * Real Pi 0.84 `AssistantMessage.content` is a block array, not a string, so a
 * terminal `message_end` carries its final text here. The array is already
 * bounded by the session-event parser, so this walk is bounded too.
 */
function contentBlocksText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  let text = "";
  for (const block of value) {
    if (typeof block === "string") {
      text += block;
      continue;
    }
    const record = recordValue(block);
    if (record === undefined) continue;
    const blockText = stringValue(record.text);
    if (blockText !== undefined) text += blockText;
  }
  return text.length > 0 ? text : undefined;
}

function messageText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const blocks = contentBlocksText(value);
  if (blocks !== undefined) return blocks;
  const record = recordValue(value);
  if (record === undefined) return undefined;
  return (
    stringValue(record.text) ??
    stringValue(record.delta) ??
    stringValue(record.content) ??
    contentBlocksText(record.content)
  );
}

function messageUpdateParts(event: PiChildSessionEvent): {
  readonly messageId?: string;
  readonly text?: string;
  readonly thinking?: string;
  readonly markdown?: string;
} {
  const eventRecord = event as unknown as RecordValue;
  const delta = recordValue(eventRecord.delta);
  const assistantEvent = recordValue(eventRecord.assistantMessageEvent);
  const messageId = messageIdFrom(delta) ?? messageIdFrom(assistantEvent);
  const assistantType = stringValue(assistantEvent?.type);
  const text =
    stringValue(delta?.text) ??
    (assistantType === "text_delta"
      ? stringValue(assistantEvent?.delta)
      : undefined);
  const thinking =
    stringValue(delta?.thinking) ??
    (assistantType === "thinking_delta"
      ? stringValue(assistantEvent?.delta)
      : undefined);
  const markdown =
    stringValue(delta?.markdown) ??
    (assistantType === "markdown" || assistantType === "markdown_delta"
      ? stringValue(assistantEvent?.delta)
      : undefined);
  return { messageId, text, thinking, markdown };
}

function usageValue(value: unknown): PiChildTranscriptUsage {
  return isRecord(value) ? { ...value } : {};
}

function mergeUsage(
  current: PiChildTranscriptUsage,
  update: PiChildTranscriptUsage,
): PiChildTranscriptUsage {
  const result: Record<string, unknown> = { ...current, ...update };
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "cost",
  ]) {
    const next = numberValue(update[key]);
    if (next !== undefined) result[key] = next;
  }
  return result;
}

function visibility(): PiChildTranscriptVisibility {
  return { expanded: false, thinkingVisible: true, imagesVisible: true };
}

function baseEntry(
  id: string,
  sequence: number,
  branchId: string,
  eventType: PiChildSessionEvent["type"] | undefined,
): PiChildTranscriptBaseEntry {
  return {
    id,
    sequence,
    branchId,
    eventTypes: eventType === undefined ? [] : [eventType],
    ...visibility(),
  };
}

function addEventType<T extends PiChildTranscriptEntry>(
  entry: T,
  eventType: PiChildSessionEvent["type"],
): T {
  if (entry.eventTypes.includes(eventType)) return entry;
  return { ...entry, eventTypes: [...entry.eventTypes, eventType] } as T;
}

function cloneAndMeasureEvent(
  event: PiChildSessionEvent,
): Result<
  { readonly event: PiChildSessionEvent; readonly byteLength: number },
  PiChildTranscriptError
> {
  const serialized = Result.fromThrowable(
    () => JSON.stringify(event),
    () =>
      ({
        type: "TranscriptEventNotCloneable",
        operation: "apply_event",
      }) as const,
  )();
  if (serialized.isErr() || serialized.value === undefined)
    return err({
      type: "TranscriptEventNotCloneable",
      operation: "apply_event",
    });
  const byteLength = new TextEncoder().encode(serialized.value).byteLength;
  if (byteLength > MAX_TRANSCRIPT_HISTORY_EVENT_BYTES)
    return err({ type: "TranscriptEventTooLarge", operation: "apply_event" });
  const cloned = Result.fromThrowable(
    () => structuredClone(event) as PiChildSessionEvent,
    () =>
      ({
        type: "TranscriptEventNotCloneable",
        operation: "apply_event",
      }) as const,
  )();
  return cloned.map((value) => ({ event: value, byteLength }));
}

function appendHistory(
  state: PiChildTranscriptState,
  event: PiChildSessionEvent,
  sequence: number,
): Result<
  Pick<
    PiChildTranscriptState,
    "historyEvents" | "historyBytes" | "historyTrimmedCount"
  >,
  PiChildTranscriptError
> {
  const measured = cloneAndMeasureEvent(event);
  if (measured.isErr()) return err(measured.error);
  const next: PiChildTranscriptHistoryEvent = {
    sequence,
    byteLength: measured.value.byteLength,
    event: measured.value.event,
  };
  const history = [...state.historyEvents, next];
  let historyBytes = state.historyBytes + next.byteLength;
  let historyTrimmedCount = state.historyTrimmedCount;
  while (historyBytes > MAX_TRANSCRIPT_HISTORY_BYTES && history.length > 1) {
    const removed = history.shift();
    historyBytes -= removed?.byteLength ?? 0;
    historyTrimmedCount += 1;
  }
  return ok({ historyEvents: history, historyBytes, historyTrimmedCount });
}

function nextEntryId(
  _state: PiChildTranscriptState,
  prefix: string,
  sequence: number,
): string {
  return `${prefix}-${sequence}`;
}

function registerBranch(
  state: PiChildTranscriptState,
  branchId: string,
): Pick<PiChildTranscriptState, "branchOrder"> {
  if (state.branchOrder.some((branch) => branch.id === branchId))
    return { branchOrder: state.branchOrder };
  return {
    branchOrder: [
      ...state.branchOrder,
      { id: branchId, order: state.branchOrder.length },
    ],
  };
}

function assistantEntryIndex(
  entries: readonly PiChildTranscriptEntry[],
  messageId: string | undefined,
): number {
  if (messageId === undefined) return -1;
  return entries.findIndex(
    (entry) => entry.kind === "assistant" && entry.messageId === messageId,
  );
}

function lastToolIndex(entries: readonly PiChildTranscriptEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1)
    if (entries[index]?.kind === "tool") return index;
  return -1;
}

function makeInputEntry(
  state: PiChildTranscriptState,
  kind: "task" | "steering" | "follow_up",
  text: string,
  sequence: number,
): PiChildTranscriptEntry {
  const base = baseEntry(
    nextEntryId(state, kind, sequence),
    sequence,
    state.selectedBranchId,
    undefined,
  );
  return {
    ...base,
    kind,
    text,
    queued: kind === "follow_up",
  } as PiChildTranscriptInputEntry;
}

function toolState(
  eventType: PiChildSessionEvent["type"],
): PiChildTranscriptToolEntry["state"] {
  if (eventType === "tool_call") return "called";
  if (eventType === "tool_partial_result") return "partial";
  if (eventType === "tool_result") return "result";
  return "error";
}

function withUpdatedEntry(
  state: PiChildTranscriptState,
  index: number,
  entry: PiChildTranscriptEntry,
): PiChildTranscriptState {
  const entries = [...state.entries];
  entries[index] = entry;
  return { ...state, entries };
}

function addEntry(
  state: PiChildTranscriptState,
  entry: PiChildTranscriptEntry,
): Result<PiChildTranscriptState, PiChildTranscriptError> {
  if (state.entries.length >= MAX_TRANSCRIPT_ENTRIES)
    return err({
      type: "TranscriptCapacityExceeded",
      operation: "append_entry",
    });
  return ok({ ...state, entries: [...state.entries, entry] });
}

function applyEventBody(
  state: PiChildTranscriptState,
  event: PiChildSessionEvent,
  sequence: number,
): Result<PiChildTranscriptState, PiChildTranscriptError> {
  const history = appendHistory(state, event, sequence);
  if (history.isErr()) return err(history.error);
  let next: PiChildTranscriptState = { ...state, ...history.value };
  const eventType = event.type;

  if (eventType === "message_start") {
    const message = recordValue(event.message);
    const messageId =
      messageIdFrom(message) ?? nextEntryId(next, "assistant", sequence);
    const branchId = stringValue(message?.branchId) ?? next.selectedBranchId;
    const entry: PiChildTranscriptAssistantEntry = {
      ...baseEntry(messageId, sequence, branchId, eventType),
      kind: "assistant",
      messageId,
      text: messageText(message?.text) ?? messageText(message?.content) ?? "",
      thinking: "",
      markdown: "",
      streaming: true,
      usage: undefined,
      imageIds: [],
    };
    const added = addEntry(next, entry);
    if (added.isErr()) return added;
    return ok({
      ...added.value,
      ...registerBranch(added.value, branchId),
      activeMessageId: messageId,
      selectedMessageId: added.value.selectedMessageId ?? messageId,
    });
  }

  if (eventType === "message_update" || eventType === "message_end") {
    const eventRecord = event as unknown as RecordValue;
    const parts =
      eventType === "message_update" ? messageUpdateParts(event) : {};
    const message =
      eventType === "message_end"
        ? recordValue(eventRecord.message)
        : undefined;
    const messageId =
      messageIdFrom(message) ?? parts.messageId ?? next.activeMessageId;
    let index = assistantEntryIndex(next.entries, messageId);
    if (index < 0) {
      const placeholderId =
        messageId ?? nextEntryId(next, "assistant-placeholder", sequence);
      const placeholder: PiChildTranscriptAssistantEntry = {
        ...baseEntry(placeholderId, sequence, next.selectedBranchId, eventType),
        kind: "assistant",
        messageId: placeholderId,
        text: "",
        thinking: "",
        markdown: "",
        streaming: true,
        imageIds: [],
      };
      const added = addEntry(next, placeholder);
      if (added.isErr()) return added;
      next = added.value;
      index = next.entries.length - 1;
    }
    const current = next.entries[index];
    if (current?.kind !== "assistant")
      return err({
        type: "TranscriptInvalidAction",
        operation: "merge_assistant_update",
      });
    const terminalText =
      messageText(message?.text) ?? messageText(message?.content);
    const terminalFacts =
      eventType === "message_end"
        ? historicalProviderErrorFacts(message)
        : undefined;
    let terminalError = current.terminalError;
    if (eventType === "message_end") {
      terminalError = undefined;
      next = {
        ...next,
        entries: next.entries.map((entry) =>
          entry.kind === "assistant" && entry.stopReason === "error"
            ? { ...entry, stopReason: undefined, terminalError: undefined }
            : entry,
        ),
      };
    }
    if (terminalFacts?.stopReason === "error") {
      terminalError = terminalFacts.providerError;
    }
    const updated: PiChildTranscriptAssistantEntry = {
      ...addEventType(current, eventType),
      text:
        eventType === "message_end" && terminalText !== undefined
          ? terminalText
          : current.text + (parts.text ?? ""),
      thinking: current.thinking + (parts.thinking ?? ""),
      markdown: current.markdown + (parts.markdown ?? ""),
      streaming: eventType !== "message_end",
      stopReason:
        terminalFacts?.stopReason ??
        stringValue(message?.stopReason) ??
        current.stopReason,
      terminalError,
      messageId: current.messageId,
    };
    next = withUpdatedEntry(next, index, updated);
    return ok({
      ...next,
      activeMessageId: current.messageId,
      selectedMessageId: next.selectedMessageId ?? current.messageId,
    });
  }

  if (
    eventType === "text" ||
    eventType === "thinking" ||
    eventType === "markdown"
  ) {
    const eventRecord = event as unknown as RecordValue;
    const text = stringValue(eventRecord.text) ?? "";
    const entry: PiChildTranscriptTextEntry = {
      ...baseEntry(
        nextEntryId(next, eventType, sequence),
        sequence,
        next.selectedBranchId,
        eventType,
      ),
      kind: eventType,
      text,
    };
    return addEntry(next, entry);
  }

  if (
    eventType === "tool_call" ||
    eventType === "tool_partial_result" ||
    eventType === "tool_result" ||
    eventType === "tool_error"
  ) {
    const eventRecord = event as unknown as RecordValue;
    const toolId =
      toolIdFrom(eventRecord) ??
      (lastToolIndex(next.entries) >= 0
        ? (
            next.entries[
              lastToolIndex(next.entries)
            ] as PiChildTranscriptToolEntry
          ).toolCallId
        : undefined) ??
      nextEntryId(next, "tool-placeholder", sequence);
    let index = next.entries.findIndex(
      (entry) => entry.kind === "tool" && entry.toolCallId === toolId,
    );
    if (index < 0) {
      const toolName =
        stringValue(eventRecord.toolName) ??
        stringValue(eventRecord.name) ??
        "unknown tool";
      const placeholder: PiChildTranscriptToolEntry = {
        ...baseEntry(
          nextEntryId(next, "tool", sequence),
          sequence,
          next.selectedBranchId,
          eventType,
        ),
        kind: "tool",
        toolCallId: toolId,
        toolName,
        knownTool: KNOWN_TOOL_NAMES.has(toolName),
        argumentsKnown:
          eventType === "tool_call" && eventRecord.arguments !== undefined,
        arguments:
          eventType === "tool_call" ? eventRecord.arguments : undefined,
        partialResults:
          eventType === "tool_partial_result"
            ? [eventRecord.partialResult ?? eventRecord.content]
            : [],
        result:
          eventType === "tool_result"
            ? (eventRecord.result ?? eventRecord.content)
            : undefined,
        error:
          eventType === "tool_error"
            ? (stringValue(eventRecord.error) ??
              stringValue(eventRecord.message))
            : undefined,
        imageIds: [],
        state: toolState(eventType),
      };
      const added = addEntry(next, placeholder);
      if (added.isErr()) return added;
      next = added.value;
      index = next.entries.length - 1;
    } else {
      const current = next.entries[index];
      if (current?.kind !== "tool")
        return err({
          type: "TranscriptInvalidAction",
          operation: "merge_tool_event",
        });
      const updated: PiChildTranscriptToolEntry = {
        ...addEventType(current, eventType),
        toolName: stringValue(eventRecord.toolName) ?? current.toolName,
        knownTool: KNOWN_TOOL_NAMES.has(
          stringValue(eventRecord.toolName) ?? current.toolName,
        ),
        argumentsKnown:
          eventType === "tool_call" && eventRecord.arguments !== undefined
            ? true
            : current.argumentsKnown,
        arguments:
          eventType === "tool_call" && eventRecord.arguments !== undefined
            ? eventRecord.arguments
            : current.arguments,
        partialResults:
          eventType === "tool_partial_result"
            ? [
                ...current.partialResults,
                eventRecord.partialResult ?? eventRecord.content,
              ]
            : current.partialResults,
        result:
          eventType === "tool_result"
            ? (eventRecord.result ?? eventRecord.content)
            : current.result,
        error:
          eventType === "tool_error"
            ? (stringValue(eventRecord.error) ??
              stringValue(eventRecord.message))
            : current.error,
        state: toolState(eventType),
      };
      next = withUpdatedEntry(next, index, updated);
    }
    return ok(next);
  }

  if (eventType === "image") {
    const imageId = nextEntryId(next, "image", sequence);
    const entry: PiChildTranscriptImageEntry = {
      ...baseEntry(imageId, sequence, next.selectedBranchId, eventType),
      kind: "image",
      imageId,
      data: stringValue((event as unknown as RecordValue).data),
      mimeType: stringValue((event as unknown as RecordValue).mimeType),
      source: (event as unknown as RecordValue).source,
    };
    return addEntry(next, entry);
  }

  if (eventType === "usage") {
    const usage = usageValue((event as unknown as RecordValue).usage);
    const entry: PiChildTranscriptUsageEntry = {
      ...baseEntry(
        nextEntryId(next, "usage", sequence),
        sequence,
        next.selectedBranchId,
        eventType,
      ),
      kind: "usage",
      usage,
    };
    const added = addEntry(next, entry);
    return added.map((value) => ({
      ...value,
      usage: mergeUsage(value.usage, usage),
    }));
  }

  if (eventType === "queue_change") {
    const eventRecord = event as unknown as RecordValue;
    const queue = Array.isArray(eventRecord.queue) ? eventRecord.queue : [];
    const entry: PiChildTranscriptQueueEntry = {
      ...baseEntry(
        nextEntryId(next, "queue", sequence),
        sequence,
        next.selectedBranchId,
        eventType,
      ),
      kind: "queue",
      queue,
      size: numberValue(eventRecord.size) ?? queue.length,
    };
    const added = addEntry(next, entry);
    return added.map((value) => ({ ...value, queue }));
  }

  if (eventType === "status") {
    const entry: PiChildTranscriptStatusEntry = {
      ...baseEntry(
        nextEntryId(next, "status", sequence),
        sequence,
        next.selectedBranchId,
        eventType,
      ),
      kind: "status",
      status:
        stringValue((event as unknown as RecordValue).status) ?? "unknown",
      message: stringValue((event as unknown as RecordValue).message),
    };
    const added = addEntry(next, entry);
    return added.map((value) => ({
      ...value,
      status: entry.status,
      statusMessage: entry.message,
    }));
  }

  if (eventType === "retry") {
    const entry: PiChildTranscriptRetryEntry = {
      ...baseEntry(
        nextEntryId(next, "retry", sequence),
        sequence,
        next.selectedBranchId,
        eventType,
      ),
      kind: "retry",
      attempt: numberValue((event as unknown as RecordValue).attempt),
      reason: stringValue((event as unknown as RecordValue).reason),
    };
    const added = addEntry(next, entry);
    return added.map((value) => ({
      ...value,
      retry: { attempt: entry.attempt, reason: entry.reason },
    }));
  }

  if (eventType === "extension_ui_request") {
    const entry: PiChildTranscriptExtensionUiEntry = {
      ...baseEntry(
        nextEntryId(next, "extension-ui", sequence),
        sequence,
        next.selectedBranchId,
        eventType,
      ),
      kind: "extension_ui",
      requestType: stringValue((event as unknown as RecordValue).requestType) as
        | "notification"
        | "widget"
        | "dialog",
      requestId:
        stringValue((event as unknown as RecordValue).requestId) ??
        "unknown-request",
      message: stringValue((event as unknown as RecordValue).message),
      widget: (event as unknown as RecordValue).widget,
      dialog: (event as unknown as RecordValue).dialog,
    };
    const added = addEntry(next, entry);
    return added.map((value) => ({
      ...value,
      extensionUi: [...value.extensionUi, entry],
    }));
  }

  const unknown = event as unknown as RecordValue;
  const entry: PiChildTranscriptUnknownEntry = {
    ...baseEntry(
      nextEntryId(next, "unknown", sequence),
      sequence,
      next.selectedBranchId,
      "unknown",
    ),
    kind: "unknown",
    originalType: stringValue(unknown.originalType) ?? "unknown",
    payload: isRecord(unknown.payload) ? unknown.payload : undefined,
  };
  return addEntry(next, entry);
}

function applyEvent(
  state: PiChildTranscriptState,
  event: PiChildSessionEvent,
  sequence: number,
): Result<PiChildTranscriptState, PiChildTranscriptError> {
  return applyEventBody(state, event, sequence).map((next) => ({
    ...next,
    nextSequence: sequence + 1,
  }));
}

/**
 * Bounded, non-mangling validation of a caller-supplied overlay entry
 * identity. Mirrors the overlay's own `OpaqueIdSchema` so a replayed id keeps
 * the exact bytes the overlay window holds; anything that is not an opaque id
 * (paths, whitespace, oversized values) is dropped instead of rewritten.
 */
const MAX_OVERLAY_ENTRY_ID_LENGTH = 256;
const OVERLAY_ENTRY_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;

function actionOverlayEntryId(
  action: PiChildTranscriptAction,
): string | undefined {
  if (
    action.kind !== "event" &&
    action.kind !== "task" &&
    action.kind !== "steering" &&
    action.kind !== "follow_up"
  )
    return undefined;
  const raw = action.overlayEntryId;
  if (raw === undefined) return undefined;
  if (raw.length === 0 || raw.length > MAX_OVERLAY_ENTRY_ID_LENGTH)
    return undefined;
  return OVERLAY_ENTRY_ID_PATTERN.test(raw) ? raw : undefined;
}

/**
 * Stamps the replayed overlay identity onto entries this action created.
 *
 * Entries that already existed keep the identity of the overlay entry that
 * created them, so a later `message_end` merged into an assistant entry never
 * re-labels it. Transcript entry ids, sequences and ordering are untouched.
 */
function stampOverlayEntryIdentity(
  previous: PiChildTranscriptState,
  next: PiChildTranscriptState,
  action: PiChildTranscriptAction,
): PiChildTranscriptState {
  const overlayEntryId = actionOverlayEntryId(action);
  if (overlayEntryId === undefined) return next;
  if (next.entries.length <= previous.entries.length) return next;
  const entries = next.entries.map((entry, index) =>
    index < previous.entries.length || entry.overlayEntryId !== undefined
      ? entry
      : ({ ...entry, overlayEntryId } as PiChildTranscriptEntry),
  );
  return { ...next, entries };
}

function applyAction(
  state: PiChildTranscriptState,
  action: PiChildTranscriptAction,
): Result<PiChildTranscriptState, PiChildTranscriptError> {
  const sequence = state.nextSequence;
  if (action.kind === "event") return applyEvent(state, action.event, sequence);
  if (
    action.kind === "task" ||
    action.kind === "steering" ||
    action.kind === "follow_up"
  ) {
    if (!boundedText(action.text))
      return err({ type: "TranscriptInputTooLarge", operation: action.kind });
    const added = addEntry(
      state,
      makeInputEntry(state, action.kind, action.text, sequence),
    );
    return added.map((next) => ({ ...next, nextSequence: sequence + 1 }));
  }
  if (action.kind === "select_branch") {
    if (!state.branchOrder.some((branch) => branch.id === action.branchId))
      return err({
        type: "TranscriptBranchNotFound",
        operation: "select_branch",
      });
    return ok({ ...state, selectedBranchId: action.branchId });
  }
  if (action.kind === "select_message") {
    if (assistantEntryIndex(state.entries, action.messageId) < 0)
      return err({
        type: "TranscriptEntryNotFound",
        operation: "select_message",
      });
    return ok({ ...state, selectedMessageId: action.messageId });
  }
  const index = state.entries.findIndex((entry) => entry.id === action.entryId);
  if (index < 0)
    return err({ type: "TranscriptEntryNotFound", operation: action.kind });
  const current = state.entries[index];
  let updated: PiChildTranscriptEntry = current;
  if (action.kind === "toggle_expanded")
    updated = { ...current, expanded: !current.expanded };
  if (action.kind === "set_thinking_visible")
    updated = { ...current, thinkingVisible: action.visible };
  if (action.kind === "set_images_visible")
    updated = { ...current, imagesVisible: action.visible };
  return ok(withUpdatedEntry(state, index, updated));
}

/** Pure, immutable transcript reducer. Every mutation returns a typed Result. */
export function reducePiChildTranscript(
  state: PiChildTranscriptState,
  action: PiChildTranscriptAction,
): Result<PiChildTranscriptState, PiChildTranscriptError> {
  return applyAction(state, action).map((next) =>
    stampOverlayEntryIdentity(state, next, action),
  );
}

export function createPiChildTranscriptState(): PiChildTranscriptState {
  return EMPTY_PI_CHILD_TRANSCRIPT_STATE;
}

/** Stateful facade for observers; it stores no host or renderer objects. */
export class PiChildTranscriptReducer {
  private currentState: PiChildTranscriptState;

  constructor(
    initialState: PiChildTranscriptState = createPiChildTranscriptState(),
  ) {
    this.currentState = initialState;
  }

  getState(): PiChildTranscriptState {
    return this.currentState;
  }

  apply(
    action: PiChildTranscriptAction,
  ): Result<PiChildTranscriptState, PiChildTranscriptError> {
    const result = reducePiChildTranscript(this.currentState, action);
    if (result.isOk()) this.currentState = result.value;
    return result;
  }

  applyEvent(
    event: PiChildSessionEvent,
  ): Result<PiChildTranscriptState, PiChildTranscriptError> {
    return this.apply({ kind: "event", event });
  }

  addTask(
    text: string,
  ): Result<PiChildTranscriptState, PiChildTranscriptError> {
    return this.apply({ kind: "task", text });
  }

  addSteering(
    text: string,
  ): Result<PiChildTranscriptState, PiChildTranscriptError> {
    return this.apply({ kind: "steering", text });
  }

  queueFollowUp(
    text: string,
  ): Result<PiChildTranscriptState, PiChildTranscriptError> {
    return this.apply({ kind: "follow_up", text });
  }

  toggleEntryExpanded(
    entryId: string,
  ): Result<PiChildTranscriptState, PiChildTranscriptError> {
    return this.apply({ kind: "toggle_expanded", entryId });
  }

  setThinkingVisible(
    entryId: string,
    visible: boolean,
  ): Result<PiChildTranscriptState, PiChildTranscriptError> {
    return this.apply({ kind: "set_thinking_visible", entryId, visible });
  }

  setImagesVisible(
    entryId: string,
    visible: boolean,
  ): Result<PiChildTranscriptState, PiChildTranscriptError> {
    return this.apply({ kind: "set_images_visible", entryId, visible });
  }

  selectBranch(
    branchId: string,
  ): Result<PiChildTranscriptState, PiChildTranscriptError> {
    return this.apply({ kind: "select_branch", branchId });
  }

  selectMessage(
    messageId: string,
  ): Result<PiChildTranscriptState, PiChildTranscriptError> {
    return this.apply({ kind: "select_message", messageId });
  }
}

/** Short alias for callers that prefer the domain name over the reducer name. */
export class PiChildTranscript extends PiChildTranscriptReducer {}

export type PiTranscriptState = PiChildTranscriptState;
export type PiTranscriptEntry = PiChildTranscriptEntry;
export type PiTranscriptError = PiChildTranscriptError;

/** Maximum width used by the dependency-free fallback renderer. */
export const MAX_PI_TRANSCRIPT_RENDER_WIDTH = 240;
/** Maximum number of visual lines retained for one rendered fact. */
export const MAX_PI_TRANSCRIPT_RENDER_LINES = 256;
/** Maximum length of any renderer-owned string. */
export const MAX_PI_TRANSCRIPT_RENDER_STRING = 16_384;

/** A stable, structured fallback row. One row owns one normalized transcript fact. */
export interface PiChildTranscriptRenderedRow {
  readonly id: string;
  readonly entryId: string;
  /**
   * Identity of the overlay entry this row belongs to, propagated from the
   * transcript entry. Consumers that must group rows the way the compact
   * layout groups entries key on this and fall back to {@link entryId}.
   */
  readonly overlayEntryId?: string;
  readonly factId: string;
  readonly sequence: number;
  readonly kind: PiChildTranscriptEntry["kind"];
  readonly lines: readonly string[];
  readonly provenance: "fallback" | "native";
}

/**
 * True when the row is the assistant stopReason=error fact that carries the
 * canonical provider-error projection. Tool call/result/error facts also end
 * in `:error` and must not match.
 */
export function isAssistantTerminalProviderErrorRow(
  row: Pick<PiChildTranscriptRenderedRow, "kind" | "factId">,
): boolean {
  return row.kind === "assistant" && row.factId.endsWith(":error");
}

export interface PiChildTranscriptRender {
  readonly rows: readonly PiChildTranscriptRenderedRow[];
  readonly lines: readonly string[];
  readonly width: number;
}

/** The narrow component contract shared by Pi's native UI and test ports. */
export interface PiTranscriptComponent {
  render(width: number): string[];
  invalidate(): void;
}

export type PiTranscriptComponentKind =
  | "task"
  | "user"
  | "steering"
  | "assistant"
  | "markdown"
  | "thinking"
  | "tool"
  | "image"
  | "usage"
  | "queue"
  | "status"
  | "retry"
  | "extension_ui"
  | "unknown";

/**
 * Structured, entry-shaped data for an injected native component. Native Pi
 * components need the transcript fact itself, not the fallback renderer's
 * prose, so every request carries the normalized payload for its kind.
 */
export type PiTranscriptComponentPayload =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "assistant";
      readonly text: string;
      readonly thinking: string;
      readonly markdown: string;
      readonly streaming: boolean;
      readonly stopReason?: string;
    }
  | {
      readonly type: "tool";
      readonly toolName: string;
      readonly toolCallId: string;
      readonly state: PiChildTranscriptToolEntry["state"];
      readonly knownTool: boolean;
      readonly argumentsKnown: boolean;
      readonly arguments?: unknown;
      readonly partialResults: readonly unknown[];
      readonly result?: unknown;
      readonly error?: string;
    }
  | { readonly type: "usage"; readonly usage: PiChildTranscriptUsage }
  | { readonly type: "queue"; readonly size: number }
  | {
      readonly type: "status";
      readonly status: string;
      readonly message?: string;
    }
  | {
      readonly type: "retry";
      readonly attempt?: number;
      readonly reason?: string;
    };

/**
 * Sanitized input for an injected native component. Image bytes and extension
 * UI payloads are deliberately not representable in this port.
 */
export interface PiTranscriptComponentRequest {
  readonly kind: PiTranscriptComponentKind;
  readonly entryId: string;
  readonly factId: string;
  readonly sequence: number;
  readonly content: string;
  readonly payload?: PiTranscriptComponentPayload;
  readonly streaming?: boolean;
  readonly toolName?: string;
  readonly knownToolDefinition?: unknown;
  readonly imageMetadata?: {
    readonly imageId: string;
    readonly mimeType?: string;
  };
  readonly extensionUiMetadata?: {
    readonly requestType: PiChildTranscriptExtensionUiEntry["requestType"];
    readonly requestId: string;
    readonly message?: string;
    readonly hasWidget: boolean;
    readonly hasDialog: boolean;
  };
  readonly theme?: unknown;
}

/** Injected Pi native component factory; it has no dependency on Pi internals. */
export interface PiTranscriptComponentFactory {
  create(request: PiTranscriptComponentRequest): PiTranscriptComponent;
  /**
   * Optional row filter. A factory returns `true` to drop a transcript fact
   * from the render entirely, which lets a harness view hide bookkeeping rows
   * the native harness never shows.
   */
  suppress?(request: PiTranscriptComponentRequest): boolean;
}

export interface PiTranscriptRenderOptions {
  readonly componentFactory?: PiTranscriptComponentFactory;
  readonly toolDefinitions?:
    | ReadonlyMap<string, unknown>
    | Readonly<Record<string, unknown>>;
  readonly theme?: unknown;
}

function stripTranscriptAnsi(value: string): string {
  let result = "";
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === 0x1b || code === 0x9b) {
      if (code === 0x1b && value.charCodeAt(index + 1) === 0x5d) {
        index += 2;
        while (index < value.length && value.charCodeAt(index) !== 0x07) {
          if (
            value.charCodeAt(index) === 0x1b &&
            value.charCodeAt(index + 1) === 0x5c
          ) {
            index += 2;
            break;
          }
          index += 1;
        }
        if (value.charCodeAt(index) === 0x07) index += 1;
      } else {
        index += code === 0x1b ? 2 : 1;
        while (index < value.length) {
          const terminator = value.charCodeAt(index);
          index += 1;
          if (terminator >= 0x40 && terminator <= 0x7e) break;
        }
      }
      continue;
    }
    if (code === 0x0a || code === 0x0d) {
      result += value[index];
      index += 1;
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
      index += 1;
      continue;
    }
    result += value[index];
    index += 1;
  }
  return result;
}

function codePointWidth(codePoint: number): number {
  if (
    codePoint === 0 ||
    codePoint < 32 ||
    (codePoint >= 0x7f && codePoint < 0xa0)
  )
    return 0;
  if (
    (codePoint >= 0x300 && codePoint <= 0x36f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) ||
    codePoint === 0x200d
  )
    return 0;
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2329 && codePoint <= 0x232a) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  )
    return 2;
  return 1;
}

function boundedTranscriptText(value: string): string {
  const clean = stripTranscriptAnsi(value);
  const codePoints = [...clean];
  if (codePoints.length <= MAX_PI_TRANSCRIPT_RENDER_STRING) return clean;
  return `${codePoints.slice(0, MAX_PI_TRANSCRIPT_RENDER_STRING - 1).join("")}…`;
}

function clipTranscriptLine(value: string, width: number): string {
  const clean = boundedTranscriptText(value);
  let result = "";
  let used = 0;
  for (const character of clean) {
    const characterWidth = codePointWidth(character.codePointAt(0) ?? 0);
    if (characterWidth > 0 && used + characterWidth > width) {
      if (result.length === 0) return width === 1 ? "?" : result;
      break;
    }
    result += character;
    used += characterWidth;
  }
  return result || (width === 1 ? "?" : "");
}

function wrapTranscriptText(value: string, width: number): string[] {
  const clean = boundedTranscriptText(value).replace(/\r\n?/g, "\n");
  const sourceLines = clean.split("\n");
  const result: string[] = [];
  for (const sourceLine of sourceLines) {
    if (sourceLine.length === 0) {
      result.push("");
      continue;
    }
    let remaining = sourceLine;
    while (
      remaining.length > 0 &&
      result.length < MAX_PI_TRANSCRIPT_RENDER_LINES
    ) {
      const piece = clipTranscriptLine(remaining, width);
      if (piece.length === 0) break;
      result.push(piece);
      const consumed = Math.max(1, [...piece].length);
      remaining = [...remaining].slice(consumed).join("");
    }
    if (remaining.length > 0) {
      const omitted = [...remaining].length;
      result.push(clipTranscriptLine(`…${omitted} characters omitted`, width));
      break;
    }
    if (result.length >= MAX_PI_TRANSCRIPT_RENDER_LINES) break;
  }
  if (result.length === 0) result.push("");
  if (result.length > MAX_PI_TRANSCRIPT_RENDER_LINES)
    result.length = MAX_PI_TRANSCRIPT_RENDER_LINES;
  return result.map((line) => clipTranscriptLine(line, width));
}

function renderWidth(width: number | undefined): number {
  if (width === undefined || !Number.isFinite(width)) return 80;
  return Math.max(
    1,
    Math.min(MAX_PI_TRANSCRIPT_RENDER_WIDTH, Math.floor(width)),
  );
}

function safeTranscriptIdentity(value: string): string {
  const clean = boundedTranscriptText(value).replace(
    /[^\p{L}\p{N}._:-]+/gu,
    "_",
  );
  return clean ? [...clean].slice(0, 256).join("") : "unknown";
}

function summarizeTranscriptValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): string {
  if (depth > 3) return "…";
  if (value === null) return "null";
  if (typeof value === "string")
    return JSON.stringify(boundedTranscriptText(value));
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (typeof value !== "object") return `[${typeof value}]`;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const shown = value
      .slice(0, 4)
      .map((item) => summarizeTranscriptValue(item, depth + 1, seen));
    return `[${shown.join(", ")}${value.length > shown.length ? `, …+${value.length - shown.length}` : ""}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const shown = keys
    .slice(0, 4)
    .map(
      (key) =>
        `${safeTranscriptIdentity(key)}:${summarizeTranscriptValue(record[key], depth + 1, seen)}`,
    );
  return `{${shown.join(", ")}${keys.length > shown.length ? `, …+${keys.length - shown.length}` : ""}}`;
}

function row(
  entryId: string,
  sequence: number,
  kind: PiChildTranscriptEntry["kind"],
  fact: string,
  content: string,
  width: number,
): PiChildTranscriptRenderedRow {
  const stableEntryId = safeTranscriptIdentity(entryId);
  const factId = `${stableEntryId}:${safeTranscriptIdentity(fact)}`;
  const lines = wrapTranscriptText(content, width);
  return {
    id: factId,
    entryId: stableEntryId,
    factId,
    sequence,
    kind,
    lines,
    provenance: "fallback",
  };
}

function hiddenRow(
  entry: PiChildTranscriptEntry,
  fact: string,
  label: string,
  width: number,
): PiChildTranscriptRenderedRow {
  return row(
    entry.id,
    entry.sequence,
    entry.kind,
    fact,
    `${label}: [hidden]`,
    width,
  );
}

function renderEntry(
  entry: PiChildTranscriptEntry,
  width: number,
  largeEvent: boolean,
): PiChildTranscriptRenderedRow[] {
  if (largeEvent) {
    return [
      row(
        entry.id,
        entry.sequence,
        entry.kind,
        "large-event",
        `[event ${entry.sequence}: retained locally; details omitted for safety]`,
        width,
      ),
    ];
  }
  const rows: PiChildTranscriptRenderedRow[] = [];
  if (
    entry.kind === "task" ||
    entry.kind === "steering" ||
    entry.kind === "follow_up"
  ) {
    rows.push(
      row(
        entry.id,
        entry.sequence,
        entry.kind,
        "text",
        `${entry.kind}: ${entry.text || "[empty]"}`,
        width,
      ),
    );
  } else if (entry.kind === "assistant") {
    rows.push(
      row(
        entry.id,
        entry.sequence,
        entry.kind,
        "text",
        `assistant${entry.streaming ? " (streaming)" : ""}: ${entry.text || "[empty]"}`,
        width,
      ),
    );
    if (entry.thinkingVisible) {
      if (entry.thinking)
        rows.push(
          row(
            entry.id,
            entry.sequence,
            entry.kind,
            "thinking",
            `thinking: ${entry.thinking}`,
            width,
          ),
        );
    } else rows.push(hiddenRow(entry, "thinking", "thinking", width));
    if (entry.markdown)
      rows.push(
        row(
          entry.id,
          entry.sequence,
          entry.kind,
          "markdown",
          `markdown: ${entry.markdown}`,
          width,
        ),
      );
    if (entry.stopReason === "error")
      rows.push(
        row(
          entry.id,
          entry.sequence,
          entry.kind,
          "error",
          formatPiChildProviderError(entry.terminalError),
          width,
        ),
      );
    else if (entry.stopReason)
      rows.push(
        row(
          entry.id,
          entry.sequence,
          entry.kind,
          "stop",
          `assistant stop: ${entry.stopReason}`,
          width,
        ),
      );
    if (entry.usage)
      rows.push(
        row(
          entry.id,
          entry.sequence,
          entry.kind,
          "usage",
          `assistant usage: ${summarizeTranscriptValue(entry.usage)}`,
          width,
        ),
      );
    if (entry.imageIds.length > 0) {
      rows.push(
        entry.imagesVisible
          ? row(
              entry.id,
              entry.sequence,
              entry.kind,
              "images",
              `assistant images: ${entry.imageIds.length} (data omitted)`,
              width,
            )
          : hiddenRow(entry, "images", "assistant images", width),
      );
    }
  } else if (entry.kind === "tool") {
    rows.push(
      row(
        entry.id,
        entry.sequence,
        entry.kind,
        "tool",
        `tool: ${entry.toolName || "unknown tool"} [${entry.knownTool ? "known" : "unknown"}] state:${entry.state}`,
        width,
      ),
    );
    if (entry.argumentsKnown) {
      rows.push(
        row(
          entry.id,
          entry.sequence,
          entry.kind,
          "arguments",
          `tool arguments: ${entry.expanded ? summarizeTranscriptValue(entry.arguments) : "[collapsed]"}`,
          width,
        ),
      );
    } else
      rows.push(
        row(
          entry.id,
          entry.sequence,
          entry.kind,
          "arguments",
          "tool arguments: [unavailable]",
          width,
        ),
      );
    for (const [index, partial] of entry.partialResults.entries()) {
      rows.push(
        row(
          entry.id,
          entry.sequence,
          entry.kind,
          `partial-${index}`,
          `tool partial ${index + 1}: ${entry.expanded ? summarizeTranscriptValue(partial) : "[collapsed]"}`,
          width,
        ),
      );
    }
    if (entry.result !== undefined)
      rows.push(
        row(
          entry.id,
          entry.sequence,
          entry.kind,
          "result",
          `tool result: ${entry.expanded ? summarizeTranscriptValue(entry.result) : "[collapsed]"}`,
          width,
        ),
      );
    if (entry.error !== undefined)
      rows.push(
        row(
          entry.id,
          entry.sequence,
          entry.kind,
          "error",
          `tool error: ${entry.error}`,
          width,
        ),
      );
    if (entry.imageIds.length > 0) {
      rows.push(
        entry.imagesVisible
          ? row(
              entry.id,
              entry.sequence,
              entry.kind,
              "images",
              `tool images: ${entry.imageIds.length} (data omitted)`,
              width,
            )
          : hiddenRow(entry, "images", "tool images", width),
      );
    }
  } else if (
    entry.kind === "text" ||
    entry.kind === "thinking" ||
    entry.kind === "markdown"
  ) {
    if (entry.kind === "thinking" && !entry.thinkingVisible)
      rows.push(hiddenRow(entry, "text", entry.kind, width));
    else
      rows.push(
        row(
          entry.id,
          entry.sequence,
          entry.kind,
          "text",
          `${entry.kind}: ${entry.text || "[empty]"}`,
          width,
        ),
      );
  } else if (entry.kind === "image") {
    rows.push(
      entry.imagesVisible
        ? row(
            entry.id,
            entry.sequence,
            entry.kind,
            "image",
            `image ${entry.imageId} ${entry.mimeType ?? "unknown type"}: binary data omitted`,
            width,
          )
        : hiddenRow(entry, "image", "image", width),
    );
  } else if (entry.kind === "usage") {
    rows.push(
      row(
        entry.id,
        entry.sequence,
        entry.kind,
        "usage",
        `usage: ${summarizeTranscriptValue(entry.usage)}`,
        width,
      ),
    );
  } else if (entry.kind === "queue") {
    rows.push(
      row(
        entry.id,
        entry.sequence,
        entry.kind,
        "queue",
        `queue: size=${entry.size} ${summarizeTranscriptValue(entry.queue)}`,
        width,
      ),
    );
  } else if (entry.kind === "status") {
    rows.push(
      row(
        entry.id,
        entry.sequence,
        entry.kind,
        "status",
        `status: ${entry.status}${entry.message ? ` - ${entry.message}` : ""}`,
        width,
      ),
    );
  } else if (entry.kind === "retry") {
    rows.push(
      row(
        entry.id,
        entry.sequence,
        entry.kind,
        "retry",
        `retry: attempt=${entry.attempt ?? "?"}${entry.reason ? ` - ${entry.reason}` : ""}`,
        width,
      ),
    );
  } else if (entry.kind === "extension_ui") {
    rows.push(
      row(
        entry.id,
        entry.sequence,
        entry.kind,
        "ui",
        `extension ui: ${entry.requestType} request=${entry.requestId}${entry.message ? ` - ${entry.message}` : ""}`,
        width,
      ),
    );
    if (entry.widget !== undefined)
      rows.push(
        row(
          entry.id,
          entry.sequence,
          entry.kind,
          "widget",
          "extension widget: [payload omitted]",
          width,
        ),
      );
    if (entry.dialog !== undefined)
      rows.push(
        row(
          entry.id,
          entry.sequence,
          entry.kind,
          "dialog",
          "extension dialog: [payload omitted]",
          width,
        ),
      );
  } else {
    const originalType =
      "originalType" in entry ? entry.originalType : entry.kind;
    rows.push(
      row(
        entry.id,
        entry.sequence,
        entry.kind,
        "unknown",
        `unknown event: ${originalType}; payload omitted`,
        width,
      ),
    );
  }
  return rows;
}

/**
 * Renders normalized child transcript state without importing Pi TUI components.
 * The renderer is deliberately fail-closed: payloads are summarized, images are
 * represented by metadata only, and hidden content gets an explicit placeholder.
 */
function renderPiChildTranscriptFallback(
  state: PiChildTranscriptState,
  width = 80,
): PiChildTranscriptRender {
  const actualWidth = renderWidth(width);
  const largeEvents = new Map<number, number>();
  for (const history of state.historyEvents) {
    if (history.byteLength > 1024 * 1024)
      largeEvents.set(history.sequence, history.byteLength);
  }
  const renderedSequences = new Set<number>();
  const rows: PiChildTranscriptRenderedRow[] = [];
  for (const entry of state.entries) {
    if (largeEvents.has(entry.sequence)) renderedSequences.add(entry.sequence);
    const entryRows = renderEntry(
      entry,
      actualWidth,
      largeEvents.has(entry.sequence),
    );
    const overlayEntryId = entry.overlayEntryId;
    // Row identity stays renderer-owned; the overlay identity rides along so
    // consumers can regroup full-layout rows the way compact groups entries.
    rows.push(
      ...(overlayEntryId === undefined
        ? entryRows
        : entryRows.map((item) => ({ ...item, overlayEntryId }))),
    );
  }
  for (const [sequence, byteLength] of largeEvents) {
    if (renderedSequences.has(sequence)) continue;
    rows.push(
      row(
        `history-${sequence}`,
        sequence,
        "unknown",
        "large-event",
        `[event ${sequence}: ${byteLength} bytes retained locally; details omitted for safety]`,
        actualWidth,
      ),
    );
  }
  rows.sort((left, right) => left.sequence - right.sequence);
  return {
    rows,
    lines: rows.flatMap((item) => item.lines),
    width: actualWidth,
  };
}

export type PiTranscriptRenderInput =
  | PiTranscriptRenderOptions
  | PiTranscriptComponentFactory;

interface CachedTranscriptComponent {
  readonly signature: PiTranscriptComponentRequest;
  readonly component?: PiTranscriptComponent;
}

function isComponentFactory(
  value: PiTranscriptRenderInput,
): value is PiTranscriptComponentFactory {
  return isRecord(value) && typeof value.create === "function";
}

function optionsFrom(
  input: PiTranscriptRenderInput | undefined,
): PiTranscriptRenderOptions {
  if (input === undefined) return {};
  return isComponentFactory(input) ? { componentFactory: input } : input;
}

function toolDefinitionFor(
  entry: PiChildTranscriptEntry | undefined,
  definitions: PiTranscriptRenderOptions["toolDefinitions"],
): unknown {
  if (entry?.kind !== "tool" || !entry.knownTool || definitions === undefined)
    return undefined;
  if (definitions instanceof Map) return definitions.get(entry.toolName);
  return (definitions as Readonly<Record<string, unknown>>)[entry.toolName];
}

function componentKindFor(
  rowItem: PiChildTranscriptRenderedRow,
  entry: PiChildTranscriptEntry | undefined,
): PiTranscriptComponentKind {
  if (entry?.kind === "task") return "task";
  if (entry?.kind === "steering") return "steering";
  if (entry?.kind === "follow_up") return "user";
  if (entry?.kind === "tool") return "tool";
  if (entry?.kind === "image") return "image";
  if (entry?.kind === "usage") return "usage";
  if (entry?.kind === "queue") return "queue";
  if (entry?.kind === "status") return "status";
  if (entry?.kind === "retry") return "retry";
  if (entry?.kind === "extension_ui") return "extension_ui";
  if (entry?.kind === "unknown" || entry === undefined) return "unknown";
  if (rowItem.factId.endsWith(":thinking")) return "thinking";
  if (rowItem.factId.endsWith(":markdown")) return "markdown";
  return entry.kind === "thinking" ? "thinking" : "assistant";
}

function payloadFor(
  entry: PiChildTranscriptEntry | undefined,
): PiTranscriptComponentPayload | undefined {
  if (entry === undefined) return undefined;
  switch (entry.kind) {
    case "task":
    case "steering":
    case "follow_up":
      return { type: "text", text: boundedTranscriptText(entry.text) };
    case "assistant":
      return {
        type: "assistant",
        text: boundedTranscriptText(entry.text),
        thinking: boundedTranscriptText(entry.thinking),
        markdown: boundedTranscriptText(entry.markdown),
        streaming: entry.streaming,
        stopReason: entry.stopReason,
      };
    case "text":
    case "thinking":
    case "markdown":
      return { type: "text", text: boundedTranscriptText(entry.text) };
    case "tool":
      return {
        type: "tool",
        toolName: entry.toolName,
        toolCallId: entry.toolCallId,
        state: entry.state,
        knownTool: entry.knownTool,
        argumentsKnown: entry.argumentsKnown,
        arguments: entry.arguments,
        partialResults: entry.partialResults,
        result: entry.result,
        error: entry.error,
      };
    case "usage":
      return { type: "usage", usage: entry.usage };
    case "queue":
      return { type: "queue", size: entry.size };
    case "status":
      return {
        type: "status",
        status: entry.status,
        message: entry.message,
      };
    case "retry":
      return { type: "retry", attempt: entry.attempt, reason: entry.reason };
    default:
      return undefined;
  }
}

function requestFor(
  rowItem: PiChildTranscriptRenderedRow,
  entry: PiChildTranscriptEntry | undefined,
  options: PiTranscriptRenderOptions,
  normalizedRow = rowItem,
): PiTranscriptComponentRequest {
  const kind = componentKindFor(rowItem, entry);
  const request: PiTranscriptComponentRequest = {
    kind,
    entryId: rowItem.entryId,
    factId: rowItem.factId,
    sequence: rowItem.sequence,
    content: normalizedRow.lines.join("\n"),
    payload: payloadFor(entry),
    streaming: entry?.kind === "assistant" ? entry.streaming : undefined,
    toolName: entry?.kind === "tool" ? entry.toolName : undefined,
    knownToolDefinition: toolDefinitionFor(entry, options.toolDefinitions),
    theme: options.theme,
  };
  if (entry?.kind === "image")
    return {
      ...request,
      imageMetadata: {
        imageId: entry.imageId,
        mimeType: entry.mimeType,
      },
    };
  if (entry?.kind === "extension_ui")
    return {
      ...request,
      extensionUiMetadata: {
        requestType: entry.requestType,
        requestId: entry.requestId,
        message: entry.message,
        hasWidget: entry.widget !== undefined,
        hasDialog: entry.dialog !== undefined,
      },
    };
  return request;
}

function samePayload(
  left: PiTranscriptComponentPayload | undefined,
  right: PiTranscriptComponentPayload | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  if (left.type !== right.type) return false;
  return Result.fromThrowable(
    () => JSON.stringify(left) === JSON.stringify(right),
    () => "payload_compare_failed",
  )().unwrapOr(false);
}

function sameComponentRequest(
  left: PiTranscriptComponentRequest,
  right: PiTranscriptComponentRequest,
): boolean {
  return (
    left.kind === right.kind &&
    left.entryId === right.entryId &&
    left.factId === right.factId &&
    left.sequence === right.sequence &&
    left.content === right.content &&
    left.streaming === right.streaming &&
    left.toolName === right.toolName &&
    Object.is(left.knownToolDefinition, right.knownToolDefinition) &&
    Object.is(left.theme, right.theme) &&
    samePayload(left.payload, right.payload) &&
    JSON.stringify(left.imageMetadata) ===
      JSON.stringify(right.imageMetadata) &&
    JSON.stringify(left.extensionUiMetadata) ===
      JSON.stringify(right.extensionUiMetadata)
  );
}

function safeInvalidate(component: PiTranscriptComponent): void {
  Result.fromThrowable(
    () => component.invalidate(),
    () => "component_invalidate_failed",
  )().match(
    () => undefined,
    () => undefined,
  );
}

function safeSuppress(
  factory: PiTranscriptComponentFactory,
  request: PiTranscriptComponentRequest,
): boolean {
  if (typeof factory.suppress !== "function") return false;
  return Result.fromThrowable(
    () => factory.suppress?.(request) === true,
    () => "component_suppress_failed",
  )().unwrapOr(false);
}

function safeCreateComponent(
  factory: PiTranscriptComponentFactory,
  request: PiTranscriptComponentRequest,
): PiTranscriptComponent | undefined {
  return Result.fromThrowable(
    () => factory.create(request),
    () => "component_create_failed",
  )().match(
    (component) =>
      typeof component?.render === "function" &&
      typeof component.invalidate === "function"
        ? component
        : undefined,
    () => undefined,
  );
}

/**
 * Bounds a native component's own line without touching its styling. Native
 * components come from the harness's trusted UI code, already wrapped to the
 * requested width, so stripping their ANSI would erase Pi's colors.
 */
/**
 * Clips a styled line to the visible width without dropping its escape
 * sequences. Native components pad to the width they are given, but a long
 * tool path or result line can still overflow, and an overflowing line wraps
 * and shears the rows below it.
 */
function clipNativeLine(value: string, width: number): string {
  if (width <= 0) return "";
  let visible = 0;
  let styled = false;
  let out = "";
  const chars = [...value];
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index] as string;
    if (char === "\u001b") {
      styled = true;
      const next = chars[index + 1];
      if (next === "]") {
        // OSC: terminated by BEL or ST, and costs no visible columns.
        out += char;
        index += 1;
        while (index < chars.length) {
          const current = chars[index] as string;
          out += current;
          if (current === "\u0007") break;
          if (
            current === "\u001b" &&
            chars[index + 1] === "\\" &&
            index + 1 < chars.length
          ) {
            out += "\\";
            index += 1;
            break;
          }
          index += 1;
        }
        continue;
      }
      if (next === "[") {
        out += char;
        out += next;
        index += 1;
        while (index + 1 < chars.length) {
          const current = chars[index + 1] as string;
          out += current;
          index += 1;
          if (/[@-~]/.test(current)) break;
        }
        continue;
      }
      // Any other escape: copy the introducer and its single final byte.
      out += char;
      if (next !== undefined) {
        out += next;
        index += 1;
      }
      continue;
    }
    const cost = codePointWidth(char.codePointAt(0) ?? 0);
    if (visible + cost > width) return styled ? `${out}\u001b[0m` : out;
    visible += cost;
    out += char;
  }
  return out;
}

function boundedNativeLines(value: string, width: number): string[] {
  const lines: string[] = [];
  for (const part of value.replace(/\r\n?/g, "\n").split("\n")) {
    const codePoints = [...part];
    const bounded =
      codePoints.length <= MAX_PI_TRANSCRIPT_RENDER_STRING
        ? part
        : `${codePoints.slice(0, MAX_PI_TRANSCRIPT_RENDER_STRING - 1).join("")}\u2026`;
    lines.push(clipNativeLine(bounded, width));
  }
  return lines;
}

function safeRenderComponent(
  component: PiTranscriptComponent,
  width: number,
  fallback: readonly string[],
): string[] {
  return Result.fromThrowable(
    () => component.render(width),
    () => "component_render_failed",
  )().match(
    (lines) => {
      if (!Array.isArray(lines)) return [...fallback];
      const bounded: string[] = [];
      for (const line of lines) {
        if (typeof line !== "string") continue;
        bounded.push(...boundedNativeLines(line, width));
        if (bounded.length >= MAX_PI_TRANSCRIPT_RENDER_LINES) break;
      }
      return bounded.length > 0
        ? bounded.slice(0, MAX_PI_TRANSCRIPT_RENDER_LINES)
        : [...fallback];
    },
    () => [...fallback],
  );
}

/** Stateful native renderer. Keep one instance to retain its component cache. */
export class PiChildTranscriptRenderer {
  private readonly cache = new Map<
    string,
    Map<string, CachedTranscriptComponent>
  >();
  private options: PiTranscriptRenderOptions;

  constructor(options: PiTranscriptRenderInput = {}) {
    this.options = optionsFrom(options);
  }

  private invalidateCache(): void {
    for (const facts of this.cache.values())
      for (const cached of facts.values())
        if (cached.component !== undefined) safeInvalidate(cached.component);
    this.cache.clear();
  }

  private renderNative(
    fallback: PiChildTranscriptRender,
    state: PiChildTranscriptState,
    options: PiTranscriptRenderOptions,
  ): PiChildTranscriptRender {
    const factory = options.componentFactory;
    if (factory === undefined) return fallback;

    const entries = new Map(
      state.entries.map((entry) => [safeTranscriptIdentity(entry.id), entry]),
    );
    const normalizedRows = new Map(
      renderPiChildTranscriptFallback(
        state,
        MAX_PI_TRANSCRIPT_RENDER_WIDTH,
      ).rows.map((rowItem) => [rowItem.id, rowItem]),
    );
    const activeEntries = new Set<string>();
    const nativeRows: PiChildTranscriptRenderedRow[] = [];
    for (const rowItem of fallback.rows) {
      activeEntries.add(rowItem.entryId);
      const entryFacts = this.cache.get(rowItem.entryId) ?? new Map();
      this.cache.set(rowItem.entryId, entryFacts);
      const entry = entries.get(rowItem.entryId);
      const request = requestFor(
        rowItem,
        entry,
        options,
        normalizedRows.get(rowItem.id),
      );
      if (safeSuppress(factory, request)) {
        const suppressed = entryFacts.get(rowItem.factId);
        if (suppressed?.component !== undefined)
          safeInvalidate(suppressed.component);
        entryFacts.delete(rowItem.factId);
        continue;
      }
      const cached = entryFacts.get(rowItem.factId);
      let component = cached?.component;
      if (
        cached !== undefined &&
        !sameComponentRequest(cached.signature, request)
      ) {
        if (component !== undefined) safeInvalidate(component);
        component = safeCreateComponent(factory, request);
      } else if (component === undefined) {
        component = safeCreateComponent(factory, request);
      }
      entryFacts.set(rowItem.factId, { signature: request, component });
      nativeRows.push({
        ...rowItem,
        lines:
          component === undefined
            ? [...rowItem.lines]
            : safeRenderComponent(component, fallback.width, rowItem.lines),
        provenance: "native",
      });
    }
    for (const entryId of this.cache.keys())
      if (!activeEntries.has(entryId)) {
        const facts = this.cache.get(entryId);
        if (facts !== undefined)
          for (const cached of facts.values())
            if (cached.component !== undefined)
              safeInvalidate(cached.component);
        this.cache.delete(entryId);
      }
    return {
      rows: nativeRows,
      lines: nativeRows.flatMap((item) => item.lines),
      width: fallback.width,
    };
  }

  render(
    state: PiChildTranscriptState,
    width = 80,
    options?: PiTranscriptRenderOptions,
  ): PiChildTranscriptRender {
    const nextOptions = options ?? this.options;
    if (nextOptions.componentFactory !== this.options.componentFactory)
      this.invalidateCache();
    this.options = nextOptions;
    const fallback = renderPiChildTranscriptFallback(state, width);
    return this.renderNative(fallback, state, nextOptions);
  }
}

export function createPiChildTranscriptRenderer(
  input: PiTranscriptRenderInput = {},
): PiChildTranscriptRenderer {
  return new PiChildTranscriptRenderer(input);
}

const transcriptRendererCache = new WeakMap<
  object,
  PiChildTranscriptRenderer
>();

function rendererFor(
  input: PiTranscriptRenderInput | undefined,
): PiChildTranscriptRenderer {
  if (input === undefined) return new PiChildTranscriptRenderer();
  const options = optionsFrom(input);
  const key = (options.componentFactory ?? input) as object;
  const cached = transcriptRendererCache.get(key);
  if (cached !== undefined) return cached;
  const renderer = new PiChildTranscriptRenderer(options);
  transcriptRendererCache.set(key, renderer);
  return renderer;
}

export function renderPiChildTranscript(
  state: PiChildTranscriptState,
  width = 80,
  input?: PiTranscriptRenderInput,
): PiChildTranscriptRender {
  const options = optionsFrom(input);
  return rendererFor(input).render(state, width, options);
}

/** Alias used by adapter callers that do not need the Pi-specific prefix. */
export const renderChildTranscript = renderPiChildTranscript;

/** Convenience form for callers that need structured rows only. */
export function renderPiChildTranscriptRows(
  state: PiChildTranscriptState,
  width = 80,
  input?: PiTranscriptRenderInput,
): readonly PiChildTranscriptRenderedRow[] {
  return renderPiChildTranscript(state, width, input).rows;
}

/** Convenience form matching Pi's fallback `string[]` rendering contract. */
export function renderPiChildTranscriptLines(
  state: PiChildTranscriptState,
  width = 80,
  input?: PiTranscriptRenderInput,
): string[] {
  return [...renderPiChildTranscript(state, width, input).lines];
}

export const renderChildTranscriptRows = renderPiChildTranscriptRows;
export const renderChildTranscriptLines = renderPiChildTranscriptLines;
