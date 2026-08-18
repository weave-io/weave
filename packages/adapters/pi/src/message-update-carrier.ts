/**
 * The single authority on what one `message_update` frame states.
 *
 * ## Why this exists
 *
 * Pi sends the WHOLE assistant lifecycle through `message_update`: answer
 * deltas, raw chain-of-thought deltas, and pure framing (`text_start`,
 * `text_end`, `toolcall_*`). Two independent wire shapes carry the same facts
 * — a legacy `delta: { text }` / `delta: { thinking }` object, and 0.81.1+'s
 * `assistantMessageEvent: { type, delta }` — and nothing on the wire promises
 * that a frame carries only one of them.
 *
 * Previously each consumer answered "is this answer text?" for itself, by
 * reading `delta.text` FIRST and only then looking at the authoritative
 * `assistantMessageEvent`. A frame that carried both — `delta: { text: … }`
 * beside `assistantMessageEvent: { type: "thinking_delta", … }` — was
 * therefore published as an ANSWER by the card, the delegation tree preview,
 * the overlay window, the replay steps, the transcript, search and every
 * snapshot built from them. That is a chain-of-thought disclosure produced by
 * an ambiguity, not by a bug in any one reader.
 *
 * So the classification is made ONCE, here, and it is mutually exclusive by
 * construction: a frame is answer text, or a content-free reasoning fact, or
 * framing that states nothing, or it is REJECTED. There is no ordering between
 * carriers to get wrong, because a frame that declares more than one kind of
 * carrier is never resolved in favour of either.
 *
 * ## Fail-closed
 *
 * Every rejection produces no text and no reasoning claim. A rejected frame
 * moves nothing: not a card row, not the tree preview, not an overlay entry,
 * not a replay step. The child said something this boundary cannot describe
 * honestly, so it says nothing.
 *
 * ## Hostile input
 *
 * The record may be a host object rather than parsed JSON, so every read here
 * is descriptor-safe: only own, enumerable DATA properties are values. An
 * accessor is never invoked (reading it would run the payload's own code), an
 * inherited property is not the frame's own statement, and a proxy trap that
 * throws is reported as {@link PiMessageUpdateRejection} `unreadable` rather
 * than propagated.
 */
import { Result } from "neverthrow";

/**
 * Ceiling on one answer carrier's string.
 *
 * Pinned to the child event parser's `MAX_CHILD_EVENT_STRING`, and declared
 * here rather than imported so this module depends on NOTHING: the parser
 * itself redacts through it, and a cycle between the parser and its own
 * secrecy boundary is not a dependency anyone should have to reason about.
 * `message-update-carrier.test.ts` pins the two values together.
 */
export const MAX_MESSAGE_UPDATE_ANSWER_LENGTH = 16_384;

/** Why a frame states nothing this boundary will publish. */
export type PiMessageUpdateRejection =
  /** Reflection over the frame threw (proxy trap, revoked proxy). */
  | "unreadable"
  /** Answer text and raw reasoning were both carried by one frame. */
  | "mixed-carriers"
  /** A declared answer carrier held no string to publish. */
  | "malformed-answer"
  /** Two answer carriers disagreed about the text. */
  | "conflicting-answers"
  /** A declared answer carrier exceeded the event string bound. */
  | "oversized-answer";

/**
 * What exactly one `message_update` frame states.
 *
 * - `answer` — visible assistant text, and the ONLY variant that carries prose;
 * - `reasoning` — the content-free fact that the child produced raw
 *   chain-of-thought. Deliberately carries no text: the prose is dropped here
 *   and never leaves this module;
 * - `framing` — lifecycle structure (`text_start`, `text_end`, `toolcall_*`,
 *   an update with no carrier at all). States no fact a reader can act on;
 * - `rejected` — the frame is ambiguous or unreadable. Fail closed.
 */
export type PiMessageUpdateCarrier =
  | { readonly kind: "answer"; readonly text: string }
  | { readonly kind: "reasoning" }
  | { readonly kind: "framing" }
  | { readonly kind: "rejected"; readonly reason: PiMessageUpdateRejection };

