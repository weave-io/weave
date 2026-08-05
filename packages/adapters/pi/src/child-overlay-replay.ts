/**
 * Native session entry → overlay replay mapping (Spec 33 §7, plan Task 12
 * phase A).
 *
 * Owns the bounded projection of Pi native session entries into overlay
 * entries, the semantic compaction and bounding of replay steps, and the
 * rebuild of a child transcript from retained overlay entries.
 *
 * Depends only on `child-overlay-types.js`; it never imports the controller,
 * the component, or the `child-overlay.js` facade.
 */

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import {
  CHILD_OVERLAY_BOUNDS,
  type ChildOverlayEntry,
  type ChildOverlayEntryKind,
  type ChildOverlayMappingError,
  type ChildOverlayPage,
  type ChildOverlayReplayStep,
  ChildOverlayRunDividerSchema,
  OpaqueIdSchema,
  RunActionSchema,
} from "./child-overlay-types.js";
import {
  type PiChildSessionEvent,
  parsePiChildSessionEvent,
} from "./child-session-events.js";
import {
  createPiChildTranscriptState,
  MAX_TRANSCRIPT_INPUT_BYTES,
  type PiChildTranscriptAction,
  type PiChildTranscriptState,
  reducePiChildTranscript,
} from "./child-transcript.js";

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

export function boundText(value: string): string {
  const clean = value.replace(BOUND_TEXT_CONTROL_PATTERN, "");
  if (clean.length <= CHILD_OVERLAY_BOUNDS.maxTextLength) return clean;
  return [...clean].slice(0, CHILD_OVERLAY_BOUNDS.maxTextLength).join("");
}

