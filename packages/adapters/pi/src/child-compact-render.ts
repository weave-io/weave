/**
 * Compact `weave_delegate` block reducer and renderer (Pi adapter contract §6).
 *
 * Pure, adapter-owned core for Task 11. Maps parser-approved child event data
 * into a bounded reducer input union without importing UI types. Output is three
 * sanitized strings (plus an optional expanded current item) for later wiring
 * through Pi theme / native components.
 *
 * Never throws on expected paths: invalid reduce/render input yields a typed
 * degraded three-line block.
 */
import { err, ok, Result, type Result as NeverthrowResult } from "neverthrow";
import {
  MAX_CHILD_EVENT_STRING,
  type PiChildSessionEvent,
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

/** Collapsed activity line code-point budget (matches delegation-tool preview). */
export const CHILD_COMPACT_COLLAPSED_CODE_POINTS = 240;
/** Expanded current-item code-point budget. */
export const CHILD_COMPACT_EXPANDED_CODE_POINTS = 4_096;
/** Maximum run blocks retained per logical thread in reducer state. */
export const CHILD_COMPACT_MAX_RUNS = 64;
/** Maximum tracked items per run block. */
export const CHILD_COMPACT_MAX_ITEMS = 128;
/** Maximum dedup keys retained per run. */
export const CHILD_COMPACT_MAX_DEDUP_KEYS = 256;

const COLLAPSED_LINE_COUNT = 3;
const DEGRADED_LINES = [
  "weave_delegate",
  "render unavailable",
  "",
] as const satisfies readonly [string, string, string];

// ---------------------------------------------------------------------------
// Errors / degraded
// ---------------------------------------------------------------------------

export type ChildCompactError = {
  readonly type: "ChildCompactFailed";
  readonly operation: "reduce" | "render" | "map";
  readonly detail: string;
};

export type ChildCompactDegradedReason =
  | "invalid_input"
  | "reduce_failed"
  | "render_failed";

// ---------------------------------------------------------------------------
// Reducer input (adapter-owned; maps parser-approved session events)
// ---------------------------------------------------------------------------

export type ChildCompactRunAction = "start" | "retry" | "continue";

export type ChildCompactRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

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
    }
  | {
      readonly kind: "thinking";
      readonly itemId: string;
    }
  | {
      readonly kind: "tool";
      readonly itemId: string;
    }
  | {
      readonly kind: "control";
      readonly itemId: string;
    }
  | {
      readonly kind: "settle";
      /** Authoritative Task 8 / §10 settlement only. */
      readonly settlement: PiChildSettlement;
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

export interface ChildCompactRenderOutput {
  /** Exactly three collapsed lines for every state. */
  readonly lines: readonly [string, string, string];
  /** Bounded expanded text for the current activity item, when present. */
  readonly expandedCurrentItem: string | undefined;
  readonly degraded: boolean;
  readonly degradedReason?: ChildCompactDegradedReason;
}

export interface ChildCompactRenderOptions {
  readonly expanded?: boolean;
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

export function degradedChildCompactRender(
  reason: ChildCompactDegradedReason = "render_failed",
): ChildCompactRenderOutput {
  return {
    lines: DEGRADED_LINES,
    expandedCurrentItem: undefined,
    degraded: true,
    degradedReason: reason,
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
    case "render":
      return "render_failed";
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
          return {
            kind: "assistant_end",
            itemId,
            ...(text !== undefined ? { text } : {}),
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
        case "thinking":
          return { kind: "thinking", itemId: `${itemId}:thinking` };
        case "tool_call":
        case "tool_partial_result":
        case "tool_result":
        case "tool_error": {
          const toolId =
            typeof event.toolCallId === "string" && event.toolCallId.length > 0
              ? boundOpaqueId(event.toolCallId)
              : `${itemId}:tool`;
          return { kind: "tool", itemId: toolId };
        }
        case "usage":
        case "queue_change":
        case "status":
        case "retry":
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
      meaningful !== undefined
        ? meaningful
        : current.latestMeaningfulFragment,
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
// Render
// ---------------------------------------------------------------------------

export function renderChildCompact(
  state: ChildCompactState,
  options: ChildCompactRenderOptions = {},
): NeverthrowResult<ChildCompactRenderOutput, ChildCompactError> {
  return Result.fromThrowable(
    () => renderChildCompactUnchecked(state, options),
    (cause) => ({
      type: "ChildCompactFailed" as const,
      operation: "render" as const,
      detail: stableErrorDetail("render", cause),
    }),
  )();
}

/**
 * Always returns exactly three sanitized lines. Invalid state / render failures
 * become a typed degraded block (never throws).
 */
export function renderChildCompactSafe(
  state: unknown,
  options: ChildCompactRenderOptions = {},
): ChildCompactRenderOutput {
  if (!isChildCompactState(state)) {
    return degradedChildCompactRender("invalid_input");
  }
  return renderChildCompact(state, options).match(
    (output) => output,
    () => degradedChildCompactRender("render_failed"),
  );
}

/**
 * Reduce then render with full isolation: never throws; failures degrade.
 */
export function projectChildCompact(
  state: ChildCompactState,
  input: unknown,
  options: ChildCompactRenderOptions = {},
): ChildCompactRenderOutput {
  const parsed = parseReducerInput(input);
  if (parsed.isErr()) return degradedChildCompactRender("invalid_input");
  const reduced = reduceChildCompact(state, parsed.value);
  if (reduced.isErr()) return degradedChildCompactRender("reduce_failed");
  return renderChildCompactSafe(reduced.value, options);
}

function renderChildCompactUnchecked(
  state: ChildCompactState,
  options: ChildCompactRenderOptions,
): ChildCompactRenderOutput {
  const run = currentRun(state);
  const agent = run?.agentName ?? "delegate";
  const status = run?.status ?? "running";
  const runNumber = run?.runNumber ?? 1;
  const action = run?.action ?? "start";

  const activity = selectActivityText(run);
  const collapsedActivity = collapseActivity(activity);

  const line1 = sanitizeChildCompactText(
    `weave_delegate · ${agent} · ${status}`,
  );
  const line2 = collapsedActivity;
  const line3 = sanitizeChildCompactText(`run ${runNumber} · ${action}`);

  const lines: [string, string, string] = [
    line1 || "weave_delegate",
    line2,
    line3 || `run ${runNumber}`,
  ];

  const expandedCurrentItem = options.expanded
    ? boundExpanded(activity)
    : undefined;

  assertNoLeakage(lines, expandedCurrentItem, state);

  return {
    lines,
    expandedCurrentItem,
    degraded: false,
  };
}

function selectActivityText(
  run: ChildCompactRunBlock | undefined,
): string | undefined {
  if (run === undefined) return undefined;
  if (run.status === "completed") {
    return run.finalResponse;
  }
  if (run.status === "failed" || run.status === "cancelled") {
    return run.errorSummary;
  }
  // Running: latest meaningful assistant fragment only — never thinking/tool.
  return run.latestMeaningfulFragment;
}

function collapseActivity(text: string | undefined): string {
  if (text === undefined || text.length === 0) return "…";
  const clean = sanitizeChildCompactText(text);
  if (clean.length === 0) return "…";
  const codePoints = [...clean];
  if (codePoints.length <= CHILD_COMPACT_COLLAPSED_CODE_POINTS) return clean;
  return `…${codePoints
    .slice(-(CHILD_COMPACT_COLLAPSED_CODE_POINTS - 1))
    .join("")}`;
}

function boundExpanded(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const clean = sanitizeChildCompactText(text);
  if (clean.length === 0) return undefined;
  const codePoints = [...clean];
  if (codePoints.length <= CHILD_COMPACT_EXPANDED_CODE_POINTS) return clean;
  return `${codePoints.slice(0, CHILD_COMPACT_EXPANDED_CODE_POINTS - 1).join("")}…`;
}

/**
 * Chrome lines must never echo opaque thread ids, session paths, or native ids
 * from state metadata. Assistant activity text is caller content and is not
 * scanned here.
 */
function assertNoLeakage(
  lines: readonly [string, string, string],
  expanded: string | undefined,
  state: ChildCompactState,
): void {
  const chrome = `${lines[0]}\n${lines[2]}`;
  if (state.threadId.length > 0 && chrome.includes(state.threadId)) {
    throw new Error("thread_id_leakage");
  }
  void expanded;
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
      return ok({
        kind: "assistant_end",
        itemId: record.itemId,
        ...(typeof record.text === "string" ? { text: record.text } : {}),
      });
    }
    case "thinking":
    case "tool":
    case "control": {
      if (typeof record.itemId !== "string") {
        return err({
          type: "ChildCompactFailed",
          operation: "reduce",
          detail: `invalid_${kind}`,
        });
      }
      return ok({ kind, itemId: record.itemId });
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
      return ok({ kind: "settle", settlement });
    }
    default:
      return err({
        type: "ChildCompactFailed",
        operation: "reduce",
        detail: "unknown_kind",
      });
  }
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

function isChildCompactState(value: unknown): value is ChildCompactState {
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

function currentRun(state: ChildCompactState): ChildCompactRunBlock | undefined {
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

/** Exact collapsed line count invariant helper for tests and callers. */
export function childCompactLineCount(
  output: ChildCompactRenderOutput,
): number {
  return output.lines.length === COLLAPSED_LINE_COUNT
    ? COLLAPSED_LINE_COUNT
    : output.lines.length;
}

// ---------------------------------------------------------------------------
// Projection helper (owns state; correlates IDs; safe render boundary)
// ---------------------------------------------------------------------------

export interface PiChildCompactProjectionConfig {
  readonly threadId: string;
  readonly agentName: string;
}

export interface PiChildCompactStartRunInput {
  readonly runNumber: number;
  readonly action: ChildCompactRunAction;
  readonly agentName?: string;
}

/**
 * Stateful helper over the pure compact reducer/renderer. Correlates stable
 * message IDs across message_start/update/end, uses toolCallId for tools,
 * maps parser-approved events, starts runs, and settles only from Task 8.
 * Every public method is fail-closed to a degraded 3-line block.
 */
export class PiChildCompactProjection {
  private state: ChildCompactState;
  private readonly defaultAgentName: string;
  private activeMessageId: string | undefined;
  private messageSeq = 0;

  constructor(config: PiChildCompactProjectionConfig) {
    this.state = createChildCompactState(config.threadId);
    this.defaultAgentName =
      sanitizeChildCompactText(config.agentName) || "delegate";
  }

  /** Frozen snapshot of reducer state (never mutates through the return). */
  getState(): ChildCompactState {
    return this.state;
  }

  startRun(input: PiChildCompactStartRunInput): ChildCompactRenderOutput {
    const agentName =
      input.agentName !== undefined
        ? sanitizeChildCompactText(input.agentName) || this.defaultAgentName
        : this.defaultAgentName;
    const next = reduceChildCompactSafe(this.state, {
      kind: "start_run",
      threadId: this.state.threadId,
      runNumber: input.runNumber,
      action: input.action,
      agentName,
    });
    this.state = next;
    this.activeMessageId = undefined;
    return renderChildCompactSafe(this.state);
  }

  /**
   * Maps one parser-approved session event into reducer input using stable
   * per-message / per-tool ids, then renders. Never throws.
   */
  applySessionEvent(event: PiChildSessionEvent): ChildCompactRenderOutput {
    const itemId = this.correlateItemId(event);
    const mapped = mapPiChildSessionEventToCompactInput(event, itemId);
    if (mapped.isErr()) return degradedChildCompactRender("reduce_failed");
    const input = mapped.value;
    if (input === undefined) return renderChildCompactSafe(this.state);
    this.state = reduceChildCompactSafe(this.state, input);
    return renderChildCompactSafe(this.state);
  }

  /** Applies authoritative Task 8 settlement only. Never throws. */
  settle(settlement: PiChildSettlement): ChildCompactRenderOutput {
    this.state = reduceChildCompactSafe(this.state, {
      kind: "settle",
      settlement,
    });
    this.activeMessageId = undefined;
    return renderChildCompactSafe(this.state);
  }

  render(options: ChildCompactRenderOptions = {}): ChildCompactRenderOutput {
    return renderChildCompactSafe(this.state, options);
  }

  private correlateItemId(event: PiChildSessionEvent): string {
    switch (event.type) {
      case "message_start": {
        const id =
          messageIdFromUnknown(event.message) ?? this.allocateMessageId();
        this.activeMessageId = id;
        return id;
      }
      case "message_update": {
        const fromEvent = messageIdFromMessageUpdate(event);
        const id =
          fromEvent ?? this.activeMessageId ?? this.allocateMessageId();
        this.activeMessageId = id;
        return id;
      }
      case "message_end": {
        const id =
          messageIdFromUnknown(event.message) ??
          this.activeMessageId ??
          this.allocateMessageId();
        this.activeMessageId = id;
        return id;
      }
      case "tool_call":
      case "tool_partial_result":
      case "tool_result":
      case "tool_error": {
        if (
          typeof event.toolCallId === "string" &&
          event.toolCallId.length > 0
        ) {
          return boundOpaqueId(event.toolCallId);
        }
        return boundOpaqueId(`tool:${this.allocateMessageId()}`);
      }
      case "text":
      case "markdown":
        return this.activeMessageId ?? this.allocateMessageId();
      case "thinking":
        return `${this.activeMessageId ?? "assistant"}:thinking`;
      default:
        return this.activeMessageId ?? "assistant";
    }
  }

  private allocateMessageId(): string {
    this.messageSeq += 1;
    return `msg-${this.messageSeq}`;
  }
}

function messageIdFromUnknown(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.messageId === "string" && record.messageId.length > 0) {
    return boundOpaqueId(record.messageId);
  }
  if (typeof record.id === "string" && record.id.length > 0) {
    return boundOpaqueId(record.id);
  }
  return undefined;
}

function messageIdFromMessageUpdate(
  event: PiChildSessionEvent,
): string | undefined {
  if (event.type !== "message_update") return undefined;
  const record = event as unknown as Record<string, unknown>;
  return (
    messageIdFromUnknown(record.delta) ??
    messageIdFromUnknown(record.assistantMessageEvent)
  );
}
