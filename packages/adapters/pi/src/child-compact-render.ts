/**
 * Compact `weave_delegate` state reducer (Pi adapter contract §6).
 *
 * Pure, adapter-owned core. Maps parser-approved child event data into a
 * bounded reducer input union without importing UI types, then folds those
 * inputs into bounded run/item state. The delegation card model consumes the
 * same inputs, the same sanitizer, and the same id bounds, so both surfaces
 * correlate one child event under exactly one key.
 *
 * Never throws on expected paths: invalid reduce input is a typed error and
 * leaves prior state untouched.
 */
import { err, type Result as NeverthrowResult, ok, Result } from "neverthrow";
import {
  PI_CHILD_ERROR_CLASSES,
  type PiChildErrorClass,
} from "./child-provider-error.js";
import {
  MAX_CHILD_EVENT_STRING,
  type PiChildSessionEvent,
  parsePiChildUsageReport,
} from "./child-session-events.js";
import {
  extractAssistantTextDeltaPreview,
  truncateLatestOutput,
} from "./child-tree.js";
import type { PiChildSettlement } from "./rpc-child.js";
import type { JsonValue } from "./strict-json.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Maximum run blocks retained per logical thread in reducer state. */
export const CHILD_COMPACT_MAX_RUNS = 64;
/** Maximum tracked items per run block. */
export const CHILD_COMPACT_MAX_ITEMS = 128;
/** Maximum dedup keys retained per run. */
export const CHILD_COMPACT_MAX_DEDUP_KEYS = 256;

/** Largest accepted money figure, in whole units. Anything larger is absent. */
export const CHILD_COMPACT_MAX_COST = 1_000_000;
/** Largest accepted queue depth. Anything larger is absent. */
export const CHILD_COMPACT_MAX_QUEUE_SIZE = 10_000;
/** Largest accepted retry attempt number. Anything larger is absent. */
export const CHILD_COMPACT_MAX_ATTEMPT = 1_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ChildCompactError = {
  readonly type: "ChildCompactFailed";
  readonly operation: "reduce" | "map";
  readonly detail: string;
};

// ---------------------------------------------------------------------------
// Reducer input (adapter-owned; maps parser-approved session events)
// ---------------------------------------------------------------------------

export type ChildCompactRunAction = "start" | "retry" | "continue";

export type ChildCompactRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** Which point of a tool call's life one `tool` input reports. */
export type ChildCompactToolPhase = "call" | "partial" | "result" | "error";

/**
 * Bounded, already-parsed usage facts carried alongside an input.
 *
 * Every field is independently optional: a report that carries no usable field
 * is a legitimate "unavailable" state and never becomes a zero or a guess.
 */
export interface ChildCompactUsageFacts {
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly contextTokens?: number;
  readonly contextWindow?: number;
  /** Whole currency units, as the host reported them. Never derived. */
  readonly costUsd?: number;
  readonly model?: string;
}

/**
 * Bounded reducer inputs. Callers map `PiChildSessionEvent` / Task 8 settlement
 * into this union; the reducer never imports UI types.
 */
export type ChildCompactReducerInput =
  | {
      readonly kind: "start_run";
      readonly threadId: string;
      readonly runNumber: number;
      readonly action: ChildCompactRunAction;
      readonly agentName: string;
    }
  | {
      readonly kind: "assistant_fragment";
      readonly itemId: string;
      readonly dedupKey: string;
      readonly text: string;
      /** Default `append`. `replace` overwrites the item text. */
      readonly mode?: "append" | "replace";
    }
  | {
      readonly kind: "assistant_end";
      readonly itemId: string;
      readonly text?: string;
      /** Usage the terminal assistant message reported, when it carried any. */
      readonly usage?: ChildCompactUsageFacts;
    }
  | {
      readonly kind: "thinking";
      readonly itemId: string;
      /** Bounded reasoning SUMMARY. Raw chain-of-thought is never retained. */
      readonly summary?: string;
    }
  | {
      readonly kind: "tool";
      readonly itemId: string;
      readonly phase?: ChildCompactToolPhase;
      readonly toolName?: string;
      /** Safe progress, result, or error detail the child reported. */
      readonly detail?: string;
    }
  | {
      readonly kind: "usage";
      readonly itemId: string;
      readonly usage: ChildCompactUsageFacts;
    }
  | {
      readonly kind: "queue";
      readonly itemId: string;
      readonly size?: number;
    }
  | {
      readonly kind: "status";
      readonly itemId: string;
      readonly status?: string;
      readonly message?: string;
    }
  | {
      readonly kind: "retry";
      readonly itemId: string;
      readonly attempt?: number;
      readonly reason?: string;
    }
  | {
      readonly kind: "control";
      readonly itemId: string;
    }
  | {
      readonly kind: "settle";
      /** Authoritative Task 8 / §10 settlement only. */
      readonly settlement: PiChildSettlement;
      /**
       * The closed-vocabulary failure class behind a failed settlement, when a
       * classifier named one. It is the only gate on recovery guidance.
       */
      readonly failureClass?: PiChildErrorClass;
    };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type ChildCompactItemKind =
  | "assistant"
  | "placeholder"
  | "thinking"
  | "tool"
  | "control";

