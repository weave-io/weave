import { err, ok, Result } from "neverthrow";
import {
  PI_LIVE_REASONING_MAX_CONTENT_INDEX,
  PI_LIVE_REASONING_MAX_INPUT_BYTES,
  PI_LIVE_REASONING_PHASES,
  type PiLiveReasoningPhase,
  type PiLiveReasoningRejection,
  type PiLiveReasoningRejectionReason,
  type PiLiveReasoningUpdate,
} from "./child-live-reasoning-types.js";
import {
  classifyPiMessageUpdate,
  isRawReasoningAssistantEventType,
} from "./message-update-carrier.js";

interface PiLiveReasoningCarrier {
  readonly phase: PiLiveReasoningPhase;
  readonly contentIndex: number;
  /** Empty is a valid structural marker from the sanitized Task 2 fixture. */
  readonly text: string;
  readonly inputWasNonEmpty: boolean;
}

type SafeOwnValue =
  | { readonly found: false }
  | { readonly found: true; readonly value: unknown };
type SafeReadError = "unreadable" | "unsafe";

const ABSENT: SafeOwnValue = { found: false };
const textEncoder = new TextEncoder();

/** Reflection itself is a fallible boundary: a revoked proxy can throw. */
const readDescriptor = Result.fromThrowable(
  (target: object, key: PropertyKey): PropertyDescriptor | undefined =>
    Object.getOwnPropertyDescriptor(target, key),
  (): SafeReadError => "unreadable",
);

/** Reads only an own enumerable data property. Accessors are never invoked. */
function readOwnEnumerableData(
  target: object,
  key: PropertyKey,
): Result<SafeOwnValue, SafeReadError> {
  const descriptor = readDescriptor(target, key);
  if (descriptor.isErr()) return err(descriptor.error);
  if (descriptor.value === undefined) return ok(ABSENT);
  if (descriptor.value.enumerable !== true || !("value" in descriptor.value)) {
    return err("unsafe");
  }
  return ok({ found: true, value: descriptor.value.value });
}

function isObjectRecord(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  return Result.fromThrowable(
    () => Array.isArray(value),
    () => true,
  )().match(
    (isArray) => !isArray,
    () => false,
  );
}

function boundedContentIndex(
  value: SafeOwnValue,
): Result<number, PiLiveReasoningRejectionReason> {
  if (!value.found) return err("missing-correlation");
  if (
    typeof value.value !== "number" ||
    !Number.isSafeInteger(value.value) ||
    value.value < 0 ||
    value.value > PI_LIVE_REASONING_MAX_CONTENT_INDEX
  ) {
    return err("correlation-out-of-bounds");
  }
  return ok(value.value);
}

function boundedInput(
  value: string,
): Result<string, PiLiveReasoningRejectionReason> {
  if (
    textEncoder.encode(value).byteLength > PI_LIVE_REASONING_MAX_INPUT_BYTES
  ) {
    return err("invalid-text");
  }
  return ok(value);
}

interface ExtractedReasoningText {
  readonly text: string;
  readonly inputWasNonEmpty: boolean;
}

const MAX_REASONING_CONTENT_ITEMS = 256;

function combineReasoningText(
  parts: readonly string[],
): Result<ExtractedReasoningText, PiLiveReasoningRejectionReason> {
  let bytes = 0;
  let inputWasNonEmpty = false;
  for (const part of parts) {
    bytes += textEncoder.encode(part).byteLength;
    if (bytes > PI_LIVE_REASONING_MAX_INPUT_BYTES) {
      return err("invalid-text");
    }
    if (part.length > 0) inputWasNonEmpty = true;
  }
  return ok({ text: parts.join(""), inputWasNonEmpty });
}

function mapSafeReadError(
  error: SafeReadError,
): PiLiveReasoningRejectionReason {
  return error === "unreadable" ? "unreadable" : "invalid-carrier";
}

/**
 * Reads an array through its own data descriptors. The authenticated parser
 * normally hands this projector a materialized plain array, but keeping this
 * boundary descriptor-safe also makes direct replay and hostile-input tests
 * fail closed without invoking an element accessor.
 */
