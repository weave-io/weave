import { err, ok, Result } from "neverthrow";
import { z } from "zod";
import {
  classifyPiMessageUpdate,
  isRawReasoningAssistantEventType,
} from "./message-update-carrier.js";

/** Bounds applied to observed private Pi protocol data. */
export const MAX_CHILD_EVENT_STRING = 16_384;
export const MAX_CHILD_EVENT_KEYS = 64;
export const MAX_CHILD_EVENT_ITEMS = 128;

const boundedString = z.string().max(MAX_CHILD_EVENT_STRING);
const boundedKey = z.string().max(256);
const boundedJson: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string().max(MAX_CHILD_EVENT_STRING),
    z.number().finite(),
    z.boolean(),
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

const event = <T extends z.ZodRawShape>(type: string, shape: T) =>
  z.object({ type: z.literal(type), ...shape }).catchall(boundedJson);

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
/**
 * Raw model reasoning (chain-of-thought).
 *
 * Its `text` is NEVER a summary and is never rendered anywhere: the overlay,
 * the delegation card's model-visible line and the persisted card details all
 * treat this event as a content-free "the child reasoned" marker. Truncating
 * or relabelling this text would fabricate a summary the host never produced.
 */
const Thinking = event("thinking", { text: boundedString.optional() });
/**
 * The ONE trusted reasoning surface.
 *
 * A host emits this only when it has itself produced an explicit reasoning
 * summary for the reader. It is structurally distinct from {@link Thinking} on
 * purpose: nothing derives one from the other.
 */
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

// ---------------------------------------------------------------------------
// Usage telemetry (Pi 0.83 / 0.84 field mapping)
// ---------------------------------------------------------------------------

/**
 * Exact Pi 0.83 shapes this narrow parses, read from the isolated install at
 * `/private/tmp/weave-pi083/node_modules` (`@earendil-works/pi-coding-agent`
 * 0.83.0, `@earendil-works/pi-ai`):
 *
 * - `@earendil-works/pi-ai/dist/types.d.ts:260` —
 *   `interface Usage { input: number; output: number; cacheRead: number;
 *   cacheWrite: number; cacheWrite1h?: number; reasoning?: number;
 *   totalTokens: number; cost: { input; output; cacheRead; cacheWrite; total } }`.
 *   `reasoning` is documented as a subset of `output`; `cost` is money, not
 *   tokens, and is deliberately not projected.
 * - `@earendil-works/pi-ai/dist/types.d.ts` `interface AssistantMessage` —
 *   `{ api; provider: ProviderId; model: string; responseModel?: string;
 *   usage: Usage; ... }`. Only `model` is read here; `provider` is never read
 *   from the host, it is derived from an unambiguous `provider/model` string.
 * - `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:193` —
 *   `interface ContextUsage { tokens: number | null; contextWindow: number;
 *   percent: number | null }`. `tokens` is the used figure, `contextWindow`
 *   the limit. `percent` is host-computed and intentionally ignored: the
 *   overlay derives a percentage only from both operands it can verify.
 * - `@earendil-works/pi-coding-agent/dist/core/usage-totals.d.ts` —
 *   `UsageTotals { input; output; cacheRead; cacheWrite; cost }`, the same
 *   token field names, which is why the flat token names are accepted at the
 *   top level of the `usage` payload as well as inside a nested `usage`.
 *
 * Pi emits this accounting on the terminal assistant message
 * (`message_end.message.usage`), which is the authoritative live source; the
 * standalone `usage` event is retained as a backward-compatible source for
 * hosts and recorded sessions that carry usage on its own event.
 *
 * Everything is optional: both carriers are `boundedJson`, so a report with no
 * usable field is a legitimate "unavailable" state.
 */
export const MAX_CHILD_USAGE_TOKENS = 1_000_000_000;

/** Bounded, non-negative integer token counts. Anything else is absent. */
const UsageTokenCountSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_CHILD_USAGE_TOKENS);

/**
 * Ceiling on one report's money figure.
 *
 * Cost is money, not tokens, so it is read as a finite non-negative number
 * rather than an integer, and an absurd figure is absent rather than printed.
 */
export const MAX_CHILD_USAGE_COST = 1_000_000;

const UsageCostSchema = z.number().finite().min(0).max(MAX_CHILD_USAGE_COST);

/** Model labels are bounded the same way run-divider model labels are. */
export const MAX_CHILD_USAGE_MODEL_LENGTH = 128;

const UsageModelSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_CHILD_USAGE_MODEL_LENGTH);

/** One parsed, bounded usage report. Every field is independently optional. */
export interface PiChildUsageReport {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
  /** `ContextUsage.tokens` — context tokens used, as reported by the host. */
  readonly contextTokens?: number;
  /** `ContextUsage.contextWindow` — the host-reported context limit. */
  readonly contextWindow?: number;
  /**
   * `Usage.cost.total` — what the host itself charged for this report.
   *
   * Money is only ever READ, never derived from token counts, and only from
   * the exact places pi-ai puts it.
   */
  readonly costTotal?: number;
  /** `AssistantMessage.model`, when the host reports it beside the usage. */
  readonly model?: string;
}

/** No usable usage payload was present on the event. */
export type PiChildUsageError = { readonly type: "UsageUnavailable" };

const recordOrUndefined = (
  value: unknown,
): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Why an observed field or element is not the host's own stated value. */
type OwnValueRejection =
  | "absent"
  | "inherited"
  | "accessor"
  | "non-enumerable"
  | "unreadable"
  | "malformed";

/**
 * `Object.getOwnPropertyDescriptor` as a value.
 *
 * The observed payload is private host data that may be a proxy: its
 * `getOwnPropertyDescriptor` trap can throw, and a revoked proxy always does.
 * A descriptor that cannot be read states nothing.
 */
const ownDescriptor = Result.fromThrowable(
  (target: object, key: PropertyKey): PropertyDescriptor | undefined =>
    Object.getOwnPropertyDescriptor(target, key),
  (): OwnValueRejection => "unreadable",
);

