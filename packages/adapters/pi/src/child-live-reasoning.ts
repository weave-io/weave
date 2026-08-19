import { err, ok, Result, ResultAsync } from "neverthrow";
import {
  type ChildUiEventDiagnosticsSink,
  recordChildUiEventFailure,
} from "./child-ui-event-diagnostics.js";
import {
  classifyPiMessageUpdate,
  isRawReasoningAssistantEventType,
} from "./message-update-carrier.js";

/** The shared in-memory ceiling for one live thinking block. */
export const PI_LIVE_REASONING_MAX_BYTES = 4 * 1024;
/** Alias used by callers that name the Pi surface explicitly. */
export const MAX_PI_LIVE_REASONING_BYTES = PI_LIVE_REASONING_MAX_BYTES;
/** Maximum code points in the parent card's one-line reasoning content. */
export const PI_LIVE_REASONING_PARENT_MAX_CODE_POINTS = 240;
/** Maximum number of rows in the focused inspector's live reasoning view. */
export const PI_LIVE_REASONING_INSPECTOR_MAX_ROWS = 3;
/** Maximum code points in one inspector row before terminal truncation. */
export const PI_LIVE_REASONING_INSPECTOR_ROW_MAX_CODE_POINTS = 240;
/** The captured Pi content-index bound. */
export const PI_LIVE_REASONING_MAX_CONTENT_INDEX = 255;
/** Maximum input accepted after the parser-approved boundary. */
export const PI_LIVE_REASONING_MAX_INPUT_BYTES = 16_384;

export const PI_LIVE_REASONING_TRUNCATION_MARKER = "… [truncated]";
export const PI_LIVE_REASONING_UNPRINTABLE_MARKER = "[unprintable reasoning]";
export const PI_LIVE_REASONING_PARENT_PREFIX = "↪ reasoning • ";

/** Generic Pi 0.84.2 phases that are allowed into the live projector. */
export const PI_LIVE_REASONING_PHASES = ["start", "delta", "end"] as const;
export type PiLiveReasoningPhase = (typeof PI_LIVE_REASONING_PHASES)[number];

/** A bounded, terminal-safe update that is never a session event. */
export interface PiLiveReasoningUpdate {
  readonly childId: string;
  readonly generationId: string;
  readonly lifecycleEpoch: number;
  readonly phase: PiLiveReasoningPhase;
  readonly contentIndex: number;
  /** The current bounded display buffer, not a durable transcript fragment. */
  readonly text: string;
}

export type PiLiveReasoningRejectionReason =
  | "unreadable"
  | "invalid-carrier"
  | "mixed-carriers"
  | "missing-text"
  | "invalid-text"
  | "missing-correlation"
  | "correlation-out-of-bounds"
  | "stale-child"
  | "stale-generation"
  | "stale-epoch"
  | "out-of-order"
  | "no-active-block"
  | "duplicate-delta"
  | "settled"
  | "disposed";

/** Rejections never contain source text, identities, or exception messages. */
export interface PiLiveReasoningRejection {
  readonly type: "PiLiveReasoningRejected";
  readonly reason: PiLiveReasoningRejectionReason;
}

/** Result-like values are inspected, but observers may return any UI value. */
export type PiLiveReasoningObserverResult = unknown;

/** One UI-only sink. It must never be used as a session-event callback. */
export type PiLiveReasoningObserver = (
  update: PiLiveReasoningUpdate,
) => PiLiveReasoningObserverResult;

export interface PiLiveReasoningSnapshot {
  readonly childId: string | undefined;
  readonly generationId: string | undefined;
  readonly lifecycleEpoch: number;
  readonly phase: PiLiveReasoningPhase | "idle";
  readonly contentIndex: number | undefined;
  /** Current normalized content held only for the live UI projection. */
  readonly text: string;
  /** Parent-card content, without the parent-card prefix. */
  readonly parentCardText: string;
  /** Focused-inspector rows. Empty means that no row should be rendered. */
  readonly inspectorRows: readonly string[];
  /** A complete parent-card line, or the empty string when no row is valid. */
  readonly parentCardLine: string;
  readonly active: boolean;
  readonly retainedBytes: number;
  readonly omitted: boolean;
  readonly unprintable: boolean;
  readonly registryEntries: number;
}

