import { err, ok, Result } from "neverthrow";
import {
  blocked,
  type CaptureFailure,
  MAX_CAPTURE_ARRAY_LENGTH,
  MAX_CAPTURE_DEPTH,
  MAX_CAPTURE_EVENTS,
  MAX_CAPTURE_KEYS,
  MAX_CAPTURE_PREVIEW_BYTES,
  MAX_CAPTURE_STRING_BYTES,
  MAX_CAPTURE_TOTAL_BYTES,
  PROMPT_OMITTED_MARKER,
  PROVIDER_VALUE_OMITTED_MARKER,
  REASONING_OMITTED_MARKER,
  type SanitizedEvent,
  STRING_OMITTED_MARKER,
  STRING_TRUNCATED_MARKER,
} from "./child-stream-capture-contract.js";

export const RETAINED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
]);

export const THINKING_EVENT_TYPES: ReadonlySet<string> = new Set([
  "thinking_start",
  "thinking_delta",
  "thinking_end",
]);

const SAFE_EVENT_TYPES: ReadonlySet<string> = new Set([
  ...RETAINED_EVENT_TYPES,
  ...THINKING_EVENT_TYPES,
  "text_start",
  "text_delta",
  "text_end",
  "toolcall_start",
  "toolcall_delta",
  "toolcall_end",
  "toolCall",
  "text",
  "thinking",
  "toolResult",
]);

const SAFE_ROLES = new Set(["user", "assistant", "toolResult"]);
const SAFE_TOOL_NAMES = new Set(["read", "bash"]);
const SAFE_STOP_REASONS = new Set(["toolUse", "stop", "aborted", "error"]);
const PROVIDER_KEYS = new Set([
  "api",
  "provider",
  "model",
  "responseModel",
  "baseUrl",
  "apiKey",
  "headers",
  "request",
  "response",
  "raw",
]);
const PROMPT_KEYS = new Set([
  "prompt",
  "systemPrompt",
  "appendSystemPrompt",
  "instructions",
]);
const GENERIC_ID_KEYS = new Set([
  "id",
  "messageId",
  "sessionId",
  "requestId",
  "childId",
  "threadId",
  "parentId",
  "correlationId",
]);
const TOOL_ID_KEYS = new Set(["toolCallId", "tool_use_id", "toolUseId"]);

/** These are the only non-structural text values emitted by the deterministic provider. */
const CONTROLLED_TEXT = new Set([
  "Weave capture ",
  "deterministic final ",
  "answer.",
  "Weave capture deterministic final answer.",
  "weave capture deterministic final answer.",
  "weave capture deterministic workspace file\n",
  "weave-capture-ok\n",
  "weave-capture-ok",
  '{"path":"weave-capture-sample.txt"}',
  '{"command":"echo weave-capture-ok"}',
]);

const ABSENT = Symbol("absent");

type SafeRead = Result<unknown | typeof ABSENT, CaptureFailure>;

/** Read an ordinary data record without invoking an object-provided method. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Result.fromThrowable(
    () => typeof value === "object" && value !== null && !Array.isArray(value),
    () => false,
  )().match(
    (record) => record,
    () => false,
  );
}

function ownKeys(value: object): Result<readonly string[], CaptureFailure> {
  return Result.fromThrowable(
    () => Object.keys(value),
    () => blocked("sanitization-failed"),
  )();
}

function ownEnumerableDataValue(value: object, key: string): SafeRead {
  const descriptor = Result.fromThrowable(
    () => Object.getOwnPropertyDescriptor(value, key),
    () => blocked("sanitization-failed"),
  )();
  if (descriptor.isErr()) return err(descriptor.error);
  if (descriptor.value === undefined) return ok(ABSENT);
  if (
    !Object.hasOwn(descriptor.value, "value") ||
    descriptor.value.enumerable !== true
  ) {
    return ok(ABSENT);
  }
  return ok(descriptor.value.value);
}

function isArray(value: unknown): Result<boolean, CaptureFailure> {
  return Result.fromThrowable(
    () => Array.isArray(value),
    () => blocked("sanitization-failed"),
  )();
}

function arrayLength(
  value: readonly unknown[],
): Result<number, CaptureFailure> {
  return Result.fromThrowable(
    () => value.length,
    () => blocked("sanitization-failed"),
  )();
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function sha256HexOfText(text: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(new TextEncoder().encode(text))
    .digest("hex");
}

function safeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:[\\/]/u.test(value) &&
    !value.includes("\\") &&
    !value.split("/").some((part) => part === ".." || part.length === 0) &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  );
}

const ABSOLUTE_PATH_PATTERN =
  /(^|[\s"'`=:([])(?:\/(?:[^\s"'`=:)\]]+)|[A-Za-z]:[\\/][^\s"'`=:)\]]+)/u;
const CREDENTIAL_PATTERN =
  /\b(?:sk-[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|Bearer\s+[A-Za-z0-9._-]{10,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/u;
const ENVIRONMENT_PATTERN =
  /\bprocess\.env\b|\b(?:[A-Z][A-Z0-9_]{2,})=(?:[^\s]+)|\$\{?[A-Z][A-Z0-9_]{2,}\}?/u;
const EXCEPTION_PATTERN =
  /(?:^|\n)\s*at\s+[^\n(]+\([^\n]*\)|Traceback \(most recent call last\)/u;

/** Closed-content detector used before any string can reach the fixture walker. */
export function containsForbiddenContent(value: string): boolean {
  return (
    ABSOLUTE_PATH_PATTERN.test(value) ||
    CREDENTIAL_PATTERN.test(value) ||
    ENVIRONMENT_PATTERN.test(value) ||
    EXCEPTION_PATTERN.test(value) ||
    value.includes(String.fromCharCode(0x1b))
  );
}

