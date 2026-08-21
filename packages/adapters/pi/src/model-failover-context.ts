import { err, ok, Result } from "neverthrow";
import { z } from "zod";
import {
  fingerprintPiAssistantMessage,
  isPiModelFailoverMarker,
  isPiUuidV4,
  PI_MODEL_FAILOVER_MARKER_CONTENT,
  PI_MODEL_FAILOVER_MARKER_TYPE,
  type PiAssistantFingerprint,
  type PiFailoverObservedValue,
  parsePiAssistantFingerprint,
  parsePiModelFailoverMarkerDetails,
  readPiOwnEnumerableData,
} from "./model-failover-contract.js";

/** Maximum provider-context entries inspected by one repair attempt. */
export const MAX_PI_FAILOVER_CONTEXT_MESSAGES = 256;

export interface PiFailoverContextRepairInput {
  readonly messages: readonly PiFailoverObservedValue[];
  /** Preferred public field. */
  readonly token?: string;
  /** Compatibility spelling used by coordinator seams. */
  readonly markerToken?: string;
  /** Preferred public field. */
  readonly fingerprint?: PiAssistantFingerprint;
  /** Compatibility spelling used by coordinator seams. */
  readonly failedAssistantFingerprint?: PiAssistantFingerprint;
}

export type PiFailoverContextRepairError =
  | { readonly type: "ContextMessagesMalformed" }
  | { readonly type: "ContextMessagesTooLarge" }
  | { readonly type: "ExpectedTokenMalformed" }
  | { readonly type: "RetainedFingerprintMalformed" }
  | { readonly type: "MarkerMissing" }
  | { readonly type: "MarkerDuplicate" }
  | { readonly type: "MarkerMalformed" }
  | { readonly type: "MarkerMisplaced" }
  | { readonly type: "FailedAssistantMalformed" }
  | { readonly type: "FailedAssistantMismatch" };

const arrayIsArray = Array.isArray;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const hasOwnPropertyFn = Object.prototype.hasOwnProperty;
const PI_CONTEXT_INPUT_SCHEMA = z.unknown();
type PiContextObservedValue = z.input<typeof PI_CONTEXT_INPUT_SCHEMA>;

interface PiContextObject {
  readonly piContextObjectMarker?: never;
}

const PI_CONTEXT_OBJECT_SCHEMA = z.custom<PiContextObject>((value) =>
  Result.fromThrowable(
    () =>
      value !== null &&
      Object(value) === value &&
      !Array.isArray(value) &&
      !(value instanceof Function),
    (): boolean => false,
  )().unwrapOr(false),
);

interface NormalizedContextRepairInput {
  readonly messages: readonly PiFailoverObservedValue[];
  readonly token: PiContextObservedValue;
  readonly fingerprint: PiContextObservedValue;
}

function isObservedMessageArray(
  value: PiContextObservedValue,
): value is readonly PiFailoverObservedValue[] {
  return Result.fromThrowable(
    () => arrayIsArray(value),
    (): boolean => false,
  )().unwrapOr(false);
}

function failure(
  type: PiFailoverContextRepairError["type"],
): Result<never, PiFailoverContextRepairError> {
  switch (type) {
    case "ContextMessagesMalformed":
      return err({ type: "ContextMessagesMalformed" });
    case "ContextMessagesTooLarge":
      return err({ type: "ContextMessagesTooLarge" });
    case "ExpectedTokenMalformed":
      return err({ type: "ExpectedTokenMalformed" });
    case "RetainedFingerprintMalformed":
      return err({ type: "RetainedFingerprintMalformed" });
    case "MarkerMissing":
      return err({ type: "MarkerMissing" });
    case "MarkerDuplicate":
      return err({ type: "MarkerDuplicate" });
    case "MarkerMalformed":
      return err({ type: "MarkerMalformed" });
    case "MarkerMisplaced":
      return err({ type: "MarkerMisplaced" });
    case "FailedAssistantMalformed":
      return err({ type: "FailedAssistantMalformed" });
    case "FailedAssistantMismatch":
      return err({ type: "FailedAssistantMismatch" });
  }
}