export interface PiLiveReasoningProjectorConfig {
  readonly childId: string;
  readonly generationId: string;
  readonly parentCardObserver?: PiLiveReasoningObserver;
  readonly inspectorObserver?: PiLiveReasoningObserver;
  /** Aliases make the two independent UI sinks explicit at call sites. */
  readonly onParentCardReasoning?: PiLiveReasoningObserver;
  readonly onInspectorReasoning?: PiLiveReasoningObserver;
  readonly diagnostics?: ChildUiEventDiagnosticsSink;
  readonly registry?: PiLiveReasoningRegistry;
  readonly registryKey?: string;
}

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

/**
 * Reads an array through its own data descriptors. The authenticated parser
 * normally hands this projector a materialized plain array, but keeping this
 * boundary descriptor-safe also makes direct replay and hostile-input tests
 * fail closed without invoking an element accessor.
 */
function mapSafeReadError(
  error: SafeReadError,
): PiLiveReasoningRejectionReason {
  return error === "unreadable" ? "unreadable" : "invalid-carrier";
}

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
function readPiLiveReasoningCarrier(
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

function stripTerminalControls(value: string): string {
  // Build the expressions from code points so the source file contains no
  // control characters in regular-expression literals.
  const terminalEscape = String.fromCodePoint(0x1b);
  const bell = String.fromCodePoint(0x07);
  const withoutAnsi = value
    // OSC and CSI sequences, plus the short ESC forms used by terminals.
    .replace(
      new RegExp(
        `${terminalEscape}\\][^${bell}]*(?:${bell}|${terminalEscape}\\\\)`,
        "g",
      ),
      "",
    )
    .replace(new RegExp(`${terminalEscape}\\[[0-?]*[ -/]*[@-~]`, "g"), "")
    .replace(new RegExp(`${terminalEscape}[()][0-2A-Z]`, "g"), "")
    .replace(new RegExp(`${terminalEscape}[\\s\\S]`, "g"), "");
  return Array.from(withoutAnsi)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        character === "\n" ||
        character === "\r" ||
        character === "\t" ||
        (codePoint >= 0x20 &&
          codePoint !== 0x7f &&
          !(codePoint >= 0x80 && codePoint <= 0x9f))
      );
    })
    .join("");
}

interface NormalizedText {
  readonly text: string;
  readonly hadInput: boolean;
  readonly hadPrintable: boolean;
}

function normalizeTerminalText(value: string): NormalizedText {
  const hadInput = value.length > 0;
  const cleaned = stripTerminalControls(value)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ");
  const lines = cleaned
    .split("\n")
    .map((line) => line.replace(/[ \f\v]+/g, " ").trim());
  const text = lines
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  const hadPrintable = Array.from(text).some(
    (character) => !/\s/u.test(character),
  );
  return { text, hadInput, hadPrintable };
}

/** Normalize one streamed fragment without removing its join-space. */
function normalizeTerminalFragment(value: string): NormalizedText {
  const hadInput = value.length > 0;
  const cleaned = stripTerminalControls(value)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ");
  const text = cleaned
    .split("\n")
    .map((line) => line.replace(/[ \f\v]+/g, " "))
    .join("\n")
    .replace(/\n{2,}/g, "\n");
  const hadPrintable = Array.from(text).some(
    (character) => !/\s/u.test(character),
  );
  return { text: hadPrintable ? text : "", hadInput, hadPrintable };
}

function codePoints(value: string): readonly string[] {
  return Array.from(value);
}

function newestWithMarker(value: string, maxCodePoints: number): string {
  const characters = codePoints(value);
  if (characters.length <= maxCodePoints) return value;
  const marker = codePoints(PI_LIVE_REASONING_TRUNCATION_MARKER);
  const keep = Math.max(0, maxCodePoints - marker.length);
  return `${characters.slice(-keep).join("")}${marker.join("")}`;
}