export interface ChildCompactItem {
  readonly id: string;
  readonly kind: ChildCompactItemKind;
  readonly text: string;
  readonly isPlaceholder: boolean;
  readonly ended: boolean;
}

export interface ChildCompactRunBlock {
  readonly runNumber: number;
  readonly action: ChildCompactRunAction;
  readonly agentName: string;
  readonly status: ChildCompactRunStatus;
  readonly items: readonly ChildCompactItem[];
  /** Stable ordered item ids for the run. */
  readonly itemIds: readonly string[];
  /** Dedup keys already applied to this run. */
  readonly dedupKeys: ReadonlySet<string>;
  /** Latest meaningful assistant fragment (running preview only). */
  readonly latestMeaningfulFragment: string | undefined;
  /** Authoritative final response from Task 8 settlement. */
  readonly finalResponse: string | undefined;
  /** Authoritative error summary from Task 8 settlement. */
  readonly errorSummary: string | undefined;
  /** Frozen prior runs are never mutated. */
  readonly frozen: boolean;
}

export interface ChildCompactState {
  /** Opaque logical thread id — never rendered. */
  readonly threadId: string;
  readonly runs: readonly ChildCompactRunBlock[];
  readonly currentRunNumber: number | undefined;
}

// ---------------------------------------------------------------------------
// Public constructors
// ---------------------------------------------------------------------------

export function createChildCompactState(threadId: string): ChildCompactState {
  return {
    threadId: boundOpaqueId(threadId),
    runs: [],
    currentRunNumber: undefined,
  };
}

// ---------------------------------------------------------------------------
// Sanitize
// ---------------------------------------------------------------------------

/**
 * Strips ANSI CSI/OSC and C0/C1 controls, normalizes whitespace/newlines, and
 * bounds text to the child event string cap then the 4 KiB UTF-8 projection.
 */
export function sanitizeChildCompactText(value: string): string {
  const stripped = stripTerminalControls(value);
  const normalized = stripped.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return "";
  const capped =
    normalized.length > MAX_CHILD_EVENT_STRING
      ? [...normalized].slice(0, MAX_CHILD_EVENT_STRING).join("")
      : normalized;
  return truncateLatestOutput(capped);
}

function stripTerminalControls(value: string): string {
  let result = "";
  let i = 0;
  while (i < value.length) {
    const code = value.charCodeAt(i);
    if (code === 0x1b || code === 0x9b) {
      if (code === 0x1b && value.charCodeAt(i + 1) === 0x5d) {
        // OSC: ESC ] … BEL or ST (ESC \)
        i = skipOscPayload(value, i + 2);
      } else {
        // CSI / other ESC sequences: skip until final byte 0x40–0x7e
        i += code === 0x1b ? 2 : 1;
        while (i < value.length) {
          const t = value.charCodeAt(i);
          i += 1;
          if (t >= 0x40 && t <= 0x7e) break;
        }
      }
      continue;
    }
    if (code === 0x9d) {
      // Raw C1 OSC: skip payload through BEL or ST (C1 0x9c / ESC \)
      i = skipOscPayload(value, i + 1);
      continue;
    }
    // C0 (except TAB handled as whitespace later), DEL, remaining C1
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
      if (code === 0x09 || code === 0x0a || code === 0x0d) {
        result += " ";
      }
      i += 1;
      continue;
    }
    result += value[i];
    i += 1;
  }
  return result;
}

/** Advances past an OSC payload starting at `start`, returning the next index. */
function skipOscPayload(value: string, start: number): number {
  let i = start;
  while (i < value.length && value.charCodeAt(i) !== 0x07) {
    if (value.charCodeAt(i) === 0x9c) {
      return i + 1;
    }
    if (value.charCodeAt(i) === 0x1b && value.charCodeAt(i + 1) === 0x5c) {
      return i + 2;
    }
    i += 1;
  }
  if (i < value.length && value.charCodeAt(i) === 0x07) return i + 1;
  return i;
}

function stableErrorDetail(
  operation: ChildCompactError["operation"],
  _cause: unknown,
): string {
  // Never echo raw exception text — it may contain paths or secrets.
  void _cause;
  switch (operation) {
    case "map":
      return "map_failed";
    case "reduce":
      return "reduce_failed";
    default:
      return "compact_failed";
  }
}