function readArrayValues(
  messages: readonly PiFailoverObservedValue[],
): Result<readonly PiFailoverObservedValue[], PiFailoverContextRepairError> {
  const isArray = Result.fromThrowable(
    () => arrayIsArray(messages),
    (): boolean => false,
  )();
  if (isArray.isErr() || !isArray.value) {
    return failure("ContextMessagesMalformed");
  }

  const length = Result.fromThrowable(
    () => {
      const descriptor = getOwnPropertyDescriptor(messages, "length");
      if (
        descriptor === undefined ||
        descriptor.enumerable !== false ||
        !hasOwnPropertyFn.call(descriptor, "value")
      ) {
        return null;
      }
      const parsedLength = z.number().safeParse(descriptor.value);
      if (
        !parsedLength.success ||
        !Number.isSafeInteger(parsedLength.data) ||
        parsedLength.data < 0
      ) {
        return null;
      }
      return parsedLength.data;
    },
    (): null => null,
  )();
  if (length.isErr() || length.value === null) {
    return failure("ContextMessagesMalformed");
  }
  if (length.value > MAX_PI_FAILOVER_CONTEXT_MESSAGES) {
    return failure("ContextMessagesTooLarge");
  }

  const values: PiFailoverObservedValue[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = Result.fromThrowable(
      () => getOwnPropertyDescriptor(messages, String(index)),
      (): null => null,
    )();
    if (
      descriptor.isErr() ||
      descriptor.value === undefined ||
      descriptor.value === null ||
      descriptor.value.enumerable !== true ||
      !hasOwnPropertyFn.call(descriptor.value, "value")
    ) {
      return failure("ContextMessagesMalformed");
    }
    values.push(descriptor.value.value);
  }
  return ok(values);
}

function normalizeInput(
  inputOrMessages:
    | PiFailoverContextRepairInput
    | readonly PiFailoverObservedValue[],
  token?: string,
  fingerprint?: PiAssistantFingerprint,
): NormalizedContextRepairInput | null {
  if (isObservedMessageArray(inputOrMessages)) {
    if (token === undefined || fingerprint === undefined) return null;
    return { messages: inputOrMessages, token, fingerprint };
  }

  const parsedInput = PI_CONTEXT_OBJECT_SCHEMA.safeParse(inputOrMessages);
  if (!parsedInput.success) return null;
  const messages = readPiOwnEnumerableData(parsedInput.data, "messages");
  const tokenValue = readPiOwnEnumerableData(parsedInput.data, "token");
  const markerToken = readPiOwnEnumerableData(parsedInput.data, "markerToken");
  const fingerprintValue = readPiOwnEnumerableData(
    parsedInput.data,
    "fingerprint",
  );
  const failedFingerprint = readPiOwnEnumerableData(
    parsedInput.data,
    "failedAssistantFingerprint",
  );
  if (messages.state !== "data") return null;
  if (!isObservedMessageArray(messages.value)) return null;

  let resolvedToken: PiContextObservedValue | null = null;
  if (
    tokenValue.state === "data" &&
    tokenValue.value !== null &&
    tokenValue.value !== undefined
  ) {
    resolvedToken = tokenValue.value;
  } else if (
    markerToken.state === "data" &&
    markerToken.value !== null &&
    markerToken.value !== undefined
  ) {
    resolvedToken = markerToken.value;
  }
  let resolvedFingerprint: PiContextObservedValue | null = null;
  if (
    fingerprintValue.state === "data" &&
    fingerprintValue.value !== null &&
    fingerprintValue.value !== undefined
  ) {
    resolvedFingerprint = fingerprintValue.value;
  } else if (
    failedFingerprint.state === "data" &&
    failedFingerprint.value !== null &&
    failedFingerprint.value !== undefined
  ) {
    resolvedFingerprint = failedFingerprint.value;
  }
  if (resolvedToken === null || resolvedFingerprint === null) return null;
  return {
    messages: messages.value,
    token: resolvedToken,
    fingerprint: resolvedFingerprint,
  };
}

function markerType(
  value: PiFailoverObservedValue,
):
  | { readonly kind: "unrelated" }
  | { readonly kind: "candidate"; readonly malformed: boolean } {
  const customType = readPiOwnEnumerableData(value, "customType");
  if (customType.state === "accessor" || customType.state === "unreadable") {
    return { kind: "candidate", malformed: true };
  }
  if (customType.state !== "data") return { kind: "unrelated" };
  if (customType.value !== PI_MODEL_FAILOVER_MARKER_TYPE) {
    return { kind: "unrelated" };
  }
  return { kind: "candidate", malformed: false };
}

