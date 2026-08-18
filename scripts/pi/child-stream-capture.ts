import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { renderOverlayPiNative } from "../../packages/adapters/pi/src/child-overlay-pi-native.js";
import { redactProviderErrorFromEvent } from "../../packages/adapters/pi/src/child-provider-error.js";
import {
  parsePiChildSessionEvent,
  retainedChildSessionEvent,
} from "../../packages/adapters/pi/src/child-session-events.js";
import {
  createPiChildTranscriptState,
  reducePiChildTranscript,
} from "../../packages/adapters/pi/src/child-transcript.js";
import { readArtifactSha256 } from "../../packages/adapters/pi/src/extension-build-identity.js";
import { messageUpdateObservesRawReasoning } from "../../packages/adapters/pi/src/message-update-carrier.js";
import { plainPaint } from "../../packages/adapters/pi/src/ui-paint.js";

// ---------------------------------------------------------------------------
// Capture identity and bounds
// ---------------------------------------------------------------------------

export const FIXTURE_SCHEMA_VERSION = 1 as const;
export const MANIFEST_SCHEMA_VERSION = 1 as const;
export const SANITIZER_VERSION = "1.1.0" as const;
export const REQUIRED_PI_VERSION = "0.84.2" as const;

export const MAX_CAPTURE_EVENTS = 1_000;
export const MAX_CAPTURE_DEPTH = 32;
export const MAX_CAPTURE_KEYS = 128;
export const MAX_CAPTURE_ARRAY_LENGTH = 256;
export const MAX_CAPTURE_STRING_BYTES = 4_096;
export const MAX_CAPTURE_PREVIEW_BYTES = 512;
export const MAX_CAPTURE_TOTAL_BYTES = 512 * 1024;

const CAPTURE_TIMEOUT_MS = 45_000;
const CAPTURE_KILL_WAIT_MS = 1_000;
const CAPTURE_PROMPT_TEXT = "go";
const CAPTURE_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const CAPTURE_PI_AI_PACKAGE_NAME = "@earendil-works/pi-ai";

/** The value written in place of every thinking string before sanitization. */
export const REASONING_OMITTED_MARKER = "<reasoning-omitted>" as const;
/** User prompts are structure, not fixture content. */
export const PROMPT_OMITTED_MARKER = "<prompt-omitted>" as const;
/** Unknown host text is never copied into the fixture. */
export const STRING_OMITTED_MARKER = "<string-omitted>" as const;
/** Provider metadata is structure-only in the fixture. */
export const PROVIDER_VALUE_OMITTED_MARKER =
  "<provider-value-omitted>" as const;
export const STRING_TRUNCATED_MARKER = "<string-truncated>" as const;