export function messageText(message: unknown): {
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

export function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function boundLabel(value: string): string {
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
          nonEmptyString(block.name) ??
            nonEmptyString(block.toolName) ??
            "tool",
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

export function pushReplayEvent(
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

function replayEventRecord(
  step: ChildOverlayReplayStep,
): Record<string, unknown> | undefined {
  if (step.kind !== "event") return undefined;
  return step.event as unknown as Record<string, unknown>;
}

function replayEventType(step: ChildOverlayReplayStep): string | undefined {
  const event = replayEventRecord(step);
  return typeof event?.type === "string" ? event.type : undefined;
}

function replayToolCallId(step: ChildOverlayReplayStep): string | undefined {
  const event = replayEventRecord(step);
  return event === undefined ? undefined : nonEmptyString(event.toolCallId);
}

function replayMessageId(step: ChildOverlayReplayStep): string {
  const event = replayEventRecord(step);
  if (event === undefined) return "";
  const message = recordOf(event.message);
  return nonEmptyString(message?.id) ?? nonEmptyString(event.messageId) ?? "";
}

function toolCallHasArguments(step: ChildOverlayReplayStep): boolean {
  const event = replayEventRecord(step);
  return event !== undefined && event.arguments !== undefined;
}

function isReplayImage(step: ChildOverlayReplayStep): boolean {
  return replayEventType(step) === "image";
}

function replayStepKey(step: ChildOverlayReplayStep): string {
  if (step.kind === "input") return `input:${step.input}:${step.text}`;
  const event = replayEventRecord(step);
  if (event === undefined) return "event";
  const type = typeof event.type === "string" ? event.type : "event";
  const toolCallId = nonEmptyString(event.toolCallId) ?? "";
  const messageId = replayMessageId(step);
  const text = nonEmptyString(event.text) ?? "";
  const mimeType = nonEmptyString(event.mimeType) ?? "";
  const payload =
    event.partialResult !== undefined ||
    event.result !== undefined ||
    event.error !== undefined ||
    event.arguments !== undefined
      ? JSON.stringify({
          arguments: event.arguments ?? null,
          partialResult: event.partialResult ?? null,
          result: event.result ?? null,
          error: event.error ?? null,
        })
      : "";
  return `${type}:${messageId}:${toolCallId}:${text}:${mimeType}:${payload}`;
}

/**
 * Stage key for semantic compaction. Same-stage repeats replace the prior
 * step instead of consuming another replay slot (updates / thinking / tool
 * partials, and later tool terminals / message ends for the same id).
 *
 * Returns `undefined` for facts that must accumulate uniquely (images, inputs,
 * distinct status/retry rows).
 */
function replayCompactionStageKey(
  step: ChildOverlayReplayStep,
): string | undefined {
  if (step.kind === "input") return undefined;
  const type = replayEventType(step);
  if (type === undefined) return undefined;
  const toolCallId = replayToolCallId(step) ?? "";
  const messageId = replayMessageId(step);
  switch (type) {
    case "message_update":
      return `message_update:${messageId}`;
    case "thinking":
      return "thinking";
    case "text":
      return "text";
    case "markdown":
      return "markdown";
    case "tool_partial_result":
      return `tool_partial:${toolCallId}`;
    case "tool_call":
      return `tool_call:${toolCallId}`;
    case "tool_result":
    case "tool_error":
      return `tool_terminal:${toolCallId}`;
    case "message_start":
      return `message_start:${messageId}`;
    case "message_end":
      return `message_end:${messageId}`;
    default:
      return undefined;
  }
}

/**
 * Whether `incoming` should replace an already-compacted step at the same
 * stage. Tool calls prefer the variant that carries arguments; other stages
 * always take the latest fact.
 */
function shouldReplaceCompactedStep(
  existing: ChildOverlayReplayStep,
  incoming: ChildOverlayReplayStep,
): boolean {
  if (replayEventType(existing) !== "tool_call") return true;
  if (toolCallHasArguments(incoming)) return true;
  if (toolCallHasArguments(existing)) return false;
  return true;
}

/**
 * Collapses repeated same-stage replay facts so streaming updates/partials
 * overwrite their prior slot before the entry bound is applied.
 */
function compactReplaySteps(
  steps: readonly ChildOverlayReplayStep[],
): ChildOverlayReplayStep[] {
  const compacted: ChildOverlayReplayStep[] = [];
  const stageIndex = new Map<string, number>();
  const seenUnique = new Set<string>();

  for (const step of steps) {
    const stageKey = replayCompactionStageKey(step);
    if (stageKey !== undefined) {
      const index = stageIndex.get(stageKey);
      if (index !== undefined) {
        const prior = compacted[index];
        if (prior !== undefined && shouldReplaceCompactedStep(prior, step)) {
          compacted[index] = step;
        }
        continue;
      }
      stageIndex.set(stageKey, compacted.length);
      compacted.push(step);
      continue;
    }

    const uniqueKey = replayStepKey(step);
    if (seenUnique.has(uniqueKey)) continue;
    seenUnique.add(uniqueKey);
    compacted.push(step);
  }
  return compacted;
}

/**
 * Marks required framing that must survive overflow: assistant start/end,
 * every retained tool's opening `tool_call` (preferring args) and terminal
 * result/error, plus image facts. Returns indices into `steps`.
 */
function essentialReplayIndices(
  steps: readonly ChildOverlayReplayStep[],
): readonly number[] {
  const toolIds = new Set<string>();
  for (const step of steps) {
    const toolCallId = replayToolCallId(step);
    const type = replayEventType(step);
    if (
      toolCallId !== undefined &&
      (type === "tool_call" ||
        type === "tool_partial_result" ||
        type === "tool_result" ||
        type === "tool_error")
    ) {
      toolIds.add(toolCallId);
    }
  }

  const chosenToolCall = new Map<string, number>();
  const chosenToolTerminal = new Map<string, number>();
  let messageStart: number | undefined;
  let messageEnd: number | undefined;
  const images: number[] = [];

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step === undefined) continue;
    if (isReplayMessageStart(step) && messageStart === undefined) {
      messageStart = index;
      continue;
    }
    if (isReplayMessageEnd(step)) {
      messageEnd = index;
      continue;
    }
    if (isReplayImage(step)) {
      images.push(index);
      continue;
    }
    const type = replayEventType(step);
    const toolCallId = replayToolCallId(step);
    if (toolCallId === undefined || !toolIds.has(toolCallId)) continue;
    if (type === "tool_call") {
      const prior = chosenToolCall.get(toolCallId);
      if (prior === undefined) {
        chosenToolCall.set(toolCallId, index);
      } else {
        const priorStep = steps[prior];
        if (
          priorStep !== undefined &&
          shouldReplaceCompactedStep(priorStep, step)
        ) {
          chosenToolCall.set(toolCallId, index);
        }
      }
      continue;
    }
    if (type === "tool_result" || type === "tool_error") {
      chosenToolTerminal.set(toolCallId, index);
    }
  }

  const indices = new Set<number>();
  if (messageStart !== undefined) indices.add(messageStart);
  if (messageEnd !== undefined) indices.add(messageEnd);
  for (const index of chosenToolCall.values()) indices.add(index);
  for (const index of chosenToolTerminal.values()) indices.add(index);
  for (const index of images) indices.add(index);
  return [...indices].sort((left, right) => left - right);
}

/**
 * Fits compacted replay under the entry bound while preserving required
 * framing. When essential frames alone exceed the bound, fails typed —
 * never silently drops a tool call or terminal.
 */
function boundReplaySteps(
  steps: readonly ChildOverlayReplayStep[],
  cap: number,
): Result<readonly ChildOverlayReplayStep[], ChildOverlayMappingError> {
  if (cap <= 0) {
    return err({
      type: "OverlayCapacityExceeded",
      operation: "entry-replay-steps",
    });
  }
  if (steps.length <= cap) return ok(steps);

  const essential = essentialReplayIndices(steps);
  if (essential.length > cap) {
    return err({
      type: "OverlayCapacityExceeded",
      operation: "entry-replay-steps",
    });
  }

  const essentialSet = new Set(essential);
  const optional = steps
    .map((_, index) => index)
    .filter((index) => !essentialSet.has(index));
  const optionalBudget = cap - essential.length;
  const keptOptional =
    optional.length <= optionalBudget
      ? optional
      : optional.slice(optional.length - optionalBudget);
  const kept = new Set([...essential, ...keptOptional]);
  return ok(steps.filter((_, index) => kept.has(index)));
}

/**
 * Concatenates replay steps for an entry replaced in place (a tool call that
 * later gains partial results and a terminal result, or a message that ends).
 *
 * Semantic compaction collapses repeated updates/thinking/tool partials onto
 * one stage slot before the bound applies. Remaining overflow preserves
 * required framing; essential-frame overflow fails typed.
 */
export function mergeReplaySteps(
  existing: readonly ChildOverlayReplayStep[] | undefined,
  incoming: readonly ChildOverlayReplayStep[] | undefined,
): Result<
  readonly ChildOverlayReplayStep[] | undefined,
  ChildOverlayMappingError
> {
  if (existing === undefined && incoming === undefined) return ok(undefined);
  const compacted = compactReplaySteps([
    ...(existing ?? []),
    ...(incoming ?? []),
  ]);
  return boundReplaySteps(compacted, CHILD_OVERLAY_BOUNDS.maxEntryReplaySteps);
}

/**
 * Public merge helper for tests and callers that need the typed capacity
 * result from semantic replay compaction.
 */
export function mergeChildOverlayReplaySteps(
  existing: readonly ChildOverlayReplayStep[] | undefined,
  incoming: readonly ChildOverlayReplayStep[] | undefined,
): Result<
  readonly ChildOverlayReplayStep[] | undefined,
  ChildOverlayMappingError
> {
  return mergeReplaySteps(existing, incoming);
}

export function safeEntryId(value: string, fallback: string): string {
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
  const hasOtherFacts = parts.toolResults.length > 0 || parts.images.length > 0;
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
export function degradedCapacityEntry(
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
