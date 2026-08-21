import { err, ok, Result } from "neverthrow";
import { z } from "zod";
import {
  classifyPiMessageUpdate,
  isRawReasoningAssistantEventType,
  RAW_REASONING_PROSE_KEYS,
} from "./message-update-carrier.js";

/** Bounds applied to observed private Pi protocol data. */
export const MAX_CHILD_EVENT_STRING = 16_384;
export const MAX_CHILD_EVENT_KEYS = 64;
export const MAX_CHILD_EVENT_ITEMS = 128;

export type PiChildEventJsonPrimitive = string | number | boolean | null;
const hostOnlyAbsentSchema = z.void();
export type PiChildEventJsonValue =
  | PiChildEventJsonPrimitive
  | readonly PiChildEventJsonValue[]
  | { readonly [key: string]: PiChildEventJsonValue };

const boundedString = z.string().max(MAX_CHILD_EVENT_STRING);
const hostString = z.string();
const boundedKey = z.string().max(256);
const boundedNumber = z.number().finite();
const boundedBoolean = z.boolean();
const boundedJson: z.ZodType<PiChildEventJsonValue> = z.lazy(() =>
  z.union([
    boundedString,
    boundedNumber,
    boundedBoolean,
    z.null(),
    z.array(boundedJson).max(MAX_CHILD_EVENT_ITEMS),
    z
      .record(boundedKey, boundedJson)
      .refine(
        (value) => Object.keys(value).length <= MAX_CHILD_EVENT_KEYS,
        "too many object keys",
      ),
  ]),
);

const boundedRecordSchema = z
  .record(boundedKey, boundedJson)
  .refine(
    (value) => Object.keys(value).length <= MAX_CHILD_EVENT_KEYS,
    "too many object keys",
  );
type BoundedRecord = z.output<typeof boundedRecordSchema>;

type EventFieldMap = Parameters<typeof z.object>[0];
const event = <T extends string, F extends EventFieldMap>(
  eventType: T,
  fields: F,
) =>
  z
    .object({ type: z.literal(eventType), ...fields })
    .catchall(boundedJson.or(z.undefined()).or(hostOnlyAbsentSchema));

const MessageStart = event("message_start", {
  message: boundedJson.optional(),
});
const MessageUpdate = event("message_update", {
  delta: boundedJson.optional(),
  assistantMessageEvent: boundedJson.optional(),
});
const MessageEnd = event("message_end", {
  message: boundedJson.optional(),
});
const Text = event("text", { text: boundedString });
/** Raw model reasoning is retained only as a content-free marker. */
const Thinking = event("thinking", { text: boundedString.optional() });
/** The host's explicit reasoning summary is the one trusted prose surface. */
const ReasoningSummary = event("reasoning_summary", {
  text: boundedString.optional(),
});
const Markdown = event("markdown", { text: boundedString.optional() });
const ToolCall = event("tool_call", {
  toolCallId: boundedString.optional(),
  toolName: boundedString.optional(),
  name: boundedString.optional(),
  arguments: boundedJson.optional(),
});
const ToolPartialResult = event("tool_partial_result", {
  toolCallId: boundedString.optional(),
  arguments: boundedJson.optional(),
  partialResult: boundedJson.optional(),
  content: boundedJson.optional(),
});
const ToolResult = event("tool_result", {
  toolCallId: boundedString.optional(),
  result: boundedJson.optional(),
  content: boundedJson.optional(),
});
const ToolError = event("tool_error", {
  toolCallId: boundedString.optional(),
  error: boundedString.optional(),
  message: boundedString.optional(),
});
const Image = event("image", {
  data: boundedString.optional(),
  mimeType: boundedString.optional(),
  source: boundedJson.optional(),
});
const Usage = event("usage", { usage: boundedJson.optional() });

const QueueChange = event("queue_change", {
  size: z.number().int().min(0).max(MAX_CHILD_EVENT_ITEMS).optional(),
  queue: z.array(boundedJson).max(MAX_CHILD_EVENT_ITEMS).optional(),
});
const Status = event("status", {
  status: boundedString.optional(),
  message: boundedString.optional(),
});
const Retry = event("retry", {
  attempt: z.number().int().min(0).max(1_000).optional(),
  reason: boundedString.optional(),
});

/** The three UI request families Pi exposes to extensions. */
const ExtensionUiRequest = event("extension_ui_request", {
  requestType: z.enum(["notification", "widget", "dialog"]),
  requestId: boundedString,
  message: boundedString.optional(),
  widget: boundedJson.optional(),
  dialog: boundedJson.optional(),
});

const ExtensionUiResponse = event("extension_ui_response", {
  requestId: boundedString,
  response: boundedJson.or(hostOnlyAbsentSchema).optional(),
  cancelled: z.boolean().optional(),
  error: boundedString.optional(),
});

const UnknownChildEvent = z
  .object({
    type: z.literal("unknown"),
    originalType: z.string().min(1).max(256),
    payload: boundedRecordSchema.optional(),
  })
  .strict();

/** All observed child events. Unknown host kinds are represented explicitly. */
export const PiChildSessionEventSchema = z.discriminatedUnion("type", [
  MessageStart,
  MessageUpdate,
  MessageEnd,
  Text,
  Thinking,
  ReasoningSummary,
  Markdown,
  ToolCall,
  ToolPartialResult,
  ToolResult,
  ToolError,
  Image,
  Usage,
  QueueChange,
  Status,
  Retry,
  ExtensionUiRequest,
  ExtensionUiResponse,
  UnknownChildEvent,
]);
type ParsedPiChildSessionEvent = z.infer<typeof PiChildSessionEventSchema>;
/**
 * Parser output is bounded JSON. The index compatibility member also accepts
 * an absent host-only property so existing descriptor-safe callers can hand a
 * hostile event-shaped object to a redaction boundary before parsing it.
 */
export type PiChildSessionEvent = ParsedPiChildSessionEvent & {
  readonly [key: string]:
    | PiChildEventJsonValue
    | z.output<typeof hostOnlyAbsentSchema>;
};
export type PiChildEventType = PiChildSessionEvent["type"];