/**
 * `assistantMessageEvent.type` values that state raw chain-of-thought.
 *
 * All three are genuine reasoning facts. `text_start`, `text_end` and every
 * `toolcall_*` are NOT: they are framing, and reporting them as reasoning made
 * the card say `reasoning` while the child was answering.
 */
const RAW_REASONING_EVENT_TYPES: ReadonlySet<string> = new Set([
  "thinking_start",
  "thinking_delta",
  "thinking_end",
]);

/**
 * The ONE vocabulary of `assistantMessageEvent.type` values that state raw
 * chain-of-thought.
 *
 * Exported so the redaction boundary in `child-session-events.ts` decides
 * "is this carrier raw reasoning?" from the same closed set this classifier
 * uses. A second, drifting copy of the list is exactly how `thinking_start`
 * and `thinking_end` came to be classified as reasoning here while their
 * prose was retained there.
 */
export function isRawReasoningAssistantEventType(type: unknown): boolean {
  return typeof type === "string" && RAW_REASONING_EVENT_TYPES.has(type);
}

/** The `assistantMessageEvent.type` that declares an answer-text carrier. */
const ANSWER_EVENT_TYPE = "text_delta";

const REJECTED = (
  reason: PiMessageUpdateRejection,
): PiMessageUpdateCarrier => ({ kind: "rejected", reason });

/** Distinguishes "the frame states no such property" from a stated value. */
const ABSENT = Symbol("absent");
/** Reflection over the frame itself threw. */
const UNREADABLE = Symbol("unreadable");

const ownDescriptor = Result.fromThrowable(
  (target: object, key: string): PropertyDescriptor | undefined =>
    Object.getOwnPropertyDescriptor(target, key),
  () => UNREADABLE,
);

const isArrayValue = Result.fromThrowable(
  (value: unknown): boolean => Array.isArray(value),
  () => UNREADABLE,
);

/**
 * The value of an own, enumerable data property.
 *
 * An accessor states nothing (invoking it would run the payload's own code),
 * and neither does an inherited or non-enumerable property. A throwing trap is
 * {@link UNREADABLE}, never an exception.
 */
function ownDataValue(
  target: object,
  key: string,
): unknown | typeof ABSENT | typeof UNREADABLE {
  const descriptor = ownDescriptor(target, key);
  if (descriptor.isErr()) return UNREADABLE;
  const found = descriptor.value;
  if (found === undefined) return ABSENT;
  if (!("value" in found)) return ABSENT;
  if (found.enumerable !== true) return ABSENT;
  return found.value;
}

/** The value as a plain object, or a marker. Arrays are not carriers. */
function ownRecord(
  target: object,
  key: string,
): object | typeof ABSENT | typeof UNREADABLE {
  const value = ownDataValue(target, key);
  if (value === ABSENT || value === UNREADABLE) return value;
  if (typeof value !== "object" || value === null) return ABSENT;
  const array = isArrayValue(value);
  if (array.isErr()) return UNREADABLE;
  return array.value ? ABSENT : value;
}

/** One frame's observed carriers, before they are resolved into a verdict. */
interface CarrierObservation {
  /** Answer strings observed, in the order the carriers were read. */
  readonly answers: string[];
  /** An answer carrier was declared but stated no usable string. */
  malformedAnswer: boolean;
  /** An answer carrier stated a string beyond the event string bound. */
  oversizedAnswer: boolean;
  /** Raw chain-of-thought was declared, in any shape. */
  reasoning: boolean;
}

/**
 * Classifies one `message_update` record.
 *
 * The caller has already decided the frame is a `message_update`; this reads
 * only its carriers. Never throws, never invokes an accessor, and never
 * returns reasoning prose.
 */
