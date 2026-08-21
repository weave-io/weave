import { err, ok, Result, type ResultAsync } from "neverthrow";
import { z } from "zod";
import {
  observePiModel,
  type PiModelInfo,
  type PiModelInfoWithContextWindow,
  type PiOrderedModelResolution,
} from "./model-resolution.js";
import { canonicalizeToBytes, type JsonValue } from "./strict-json.js";

const PI_FAILOVER_INPUT_SCHEMA = z.unknown();
export type PiFailoverObservedValue = z.input<typeof PI_FAILOVER_INPUT_SCHEMA>;

interface PiInspectableObject {
  readonly piInspectableObjectMarker?: never;
}

const PI_INSPECTABLE_OBJECT_SCHEMA = z.custom<PiInspectableObject>((value) =>
  Result.fromThrowable(
    () =>
      value !== null && Object(value) === value && !(value instanceof Function),
    (): boolean => false,
  )().unwrapOr(false),
);

const PI_STRING_SCHEMA = z.string();
const PI_BOOLEAN_SCHEMA = z.boolean();
const PI_NUMBER_SCHEMA = z.number();

function parseInspectableObject(
  value: PiFailoverObservedValue,
): PiInspectableObject | undefined {
  const parsed = PI_INSPECTABLE_OBJECT_SCHEMA.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parsePropertyKeyString(key: PropertyKey): string | undefined {
  const parsed = PI_STRING_SCHEMA.safeParse(key);
  return parsed.success ? parsed.data : undefined;
}

/** The complete, closed set of provider failures eligible for model fallback. */
export const PI_FAILOVER_FAILURE_CLASSES = Object.freeze([
  "authentication_failed",
  "authorization_failed",
  "rate_limited",
  "provider_unavailable",
  "timeout",
  "context_overflow_unrecovered",
  "unknown_provider_failure",
] as const);

export type PiFailoverFailureClass =
  (typeof PI_FAILOVER_FAILURE_CLASSES)[number];

/** A classification contains only a closed class. Provider data never crosses this boundary. */
export interface PiFailureClassification {
  readonly failureClass: PiFailoverFailureClass;
}

/** The largest UTF-8 failure field the classifier will inspect. */
export const MAX_PI_ERROR_MESSAGE_BYTES = 512;

/** Compatibility name for callers that used the partial contract. */
export const MAX_PI_ERROR_MESSAGE_PREFIX_LENGTH = MAX_PI_ERROR_MESSAGE_BYTES;

/** Maximum number of nested provider error objects inspected by the classifier. */
export const MAX_PI_FAILURE_EVIDENCE_DEPTH = 2;

/** Maximum candidate count retained by a frozen failover list. */
export const MAX_PI_FAILOVER_CANDIDATES = 64;

/** Marker custom type used for a fallback recovery turn. */
export const PI_MODEL_FAILOVER_MARKER_TYPE =
  "weave.model-fallback.recovery-marker" as const;

/** Compatibility names for the public marker type. */
export const PI_MODEL_FALLBACK_MARKER_TYPE = PI_MODEL_FAILOVER_MARKER_TYPE;
export const PI_FAILOVER_MARKER_TYPE = PI_MODEL_FAILOVER_MARKER_TYPE;

export const PI_MODEL_FAILOVER_MARKER_SCHEMA_VERSION = 1 as const;
export const PI_MODEL_FAILOVER_MARKER_CONTENT =
  "Weave model fallback recovery." as const;
export const MAX_PI_MODEL_FAILOVER_MARKER_CONTENT_BYTES = 128;

/** RFC 4122 version-4 UUID syntax, including the RFC variant bits. */
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const hasOwnPropertyFn = Object.prototype.hasOwnProperty;
const stringToLowerCase = String.prototype.toLowerCase;
const textEncoder = new TextEncoder();

export type PiOwnDataReadState = "missing" | "data" | "accessor" | "unreadable";

export interface PiOwnDataRead {
  readonly state: PiOwnDataReadState;
  readonly value?: PiFailoverObservedValue;
}

/**
 * Read one own enumerable data property without invoking a getter. A proxy
 * trap or descriptor failure is represented as `unreadable`, never thrown.
 */
export function readPiOwnEnumerableData(
  target: PiFailoverObservedValue,
  key: PropertyKey,
): PiOwnDataRead {
  const parsedTarget = parseInspectableObject(target);
  if (parsedTarget === undefined) return { state: "missing" };

  return Result.fromThrowable(
    () => getOwnPropertyDescriptor(parsedTarget, key),
    (): undefined => undefined,
  )().match(
    (descriptor) => {
      if (descriptor === undefined || descriptor.enumerable !== true) {
        return { state: "missing" };
      }
      if (!hasOwnPropertyFn.call(descriptor, "value")) {
        return { state: "accessor" };
      }
      return { state: "data", value: descriptor.value };
    },
    () => ({ state: "unreadable" as const }),
  );
}

function readOwnPropertyDescriptor(
  target: PiInspectableObject,
  key: PropertyKey,
): Result<PropertyDescriptor | undefined, "unreadable"> {
  return Result.fromThrowable(
    () => getOwnPropertyDescriptor(target, key),
    (): "unreadable" => "unreadable",
  )();
}

function readOwnKeys(
  target: PiInspectableObject,
): Result<readonly PropertyKey[], "unreadable"> {
  return Result.fromThrowable(
    () => Reflect.ownKeys(target),
    (): "unreadable" => "unreadable",
  )();
}

function readPrototype(
  target: PiInspectableObject,
): Result<PiInspectableObject | null, "unreadable"> {
  return Result.fromThrowable(
    () => getPrototypeOf(target),
    (): "unreadable" => "unreadable",
  )();
}

function boundedText(
  value: PiFailoverObservedValue,
):
  | { readonly state: "usable"; readonly text: string }
  | { readonly state: "absent" | "hostile" } {
  const parsedValue = PI_STRING_SCHEMA.safeParse(value);
  if (!parsedValue.success) return { state: "absent" };
  if (parsedValue.data.length > MAX_PI_ERROR_MESSAGE_BYTES) {
    return { state: "hostile" };
  }

  const bytes = Result.fromThrowable(
    () => textEncoder.encode(parsedValue.data),
    (): undefined => undefined,
  )();
  if (bytes.isErr() || bytes.value.byteLength > MAX_PI_ERROR_MESSAGE_BYTES) {
    return { state: "hostile" };
  }

  return {
    state: "usable",
    text: stringToLowerCase.call(parsedValue.data),
  };
}

function classifyText(text: string): PiFailoverFailureClass {
  if (
    /(?:^|\b)401(?:\b|\s|:)/u.test(text) ||
    /\bunauthori[sz]ed\b/u.test(text) ||
    /\bauthentication(?:\s+failed|\s+error)?\b/u.test(text) ||
    /\binvalid\s+(?:api|access)\s+key\b/u.test(text)
  ) {
    return "authentication_failed";
  }

  if (
    /(?:^|\b)403(?:\b|\s|:)/u.test(text) ||
    /\bforbidden\b/u.test(text) ||
    /\bpermission\s+denied\b/u.test(text) ||
    /\baccess\s+denied\b/u.test(text) ||
    /\bnot\s+authorized\b/u.test(text) ||
    /\bauthorization\s+failed\b/u.test(text)
  ) {
    return "authorization_failed";
  }

  if (
    /(?:^|\b)429(?:\b|\s|:)/u.test(text) ||
    /\brate[\s_-]*limit(?:ed|ing)?\b/u.test(text) ||
    /\btoo\s+many\s+requests\b/u.test(text) ||
    /\bthrottl(?:ed|e|ing)\b/u.test(text)
  ) {
    return "rate_limited";
  }

  if (
    /\bcontext\s+(?:window|length|limit|overflow)\b/u.test(text) ||
    /\bmaximum\s+context\b/u.test(text) ||
    /\bprompt\s+(?:is\s+)?too\s+long\b/u.test(text) ||
    /\binput\s+too\s+long\b/u.test(text) ||
    /\btoo\s+many\s+tokens\b/u.test(text) ||
    /\btoken\s+limit\b/u.test(text) ||
    /\b(?:exceeded|exceeds)\b[^\n]{0,64}\bcontext\b/u.test(text) ||
    /\b(?:context[_ -]?length|prompt[_ -]?length)[_-]?(?:exceeded|too[_ -]?long)\b/u.test(
      text,
    )
  ) {
    return "context_overflow_unrecovered";
  }

  if (
    /\b(?:timed?\s*out|timeout|deadline\s+exceeded)\b/u.test(text) ||
    /\betimedout\b/u.test(text) ||
    /\b(?:econnreset|eai_again|e?timeout)\b/u.test(text)
  ) {
    return "timeout";
  }

  if (
    /(?:^|\b)5\d\d(?:\b|\s|:)/u.test(text) ||
    /\b(?:provider|service|upstream)\s+(?:unavailable|error)\b/u.test(text) ||
    /\bservice\s+unavailable\b/u.test(text) ||
    /\btemporarily\s+unavailable\b/u.test(text) ||
    /\bbad\s+gateway\b/u.test(text) ||
    /\binternal\s+server\s+error\b/u.test(text) ||
    /\b(?:provider|service)\s+overloaded\b/u.test(text)
  ) {
    return "provider_unavailable";
  }

  return "unknown_provider_failure";
}

const STATUS_KEYS = [
  "statusCode",
  "httpStatus",
  "responseStatus",
  "status",
  "code",
] as const;
const TEXT_KEYS = [
  "errorMessage",
  "message",
  "statusText",
  "reason",
  "name",
  "code",
] as const;
const NESTED_ERROR_KEYS = ["error", "cause", "response"] as const;
const BOOLEAN_TIMEOUT_KEYS = ["timeout", "timedOut", "timed_out"] as const;
const BOOLEAN_OVERFLOW_KEYS = [
  "contextOverflow",
  "context_overflow",
  "contextLengthExceeded",
] as const;

interface FailureEvidence {
  readonly statusCodes: readonly number[];
  readonly textClasses: readonly PiFailoverFailureClass[];
  readonly timeoutFlag: boolean;
  readonly overflowFlag: boolean;
  readonly hostile: boolean;
}

function collectFailureEvidence(
  root: PiFailoverObservedValue,
): FailureEvidence {
  const statusCodes: number[] = [];
  const textClasses: PiFailoverFailureClass[] = [];
  const queue: Array<{
    readonly value: PiFailoverObservedValue;
    readonly depth: number;
  }> = [{ value: root, depth: 0 }];
  const seen = new Set<PiInspectableObject>();
  let timeoutFlag = false;
  let overflowFlag = false;
  let hostile = false;

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const { value, depth } = current;
    const currentObject = parseInspectableObject(value);
    if (currentObject === undefined) continue;
    if (seen.has(currentObject)) continue;
    seen.add(currentObject);

    for (const key of STATUS_KEYS) {
      const read = readPiOwnEnumerableData(currentObject, key);
      if (read.state === "accessor" || read.state === "unreadable") {
        hostile = true;
        continue;
      }
      if (read.state !== "data") continue;
      const status = PI_NUMBER_SCHEMA.safeParse(read.value);
      if (
        status.success &&
        Number.isSafeInteger(status.data) &&
        status.data >= 100 &&
        status.data <= 599
      ) {
        statusCodes.push(status.data);
      }
    }

    for (const key of TEXT_KEYS) {
      const read = readPiOwnEnumerableData(currentObject, key);
      if (read.state === "accessor" || read.state === "unreadable") {
        hostile = true;
        continue;
      }
      if (read.state !== "data") continue;
      const text = boundedText(read.value);
      if (text.state === "hostile") {
        hostile = true;
      } else if (text.state === "usable") {
        textClasses.push(classifyText(text.text));
      }
    }

    for (const key of BOOLEAN_TIMEOUT_KEYS) {
      const read = readPiOwnEnumerableData(currentObject, key);
      if (read.state === "accessor" || read.state === "unreadable") {
        hostile = true;
      } else if (read.state === "data") {
        const timeout = PI_BOOLEAN_SCHEMA.safeParse(read.value);
        if (timeout.success && timeout.data) timeoutFlag = true;
      }
    }

    for (const key of BOOLEAN_OVERFLOW_KEYS) {
      const read = readPiOwnEnumerableData(currentObject, key);
      if (read.state === "accessor" || read.state === "unreadable") {
        hostile = true;
      } else if (read.state === "data") {
        const overflow = PI_BOOLEAN_SCHEMA.safeParse(read.value);
        if (overflow.success && overflow.data) overflowFlag = true;
      }
    }

    if (depth >= MAX_PI_FAILURE_EVIDENCE_DEPTH) continue;
    for (const key of NESTED_ERROR_KEYS) {
      const read = readPiOwnEnumerableData(currentObject, key);
      if (read.state === "accessor" || read.state === "unreadable") {
        hostile = true;
        continue;
      }
      if (read.state !== "data") continue;
      const nestedObject = parseInspectableObject(read.value);
      if (nestedObject !== undefined) {
        queue.push({ value: nestedObject, depth: depth + 1 });
      }
    }
  }

  return { statusCodes, textClasses, timeoutFlag, overflowFlag, hostile };
}