// ---------------------------------------------------------------------------
// Online reasoning omission
// ---------------------------------------------------------------------------

interface OmittedProse {
  readonly marker: typeof REASONING_OMITTED_MARKER;
  readonly byteLength: number;
  readonly lineCount: number;
  /** True only when a saturated count could not represent the full input. */
  readonly truncated: boolean;
}

function omittedProse(value: string): OmittedProse {
  const byteLength = utf8Bytes(value);
  const lineCount = value.split("\n").length;
  return {
    marker: REASONING_OMITTED_MARKER,
    byteLength: Math.min(byteLength, MAX_CAPTURE_TOTAL_BYTES),
    lineCount: Math.min(lineCount, MAX_CAPTURE_TOTAL_BYTES),
    truncated:
      byteLength > MAX_CAPTURE_TOTAL_BYTES ||
      lineCount > MAX_CAPTURE_TOTAL_BYTES,
  };
}

function omitReasoningValue(
  value: unknown,
  depth: number,
): Result<unknown, CaptureFailure> {
  if (typeof value === "string") return ok(omittedProse(value));
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return ok(value);
  }
  if (depth > MAX_CAPTURE_DEPTH) return err(blocked("bounds-exceeded"));
  const arrayResult = isArray(value);
  if (arrayResult.isErr()) return err(arrayResult.error);
  if (arrayResult.value) {
    const array = value as readonly unknown[];
    const length = arrayLength(array);
    if (length.isErr()) return err(length.error);
    if (length.value > MAX_CAPTURE_ARRAY_LENGTH) {
      return err(blocked("bounds-exceeded"));
    }
    const output: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const item = ownEnumerableDataValue(array, String(index));
      if (item.isErr()) return err(item.error);
      if (item.value === ABSENT) return err(blocked("sanitization-failed"));
      const omitted = omitReasoningValue(item.value, depth + 1);
      if (omitted.isErr()) return omitted;
      output.push(omitted.value);
    }
    return ok(output);
  }
  if (!isRecord(value)) return err(blocked("sanitization-failed"));
  const keys = ownKeys(value);
  if (keys.isErr()) return err(keys.error);
  if (keys.value.length > MAX_CAPTURE_KEYS) {
    return err(blocked("bounds-exceeded"));
  }
  const output: Record<string, unknown> = {};
  for (const key of keys.value) {
    const member = ownEnumerableDataValue(value, key);
    if (member.isErr()) return err(member.error);
    if (member.value === ABSENT) return err(blocked("sanitization-failed"));
    if (key === "type" && typeof member.value === "string") {
      output[key] = member.value;
      continue;
    }
    const omitted = omitReasoningValue(member.value, depth + 1);
    if (omitted.isErr()) return omitted;
    output[key] = omitted.value;
  }
  return ok(output);
}