/** `Array.isArray` as a value: it throws on a revoked proxy. */
const isArrayValue = Result.fromThrowable(
  (value: unknown): boolean => Array.isArray(value),
  (): OwnValueRejection => "unreadable",
);

/** `Object.keys` as a value: a proxy `ownKeys` trap can throw. */
const ownEnumerableKeys = Result.fromThrowable(
  (target: object): string[] => Object.keys(target),
  (): OwnValueRejection => "unreadable",
);

/**
 * The value of an own, enumerable DATA property.
 *
 * An accessor is not a stated value - reading it would run the payload's own
 * code - and neither is an inherited or non-enumerable property. All three are
 * rejections rather than values, and no getter is invoked to decide that.
 */
const ownEnumerableDataValue = (
  target: object,
  key: PropertyKey,
): Result<unknown, OwnValueRejection> => {
  const descriptor = ownDescriptor(target, key);
  if (descriptor.isErr()) return err(descriptor.error);
  const found = descriptor.value;
  if (found === undefined) return err("absent");
  if (!("value" in found)) return err("accessor");
  if (found.enumerable !== true) return err("non-enumerable");
  return ok(found.value);
};

/**
 * The event kind the record itself stated.
 *
 * Kind dispatch reads `type` exactly once, through this helper. An accessor,
 * inherited value, non-enumerable property, or non-string is not a stated
 * kind: the getter is never invoked and the value never selects a known
 * parser or normalizer.
 */
const ownEventTypeString = (
  record: object,
): Result<string, OwnValueRejection> => {
  const value = ownEnumerableDataValue(record, "type");
  if (value.isErr()) return err(value.error);
  return typeof value.value === "string" ? ok(value.value) : err("malformed");
};

/**
 * The exact strings a host-stated queue list holds.
 *
 * The list must be a plain, dense array of primitive strings that already fit
 * the bound. Subclasses, sparse holes, accessor or non-enumerable indexes,
 * non-string entries, oversized lists and overbound strings are all
 * rejections; nothing is coerced, sliced or defaulted.
 */
const readQueueList = (
  value: unknown,
): Result<readonly string[], OwnValueRejection> => {
  // `Array.isArray` itself throws on a revoked proxy.
  const arrayShaped = isArrayValue(value);
  if (arrayShaped.isErr()) return err(arrayShaped.error);
  if (!arrayShaped.value) return err("malformed");
  const list = value as readonly unknown[];
  // A plain array only. A subclass or an exotic array-like carries behaviour
  // this parser cannot vouch for.
  const prototype = Result.fromThrowable(
    () => Object.getPrototypeOf(list) as unknown,
    (): OwnValueRejection => "unreadable",
  )();
  if (prototype.isErr()) return err(prototype.error);
  if (prototype.value !== Array.prototype) return err("malformed");

  // `length` is an own, non-enumerable DATA property on every real array.
  // Reading it through its descriptor keeps a proxy's `get` trap out of the
  // decision entirely.
  const lengthDescriptor = ownDescriptor(list, "length");
  if (lengthDescriptor.isErr()) return err(lengthDescriptor.error);
  const found = lengthDescriptor.value;
  if (found === undefined || !("value" in found) || found.enumerable === true) {
    return err("malformed");
  }
  const size = found.value;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    return err("malformed");
  }
  if (size > MAX_CHILD_EVENT_ITEMS) return err("malformed");

  // Dense and nothing else: the own enumerable keys must be exactly the
  // indexes `0..size-1`. A hole, a non-enumerable index or an extra own
  // enumerable property is a shape this parser cannot read as a queue.
  const keys = Result.fromThrowable(
    () => Object.keys(list),
    (): OwnValueRejection => "unreadable",
  )();
  if (keys.isErr()) return err(keys.error);
  if (keys.value.length !== size) return err("malformed");
  for (let index = 0; index < size; index += 1) {
    if (keys.value[index] !== String(index)) return err("malformed");
  }

  const items: string[] = [];
  for (let index = 0; index < size; index += 1) {
    const element = ownEnumerableDataValue(list, String(index));
    // A hole, an accessor index, a non-enumerable index or an unreadable one
    // is not a queued entry.
    if (element.isErr()) return err(element.error);
    const item = element.value;
    if (typeof item !== "string") return err("malformed");
    // Bounded, never truncated: a shortened entry is not what the host queued.
    if (item.length > MAX_CHILD_EVENT_STRING) return err("malformed");
    items.push(item);
  }
  return ok(items);
};

/** Read only an own data property. Accessors and inherited values are absent. */
const ownDataProperty = (
  record: Record<string, unknown>,
  key: string,
): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
};

