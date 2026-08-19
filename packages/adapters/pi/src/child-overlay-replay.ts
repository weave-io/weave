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
  PI_NATIVE_RESULT_CHUNK_ENTRY_TYPE,
  PI_NATIVE_RESULT_COMMIT_ENTRY_TYPE,
} from "./child-native-results.js";
import {
  boundLabel,
  boundText,
  messageText,
  type NativeMessageParts,
  nativeMessageParts,
  nonEmptyString,
  recordOf,
  safeEntryId,
} from "./child-overlay-native-parts.js";
import {
  CHILD_OVERLAY_BOUNDS,
  type ChildOverlayEntry,
  type ChildOverlayEntryKind,
  type ChildOverlayMappingError,
  type ChildOverlayReplayStep,
  ChildOverlayRunOrdinalSchema,
  OpaqueIdSchema,
  RunActionSchema,
} from "./child-overlay-types.js";
import {
  historicalAssistantMessageFields,
  redactProviderErrorFromEvent,
} from "./child-provider-error.js";
import {
  type PiChildSessionEvent,
  parsePiChildSessionEvent,
  retainedChildSessionEvent,
} from "./child-session-events.js";
import {
  createPiChildTranscriptState,
  MAX_TRANSCRIPT_INPUT_BYTES,
  type PiChildTranscriptAction,
  type PiChildTranscriptState,
  reducePiChildTranscript,
} from "./child-transcript.js";
import { messageUpdateAnswerText } from "./message-update-carrier.js";

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
  run: ChildOverlayRunOrdinalSchema.optional(),
  action: RunActionSchema.optional(),
  runNumber: ChildOverlayRunOrdinalSchema.optional(),
});

// The bounded narrow of the host's own message shapes lives one layer below,
// in `child-overlay-native-parts.js`. Its primitives are re-exported here
// because they were this module's public surface first, and every overlay
// module above it already reads them from this path.
export {
  boundLabel,
  boundText,
  messageText,
  nonEmptyString,
  recordOf,
  safeEntryId,
} from "./child-overlay-native-parts.js";