function omitReasoningWalk(
  value: unknown,
  depth: number,
): Result<unknown, CaptureFailure> {
  if (typeof value !== "object" || value === null) return ok(value);
  if (depth > MAX_CAPTURE_DEPTH) return err(blocked("bounds-exceeded"));
  const arrayResult = isArray(value);
  if (arrayResult.isErr()) return err(arrayResult.error);
  if (arrayResult.value) {
    const array = value as readonly unknown[];
    const length = arrayLength(array);
    if (length.isErr()) return err(length.error);
    if (length.value > MAX_CAPTURE_ARRAY_LENGTH) {
      return err(blocked("bounds-exceeded"));
    }
    const output: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const member = ownEnumerableDataValue(array, String(index));
      if (member.isErr()) return err(member.error);
      if (member.value === ABSENT) return err(blocked("sanitization-failed"));
      const walked = omitReasoningWalk(member.value, depth + 1);
      if (walked.isErr()) return walked;
      output.push(walked.value);
    }
    return ok(output);
  }
  if (!isRecord(value)) return err(blocked("sanitization-failed"));
  const keys = ownKeys(value);
  if (keys.isErr()) return err(keys.error);
  if (keys.value.length > MAX_CAPTURE_KEYS) {
    return err(blocked("bounds-exceeded"));
  }
  const typeRead = ownEnumerableDataValue(value, "type");
  if (typeRead.isErr()) return err(typeRead.error);
  const type = typeof typeRead.value === "string" ? typeRead.value : undefined;
  const reasoningEvent = type !== undefined && THINKING_EVENT_TYPES.has(type);
  const reasoningBlock = type === "thinking" || type === "reasoning";
  const output: Record<string, unknown> = {};
  for (const key of keys.value) {
    const member = ownEnumerableDataValue(value, key);
    if (member.isErr()) return err(member.error);
    if (member.value === ABSENT) return err(blocked("sanitization-failed"));

    const isDeclaredReasoningKey = key === "thinking" || key === "reasoning";
    const isThinkingEventProse =
      reasoningEvent &&
      (key === "delta" || key === "content" || key === "text");
    if (
      (reasoningBlock && key !== "type" && key !== "contentIndex") ||
      isDeclaredReasoningKey ||
      isThinkingEventProse
    ) {
      const omitted = omitReasoningValue(member.value, depth + 1);
      if (omitted.isErr()) return omitted;
      output[key] = omitted.value;
      continue;
    }

    const walked = omitReasoningWalk(member.value, depth + 1);
    if (walked.isErr()) return walked;
    output[key] = walked.value;
  }
  return ok(output);
}

/**
 * Omit raw thinking prose online. The returned tree contains only structural
 * markers and counts; the original string is never handed to sanitization.
 */
export function omitReasoningProse(
  rawEvent: unknown,
): Result<unknown, CaptureFailure> {
  return omitReasoningWalk(rawEvent, 0);
}

// ---------------------------------------------------------------------------
// Bounded, descriptor-safe fixture sanitizer
// ---------------------------------------------------------------------------

export interface OrdinalState {
  readonly toolCallIds: Map<string, string>;
  readonly genericIds: Map<string, string>;
  nextToolOrdinal: number;
  nextGenericOrdinal: number;
  totalBytes: number;
}

export function createOrdinalState(
  toolCallIds: ReadonlyMap<string, string> = new Map(),
): OrdinalState {
  const tools = new Map(toolCallIds);
  let nextToolOrdinal = 1;
  for (const ordinal of tools.values()) {
    const match = /^tool-call-(\d+)$/u.exec(ordinal);
    if (match !== null)
      nextToolOrdinal = Math.max(nextToolOrdinal, Number(match[1]) + 1);
  }
  return {
    toolCallIds: tools,
    genericIds: new Map(),
    nextToolOrdinal,
    nextGenericOrdinal: 1,
    totalBytes: 0,
  };
}

function ordinalToolCallId(value: string, state: OrdinalState): string {
  const existing = state.toolCallIds.get(value);
  if (existing !== undefined) return existing;
  const ordinal = `tool-call-${state.nextToolOrdinal}`;
  state.nextToolOrdinal += 1;
  state.toolCallIds.set(value, ordinal);
  return ordinal;
}

function ordinalGenericId(value: string, state: OrdinalState): string {
  const existing = state.genericIds.get(value);
  if (existing !== undefined) return existing;
  const ordinal = `id-${state.nextGenericOrdinal}`;
  state.nextGenericOrdinal += 1;
  state.genericIds.set(value, ordinal);
  return ordinal;
}

interface WalkContext {
  readonly key?: string;
  readonly type?: string;
  readonly role?: string;
  readonly toolName?: string;
  readonly eventType?: string;
}