/** Per-field parse: malformed, negative, fractional, or oversized → absent. */
const tokenCount = (value: unknown): number | undefined => {
  const parsed = UsageTokenCountSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const modelLabel = (value: unknown): string | undefined => {
  const parsed = UsageModelSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

/**
 * The money figure a host `Usage` payload carries.
 *
 * pi-ai reports a breakdown object (`{ input, output, cacheRead, cacheWrite,
 * total }`); some recorded sessions carry a bare number instead. Anything
 * else is absent rather than zero.
 */
const costTotalOf = (usage: Record<string, unknown>): number | undefined => {
  const cost = ownDataProperty(usage, "cost");
  const bare = UsageCostSchema.safeParse(cost);
  if (bare.success) return bare.data;
  const record = recordOrUndefined(cost);
  if (record === undefined) return undefined;
  const total = UsageCostSchema.safeParse(ownDataProperty(record, "total"));
  return total.success ? total.data : undefined;
};

const firstDefined = <T>(
  ...values: readonly (T | undefined)[]
): T | undefined => values.find((value) => value !== undefined);

/** Build one report from already-located token, context, and model sources. */
function usageReportFrom(
  tokens: Record<string, unknown>,
  context: Record<string, unknown>,
  model: string | undefined,
): PiChildUsageReport {
  return {
    inputTokens: tokenCount(tokens["input"]),
    outputTokens: tokenCount(tokens["output"]),
    cacheReadTokens: tokenCount(tokens["cacheRead"]),
    cacheWriteTokens: tokenCount(tokens["cacheWrite"]),
    reasoningTokens: tokenCount(tokens["reasoning"]),
    totalTokens: tokenCount(tokens["totalTokens"]),
    contextTokens: firstDefined(
      tokenCount(context["tokens"]),
      tokenCount(context["contextTokens"]),
    ),
    contextWindow: tokenCount(context["contextWindow"]),
    costTotal: costTotalOf(tokens),
    model,
  };
}

/**
 * Standalone `usage` event: the backward-compatible source kept for hosts and
 * recorded sessions that emit usage on its own event rather than on the
 * terminal assistant message.
 */
function parseStandaloneUsageEvent(
  event: PiChildSessionEvent,
): Result<PiChildUsageReport, PiChildUsageError> {
  const record = event as unknown as Record<string, unknown>;
  const payload = recordOrUndefined(record["usage"]);
  if (payload === undefined) return err({ type: "UsageUnavailable" });

  // `usage.usage` covers hosts that nest the pi-ai `Usage` inside the payload.
  const tokens = recordOrUndefined(payload["usage"]) ?? payload;
  // `ContextUsage` may travel nested beside the usage or flattened onto it.
  const context =
    recordOrUndefined(payload["context"]) ??
    recordOrUndefined(payload["contextUsage"]) ??
    payload;

  return ok(
    usageReportFrom(
      tokens,
      context,
      firstDefined(
        modelLabel(record["model"]),
        modelLabel(payload["model"]),
        modelLabel(tokens["model"]),
      ),
    ),
  );
}

/**
 * Terminal assistant message: the authoritative live source.
 *
 * Pi reports real token accounting on `message_end.message.usage`, where
 * `message` is the pi-ai `AssistantMessage` (`{ role: "assistant"; model;
 * responseModel?; usage: Usage; ... }`). A message that carries no usage
 * object is not a report and leaves any retained report untouched.
 */
function parseAssistantMessageUsage(
  event: PiChildSessionEvent,
): Result<PiChildUsageReport, PiChildUsageError> {
  const record = event as unknown as Record<string, unknown>;
  const message = recordOrUndefined(record["message"]);
  if (message === undefined) return err({ type: "UsageUnavailable" });
  const role = message["role"];
  // Only the assistant message carries model accounting; anything else that
  // happens to have a `usage` key is not an authoritative report.
  if (typeof role === "string" && role !== "assistant") {
    return err({ type: "UsageUnavailable" });
  }
  const payload = recordOrUndefined(message["usage"]);
  if (payload === undefined) return err({ type: "UsageUnavailable" });

  const tokens = recordOrUndefined(payload["usage"]) ?? payload;
  // `ContextUsage` is a separate host structure; it is read only where the
  // host actually places it and is never inferred from the token totals.
  const context =
    recordOrUndefined(message["contextUsage"]) ??
    recordOrUndefined(message["context"]) ??
    recordOrUndefined(record["contextUsage"]) ??
    recordOrUndefined(record["context"]) ??
    {};

  return ok(
    usageReportFrom(
      tokens,
      context,
      firstDefined(
        modelLabel(message["model"]),
        modelLabel(message["responseModel"]),
        modelLabel(record["model"]),
      ),
    ),
  );
}

/**
 * Narrow a parser-approved event into a bounded usage report.
 *
 * Two authoritative sources are accepted: the terminal `message_end` assistant
 * message Pi actually emits, and the standalone `usage` event some hosts and
 * recorded sessions still carry.
 *
 * Never throws: expected failure is the typed {@link PiChildUsageError}, and
 * every individual field that is missing, malformed, or out of bounds is
 * simply absent from the returned report.
 */
export function parsePiChildUsageReport(
  event: PiChildSessionEvent,
): Result<PiChildUsageReport, PiChildUsageError> {
  if (event.type === "usage") return parseStandaloneUsageEvent(event);
  if (event.type === "message_end") return parseAssistantMessageUsage(event);
  return err({ type: "UsageUnavailable" });
}

/** Token fields projected out of a host `Usage` payload, in pi-ai order. */
const USAGE_TOKEN_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
  "totalTokens",
] as const;

/** Bounded usage facts recovered from one persisted assistant message. */
export interface PiAssistantUsageFacts {
  /** Bounded, non-negative integer token counts, keyed by pi-ai field name. */
  readonly usage?: Readonly<Record<string, number>>;
  /** `Usage.cost.total`, bounded. Read only, never derived from tokens. */
  readonly costTotal?: number;
  /** Bounded context facts, keyed by Pi's ContextUsage field names. */
  readonly contextUsage?: Readonly<{
    readonly tokens?: number;
    readonly contextWindow?: number;
  }>;
  readonly model?: string;
}

/**
 * Project the usage facts of a persisted assistant message into a bounded,
 * payload-free record.
 *
 * Historical telemetry comes from native session entries, which store the same
 * pi-ai `AssistantMessage`. Only the known token fields, the host's own
 * `cost.total` and the model label are copied, so no raw host payload or path
 * can travel with them. The money figure is READ from the one field pi-ai puts
 * it in and is never derived from the token counts beside it.
 * `undefined` means the message carried no usable usage fact.
 */
export function projectAssistantUsageFacts(
  message: unknown,
): PiAssistantUsageFacts | undefined {
  const projected = Result.fromThrowable(
    (): PiAssistantUsageFacts | undefined => {
      const record = recordOrUndefined(message);
      if (record === undefined) return undefined;
      const payload = recordOrUndefined(ownDataProperty(record, "usage"));
      const tokens =
        payload === undefined
          ? undefined
          : (recordOrUndefined(ownDataProperty(payload, "usage")) ?? payload);

      const usage: Record<string, number> = {};
      if (tokens !== undefined) {
        for (const field of USAGE_TOKEN_FIELDS) {
          const count = tokenCount(ownDataProperty(tokens, field));
          if (count !== undefined) usage[field] = count;
        }
      }

      const rawContext =
        recordOrUndefined(ownDataProperty(record, "contextUsage")) ??
        recordOrUndefined(ownDataProperty(record, "context"));
      const contextTokens =
        rawContext === undefined
          ? undefined
          : tokenCount(ownDataProperty(rawContext, "tokens"));
      const contextWindow =
        rawContext === undefined
          ? undefined
          : tokenCount(ownDataProperty(rawContext, "contextWindow"));
      const contextUsage =
        contextTokens === undefined && contextWindow === undefined
          ? undefined
          : {
              ...(contextTokens === undefined ? {} : { tokens: contextTokens }),
              ...(contextWindow === undefined ? {} : { contextWindow }),
            };
      const costTotal = tokens === undefined ? undefined : costTotalOf(tokens);
      const model = firstDefined(
        modelLabel(ownDataProperty(record, "model")),
        modelLabel(ownDataProperty(record, "responseModel")),
      );
      if (
        Object.keys(usage).length === 0 &&
        costTotal === undefined &&
        contextUsage === undefined &&
        model === undefined
      ) {
        return undefined;
      }
      return {
        ...(payload === undefined ? {} : { usage }),
        ...(costTotal === undefined ? {} : { costTotal }),
        ...(contextUsage === undefined ? {} : { contextUsage }),
        ...(model === undefined ? {} : { model }),
      };
    },
    () => undefined,
  )();
  return projected.isOk() ? projected.value : undefined;
}
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
  /** Correlates the response with exactly one originating child request. */
  requestId: boundedString,
  response: boundedJson.optional(),
  cancelled: z.boolean().optional(),
  error: boundedString.optional(),
});