/** A named parser input boundary for values supplied by a host or session file. */
const HostEventInputBoundary = z.unknown();
type HostEventInput = z.input<typeof HostEventInputBoundary>;

/** Opaque reference accepted only after the descriptor-safe boundary checks it. */
interface HostObjectReference {
  readonly hostObjectMarker?: never;
}
const HostObjectReferenceSchema = z.custom<HostObjectReference>(
  (candidate) => Object(candidate) === candidate,
);

/** Avoid running bounded Zod checks on an object that can trap on `length`. */
const isPrimitiveInput = (value: HostEventInput): boolean =>
  Object(value) !== value;

/** Why an observed field or element is not the host's own stated value. */
type OwnValueRejection =
  | "absent"
  | "accessor"
  | "non-enumerable"
  | "unreadable"
  | "malformed";

/** Reflection wrappers turn hostile proxy traps into typed parser failures. */
const ownDescriptor = Result.fromThrowable(
  (
    target: HostObjectReference,
    key: PropertyKey,
  ): PropertyDescriptor | undefined =>
    Object.getOwnPropertyDescriptor(target, key),
  (): OwnValueRejection => "unreadable",
);

const isArrayValue = Result.fromThrowable(
  (value: HostEventInput): boolean => Array.isArray(value),
  (): OwnValueRejection => "unreadable",
);

const ownEnumerableKeys = Result.fromThrowable(
  (target: HostObjectReference): string[] => Object.keys(target),
  (): OwnValueRejection => "unreadable",
);

/** Read one own enumerable data property without invoking an accessor. */
const ownEnumerableDataValue = (
  target: HostObjectReference,
  key: PropertyKey,
): Result<HostEventInput, OwnValueRejection> => {
  const descriptor = ownDescriptor(target, key);
  if (descriptor.isErr()) return err(descriptor.error);
  const found = descriptor.value;
  if (found === undefined) return err("absent");
  if (!("value" in found)) return err("accessor");
  if (found.enumerable !== true) return err("non-enumerable");
  return ok(found.value);
};

/** The event kind the record itself stated. */
const ownEventTypeString = (
  record: HostObjectReference,
): Result<string, OwnValueRejection> => {
  const value = ownEnumerableDataValue(record, "type");
  if (value.isErr()) return err(value.error);
  if (!isPrimitiveInput(value.value)) return err("malformed");
  const parsed = z.string().safeParse(value.value);
  return parsed.success ? ok(parsed.data) : err("malformed");
};

const ArrayLengthSchema = z.number().int().min(0).max(MAX_CHILD_EVENT_ITEMS);

/** Read a complete, dense, plain queue list from a parser input. */
const readQueueList = (
  value: HostEventInput,
): Result<readonly string[], OwnValueRejection> => {
  const arrayResult = isArrayValue(value);
  if (arrayResult.isErr()) return err(arrayResult.error);
  if (!arrayResult.value) return err("malformed");

  const targetResult = HostObjectReferenceSchema.safeParse(value);
  if (!targetResult.success) return err("malformed");
  const target = targetResult.data;
  const prototype = Result.fromThrowable(
    () => Object.getPrototypeOf(target),
    (): OwnValueRejection => "unreadable",
  )();
  if (prototype.isErr()) return err(prototype.error);
  if (prototype.value !== Array.prototype) return err("malformed");

  const lengthDescriptor = ownDescriptor(target, "length");
  if (lengthDescriptor.isErr()) return err(lengthDescriptor.error);
  const found = lengthDescriptor.value;
  if (found === undefined || !("value" in found) || found.enumerable === true) {
    return err("malformed");
  }
  const sizeResult = ArrayLengthSchema.safeParse(found.value);
  if (!sizeResult.success || !Number.isSafeInteger(sizeResult.data)) {
    return err("malformed");
  }
  const size = sizeResult.data;

  const keys = ownEnumerableKeys(target);
  if (keys.isErr()) return err(keys.error);
  if (keys.value.length !== size) return err("malformed");
  for (let index = 0; index < size; index += 1) {
    if (keys.value[index] !== String(index)) return err("malformed");
  }

  const items: string[] = [];
  for (let index = 0; index < size; index += 1) {
    const element = ownEnumerableDataValue(target, String(index));
    if (element.isErr()) return err(element.error);
    if (!isPrimitiveInput(element.value)) return err("malformed");
    const item = boundedString.safeParse(element.value);
    if (!item.success) return err("malformed");
    items.push(item.data);
  }
  return ok(items);
};

/** Read an already parser-approved own data property. */
const ownDataProperty = (
  record: BoundedRecord,
  key: string,
): PiChildEventJsonValue | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    descriptor.enumerable !== true
  ) {
    return undefined;
  }
  const parsed = boundedJson.safeParse(descriptor.value);
  return parsed.success ? parsed.data : undefined;
};

const recordOrUndefined = (
  value: PiChildEventJsonValue | undefined,
): BoundedRecord | undefined => {
  if (value === undefined) return undefined;
  const parsed = boundedRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const eventDataProperty = (
  eventValue: PiChildSessionEvent,
  key: string,
): PiChildEventJsonValue | undefined => {
  const parsed = boundedRecordSchema.safeParse(eventValue);
  return parsed.success ? ownDataProperty(parsed.data, key) : undefined;
};

type MaterializedRecord = {
  readonly [key: string]: PiChildEventJsonValue;
};

const emptyMaterializedRecord = (): MaterializedRecord => Object.create(null);
const emptyBoundedRecord = (): BoundedRecord => Object.create(null);

const ownMaterializedDataProperty = (
  record: MaterializedRecord,
  key: string,
): PiChildEventJsonValue | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    descriptor.enumerable !== true
  ) {
    return undefined;
  }
  return descriptor.value;
};

const isMaterializedRecord = (
  value: PiChildEventJsonValue | undefined,
): value is MaterializedRecord =>
  Object(value) === value && !Array.isArray(value);

const materializedRecordOrUndefined = (
  value: PiChildEventJsonValue | undefined,
): MaterializedRecord | undefined =>
  isMaterializedRecord(value) ? value : undefined;