function validateMarker(
  value: PiFailoverObservedValue,
  expectedToken: string,
): Result<true, PiFailoverContextRepairError> {
  if (!isPiModelFailoverMarker(value)) {
    return failure("MarkerMalformed");
  }
  const details = readPiOwnEnumerableData(value, "details");
  if (details.state !== "data") return failure("MarkerMalformed");
  const parsed = parsePiModelFailoverMarkerDetails(
    details.value,
    expectedToken,
  );
  if (parsed.isErr()) return failure("MarkerMalformed");
  // Keep this check explicit. It prevents a future marker parser from
  // widening admission to a text-only sentinel.
  const content = readPiOwnEnumerableData(value, "content");
  if (
    content.state !== "data" ||
    content.value !== PI_MODEL_FAILOVER_MARKER_CONTENT
  ) {
    return failure("MarkerMalformed");
  }
  return ok(true);
}

/**
 * Remove exactly the failed assistant and its exact hidden marker from the
 * provider-only context clone. Durable Pi history is never passed here and is
 * therefore unchanged.
 */
export function repairPiFailoverContext(
  input: PiFailoverContextRepairInput,
): Result<readonly PiFailoverObservedValue[], PiFailoverContextRepairError>;
export function repairPiFailoverContext(
  messages: readonly PiFailoverObservedValue[],
  token: string,
  fingerprint: PiAssistantFingerprint,
): Result<readonly PiFailoverObservedValue[], PiFailoverContextRepairError>;
export function repairPiFailoverContext(
  inputOrMessages:
    | PiFailoverContextRepairInput
    | readonly PiFailoverObservedValue[],
  token?: string,
  fingerprint?: PiAssistantFingerprint,
): Result<readonly PiFailoverObservedValue[], PiFailoverContextRepairError> {
  const normalized = Result.fromThrowable(
    () => normalizeInput(inputOrMessages, token, fingerprint),
    (): null => null,
  )();
  if (normalized.isErr() || normalized.value === null) {
    return failure("ContextMessagesMalformed");
  }
  const input = normalized.value;
  if (!isPiUuidV4(input.token)) {
    return failure("ExpectedTokenMalformed");
  }

  const retained = parsePiAssistantFingerprint(input.fingerprint);
  if (retained.isErr()) return failure("RetainedFingerprintMalformed");

  const values = readArrayValues(input.messages);
  if (values.isErr()) return values;

  let markerIndex: number | undefined;
  let markerCount = 0;
  for (let index = 0; index < values.value.length; index += 1) {
    const candidate = markerType(values.value[index]);
    if (candidate.kind === "candidate" && candidate.malformed) {
      return failure("MarkerMalformed");
    }
    if (candidate.kind !== "candidate") continue;
    markerCount += 1;
    if (markerCount > 1) return failure("MarkerDuplicate");
    const valid = validateMarker(values.value[index], input.token);
    if (valid.isErr()) return failure(valid.error.type);
    markerIndex = index;
  }

  if (markerIndex === undefined) return failure("MarkerMissing");
  if (markerIndex === 0) return failure("MarkerMisplaced");

  const assistantIndex = markerIndex - 1;
  const assistant = values.value[assistantIndex];
  const role = readPiOwnEnumerableData(assistant, "role");
  if (role.state !== "data" || role.value !== "assistant") {
    return failure("FailedAssistantMalformed");
  }

  const actual = fingerprintPiAssistantMessage(assistant);
  if (actual.isErr()) return failure("FailedAssistantMalformed");
  if (
    actual.value.schemaVersion !== retained.value.schemaVersion ||
    actual.value.algorithm !== retained.value.algorithm ||
    actual.value.digest !== retained.value.digest ||
    actual.value.byteLength !== retained.value.byteLength ||
    actual.value.depth !== retained.value.depth ||
    actual.value.propertyCount !== retained.value.propertyCount ||
    actual.value.contentBlockCount !== retained.value.contentBlockCount
  ) {
    return failure("FailedAssistantMismatch");
  }

  return ok(
    values.value.filter(
      (_entry, index) => index !== assistantIndex && index !== markerIndex,
    ),
  );
}

/** Compatibility spelling for the provider-context boundary. */
export const repairPiModelFailoverContext = repairPiFailoverContext;
export const filterPiFailoverContext = repairPiFailoverContext;

/** Boolean admission helper for callers that do not need the repaired list. */
export function canRepairPiFailoverContext(
  input: PiFailoverContextRepairInput,
): boolean {
  return repairPiFailoverContext(input).isOk();
}