const UnknownChildEvent = z
  .object({
    type: z.literal("unknown"),
    originalType: z.string().min(1).max(256),
    payload: z
      .record(boundedKey, boundedJson)
      .refine(
        (value) => Object.keys(value).length <= MAX_CHILD_EVENT_KEYS,
        "too many object keys",
      )
      .optional(),
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
export type PiChildSessionEvent = z.infer<typeof PiChildSessionEventSchema>;
export type PiChildEventType = PiChildSessionEvent["type"];

/** How deep a preserved payload may nest before it states nothing. */
const MAX_PRESERVED_PAYLOAD_DEPTH = 32;

/** Distinguishes "no stated value" from a stated `undefined`. */
const ABSENT_MEMBER = Symbol("absent-member");

/**
 * The value of an own, enumerable data property, WITHOUT guarding the
 * reflection itself.
 *
 * Used for the event record the parser was handed: a record whose own traps
 * throw is unusable, and the parser's outer guard reports that as its typed
 * failure. Accessors still state nothing and are never invoked.
 */
const strictOwnEnumerableDataValue = (
  target: object,
  key: PropertyKey,
): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined) return ABSENT_MEMBER;
  if (!("value" in descriptor) || descriptor.enumerable !== true) {
    return ABSENT_MEMBER;
  }
  return descriptor.value;
};

/** Keys that must never be copied: assignment into `{}` would mutate authority. */
const isPrototypePollutionKey = (key: string): boolean =>
  key === "__proto__" || key === "constructor" || key === "prototype";

const emptyMaterializedRecord = (): Record<string, unknown> =>
  Object.create(null) as Record<string, unknown>;

/**
 * Define one own enumerable writable configurable DATA property.
 *
 * Assignment is never used: `target["__proto__"] = value` on an ordinary
 * object retargets `[[Prototype]]` instead of creating an own key. Pollution
 * keys are rejected so later Zod or `{}` assignment cannot inherit them.
 */
const defineCopiedDataProperty = (
  target: object,
  key: string,
  value: unknown,
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

/**
 * Copy one already-located own enumerable data value into a fresh null-
 * prototype record or dense array. Descriptors only: a later `get` cannot
 * invent a different member. Anything exotic is a rejection so the caller can
 * drop that field. Pollution keys are omitted rather than assigned.
 */
const materializePlainDataValue = (
  value: unknown,
  depth: number,
): Result<unknown, OwnValueRejection> => {
  if (value === null) return ok(null);
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") {
    return ok(value);
  }
  if (type !== "object") return err("malformed");
  if (depth >= MAX_PRESERVED_PAYLOAD_DEPTH) return err("malformed");

  const prototype = Result.fromThrowable(
    () => Object.getPrototypeOf(value) as unknown,
    (): OwnValueRejection => "unreadable",
  )();
  if (prototype.isErr()) return err(prototype.error);

  const arrayShaped = isArrayValue(value);
  if (arrayShaped.isErr()) return err(arrayShaped.error);
  const isArray = arrayShaped.value;
  if (isArray) {
    if (prototype.value !== Array.prototype) return err("malformed");
  } else if (prototype.value !== Object.prototype && prototype.value !== null) {
    return err("malformed");
  }

  const target = value as object;
  const keys = ownEnumerableKeys(target);
  if (keys.isErr()) return err(keys.error);
  if (keys.value.length > MAX_CHILD_EVENT_ITEMS) return err("malformed");

  if (isArray) {
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
    const size = found.value;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      return err("malformed");
    }
    if (size > MAX_CHILD_EVENT_ITEMS) return err("malformed");
    if (keys.value.length !== size) return err("malformed");
    const items: unknown[] = [];
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
    const nested = materializePlainDataValue(member.value, depth + 1);
    if (nested.isErr()) return err(nested.error);
    const defined = defineCopiedDataProperty(copy, key, nested.value);
    if (defined.isErr()) return err(defined.error);
  }
  return ok(copy);
};

/**
 * The only record schema validation and the native-tool normalizer may see.
 *
 * Own enumerable DATA fields are copied into a fresh null-prototype record
 * with `Object.defineProperty`. `type` is forced to the already-captured
 * descriptor-safe primitive string, so a proxy whose `get` trap names a
 * different kind cannot select a known parser. Accessors, inherited values,
 * non-enumerable fields, pollution keys, and values that are not plain data
 * are omitted rather than read.
 */