const isPrototypePollutionKey = (key: string): boolean =>
  key === "__proto__" || key === "constructor" || key === "prototype";

/** Define one safe data property on a parser-owned null-prototype record. */
const defineMaterializedDataProperty = (
  target: MaterializedRecord,
  key: string,
  value: PiChildEventJsonValue,
): Result<void, OwnValueRejection> => {
  if (isPrototypePollutionKey(key)) return err("malformed");
  return Result.fromThrowable(
    (): void => {
      Object.defineProperty(target, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    },
    (): OwnValueRejection => "unreadable",
  )();
};

const defineCopiedDataProperty = (
  target: BoundedRecord,
  key: string,
  value: PiChildEventJsonValue,
): Result<void, OwnValueRejection> =>
  defineMaterializedDataProperty(target, key, value);

/** Copy a parser-approved record without changing its bounded values. */
const copyBoundedRecord = (record: BoundedRecord): BoundedRecord => {
  const copy = emptyBoundedRecord();
  for (const key of Object.keys(record)) {
    const value = ownDataProperty(record, key);
    if (value === undefined) continue;
    const defined = defineCopiedDataProperty(copy, key, value);
    if (defined.isErr()) continue;
  }
  return copy;
};

/** How deep a preserved host value may nest. */
const MAX_PRESERVED_PAYLOAD_DEPTH = 32;

/** Materialize one host value through descriptors into bounded JSON data. */
const materializePlainDataValue = (
  value: HostEventInput,
  depth: number,
  omitUndefinedObjectMembers = false,
): Result<PiChildEventJsonValue, OwnValueRejection> => {
  if (value === null) return ok(null);
  if (isPrimitiveInput(value)) {
    const stringValue = hostString.safeParse(value);
    if (stringValue.success) return ok(stringValue.data);
    const numberValue = boundedNumber.safeParse(value);
    if (numberValue.success) return ok(numberValue.data);
    const booleanValue = boundedBoolean.safeParse(value);
    if (booleanValue.success) return ok(booleanValue.data);
    return err("malformed");
  }
  if (depth >= MAX_PRESERVED_PAYLOAD_DEPTH) return err("malformed");

  const targetResult = HostObjectReferenceSchema.safeParse(value);
  if (!targetResult.success) return err("malformed");
  const target = targetResult.data;
  const prototype = Result.fromThrowable(
    () => Object.getPrototypeOf(target),
    (): OwnValueRejection => "unreadable",
  )();
  if (prototype.isErr()) return err(prototype.error);

  const arrayResult = isArrayValue(value);
  if (arrayResult.isErr()) return err(arrayResult.error);
  const arrayValue = arrayResult.value;
  if (arrayValue) {
    if (prototype.value !== Array.prototype) return err("malformed");
  } else if (prototype.value !== Object.prototype && prototype.value !== null) {
    return err("malformed");
  }

  const keys = ownEnumerableKeys(target);
  if (keys.isErr()) return err(keys.error);
  if (keys.value.length > MAX_CHILD_EVENT_ITEMS) return err("malformed");

  if (arrayValue) {
    const lengthDescriptor = ownDescriptor(target, "length");
    if (lengthDescriptor.isErr()) return err(lengthDescriptor.error);
    const found = lengthDescriptor.value;
    if (
      found === undefined ||
      !("value" in found) ||
      found.enumerable === true
    ) {
      return err("malformed");
    }
    const sizeResult = ArrayLengthSchema.safeParse(found.value);
    if (!sizeResult.success || !Number.isSafeInteger(sizeResult.data)) {
      return err("malformed");
    }
    const size = sizeResult.data;
    if (keys.value.length !== size) return err("malformed");
    const items: PiChildEventJsonValue[] = [];
    for (let index = 0; index < size; index += 1) {
      if (keys.value[index] !== String(index)) return err("malformed");
      const element = ownEnumerableDataValue(target, String(index));
      if (element.isErr()) return err(element.error);
      const nested = materializePlainDataValue(element.value, depth + 1);
      if (nested.isErr()) return err(nested.error);
      items.push(nested.value);
    }
    return ok(items);
  }

  const copy = emptyMaterializedRecord();
  for (const key of keys.value) {
    if (isPrototypePollutionKey(key)) continue;
    const member = ownEnumerableDataValue(target, key);
    if (member.isErr()) return err(member.error);
    const nested = materializePlainDataValue(
      member.value,
      depth + 1,
      omitUndefinedObjectMembers,
    );
    if (nested.isErr()) {
      // Host wrappers may spell absent optional facts as own `undefined`
      // members. They are not JSON values and must not enter the retained
      // graph, but they do not invalidate the other bounded usage facts.
      if (omitUndefinedObjectMembers && member.value === undefined) continue;
      return err(nested.error);
    }
    const defined = defineMaterializedDataProperty(copy, key, nested.value);
    if (defined.isErr()) return err(defined.error);
  }
  return ok(copy);
};

/** Materialize all own event fields before any normalizer or Zod schema reads them. */
const materializeObservedEventRecord = (
  record: HostObjectReference,
  eventType: string,
): Result<MaterializedRecord, OwnValueRejection> => {
  const keys = ownEnumerableKeys(record);
  if (keys.isErr()) return err(keys.error);
  const materialized = emptyMaterializedRecord();
  const typed = defineMaterializedDataProperty(materialized, "type", eventType);
  if (typed.isErr()) return err(typed.error);

  let copiedFields = 0;
  for (const key of keys.value) {
    if (key === "type" || isPrototypePollutionKey(key)) continue;
    if (copiedFields >= MAX_CHILD_EVENT_KEYS) break;
    const boundedName = key.slice(0, 256);
    if (!boundedName || isPrototypePollutionKey(boundedName)) continue;
    if (Object.hasOwn(materialized, boundedName)) continue;
    const member = ownEnumerableDataValue(record, key);
    if (member.isErr()) continue;
    const nested = materializePlainDataValue(member.value, 0);
    if (nested.isErr()) continue;
    const defined = defineMaterializedDataProperty(
      materialized,
      boundedName,
      nested.value,
    );
    if (defined.isErr()) return err(defined.error);
    copiedFields += 1;
  }
  return ok(materialized);
};

const unknownChildEvent = (
  originalType: string,
  payload: BoundedRecord,
): PiChildSessionEvent => ({
  type: "unknown",
  originalType,
  payload,
});

/** Convert a materialized unrecognised record into the bounded unknown variant. */
const preserveMaterializedUnknown = (
  record: MaterializedRecord,
): PiChildSessionEvent => {
  const declaredType = z
    .string()
    .safeParse(ownMaterializedDataProperty(record, "type"));
  let originalType = "missing";
  if (declaredType.success) {
    originalType = declaredType.data.slice(0, 256) || "missing";
  }

  const payload = emptyBoundedRecord();
  let copiedFields = 0;
  for (const key of Object.keys(record)) {
    if (
      key === "type" ||
      isPrototypePollutionKey(key) ||
      copiedFields >= MAX_CHILD_EVENT_KEYS
    ) {
      continue;
    }
    const boundedName = key.slice(0, 256);
    if (!boundedName || isPrototypePollutionKey(boundedName)) continue;
    if (Object.hasOwn(payload, boundedName)) continue;
    const value = ownMaterializedDataProperty(record, key);
    if (value === undefined) continue;
    const bounded = boundedJson.safeParse(value);
    if (!bounded.success) continue;
    const defined = defineCopiedDataProperty(
      payload,
      boundedName,
      bounded.data,
    );
    if (defined.isErr()) continue;
    copiedFields += 1;
  }
  return unknownChildEvent(originalType, payload);
};

/** Preserve an unknown host event without invoking its accessors. */
export function preserveUnknownChildEvent(
  value: HostEventInput,
): PiChildSessionEvent {
  const targetResult = HostObjectReferenceSchema.safeParse(value);
  if (!targetResult.success) {
    return unknownChildEvent("non-object", emptyBoundedRecord());
  }
  const arrayResult = isArrayValue(value);
  if (arrayResult.isErr()) {
    return unknownChildEvent("unreadable", emptyBoundedRecord());
  }
  if (arrayResult.value) {
    return unknownChildEvent("non-object", emptyBoundedRecord());
  }
  const typeResult = ownEventTypeString(targetResult.data);
  if (typeResult.isErr()) {
    return unknownChildEvent("unreadable", emptyBoundedRecord());
  }
  const materialized = materializeObservedEventRecord(
    targetResult.data,
    typeResult.value,
  );
  if (materialized.isErr()) {
    return unknownChildEvent("unreadable", emptyBoundedRecord());
  }
  return preserveMaterializedUnknown(materialized.value);
}

/** The correlated response sent back to the originating child extension. */
export const PiExtensionUiResponseSchema = ExtensionUiResponse;
export type PiExtensionUiResponse = z.infer<typeof PiExtensionUiResponseSchema>;

// ---------------------------------------------------------------------------
// Usage telemetry (Pi 0.83 / 0.84 field mapping)
// ---------------------------------------------------------------------------

export const MAX_CHILD_USAGE_TOKENS = 1_000_000_000;
const UsageTokenCountSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_CHILD_USAGE_TOKENS);
export const MAX_CHILD_USAGE_COST = 1_000_000;
const UsageCostSchema = z.number().finite().min(0).max(MAX_CHILD_USAGE_COST);
export const MAX_CHILD_USAGE_MODEL_LENGTH = 128;
const UsageModelSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_CHILD_USAGE_MODEL_LENGTH);