function markerWithinCodePointBound(
  value: string,
  maxCodePoints: number,
): string {
  const marker = PI_LIVE_REASONING_TRUNCATION_MARKER;
  const characters = codePoints(value);
  const markerLength = codePoints(marker).length;
  const keep = Math.max(0, maxCodePoints - markerLength);
  return `${characters.slice(-keep).join("")}${marker}`;
}

function newestUtf8(
  value: string,
  maxBytes: number,
): {
  readonly text: string;
  readonly omitted: boolean;
} {
  const bytes = textEncoder.encode(value).byteLength;
  if (bytes <= maxBytes) return { text: value, omitted: false };
  const characters = codePoints(value);
  let used = 0;
  let start = characters.length;
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const width = textEncoder.encode(characters[index] ?? "").byteLength;
    if (used + width > maxBytes) break;
    used += width;
    start = index;
  }
  return { text: characters.slice(start).join(""), omitted: true };
}

function reconcileEnd(current: string, ending: string): string {
  if (ending.length === 0 || current === ending) return current;
  if (current.length === 0) return ending;
  if (ending.startsWith(current)) return ending;
  if (current.startsWith(ending) || current.endsWith(ending)) return current;

  const maxOverlap = Math.min(current.length, ending.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (current.endsWith(ending.slice(0, size))) {
      return `${current}${ending.slice(size)}`;
    }
  }
  return `${current}${ending}`;
}

function parentDisplay(
  text: string,
  omitted: boolean,
  unprintable: boolean,
): string {
  if (text.length === 0)
    return unprintable ? PI_LIVE_REASONING_UNPRINTABLE_MARKER : "";
  const oneLine = text.replace(/\s+/gu, " ").trim();
  if (oneLine.length === 0) {
    return unprintable ? PI_LIVE_REASONING_UNPRINTABLE_MARKER : "";
  }
  const bounded = newestWithMarker(
    oneLine,
    PI_LIVE_REASONING_PARENT_MAX_CODE_POINTS,
  );
  const clipped = bounded !== oneLine;
  if (omitted || clipped) {
    return clipped
      ? bounded
      : markerWithinCodePointBound(
          bounded,
          PI_LIVE_REASONING_PARENT_MAX_CODE_POINTS,
        );
  }
  return bounded;
}

function inspectorDisplay(
  text: string,
  omitted: boolean,
  unprintable: boolean,
): readonly string[] {
  if (text.length === 0) {
    return unprintable ? [PI_LIVE_REASONING_UNPRINTABLE_MARKER] : [];
  }
  const normalized = text
    .split("\n")
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter((line) => line.length > 0);
  if (normalized.length === 0) {
    return unprintable ? [PI_LIVE_REASONING_UNPRINTABLE_MARKER] : [];
  }

  let lines = normalized.map((line) =>
    newestWithMarker(line, PI_LIVE_REASONING_INSPECTOR_ROW_MAX_CODE_POINTS),
  );
  const lineClipped = lines.some((line, index) => line !== normalized[index]);
  let droppedLines = false;
  if (lines.length > PI_LIVE_REASONING_INSPECTOR_MAX_ROWS) {
    lines = lines.slice(-PI_LIVE_REASONING_INSPECTOR_MAX_ROWS);
    droppedLines = true;
  }
  if (omitted || lineClipped || droppedLines) {
    const last = lines.length - 1;
    if (
      last >= 0 &&
      !lines[last]?.endsWith(PI_LIVE_REASONING_TRUNCATION_MARKER)
    ) {
      lines[last] = markerWithinCodePointBound(
        lines[last] ?? "",
        PI_LIVE_REASONING_INSPECTOR_ROW_MAX_CODE_POINTS,
      );
    }
  }
  return lines;
}

const PI_LIVE_REASONING_PHASE_SET: ReadonlySet<string> = new Set(
  PI_LIVE_REASONING_PHASES,
);

