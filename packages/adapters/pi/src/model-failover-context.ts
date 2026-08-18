import { err, ok, Result } from "neverthrow";
import {
  fingerprintPiAssistantMessage,
  isPiModelFailoverMarker,
  isPiUuidV4,
  PI_MODEL_FAILOVER_MARKER_CONTENT,
  PI_MODEL_FAILOVER_MARKER_TYPE,
  type PiAssistantFingerprint,
  parsePiAssistantFingerprint,
  parsePiModelFailoverMarkerDetails,
  readPiOwnEnumerableData,
} from "./model-failover-contract.js";

/** Maximum provider-context entries inspected by one repair attempt. */
export const MAX_PI_FAILOVER_CONTEXT_MESSAGES = 256;

export interface PiFailoverContextRepairInput {
  readonly messages: readonly unknown[];
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

function failure(
  type: PiFailoverContextRepairError["type"],
): Result<never, PiFailoverContextRepairError> {
  return err({ type } as PiFailoverContextRepairError);
}

function readArrayValues(
  messages: readonly unknown[],
): Result<readonly unknown[], PiFailoverContextRepairError> {
  if (!arrayIsArray(messages)) return failure("ContextMessagesMalformed");

  const length = Result.fromThrowable(
    () => {
      const descriptor = getOwnPropertyDescriptor(messages, "length");
      if (
        descriptor === undefined ||
        descriptor.enumerable !== false ||
        !hasOwnPropertyFn.call(descriptor, "value") ||
        typeof descriptor.value !== "number" ||
        !Number.isSafeInteger(descriptor.value) ||
        descriptor.value < 0
      ) {
        return undefined;
      }
      return descriptor.value;
    },
    (): undefined => undefined,
  )();
  if (length.isErr() || length.value === undefined) {
    return failure("ContextMessagesMalformed");
  }
  if (length.value > MAX_PI_FAILOVER_CONTEXT_MESSAGES) {
    return failure("ContextMessagesTooLarge");
  }

  const values: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = Result.fromThrowable(
      () => getOwnPropertyDescriptor(messages, String(index)),
      (): PropertyDescriptor | undefined => undefined,
    )();
    if (
      descriptor.isErr() ||
      descriptor.value === undefined ||
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
  inputOrMessages: PiFailoverContextRepairInput | readonly unknown[],
  token?: string,
  fingerprint?: PiAssistantFingerprint,
): PiFailoverContextRepairInput | undefined {
  if (arrayIsArray(inputOrMessages)) {
    if (token === undefined || fingerprint === undefined) return undefined;
    return { messages: inputOrMessages, token, fingerprint };
  }
  if (inputOrMessages === null || typeof inputOrMessages !== "object") {
    return undefined;
  }
  const input = inputOrMessages as PiFailoverContextRepairInput;
  const resolvedToken = input.token ?? input.markerToken;
  const resolvedFingerprint =
    input.fingerprint ?? input.failedAssistantFingerprint;
  if (
    !arrayIsArray(input.messages) ||
    resolvedToken === undefined ||
    resolvedFingerprint === undefined
  ) {
    return undefined;
  }
  return {
    messages: input.messages,
    token: resolvedToken,
    fingerprint: resolvedFingerprint,
  };
}

function markerType(
  value: unknown,
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
  value: unknown,
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
): Result<readonly unknown[], PiFailoverContextRepairError>;
export function repairPiFailoverContext(
  messages: readonly unknown[],
  token: string,
  fingerprint: PiAssistantFingerprint,
): Result<readonly unknown[], PiFailoverContextRepairError>;
export function repairPiFailoverContext(
  inputOrMessages: PiFailoverContextRepairInput | readonly unknown[],
  token?: string,
  fingerprint?: PiAssistantFingerprint,
): Result<readonly unknown[], PiFailoverContextRepairError> {
  const normalized = Result.fromThrowable(
    () => normalizeInput(inputOrMessages, token, fingerprint),
    (): undefined => undefined,
  )();
  if (normalized.isErr() || normalized.value === undefined) {
    return failure("ContextMessagesMalformed");
  }
  const input = normalized.value;
  if (typeof input.token !== "string" || !isPiUuidV4(input.token)) {
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