export function classifyPiMessageUpdate(
  record: unknown,
): PiMessageUpdateCarrier {
  if (typeof record !== "object" || record === null) return { kind: "framing" };
  const array = isArrayValue(record);
  if (array.isErr()) return REJECTED("unreadable");
  if (array.value) return { kind: "framing" };

  const observed: CarrierObservation = {
    answers: [],
    malformedAnswer: false,
    oversizedAnswer: false,
    reasoning: false,
  };

  if (!observeLegacyDelta(record, observed)) return REJECTED("unreadable");
  if (!observeAssistantEvent(record, observed)) return REJECTED("unreadable");

  const answerDeclared =
    observed.answers.length > 0 ||
    observed.malformedAnswer ||
    observed.oversizedAnswer;
  // Ambiguity is resolved in favour of NEITHER carrier. Publishing the answer
  // would publish whatever the reasoning carrier put beside it; publishing the
  // reasoning fact would claim something about a frame that also spoke.
  if (observed.reasoning && answerDeclared) return REJECTED("mixed-carriers");
  if (observed.oversizedAnswer) return REJECTED("oversized-answer");
  if (observed.malformedAnswer) return REJECTED("malformed-answer");
  if (observed.reasoning) return { kind: "reasoning" };
  const [first, ...rest] = observed.answers;
  if (first === undefined) return { kind: "framing" };
  if (rest.some((other) => other !== first)) {
    return REJECTED("conflicting-answers");
  }
  return { kind: "answer", text: first };
}

/**
 * Reads the legacy `delta: { text } | { thinking }` carrier.
 *
 * Returns `false` when the frame could not be read at all.
 */
function observeLegacyDelta(
  record: object,
  observed: CarrierObservation,
): boolean {
  const delta = ownRecord(record, "delta");
  if (delta === UNREADABLE) return false;
  if (delta === ABSENT) return true;

  const thinking = ownDataValue(delta, "thinking");
  if (thinking === UNREADABLE) return false;
  // A declared thinking carrier is a reasoning fact whatever its payload
  // looks like: this classification never reads the prose, so a malformed
  // thinking value is still the child reasoning. A key stated as `undefined`
  // is the JSON "absent" this boundary already sees everywhere else.
  if (thinking !== ABSENT && thinking !== undefined) observed.reasoning = true;

  const text = ownDataValue(delta, "text");
  if (text === UNREADABLE) return false;
  if (text === ABSENT) return true;
  recordAnswer(text, observed);
  return true;
}

/**
 * Reads the `assistantMessageEvent: { type, delta }` carrier.
 *
 * Returns `false` when the frame could not be read at all.
 */
function observeAssistantEvent(
  record: object,
  observed: CarrierObservation,
): boolean {
  const event = ownRecord(record, "assistantMessageEvent");
  if (event === UNREADABLE) return false;
  if (event === ABSENT) return true;

  const type = ownDataValue(event, "type");
  if (type === UNREADABLE) return false;
  if (typeof type !== "string") return true;
  if (RAW_REASONING_EVENT_TYPES.has(type)) {
    observed.reasoning = true;
    return true;
  }
  if (type !== ANSWER_EVENT_TYPE) return true;

  const delta = ownDataValue(event, "delta");
  if (delta === UNREADABLE) return false;
  recordAnswer(delta === ABSENT ? undefined : delta, observed);
  return true;
}

/** Folds one declared answer carrier's payload into the observation. */
function recordAnswer(value: unknown, observed: CarrierObservation): void {
  if (typeof value !== "string") {
    observed.malformedAnswer = true;
    return;
  }
  if (value.length > MAX_MESSAGE_UPDATE_ANSWER_LENGTH) {
    observed.oversizedAnswer = true;
    return;
  }
  observed.answers.push(value);
}

/**
 * The answer text one `message_update` states, or `undefined`.
 *
 * The narrow reader every text consumer uses. Reasoning, framing and every
 * rejection all answer `undefined`, so no caller can accidentally publish a
 * frame this boundary refused.
 */
export function messageUpdateAnswerText(record: unknown): string | undefined {
  const carrier = classifyPiMessageUpdate(record);
  return carrier.kind === "answer" ? carrier.text : undefined;
}

/**
 * True when the frame states, unambiguously, that the child produced raw
 * chain-of-thought.
 *
 * Content-free: it is the fact, never the prose. A frame that also carried
 * answer text is rejected upstream and answers `false` here too.
 */
export function messageUpdateObservesRawReasoning(record: unknown): boolean {
  return classifyPiMessageUpdate(record).kind === "reasoning";
}