function isMeaningfulText(value: string): boolean {
  return sanitizeChildCompactText(value).length > 0;
}

// ---------------------------------------------------------------------------
// Map parser-approved session events → reducer inputs
// ---------------------------------------------------------------------------

/**
 * Maps one parser-approved `PiChildSessionEvent` into zero or one reducer
 * inputs. Settlement is never derived here — only Task 8 `settle` input.
 */
export function mapPiChildSessionEventToCompactInput(
  event: PiChildSessionEvent,
  itemId = "assistant",
): NeverthrowResult<ChildCompactReducerInput | undefined, ChildCompactError> {
  return Result.fromThrowable(
    (): ChildCompactReducerInput | undefined => {
      switch (event.type) {
        case "message_start":
          return {
            kind: "assistant_fragment",
            itemId,
            dedupKey: `${itemId}:start`,
            text: "",
            mode: "replace",
          };
        case "message_update": {
          const preview = extractAssistantTextDeltaPreview(
            event as unknown as Record<string, JsonValue>,
          );
          if (preview !== undefined) {
            const dedupKey = `${itemId}:frag:${stableFragmentKey(preview)}`;
            return {
              kind: "assistant_fragment",
              itemId,
              dedupKey,
              text: preview,
              mode: "append",
            };
          }
          // Thinking deltas inside message_update — record, never activity.
          return { kind: "thinking", itemId: `${itemId}:thinking` };
        }
        case "message_end": {
          const text = extractAssistantEndText(event.message);
          const usage = extractUsageFacts(event);
          return {
            kind: "assistant_end",
            itemId,
            ...(text !== undefined ? { text } : {}),
            ...(usage !== undefined ? { usage } : {}),
          };
        }
        case "text":
        case "markdown": {
          const text = typeof event.text === "string" ? event.text : "";
          if (!isMeaningfulText(text)) return undefined;
          return {
            kind: "assistant_fragment",
            itemId,
            dedupKey: `${itemId}:text:${stableFragmentKey(text)}`,
            text,
            mode: "replace",
          };
        }
        case "thinking": {
          const summary =
            typeof event.text === "string"
              ? sanitizeChildCompactText(event.text)
              : "";
          return {
            kind: "thinking",
            itemId: `${itemId}:thinking`,
            ...(summary.length > 0 ? { summary } : {}),
          };
        }
        case "tool_call":
        case "tool_partial_result":
        case "tool_result":
        case "tool_error": {
          const toolId =
            typeof event.toolCallId === "string" && event.toolCallId.length > 0
              ? boundOpaqueId(event.toolCallId)
              : `${itemId}:tool`;
          const toolName = sanitizeChildCompactText(readToolName(event) ?? "");
          const detail = extractToolDetailText(event);
          return {
            kind: "tool",
            itemId: toolId,
            phase: TOOL_PHASE_BY_EVENT[event.type],
            ...(toolName.length > 0 ? { toolName } : {}),
            ...(detail !== undefined ? { detail } : {}),
          };
        }
        case "usage": {
          const usage = extractUsageFacts(event);
          return {
            kind: "usage",
            itemId: `${itemId}:control:usage`,
            usage: usage ?? {},
          };
        }
        case "queue_change": {
          const size = boundedCount(event.size, CHILD_COMPACT_MAX_QUEUE_SIZE);
          return {
            kind: "queue",
            itemId: `${itemId}:control:queue_change`,
            ...(size !== undefined ? { size } : {}),
          };
        }
        case "status": {
          const status =
            typeof event.status === "string"
              ? sanitizeChildCompactText(event.status)
              : "";
          const message =
            typeof event.message === "string"
              ? sanitizeChildCompactText(event.message)
              : "";
          return {
            kind: "status",
            itemId: `${itemId}:control:status`,
            ...(status.length > 0 ? { status } : {}),
            ...(message.length > 0 ? { message } : {}),
          };
        }
        case "retry": {
          const attempt = boundedCount(
            event.attempt,
            CHILD_COMPACT_MAX_ATTEMPT,
          );
          const reason =
            typeof event.reason === "string"
              ? sanitizeChildCompactText(event.reason)
              : "";
          return {
            kind: "retry",
            itemId: `${itemId}:control:retry`,
            ...(attempt !== undefined ? { attempt } : {}),
            ...(reason.length > 0 ? { reason } : {}),
          };
        }
        case "extension_ui_request":
        case "extension_ui_response":
        case "image":
        case "unknown":
          return { kind: "control", itemId: `${itemId}:control:${event.type}` };
        default:
          return undefined;
      }
    },
    (cause) => ({
      type: "ChildCompactFailed" as const,
      operation: "map" as const,
      detail: stableErrorDetail("map", cause),
    }),
  )();
}