/** Validates a synthesized child event through the shared bounded schema. */
function replayEvent(candidate: unknown): ChildOverlayReplayStep | undefined {
  const parsed = parsePiChildSessionEvent(candidate);
  if (!parsed.success) return undefined;
  // Replay steps are retained state: they are serialized with the overlay
  // window and re-reduced on every rebuild, so the shared retention decision
  // is asked here, on the OBSERVED frame, before the step exists.
  //
  // Order matters. `redactProviderErrorFromEvent` REBUILDS a `message_update`
  // from its known carriers, which silently drops whatever a rejected frame
  // hid under an undeclared member - and turns the refused frame into an
  // ordinary answer step that publishes the text beside the hidden thought.
  // Asking first is what keeps this entrance's verdict the same as the
  // transcript reducer's and the registry's.
  const retained = retainedChildSessionEvent(parsed.data);
  if (retained === undefined) return undefined;
  return { kind: "event", event: redactProviderErrorFromEvent(retained) };
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
    case "reasoning_summary":
      return "reasoning_summary";
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
      return assistantEntryFromParts(
        id,
        sequence,
        parts.value,
        // Historical facts the persisted assistant message contributes: pi-ai
        // usage accounting and the terminal outcome, sanitized.
        historicalAssistantMessageFields(message.data.message),
      );
    if (parts.value.role === "user" || parts.value.role === "toolResult")
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
    // Adapter-owned storage/transport bookkeeping is never user-visible: the
    // thread pointer and the durable result-chunk/commit group are internal
    // records, not control facts the operator steered or observed.
    if (
      customType === "weave.child.thread" ||
      customType === PI_NATIVE_RESULT_CHUNK_ENTRY_TYPE ||
      customType === PI_NATIVE_RESULT_COMMIT_ENTRY_TYPE
    ) {
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
  historicalFields: Record<string, unknown> = {},
): Result<ChildOverlayEntry, ChildOverlayMappingError> {
  const steps: ChildOverlayReplayStep[] = [];
  const start = pushReplayEvent(steps, {
    type: "message_start",
    message: { id, role: "assistant" },
  });
  if (start.isErr()) return err(start.error);
  // A persisted raw reasoning block replays as a content-free marker: the
  // rebuilt page proves the child reasoned without restating its thoughts.
  if (parts.reasoningBlocks > 0) {
    const pushed = pushReplayEvent(steps, { type: "thinking" });
    if (pushed.isErr()) return err(pushed.error);
  }
  for (const summary of parts.reasoningSummaries) {
    const pushed = pushReplayEvent(steps, {
      type: "reasoning_summary",
      text: summary,
    });
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
    message: {
      id,
      role: "assistant",
      content: parts.text,
      ...historicalFields,
    },
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
  const reasoned = parts.reasoningBlocks > 0;
  let kind: ChildOverlayEntryKind = "assistant";
  if (!hasText && parts.toolCalls.length > 0) kind = "tool";
  else if (!hasText && (reasoned || parts.reasoningSummaries.length > 0))
    kind = "thinking";
  else if (!hasText && parts.images.length > 0) kind = "image";
  // Raw reasoning contributes no text to the entry label. An explicit host
  // summary remains a trusted historical fact, but the inspector renderer
  // deliberately emits zero rows for this legacy summary-only entry.
  const text = hasText
    ? parts.text
    : boundText(
        [
          ...parts.toolCalls.map((call) => call.toolName),
          ...parts.reasoningSummaries,
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
  // A `toolResult` message is an ANSWER, never an input. It has no prompt text
  // to replay, so it never contributes a prompt row.
  const isToolAnswer = parts.role === "toolResult";
  if (!isToolAnswer && (hasText || !hasOtherFacts)) {
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

  let kind: ChildOverlayEntryKind =
    sequence === 0 && !isToolAnswer ? "prompt" : "user";
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
      // Carry the overlay entry's stable id into the transcript so full-layout
      // rows regroup under the same identity the compact layout uses.
      const action: PiChildTranscriptAction =
        step.kind === "event"
          ? { kind: "event", event: step.event, overlayEntryId: entry.id }
          : {
              kind: step.input,
              text: step.text.slice(0, MAX_TRANSCRIPT_INPUT_BYTES),
              overlayEntryId: entry.id,
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

// ---------------------------------------------------------------------------
// Live event projection (moved out of the controller to keep it reviewable)
// ---------------------------------------------------------------------------
/**
 * Project one parsed child session event into a bounded overlay entry.
 *
 * Pure: it reads only the event, the caller's sequence number, and the
 * caller's expansion default, and returns undefined for events the overlay
 * window does not display. Assistant lifecycle identity is the caller's: an
 * update projecting nothing here still belongs to that lifecycle.
 */
export function projectLiveEntry(
  event: PiChildSessionEvent,
  sequence: number,
  expanded: boolean,
  assistantEntryId?: string,
): ChildOverlayEntry | undefined {
  // Same contract as the historical mapper's `replayEvent`, through the same
  // shared decision: a retained step never carries chain-of-thought prose,
  // only the fact that it happened, and a frame the carrier classification
  // rejected projects no entry and no step at all.
  const retained = retainedChildSessionEvent(event);
  if (retained === undefined) return undefined;
  const replay: readonly ChildOverlayReplayStep[] = [
    { kind: "event", event: retained },
  ];
  switch (event.type) {
    case "message_start":
    case "message_update":
    case "message_end": {
      let text = "";
      if (event.type === "message_end") {
        text = messageText(event.message).text;
      } else if (event.type === "message_update") {
        // The single carrier classification: only an unambiguous answer frame
        // has body text. A `thinking_delta`, a framing frame, and any frame
        // that mixed carriers all project nothing.
        const delta = messageUpdateAnswerText(event);
        if (delta !== undefined) text = boundText(delta);
      }
      // Real Pi 0.84 `AssistantMessage` carries no id, and `state.entries`
      // grows between start and end, so neither the message nor the sequence
      // names a lifecycle. The sequence fallback covers direct pure calls.
      const id = assistantEntryId ?? `live-assistant-${sequence}`;
      if (event.type === "message_update" && text.length === 0)
        return undefined;
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
    // Raw reasoning: the entry exists, its text never does.
    case "thinking":
      return {
        id: `live-thinking-${sequence}`,
        sequence,
        kind: "thinking",
        text: "",
        expanded,
        replay,
      };
    case "reasoning_summary":
      return {
        id: `live-reasoning-summary-${sequence}`,
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
    // Replay is the contract. The reducer turns `queue_change` into a queue
    // row, so a live child showed the parent's queued follow-ups while the
    // same window rebuilt through `transcriptFromOverlayEntries` showed none.
    // The row stays suppressed in the full pane; only the fact is retained.
    case "queue_change": {
      const size = queueChangeSize(event);
      return {
        id: `live-queue-${sequence}`,
        sequence,
        kind: "status",
        text: boundText(`queue: ${size ?? "unknown"}`),
        expanded,
        replay,
      };
    }
    default:
      return undefined;
  }
}

/**
 * Queued follow-ups a `queue_change` reports, or `undefined` when it reported
 * none.
 *
 * An unstated count is UNKNOWN, never zero: reading a missing size as `0`
 * published the child's own authority for a claim it never made, and the rail
 * then told the reader that a steered child had an empty queue.
 */
function queueChangeSize(event: PiChildSessionEvent): number | undefined {
  const record = event as unknown as Record<string, unknown>;
  if (typeof record.size === "number") return record.size;
  return Array.isArray(record.queue) ? record.queue.length : undefined;
}

// ---------------------------------------------------------------------------
// Live assistant lifecycle identity
// ---------------------------------------------------------------------------

/**
 * Wrap point of the per-child assistant lifecycle allocator. The counter is one
 * number per child, not a growing map, and its wrap distance is far larger than
 * any retained window, so a reused slot cannot collide with a live entry.
 */
export const MAX_LIVE_ASSISTANT_LIFECYCLES = 1_000_000;

/** Which part of an assistant message lifecycle an event belongs to. */
export type LiveAssistantLifecyclePhase = "start" | "continue" | "end";

/** Classifies an event as part of an assistant lifecycle, else undefined. */
export function liveAssistantLifecyclePhase(
  event: PiChildSessionEvent,
): LiveAssistantLifecyclePhase | undefined {
  if (event.type === "message_start") return "start";
  if (event.type === "message_update") return "continue";
  if (event.type === "message_end") return "end";
  return undefined;
}

/**
 * The canonical window entry of an assistant message that is still being
 * written.
 *
 * A streamed `message_update` states one delta, and an entry that keeps only
 * that delta is a fact nothing can rebuild an answer from. Every window
 * reconstruction the overlay performs — a trim, an older/newer page merge, a
 * search that fetches pages — replays entries through
 * {@link transcriptFromOverlayEntries}, and a lifecycle whose only retained
 * step was `message_start` came back empty while the child was still
 * answering.
 *
 * So the entry carries the ACCUMULATED answer instead, with one canonical
 * `message_update` step that reproduces it. It is exactly one step: replay
 * compaction collapses same-message updates onto their own stage, so a
 * thousand deltas cost one slot, and the terminal `message_end` occupies a
 * different stage and REPLACES the accumulated text on rebuild rather than
 * appending to it. Raw chain-of-thought never reaches here: the caller
 * accumulates answer deltas only.
 */
export function liveAssistantStreamEntry(input: {
  readonly id: string;
  readonly sequence: number;
  readonly expanded: boolean;
  readonly text: string;
  /** Framed as its own message when no `message_start` was observed. */
  readonly framed: boolean;
}): ChildOverlayEntry {
  const text = boundText(input.text);
  const steps: ChildOverlayReplayStep[] = [];
  if (input.framed) {
    const start = replayEvent({
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    if (start !== undefined) steps.push(start);
  }
  const update = replayEvent({
    type: "message_update",
    delta: { text },
  });
  if (update !== undefined) steps.push(update);
  return {
    id: input.id,
    sequence: input.sequence,
    kind: "assistant",
    text,
    expanded: input.expanded,
    replay: steps,
  };
}

/**
 * Allocates the next assistant lifecycle overlay entry id from a bounded
 * monotonic counter.
 *
 * Pi 0.84 `message_start` / `message_end` carry the pi-ai `AssistantMessage`
 * directly, and that type has no `id`, so lifecycle identity cannot be read off
 * the event. It cannot be derived from the window length either, because start
 * inserts an entry and end would then compute a different id.
 */
export function allocateLiveAssistantEntryId(counter: number): {
  readonly entryId: string;
  readonly nextCounter: number;
} {
  const slot =
    Number.isSafeInteger(counter) && counter >= 0
      ? counter % MAX_LIVE_ASSISTANT_LIFECYCLES
      : 0;
  return {
    entryId: `live-assistant-${slot}`,
    nextCounter: (slot + 1) % MAX_LIVE_ASSISTANT_LIFECYCLES,
  };
}
