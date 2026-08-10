import { err, ok, type Result } from "neverthrow";
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
// Usage telemetry (Pi 0.83 field mapping)
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
 * Everything is optional: the child `usage` event carries `boundedJson`, so a
 * report with no usable field is a legitimate "unavailable" state.
 */
export const MAX_CHILD_USAGE_TOKENS = 1_000_000_000;

/** Bounded, non-negative integer token counts. Anything else is absent. */
const UsageTokenCountSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_CHILD_USAGE_TOKENS);

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

/** Per-field parse: malformed, negative, fractional, or oversized → absent. */
const tokenCount = (value: unknown): number | undefined => {
  const parsed = UsageTokenCountSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const modelLabel = (value: unknown): string | undefined => {
  const parsed = UsageModelSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const firstDefined = <T>(
  ...values: readonly (T | undefined)[]
): T | undefined => values.find((value) => value !== undefined);

/**
 * Narrow a parser-approved `usage` event into a bounded report.
 *
 * Never throws: expected failure is the typed {@link PiChildUsageError}, and
 * every individual field that is missing, malformed, or out of bounds is
 * simply absent from the returned report.
 */
export function parsePiChildUsageReport(
  event: PiChildSessionEvent,
): Result<PiChildUsageReport, PiChildUsageError> {
  if (event.type !== "usage") return err({ type: "UsageUnavailable" });
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

  const report: PiChildUsageReport = {
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
    model: firstDefined(
      modelLabel(record["model"]),
      modelLabel(payload["model"]),
      modelLabel(tokens["model"]),
    ),
  };
  return ok(report);
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
  const content = (value as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const text = (item as Record<string, unknown>)["text"];
    if (typeof text === "string") return text.slice(0, MAX_CHILD_EVENT_STRING);
  }
  return undefined;
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
      return {
        type: "tool_partial_result",
        toolCallId: record["toolCallId"],
        toolName: record["toolName"],
        partialResult: boundNativeToolValue(record["partialResult"]),
      };
    case "tool_execution_end":
      if (record["isError"] === true) {
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
export const parsePiChildSessionEvent = (value: unknown) => {
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