/** Pi names a tool on `toolName`; some hosts still send `name`. */
function readToolName(event: PiChildSessionEvent): string | undefined {
  const record = event as unknown as Record<string, unknown>;
  const named = record["toolName"];
  if (typeof named === "string") return named;
  const legacy = record["name"];
  return typeof legacy === "string" ? legacy : undefined;
}

const TOOL_PHASE_BY_EVENT: Readonly<Record<string, ChildCompactToolPhase>> =
  Object.freeze({
    tool_call: "call",
    tool_partial_result: "partial",
    tool_result: "result",
    tool_error: "error",
  });

/** Non-negative integers only, capped. Anything else is absent, never zero. */
function boundedCount(value: unknown, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    return undefined;
  if (value < 0 || value > max) return undefined;
  return value;
}

/** Non-negative finite money figures only, capped. */
function boundedCost(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > CHILD_COMPACT_MAX_COST) return undefined;
  return value;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The host's own reported total spend for this run, when it reported one.
 *
 * Cost is money, not tokens, so it is read only from the exact places pi-ai
 * puts it (`usage.cost.total`, on the standalone event or on the terminal
 * assistant message) and never derived from token counts.
 */
function extractUsageCost(event: PiChildSessionEvent): number | undefined {
  const record = event as unknown as Record<string, unknown>;
  const carriers = [
    plainRecord(record["usage"]),
    plainRecord(plainRecord(record["message"])?.["usage"]),
  ];
  for (const carrier of carriers) {
    if (carrier === undefined) continue;
    const nested = plainRecord(carrier["usage"]) ?? carrier;
    const cost = plainRecord(nested["cost"]) ?? plainRecord(carrier["cost"]);
    const total = boundedCost(cost?.["total"]);
    if (total !== undefined) return total;
  }
  return undefined;
}

/**
 * Bounded usage facts from a parser-approved `usage` or `message_end` event.
 *
 * Token and model facts come from the shared narrow in `child-session-events`;
 * only the money figure is read here, so there is still exactly one token
 * projection in the adapter.
 */
function extractUsageFacts(
  event: PiChildSessionEvent,
): ChildCompactUsageFacts | undefined {
  const parsed = parsePiChildUsageReport(event);
  const report = parsed.isOk() ? parsed.value : undefined;
  const costUsd = extractUsageCost(event);
  const facts: ChildCompactUsageFacts = {
    ...(report?.totalTokens !== undefined
      ? { totalTokens: report.totalTokens }
      : {}),
    ...(report?.inputTokens !== undefined
      ? { inputTokens: report.inputTokens }
      : {}),
    ...(report?.outputTokens !== undefined
      ? { outputTokens: report.outputTokens }
      : {}),
    ...(report?.contextTokens !== undefined
      ? { contextTokens: report.contextTokens }
      : {}),
    ...(report?.contextWindow !== undefined
      ? { contextWindow: report.contextWindow }
      : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(report?.model !== undefined ? { model: report.model } : {}),
  };
  return Object.keys(facts).length > 0 ? facts : undefined;
}

/**
 * Safe, bounded detail text a tool event carried, in the child's own words.
 *
 * Only string-shaped fields and `text` content blocks are read; a structured
 * payload contributes nothing rather than being stringified into the card.
 */
function extractToolDetailText(event: PiChildSessionEvent): string | undefined {
  const record = event as unknown as Record<string, unknown>;
  for (const key of [
    "error",
    "message",
    "result",
    "partialResult",
    "content",
  ]) {
    const text = readDetailValue(record[key]);
    if (text !== undefined) return text;
  }
  return undefined;
}

function readDetailValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const clean = sanitizeChildCompactText(value);
    return clean.length > 0 ? clean : undefined;
  }
  if (Array.isArray(value)) {
    let text = "";
    for (const block of value.slice(0, 16)) {
      const record = plainRecord(block);
      if (record?.["type"] === "text" && typeof record["text"] === "string") {
        text += `${record["text"]} `;
      }
    }
    const clean = sanitizeChildCompactText(text);
    return clean.length > 0 ? clean : undefined;
  }
  const record = plainRecord(value);
  if (record === undefined) return undefined;
  for (const key of ["text", "message", "summary", "output"]) {
    const nested = record[key];
    if (typeof nested === "string") {
      const clean = sanitizeChildCompactText(nested);
      if (clean.length > 0) return clean;
    }
  }
  return undefined;
}

function extractAssistantEndText(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null || Array.isArray(message))
    return undefined;
  const record = message as Record<string, unknown>;
  if (record.role !== "assistant") return undefined;
  const content = record.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  let text = "";
  for (const block of content) {
    if (typeof block !== "object" || block === null || Array.isArray(block))
      continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") text += b.text;
  }
  return text.length > 0 ? text : undefined;
}