function readReasoningArray(
  value: object,
): Result<readonly unknown[], PiLiveReasoningRejectionReason> {
  const array = Result.fromThrowable(
    () => Array.isArray(value),
    () => "unreadable" as const,
  )();
  if (array.isErr()) return err(array.error);
  if (!array.value) return err("invalid-text");

  const length = readDescriptor(value, "length");
  if (length.isErr()) return err(mapSafeReadError(length.error));
  if (
    length.value === undefined ||
    !("value" in length.value) ||
    length.value.enumerable === true
  ) {
    return err("invalid-carrier");
  }
  const size = length.value.value;
  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > MAX_REASONING_CONTENT_ITEMS
  ) {
    return err("correlation-out-of-bounds");
  }
  const keys = Result.fromThrowable(
    () => Object.keys(value),
    () => "unreadable" as const,
  )();
  if (keys.isErr()) return err(keys.error);
  if (
    keys.value.length !== size ||
    keys.value.some((key, index) => key !== String(index))
  ) {
    return err("invalid-carrier");
  }

  const items: unknown[] = [];
  for (let index = 0; index < size; index += 1) {
    const item = readOwnEnumerableData(value, String(index));
    if (item.isErr()) return err(mapSafeReadError(item.error));
    if (!item.value.found) return err("invalid-carrier");
    items.push(item.value.value);
  }
  return ok(items);
}

/**
 * Pi's completed thinking content can be either a string or an array of
 * thinking blocks. Structural Task 2 markers intentionally remain empty; no
 * marker metadata is promoted to display prose.
 */
function extractReasoningText(
  value: unknown,
): Result<ExtractedReasoningText, PiLiveReasoningRejectionReason> {
  if (typeof value === "string") {
    const bounded = boundedInput(value);
    return bounded.isErr()
      ? err(bounded.error)
      : combineReasoningText([bounded.value]);
  }
  if (typeof value !== "object" || value === null) {
    return err("invalid-text");
  }

  const array = Result.fromThrowable(
    () => Array.isArray(value),
    () => undefined,
  )();
  if (array.isErr()) return err("unreadable");
  if (array.value) {
    const items = readReasoningArray(value);
    if (items.isErr()) return err(items.error);
    const parts: string[] = [];
    for (const item of items.value) {
      const extracted = extractReasoningText(item);
      if (extracted.isErr()) return err(extracted.error);
      if (extracted.value.inputWasNonEmpty) parts.push(extracted.value.text);
    }
    return combineReasoningText(parts);
  }

  const record = value;
  const type = readOwnEnumerableData(record, "type");
  if (type.isErr()) return err("unreadable");
  if (
    type.value.found &&
    typeof type.value.value === "string" &&
    type.value.value !== "thinking" &&
    type.value.value !== "reasoning"
  ) {
    // An unknown typed block is not a captured reasoning block. Refuse it
    // instead of guessing that its text is safe to show.
    return err("invalid-carrier");
  }

  const parts: string[] = [];
  for (const key of ["text", "thinking", "reasoning", "content"] as const) {
    const field = readOwnEnumerableData(record, key);
    if (field.isErr()) return err("unreadable");
    if (!field.value.found || field.value.value === undefined) continue;
    const extracted = extractReasoningText(field.value.value);
    if (extracted.isErr()) return err(extracted.error);
    if (extracted.value.inputWasNonEmpty) parts.push(extracted.value.text);
  }
  // A marker object has no recognized prose field and is intentionally
  // content-free. A typed thinking block with no prose is the same.
  return combineReasoningText(parts);
}

/**
 * Reads the exact Pi generic carrier. Legacy `delta.thinking`, summaries,
 * answer carriers, and standalone `thinking` events intentionally return no
 * update here. The classifier remains the mixed-carrier authority.
 */
