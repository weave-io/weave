import { err, ok, Result } from "neverthrow";
import { z } from "zod";

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
const Thinking = event("thinking", { text: boundedString.optional() });
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

/** Convert an unrecognised host record into the bounded unknown variant. */
export function preserveUnknownChildEvent(value: unknown): PiChildSessionEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { type: "unknown", originalType: "non-object", payload: {} };
  }
  const record = value as Record<string, unknown>;
  const rawType = typeof record.type === "string" ? record.type : "missing";
  const originalType = rawType.slice(0, 256) || "missing";
  const payload: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === "type" || Object.keys(payload).length >= MAX_CHILD_EVENT_KEYS)
      continue;
    const boundedName = key.slice(0, 256);
    const parsed = boundedJson.safeParse(item);
    if (boundedName && parsed.success) payload[boundedName] = parsed.data;
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

  const bounded: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (Object.keys(bounded).length >= MAX_CHILD_EVENT_KEYS) break;
    const boundedKey = key.slice(0, 256);
    const boundedItem = boundNativeToolValue(item, depth + 1);
    if (boundedKey && boundedItem !== undefined)
      bounded[boundedKey] = boundedItem;
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
const nativeToolEndIsError = (record: Record<string, unknown>): boolean => {
  if (record["isError"] === true) return true;
  const result = record["result"];
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return false;
  }
  const nested = result as Record<string, unknown>;
  return nested["isError"] === true || nested["is_error"] === true;
};

const normalizeNativeToolEvent = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  switch (record["type"]) {
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
      return value;
  }
};

/** Validate known events; preserve only genuinely unknown event kinds. */
const parseChildSessionEvent = (value: unknown) => {
  const normalized = normalizeNativeToolEvent(value);
  const parsed = PiChildSessionEventSchema.safeParse(normalized);
  if (parsed.success) return parsed;
  const eventType =
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).type === "string"
      ? (value as Record<string, string>).type
      : undefined;
  if (eventType !== undefined && !KNOWN_CHILD_EVENT_TYPES.has(eventType)) {
    return { success: true as const, data: preserveUnknownChildEvent(value) };
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
 * normalization reads `type` and enumerates tool payloads, schema validation
 * reads every member the shapes name, the fallback path reads `type` again, and
 * unknown-event preservation enumerates the whole record. Guarding one step
 * would leave the others open, so the complete unit of work is wrapped and a
 * hostile input becomes the ordinary typed parser failure every caller already
 * handles — the overlay controller ignores the event, the replay mapper skips
 * the entry, and the RPC reader rejects the frame.
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