function stableFragmentKey(text: string): string {
  const clean = sanitizeChildCompactText(text);
  if (clean.length <= 64) return clean;
  return `${clean.slice(0, 32)}…${clean.slice(-16)}:${clean.length}`;
}

// ---------------------------------------------------------------------------
// Reduce
// ---------------------------------------------------------------------------

export function reduceChildCompact(
  state: ChildCompactState,
  input: ChildCompactReducerInput,
): NeverthrowResult<ChildCompactState, ChildCompactError> {
  return Result.fromThrowable(
    () => reduceChildCompactUnchecked(state, input),
    (cause) => ({
      type: "ChildCompactFailed" as const,
      operation: "reduce" as const,
      detail: stableErrorDetail("reduce", cause),
    }),
  )();
}

/**
 * Safe reduce: invalid or failing input leaves state unchanged (never throws).
 */
export function reduceChildCompactSafe(
  state: ChildCompactState,
  input: unknown,
): ChildCompactState {
  const parsed = parseReducerInput(input);
  if (parsed.isErr()) return state;
  return reduceChildCompact(state, parsed.value).unwrapOr(state);
}

function reduceChildCompactUnchecked(
  state: ChildCompactState,
  input: ChildCompactReducerInput,
): ChildCompactState {
  switch (input.kind) {
    case "start_run":
      return reduceStartRun(state, input);
    case "assistant_fragment":
      return reduceAssistantFragment(state, input);
    case "assistant_end":
      return reduceAssistantEnd(state, input);
    case "thinking":
      return reduceSideItem(state, input.itemId, "thinking");
    case "tool":
      return reduceSideItem(state, input.itemId, "tool");
    // Operational inputs carry card facts; the compact block records them as
    // one control item each, exactly as it always did.
    case "usage":
    case "queue":
    case "status":
    case "retry":
    case "control":
      return reduceSideItem(state, input.itemId, "control");
    case "settle":
      return reduceSettle(state, input.settlement);
    default: {
      const _exhaustive: never = input;
      return _exhaustive;
    }
  }
}

function reduceStartRun(
  state: ChildCompactState,
  input: Extract<ChildCompactReducerInput, { kind: "start_run" }>,
): ChildCompactState {
  const threadId = boundOpaqueId(input.threadId);
  const agentName = sanitizeChildCompactText(input.agentName) || "delegate";
  const runNumber = Number.isSafeInteger(input.runNumber)
    ? Math.max(1, Math.floor(input.runNumber))
    : 1;
  const action = input.action;

  const frozenRuns = state.runs.map((run) =>
    run.frozen ? run : { ...run, frozen: true },
  );

  const existing = frozenRuns.find((run) => run.runNumber === runNumber);
  if (existing !== undefined) {
    return {
      threadId,
      runs: frozenRuns,
      currentRunNumber: runNumber,
    };
  }

  const nextRun: ChildCompactRunBlock = {
    runNumber,
    action,
    agentName,
    status: "running",
    items: [],
    itemIds: [],
    dedupKeys: new Set<string>(),
    latestMeaningfulFragment: undefined,
    finalResponse: undefined,
    errorSummary: undefined,
    frozen: false,
  };

  const runs = [...frozenRuns, nextRun].slice(-CHILD_COMPACT_MAX_RUNS);
  return { threadId, runs, currentRunNumber: runNumber };
}

function reduceAssistantFragment(
  state: ChildCompactState,
  input: Extract<ChildCompactReducerInput, { kind: "assistant_fragment" }>,
): ChildCompactState {
  const current = currentMutableRun(state);
  if (current === undefined) return state;

  const dedupKey = boundOpaqueId(input.dedupKey);
  if (current.dedupKeys.has(dedupKey)) return state;

  const mode = input.mode ?? "append";
  const incoming = sanitizeChildCompactText(input.text);
  const itemId = boundOpaqueId(input.itemId);
  const existing = current.items.find((item) => item.id === itemId);

  let nextText: string;
  if (existing === undefined) {
    nextText = incoming;
  } else if (mode === "replace") {
    nextText = incoming;
  } else {
    nextText = sanitizeChildCompactText(`${existing.text} ${incoming}`.trim());
  }

  const meaningful = nextText.length > 0 ? nextText : undefined;
  const nextItem: ChildCompactItem = {
    id: itemId,
    kind: existing?.isPlaceholder ? "assistant" : "assistant",
    text: nextText,
    isPlaceholder: false,
    ended: existing?.ended ?? false,
  };

  const items = upsertItem(current.items, nextItem);
  const itemIds = mergeItemIds(current.itemIds, itemId);
  const dedupKeys = extendDedupKeys(current.dedupKeys, dedupKey);

  return replaceCurrentRun(state, {
    ...current,
    items,
    itemIds,
    dedupKeys,
    latestMeaningfulFragment:
      meaningful !== undefined ? meaningful : current.latestMeaningfulFragment,
  });
}

