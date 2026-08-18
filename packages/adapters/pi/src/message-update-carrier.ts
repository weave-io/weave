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
 * The same ambiguity has a HIDDEN form: a frame whose
 * `assistantMessageEvent.type` says `text_delta` (or `answer`, or anything
 * else) while the carrier buries the thought in a `thinking` / `reasoning`
 * member, or in a nested `{ type: "thinking" }` content block. Deciding from
 * the declared type alone published those frames as pure answers. The type is
 * therefore only one of the things read: any carrier that still holds raw
 * reasoning prose, however it labels itself, is a reasoning carrier here.
 *
 * That scan reads the WHOLE frame, not a list of members this module happens
 * to know. A thought parked in a top-level `metadata.trace.content` block —
 * a member no carrier declares and no field list names — is the same
 * disclosure as one parked in `assistantMessageEvent.thinking`, and scanning
 * only the two carriers plus a couple of frame keys published exactly that
 * frame as a clean answer. Ordinary answers survive the wider scan because
 * the scan is structural rather than positional: only a `thinking` /
 * `reasoning` member that still holds a non-empty string, or a
 * `{ type: "thinking" | "reasoning" }` block that does, declares anything. A
 * numeric `usage.reasoning` token count states no prose, so it states nothing.
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
  /**
   * Answer text and raw reasoning were both carried by one frame - whether
   * the reasoning was declared by the carrier's type or hidden in a prose
   * member or a nested thinking block beside the answer.
   */
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

/**
 * Keys that state raw chain-of-thought PROSE wherever a carrier declares them.
 *
 * The declared `type` is not the only thing that makes a frame reasoning. A
 * carrier may say `text_delta` (or any other type, including one this module
 * has no rule for) and still hold the thought in a `thinking` or `reasoning`
 * member beside its answer, and nothing on the wire forbids that. Reading the
 * type alone published such a frame as a pure answer and left the prose in
 * everything retained from it.
 *
 * Exported so `child-session-events.ts` redacts the SAME keys this classifier
 * refuses on; `message-update-carrier.test.ts` pins the two lists together.
 */
export const RAW_REASONING_PROSE_KEYS: readonly string[] = [
  "thinking",
  "reasoning",
];

const RAW_REASONING_PROSE_KEY_SET: ReadonlySet<string> = new Set(
  RAW_REASONING_PROSE_KEYS,
);

/**
 * Content-block `type` values that state raw chain-of-thought.
 *
 * A block is the second hidden carrier: `{ type: "thinking", text }` nested in
 * a carrier's `content` is the whole thought, whatever the carrier's own type
 * claims to be.
 */
const RAW_REASONING_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "thinking",
  "reasoning",
]);

/** How deep one hidden-carrier scan walks before it describes nothing. */
const MAX_HIDDEN_REASONING_DEPTH = 8;
/** How many objects one frame's scans may read before they describe nothing. */
const MAX_HIDDEN_REASONING_NODES = 512;

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

/** Own enumerable key names, or {@link UNREADABLE} when reflection threw. */
const ownEnumerableKeys = Result.fromThrowable(
  (target: object): string[] => Object.keys(target),
  () => UNREADABLE,
);

/** How many objects one frame's hidden-reasoning scans may still read. */
interface ScanBudget {
  remaining: number;
}

/**
 * True when some string this value can still reach holds prose.
 *
 * `type` is skipped: a block kind (`"thinking"`) is structure, not
 * chain-of-thought, so a block whose prose is already blank states nothing and
 * an emptied carrier reclassifies exactly as it did before it was emptied.
 * Mirrors `carriesReasoningProse` in the redaction boundary.
 */
function reachesProse(
  value: unknown,
  budget: ScanBudget,
  depth: number,
): boolean | typeof UNREADABLE {
  if (typeof value === "string") return value !== "";
  if (typeof value !== "object" || value === null) return false;
  if (depth >= MAX_HIDDEN_REASONING_DEPTH) return UNREADABLE;
  if (budget.remaining <= 0) return UNREADABLE;
  budget.remaining -= 1;
  const keys = ownEnumerableKeys(value);
  if (keys.isErr()) return UNREADABLE;
  for (const key of keys.value) {
    if (key === "type") continue;
    const member = ownDataValue(value, key);
    if (member === UNREADABLE) return UNREADABLE;
    if (member === ABSENT) continue;
    const nested = reachesProse(member, budget, depth + 1);
    if (nested !== false) return nested;
  }
  return false;
}