function stringMarkerFor(
  value: string,
  key: string,
  context: WalkContext,
): string {
  if (PROVIDER_KEYS.has(key)) return PROVIDER_VALUE_OMITTED_MARKER;
  if (PROMPT_KEYS.has(key)) return PROMPT_OMITTED_MARKER;
  if (key === "text" && context.role === "user") return PROMPT_OMITTED_MARKER;
  if (key === "marker" && value === REASONING_OMITTED_MARKER) {
    return REASONING_OMITTED_MARKER;
  }
  if (key === "type" && SAFE_EVENT_TYPES.has(value)) return value;
  if (key === "eventType" && SAFE_EVENT_TYPES.has(value)) return value;
  if (key === "role" && SAFE_ROLES.has(value)) return value;
  if ((key === "toolName" || key === "name") && SAFE_TOOL_NAMES.has(value)) {
    return value;
  }
  if (key === "stopReason" && SAFE_STOP_REASONS.has(value)) return value;
  if ((key === "path" || key === "file") && safeRelativePath(value)) {
    return value === "weave-capture-sample.txt" ? value : STRING_OMITTED_MARKER;
  }
  if (key === "command" && !containsForbiddenContent(value)) {
    return value === "echo weave-capture-ok" ? value : STRING_OMITTED_MARKER;
  }
  if (key === "delta" || key === "content" || key === "text") {
    return CONTROLLED_TEXT.has(value) ? value : STRING_OMITTED_MARKER;
  }
  if (CONTROLLED_TEXT.has(value)) return value;
  return STRING_OMITTED_MARKER;
}

function sanitizeString(
  value: string,
  key: string,
  context: WalkContext,
  state: OrdinalState,
): Result<unknown, CaptureFailure> {
  if (containsForbiddenContent(value)) return err(blocked("forbidden-content"));
  if (
    TOOL_ID_KEYS.has(key) ||
    (key === "id" &&
      (context.type === "toolCall" || context.toolName !== undefined))
  ) {
    return ok(ordinalToolCallId(value, state));
  }
  if (GENERIC_ID_KEYS.has(key)) return ok(ordinalGenericId(value, state));
  const byteLength = utf8Bytes(value);
  if (byteLength > MAX_CAPTURE_STRING_BYTES) {
    return ok({
      marker: STRING_TRUNCATED_MARKER,
      byteLength: Math.min(byteLength, MAX_CAPTURE_TOTAL_BYTES),
      previewBytes: Math.min(byteLength, MAX_CAPTURE_PREVIEW_BYTES),
      truncated: true,
    });
  }
  return ok(stringMarkerFor(value, key, context));
}

function sanitizeWalk(
  value: unknown,
  depth: number,
  state: OrdinalState,
  context: WalkContext,
): Result<unknown, CaptureFailure> {
  if (depth > MAX_CAPTURE_DEPTH) return err(blocked("bounds-exceeded"));
  if (typeof value === "string") {
    return sanitizeString(value, context.key ?? "", context, state);
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      return err(blocked("sanitization-failed"));
    }
    return ok(value);
  }
  if (
    typeof value === "undefined" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return err(blocked("sanitization-failed"));
  }

  const arrayResult = isArray(value);
  if (arrayResult.isErr()) return err(arrayResult.error);
  if (arrayResult.value) {
    const array = value as readonly unknown[];
    const length = arrayLength(array);
    if (length.isErr()) return err(length.error);
    if (length.value > MAX_CAPTURE_ARRAY_LENGTH) {
      return err(blocked("bounds-exceeded"));
    }
    const output: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const member = ownEnumerableDataValue(array, String(index));
      if (member.isErr()) return err(member.error);
      if (member.value === ABSENT) return err(blocked("sanitization-failed"));
      const sanitized = sanitizeWalk(member.value, depth + 1, state, context);
      if (sanitized.isErr()) return sanitized;
      output.push(sanitized.value);
    }
    return ok(output);
  }
  if (!isRecord(value)) return err(blocked("sanitization-failed"));

  const keys = ownKeys(value);
  if (keys.isErr()) return err(keys.error);
  if (keys.value.length > MAX_CAPTURE_KEYS)
    return err(blocked("bounds-exceeded"));
  const symbolKeys = Result.fromThrowable(
    () => Object.getOwnPropertySymbols(value),
    () => blocked("sanitization-failed"),
  )();
  if (symbolKeys.isErr()) return err(symbolKeys.error);
  const enumerableSymbol = Result.fromThrowable(
    () =>
      symbolKeys.value.some((symbol) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, symbol);
        return descriptor?.enumerable === true;
      }),
    () => blocked("sanitization-failed"),
  )();
  if (enumerableSymbol.isErr()) return err(enumerableSymbol.error);
  if (enumerableSymbol.value) {
    return err(blocked("sanitization-failed"));
  }

  const rawValues = new Map<string, unknown>();
  for (const key of keys.value) {
    const member = ownEnumerableDataValue(value, key);
    if (member.isErr()) return err(member.error);
    if (member.value === ABSENT) return err(blocked("sanitization-failed"));
    rawValues.set(key, member.value);
  }
  const recordType =
    typeof rawValues.get("type") === "string"
      ? (rawValues.get("type") as string)
      : context.type;
  const recordRole =
    typeof rawValues.get("role") === "string"
      ? (rawValues.get("role") as string)
      : context.role;
  const recordToolName =
    typeof rawValues.get("toolName") === "string"
      ? (rawValues.get("toolName") as string)
      : context.toolName;
  const recordContext: WalkContext = {
    ...context,
    type: recordType,
    role: recordRole,
    toolName: recordToolName,
    eventType: context.eventType ?? recordType,
  };

  const output: Record<string, unknown> = {};
  for (const key of keys.value) {
    const raw = rawValues.get(key);
    if (raw === undefined) return err(blocked("sanitization-failed"));
    if (key === "timestamp") {
      output[key] = 0;
      continue;
    }
    const child: WalkContext = {
      ...recordContext,
      key,
      eventType:
        recordContext.eventType ??
        (typeof rawValues.get("type") === "string"
          ? (rawValues.get("type") as string)
          : undefined),
    };
    const sanitized = sanitizeWalk(raw, depth + 1, state, child);
    if (sanitized.isErr()) return sanitized;
    output[key] = sanitized.value;
  }
  return ok(output);
}