function reduceAssistantEnd(
  state: ChildCompactState,
  input: Extract<ChildCompactReducerInput, { kind: "assistant_end" }>,
): ChildCompactState {
  const current = currentMutableRun(state);
  if (current === undefined) return state;

  const itemId = boundOpaqueId(input.itemId);
  const existing = current.items.find((item) => item.id === itemId);
  const endText =
    input.text !== undefined ? sanitizeChildCompactText(input.text) : "";

  if (existing === undefined) {
    // Out-of-order end-before-start: placeholder slot, optionally filled.
    const placeholder: ChildCompactItem = {
      id: itemId,
      kind: endText.length > 0 ? "assistant" : "placeholder",
      text: endText,
      isPlaceholder: true,
      ended: true,
    };
    const meaningful =
      endText.length > 0 ? endText : current.latestMeaningfulFragment;
    return replaceCurrentRun(state, {
      ...current,
      items: upsertItem(current.items, placeholder),
      itemIds: mergeItemIds(current.itemIds, itemId),
      latestMeaningfulFragment: meaningful,
    });
  }

  const text =
    endText.length > 0 ? endText : sanitizeChildCompactText(existing.text);
  const nextItem: ChildCompactItem = {
    id: itemId,
    kind: "assistant",
    text,
    isPlaceholder: false,
    ended: true,
  };
  return replaceCurrentRun(state, {
    ...current,
    items: upsertItem(current.items, nextItem),
    latestMeaningfulFragment:
      text.length > 0 ? text : current.latestMeaningfulFragment,
  });
}

function reduceSideItem(
  state: ChildCompactState,
  itemId: string,
  kind: "thinking" | "tool" | "control",
): ChildCompactState {
  const current = currentMutableRun(state);
  if (current === undefined) return state;
  const id = boundOpaqueId(itemId);
  const existing = current.items.find((item) => item.id === id);
  if (existing !== undefined) return state;
  const item: ChildCompactItem = {
    id,
    kind,
    text: "",
    isPlaceholder: false,
    ended: true,
  };
  // Recorded for overlay/parity, never selected as final activity.
  return replaceCurrentRun(state, {
    ...current,
    items: upsertItem(current.items, item),
    itemIds: mergeItemIds(current.itemIds, id),
  });
}

function reduceSettle(
  state: ChildCompactState,
  settlement: PiChildSettlement,
): ChildCompactState {
  const current = currentMutableRun(state);
  if (current === undefined) return state;

  if (settlement.outcome === "completed") {
    // Task 8 / §10: only authoritative assistantOutput — never completionCandidate.
    const finalResponse = sanitizeChildCompactText(
      settlement.assistantOutput ?? "",
    );
    return replaceCurrentRun(state, {
      ...current,
      status: "completed",
      finalResponse: finalResponse.length > 0 ? finalResponse : undefined,
      errorSummary: undefined,
      frozen: true,
    });
  }

  if (settlement.outcome === "failed") {
    const errorSummary =
      sanitizeChildCompactText(settlement.reason) || "failed";
    return replaceCurrentRun(state, {
      ...current,
      status: "failed",
      finalResponse: undefined,
      errorSummary,
      frozen: true,
    });
  }

  return replaceCurrentRun(state, {
    ...current,
    status: "cancelled",
    finalResponse: undefined,
    errorSummary: "cancelled",
    frozen: true,
  });
}

// ---------------------------------------------------------------------------
// Leakage guard
// ---------------------------------------------------------------------------

/**
 * Chrome text must never echo the opaque thread id, a session path, or a native
 * id carried in reducer state. Assistant activity text is caller content and is
 * never scanned here.
 *
 * Returns `false` when the chrome leaks; callers degrade rather than paint.
 */