function classifyTerminalAssistant(
  message: PiFailoverObservedValue,
): PiFailureClassification | undefined {
  const messageObject = parseInspectableObject(message);
  if (messageObject === undefined) return undefined;
  const role = readPiOwnEnumerableData(messageObject, "role");
  if (role.state !== "data" || role.value !== "assistant") return undefined;
  const stopReason = readPiOwnEnumerableData(messageObject, "stopReason");
  if (stopReason.state !== "data") return undefined;
  const parsedStopReason = PI_STRING_SCHEMA.safeParse(stopReason.value);
  if (!parsedStopReason.success) return undefined;

  // Only a terminal provider error is a fallback signal. In particular, a
  // length stop is not evidence that Pi's overflow recovery failed.
  if (parsedStopReason.data !== "error") return undefined;

  const evidence = collectFailureEvidence(messageObject);
  if (evidence.hostile) {
    return { failureClass: "unknown_provider_failure" };
  }

  const status = evidence.statusCodes.find((value) => value === 401);
  if (status !== undefined) {
    return { failureClass: "authentication_failed" };
  }
  if (evidence.statusCodes.some((value) => value === 403)) {
    return { failureClass: "authorization_failed" };
  }
  if (evidence.statusCodes.some((value) => value === 429)) {
    return { failureClass: "rate_limited" };
  }
  if (evidence.statusCodes.some((value) => value === 408)) {
    return { failureClass: "timeout" };
  }
  if (evidence.statusCodes.some((value) => value >= 500 && value <= 599)) {
    return { failureClass: "provider_unavailable" };
  }
  if (evidence.overflowFlag) {
    return { failureClass: "context_overflow_unrecovered" };
  }
  if (evidence.timeoutFlag) {
    return { failureClass: "timeout" };
  }

  const textPriority: readonly PiFailoverFailureClass[] = [
    "authentication_failed",
    "authorization_failed",
    "rate_limited",
    "context_overflow_unrecovered",
    "timeout",
    "provider_unavailable",
  ];
  for (const failureClass of textPriority) {
    if (evidence.textClasses.includes(failureClass)) {
      return { failureClass };
    }
  }

  return { failureClass: "unknown_provider_failure" };
}