/**
 * True when this value DECLARES raw chain-of-thought, however it is buried.
 *
 * Two declarations count, and both are structural rather than typed:
 *
 * - a `thinking` or `reasoning` member that still holds prose, at any depth;
 * - a `{ type: "thinking" | "reasoning", … }` content block that still holds
 *   prose, at any depth.
 *
 * Everything else is left alone, which is what keeps ordinary answer frames
 * (and the numeric `usage.reasoning` token count beside them) out of it: a
 * key that names reasoning but carries no prose declares nothing.
 */
function declaresHiddenReasoning(
  value: unknown,
  budget: ScanBudget,
  depth: number,
): boolean | typeof UNREADABLE {
  if (typeof value !== "object" || value === null) return false;
  if (depth >= MAX_HIDDEN_REASONING_DEPTH) return UNREADABLE;
  if (budget.remaining <= 0) return UNREADABLE;
  budget.remaining -= 1;
  const array = isArrayValue(value);
  if (array.isErr()) return UNREADABLE;
  const keys = ownEnumerableKeys(value);
  if (keys.isErr()) return UNREADABLE;
  if (!array.value) {
    const type = ownDataValue(value, "type");
    if (type === UNREADABLE) return UNREADABLE;
    if (typeof type === "string" && RAW_REASONING_BLOCK_TYPES.has(type)) {
      const prose = reachesProse(value, budget, depth);
      if (prose !== false) return prose;
    }
  }
  for (const key of keys.value) {
    const member = ownDataValue(value, key);
    if (member === UNREADABLE) return UNREADABLE;
    if (member === ABSENT || member === undefined) continue;
    if (!array.value && RAW_REASONING_PROSE_KEY_SET.has(key)) {
      const prose = reachesProse(member, budget, depth + 1);
      if (prose !== false) return prose;
    }
    const nested = declaresHiddenReasoning(member, budget, depth + 1);
    if (nested !== false) return nested;
  }
  return false;
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

  // One budget for the whole frame, spent by ONE walk of it: a hostile
  // payload cannot pay for a deep scan once per carrier, and no member is
  // charged twice because a carrier happens to be scanned again by name.
  const budget: ScanBudget = { remaining: MAX_HIDDEN_REASONING_NODES };
  if (!observeFrameHiddenReasoning(record, observed, budget)) {
    return REJECTED("unreadable");
  }
  if (!observeLegacyDelta(record, observed)) {
    return REJECTED("unreadable");
  }
  if (!observeAssistantEvent(record, observed)) {
    return REJECTED("unreadable");
  }

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

  // Prose this carrier buries under a reasoning key or a reasoning block was
  // already found by the frame-wide scan. What is left here is the carrier's
  // OWN declaration, which is a reasoning fact whatever its payload holds.
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

  // Hidden prose was read BEFORE this, by the frame-wide scan, and
  // independently of the type: `text_delta` beside a `thinking` member, or an
  // `answer` frame whose `content` holds a thinking block, is a raw-reasoning
  // carrier however it labels itself; a frame that then also declares an
  // answer is mixed, and moves nothing. All that is read here is the type's
  // own statement and the answer text it declares.
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

/**
 * Reads raw-reasoning prose ANYWHERE in the frame, under any member.
 *
 * One walk of the whole `message_update` record, carriers included. A
 * narrower version of this read only the frame's two prose keys, its
 * `content` list and the two carriers it knows by name, so a thought parked
 * under an undeclared top-level member — `metadata.trace.content` holding a
 * `{ type: "thinking", text }` block — was found nowhere and the frame was
 * published as a clean answer with the prose still attached to it.
 *
 * Widening the walk does not widen what COUNTS as reasoning: only a
 * `thinking` / `reasoning` member that still holds a non-empty string, or a
 * `{ type: "thinking" | "reasoning" }` block that does, declares anything. The
 * frame's `text`, `partial` and `partialText` answer snapshots are strings
 * under ordinary keys and `usage.reasoning` is a number, so neither is prose
 * and neither turns an answer into a reasoning frame.
 *
 * Returns `false` when the frame could not be read at all.
 */
function observeFrameHiddenReasoning(
  record: object,
  observed: CarrierObservation,
  budget: ScanBudget,
): boolean {
  const hidden = declaresHiddenReasoning(record, budget, 0);
  if (hidden === UNREADABLE) return false;
  if (hidden) observed.reasoning = true;
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