export function readPiLiveReasoningCarrier(
  value: unknown,
): Result<PiLiveReasoningCarrier | undefined, PiLiveReasoningRejectionReason> {
  if (typeof value !== "object" || value === null) return ok(undefined);
  const rootIsArray = Result.fromThrowable(
    () => Array.isArray(value),
    () => undefined,
  )();
  if (rootIsArray.isErr()) return err("unreadable");
  if (rootIsArray.value === undefined || rootIsArray.value)
    return ok(undefined);

  const eventType = readOwnEnumerableData(value, "type");
  if (eventType.isErr()) return err("unreadable");
  if (!eventType.value.found || eventType.value.value !== "message_update") {
    return ok(undefined);
  }

  const assistantEvent = readOwnEnumerableData(value, "assistantMessageEvent");
  if (assistantEvent.isErr()) return err("unreadable");
  if (!assistantEvent.value.found) return ok(undefined);
  if (!isObjectRecord(assistantEvent.value.value)) {
    return err("invalid-carrier");
  }

  const assistant = assistantEvent.value.value;
  const assistantType = readOwnEnumerableData(assistant, "type");
  if (assistantType.isErr()) return err("unreadable");
  if (!assistantType.value.found) return ok(undefined);
  if (!isRawReasoningAssistantEventType(assistantType.value.value)) {
    return ok(undefined);
  }

  const classified = classifyPiMessageUpdate(value);
  if (classified.kind === "rejected") return err("mixed-carriers");

  const rawContentIndex = readOwnEnumerableData(assistant, "contentIndex");
  if (rawContentIndex.isErr()) return err("unreadable");
  const contentIndex = boundedContentIndex(rawContentIndex.value);
  if (contentIndex.isErr()) return err(contentIndex.error);

  let phase: PiLiveReasoningPhase;
  if (assistantType.value.value === "thinking_start") {
    phase = "start";
  } else if (assistantType.value.value === "thinking_delta") {
    phase = "delta";
  } else {
    phase = "end";
  }
  const field = phase === "delta" ? "delta" : "content";
  const carrierText = readOwnEnumerableData(assistant, field);
  if (carrierText.isErr()) return err("unreadable");
  if (phase === "delta" && !carrierText.value.found) {
    return err("missing-text");
  }

  // The Task 2 fixture replaces raw strings with a structural marker object.
  // It is a valid captured carrier but carries no display text. Pi's completed
  // thinking block may also be an array of `{ type: "thinking", text }`
  // blocks; extract only that captured shape, descriptor-safely.
  if (!carrierText.value.found || carrierText.value.value === undefined) {
    return ok({
      phase,
      contentIndex: contentIndex.value,
      text: "",
      inputWasNonEmpty: false,
    });
  }
  const extracted = extractReasoningText(carrierText.value.value);
  if (extracted.isErr()) return err(extracted.error);
  return ok({
    phase,
    contentIndex: contentIndex.value,
    text: extracted.value.text,
    inputWasNonEmpty: extracted.value.inputWasNonEmpty,
  });
}

const PI_LIVE_REASONING_PHASE_SET: ReadonlySet<string> = new Set(
  PI_LIVE_REASONING_PHASES,
);

/** Validates an observer-fed update without invoking getters or trusting casts. */
export function readPiLiveReasoningUpdate(
  value: unknown,
): Result<PiLiveReasoningUpdate, PiLiveReasoningRejectionReason> {
  if (typeof value !== "object" || value === null) {
    return err("invalid-carrier");
  }
  const childId = readOwnEnumerableData(value, "childId");
  if (childId.isErr()) return err(mapSafeReadError(childId.error));
  const generationId = readOwnEnumerableData(value, "generationId");
  if (generationId.isErr()) return err(mapSafeReadError(generationId.error));
  const lifecycleEpoch = readOwnEnumerableData(value, "lifecycleEpoch");
  if (lifecycleEpoch.isErr())
    return err(mapSafeReadError(lifecycleEpoch.error));
  const phase = readOwnEnumerableData(value, "phase");
  if (phase.isErr()) return err(mapSafeReadError(phase.error));
  const contentIndex = readOwnEnumerableData(value, "contentIndex");
  if (contentIndex.isErr()) return err(mapSafeReadError(contentIndex.error));
  const text = readOwnEnumerableData(value, "text");
  if (text.isErr()) return err(mapSafeReadError(text.error));
  if (
    !childId.value.found ||
    typeof childId.value.value !== "string" ||
    childId.value.value.length === 0 ||
    !generationId.value.found ||
    typeof generationId.value.value !== "string" ||
    generationId.value.value.length === 0
  ) {
    return err("invalid-carrier");
  }
  if (
    !phase.value.found ||
    typeof phase.value.value !== "string" ||
    !PI_LIVE_REASONING_PHASE_SET.has(phase.value.value)
  ) {
    return err("out-of-order");
  }
  const epoch = lifecycleEpoch.value.found
    ? lifecycleEpoch.value.value
    : undefined;
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 1) {
    return err("stale-epoch");
  }
  const correlation = boundedContentIndex(contentIndex.value);
  if (correlation.isErr()) return err(correlation.error);
  if (!text.value.found || typeof text.value.value !== "string") {
    return err("invalid-text");
  }
  const bounded = boundedInput(text.value.value);
  if (bounded.isErr()) return err(bounded.error);
  return ok({
    childId: childId.value.value,
    generationId: generationId.value.value,
    lifecycleEpoch: epoch,
    phase: phase.value.value as PiLiveReasoningPhase,
    contentIndex: correlation.value,
    text: bounded.value,
  });
}

export function makePiLiveReasoningRejection(
  reason: PiLiveReasoningRejectionReason,
): PiLiveReasoningRejection {
  return { type: "PiLiveReasoningRejected", reason };
}