export function childCompactChromeIsClean(
  chrome: string,
  state: ChildCompactState,
): boolean {
  if (state.threadId.length === 0) return true;
  return !chrome.includes(state.threadId);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function parseReducerInput(
  value: unknown,
): NeverthrowResult<ChildCompactReducerInput, ChildCompactError> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err({
      type: "ChildCompactFailed",
      operation: "reduce",
      detail: "invalid_input",
    });
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== "string") {
    return err({
      type: "ChildCompactFailed",
      operation: "reduce",
      detail: "invalid_input",
    });
  }

  switch (kind) {
    case "start_run": {
      if (
        typeof record.threadId !== "string" ||
        typeof record.runNumber !== "number" ||
        typeof record.agentName !== "string" ||
        (record.action !== "start" &&
          record.action !== "retry" &&
          record.action !== "continue")
      ) {
        return err({
          type: "ChildCompactFailed",
          operation: "reduce",
          detail: "invalid_start_run",
        });
      }
      return ok({
        kind: "start_run",
        threadId: record.threadId,
        runNumber: record.runNumber,
        action: record.action,
        agentName: record.agentName,
      });
    }
    case "assistant_fragment": {
      if (
        typeof record.itemId !== "string" ||
        typeof record.dedupKey !== "string" ||
        typeof record.text !== "string"
      ) {
        return err({
          type: "ChildCompactFailed",
          operation: "reduce",
          detail: "invalid_assistant_fragment",
        });
      }
      const mode =
        record.mode === "replace" || record.mode === "append"
          ? record.mode
          : undefined;
      return ok({
        kind: "assistant_fragment",
        itemId: record.itemId,
        dedupKey: record.dedupKey,
        text: record.text,
        ...(mode !== undefined ? { mode } : {}),
      });
    }
    case "assistant_end": {
      if (typeof record.itemId !== "string") {
        return err({
          type: "ChildCompactFailed",
          operation: "reduce",
          detail: "invalid_assistant_end",
        });
      }
      const usage = parseUsageFacts(record.usage);
      return ok({
        kind: "assistant_end",
        itemId: record.itemId,
        ...(typeof record.text === "string" ? { text: record.text } : {}),
        ...(usage !== undefined ? { usage } : {}),
      });
    }
    case "thinking": {
      if (typeof record.itemId !== "string") {
        return err({
          type: "ChildCompactFailed",
          operation: "reduce",
          detail: "invalid_thinking",
        });
      }
      return ok({
        kind: "thinking",
        itemId: record.itemId,
        ...(typeof record.summary === "string"
          ? { summary: record.summary }
          : {}),
      });
    }
    case "tool": {
      if (typeof record.itemId !== "string") {
        return err({
          type: "ChildCompactFailed",
          operation: "reduce",
          detail: "invalid_tool",
        });
      }
      const phase =
        record.phase === "call" ||
        record.phase === "partial" ||
        record.phase === "result" ||
        record.phase === "error"
          ? record.phase
          : undefined;
      return ok({
        kind: "tool",
        itemId: record.itemId,
        ...(phase !== undefined ? { phase } : {}),
        ...(typeof record.toolName === "string"
          ? { toolName: record.toolName }
          : {}),
        ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
      });
    }
    case "usage": {
      if (typeof record.itemId !== "string") {
        return err({
          type: "ChildCompactFailed",
          operation: "reduce",
          detail: "invalid_usage",
        });
      }
      return ok({
        kind: "usage",
        itemId: record.itemId,
        usage: parseUsageFacts(record.usage) ?? {},
      });
    }
    case "queue": {
      if (typeof record.itemId !== "string") {
        return err({
          type: "ChildCompactFailed",
          operation: "reduce",
          detail: "invalid_queue",
        });
      }
      const size = boundedCount(record.size, CHILD_COMPACT_MAX_QUEUE_SIZE);
      return ok({
        kind: "queue",
        itemId: record.itemId,
        ...(size !== undefined ? { size } : {}),
      });
    }
    case "status": {
      if (typeof record.itemId !== "string") {
        return err({
          type: "ChildCompactFailed",
          operation: "reduce",
          detail: "invalid_status",
        });
      }
      return ok({
        kind: "status",
        itemId: record.itemId,
        ...(typeof record.status === "string" ? { status: record.status } : {}),
        ...(typeof record.message === "string"
          ? { message: record.message }
          : {}),
      });
    }
    case "retry": {
      if (typeof record.itemId !== "string") {
        return err({
          type: "ChildCompactFailed",
          operation: "reduce",
          detail: "invalid_retry",
        });
      }
      const attempt = boundedCount(record.attempt, CHILD_COMPACT_MAX_ATTEMPT);
      return ok({
        kind: "retry",
        itemId: record.itemId,
        ...(attempt !== undefined ? { attempt } : {}),
        ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
      });
    }
    case "control": {
      if (typeof record.itemId !== "string") {
        return err({
          type: "ChildCompactFailed",
          operation: "reduce",
          detail: "invalid_control",
        });
      }
      return ok({ kind: "control", itemId: record.itemId });
    }
    case "settle": {
      const settlement = parseSettlement(record.settlement);
      if (settlement === undefined) {
        return err({
          type: "ChildCompactFailed",
          operation: "reduce",
          detail: "invalid_settlement",
        });
      }
      const failureClass = isChildErrorClass(record.failureClass)
        ? record.failureClass
        : undefined;
      return ok({
        kind: "settle",
        settlement,
        ...(failureClass !== undefined ? { failureClass } : {}),
      });
    }
    default:
      return err({
        type: "ChildCompactFailed",
        operation: "reduce",
        detail: "unknown_kind",
      });
  }
}