/**
 * Classify the terminal assistant from `message_end`. The function accepts
 * either the parser-approved assistant or its public `message_end` wrapper;
 * it does not accept the old recovery-exhausted hook payload. It returns no
 * classification for abort, normal completion, or a length stop.
 */
export function classifyPiFailure(
  messageOrEvent: PiFailoverObservedValue,
): PiFailureClassification | undefined {
  return Result.fromThrowable(
    () => {
      const eventObject = parseInspectableObject(messageOrEvent);
      if (eventObject !== undefined) {
        const type = readPiOwnEnumerableData(eventObject, "type");
        if (type.state === "data" && type.value === "message_end") {
          const message = readPiOwnEnumerableData(eventObject, "message");
          return message.state === "data"
            ? classifyTerminalAssistant(message.value)
            : undefined;
        }
      }
      return classifyTerminalAssistant(messageOrEvent);
    },
    (): undefined => void 0,
  )().match(
    (value) => value,
    () => void 0,
  );
}

/** Provider-boundary spelling for the terminal `message_end` classifier. */
export const classifyPiProviderFailure = classifyPiFailure;

/** Classify an event only when it is the public terminal `message_end` event. */
export function classifyPiMessageEndFailure(
  event: PiFailoverObservedValue,
): PiFailureClassification | undefined {
  const eventObject = parseInspectableObject(event);
  if (eventObject === undefined) return undefined;
  const type = readPiOwnEnumerableData(eventObject, "type");
  const message = readPiOwnEnumerableData(eventObject, "message");
  if (type.state !== "data" || type.value !== "message_end") return undefined;
  if (message.state !== "data") return undefined;
  return classifyPiFailure(message.value);
}

/** Public Pi settlement carries no recovery payload. */
export function isPiPayloadlessAgentSettledEvent(
  event: PiFailoverObservedValue,
): event is { readonly type: "agent_settled" } {
  const eventObject = parseInspectableObject(event);
  if (eventObject === undefined) return false;
  const type = readPiOwnEnumerableData(eventObject, "type");
  if (type.state !== "data" || type.value !== "agent_settled") return false;
  const keys = readOwnKeys(eventObject);
  return keys.isOk() && keys.value.length === 1 && keys.value[0] === "type";
}

export const isPiAgentSettledEvent = isPiPayloadlessAgentSettledEvent;

/** Whether this class may consume a candidate in the current prompt epoch. */
export function isPiFailureAdvanceEligible(
  failureClass: PiFailoverFailureClass,
  unknownAdvancesUsed = 0,
): boolean {
  if (!isPiFailoverFailureClass(failureClass)) return false;
  if (failureClass !== "unknown_provider_failure") return true;
  return (
    Number.isSafeInteger(unknownAdvancesUsed) &&
    unknownAdvancesUsed >= 0 &&
    unknownAdvancesUsed < 1
  );
}

/** Compatibility spelling for coordinator policy call sites. */
export const canAdvancePiFailover = isPiFailureAdvanceEligible;

export interface PiFailoverAdvanceState {
  readonly advance: boolean;
  readonly unknownAdvancesUsed: number;
}

/** Consume at most one unknown-provider allowance without retaining failure data. */
export function consumePiFailureAdvance(
  failureClass: PiFailoverFailureClass,
  unknownAdvancesUsed = 0,
): PiFailoverAdvanceState {
  const prior =
    Number.isSafeInteger(unknownAdvancesUsed) && unknownAdvancesUsed >= 0
      ? Math.min(unknownAdvancesUsed, 1)
      : 0;
  const advance = isPiFailureAdvanceEligible(failureClass, prior);
  return {
    advance,
    unknownAdvancesUsed:
      failureClass === "unknown_provider_failure" && advance
        ? prior + 1
        : prior,
  };
}