const materializeObservedEventRecord = (
  record: object,
  eventType: string,
): Result<Record<string, unknown>, OwnValueRejection> => {
  const keys = ownEnumerableKeys(record);
  if (keys.isErr()) return err(keys.error);
  const materialized = emptyMaterializedRecord();
  const typed = defineCopiedDataProperty(materialized, "type", eventType);
  if (typed.isErr()) return err(typed.error);
  for (const key of keys.value) {
    if (key === "type" || isPrototypePollutionKey(key)) continue;
    if (Object.keys(materialized).length - 1 >= MAX_CHILD_EVENT_KEYS) break;
    const boundedName = key.slice(0, 256);
    if (!boundedName || isPrototypePollutionKey(boundedName)) continue;
    const member = ownEnumerableDataValue(record, key);
    if (member.isErr()) continue;
    const nested = materializePlainDataValue(member.value, 0);
    if (nested.isErr()) continue;
    const defined = defineCopiedDataProperty(
      materialized,
      boundedName,
      nested.value,
    );
    if (defined.isErr()) return err(defined.error);
  }
  return ok(materialized);
};

/**
 * Convert an unrecognised host record into the bounded unknown variant.
 *
 * Fields are materialized through their own property descriptors before Zod
 * reads them, so preserving an event never invokes an accessor the observed
 * payload defined, never assigns a pollution key, and never throws on a
 * hostile proxy.
 */
export function preserveUnknownChildEvent(value: unknown): PiChildSessionEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { type: "unknown", originalType: "non-object", payload: {} };
  }
  const record = value as Record<string, unknown>;
  // The event record's OWN reflection is not guarded here: a record this
  // parser cannot enumerate at all is unusable, and `parsePiChildSessionEvent`
  // already turns that into its typed parser failure. What is guarded is
  // everything the record merely CARRIES.
  const declaredType = strictOwnEnumerableDataValue(record, "type");
  const rawType = typeof declaredType === "string" ? declaredType : "missing";
  const originalType = rawType.slice(0, 256) || "missing";
  const payload = emptyMaterializedRecord();
  for (const key of Object.keys(record)) {
    if (
      key === "type" ||
      isPrototypePollutionKey(key) ||
      Object.keys(payload).length >= MAX_CHILD_EVENT_KEYS
    ) {
      continue;
    }
    const boundedName = key.slice(0, 256);
    if (!boundedName || isPrototypePollutionKey(boundedName)) continue;
    const member = strictOwnEnumerableDataValue(record, key);
    // An accessor field states nothing: running it would execute the observed
    // payload's own code inside the parser.
    if (member === ABSENT_MEMBER) continue;
    const nested = materializePlainDataValue(member, 0);
    if (nested.isErr()) continue;
    const parsed = boundedJson.safeParse(nested.value);
    if (!parsed.success) continue;
    const defined = defineCopiedDataProperty(payload, boundedName, parsed.data);
    if (defined.isErr()) continue;
  }
  return { type: "unknown", originalType, payload };
}

/** The correlated response sent back to the originating child extension. */
export const PiExtensionUiResponseSchema = ExtensionUiResponse;
export type PiExtensionUiResponse = z.infer<typeof PiExtensionUiResponseSchema>;

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

const boundNativeToolValue = (value: unknown, depth = 0): unknown => {
  if (typeof value === "string") return value.slice(0, MAX_CHILD_EVENT_STRING);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  if (depth >= MAX_CHILD_EVENT_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_CHILD_EVENT_ITEMS)
      .map((item) => boundNativeToolValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value !== "object") return undefined;

  const bounded = emptyMaterializedRecord();
  for (const [key, item] of Object.entries(value)) {
    if (Object.keys(bounded).length >= MAX_CHILD_EVENT_KEYS) break;
    if (isPrototypePollutionKey(key)) continue;
    const boundedKey = key.slice(0, 256);
    if (!boundedKey || isPrototypePollutionKey(boundedKey)) continue;
    const boundedItem = boundNativeToolValue(item, depth + 1);
    if (boundedItem === undefined) continue;
    const defined = defineCopiedDataProperty(bounded, boundedKey, boundedItem);
    if (defined.isErr()) continue;
  }
  return bounded;
};

const nativeToolErrorMessage = (value: unknown): string | undefined => {
  if (typeof value === "string") return value.slice(0, MAX_CHILD_EVENT_STRING);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const content = record["content"];
  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === "string")
        return item.slice(0, MAX_CHILD_EVENT_STRING);
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        continue;
      }
      const text = (item as Record<string, unknown>)["text"];
      if (typeof text === "string")
        return text.slice(0, MAX_CHILD_EVENT_STRING);
    }
  }
  if (typeof content === "string")
    return content.slice(0, MAX_CHILD_EVENT_STRING);
  // A tool that reports its own failure prose rather than a content block.
  for (const key of ["error", "message", "output"] as const) {
    const text = record[key];
    if (typeof text === "string" && text.length > 0)
      return text.slice(0, MAX_CHILD_EVENT_STRING);
  }
  return undefined;
};

/**
 * Did this `tool_execution_end` report a FAILED tool?
 *
 * Pi carries the flag twice: on the event, and on the pi-ai
 * `ToolResultMessage` it wraps (`{ role: "toolResult", …, isError }`). Only
 * the event-level flag was read, so a host that reports the failure on the
 * message alone produced an ordinary success row and the deliberate failure
 * had no `⎿` outcome at all. Either authority is enough; neither is invented.
 */
const ownTrueFlag = (record: object, key: string): boolean => {
  const flag = ownEnumerableDataValue(record, key);
  return flag.isOk() && flag.value === true;
};