function isChildErrorClass(value: unknown): value is PiChildErrorClass {
  return (
    typeof value === "string" &&
    (PI_CHILD_ERROR_CLASSES as readonly string[]).includes(value)
  );
}

/** Field-wise parse: every malformed or out-of-bounds figure is simply absent. */
function parseUsageFacts(value: unknown): ChildCompactUsageFacts | undefined {
  const record = plainRecord(value);
  if (record === undefined) return undefined;
  const facts: ChildCompactUsageFacts = {
    ...tokenField(record, "totalTokens"),
    ...tokenField(record, "inputTokens"),
    ...tokenField(record, "outputTokens"),
    ...tokenField(record, "contextTokens"),
    ...tokenField(record, "contextWindow"),
    ...(boundedCost(record["costUsd"]) !== undefined
      ? { costUsd: boundedCost(record["costUsd"]) }
      : {}),
    ...(typeof record["model"] === "string" &&
    sanitizeChildCompactText(record["model"]).length > 0
      ? { model: sanitizeChildCompactText(record["model"]) }
      : {}),
  };
  return Object.keys(facts).length > 0 ? facts : undefined;
}

function tokenField(
  record: Record<string, unknown>,
  key: keyof ChildCompactUsageFacts,
): Partial<ChildCompactUsageFacts> {
  const count = boundedCount(record[key], Number.MAX_SAFE_INTEGER);
  return count === undefined ? {} : { [key]: count };
}

function parseSettlement(value: unknown): PiChildSettlement | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.outcome === "completed") {
    return {
      outcome: "completed",
      ...(typeof record.assistantOutput === "string"
        ? { assistantOutput: record.assistantOutput }
        : {}),
      ...(typeof record.completionCandidate === "string"
        ? { completionCandidate: record.completionCandidate }
        : {}),
    };
  }
  if (record.outcome === "failed" && typeof record.reason === "string") {
    return { outcome: "failed", reason: record.reason };
  }
  if (record.outcome === "cancelled") {
    return { outcome: "cancelled" };
  }
  return undefined;
}

/** Structural guard for state that crossed an untyped boundary. */
export function isChildCompactState(
  value: unknown,
): value is ChildCompactState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.threadId === "string" && Array.isArray(record.runs);
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function boundOpaqueId(value: string): string {
  if (value.length <= 256) return value;
  return value.slice(0, 256);
}

function currentRun(
  state: ChildCompactState,
): ChildCompactRunBlock | undefined {
  if (state.currentRunNumber === undefined) return undefined;
  return state.runs.find((run) => run.runNumber === state.currentRunNumber);
}

function currentMutableRun(
  state: ChildCompactState,
): ChildCompactRunBlock | undefined {
  const run = currentRun(state);
  if (run === undefined || run.frozen) return undefined;
  return run;
}

function replaceCurrentRun(
  state: ChildCompactState,
  next: ChildCompactRunBlock,
): ChildCompactState {
  return {
    ...state,
    runs: state.runs.map((run) =>
      run.runNumber === next.runNumber ? next : run,
    ),
  };
}

function upsertItem(
  items: readonly ChildCompactItem[],
  item: ChildCompactItem,
): readonly ChildCompactItem[] {
  const index = items.findIndex((entry) => entry.id === item.id);
  if (index === -1) {
    return [...items, item].slice(-CHILD_COMPACT_MAX_ITEMS);
  }
  const next = [...items];
  next[index] = item;
  return next;
}

function mergeItemIds(
  ids: readonly string[],
  itemId: string,
): readonly string[] {
  if (ids.includes(itemId)) return ids;
  return [...ids, itemId].slice(-CHILD_COMPACT_MAX_ITEMS);
}

function extendDedupKeys(
  keys: ReadonlySet<string>,
  next: string,
): ReadonlySet<string> {
  if (keys.has(next)) return keys;
  const extended = new Set(keys);
  extended.add(next);
  if (extended.size <= CHILD_COMPACT_MAX_DEDUP_KEYS) return extended;
  // Drop oldest insertion order when over cap.
  const trimmed = [...extended].slice(-CHILD_COMPACT_MAX_DEDUP_KEYS);
  return new Set(trimmed);
}

/**
 * Bounds an opaque correlation id (message id, tool call id, dedup key) to the
 * exact length the reducer retains. Shared with the card projection so both
 * surfaces correlate the same event under the same key.
 */
export function boundChildCompactId(value: string): string {
  return boundOpaqueId(value);
}