/** Marker details are intentionally the only correlation data sent to Pi. */
export interface PiModelFailoverMarkerDetails {
  readonly schemaVersion: typeof PI_MODEL_FAILOVER_MARKER_SCHEMA_VERSION;
  readonly token: string;
}

/** Public custom message shape passed to `sendMessage`. */
export interface PiModelFailoverMarker {
  readonly role: "custom";
  readonly customType: typeof PI_MODEL_FAILOVER_MARKER_TYPE;
  readonly content: typeof PI_MODEL_FAILOVER_MARKER_CONTENT;
  readonly details: PiModelFailoverMarkerDetails;
  readonly display: false;
}

export type PiModelFailoverMarkerError =
  | { readonly type: "MarkerTokenInvalid" }
  | { readonly type: "MarkerTokenGenerationFailed" }
  | { readonly type: "MarkerContentOutOfBounds" }
  | { readonly type: "MarkerDetailsMalformed" };

/** Check the strict RFC 4122 version-4 token shape. */
export function isPiUuidV4(value: PiFailoverObservedValue): value is string {
  const parsed = PI_STRING_SCHEMA.safeParse(value);
  return parsed.success && UUID_V4_PATTERN.test(parsed.data);
}

/** Compatibility spelling for marker-token validation. */
export const isPiUuidV4Token = isPiUuidV4;

function strictMarkerDetails(
  value: PiFailoverObservedValue,
  expectedToken?: string,
): Result<PiModelFailoverMarkerDetails, PiModelFailoverMarkerError> {
  const object = parseInspectableObject(value);
  if (object === undefined) {
    return err({ type: "MarkerDetailsMalformed" });
  }
  const prototype = readPrototype(object);
  if (
    prototype.isErr() ||
    (prototype.value !== Object.prototype && prototype.value !== null)
  ) {
    return err({ type: "MarkerDetailsMalformed" });
  }
  const keys = readOwnKeys(object);
  if (
    keys.isErr() ||
    keys.value.some((key) => parsePropertyKeyString(key) === undefined)
  ) {
    return err({ type: "MarkerDetailsMalformed" });
  }
  if (
    keys.value.length !== 2 ||
    !keys.value.includes("schemaVersion") ||
    !keys.value.includes("token")
  ) {
    return err({ type: "MarkerDetailsMalformed" });
  }
  const schemaVersion = readPiOwnEnumerableData(object, "schemaVersion");
  const token = readPiOwnEnumerableData(object, "token");
  if (
    schemaVersion.state !== "data" ||
    token.state !== "data" ||
    schemaVersion.value !== PI_MODEL_FAILOVER_MARKER_SCHEMA_VERSION ||
    !isPiUuidV4(token.value)
  ) {
    return err({ type: "MarkerDetailsMalformed" });
  }
  if (expectedToken !== undefined && token.value !== expectedToken) {
    return err({ type: "MarkerTokenInvalid" });
  }
  return ok({
    schemaVersion: PI_MODEL_FAILOVER_MARKER_SCHEMA_VERSION,
    token: token.value,
  });
}

/** Validate marker details without retaining or exposing provider content. */
export function parsePiModelFailoverMarkerDetails(
  value: PiFailoverObservedValue,
  expectedToken?: string,
): Result<PiModelFailoverMarkerDetails, PiModelFailoverMarkerError> {
  if (expectedToken !== undefined && !isPiUuidV4(expectedToken)) {
    return err({ type: "MarkerTokenInvalid" });
  }
  return Result.fromThrowable(
    () => strictMarkerDetails(value, expectedToken),
    (): PiModelFailoverMarkerError => ({ type: "MarkerDetailsMalformed" }),
  )().andThen((result) => result);
}

/** Create the fixed, hidden, strictly correlated recovery marker. */
export function createPiModelFailoverMarker(
  token?: string,
): Result<PiModelFailoverMarker, PiModelFailoverMarkerError> {
  const generated = Result.fromThrowable(
    () => token ?? crypto.randomUUID(),
    (): PiModelFailoverMarkerError => ({ type: "MarkerTokenGenerationFailed" }),
  )();
  if (generated.isErr()) return err(generated.error);
  if (!isPiUuidV4(generated.value)) {
    return err({ type: "MarkerTokenInvalid" });
  }

  const contentBytes = textEncoder.encode(PI_MODEL_FAILOVER_MARKER_CONTENT);
  if (contentBytes.byteLength > MAX_PI_MODEL_FAILOVER_MARKER_CONTENT_BYTES) {
    return err({ type: "MarkerContentOutOfBounds" });
  }

  const details = Object.freeze({
    schemaVersion: PI_MODEL_FAILOVER_MARKER_SCHEMA_VERSION,
    token: generated.value,
  });
  return ok(
    Object.freeze({
      role: "custom" as const,
      customType: PI_MODEL_FAILOVER_MARKER_TYPE,
      content: PI_MODEL_FAILOVER_MARKER_CONTENT,
      details,
      display: false as const,
    }),
  );
}

/** Compatibility names used by adapter lifecycle call sites. */
export const createPiRecoveryMarker = createPiModelFailoverMarker;
export const createPiFailoverMarker = createPiModelFailoverMarker;
export const createPiModelFallbackMarker = createPiModelFailoverMarker;

/** Validate one complete marker against an expected token. */
export function isPiModelFailoverMarker(
  value: PiFailoverObservedValue,
  expectedToken?: string,
): value is PiModelFailoverMarker {
  const object = parseInspectableObject(value);
  if (object === undefined) return false;
  if (expectedToken !== undefined && !isPiUuidV4(expectedToken)) return false;
  const role = readPiOwnEnumerableData(object, "role");
  const customType = readPiOwnEnumerableData(object, "customType");
  const content = readPiOwnEnumerableData(object, "content");
  const display = readPiOwnEnumerableData(object, "display");
  const details = readPiOwnEnumerableData(object, "details");
  if (
    role.state !== "data" ||
    customType.state !== "data" ||
    content.state !== "data" ||
    display.state !== "data" ||
    details.state !== "data" ||
    role.value !== "custom" ||
    customType.value !== PI_MODEL_FAILOVER_MARKER_TYPE ||
    content.value !== PI_MODEL_FAILOVER_MARKER_CONTENT ||
    display.value !== false
  ) {
    return false;
  }
  return parsePiModelFailoverMarkerDetails(details.value, expectedToken).isOk();
}