const RETAINED_EVENT_TYPES: ReadonlySet<string> = new Set([
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

const THINKING_EVENT_TYPES: ReadonlySet<string> = new Set([
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

const CAPTURE_BOUNDS = Object.freeze({
  maxEvents: MAX_CAPTURE_EVENTS,
  maxDepth: MAX_CAPTURE_DEPTH,
  maxKeys: MAX_CAPTURE_KEYS,
  maxArrayLength: MAX_CAPTURE_ARRAY_LENGTH,
  maxStringBytes: MAX_CAPTURE_STRING_BYTES,
  maxPreviewBytes: MAX_CAPTURE_PREVIEW_BYTES,
  maxTotalBytes: MAX_CAPTURE_TOTAL_BYTES,
});

export interface CaptureManifestBounds {
  readonly maxEvents: number;
  readonly maxDepth: number;
  readonly maxKeys: number;
  readonly maxArrayLength: number;
  readonly maxStringBytes: number;
  readonly maxPreviewBytes: number;
  readonly maxTotalBytes: number;
}

export type CaptureFailureType =
  | "invalid-args"
  | "pi-version-mismatch"
  | "pi-ai-unavailable"
  | "workspace-failed"
  | "spawn-failed"
  | "capture-timeout"
  | "bounds-exceeded"
  | "forbidden-content"
  | "sanitization-failed"
  | "fixture-exists"
  | "write-failed";

export interface CaptureFailure {
  readonly type: CaptureFailureType;
  readonly evidence: "blocked";
}

function blocked(type: CaptureFailureType): CaptureFailure {
  return { type, evidence: "blocked" };
}

export type FixtureValidationFailureType =
  | "manifest-corrupt"
  | "fixture-corrupt"
  | "missing-text-delta"
  | "broken-tool-correlation"
  | "malformed-thinking-lifecycle";

export interface FixtureValidationFailure {
  readonly type: FixtureValidationFailureType;
  readonly evidence: "blocked";
}

function invalidFixture(
  type: FixtureValidationFailureType,
): FixtureValidationFailure {
  return { type, evidence: "blocked" };
}

export interface SanitizedEvent {
  readonly ordinalId: number;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface CaptureFixture {
  readonly schemaVersion: typeof FIXTURE_SCHEMA_VERSION;
  readonly events: readonly SanitizedEvent[];
}

export interface CaptureManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  readonly sanitizerVersion: typeof SANITIZER_VERSION;
  readonly piVersion: string;
  readonly piExecutableSha256: string;
  readonly piPackageSha256: string;
  readonly piAiVersion: string;
  readonly piAiPackageSha256: string;
  readonly eventCount: number;
  readonly fixtureBytes: number;
  readonly captureTimeMs: number;
  readonly captureCompletedAt: string;
  readonly fixtureSha256: string;
  readonly omitReasoningContent: true;
  readonly idEncoding: "ordinals";
  readonly bounds: CaptureManifestBounds;
}

export interface CaptureSuccess {
  readonly fixturePath: string;
  readonly manifestPath: string;
  readonly eventCount: number;
  readonly captureDurationMs: number;
  readonly fixtureSha256: string;
}

// ---------------------------------------------------------------------------
// Small safe primitives
// ---------------------------------------------------------------------------

const ABSENT = Symbol("absent");

type SafeRead = Result<unknown | typeof ABSENT, CaptureFailure>;

function isRecord(value: unknown): value is Record<string, unknown> {
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

function utf8Bytes(value: string): number {
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

interface OrdinalState {
  readonly toolCallIds: Map<string, string>;
  readonly genericIds: Map<string, string>;
  nextToolOrdinal: number;
  nextGenericOrdinal: number;
  totalBytes: number;
}

function createOrdinalState(
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

interface SanitizerState {
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

function sanitizeRawEventWithState(
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

// ---------------------------------------------------------------------------
// Fixture and manifest serialization / independent verification
// ---------------------------------------------------------------------------

export function serializeFixture(events: readonly SanitizedEvent[]): string {
  return `${JSON.stringify(
    { schemaVersion: FIXTURE_SCHEMA_VERSION, events } satisfies CaptureFixture,
    null,
    2,
  )}\n`;
}

export function buildCaptureManifest(input: {
  readonly piVersion: string;
  readonly piExecutableSha256: string;
  readonly piPackageSha256: string;
  readonly piAiVersion: string;
  readonly piAiPackageSha256: string;
  readonly eventCount: number;
  readonly fixtureBytes: number;
  readonly captureTimeMs: number;
  readonly fixtureSha256: string;
  readonly captureCompletedAt?: string;
}): CaptureManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    sanitizerVersion: SANITIZER_VERSION,
    piVersion: input.piVersion,
    piExecutableSha256: input.piExecutableSha256,
    piPackageSha256: input.piPackageSha256,
    piAiVersion: input.piAiVersion,
    piAiPackageSha256: input.piAiPackageSha256,
    eventCount: input.eventCount,
    fixtureBytes: input.fixtureBytes,
    captureTimeMs: input.captureTimeMs,
    captureCompletedAt: input.captureCompletedAt ?? new Date().toISOString(),
    fixtureSha256: input.fixtureSha256,
    omitReasoningContent: true,
    idEncoding: "ordinals",
    bounds: CAPTURE_BOUNDS,
  };
}

function parseJson(
  text: string,
  failure: FixtureValidationFailureType,
): Result<unknown, FixtureValidationFailure> {
  return Result.fromThrowable(
    () => JSON.parse(text) as unknown,
    () => invalidFixture(failure),
  )();
}

function parseCaptureFixture(
  text: string,
): Result<CaptureFixture, FixtureValidationFailure> {
  const parsed = parseJson(text, "fixture-corrupt");
  if (parsed.isErr()) return err(parsed.error);
  if (!isRecord(parsed.value)) return err(invalidFixture("fixture-corrupt"));
  if (parsed.value.schemaVersion !== FIXTURE_SCHEMA_VERSION) {
    return err(invalidFixture("fixture-corrupt"));
  }
  const events = parsed.value.events;
  if (!Array.isArray(events) || events.length > MAX_CAPTURE_EVENTS) {
    return err(invalidFixture("fixture-corrupt"));
  }
  let expectedOrdinal = 0;
  for (const event of events) {
    if (
      !isRecord(event) ||
      event.ordinalId !== expectedOrdinal ||
      typeof event.eventType !== "string" ||
      !isRecord(event.payload) ||
      event.payload.type !== event.eventType
    ) {
      return err(invalidFixture("fixture-corrupt"));
    }
    expectedOrdinal += 1;
  }
  return ok({
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    events: events as unknown as readonly SanitizedEvent[],
  });
}

function parseCaptureManifest(
  text: string,
): Result<CaptureManifest, FixtureValidationFailure> {
  const parsed = parseJson(text, "manifest-corrupt");
  if (parsed.isErr()) return err(parsed.error);
  if (!isRecord(parsed.value)) return err(invalidFixture("manifest-corrupt"));
  const value = parsed.value;
  const bounds = value.bounds;
  if (
    value.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    value.sanitizerVersion !== SANITIZER_VERSION ||
    value.piVersion !== REQUIRED_PI_VERSION ||
    typeof value.piExecutableSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.piExecutableSha256) ||
    typeof value.piPackageSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.piPackageSha256) ||
    value.piAiVersion !== REQUIRED_PI_VERSION ||
    typeof value.piAiPackageSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.piAiPackageSha256) ||
    typeof value.eventCount !== "number" ||
    !Number.isSafeInteger(value.eventCount) ||
    value.eventCount < 1 ||
    typeof value.fixtureBytes !== "number" ||
    !Number.isSafeInteger(value.fixtureBytes) ||
    value.fixtureBytes < 1 ||
    typeof value.captureTimeMs !== "number" ||
    !Number.isSafeInteger(value.captureTimeMs) ||
    value.captureTimeMs < 0 ||
    typeof value.captureCompletedAt !== "string" ||
    !Number.isFinite(Date.parse(value.captureCompletedAt)) ||
    typeof value.fixtureSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.fixtureSha256) ||
    value.omitReasoningContent !== true ||
    value.idEncoding !== "ordinals" ||
    !isRecord(bounds) ||
    JSON.stringify(bounds) !== JSON.stringify(CAPTURE_BOUNDS)
  ) {
    return err(invalidFixture("manifest-corrupt"));
  }
  return ok(value as unknown as CaptureManifest);
}

function containsRawReasoningShape(value: unknown, depth = 0): boolean {
  if (depth > MAX_CAPTURE_DEPTH) return true;
  if (typeof value === "string") return false;
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value))
    return value.some((item) => containsRawReasoningShape(item, depth + 1));
  if (!isRecord(value)) return true;
  const type = typeof value.type === "string" ? value.type : undefined;
  if (type === "thinking" || type === "reasoning") {
    for (const [key, member] of Object.entries(value)) {
      if (key !== "type" && typeof member === "string") return true;
    }
  }
  if (THINKING_EVENT_TYPES.has(type ?? "")) {
    for (const key of ["delta", "content", "text"]) {
      if (typeof value[key] === "string") return true;
    }
  }
  for (const [key, member] of Object.entries(value)) {
    if (
      (key === "thinking" || key === "reasoning") &&
      typeof member === "string"
    ) {
      return true;
    }
    if (containsRawReasoningShape(member, depth + 1)) return true;
  }
  return false;
}

function reasoningMarkerFacts(
  value: unknown,
  depth = 0,
): { readonly hasMarker: boolean; readonly valid: boolean } {
  if (depth > MAX_CAPTURE_DEPTH) return { hasMarker: false, valid: false };
  if (value === null || typeof value !== "object") {
    return { hasMarker: false, valid: true };
  }
  if (Array.isArray(value)) {
    let hasMarker = false;
    let valid = true;
    for (const item of value) {
      const next = reasoningMarkerFacts(item, depth + 1);
      hasMarker ||= next.hasMarker;
      valid &&= next.valid;
    }
    return { hasMarker, valid };
  }
  if (!isRecord(value)) return { hasMarker: false, valid: false };
  const marker = value.marker;
  const isMarker = marker === REASONING_OMITTED_MARKER;
  if (isMarker) {
    return {
      hasMarker: true,
      valid:
        typeof value.byteLength === "number" &&
        Number.isSafeInteger(value.byteLength) &&
        value.byteLength >= 0 &&
        value.byteLength <= MAX_CAPTURE_TOTAL_BYTES &&
        typeof value.lineCount === "number" &&
        Number.isSafeInteger(value.lineCount) &&
        value.lineCount >= 0 &&
        value.lineCount <= MAX_CAPTURE_TOTAL_BYTES &&
        typeof value.truncated === "boolean",
    };
  }
  let hasMarker = false;
  let valid = true;
  for (const item of Object.values(value)) {
    const next = reasoningMarkerFacts(item, depth + 1);
    hasMarker ||= next.hasMarker;
    valid &&= next.valid;
  }
  return { hasMarker, valid };
}

function contentFreeFixture(
  fixtureText: string,
  fixture: CaptureFixture,
): boolean {
  if (containsForbiddenContent(fixtureText)) return false;
  if (fixtureText.includes("SYNTHETIC-CONTROLLED-REASONING-")) return false;
  if (containsRawReasoningShape(fixture)) return false;
  const markers = reasoningMarkerFacts(fixture);
  return markers.hasMarker && markers.valid;
}

/** Independently hashes and validates the immutable fixture + sidecar pair. */
export function verifyCaptureManifest(
  fixtureText: string,
  manifestText: string,
): Result<
  { readonly fixture: CaptureFixture; readonly manifest: CaptureManifest },
  FixtureValidationFailure
> {
  const manifest = parseCaptureManifest(manifestText);
  if (manifest.isErr()) return err(manifest.error);
  const fixture = parseCaptureFixture(fixtureText);
  if (fixture.isErr()) return err(fixture.error);
  const fixtureBytes = utf8Bytes(fixtureText);
  if (
    fixtureBytes > MAX_CAPTURE_TOTAL_BYTES ||
    !contentFreeFixture(fixtureText, fixture.value) ||
    sha256HexOfText(fixtureText) !== manifest.value.fixtureSha256 ||
    fixtureBytes !== manifest.value.fixtureBytes ||
    fixture.value.events.length !== manifest.value.eventCount
  ) {
    return err(invalidFixture("fixture-corrupt"));
  }
  return ok({ fixture: fixture.value, manifest: manifest.value });
}

// ---------------------------------------------------------------------------
// Structural validation and red controls
// ---------------------------------------------------------------------------

export interface FixtureStructuralFacts {
  readonly hasThinkingLifecycle: boolean;
  readonly hasTextDelta: boolean;
  readonly textDeltaCount: number;
  readonly toolCorrelationCount: number;
  readonly hasReadTool: boolean;
  readonly hasBashTool: boolean;
}

function assistantEvent(
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return isRecord(payload.assistantMessageEvent)
    ? payload.assistantMessageEvent
    : undefined;
}

function assistantEventType(
  payload: Record<string, unknown>,
): string | undefined {
  const event = assistantEvent(payload);
  return typeof event?.type === "string" ? event.type : undefined;
}

/** Validates lifecycle ordering, answer deltas, and authoritative tool ids. */
export function validateFixtureStructure(
  fixture: CaptureFixture,
): Result<FixtureStructuralFacts, FixtureValidationFailure> {
  const thinkingState = new Map<number, "started" | "delta-seen">();
  let thinkingTriplesCompleted = 0;
  let textDeltaCount = 0;
  let textStarted = false;
  let textEnded = false;

  for (const event of fixture.events) {
    if (event.eventType !== "message_update") continue;
    const type = assistantEventType(event.payload);
    if (type === "text_start") {
      if (textStarted || textEnded)
        return err(invalidFixture("missing-text-delta"));
      textStarted = true;
    }
    if (type === "text_delta") {
      if (!textStarted || textEnded)
        return err(invalidFixture("missing-text-delta"));
      textDeltaCount += 1;
    }
    if (type === "text_end") {
      if (!textStarted || textDeltaCount === 0 || textEnded) {
        return err(invalidFixture("missing-text-delta"));
      }
      textEnded = true;
    }
    if (type === undefined || !THINKING_EVENT_TYPES.has(type)) continue;
    const eventValue = assistantEvent(event.payload);
    const contentIndex = eventValue?.contentIndex;
    if (typeof contentIndex !== "number") {
      return err(invalidFixture("malformed-thinking-lifecycle"));
    }
    const state = thinkingState.get(contentIndex);
    if (type === "thinking_start") {
      if (state !== undefined)
        return err(invalidFixture("malformed-thinking-lifecycle"));
      thinkingState.set(contentIndex, "started");
    } else if (type === "thinking_delta") {
      if (state === undefined)
        return err(invalidFixture("malformed-thinking-lifecycle"));
      thinkingState.set(contentIndex, "delta-seen");
    } else {
      if (state !== "delta-seen")
        return err(invalidFixture("malformed-thinking-lifecycle"));
      thinkingState.delete(contentIndex);
      thinkingTriplesCompleted += 1;
    }
  }
  if (thinkingState.size > 0 || thinkingTriplesCompleted === 0) {
    return err(invalidFixture("malformed-thinking-lifecycle"));
  }
  if (!textStarted || textDeltaCount < 2 || !textEnded) {
    return err(invalidFixture("missing-text-delta"));
  }

  const started = new Set<string>();
  const terminal = new Set<string>();
  let hasReadTool = false;
  let hasBashTool = false;
  for (const event of fixture.events) {
    if (event.eventType === "tool_execution_start") {
      const id = event.payload.toolCallId;
      const name = event.payload.toolName;
      if (
        typeof id !== "string" ||
        typeof name !== "string" ||
        started.has(id)
      ) {
        return err(invalidFixture("broken-tool-correlation"));
      }
      started.add(id);
      hasReadTool ||= name === "read";
      hasBashTool ||= name === "bash";
      continue;
    }
    if (
      event.eventType === "tool_execution_update" ||
      event.eventType === "tool_execution_end"
    ) {
      const id = event.payload.toolCallId;
      if (typeof id !== "string" || !started.has(id) || terminal.has(id)) {
        return err(invalidFixture("broken-tool-correlation"));
      }
      if (event.eventType === "tool_execution_end") terminal.add(id);
    }
  }
  if (
    started.size === 0 ||
    terminal.size !== started.size ||
    !hasReadTool ||
    !hasBashTool
  ) {
    return err(invalidFixture("broken-tool-correlation"));
  }
  return ok({
    hasThinkingLifecycle: thinkingTriplesCompleted > 0,
    hasTextDelta: textDeltaCount > 0,
    textDeltaCount,
    toolCorrelationCount: terminal.size,
    hasReadTool,
    hasBashTool,
  });
}

/** Applies corruption, omission, correlation, and lifecycle red controls. */
export function runFixtureRedControls(
  fixtureText: string,
  manifestText: string,
): Result<
  Readonly<Record<FixtureValidationFailureType, true>>,
  {
    readonly mutation: FixtureValidationFailureType;
    readonly reason: "not-rejected" | "base-fixture-invalid";
  }
> {
  const base = verifyCaptureManifest(fixtureText, manifestText);
  if (base.isErr()) {
    return err({ mutation: base.error.type, reason: "base-fixture-invalid" });
  }
  const structural = validateFixtureStructure(base.value.fixture);
  if (structural.isErr()) {
    return err({
      mutation: structural.error.type,
      reason: "base-fixture-invalid",
    });
  }
  const events = base.value.fixture.events;

  const missingText = validateFixtureStructure({
    ...base.value.fixture,
    events: events.filter(
      (event) => assistantEventType(event.payload) !== "text_delta",
    ),
  });
  if (!missingText.isErr() || missingText.error.type !== "missing-text-delta") {
    return err({ mutation: "missing-text-delta", reason: "not-rejected" });
  }

  const brokenCorrelation = validateFixtureStructure({
    ...base.value.fixture,
    events: events.map((event) =>
      event.eventType === "tool_execution_end"
        ? {
            ...event,
            payload: { ...event.payload, toolCallId: "tool-call-unknown" },
          }
        : event,
    ),
  });
  if (
    !brokenCorrelation.isErr() ||
    brokenCorrelation.error.type !== "broken-tool-correlation"
  ) {
    return err({ mutation: "broken-tool-correlation", reason: "not-rejected" });
  }

  let droppedStart = false;
  const malformedThinking = validateFixtureStructure({
    ...base.value.fixture,
    events: events.filter((event) => {
      if (
        !droppedStart &&
        assistantEventType(event.payload) === "thinking_start"
      ) {
        droppedStart = true;
        return false;
      }
      return true;
    }),
  });
  if (
    !malformedThinking.isErr() ||
    malformedThinking.error.type !== "malformed-thinking-lifecycle"
  ) {
    return err({
      mutation: "malformed-thinking-lifecycle",
      reason: "not-rejected",
    });
  }

  const corruptFixture = verifyCaptureManifest(
    `${fixtureText.slice(0, -1)}${fixtureText.endsWith("\n") ? " " : "\n"}`,
    manifestText,
  );
  if (
    !corruptFixture.isErr() ||
    corruptFixture.error.type !== "fixture-corrupt"
  ) {
    return err({ mutation: "fixture-corrupt", reason: "not-rejected" });
  }

  const parsedManifest = parseJson(manifestText, "manifest-corrupt");
  if (parsedManifest.isErr() || !isRecord(parsedManifest.value)) {
    return err({ mutation: "manifest-corrupt", reason: "not-rejected" });
  }
  const corruptManifest = verifyCaptureManifest(
    fixtureText,
    `${JSON.stringify({ ...parsedManifest.value, schemaVersion: 99 }, null, 2)}\n`,
  );
  if (
    !corruptManifest.isErr() ||
    corruptManifest.error.type !== "manifest-corrupt"
  ) {
    return err({ mutation: "manifest-corrupt", reason: "not-rejected" });
  }

  return ok({
    "missing-text-delta": true,
    "broken-tool-correlation": true,
    "malformed-thinking-lifecycle": true,
    "fixture-corrupt": true,
    "manifest-corrupt": true,
  });
}

// ---------------------------------------------------------------------------
// Public-adapter replay
// ---------------------------------------------------------------------------

export interface ReplayFacts {
  readonly reasoningObserved: boolean;
  readonly assistantAnswerText: string | undefined;
  readonly assistantDeltaCount: number;
  readonly toolRowCount: number;
  readonly renderedLines: readonly string[];
  readonly syntheticReasoningLeaked: boolean;
  readonly parentRawReasoningLaneAvailable: boolean;
  readonly inspectorRawReasoningLaneAvailable: boolean;
  readonly inspectorToolDetailsLaneAvailable: boolean;
  readonly inspectorAssistantReplyLaneAvailable: boolean;
}

const SYNTHETIC_REASONING_PREFIX = "SYNTHETIC-CONTROLLED-REASONING-";

/** Clone only the carrier that receives the controlled in-memory test text. */
export function injectControlledReasoningInMemory(
  payload: Record<string, unknown>,
  ordinalId: number,
): Record<string, unknown> {
  const event = isRecord(payload.assistantMessageEvent)
    ? payload.assistantMessageEvent
    : undefined;
  if (event === undefined || !THINKING_EVENT_TYPES.has(String(event.type))) {
    return payload;
  }
  const key = event.type === "thinking_delta" ? "delta" : "content";
  return {
    ...payload,
    assistantMessageEvent: {
      ...event,
      [key]: `${SYNTHETIC_REASONING_PREFIX}${ordinalId}`,
    },
  };
}

function replayPayload(
  event: SanitizedEvent,
  injectReasoning: boolean,
): Record<string, unknown> {
  if (!injectReasoning) return { ...event.payload };
  return injectControlledReasoningInMemory(
    { ...event.payload },
    event.ordinalId,
  );
}

/** Replay the captured structure through the production parser and reducer. */
export function replayFixtureThroughAdapter(
  fixture: CaptureFixture,
  options: { readonly injectControlledReasoningInMemory?: boolean } = {},
): Result<ReplayFacts, FixtureValidationFailure> {
  const structural = validateFixtureStructure(fixture);
  if (structural.isErr()) return err(structural.error);
  let state = createPiChildTranscriptState();
  let reasoningObserved = false;
  let assistantDeltaCount = 0;

  for (const event of fixture.events) {
    const payload = replayPayload(
      event,
      options.injectControlledReasoningInMemory === true,
    );
    if (event.eventType === "message_update") {
      reasoningObserved ||= messageUpdateObservesRawReasoning(payload);
      const eventType = assistantEventType(payload);
      if (eventType === "text_delta") assistantDeltaCount += 1;
    }
    const parsed = parsePiChildSessionEvent(payload);
    if (!parsed.success) return err(invalidFixture("fixture-corrupt"));
    const retained = retainedChildSessionEvent(parsed.data);
    if (retained === undefined) continue;
    const next = reducePiChildTranscript(state, {
      kind: "event",
      event: redactProviderErrorFromEvent(retained),
    });
    if (next.isErr()) return err(invalidFixture("fixture-corrupt"));
    state = next.value;
  }

  const rendered = renderOverlayPiNative(
    plainPaint(),
    { entries: state.entries, childName: "capture-replay", settled: true },
    96,
  );
  const renderedLines = rendered.plain.map((line) => line.replace(/\s+$/u, ""));
  const joined = renderedLines.join("\n");
  let toolRowCount = 0;
  for (const line of renderedLines) if (/^⚙ /u.test(line)) toolRowCount += 1;

  const answerTexts = fixture.events
    .filter(
      (event) =>
        event.eventType === "message_end" && isRecord(event.payload.message),
    )
    .flatMap((event) => {
      const message = event.payload.message as Record<string, unknown>;
      if (message.role !== "assistant" || !Array.isArray(message.content))
        return [];
      return message.content.flatMap((block) => {
        if (
          !isRecord(block) ||
          block.type !== "text" ||
          typeof block.text !== "string"
        ) {
          return [];
        }
        return [block.text];
      });
    });
  const assistantAnswerText = answerTexts.at(-1);

  return ok({
    reasoningObserved,
    assistantAnswerText,
    assistantDeltaCount,
    toolRowCount,
    renderedLines,
    syntheticReasoningLeaked: joined.includes(SYNTHETIC_REASONING_PREFIX),
    parentRawReasoningLaneAvailable: structural.value.hasThinkingLifecycle,
    inspectorRawReasoningLaneAvailable: structural.value.hasThinkingLifecycle,
    inspectorToolDetailsLaneAvailable:
      structural.value.toolCorrelationCount > 0,
    inspectorAssistantReplyLaneAvailable:
      structural.value.textDeltaCount > 0 && assistantAnswerText !== undefined,
  });
}

// ---------------------------------------------------------------------------
// Real Pi 0.84.2 RPC capture
// ---------------------------------------------------------------------------

/**
 * This extension is loaded with Pi's public `-e` option. Its deterministic
 * provider emits real pi-ai assistant events; Pi then performs the built-in
 * read and bash calls and publishes the resulting RPC JSONL events.
 */
const DETERMINISTIC_EXTENSION_SOURCE = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";

export default function (pi: ExtensionAPI) {
  let turn = 0;

  pi.registerProvider("weave-capture-deterministic", {
    name: "Weave Capture Deterministic",
    baseUrl: "http://127.0.0.1:0",
    apiKey: "unused",
    api: "openai-completions",
    models: [{
      id: "capture-deterministic-1",
      name: "Weave Capture Deterministic Model",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }],
    streamSimple(model: any, _context: any) {
      turn += 1;
      const thisTurn = turn;
      const stream = createAssistantMessageEventStream();
      const output: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "pending",
        timestamp: Date.now(),
      };
      (async () => {
        stream.push({ type: "start", partial: output });
        const thinkingText = String(thisTurn);
        output.content.push({ type: "thinking", thinking: thinkingText });
        const thinkIdx = output.content.length - 1;
        stream.push({ type: "thinking_start", contentIndex: thinkIdx, partial: output });
        (output.content[thinkIdx] as any).thinking = thinkingText;
        stream.push({ type: "thinking_delta", contentIndex: thinkIdx, delta: thinkingText, partial: output });
        stream.push({ type: "thinking_end", contentIndex: thinkIdx, content: thinkingText, partial: output });

        if (thisTurn === 1) {
          output.content.push({ type: "toolCall", id: "weave-capture-read-call", name: "read", arguments: {} });
          const idx = output.content.length - 1;
          stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
          const argsJson = JSON.stringify({ path: "weave-capture-sample.txt" });
          (output.content[idx] as any).arguments = { path: "weave-capture-sample.txt" };
          stream.push({ type: "toolcall_delta", contentIndex: idx, delta: argsJson, partial: output });
          stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: { type: "toolCall", id: "weave-capture-read-call", name: "read", arguments: { path: "weave-capture-sample.txt" } }, partial: output });
          output.stopReason = "toolUse";
        } else if (thisTurn === 2) {
          output.content.push({ type: "toolCall", id: "weave-capture-bash-call", name: "bash", arguments: {} });
          const idx = output.content.length - 1;
          stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
          const argsJson = JSON.stringify({ command: "echo weave-capture-ok" });
          (output.content[idx] as any).arguments = { command: "echo weave-capture-ok" };
          stream.push({ type: "toolcall_delta", contentIndex: idx, delta: argsJson, partial: output });
          stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: { type: "toolCall", id: "weave-capture-bash-call", name: "bash", arguments: { command: "echo weave-capture-ok" } }, partial: output });
          output.stopReason = "toolUse";
        } else {
          output.content.push({ type: "text", text: "" });
          const idx = output.content.length - 1;
          stream.push({ type: "text_start", contentIndex: idx, partial: output });
          for (const answer of ["Weave capture ", "deterministic final ", "answer."]) {
            (output.content[idx] as any).text += answer;
            stream.push({ type: "text_delta", contentIndex: idx, delta: answer, partial: output });
          }
          stream.push({ type: "text_end", contentIndex: idx, content: "Weave capture deterministic final answer.", partial: output });
          output.stopReason = "stop";
        }

        stream.push({ type: "done", reason: output.stopReason as any, message: output });
        stream.end();
      })();
      return stream;
    },
  });
}
`;

interface DeterministicCaptureWorkspace {
  readonly root: string;
  readonly extensionPath: string;
  readonly workspacePath: string;
}

function prepareWorkspace(): ResultAsync<
  DeterministicCaptureWorkspace,
  CaptureFailure
> {
  const root = join(tmpdir(), `weave-pi-capture-${crypto.randomUUID()}`);
  const extensionPath = join(root, "deterministic-extension.ts");
  const workspacePath = join(root, "workspace");
  return ResultAsync.fromPromise(
    $`mkdir -p ${workspacePath}`
      .quiet()
      .then(() => Bun.write(extensionPath, DETERMINISTIC_EXTENSION_SOURCE))
      .then(() =>
        Bun.write(
          join(workspacePath, "weave-capture-sample.txt"),
          "weave capture deterministic workspace file\n",
        ),
      )
      .then(() => ({ root, extensionPath, workspacePath })),
    () => blocked("workspace-failed"),
  ).orElse((failure) =>
    cleanupWorkspace(root).andThen(() => errAsync(failure)),
  );
}

function cleanupWorkspace(root: string): ResultAsync<void, CaptureFailure> {
  return ResultAsync.fromPromise($`rm -rf ${root}`.quiet(), () =>
    blocked("workspace-failed"),
  ).map(() => undefined);
}

function safeRuntimeEnvironment(): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (value === undefined) continue;
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE)/iu.test(key)) {
      continue;
    }
    output[key] = value;
  }
  return output;
}

function appendJsonlLine(
  buffer: string,
  chunk: string,
): {
  readonly buffer: string;
  readonly lines: readonly string[];
} {
  const combined = `${buffer}${chunk}`;
  const parts = combined.split("\n");
  const remainder = parts.pop() ?? "";
  return {
    buffer: remainder,
    lines: parts.map((line) =>
      line.endsWith("\r") ? line.slice(0, -1) : line,
    ),
  };
}

function verifyPiVersion(
  pi: string,
  requiredVersion: string,
): ResultAsync<string, CaptureFailure> {
  return ResultAsync.fromPromise(
    (async () => {
      const process = Bun.spawn({
        cmd: [pi, "--version"],
        stdout: "pipe",
        stderr: "pipe",
        env: safeRuntimeEnvironment(),
      });
      const stdout = process.stdout;
      if (stdout === undefined || typeof stdout === "number") {
        await process.exited;
        return "";
      }
      const version = await new Response(stdout).text();
      await process.exited;
      return version.trim();
    })(),
    () => blocked("spawn-failed"),
  ).andThen((version) =>
    version === requiredVersion || version.startsWith(`${requiredVersion} `)
      ? okAsync(version)
      : errAsync(blocked("pi-version-mismatch")),
  );
}

async function readDeterministicEvents(
  child: ReturnType<typeof Bun.spawn>,
): Promise<Result<readonly SanitizedEvent[], CaptureFailure>> {
  const stdout = child.stdout;
  if (stdout === undefined || typeof stdout === "number") {
    return err(blocked("spawn-failed"));
  }
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  const state: SanitizerState = { ordinals: createOrdinalState() };
  const events: SanitizedEvent[] = [];
  let buffer = "";
  let settled = false;
  const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
  try {
    while (!settled) {
      if (Date.now() > deadline) return err(blocked("capture-timeout"));
      const remainingMs = deadline - Date.now();
      const read = await Promise.race([
        reader.read(),
        new Promise<{ readonly timedOut: true }>((resolveTimeout) =>
          setTimeout(() => resolveTimeout({ timedOut: true }), remainingMs),
        ),
      ]);
      if ("timedOut" in read) return err(blocked("capture-timeout"));
      if (read.done) {
        return buffer.length === 0
          ? err(blocked("capture-timeout"))
          : err(blocked("sanitization-failed"));
      }
      const chunk = decoder.decode(read.value, { stream: true });
      if (utf8Bytes(buffer) + read.value.byteLength > MAX_CAPTURE_TOTAL_BYTES) {
        return err(blocked("bounds-exceeded"));
      }
      const decoded = appendJsonlLine(buffer, chunk);
      buffer = decoded.buffer;
      for (const line of decoded.lines) {
        if (line.length === 0) continue;
        const parsed = Result.fromThrowable(
          () => JSON.parse(line) as unknown,
          () => blocked("sanitization-failed"),
        )();
        if (parsed.isErr() || !isRecord(parsed.value)) {
          return err(
            parsed.isErr() ? parsed.error : blocked("sanitization-failed"),
          );
        }
        const eventType = parsed.value.type;
        if (typeof eventType !== "string")
          return err(blocked("sanitization-failed"));
        if (!RETAINED_EVENT_TYPES.has(eventType)) continue;
        if (events.length >= MAX_CAPTURE_EVENTS)
          return err(blocked("bounds-exceeded"));
        const sanitized = sanitizeRawEventWithState(
          parsed.value,
          events.length,
          state,
        );
        if (sanitized.isErr()) return err(sanitized.error);
        events.push(sanitized.value);
        if (eventType === "agent_settled") {
          settled = true;
          break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return settled ? ok(events) : err(blocked("capture-timeout"));
}

async function terminateChild(
  child: ReturnType<typeof Bun.spawn>,
): Promise<void> {
  Result.fromThrowable(
    () => child.kill("SIGTERM"),
    () => undefined,
  )();
  await Promise.race([
    child.exited,
    new Promise<void>((resolveDelay) =>
      setTimeout(resolveDelay, CAPTURE_KILL_WAIT_MS),
    ),
  ]);
  if (child.exitCode === null) {
    Result.fromThrowable(
      () => child.kill("SIGKILL"),
      () => undefined,
    )();
  }
}

function runDeterministicCapture(input: {
  readonly pi: string;
  readonly workspace: DeterministicCaptureWorkspace;
}): ResultAsync<readonly SanitizedEvent[], CaptureFailure> {
  return ResultAsync.fromPromise(
    (async () => {
      const child = Bun.spawn({
        cmd: [
          input.pi,
          "--mode",
          "rpc",
          "--no-session",
          "--no-extensions",
          "--no-context-files",
          "--no-skills",
          "--no-prompt-templates",
          "--offline",
          "-e",
          input.workspace.extensionPath,
          "--provider",
          "weave-capture-deterministic",
          "--model",
          "capture-deterministic-1",
        ],
        cwd: input.workspace.workspacePath,
        env: safeRuntimeEnvironment(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        const stdin = child.stdin;
        if (stdin === undefined || typeof stdin === "number") {
          return err(blocked("spawn-failed"));
        }
        stdin.write(
          `${JSON.stringify({ type: "prompt", message: CAPTURE_PROMPT_TEXT })}\n`,
        );
        return await readDeterministicEvents(child);
      } finally {
        await terminateChild(child);
      }
    })(),
    () => blocked("spawn-failed"),
  ).andThen((result) =>
    result.isOk() ? okAsync(result.value) : errAsync(result.error),
  );
}

interface PackageIdentity {
  readonly version: string;
  readonly sha256: string;
}

function packagePathCandidates(packageName: string): readonly string[] {
  const bunRoot = Bun.env.BUN_INSTALL ?? join(homedir(), ".bun");
  return [
    join(
      bunRoot,
      "install",
      "global",
      "node_modules",
      packageName,
      "package.json",
    ),
    join("node_modules", packageName, "package.json"),
  ];
}

function readPackageIdentity(
  packageName: string,
): ResultAsync<PackageIdentity, CaptureFailure> {
  const resolved = Result.fromThrowable(
    () => Bun.resolveSync(`${packageName}/package.json`, import.meta.dir),
    () => undefined,
  )();
  const candidates = [
    ...(resolved.isOk() ? [resolved.value] : []),
    ...packagePathCandidates(packageName),
  ];
  const readCandidate = (
    index: number,
  ): ResultAsync<PackageIdentity, CaptureFailure> => {
    const path = candidates[index];
    if (path === undefined) return errAsync(blocked("pi-ai-unavailable"));
    return ResultAsync.fromPromise(Bun.file(path).text(), () =>
      blocked("pi-ai-unavailable"),
    )
      .andThen((text) => {
        const parsed = Result.fromThrowable(
          () => JSON.parse(text) as unknown,
          () => blocked("pi-ai-unavailable"),
        )();
        if (
          parsed.isErr() ||
          !isRecord(parsed.value) ||
          typeof parsed.value.version !== "string"
        ) {
          return errAsync(
            parsed.isErr() ? parsed.error : blocked("pi-ai-unavailable"),
          );
        }
        return okAsync({
          version: parsed.value.version,
          sha256: sha256HexOfText(text),
        });
      })
      .orElse(() => readCandidate(index + 1));
  };
  return readCandidate(0);
}

function writeImmutableCapture(
  fixturePath: string,
  manifestPath: string,
  fixtureText: string,
  manifestText: string,
): ResultAsync<void, CaptureFailure> {
  return ResultAsync.fromPromise(
    Promise.all([
      Bun.file(fixturePath).exists(),
      Bun.file(manifestPath).exists(),
    ]),
    () => blocked("write-failed"),
  ).andThen(([fixtureExists, manifestExists]) => {
    if (fixtureExists || manifestExists)
      return errAsync(blocked("fixture-exists"));
    return ResultAsync.fromPromise(
      $`mkdir -p ${fixturePath.slice(0, fixturePath.lastIndexOf("/"))}`
        .quiet()
        .then(() => Bun.write(fixturePath, fixtureText))
        .then(() => Bun.write(manifestPath, manifestText))
        .then(() => undefined),
      () => blocked("write-failed"),
    );
  });
}

function withWorkspaceCleanup<T>(
  workspace: DeterministicCaptureWorkspace,
  operation: ResultAsync<T, CaptureFailure>,
): ResultAsync<T, CaptureFailure> {
  return operation
    .andThen((value) => cleanupWorkspace(workspace.root).map(() => value))
    .orElse((failure) =>
      cleanupWorkspace(workspace.root).andThen(() => errAsync(failure)),
    );
}

function resolveFixturePaths(input: {
  readonly fixtureDir: string;
  readonly fixtureBaseName: string;
}): { readonly fixturePath: string; readonly manifestPath: string } {
  return {
    fixturePath: join(input.fixtureDir, `${input.fixtureBaseName}.json`),
    manifestPath: join(
      input.fixtureDir,
      `${input.fixtureBaseName}.manifest.json`,
    ),
  };
}

/** Capture once from real Pi 0.84.2 and refuse to overwrite the fixture. */
export function captureChildEvents(input: {
  readonly pi: string;
  readonly requireHostVersion?: string;
  readonly fixtureDir: string;
  readonly fixtureBaseName?: string;
}): ResultAsync<CaptureSuccess, CaptureFailure> {
  const startedAt = Date.now();
  const requiredVersion = input.requireHostVersion ?? REQUIRED_PI_VERSION;
  const fixtureBaseName =
    input.fixtureBaseName ?? "pi-0.84.2-child-ui-events.v1";
  const paths = resolveFixturePaths({
    fixtureDir: input.fixtureDir,
    fixtureBaseName,
  });
  return verifyPiVersion(input.pi, requiredVersion)
    .andThen((piVersion) =>
      readPackageIdentity(CAPTURE_PI_AI_PACKAGE_NAME).map((piAi) => ({
        piVersion,
        piAi,
      })),
    )
    .andThen(({ piVersion, piAi }) =>
      readPackageIdentity(CAPTURE_PACKAGE_NAME).andThen((piPackage) => {
        if (piPackage.version !== piVersion) {
          return errAsync(blocked("pi-version-mismatch"));
        }
        return prepareWorkspace().andThen((workspace) =>
          withWorkspaceCleanup(
            workspace,
            runDeterministicCapture({ pi: input.pi, workspace }).map(
              (events) => ({
                piVersion,
                piAi,
                piPackage,
                piExecutableSha256: "",
                events,
              }),
            ),
          ),
        );
      }),
    )
    .andThen(({ piVersion, piAi, piPackage, events }) =>
      readArtifactSha256(input.pi)
        .mapErr(() => blocked("spawn-failed"))
        .andThen((piExecutableSha256) => {
          const fixtureText = serializeFixture(events);
          const fixtureSha256 = sha256HexOfText(fixtureText);
          const manifest = buildCaptureManifest({
            piVersion,
            piExecutableSha256,
            piPackageSha256: piPackage.sha256,
            piAiVersion: piAi.version,
            piAiPackageSha256: piAi.sha256,
            eventCount: events.length,
            fixtureBytes: utf8Bytes(fixtureText),
            captureTimeMs: Date.now() - startedAt,
            fixtureSha256,
          });
          const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
          const verified = verifyCaptureManifest(fixtureText, manifestText);
          if (verified.isErr()) return errAsync(blocked("sanitization-failed"));
          return writeImmutableCapture(
            paths.fixturePath,
            paths.manifestPath,
            fixtureText,
            manifestText,
          ).map(() => ({
            fixturePath: paths.fixturePath,
            manifestPath: paths.manifestPath,
            eventCount: events.length,
            captureDurationMs: Date.now() - startedAt,
            fixtureSha256,
          }));
        }),
    );
}

// ---------------------------------------------------------------------------
// Fixture I/O used by replay and the verifier
// ---------------------------------------------------------------------------

export function deriveManifestPath(fixturePath: string): string {
  return fixturePath.endsWith(".json")
    ? `${fixturePath.slice(0, -5)}.manifest.json`
    : `${fixturePath}.manifest.json`;
}

export function readFixtureAndManifest(
  fixturePath: string,
): ResultAsync<
  { readonly fixtureText: string; readonly manifestText: string },
  FixtureValidationFailure
> {
  const manifestPath = deriveManifestPath(fixturePath);
  return ResultAsync.fromPromise(
    Promise.all([Bun.file(fixturePath).text(), Bun.file(manifestPath).text()]),
    () => invalidFixture("fixture-corrupt"),
  ).map(([fixtureText, manifestText]) => ({ fixtureText, manifestText }));
}