/** Validates an observer-fed update without invoking getters or trusting casts. */
function readPiLiveReasoningUpdate(
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

function makeRejection(
  reason: PiLiveReasoningRejectionReason,
): PiLiveReasoningRejection {
  return { type: "PiLiveReasoningRejected", reason };
}

function isResult(value: unknown): value is Result<unknown, unknown> {
  return Result.fromThrowable(
    () =>
      typeof value === "object" &&
      value !== null &&
      "isErr" in value &&
      typeof (value as { readonly isErr?: unknown }).isErr === "function",
    () => false,
  )().unwrapOr(false);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Result.fromThrowable(
    () =>
      typeof value === "object" &&
      value !== null &&
      "then" in value &&
      typeof (value as { readonly then?: unknown }).then === "function",
    () => false,
  )().unwrapOr(false);
}

/**
 * A process-memory registry for UI projectors. Its lookup is for generation-
 * local UI owners; diagnostics and health expose only bounded counts, never
 * keys, identities, or snapshots.
 */
export class PiLiveReasoningRegistry {
  private readonly entries = new Map<string, PiLiveReasoningProjector>();

  register(
    key: string,
    projector: PiLiveReasoningProjector,
  ): Result<void, never> {
    const prior = this.entries.get(key);
    if (prior !== undefined && prior !== projector) {
      prior.clear().match(
        () => undefined,
        () => undefined,
      );
    }
    this.entries.set(key, projector);
    return ok(undefined);
  }

  unregister(
    key: string,
    projector?: PiLiveReasoningProjector,
  ): Result<void, never> {
    if (projector === undefined || this.entries.get(key) === projector) {
      this.entries.delete(key);
    }
    return ok(undefined);
  }

  get(key: string): PiLiveReasoningProjector | undefined {
    return this.entries.get(key);
  }

  size(): number {
    return this.entries.size;
  }

  clear(): Result<void, never> {
    for (const projector of this.entries.values()) {
      projector.clear().match(
        () => undefined,
        () => undefined,
      );
    }
    this.entries.clear();
    return ok(undefined);
  }
}

export function createPiLiveReasoningRegistry(): PiLiveReasoningRegistry {
  return new PiLiveReasoningRegistry();
}

interface MutableState {
  childId: string | undefined;
  generationId: string | undefined;
  epoch: number;
  phase: PiLiveReasoningPhase | "idle";
  contentIndex: number | undefined;
  text: string;
  retainedBytes: number;
  omitted: boolean;
  unprintable: boolean;
  released: boolean;
}

/**
 * Reducer and UI fanout for exactly one authenticated child's active thinking
 * block. The class has no session-event, tree, transcript, or settlement type
 * fields; callers must explicitly release it at the lifecycle boundary.
 */
export class PiLiveReasoningProjector {
  private diagnostics: ChildUiEventDiagnosticsSink | undefined;
  private parentCardObserver: PiLiveReasoningObserver | undefined;
  private inspectorObserver: PiLiveReasoningObserver | undefined;
  private readonly registry: PiLiveReasoningRegistry | undefined;
  private registryKey: string | undefined;
  private state: MutableState;

  constructor(config: PiLiveReasoningProjectorConfig) {
    this.diagnostics = config.diagnostics;
    this.parentCardObserver =
      config.parentCardObserver ?? config.onParentCardReasoning;
    this.inspectorObserver =
      config.inspectorObserver ?? config.onInspectorReasoning;
    this.registry = config.registry;
    this.registryKey = config.registryKey ?? config.childId;
    this.state = {
      childId: config.childId,
      generationId: config.generationId,
      epoch: 0,
      phase: "idle",
      contentIndex: undefined,
      text: "",
      retainedBytes: 0,
      omitted: false,
      unprintable: false,
      released: false,
    };
    if (this.registry !== undefined && this.registryKey !== undefined) {
      this.registry.register(this.registryKey, this).match(
        () => undefined,
        () => undefined,
      );
    }
  }

  /** Accepts only the exact parser-approved generic Pi carrier. */
  accept(
    event: unknown,
  ): Result<PiLiveReasoningUpdate | undefined, PiLiveReasoningRejection> {
    if (this.state.released) return err(makeRejection("disposed"));
    const carrier = readPiLiveReasoningCarrier(event);
    if (carrier.isErr()) return err(makeRejection(carrier.error));
    if (carrier.value === undefined) return ok(undefined);

    if (carrier.value.phase === "start") {
      this.state.epoch += 1;
      this.state.phase = "start";
      this.state.contentIndex = carrier.value.contentIndex;
      this.state.text = "";
      this.state.retainedBytes = 0;
      this.state.omitted = false;
      this.state.unprintable = false;
      this.appendInput(carrier.value.text, carrier.value.inputWasNonEmpty);
      return this.emitUpdate("start");
    }

    if (this.state.phase === "idle" || this.state.phase === "end") {
      return err(makeRejection("no-active-block"));
    }
    if (this.state.contentIndex !== carrier.value.contentIndex) {
      return err(makeRejection("out-of-order"));
    }

    if (carrier.value.phase === "delta") {
      this.appendInput(carrier.value.text, carrier.value.inputWasNonEmpty);
      return this.emitUpdate("delta");
    }

    const normalized = normalizeTerminalText(carrier.value.text);
    const reconciled = reconcileEnd(this.state.text, normalized.text);
    const finalText = normalizeTerminalText(reconciled).text;
    const bounded = newestUtf8(finalText, PI_LIVE_REASONING_MAX_BYTES);
    this.state.text = bounded.text;
    this.state.retainedBytes = textEncoder.encode(bounded.text).byteLength;
    this.state.omitted = this.state.omitted || bounded.omitted;
    this.state.unprintable =
      this.state.text.length === 0 &&
      (this.state.unprintable ||
        (carrier.value.inputWasNonEmpty && !normalized.hadPrintable));
    this.state.phase = "end";
    return this.emitUpdate("end");
  }

  /** Applies a previously projected update with identity/epoch checks. */
  apply(
    update: PiLiveReasoningUpdate,
  ): Result<PiLiveReasoningSnapshot, PiLiveReasoningRejection> {
    if (this.state.released) return err(makeRejection("disposed"));
    const validated = readPiLiveReasoningUpdate(update);
    if (validated.isErr()) return err(makeRejection(validated.error));
    const safeUpdate = validated.value;
    if (safeUpdate.childId !== this.state.childId) {
      return err(makeRejection("stale-child"));
    }
    if (safeUpdate.generationId !== this.state.generationId) {
      return err(makeRejection("stale-generation"));
    }
    if (safeUpdate.phase === "start") {
      if (safeUpdate.lifecycleEpoch < this.state.epoch) {
        return err(makeRejection("stale-epoch"));
      }
      this.state.epoch = safeUpdate.lifecycleEpoch;
      this.state.phase = "start";
      this.state.contentIndex = safeUpdate.contentIndex;
      this.state.text = "";
      this.state.retainedBytes = 0;
      this.state.omitted = false;
      this.state.unprintable = false;
    } else {
      if (this.state.phase === "idle" || this.state.phase === "end") {
        return err(makeRejection("out-of-order"));
      }
      if (safeUpdate.lifecycleEpoch !== this.state.epoch) {
        return err(makeRejection("stale-epoch"));
      }
      if (this.state.contentIndex !== safeUpdate.contentIndex) {
        return err(makeRejection("out-of-order"));
      }
    }
    const normalized = normalizeTerminalText(safeUpdate.text);
    const bounded = newestUtf8(normalized.text, PI_LIVE_REASONING_MAX_BYTES);
    this.state.text = bounded.text;
    this.state.retainedBytes = textEncoder.encode(bounded.text).byteLength;
    this.state.omitted = this.state.omitted || bounded.omitted;
    this.state.unprintable =
      this.state.text.length === 0 &&
      (safeUpdate.text === PI_LIVE_REASONING_UNPRINTABLE_MARKER ||
        (normalized.hadInput && !normalized.hadPrintable));
    this.state.phase = safeUpdate.phase;
    const appliedUpdate: PiLiveReasoningUpdate = {
      ...safeUpdate,
      text: this.displayText(),
    };
    if (appliedUpdate.text.length > 0) {
      this.notify(this.parentCardObserver, appliedUpdate);
      this.notify(this.inspectorObserver, appliedUpdate);
    }
    return ok(this.snapshot());
  }

  snapshot(): PiLiveReasoningSnapshot {
    const parentCardText = parentDisplay(
      this.state.text,
      this.state.omitted,
      this.state.unprintable,
    );
    const inspectorRows = inspectorDisplay(
      this.state.text,
      this.state.omitted,
      this.state.unprintable,
    );
    return {
      childId: this.state.childId,
      generationId: this.state.generationId,
      lifecycleEpoch: this.state.epoch,
      phase: this.state.phase,
      contentIndex: this.state.contentIndex,
      text: this.state.text,
      parentCardText,
      inspectorRows,
      parentCardLine:
        parentCardText.length === 0
          ? ""
          : `${PI_LIVE_REASONING_PARENT_PREFIX}${parentCardText}`,
      active: !this.state.released && this.state.phase !== "idle",
      retainedBytes: this.state.retainedBytes,
      omitted: this.state.omitted,
      unprintable: this.state.unprintable,
      registryEntries: this.registry?.size() ?? 0,
    };
  }

  /** Alias used by UI ports that call their transient value a state. */
  stateSnapshot(): PiLiveReasoningSnapshot {
    return this.snapshot();
  }

  clear(): Result<void, never> {
    return this.release();
  }

  settle(): Result<void, never> {
    return this.release();
  }

  dispose(): Result<void, never> {
    return this.release();
  }

  isDisposed(): boolean {
    return this.state.released;
  }

  private appendInput(value: string, inputWasNonEmpty: boolean): void {
    const normalized = normalizeTerminalFragment(value);
    const combined = `${this.state.text}${normalized.text}`;
    const bounded = newestUtf8(combined, PI_LIVE_REASONING_MAX_BYTES);
    this.state.text = bounded.text;
    this.state.retainedBytes = textEncoder.encode(bounded.text).byteLength;
    this.state.omitted = this.state.omitted || bounded.omitted;
    this.state.unprintable =
      this.state.text.length === 0 &&
      (this.state.unprintable ||
        (inputWasNonEmpty && !normalized.hadPrintable));
  }

  private displayText(): string {
    return this.state.text.length === 0 && this.state.unprintable
      ? PI_LIVE_REASONING_UNPRINTABLE_MARKER
      : this.state.text;
  }

  private emitUpdate(
    phase: PiLiveReasoningPhase,
  ): Result<PiLiveReasoningUpdate, PiLiveReasoningRejection> {
    const childId = this.state.childId;
    const generationId = this.state.generationId;
    const contentIndex = this.state.contentIndex;
    if (
      childId === undefined ||
      generationId === undefined ||
      contentIndex === undefined
    ) {
      return err(makeRejection("disposed"));
    }
    const update: PiLiveReasoningUpdate = {
      childId,
      generationId,
      lifecycleEpoch: this.state.epoch,
      phase,
      contentIndex,
      text: this.displayText(),
    };
    if (update.text.length > 0) {
      this.notify(this.parentCardObserver, update);
      this.notify(this.inspectorObserver, update);
    }
    return ok(update);
  }

  private notify(
    observer: PiLiveReasoningObserver | undefined,
    update: PiLiveReasoningUpdate,
  ): void {
    if (observer === undefined) return;
    const invoked = Result.fromThrowable(
      () => observer(update),
      () => undefined,
    )();
    if (invoked.isErr()) {
      recordChildUiEventFailure(this.diagnostics, "fanout", "callback-failed");
      return;
    }
    const result = invoked.value;
    const isAsyncResult = Result.fromThrowable(
      () => result instanceof ResultAsync,
      () => false,
    )().unwrapOr(false);
    if (isAsyncResult) {
      const asyncResult = result as ResultAsync<unknown, unknown>;
      void asyncResult.match(
        () => undefined,
        () =>
          recordChildUiEventFailure(
            this.diagnostics,
            "fanout",
            "callback-failed",
          ),
      );
      return;
    }
    if (isResult(result)) {
      const failed = Result.fromThrowable(
        () => result.isErr(),
        () => true,
      )().unwrapOr(true);
      if (failed) {
        recordChildUiEventFailure(
          this.diagnostics,
          "fanout",
          "callback-failed",
        );
      }
      return;
    }
    if (isPromiseLike(result)) {
      const pending = Result.fromThrowable(
        () => ResultAsync.fromPromise(result, () => undefined),
        () => undefined,
      )();
      if (pending.isErr()) {
        recordChildUiEventFailure(
          this.diagnostics,
          "fanout",
          "callback-failed",
        );
        return;
      }
      void pending.value.match(
        (value) => {
          if (!isResult(value)) return;
          const failed = Result.fromThrowable(
            () => value.isErr(),
            () => true,
          )().unwrapOr(true);
          if (failed) {
            recordChildUiEventFailure(
              this.diagnostics,
              "fanout",
              "callback-failed",
            );
          }
        },
        () =>
          recordChildUiEventFailure(
            this.diagnostics,
            "fanout",
            "callback-failed",
          ),
      );
    }
  }

  private release(): Result<void, never> {
    if (this.state.released) return ok(undefined);
    const registry = this.registry;
    const key = this.registryKey;
    this.state = {
      childId: undefined,
      generationId: undefined,
      epoch: 0,
      phase: "idle",
      contentIndex: undefined,
      text: "",
      retainedBytes: 0,
      omitted: false,
      unprintable: false,
      released: true,
    };
    if (registry !== undefined && key !== undefined) {
      registry.unregister(key, this).match(
        () => undefined,
        () => undefined,
      );
    }
    this.registryKey = undefined;
    this.parentCardObserver = undefined;
    this.inspectorObserver = undefined;
    this.diagnostics = undefined;
    return ok(undefined);
  }
}

/** Factory spelling for callers that prefer a construction function. */
export function createPiLiveReasoningProjector(
  config: PiLiveReasoningProjectorConfig,
): PiLiveReasoningProjector {
  return new PiLiveReasoningProjector(config);
}

/** Direct projection helper for parser-boundary tests and adapter ports. */
export function projectPiLiveReasoningUpdate(
  event: unknown,
  identity: Readonly<{
    readonly childId: string;
    readonly generationId: string;
    readonly lifecycleEpoch: number;
  }>,
): Result<PiLiveReasoningUpdate | undefined, PiLiveReasoningRejection> {
  const carrier = readPiLiveReasoningCarrier(event);
  if (carrier.isErr()) return err(makeRejection(carrier.error));
  if (carrier.value === undefined) return ok(undefined);
  if (
    !Number.isSafeInteger(identity.lifecycleEpoch) ||
    identity.lifecycleEpoch < 1
  ) {
    return err(makeRejection("stale-epoch"));
  }
  const normalized = normalizeTerminalText(carrier.value.text);
  const bounded = newestUtf8(normalized.text, PI_LIVE_REASONING_MAX_BYTES);
  return ok({
    childId: identity.childId,
    generationId: identity.generationId,
    lifecycleEpoch: identity.lifecycleEpoch,
    phase: carrier.value.phase,
    contentIndex: carrier.value.contentIndex,
    text:
      bounded.text.length === 0 &&
      carrier.value.inputWasNonEmpty &&
      !normalized.hadPrintable
        ? PI_LIVE_REASONING_UNPRINTABLE_MARKER
        : bounded.text,
  });
}

/** Terminal-safe parent one-line projection. */
export function formatPiLiveReasoningParentLine(text: string): string {
  const normalized = normalizeTerminalText(text);
  const value = parentDisplay(
    normalized.text,
    newestUtf8(normalized.text, PI_LIVE_REASONING_MAX_BYTES).omitted,
    normalized.hadInput && !normalized.hadPrintable,
  );
  return value.length === 0 ? "" : `${PI_LIVE_REASONING_PARENT_PREFIX}${value}`;
}

/** Terminal-safe focused-inspector projection. */
export function formatPiLiveReasoningInspectorRows(
  text: string,
): readonly string[] {
  const normalized = normalizeTerminalText(text);
  return inspectorDisplay(
    normalized.text,
    newestUtf8(normalized.text, PI_LIVE_REASONING_MAX_BYTES).omitted,
    normalized.hadInput && !normalized.hadPrintable,
  );
}

/** Exposed for tests that need to prove UTF-8, not UTF-16, accounting. */
export function piLiveReasoningUtf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}