/** Bounded fingerprint limits for a terminal assistant message. */
export const MAX_PI_ASSISTANT_FINGERPRINT_DEPTH = 8;
export const MAX_PI_ASSISTANT_FINGERPRINT_PROPERTIES = 256;
export const MAX_PI_ASSISTANT_FINGERPRINT_BYTES = 16_384;
export const MAX_PI_ASSISTANT_FINGERPRINT_CONTENT_BLOCKS = 64;

export interface PiAssistantFingerprint {
  readonly schemaVersion: 1;
  readonly algorithm: "sha256";
  readonly digest: string;
  readonly byteLength: number;
  readonly depth: number;
  readonly propertyCount: number;
  readonly contentBlockCount: number;
}

export type PiAssistantFingerprintError =
  | { readonly type: "FingerprintNotAssistant" }
  | { readonly type: "FingerprintDepthExceeded" }
  | { readonly type: "FingerprintPropertyLimitExceeded" }
  | { readonly type: "FingerprintByteLimitExceeded" }
  | { readonly type: "FingerprintContentBlockLimitExceeded" }
  | { readonly type: "FingerprintAccessor" }
  | { readonly type: "FingerprintProxy" }
  | { readonly type: "FingerprintUnsupportedValue" }
  | { readonly type: "FingerprintNonCanonicalValue" };

interface FingerprintState {
  depth: number;
  propertyCount: number;
  contentBlockCount: number;
}

interface PiFingerprintObject {
  [key: string]: JsonValue;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const high = code >= 0xd800 && code <= 0xdbff;
    const low = code >= 0xdc00 && code <= 0xdfff;
    if (high) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (low) {
      return true;
    }
  }
  return false;
}

function fingerprintFailure(
  type: PiAssistantFingerprintError["type"],
): Result<never, PiAssistantFingerprintError> {
  switch (type) {
    case "FingerprintNotAssistant":
      return err({ type: "FingerprintNotAssistant" });
    case "FingerprintDepthExceeded":
      return err({ type: "FingerprintDepthExceeded" });
    case "FingerprintPropertyLimitExceeded":
      return err({ type: "FingerprintPropertyLimitExceeded" });
    case "FingerprintByteLimitExceeded":
      return err({ type: "FingerprintByteLimitExceeded" });
    case "FingerprintContentBlockLimitExceeded":
      return err({ type: "FingerprintContentBlockLimitExceeded" });
    case "FingerprintAccessor":
      return err({ type: "FingerprintAccessor" });
    case "FingerprintProxy":
      return err({ type: "FingerprintProxy" });
    case "FingerprintUnsupportedValue":
      return err({ type: "FingerprintUnsupportedValue" });
    case "FingerprintNonCanonicalValue":
      return err({ type: "FingerprintNonCanonicalValue" });
  }
}

function addProperties(
  state: FingerprintState,
  count: number,
): Result<void, PiAssistantFingerprintError> {
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    state.propertyCount > MAX_PI_ASSISTANT_FINGERPRINT_PROPERTIES - count
  ) {
    return fingerprintFailure("FingerprintPropertyLimitExceeded");
  }
  state.propertyCount += count;
  return ok(void 0);
}