export interface PiChildUsageReport {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
  readonly contextTokens?: number;
  readonly contextWindow?: number;
  readonly costTotal?: number;
  readonly model?: string;
}

export type PiChildUsageError = { readonly type: "UsageUnavailable" };

type MutableUsageReport = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  contextTokens?: number;
  contextWindow?: number;
  costTotal?: number;
  model?: string;
};

const tokenCount = (
  value: PiChildEventJsonValue | undefined,
): number | undefined => {
  const parsed = UsageTokenCountSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const modelLabel = (
  value: PiChildEventJsonValue | undefined,
): string | undefined => {
  const parsed = UsageModelSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const costTotalOf = (usage: BoundedRecord): number | undefined => {
  const cost = ownDataProperty(usage, "cost");
  const bare = UsageCostSchema.safeParse(cost);
  if (bare.success) return bare.data;
  const record = recordOrUndefined(cost);
  if (record === undefined) return undefined;
  const total = UsageCostSchema.safeParse(ownDataProperty(record, "total"));
  return total.success ? total.data : undefined;
};

const materializedCostTotalOf = (
  usage: MaterializedRecord,
): number | undefined => {
  const cost = ownMaterializedDataProperty(usage, "cost");
  const bare = UsageCostSchema.safeParse(cost);
  if (bare.success) return bare.data;
  const record = materializedRecordOrUndefined(cost);
  if (record === undefined) return undefined;
  const total = UsageCostSchema.safeParse(
    ownMaterializedDataProperty(record, "total"),
  );
  return total.success ? total.data : undefined;
};

const firstDefined = <T>(
  ...values: readonly (T | undefined)[]
): T | undefined => values.find((value) => value !== undefined);

const usageReportFrom = (
  tokens: BoundedRecord,
  context: BoundedRecord,
  model: string | undefined,
): PiChildUsageReport => {
  const report: MutableUsageReport = {};
  const inputTokens = tokenCount(ownDataProperty(tokens, "input"));
  if (inputTokens !== undefined) report.inputTokens = inputTokens;
  const outputTokens = tokenCount(ownDataProperty(tokens, "output"));
  if (outputTokens !== undefined) report.outputTokens = outputTokens;
  const cacheReadTokens = tokenCount(ownDataProperty(tokens, "cacheRead"));
  if (cacheReadTokens !== undefined) report.cacheReadTokens = cacheReadTokens;
  const cacheWriteTokens = tokenCount(ownDataProperty(tokens, "cacheWrite"));
  if (cacheWriteTokens !== undefined)
    report.cacheWriteTokens = cacheWriteTokens;
  const reasoningTokens = tokenCount(ownDataProperty(tokens, "reasoning"));
  if (reasoningTokens !== undefined) report.reasoningTokens = reasoningTokens;
  const totalTokens = tokenCount(ownDataProperty(tokens, "totalTokens"));
  if (totalTokens !== undefined) report.totalTokens = totalTokens;
  const contextTokens = firstDefined(
    tokenCount(ownDataProperty(context, "tokens")),
    tokenCount(ownDataProperty(context, "contextTokens")),
  );
  if (contextTokens !== undefined) report.contextTokens = contextTokens;
  const contextWindow = tokenCount(ownDataProperty(context, "contextWindow"));
  if (contextWindow !== undefined) report.contextWindow = contextWindow;
  const costTotal = costTotalOf(tokens);
  if (costTotal !== undefined) report.costTotal = costTotal;
  if (model !== undefined) report.model = model;
  return report;
};

function parseStandaloneUsageEvent(
  event: Extract<PiChildSessionEvent, { type: "usage" }>,
): Result<PiChildUsageReport, PiChildUsageError> {
  const payload = recordOrUndefined(event.usage);
  if (payload === undefined) return err({ type: "UsageUnavailable" });
  const nestedTokens = recordOrUndefined(ownDataProperty(payload, "usage"));
  const tokens = nestedTokens ?? payload;
  const nestedContext = recordOrUndefined(ownDataProperty(payload, "context"));
  const contextUsage = recordOrUndefined(
    ownDataProperty(payload, "contextUsage"),
  );
  const context = nestedContext ?? contextUsage ?? payload;
  return ok(
    usageReportFrom(
      tokens,
      context,
      firstDefined(
        modelLabel(eventDataProperty(event, "model")),
        modelLabel(ownDataProperty(payload, "model")),
        modelLabel(ownDataProperty(tokens, "model")),
      ),
    ),
  );
}

function parseAssistantMessageUsage(
  event: Extract<PiChildSessionEvent, { type: "message_end" }>,
): Result<PiChildUsageReport, PiChildUsageError> {
  const message = recordOrUndefined(event.message);
  if (message === undefined) return err({ type: "UsageUnavailable" });
  const role = z.string().safeParse(ownDataProperty(message, "role"));
  if (role.success && role.data !== "assistant") {
    return err({ type: "UsageUnavailable" });
  }
  const payload = recordOrUndefined(ownDataProperty(message, "usage"));
  if (payload === undefined) return err({ type: "UsageUnavailable" });
  const nestedTokens = recordOrUndefined(ownDataProperty(payload, "usage"));
  const tokens = nestedTokens ?? payload;
  const messageContextUsage = recordOrUndefined(
    ownDataProperty(message, "contextUsage"),
  );
  const messageContext = recordOrUndefined(ownDataProperty(message, "context"));
  const eventContextUsage = recordOrUndefined(
    eventDataProperty(event, "contextUsage"),
  );
  const eventContext = recordOrUndefined(eventDataProperty(event, "context"));
  const context =
    messageContextUsage ??
    messageContext ??
    eventContextUsage ??
    eventContext ??
    emptyBoundedRecord();
  return ok(
    usageReportFrom(
      tokens,
      context,
      firstDefined(
        modelLabel(ownDataProperty(message, "model")),
        modelLabel(ownDataProperty(message, "responseModel")),
        modelLabel(eventDataProperty(event, "model")),
      ),
    ),
  );
}

export function parsePiChildUsageReport(
  event: PiChildSessionEvent,
): Result<PiChildUsageReport, PiChildUsageError> {
  if (event.type === "usage") return parseStandaloneUsageEvent(event);
  if (event.type === "message_end") return parseAssistantMessageUsage(event);
  return err({ type: "UsageUnavailable" });
}

const USAGE_TOKEN_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
  "totalTokens",
] as const;

export interface PiAssistantUsageFacts {
  readonly usage?: Readonly<Record<string, number>>;
  readonly costTotal?: number;
  readonly contextUsage?: Readonly<{
    readonly tokens?: number;
    readonly contextWindow?: number;
  }>;
  readonly model?: string;
}

type MutableAssistantUsageFacts = {
  usage?: Record<string, number>;
  costTotal?: number;
  contextUsage?: { tokens?: number; contextWindow?: number };
  model?: string;
};

const projectAssistantUsageFactsFromInput = (
  message: HostEventInput,
): PiAssistantUsageFacts | undefined => {
  const materialized = materializePlainDataValue(message, 0, true);
  if (materialized.isErr()) return undefined;
  const record = materializedRecordOrUndefined(materialized.value);
  if (record === undefined) return undefined;
  const payload = materializedRecordOrUndefined(
    ownMaterializedDataProperty(record, "usage"),
  );
  const tokens =
    payload === undefined
      ? undefined
      : (materializedRecordOrUndefined(
          ownMaterializedDataProperty(payload, "usage"),
        ) ?? payload);

  const usage: Record<string, number> = {};
  if (tokens !== undefined) {
    for (const field of USAGE_TOKEN_FIELDS) {
      const count = tokenCount(ownMaterializedDataProperty(tokens, field));
      if (count !== undefined) usage[field] = count;
    }
  }

  const rawContext =
    materializedRecordOrUndefined(
      ownMaterializedDataProperty(record, "contextUsage"),
    ) ??
    materializedRecordOrUndefined(
      ownMaterializedDataProperty(record, "context"),
    );
  const contextTokens =
    rawContext === undefined
      ? undefined
      : tokenCount(ownMaterializedDataProperty(rawContext, "tokens"));
  const contextWindow =
    rawContext === undefined
      ? undefined
      : tokenCount(ownMaterializedDataProperty(rawContext, "contextWindow"));
  let contextUsage: { tokens?: number; contextWindow?: number } | undefined;
  if (contextTokens !== undefined || contextWindow !== undefined) {
    contextUsage = {};
    if (contextTokens !== undefined) contextUsage.tokens = contextTokens;
    if (contextWindow !== undefined) contextUsage.contextWindow = contextWindow;
  }
  const costTotal =
    tokens === undefined ? undefined : materializedCostTotalOf(tokens);
  const model = firstDefined(
    modelLabel(ownMaterializedDataProperty(record, "model")),
    modelLabel(ownMaterializedDataProperty(record, "responseModel")),
  );
  if (
    Object.keys(usage).length === 0 &&
    costTotal === undefined &&
    contextUsage === undefined &&
    model === undefined
  ) {
    return undefined;
  }

  const facts: MutableAssistantUsageFacts = {};
  if (payload !== undefined) facts.usage = usage;
  if (costTotal !== undefined) facts.costTotal = costTotal;
  if (contextUsage !== undefined) facts.contextUsage = contextUsage;
  if (model !== undefined) facts.model = model;
  return facts;
};

export function projectAssistantUsageFacts(
  message: HostEventInput,
): PiAssistantUsageFacts | undefined {
  const projected = Result.fromThrowable(
    () => projectAssistantUsageFactsFromInput(message),
    (): "unreadable" => "unreadable",
  )();
  return projected.isOk() ? projected.value : undefined;
}

const KNOWN_CHILD_EVENT_TYPES = new Set([
  "message_start",
  "message_update",
  "message_end",
  "text",
  "thinking",
  "reasoning_summary",
  "markdown",
  "tool_call",
  "tool_partial_result",
  "tool_result",
  "tool_error",
  "image",
  "usage",
  "queue_change",
  "status",
  "retry",
  "extension_ui_request",
  "extension_ui_response",
]);

const MAX_CHILD_EVENT_DEPTH = 16;

const boundNativeToolValue = (
  value: PiChildEventJsonValue | undefined,
  depth = 0,
): PiChildEventJsonValue | undefined => {
  const stringValue = hostString.safeParse(value);
  if (stringValue.success)
    return stringValue.data.slice(0, MAX_CHILD_EVENT_STRING);
  const numberValue = boundedNumber.safeParse(value);
  if (numberValue.success) return numberValue.data;
  const booleanValue = boundedBoolean.safeParse(value);
  if (booleanValue.success) return booleanValue.data;
  if (value === null) return null;
  if (depth >= MAX_CHILD_EVENT_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    const boundedItems: PiChildEventJsonValue[] = [];
    for (const item of value.slice(0, MAX_CHILD_EVENT_ITEMS)) {
      const boundedItem = boundNativeToolValue(item, depth + 1);
      if (boundedItem !== undefined) boundedItems.push(boundedItem);
    }
    return boundedItems;
  }

  const record = materializedRecordOrUndefined(value);
  if (record === undefined) return value;
  const bounded = emptyBoundedRecord();
  let copiedFields = 0;
  for (const key of Object.keys(record)) {
    if (copiedFields >= MAX_CHILD_EVENT_KEYS) break;
    if (isPrototypePollutionKey(key)) continue;
    const boundedKey = key.slice(0, 256);
    if (!boundedKey || isPrototypePollutionKey(boundedKey)) continue;
    const item = boundNativeToolValue(
      ownMaterializedDataProperty(record, key),
      depth + 1,
    );
    if (item === undefined || Object.hasOwn(bounded, boundedKey)) continue;
    const defined = defineCopiedDataProperty(bounded, boundedKey, item);
    if (defined.isErr()) continue;
    copiedFields += 1;
  }
  return bounded;
};

const nativeToolErrorMessage = (
  value: PiChildEventJsonValue | undefined,
): string | undefined => {
  const direct = hostString.safeParse(value);
  if (direct.success) return direct.data.slice(0, MAX_CHILD_EVENT_STRING);
  const record = materializedRecordOrUndefined(value);
  if (record === undefined) return undefined;
  const content = ownMaterializedDataProperty(record, "content");
  if (Array.isArray(content)) {
    for (const item of content) {
      const itemText = hostString.safeParse(item);
      if (itemText.success) {
        return itemText.data.slice(0, MAX_CHILD_EVENT_STRING);
      }
      const itemRecord = materializedRecordOrUndefined(item);
      if (itemRecord === undefined) continue;
      const text = hostString.safeParse(
        ownMaterializedDataProperty(itemRecord, "text"),
      );
      if (text.success) return text.data.slice(0, MAX_CHILD_EVENT_STRING);
    }
  }
  const contentText = hostString.safeParse(content);
  if (contentText.success) {
    return contentText.data.slice(0, MAX_CHILD_EVENT_STRING);
  }
  for (const key of ["error", "message", "output"] as const) {
    const text = hostString.safeParse(ownMaterializedDataProperty(record, key));
    if (text.success && text.data.length > 0) {
      return text.data.slice(0, MAX_CHILD_EVENT_STRING);
    }
  }
  return undefined;
};

const ownTrueFlag = (record: MaterializedRecord, key: string): boolean =>
  ownMaterializedDataProperty(record, key) === true;

const nativeToolEndIsError = (record: MaterializedRecord): boolean => {
  if (ownTrueFlag(record, "isError")) return true;
  const result = materializedRecordOrUndefined(
    ownMaterializedDataProperty(record, "result"),
  );
  if (result === undefined) return false;
  return ownTrueFlag(result, "isError") || ownTrueFlag(result, "is_error");
};

/** Normalize the complete Pi 0.84 queue report into the shared queue fact. */
const normalizeQueueUpdateEvent = (record: MaterializedRecord) => {
  const items: string[] = [];
  for (const key of ["steering", "followUp"] as const) {
    const list = ownMaterializedDataProperty(record, key);
    if (list === undefined) return record;
    const read = readQueueList(list);
    if (read.isErr()) return record;
    for (const item of read.value) items.push(item);
    if (items.length > MAX_CHILD_EVENT_ITEMS) return record;
  }
  return { type: "queue_change", size: items.length, queue: items };
};

const normalizeNativeToolEvent = (
  record: MaterializedRecord,
  eventType: string,
) => {
  switch (eventType) {
    case "queue_update":
      return normalizeQueueUpdateEvent(record);
    case "tool_execution_start":
      return {
        type: "tool_call",
        toolCallId: ownMaterializedDataProperty(record, "toolCallId"),
        toolName: ownMaterializedDataProperty(record, "toolName"),
        arguments: boundNativeToolValue(
          ownMaterializedDataProperty(record, "args"),
        ),
      };
    case "tool_execution_update":
      return {
        type: "tool_partial_result",
        toolCallId: ownMaterializedDataProperty(record, "toolCallId"),
        toolName: ownMaterializedDataProperty(record, "toolName"),
        arguments: boundNativeToolValue(
          ownMaterializedDataProperty(record, "args"),
        ),
        partialResult: boundNativeToolValue(
          ownMaterializedDataProperty(record, "partialResult"),
        ),
      };
    case "tool_execution_end":
      if (nativeToolEndIsError(record)) {
        return {
          type: "tool_error",
          toolCallId: ownMaterializedDataProperty(record, "toolCallId"),
          toolName: ownMaterializedDataProperty(record, "toolName"),
          error: nativeToolErrorMessage(
            ownMaterializedDataProperty(record, "result"),
          ),
        };
      }
      return {
        type: "tool_result",
        toolCallId: ownMaterializedDataProperty(record, "toolCallId"),
        toolName: ownMaterializedDataProperty(record, "toolName"),
        result: boundNativeToolValue(
          ownMaterializedDataProperty(record, "result"),
        ),
      };
    default:
      return record;
  }
};

const unreadableChildEvent = () => PiChildSessionEventSchema.safeParse(void 0);

/** Validate known events and preserve only genuinely unknown event kinds. */
const parseChildSessionEvent = (value: HostEventInput) => {
  const targetResult = HostObjectReferenceSchema.safeParse(value);
  if (!targetResult.success) return PiChildSessionEventSchema.safeParse(value);

  const arrayResult = isArrayValue(value);
  if (arrayResult.isErr()) return unreadableChildEvent();
  if (arrayResult.value) return PiChildSessionEventSchema.safeParse(value);

  const typeRead = ownEventTypeString(targetResult.data);
  if (typeRead.isErr()) return unreadableChildEvent();
  const eventType = typeRead.value;
  const materialized = materializeObservedEventRecord(
    targetResult.data,
    eventType,
  );
  if (materialized.isErr()) return unreadableChildEvent();
  if (eventType.length > 256) {
    return {
      success: true as const,
      data: preserveMaterializedUnknown(materialized.value),
    };
  }

  const normalized = normalizeNativeToolEvent(materialized.value, eventType);
  const parsed = PiChildSessionEventSchema.safeParse(normalized);
  if (parsed.success) return parsed;
  if (!KNOWN_CHILD_EVENT_TYPES.has(eventType)) {
    return {
      success: true as const,
      data: preserveMaterializedUnknown(materialized.value),
    };
  }
  return parsed;
};

export const parsePiChildSessionEvent = (value: HostEventInput) => {
  const guarded = Result.fromThrowable(
    () => parseChildSessionEvent(value),
    (): "unreadable" => "unreadable",
  )();
  return guarded.isOk() ? guarded.value : unreadableChildEvent();
};

// ---------------------------------------------------------------------------
// Raw reasoning redaction
// ---------------------------------------------------------------------------

const RAW_REASONING_BLOCK_TYPES = new Set(["thinking", "reasoning"]);
const RAW_REASONING_BLOCK_FIELDS: readonly string[] = [
  "text",
  ...RAW_REASONING_PROSE_KEYS,
];
const RAW_REASONING_CARRIER_FIELDS: readonly string[] = [
  "delta",
  "text",
  "content",
  "partial",
  "partialText",
  "summary",
  ...RAW_REASONING_PROSE_KEYS,
];
const RAW_REASONING_FRAME_FIELDS: readonly string[] = [
  "text",
  "content",
  "partial",
  "partialText",
  ...RAW_REASONING_PROSE_KEYS,
];
const MESSAGE_REASONING_FIELDS: readonly string[] = [
  ...RAW_REASONING_PROSE_KEYS,
];
const MAX_REASONING_REDACTION_DEPTH = 32;

const plainRecord = (
  value: PiChildEventJsonValue | undefined,
): BoundedRecord | undefined => recordOrUndefined(value);

function carriesReasoningProse(
  value: PiChildEventJsonValue | undefined,
  depth = 0,
): boolean {
  const stringValue = boundedString.safeParse(value);
  if (stringValue.success) return stringValue.data !== "";
  if (value === null || value === undefined) return false;
  if (depth >= MAX_REASONING_REDACTION_DEPTH) return false;
  if (Array.isArray(value)) {
    return value.some((item) => carriesReasoningProse(item, depth + 1));
  }
  const record = plainRecord(value);
  if (record === undefined) return false;
  for (const key of Object.keys(record)) {
    if (key === "type") continue;
    if (carriesReasoningProse(ownDataProperty(record, key), depth + 1)) {
      return true;
    }
  }
  return false;
}

function blankReasoningProse(
  value: PiChildEventJsonValue,
  depth = 0,
): PiChildEventJsonValue {
  const stringValue = boundedString.safeParse(value);
  if (stringValue.success) return "";
  if (value === null) return null;
  if (depth >= MAX_REASONING_REDACTION_DEPTH) return null;
  if (Array.isArray(value)) {
    return value.map((item) => blankReasoningProse(item, depth + 1));
  }
  const record = plainRecord(value);
  if (record === undefined) return null;
  const next = emptyMaterializedRecord();
  for (const key of Object.keys(record)) {
    const item = ownDataProperty(record, key);
    if (item === undefined) continue;
    const cleaned =
      key === "type" ? item : blankReasoningProse(item, depth + 1);
    const defined = defineCopiedDataProperty(next, key, cleaned);
    if (defined.isErr()) continue;
  }
  return next;
}

function blankDeclaredProseFields(
  record: BoundedRecord,
  fields: readonly string[],
): BoundedRecord | undefined {
  const replacements = new Map<string, PiChildEventJsonValue>();
  for (const field of fields) {
    if (!Object.hasOwn(record, field)) continue;
    const value = ownDataProperty(record, field);
    if (value === undefined || !carriesReasoningProse(value)) continue;
    replacements.set(field, blankReasoningProse(value));
  }
  if (replacements.size === 0) return undefined;
  const redacted = copyBoundedRecord(record);
  for (const [field, value] of replacements) {
    const defined = defineCopiedDataProperty(redacted, field, value);
    if (defined.isErr()) continue;
  }
  return redacted;
}

const redactReasoningContentBlocks = (
  content: PiChildEventJsonValue | undefined,
): PiChildEventJsonValue[] | undefined => {
  if (!Array.isArray(content)) return undefined;
  let redacted = false;
  const next = content.map((block) => {
    const record = plainRecord(block);
    if (record === undefined) return block;
    const type = z.string().safeParse(ownDataProperty(record, "type"));
    if (!type.success || !RAW_REASONING_BLOCK_TYPES.has(type.data)) {
      return block;
    }
    const fields: string[] = [];
    for (const field of RAW_REASONING_BLOCK_FIELDS) {
      const value = boundedString.safeParse(ownDataProperty(record, field));
      if (value.success && value.data !== "") fields.push(field);
    }
    if (fields.length === 0) return block;
    redacted = true;
    const cleaned = copyBoundedRecord(record);
    for (const field of fields) {
      const defined = defineCopiedDataProperty(cleaned, field, "");
      if (defined.isErr()) continue;
    }
    return cleaned;
  });
  return redacted ? next : undefined;
};

const redactMessageReasoning = (
  message: PiChildEventJsonValue | undefined,
): BoundedRecord | undefined => {
  const record = plainRecord(message);
  if (record === undefined) return undefined;
  const content = redactReasoningContentBlocks(
    ownDataProperty(record, "content"),
  );
  const fields = blankDeclaredProseFields(record, MESSAGE_REASONING_FIELDS);
  if (content === undefined && fields === undefined) return undefined;
  const redacted = copyBoundedRecord(fields ?? record);
  if (content !== undefined) {
    const defined = defineCopiedDataProperty(redacted, "content", content);
    if (defined.isErr()) return undefined;
  }
  return redacted;
};

export function redactRawReasoningFromEvent(
  event: PiChildSessionEvent,
): PiChildSessionEvent {
  if (event.type === "thinking") {
    if (event.text === undefined || event.text === "") return event;
    return { ...event, text: "" };
  }
  if (event.type === "message_start" || event.type === "message_end") {
    const message = redactMessageReasoning(event.message);
    if (message === undefined) return event;
    return { ...event, message };
  }
  if (event.type !== "message_update") return event;

  const delta = plainRecord(event.delta);
  const assistantEvent = plainRecord(event.assistantMessageEvent);
  const carrier = classifyPiMessageUpdate(event);
  const ambiguous = carrier.kind === "rejected";
  const reasoningFrame = carrier.kind === "reasoning" || ambiguous;

  let redactedDelta: BoundedRecord | undefined;
  const legacyReasoning =
    delta !== undefined &&
    (reasoningFrame ||
      (Object.hasOwn(delta, "thinking") &&
        ownDataProperty(delta, "thinking") !== undefined));
  if (delta !== undefined && legacyReasoning) {
    redactedDelta = blankDeclaredProseFields(
      delta,
      RAW_REASONING_CARRIER_FIELDS,
    );
  }

  let redactedAssistant: BoundedRecord | undefined;
  if (
    assistantEvent !== undefined &&
    (isRawReasoningAssistantEventType(
      ownDataProperty(assistantEvent, "type"),
    ) ||
      reasoningFrame)
  ) {
    redactedAssistant = blankDeclaredProseFields(
      assistantEvent,
      RAW_REASONING_CARRIER_FIELDS,
    );
  }

  let redactedFrame: BoundedRecord | undefined;
  if (reasoningFrame) {
    const frame = boundedRecordSchema.safeParse(event);
    if (frame.success) {
      redactedFrame = blankDeclaredProseFields(
        frame.data,
        RAW_REASONING_FRAME_FIELDS,
      );
    }
  }
  const redactedMessage = redactMessageReasoning(
    eventDataProperty(event, "message"),
  );
  if (
    redactedDelta === undefined &&
    redactedAssistant === undefined &&
    redactedFrame === undefined &&
    redactedMessage === undefined
  ) {
    return event;
  }

  const frame = boundedRecordSchema.safeParse(event);
  if (!frame.success) return event;
  const next = copyBoundedRecord(redactedFrame ?? frame.data);
  if (redactedDelta !== undefined) {
    const defined = defineCopiedDataProperty(next, "delta", redactedDelta);
    if (defined.isErr()) return event;
  }
  if (redactedAssistant !== undefined) {
    const defined = defineCopiedDataProperty(
      next,
      "assistantMessageEvent",
      redactedAssistant,
    );
    if (defined.isErr()) return event;
  }
  if (redactedMessage !== undefined) {
    const defined = defineCopiedDataProperty(next, "message", redactedMessage);
    if (defined.isErr()) return event;
  }
  const parsed = PiChildSessionEventSchema.safeParse(next);
  return parsed.success ? parsed.data : event;
}

const CANONICAL_REASONING_CARRIER_TYPE = "thinking_delta";

export function canonicalReasoningMessageUpdate(): PiChildSessionEvent {
  const parsed = PiChildSessionEventSchema.safeParse({
    type: "message_update",
    assistantMessageEvent: { type: CANONICAL_REASONING_CARRIER_TYPE },
  });
  if (parsed.success) return parsed.data;
  return { type: "message_update" };
}

export function retainedChildSessionEvent(
  event: PiChildSessionEvent,
): PiChildSessionEvent | undefined {
  if (event.type === "message_update") {
    const carrier = classifyPiMessageUpdate(event);
    if (carrier.kind === "rejected") return undefined;
    if (carrier.kind === "reasoning") return canonicalReasoningMessageUpdate();
  }
  return redactRawReasoningFromEvent(event);
}