const nativeToolEndIsError = (record: Record<string, unknown>): boolean => {
  if (ownTrueFlag(record, "isError")) return true;
  const result = ownEnumerableDataValue(record, "result");
  if (result.isErr()) return false;
  if (typeof result.value !== "object" || result.value === null) return false;
  const arrayShaped = isArrayValue(result.value);
  if (arrayShaped.isErr() || arrayShaped.value) return false;
  return (
    ownTrueFlag(result.value, "isError") ||
    ownTrueFlag(result.value, "is_error")
  );
};

/**
 * Real Pi 0.84 queue reporting.
 *
 * `AgentSession` emits `{ type: "queue_update", steering: string[], followUp:
 * string[] }` — never the `queue_change` / `size` shape this adapter's schema
 * declares. Reading only `queue_change` meant a parent that steered or queued
 * a live child saw `queue 0` on the rail and never reached the card's
 * `steered` frame, because the one authoritative event that reports the
 * queue was discarded as unknown. Normalizing it here keeps every downstream
 * consumer — the compact reducer, the card, the overlay rail — on one queue
 * fact, exactly as the native tool events above are normalized.
 *
 * The queue is REPORTED, never inferred, and a report is all-or-nothing.
 * `queue_update` is the host's COMPLETE statement of BOTH queues, so a depth
 * may only be derived from a record that states both of them in full:
 *
 * - a record missing either own list, or carrying a list that is not a dense
 *   array of strings, or more entries than the bound admits, states NOTHING.
 *   The record is returned untouched, so it leaves this parser as the existing
 *   typed unknown variant and every consumer keeps the last proven depth.
 * - only a record whose `steering` AND `followUp` are both readable is
 *   authoritative, including the authoritative zero of a host that named both
 *   lists and both were empty.
 *
 * A partial report is a report about ONE queue, not about the child's queue
 * depth: `{ steering: [] }` proves nothing about queued follow-ups. Deriving
 * `{ size: 0 }` from it would state, with the host's own authority, that a
 * steered child has nothing queued.
 *
 * The record's `type` must already have been proven to be an own enumerable
 * data string before this function runs. Every queue field and every element
 * is then read through its own property DESCRIPTOR, so no getter on the
 * observed payload is ever invoked and no value is ever repaired: a queued
 * string that exceeds the bound is rejected rather than truncated, because a
 * truncated entry would be a queue fact the host never stated. A descriptor
 * read that throws (a revoked or hostile proxy) is a rejection like any
 * other, so this function never throws.
 */
const normalizeQueueUpdateEvent = (
  record: Record<string, unknown>,
): unknown => {
  const items: string[] = [];
  for (const key of ["steering", "followUp"] as const) {
    const list = ownEnumerableDataValue(record, key);
    if (list.isErr()) return record;
    const read = readQueueList(list.value);
    if (read.isErr()) return record;
    for (const item of read.value) items.push(item);
    if (items.length > MAX_CHILD_EVENT_ITEMS) return record;
  }
  return { type: "queue_change", size: items.length, queue: items };
};

const normalizeNativeToolEvent = (
  record: Record<string, unknown>,
  eventType: string,
): unknown => {
  switch (eventType) {
    case "queue_update":
      return normalizeQueueUpdateEvent(record);
    case "tool_execution_start":
      return {
        type: "tool_call",
        toolCallId: record["toolCallId"],
        toolName: record["toolName"],
        arguments: boundNativeToolValue(record["args"]),
      };
    case "tool_execution_update":
      // `ToolExecutionUpdateEvent` repeats the call's own `args`. Dropping
      // them meant a call whose opening event never reached this listener
      // printed `bash()` for the rest of the run even though every later
      // event still named the arguments.
      return {
        type: "tool_partial_result",
        toolCallId: record["toolCallId"],
        toolName: record["toolName"],
        arguments: boundNativeToolValue(record["args"]),
        partialResult: boundNativeToolValue(record["partialResult"]),
      };
    case "tool_execution_end":
      if (nativeToolEndIsError(record)) {
        return {
          type: "tool_error",
          toolCallId: record["toolCallId"],
          toolName: record["toolName"],
          error: nativeToolErrorMessage(record["result"]),
        };
      }
      return {
        type: "tool_result",
        toolCallId: record["toolCallId"],
        toolName: record["toolName"],
        result: boundNativeToolValue(record["result"]),
      };
    default:
      return record;
  }
};

/** Validate known events; preserve only genuinely unknown event kinds. */
const parseChildSessionEvent = (value: unknown) => {
  if (typeof value !== "object" || value === null) {
    return PiChildSessionEventSchema.safeParse(value);
  }
  const arrayShaped = isArrayValue(value);
  if (arrayShaped.isErr()) return unreadableChildEvent();
  if (arrayShaped.value) return PiChildSessionEventSchema.safeParse(value);

  const record = value as Record<string, unknown>;
  // One descriptor-safe read. Ordinary `record.type` would invoke getters and
  // accept inherited kinds; either would select a known parser or the queue
  // normalizer from a value the host never stated as own data.
  const typeRead = ownEventTypeString(record);
  if (typeRead.isErr()) return unreadableChildEvent();
  const eventType = typeRead.value;
  // After this copy, Zod and the normalizer never see the observed object.
  const materialized = materializeObservedEventRecord(record, eventType);
  if (materialized.isErr()) return unreadableChildEvent();
  if (eventType.length > 256) {
    return {
      success: true as const,
      data: preserveUnknownChildEvent(materialized.value),
    };
  }

  const normalized = normalizeNativeToolEvent(materialized.value, eventType);
  const parsed = PiChildSessionEventSchema.safeParse(normalized);
  if (parsed.success) return parsed;
  if (!KNOWN_CHILD_EVENT_TYPES.has(eventType)) {
    return {
      success: true as const,
      data: preserveUnknownChildEvent(materialized.value),
    };
  }
  return parsed;
};