function cloneFingerprintValue(
  value: PiFailoverObservedValue,
  depth: number,
  state: FingerprintState,
): Result<JsonValue, PiAssistantFingerprintError> {
  if (depth > state.depth) state.depth = depth;
  if (depth > MAX_PI_ASSISTANT_FINGERPRINT_DEPTH) {
    return fingerprintFailure("FingerprintDepthExceeded");
  }
  if (value === null) return ok(null);
  const stringValue = PI_STRING_SCHEMA.safeParse(value);
  if (stringValue.success) {
    if (
      stringValue.data.length > MAX_PI_ASSISTANT_FINGERPRINT_BYTES ||
      hasLoneSurrogate(stringValue.data) ||
      textEncoder.encode(stringValue.data).byteLength >
        MAX_PI_ASSISTANT_FINGERPRINT_BYTES
    ) {
      return fingerprintFailure("FingerprintNonCanonicalValue");
    }
    return ok(stringValue.data);
  }
  const booleanValue = PI_BOOLEAN_SCHEMA.safeParse(value);
  if (booleanValue.success) return ok(booleanValue.data);
  const numberValue = PI_NUMBER_SCHEMA.safeParse(value);
  if (numberValue.success) {
    if (
      !Number.isFinite(numberValue.data) ||
      (Number.isInteger(numberValue.data) &&
        !Number.isSafeInteger(numberValue.data))
    ) {
      return fingerprintFailure("FingerprintNonCanonicalValue");
    }
    return ok(numberValue.data);
  }

  const object = parseInspectableObject(value);
  if (object === undefined) {
    return fingerprintFailure("FingerprintUnsupportedValue");
  }

  const prototype = readPrototype(object);
  if (prototype.isErr()) return fingerprintFailure("FingerprintProxy");

  if (Array.isArray(object)) {
    if (prototype.value !== Array.prototype) {
      return fingerprintFailure("FingerprintProxy");
    }
    const keys = readOwnKeys(object);
    if (keys.isErr()) return fingerprintFailure("FingerprintProxy");
    const stringKeys = keys.value
      .map(parsePropertyKeyString)
      .filter((key): key is string => key !== undefined);
    if (stringKeys.length !== keys.value.length) {
      return fingerprintFailure("FingerprintUnsupportedValue");
    }
    const lengthDescriptor = readOwnPropertyDescriptor(object, "length");
    if (
      lengthDescriptor.isErr() ||
      lengthDescriptor.value === undefined ||
      lengthDescriptor.value.enumerable !== false ||
      !hasOwnPropertyFn.call(lengthDescriptor.value, "value")
    ) {
      return fingerprintFailure("FingerprintAccessor");
    }
    const parsedLength = PI_NUMBER_SCHEMA.safeParse(
      lengthDescriptor.value.value,
    );
    if (
      !parsedLength.success ||
      !Number.isSafeInteger(parsedLength.data) ||
      parsedLength.data < 0 ||
      parsedLength.data > MAX_PI_ASSISTANT_FINGERPRINT_PROPERTIES
    ) {
      return fingerprintFailure("FingerprintAccessor");
    }
    const length = parsedLength.data;
    const propertyCount = addProperties(state, length);
    if (propertyCount.isErr()) {
      return fingerprintFailure(propertyCount.error.type);
    }

    const output: JsonValue[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = readOwnPropertyDescriptor(object, String(index));
      if (
        descriptor.isErr() ||
        descriptor.value === undefined ||
        descriptor.value.enumerable !== true ||
        !hasOwnPropertyFn.call(descriptor.value, "value")
      ) {
        return fingerprintFailure("FingerprintAccessor");
      }
      const child = cloneFingerprintValue(
        descriptor.value.value,
        depth + 1,
        state,
      );
      if (child.isErr()) return child;
      output.push(child.value);
    }

    if (
      stringKeys.some((key) => {
        if (key === "length") return false;
        if (!/^(?:0|[1-9]\d*)$/u.test(key)) return true;
        const index = Number(key);
        return (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= length ||
          String(index) !== key
        );
      })
    ) {
      return fingerprintFailure("FingerprintUnsupportedValue");
    }
    return ok(output);
  }

  if (prototype.value !== Object.prototype && prototype.value !== null) {
    return fingerprintFailure("FingerprintUnsupportedValue");
  }
  const keys = readOwnKeys(object);
  if (keys.isErr()) return fingerprintFailure("FingerprintProxy");
  const stringKeys = keys.value
    .map(parsePropertyKeyString)
    .filter((key): key is string => key !== undefined);
  if (stringKeys.length !== keys.value.length) {
    return fingerprintFailure("FingerprintUnsupportedValue");
  }
  const propertyCount = addProperties(state, stringKeys.length);
  if (propertyCount.isErr()) {
    return fingerprintFailure(propertyCount.error.type);
  }

  const output: PiFingerprintObject = {};
  for (const key of stringKeys) {
    if (key.length > MAX_PI_ASSISTANT_FINGERPRINT_BYTES) {
      return fingerprintFailure("FingerprintByteLimitExceeded");
    }
    const descriptor = readOwnPropertyDescriptor(object, key);
    if (
      descriptor.isErr() ||
      descriptor.value === undefined ||
      descriptor.value.enumerable !== true ||
      !hasOwnPropertyFn.call(descriptor.value, "value")
    ) {
      return fingerprintFailure("FingerprintAccessor");
    }
    const contentObject = parseInspectableObject(descriptor.value.value);
    const contentIsArray =
      contentObject !== undefined && Array.isArray(contentObject);
    if (key === "content" && contentIsArray && contentObject !== undefined) {
      const blockLength = readOwnPropertyDescriptor(contentObject, "length");
      const blockCountRead =
        blockLength.isOk() &&
        blockLength.value !== undefined &&
        hasOwnPropertyFn.call(blockLength.value, "value")
          ? PI_NUMBER_SCHEMA.safeParse(blockLength.value.value)
          : undefined;
      const blockCount =
        blockCountRead?.success === true ? blockCountRead.data : undefined;
      if (
        blockCount === undefined ||
        !Number.isSafeInteger(blockCount) ||
        blockCount < 0 ||
        state.contentBlockCount >
          MAX_PI_ASSISTANT_FINGERPRINT_CONTENT_BLOCKS - blockCount
      ) {
        return fingerprintFailure("FingerprintContentBlockLimitExceeded");
      }
      state.contentBlockCount += blockCount;
    }
    const child = cloneFingerprintValue(
      descriptor.value.value,
      depth + 1,
      state,
    );
    if (child.isErr()) return child;
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      value: child.value,
      writable: true,
    });
  }
  return ok(output);
}

function parseFingerprint(
  value: PiFailoverObservedValue,
): Result<PiAssistantFingerprint, PiAssistantFingerprintError> {
  const object = parseInspectableObject(value);
  if (object === undefined) {
    return fingerprintFailure("FingerprintNonCanonicalValue");
  }
  const prototype = readPrototype(object);
  if (prototype.isErr()) return fingerprintFailure("FingerprintProxy");
  if (prototype.value !== Object.prototype && prototype.value !== null) {
    return fingerprintFailure("FingerprintNonCanonicalValue");
  }
  const keys = readOwnKeys(object);
  if (keys.isErr()) return fingerprintFailure("FingerprintProxy");
  const expectedKeys: readonly string[] = [
    "schemaVersion",
    "algorithm",
    "digest",
    "byteLength",
    "depth",
    "propertyCount",
    "contentBlockCount",
  ];
  const stringKeys = keys.value
    .map(parsePropertyKeyString)
    .filter((key): key is string => key !== undefined);
  if (
    stringKeys.length !== keys.value.length ||
    stringKeys.length !== expectedKeys.length ||
    stringKeys.some((key) => !expectedKeys.includes(key))
  ) {
    return fingerprintFailure("FingerprintNonCanonicalValue");
  }
  const schemaVersion = readPiOwnEnumerableData(object, "schemaVersion");
  const algorithm = readPiOwnEnumerableData(object, "algorithm");
  const digest = readPiOwnEnumerableData(object, "digest");
  const byteLength = readPiOwnEnumerableData(object, "byteLength");
  const depth = readPiOwnEnumerableData(object, "depth");
  const propertyCount = readPiOwnEnumerableData(object, "propertyCount");
  const contentBlockCount = readPiOwnEnumerableData(
    object,
    "contentBlockCount",
  );
  const fields = [
    schemaVersion,
    algorithm,
    digest,
    byteLength,
    depth,
    propertyCount,
    contentBlockCount,
  ];
  if (fields.some((field) => field.state === "accessor")) {
    return fingerprintFailure("FingerprintAccessor");
  }
  if (fields.some((field) => field.state === "unreadable")) {
    return fingerprintFailure("FingerprintProxy");
  }
  if (
    schemaVersion.state !== "data" ||
    algorithm.state !== "data" ||
    digest.state !== "data" ||
    byteLength.state !== "data" ||
    depth.state !== "data" ||
    propertyCount.state !== "data" ||
    contentBlockCount.state !== "data"
  ) {
    return fingerprintFailure("FingerprintNonCanonicalValue");
  }

  const parsedSchemaVersion = z.literal(1).safeParse(schemaVersion.value);
  const parsedAlgorithm = z.literal("sha256").safeParse(algorithm.value);
  const parsedDigest = PI_STRING_SCHEMA.safeParse(digest.value);
  const parsedByteLength = PI_NUMBER_SCHEMA.safeParse(byteLength.value);
  const parsedDepth = PI_NUMBER_SCHEMA.safeParse(depth.value);
  const parsedPropertyCount = PI_NUMBER_SCHEMA.safeParse(propertyCount.value);
  const parsedContentBlockCount = PI_NUMBER_SCHEMA.safeParse(
    contentBlockCount.value,
  );
  if (
    !parsedSchemaVersion.success ||
    !parsedAlgorithm.success ||
    !parsedDigest.success ||
    !/^[0-9a-f]{64}$/u.test(parsedDigest.data) ||
    !parsedByteLength.success ||
    !Number.isSafeInteger(parsedByteLength.data) ||
    parsedByteLength.data < 0 ||
    parsedByteLength.data > MAX_PI_ASSISTANT_FINGERPRINT_BYTES ||
    !parsedDepth.success ||
    !Number.isSafeInteger(parsedDepth.data) ||
    parsedDepth.data < 0 ||
    parsedDepth.data > MAX_PI_ASSISTANT_FINGERPRINT_DEPTH ||
    !parsedPropertyCount.success ||
    !Number.isSafeInteger(parsedPropertyCount.data) ||
    parsedPropertyCount.data < 0 ||
    parsedPropertyCount.data > MAX_PI_ASSISTANT_FINGERPRINT_PROPERTIES ||
    !parsedContentBlockCount.success ||
    !Number.isSafeInteger(parsedContentBlockCount.data) ||
    parsedContentBlockCount.data < 0 ||
    parsedContentBlockCount.data > MAX_PI_ASSISTANT_FINGERPRINT_CONTENT_BLOCKS
  ) {
    return fingerprintFailure("FingerprintNonCanonicalValue");
  }
  return ok({
    schemaVersion: parsedSchemaVersion.data,
    algorithm: parsedAlgorithm.data,
    digest: parsedDigest.data,
    byteLength: parsedByteLength.data,
    depth: parsedDepth.data,
    propertyCount: parsedPropertyCount.data,
    contentBlockCount: parsedContentBlockCount.data,
  });
}