export interface SanitizerState {
  readonly ordinals: OrdinalState;
}

function serializedBytes(value: unknown): Result<number, CaptureFailure> {
  const rendered = Result.fromThrowable(
    () => JSON.stringify(value),
    () => blocked("sanitization-failed"),
  )();
  if (rendered.isErr() || rendered.value === undefined) {
    return err(
      rendered.isErr() ? rendered.error : blocked("sanitization-failed"),
    );
  }
  return ok(utf8Bytes(rendered.value));
}

/** Sanitize one already-omitted event while preserving cross-event ordinals. */
export function sanitizeRawEventWithState(
  rawEvent: unknown,
  ordinalId: number,
  state: SanitizerState,
): Result<SanitizedEvent, CaptureFailure> {
  if (!isRecord(rawEvent)) return err(blocked("sanitization-failed"));
  const typeRead = ownEnumerableDataValue(rawEvent, "type");
  if (typeRead.isErr()) return err(typeRead.error);
  if (typeof typeRead.value !== "string" || typeRead.value.length === 0) {
    return err(blocked("sanitization-failed"));
  }
  const omitted = omitReasoningProse(rawEvent);
  if (omitted.isErr()) return err(omitted.error);
  const sanitized = sanitizeWalk(omitted.value, 0, state.ordinals, {
    key: "event",
    eventType: typeRead.value,
  });
  if (sanitized.isErr()) return err(sanitized.error);
  if (!isRecord(sanitized.value)) return err(blocked("sanitization-failed"));
  const payload = sanitized.value;
  if (payload.type !== typeRead.value)
    return err(blocked("sanitization-failed"));
  const bytes = serializedBytes(payload);
  if (bytes.isErr()) return err(bytes.error);
  state.ordinals.totalBytes += bytes.value;
  if (state.ordinals.totalBytes > MAX_CAPTURE_TOTAL_BYTES) {
    return err(blocked("bounds-exceeded"));
  }
  return ok({ ordinalId, eventType: typeRead.value, payload });
}

/** Sanitize one already-omitted event. The mutable map keeps ordinals stable. */
export function sanitizeRawEvent(
  rawEvent: unknown,
  ordinalId: number,
  toolCallIds: ReadonlyMap<string, string> = new Map(),
): Result<SanitizedEvent, CaptureFailure> {
  return sanitizeRawEventWithState(rawEvent, ordinalId, {
    ordinals: createOrdinalState(toolCallIds),
  });
}

/** Sanitize a whole in-memory capture before any caller may write it. */
export function sanitizeRawEvents(
  rawEvents: readonly unknown[],
): Result<readonly SanitizedEvent[], CaptureFailure> {
  if (rawEvents.length === 0) return err(blocked("capture-timeout"));
  if (rawEvents.length > MAX_CAPTURE_EVENTS)
    return err(blocked("bounds-exceeded"));
  const state: SanitizerState = { ordinals: createOrdinalState() };
  const events: SanitizedEvent[] = [];
  for (let index = 0; index < rawEvents.length; index += 1) {
    const sanitized = sanitizeRawEventWithState(rawEvents[index], index, state);
    if (sanitized.isErr()) return err(sanitized.error);
    events.push(sanitized.value);
  }
  return ok(events);
}