/**
 * The typed parser failure reported for an input that cannot be inspected.
 *
 * It is the schema's own failure for `undefined`, so callers keep the exact
 * `safeParse` failure shape they already handle, and the reported `ZodError`
 * carries only schema text. A hostile trap's message and cause are dropped
 * deliberately: they are attacker-chosen prose, and no caller needs them to
 * decide that the event is unusable.
 */
const unreadableChildEvent = () =>
  PiChildSessionEventSchema.safeParse(undefined);

/**
 * Validate known events; preserve only genuinely unknown event kinds.
 *
 * ## Why the whole boundary is wrapped
 *
 * The value comes from a child process over RPC, from a recorded session file,
 * or from a host that hands the adapter an object it built itself. Any of those
 * can be an exotic object rather than plain data: a `Proxy` whose `get`,
 * `has`, `ownKeys`, or `getOwnPropertyDescriptor` trap throws, an accessor that
 * throws on the second read, a `toJSON` or `Symbol.toPrimitive` that throws
 * inside validation, or a getter on a nested `message` that throws only once
 * the schema reaches it.
 *
 * Those throws are reachable from every step of this parser, not just one:
 * the descriptor-safe `type` read, materializing own enumerable data fields,
 * normalization enumerating tool payloads, schema validation reading every
 * member the shapes name, and unknown-event preservation enumerating the
 * whole record. Guarding one step would leave the others open, so the
 * complete unit of work is wrapped and a hostile input becomes the ordinary
 * typed parser failure every caller already handles — the overlay controller
 * ignores the event, the replay mapper skips the entry, and the RPC reader
 * rejects the frame. After the type is captured, only the materialized plain
 * record is handed to the normalizer and Zod.
 *
 * Bounded, descriptor-safe semantics are unchanged: a parser-approved real Pi
 * event still parses exactly as before, since the guard only intercepts the
 * throw that would otherwise cross the boundary.
 */
export const parsePiChildSessionEvent = (value: unknown) => {
  const guarded = Result.fromThrowable(
    () => parseChildSessionEvent(value),
    () => undefined,
  )();
  return guarded.isOk() ? guarded.value : unreadableChildEvent();
};

// ---------------------------------------------------------------------------
// Raw reasoning redaction
// ---------------------------------------------------------------------------

/** Content-block types that carry raw chain-of-thought, never a summary. */
const RAW_REASONING_BLOCK_TYPES = new Set(["thinking", "reasoning"]);
/** Fields a raw reasoning block may carry its prose in. */
const RAW_REASONING_BLOCK_FIELDS = ["text", "thinking", "reasoning"] as const;

/**
 * Every field a raw-reasoning CARRIER (`assistantMessageEvent`, or the legacy
 * `delta` object) may hold chain-of-thought prose in.
 *
 * Pi 0.84 splits one reasoning block across three frames and does NOT use one
 * field for them: `thinking_delta` carries `delta`, and `thinking_end` carries
 * the completed block in `content` — which may itself be a string or an array
 * of content blocks. Redacting `delta` alone left the whole completed thought
 * in retained history, in every rebuilt page, and in everything serialized
 * from them.
 *
 * The list is deliberately a closed superset of the fields observed on the
 * wire: a carrier this boundary has already decided is raw reasoning states
 * nothing a reader may see, so blanking a field it did not use costs nothing,
 * while missing one is a disclosure.
 */
const RAW_REASONING_CARRIER_FIELDS = [
  "delta",
  "text",
  "content",
  "partial",
  "partialText",
  "thinking",
  "reasoning",
  "summary",
] as const;

/**
 * The same treatment for the FRAME itself, minus its structural members.
 *
 * `delta`, `assistantMessageEvent` and `message` are carriers with their own
 * rules above; everything else a reasoning frame declares is prose it has no
 * reader for.
 */
const RAW_REASONING_FRAME_FIELDS = [
  "text",
  "content",
  "partial",
  "partialText",
  "thinking",
  "reasoning",
] as const;

/** Prose fields a carried MESSAGE may state reasoning in, beside its blocks. */
const MESSAGE_REASONING_FIELDS = ["thinking", "reasoning"] as const;

/** How deep redaction walks one carrier before it states nothing at all. */
const MAX_REASONING_REDACTION_DEPTH = 32;

/**
 * True when any string this value can still reach holds prose.
 *
 * `type` is skipped: a block kind (`"thinking"`) is structure, not
 * chain-of-thought, and keeping it is what lets a reader still learn THAT the
 * child reasoned.
 */
function carriesReasoningProse(value: unknown, depth = 0): boolean {
  if (typeof value === "string") return value !== "";
  if (depth >= MAX_REASONING_REDACTION_DEPTH) return false;
  if (Array.isArray(value)) {
    return value.some((item) => carriesReasoningProse(item, depth + 1));
  }
  const record = plainRecord(value);
  if (record === undefined) return false;
  return Object.entries(record).some(
    ([key, item]) => key !== "type" && carriesReasoningProse(item, depth + 1),
  );
}

/**
 * Blanks every string this value can reach while keeping its SHAPE and its
 * block kinds, so the retained event still says "the child reasoned here" and
 * says nothing else.
 */
function blankReasoningProse(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return "";
  if (depth >= MAX_REASONING_REDACTION_DEPTH) return null;
  if (Array.isArray(value)) {
    return value.map((item) => blankReasoningProse(item, depth + 1));
  }
  const record = plainRecord(value);
  if (record === undefined) return value;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    next[key] = key === "type" ? item : blankReasoningProse(item, depth + 1);
  }
  return next;
}

/**
 * Blanks the named prose fields of one record, or returns `undefined` when the
 * record stated no prose in any of them, so callers keep their own identity
 * instead of cloning.
 */