/** Compute a bounded, content-free fingerprint of a complete assistant message. */
export function fingerprintPiAssistantMessage(
  message: PiFailoverObservedValue,
): Result<PiAssistantFingerprint, PiAssistantFingerprintError> {
  const computation = Result.fromThrowable(
    (): Result<PiAssistantFingerprint, PiAssistantFingerprintError> => {
      const role = readPiOwnEnumerableData(message, "role");
      if (role.state !== "data" || role.value !== "assistant") {
        return fingerprintFailure("FingerprintNotAssistant");
      }
      const state: FingerprintState = {
        depth: 0,
        propertyCount: 0,
        contentBlockCount: 0,
      };
      const cloned = cloneFingerprintValue(message, 0, state);
      if (cloned.isErr()) return err(cloned.error);
      const bytes = canonicalizeToBytes(cloned.value);
      if (bytes.isErr()) {
        return fingerprintFailure("FingerprintNonCanonicalValue");
      }
      if (bytes.value.byteLength > MAX_PI_ASSISTANT_FINGERPRINT_BYTES) {
        return fingerprintFailure("FingerprintByteLimitExceeded");
      }
      const digest = Result.fromThrowable(
        () => new Bun.CryptoHasher("sha256").update(bytes.value).digest("hex"),
        (): PiAssistantFingerprintError => ({
          type: "FingerprintNonCanonicalValue",
        }),
      )();
      if (digest.isErr()) return err(digest.error);
      return ok({
        schemaVersion: 1,
        algorithm: "sha256",
        digest: digest.value,
        byteLength: bytes.value.byteLength,
        depth: state.depth,
        propertyCount: state.propertyCount,
        contentBlockCount: state.contentBlockCount,
      });
    },
    (): PiAssistantFingerprintError => ({ type: "FingerprintProxy" }),
  )();
  if (computation.isErr()) return err(computation.error);
  return computation.value;
}

/** Compatibility spellings for the bounded assistant fingerprint. */
export const fingerprintPiAssistant = fingerprintPiAssistantMessage;
export const fingerprintFailedPiAssistant = fingerprintPiAssistantMessage;
export const createPiAssistantFingerprint = fingerprintPiAssistantMessage;

/** Compare fingerprints only after validating the retained value. */
export function isPiAssistantFingerprintEqual(
  actual: PiFailoverObservedValue,
  expected: PiFailoverObservedValue,
): boolean {
  const actualParsed = fingerprintPiAssistantMessage(actual);
  if (actualParsed.isErr()) return false;
  const expectedParsed = parseFingerprint(expected);
  if (expectedParsed.isErr()) return false;
  return (
    actualParsed.value.schemaVersion === expectedParsed.value.schemaVersion &&
    actualParsed.value.algorithm === expectedParsed.value.algorithm &&
    actualParsed.value.digest === expectedParsed.value.digest &&
    actualParsed.value.byteLength === expectedParsed.value.byteLength &&
    actualParsed.value.depth === expectedParsed.value.depth &&
    actualParsed.value.propertyCount === expectedParsed.value.propertyCount &&
    actualParsed.value.contentBlockCount ===
      expectedParsed.value.contentBlockCount
  );
}

/** Parse a retained fingerprint for the context-repair module. */
export function parsePiAssistantFingerprint(
  value: PiFailoverObservedValue,
): Result<PiAssistantFingerprint, PiAssistantFingerprintError> {
  return parseFingerprint(value);
}

/** One resolver-produced candidate used by the coordinator and preflight port. */
export type PiFailoverCandidate = PiOrderedModelResolution;

/** Cursor entries may be resolver results or bare model facts in unit seams. */
export type PiCandidateCursorEntry =
  | PiModelInfoWithContextWindow
  | PiOrderedModelResolution;

type CandidateModel = PiModelInfo | PiOrderedModelResolution;
type FailedModel = Pick<PiModelInfo, "provider" | "id"> | string;

function isFailedModelIdentity(
  value: FailedModel,
): value is Pick<PiModelInfo, "provider" | "id"> {
  return !PI_STRING_SCHEMA.safeParse(value).success;
}

function candidateModel(candidate: CandidateModel): PiModelInfo | undefined {
  return Result.fromThrowable(
    () => ("resolved" in candidate ? candidate.model : candidate),
    (): null => null,
  )().match(
    (model) => model,
    () => void 0,
  );
}

function canonicalIdentity(
  model: Pick<PiModelInfo, "provider" | "id">,
): string | undefined {
  const observed = observePiModel(model);
  return observed.isOk()
    ? `${observed.value.provider}/${observed.value.id}`
    : undefined;
}