function blankDeclaredProseFields(
  record: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> | undefined {
  let redacted: Record<string, unknown> | undefined;
  for (const field of fields) {
    if (!Object.hasOwn(record, field)) continue;
    const value = record[field];
    if (!carriesReasoningProse(value)) continue;
    redacted ??= { ...record };
    redacted[field] = blankReasoningProse(value);
  }
  return redacted;
}

const plainRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Blanks the prose of every raw reasoning block while keeping the block, so
 * the reader still learns that the child reasoned.
 *
 * Returns `undefined` when nothing needed redacting, so callers can keep the
 * caller's own event identity instead of cloning it.
 */
const redactReasoningContentBlocks = (
  content: unknown,
): unknown[] | undefined => {
  if (!Array.isArray(content)) return undefined;
  let redacted = false;
  const next = content.map((block) => {
    const record = plainRecord(block);
    if (record === undefined) return block;
    const type = record.type;
    if (typeof type !== "string" || !RAW_REASONING_BLOCK_TYPES.has(type)) {
      return block;
    }
    const fields = RAW_REASONING_BLOCK_FIELDS.filter(
      (field) => typeof record[field] === "string" && record[field] !== "",
    );
    if (fields.length === 0) return block;
    redacted = true;
    const cleaned: Record<string, unknown> = { ...record };
    for (const field of fields) cleaned[field] = "";
    return cleaned;
  });
  return redacted ? next : undefined;
};

/**
 * Blanks raw reasoning prose carried inside a message's content blocks, and
 * any reasoning prose the message states beside them.
 */
const redactMessageReasoning = (
  message: unknown,
): Record<string, unknown> | undefined => {
  const record = plainRecord(message);
  if (record === undefined) return undefined;
  const content = redactReasoningContentBlocks(record.content);
  const fields = blankDeclaredProseFields(record, MESSAGE_REASONING_FIELDS);
  if (content === undefined && fields === undefined) return undefined;
  return {
    ...(fields ?? record),
    ...(content === undefined ? {} : { content }),
  };
};

/**
 * Strips raw chain-of-thought TEXT out of one parsed event while preserving
 * its SHAPE, so every consumer still learns that the child reasoned.
 *
 * Raw reasoning is never rendered anywhere in this adapter, so retaining it in
 * transcript state, in an overlay entry's replay steps, or in a rebuilt page
 * would only create another surface for it to escape from. It is applied at
 * every boundary that keeps an event: the transcript reducer, the live overlay
 * projection, and the replay-step builder.
 *
 * Four carriers exist, and all four are content-free after this:
 * - the standalone `thinking` event's `text`;
 * - a `message_update`'s `assistantMessageEvent` whose `type` is
 *   `thinking_start`, `thinking_delta` or `thinking_end` — on EVERY prose
 *   field it declared, not only `delta`. Pi 0.84 splits one thought across
 *   those three frames and puts the completed block in `thinking_end.content`,
 *   so redacting `thinking_delta.delta` alone retained the whole thought;
 * - the legacy `delta: { thinking }` object, likewise on every prose field it
 *   declared beside `thinking`;
 * - a `thinking` or `reasoning` content block, or a reasoning prose field, on
 *   a carried message.
 *
 * A `message_update` that carries answer text AND raw reasoning at once is a
 * fifth case, and the strictest: no reader can tell which carrier held the
 * chain-of-thought, so ALL of them are emptied. Redacting only the thinking
 * carrier left the ambiguous frame's `delta.text` in the retained history
 * event, where a rebuild, a search, or a snapshot could still read it.
 *
 * `reasoning_summary` is deliberately untouched: it is the host's own explicit
 * summary surface and the ONE trusted place reasoning prose may be read from.
 */
export function redactRawReasoningFromEvent(
  event: PiChildSessionEvent,
): PiChildSessionEvent {
  if (event.type === "thinking") {
    return event.text === undefined || event.text === ""
      ? event
      : { ...event, text: "" };
  }
  if (event.type === "message_start" || event.type === "message_end") {
    const record = event as unknown as Record<string, unknown>;
    const message = redactMessageReasoning(record.message);
    return message === undefined
      ? event
      : ({ ...event, message } as unknown as PiChildSessionEvent);
  }
  if (event.type !== "message_update") return event;
  const record = event as unknown as Record<string, unknown>;
  const delta = plainRecord(record.delta);
  const assistantEvent = plainRecord(record.assistantMessageEvent);
  const carrier = classifyPiMessageUpdate(event);
  // An ambiguous frame is redacted on every carrier it declared, because the
  // classifier refused to say which of them the child's reasoning was in.
  const ambiguous = carrier.kind === "rejected";
  // A frame the classifier already called raw reasoning states no answer at
  // all, so every prose field on it - and on the frame itself - is redacted.
  const reasoningFrame = carrier.kind === "reasoning" || ambiguous;
  // The legacy object carrier is raw reasoning when it declared `thinking`,
  // which is exactly the rule `observeLegacyDelta` classifies on.
  const legacyReasoning =
    delta !== undefined &&
    (ambiguous ||
      (Object.hasOwn(delta, "thinking") && delta.thinking !== undefined));
  const redactedDelta =
    delta === undefined || !legacyReasoning
      ? undefined
      : blankDeclaredProseFields(delta, RAW_REASONING_CARRIER_FIELDS);
  const redactedAssistant =
    assistantEvent !== undefined &&
    (isRawReasoningAssistantEventType(assistantEvent.type) || ambiguous)
      ? blankDeclaredProseFields(assistantEvent, RAW_REASONING_CARRIER_FIELDS)
      : undefined;
  const redactedFrame = reasoningFrame
    ? blankDeclaredProseFields(record, RAW_REASONING_FRAME_FIELDS)
    : undefined;
  const redactedMessage = redactMessageReasoning(record.message);
  if (
    redactedDelta === undefined &&
    redactedAssistant === undefined &&
    redactedFrame === undefined &&
    redactedMessage === undefined
  ) {
    return event;
  }
  return {
    ...(redactedFrame ?? event),
    ...(redactedDelta === undefined ? {} : { delta: redactedDelta }),
    ...(redactedAssistant === undefined
      ? {}
      : { assistantMessageEvent: redactedAssistant }),
    ...(redactedMessage === undefined ? {} : { message: redactedMessage }),
  } as unknown as PiChildSessionEvent;
}