/** Mutable, bounded cursor over the suffix after the failed model. */
export interface PiCandidateCursor<
  T extends PiCandidateCursorEntry = PiFailoverCandidate,
> {
  /** Index of the next candidate in the canonical-distinct frozen list. */
  readonly position: number;
  /** Number of candidates returned so far. Never exceeds `cap`. */
  readonly advanced: number;
  /** Hard cap, equal to the canonical-distinct input list length. */
  readonly cap: number;
  readonly exhausted: boolean;
  next(): T | undefined;
}

class BoundedPiCandidateCursor<T extends PiCandidateCursorEntry>
  implements PiCandidateCursor<T>
{
  private nextIndex: number;
  private advancedCount = 0;

  constructor(
    private readonly candidates: readonly T[],
    failedModel: Pick<PiModelInfo, "provider" | "id"> | string | undefined,
  ) {
    let failedIdentity: string | undefined;
    const failedModelText = PI_STRING_SCHEMA.safeParse(failedModel);
    if (failedModelText.success) {
      failedIdentity = failedModelText.data;
    } else if (
      failedModel !== undefined &&
      isFailedModelIdentity(failedModel)
    ) {
      failedIdentity = canonicalIdentity(failedModel);
    }
    const failedIndex =
      failedIdentity === undefined
        ? -1
        : candidates.findIndex((candidate) => {
            const model = candidateModel(candidate);
            return (
              model !== undefined && canonicalIdentity(model) === failedIdentity
            );
          });
    this.nextIndex = Math.min(candidates.length, Math.max(0, failedIndex + 1));
  }

  get position(): number {
    return this.nextIndex;
  }

  get advanced(): number {
    return this.advancedCount;
  }

  get cap(): number {
    return this.candidates.length;
  }

  get exhausted(): boolean {
    return this.nextIndex >= this.candidates.length;
  }

  next(): T | undefined {
    if (this.exhausted || this.advancedCount >= this.cap) return undefined;
    const candidate = this.candidates[this.nextIndex];
    this.nextIndex = Math.min(this.cap, this.nextIndex + 1);
    this.advancedCount = Math.min(this.cap, this.advancedCount + 1);
    return candidate;
  }
}

function canonicalDistinctCandidates<T extends PiCandidateCursorEntry>(
  candidates: readonly T[],
): readonly T[] {
  const seen = new Set<string>();
  const distinct: T[] = [];
  for (const candidate of candidates) {
    const model = candidateModel(candidate);
    if (model === undefined) continue;
    const identity = canonicalIdentity(model);
    if (identity === undefined || seen.has(identity)) continue;
    seen.add(identity);
    distinct.push(candidate);
    if (distinct.length >= MAX_PI_FAILOVER_CANDIDATES) break;
  }
  return distinct;
}

export function createPiCandidateCursor<T extends PiCandidateCursorEntry>(
  candidates: readonly T[],
  failedModel: Pick<PiModelInfo, "provider" | "id"> | string | undefined,
): PiCandidateCursor<T> {
  return new BoundedPiCandidateCursor(
    canonicalDistinctCandidates([...candidates]),
    failedModel,
  );
}

/** Compatibility spelling for model-specific call sites. */
export const createPiModelCandidateCursor = createPiCandidateCursor;

function modelContextWindow(
  model: PiModelInfoWithContextWindow | undefined,
): number | undefined {
  if (model === undefined) return undefined;
  return observePiModel(model).match(
    (facts) => facts.contextWindow,
    () => void 0,
  );
}

function modelFromCandidate(
  candidate: PiFailoverCandidate | PiModelInfo,
): PiModelInfoWithContextWindow | undefined {
  return Result.fromThrowable(
    () => ("resolved" in candidate ? candidate.model : candidate),
    (): null => null,
  )().match(
    (model) => model,
    () => void 0,
  );
}

/** Overflow recovery may use only a strictly larger declared context window. */
export function isPiCandidateContextEligible(
  candidate: PiFailoverCandidate | PiModelInfo,
  failedModel: PiModelInfoWithContextWindow | undefined,
  failureClass: PiFailoverFailureClass,
): boolean {
  if (failureClass !== "context_overflow_unrecovered") return true;
  const candidateWindow = modelContextWindow(modelFromCandidate(candidate));
  const failedWindow = modelContextWindow(failedModel);
  return (
    candidateWindow !== undefined &&
    failedWindow !== undefined &&
    Number.isSafeInteger(candidateWindow) &&
    Number.isSafeInteger(failedWindow) &&
    candidateWindow > 0 &&
    failedWindow > 0 &&
    candidateWindow > failedWindow
  );
}

/** Compatibility spelling for the coordinator's eligibility check. */
export const isPiCandidateEligible = isPiCandidateContextEligible;

export type PiCandidatePreflightSkipReason =
  | "not-in-authenticated-catalog"
  | "provider-credentials-unavailable"
  | "host-surface-unavailable"
  | "preflight-error";

export type PiCandidatePreflightOutcome =
  | { readonly status: "eligible" }
  | {
      readonly status: "skip";
      readonly reason: PiCandidatePreflightSkipReason;
    };

/** Typed preflight errors carry no provider credentials or host exception text. */
export type PiCandidatePreflightError =
  | { readonly type: "CandidateNotInAuthenticatedCatalog" }
  | { readonly type: "ProviderCredentialsUnavailable" }
  | { readonly type: "PreflightHostSurfaceUnavailable" }
  | { readonly type: "CandidatePreflightFailed" };

/** Public host-only auth preflight seam. */
export interface PiCandidatePreflightPort {
  preflight(
    candidate: PiFailoverCandidate,
  ): ResultAsync<PiCandidatePreflightOutcome, PiCandidatePreflightError>;
}

/** Canonical identity helper shared by cursor and coordinator callers. */
export function piCanonicalModelIdentity(
  model: Pick<PiModelInfo, "provider" | "id">,
): string {
  return canonicalIdentity(model) ?? "";
}

/** Runtime guard for values crossing a typed control boundary. */
export function isPiFailoverFailureClass(
  value: PiFailoverObservedValue,
): value is PiFailoverFailureClass {
  const parsed = PI_STRING_SCHEMA.safeParse(value);
  if (!parsed.success) return false;
  for (const failureClass of PI_FAILOVER_FAILURE_CLASSES) {
    if (failureClass === parsed.data) return true;
  }
  return false;
}
