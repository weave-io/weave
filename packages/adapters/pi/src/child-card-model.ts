/**
 * Delegation card fact model (Pi adapter contract §6, UI design record §1).
 *
 * A pure, bounded view model for the inline `weave_delegate` card. It answers
 * five questions and nothing else: who is running, what they were asked to do,
 * the single most meaningful thing they have produced, what it has cost, and —
 * only once an authoritative settlement says so — how it ended.
 *
 * Honesty rules this module makes structural rather than remembered:
 *
 * - **Settlement is the only completion authority.** {@link PiDelegationCardFacts.terminal}
 *   is `undefined` unless a `settle` input arrived *and* that settlement named
 *   text. A `message_end` can therefore never produce a settled card, a `✓`
 *   glyph, or a completion claim, however many assistant messages end.
 * - **Recovery is named only where the failure class documents one.** The gate
 *   is {@link CARD_RECOVERABLE_FAILURE_CLASSES}; an unclassified failure gets no
 *   advice at all.
 * - **Unknowns are absent, never zero.** Elapsed, tokens, cost, and the model
 *   are omitted rather than guessed, so the renderer prints `—`.
 * - **Usage is latest-authoritative, never summed.** Each report replaces the
 *   previous one, matching the rule `child-overlay-telemetry.ts` applies.
 * - **Reasoning is a bounded summary.** Raw chain-of-thought is never retained.
 * - **Elapsed comes from the injected clock at event time**, never from render
 *   time, so a re-render cannot make a settled child look older.
 *
 * Sanitizing lives in exactly one place: `child-compact-render.ts`'s
 * {@link sanitizeChildCompactText}. This module bounds and formats already
 * sanitized text; it opens no second sanitizer.
 *
 * Never throws on an expected path: malformed input returns a typed
 * {@link PiDelegationCardError} and leaves the prior facts untouched.
 */
import { err, ok, type Result } from "neverthrow";
import { appendAssistantStreamDelta } from "./assistant-stream-text.js";
import {
  boundChildCompactId,
  CHILD_COMPACT_MAX_DEDUP_KEYS,
  type ChildCompactReducerInput,
  type ChildCompactRunAction,
  type ChildCompactUsageFacts,
  mapPiChildSessionEventToCompactInput,
  parseReducerInput,
  sanitizeChildCompactText,
} from "./child-compact-render.js";
import type { PiModelTransitionBody } from "./child-control-bodies.js";
import {
  type PiChildErrorClass,
  type PiChildProviderError,
  type PiChildProviderErrorDescriptor,
  parsePiChildProviderError,
} from "./child-provider-error.js";
import { formatPiChildProviderError } from "./child-provider-error-render.js";
import type { PiChildSessionEvent } from "./child-session-events.js";
import {
  modelFailoverRecordFromTransition,
  type PiModelFailoverIdentity,
  type PiModelFailoverRecord,
} from "./model-failover-record.js";
import type { PiChildSettlement } from "./rpc-child.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Payload version of {@link PiDelegationCardFacts}. Bumped on any shape change. */
export const CARD_FACTS_SCHEMA_VERSION = 2;

/** The tool the card always names. Settlement never rewrites it. */
export const CARD_TOOL_NAME = "weave_delegate";

/** Retained viewport rows. The window is a bottom slice of these. */
export const CARD_VIEWPORT_RING_ROWS = 64;

/** The window height the expanded card always spends (prototype `VIEWPORT_ROWS`). */
export const CARD_VIEWPORT_ROWS = 9;

/** Code-point budget of every viewport row's `text`, and of activity prose. */
export const CARD_ROW_TEXT_MAX = 240;
/** Code-point budget of a viewport row's `head` label. */
export const CARD_ROW_HEAD_MAX = 48;
/** Code-point budget of the assignment sentence. */
export const CARD_ASSIGNMENT_MAX = 240;
/** Code-point budget of the child agent name. */
export const CARD_AGENT_NAME_MAX = 64;
/** Code-point budget of the model label. */
export const CARD_MODEL_MAX = 128;
/** Code-point budget of the status word and the lifecycle phase. */
export const CARD_STATUS_MAX = 24;
export const CARD_PHASE_MAX = 48;
/** Code-point budget of one formatted telemetry figure. */
export const CARD_TELEMETRY_MAX = 24;
/** Code-point budget of terminal headline, evidence, and recovery sentences. */
export const CARD_TERMINAL_TEXT_MAX = 240;
/** Largest run number the card will print. */
export const CARD_MAX_RUN_NUMBER = 1_000_000;

/**
 * The failure classes with a documented recovery. This list is the ONLY gate on
 * a recovery sentence: a class outside it structurally cannot be given advice.
 */
export const CARD_RECOVERABLE_FAILURE_CLASSES = [
  "rate-limit",
  "timeout",
  "overload",
  "connection",
] as const satisfies readonly PiChildErrorClass[];

const RECOVERABLE = new Set<string>(CARD_RECOVERABLE_FAILURE_CLASSES);

/**
 * The cancellation record, in the adapter's own safe words. A cancellation
 * settlement carries no child text, so the card states what it knows — who
 * stopped it, that partial work was kept, and that nothing was verified — and
 * claims nothing else.
 */
export const CARD_CANCELLED_RECORD =
  "stopped by the parent · partial work kept · nothing verified";

/** What a completed card may say when the child reported no tool terminal. */
export const CARD_NO_TOOL_EVIDENCE = "no tool evidence recorded";

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/** The tone the rail and the glyph are painted in. */
export type PiCardTone = "run" | "ok" | "warn" | "bad" | "mute";

/**
 * Native Line activity vocabulary (prototype `ACTIVITY_GLYPH`).
 *
 * `say` is a child message still being written, or one that ended with no
 * authoritative settlement behind it. `reply` — the `✓` row — is reserved for
 * the settlement-named output, so a collapsed row can never imply an answer the
 * settlement has not published.
 */
export type PiCardActivityKind =
  | "sent"
  | "boot"
  | "think"
  | "tool"
  | "queue"
  | "say"
  | "reply"
  | "error"
  | "cancel"
  | "fallback";

/** One retained transcript row, as the viewport prints it. */
export interface PiCardViewportRow {
  readonly kind: PiCardRowKind;
  /** Short label: the tool name, the role, or the event class. */
  readonly head: string;
  readonly text: string;
}

export type PiCardRowKind =
  | "boot"
  | "msg"
  | "think"
  | "tool"
  | "result"
  | "queue"
  | "retry"
  | "error"
  /**
   * Historical only. The reducer produces no settled row — a settlement adds
   * nothing to the viewport (§1.13) — but a card persisted by an earlier
   * version replays its `details` payload through the same strict parser, and
   * a kind the parser refuses would discard that reader's whole card.
   */
  | "settled";

/** The safe, derived vocabulary of ONE authoritative outcome. */
export interface PiCardTerminalFacts {
  readonly outcome: "completed" | "failed" | "cancelled";
  /** `COMPLETED` · `FAILED` · `CANCELLED`. Upper case means authoritative. */
  readonly verdict: string;
  readonly glyph: string;
  /** The authoritative sentence the settlement published. */
  readonly headline: string;
  /** What backs the verdict: tool evidence, failure class, or the initiator. */
  readonly evidence: string;
  /** Documented recovery, and only where the failure class justifies one. */
  readonly recovery?: string;
}

/**
 * The complete view model of one delegation card. Every string is already
 * sanitized and bounded; every unknown is absent.
 */
export interface PiCardAppliedIdentity {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
}

export interface PiDelegationCardFacts {
  readonly schemaVersion: number;
  readonly tool: string;
  readonly agentName: string;
  /** @deprecated Configured intent is not an applied fact and is never projected. */
  readonly model?: string;
  readonly appliedIdentity?: PiCardAppliedIdentity;
  readonly fallback?: PiModelFailoverRecord;
  readonly run: {
    readonly number: number;
    readonly action: ChildCompactRunAction;
    readonly phase: string;
    /** The attempt a `retry` event named, when it named one. Never guessed. */
    readonly attempt?: number;
  };
  readonly status: string;
  readonly tone: PiCardTone;
  readonly settled: boolean;
  readonly assignment: string;
  readonly activity: {
    readonly kind: PiCardActivityKind;
    readonly text: string;
    /** True while the row the line reports may still grow. */
    readonly live: boolean;
  };
  readonly telemetry: {
    readonly elapsed?: string;
    readonly tokens?: string;
    readonly cost?: string;
  };
  readonly viewport: {
    /** At most {@link CARD_VIEWPORT_ROWS}, taken as a literal bottom slice. */
    readonly rows: readonly PiCardViewportRow[];
    /** Exact count of produced rows the window does not show. */
    readonly above: number;
    /** Invariant: `above + rows.length === producedRows`. */
    readonly atBottom: boolean;
  };
  readonly terminal?: PiCardTerminalFacts;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type PiDelegationCardError = {
  readonly type: "PiDelegationCardFailed";
  readonly operation: "apply" | "map";
  readonly detail: string;
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Injected clock. Elapsed is read from it at event time, never at render time. */
export type PiCardClock = () => number;

interface PiCardRingRow extends PiCardViewportRow {
  /** Correlates growth in place; never projected into the facts. */
  readonly id: string;
}

interface PiCardActivityState {
  readonly kind: PiCardActivityKind;
  readonly text: string;
  readonly live: boolean;
}

/**
 * Opaque, immutable card state. Only {@link projectDelegationCardFacts} reads
 * it, so the retained internals — row ids, the raw settlement, the clock
 * stamps — cannot reach a renderer.
 */
export interface PiDelegationCardState {
  readonly agentName: string;
  /** Configured intent is retained only for construction compatibility. */
  readonly model: string | undefined;
  readonly appliedIdentity: PiCardAppliedIdentity | undefined;
  readonly fallback: PiModelFailoverRecord | undefined;
  readonly assignment: string;
  readonly runNumber: number;
  readonly runAction: ChildCompactRunAction;
  readonly runAttempt: number | undefined;
  readonly phase: string;
  readonly startedAtMs: number | undefined;
  readonly elapsedMs: number | undefined;
  readonly activity: PiCardActivityState | undefined;
  readonly openMessageId: string | undefined;
  /**
   * The exact ordered concatenation of the deltas streamed into the message
   * still being written, bounded.
   *
   * A delta is a fragment of a word as often as it is a word, so the card
   * accumulates RAW and sanitizes the projection once. Sanitizing each
   * fragment on arrival and joining the results with a space turned
   * `["hel", "lo"]` into `hel lo` — an answer the child never gave, and one
   * the inspector, which concatenated, disagreed with.
   *
   * It is held here rather than derived from the row because the row ring is
   * bounded: a long tool-heavy run can evict a message row that is still
   * being written, and the answer must not restart when it does.
   */
  readonly openMessageStream:
    | { readonly itemId: string; readonly raw: string }
    | undefined;
  readonly usage: ChildCompactUsageFacts | undefined;
  readonly toolCalls: ReadonlyMap<string, string>;
  readonly lastToolEvidence:
    | { readonly call: string; readonly term: string }
    | undefined;
  readonly rows: readonly PiCardRingRow[];
  readonly producedRows: number;
  readonly settlement: PiChildSettlement | undefined;
  readonly failureClass: PiChildErrorClass | undefined;
}

export interface PiDelegationCardConfig {
  readonly agentName: string;
  /** One imperative sentence in the parent's own words. */
  readonly assignment: string;
  readonly model?: string;
  readonly runNumber?: number;
  readonly action?: ChildCompactRunAction;
}

export function createDelegationCardState(
  config: PiDelegationCardConfig,
): PiDelegationCardState {
  return {
    agentName: boundName(config.agentName),
    model: boundOptional(config.model, CARD_MODEL_MAX),
    appliedIdentity: undefined,
    fallback: undefined,
    assignment: boundText(
      sanitizeChildCompactText(config.assignment),
      CARD_ASSIGNMENT_MAX,
    ),
    runNumber: boundRunNumber(config.runNumber ?? 1),
    runAction: config.action ?? "start",
    runAttempt: undefined,
    phase: "bootstrap",
    startedAtMs: undefined,
    elapsedMs: undefined,
    activity: undefined,
    openMessageId: undefined,
    openMessageStream: undefined,
    usage: undefined,
    toolCalls: new Map<string, string>(),
    lastToolEvidence: undefined,
    rows: [],
    producedRows: 0,
    settlement: undefined,
    failureClass: undefined,
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Fold one reducer input into the card state at `now()`.
 *
 * Malformed input is an expected path: it returns a typed error and the caller
 * keeps the state it already had. Nothing here throws.
 */
export function applyDelegationCardInput(
  state: PiDelegationCardState,
  input: unknown,
  now: PiCardClock,
): Result<PiDelegationCardState, PiDelegationCardError> {
  const parsed = parseReducerInput(input);
  if (parsed.isErr()) {
    return err({
      type: "PiDelegationCardFailed",
      operation: "apply",
      detail: parsed.error.detail,
    });
  }
  const stamp = readClock(now);
  if (stamp === undefined) {
    return err({
      type: "PiDelegationCardFailed",
      operation: "apply",
      detail: "invalid_clock",
    });
  }
  return ok(applyParsed(state, parsed.value, stamp));
}

/**
 * Map one parser-approved child event through the shared compact mapper, then
 * fold it in. The mapper is the only event→input path, so the card and the
 * compact block can never disagree about what an event meant.
 */
export function applyDelegationCardEvent(
  state: PiDelegationCardState,
  event: PiChildSessionEvent,
  now: PiCardClock,
  itemId = "assistant",
): Result<PiDelegationCardState, PiDelegationCardError> {
  const mapped = mapPiChildSessionEventToCompactInput(event, itemId);
  if (mapped.isErr()) {
    return err({
      type: "PiDelegationCardFailed",
      operation: "map",
      detail: mapped.error.detail,
    });
  }
  if (mapped.value === undefined) return ok(state);
  return applyDelegationCardInput(state, mapped.value, now);
}

function applyParsed(
  state: PiDelegationCardState,
  input: ChildCompactReducerInput,
  atMs: number,
): PiDelegationCardState {
  const timed = withClock(state, atMs);
  switch (input.kind) {
    case "start_run":
      return applyStartRun(timed, input, atMs);
    case "assistant_fragment":
      return applyAssistantFragment(timed, input);
    case "assistant_end":
      return applyAssistantEnd(timed, input);
    case "thinking":
      return applyThinking(timed, input);
    case "reasoning_summary":
      return applyReasoningSummary(timed, input);
    case "tool":
      return applyTool(timed, input);
    case "usage":
      return { ...timed, usage: mergeUsage(timed.usage, input.usage) };
    case "queue":
      return applyQueue(timed, input);
    case "status":
      return applyStatus(timed, input);
    case "retry":
      return applyRetry(timed, input);
    case "control":
      // Images, extension UI traffic, and unknown host kinds are not visible
      // transcript events: they move no row, glyph, or word on the card.
      return timed;
    case "settle":
      return applySettle(timed, input);
    default: {
      const exhaustive: never = input;
      return exhaustive;
    }
  }
}

function applyStartRun(
  state: PiDelegationCardState,
  input: Extract<ChildCompactReducerInput, { kind: "start_run" }>,
  atMs: number,
): PiDelegationCardState {
  const agentName = boundName(sanitizeChildCompactText(input.agentName));
  return {
    ...state,
    agentName: agentName.length > 0 ? agentName : state.agentName,
    runNumber: boundRunNumber(input.runNumber),
    runAction: input.action,
    runAttempt: undefined,
    phase: "bootstrap",
    startedAtMs: atMs,
    elapsedMs: 0,
    // A new run writes no message yet: the previous run's partial answer is
    // not the start of this one.
    openMessageId: undefined,
    openMessageStream: undefined,
  };
}

function applyAssistantFragment(
  state: PiDelegationCardState,
  input: Extract<ChildCompactReducerInput, { kind: "assistant_fragment" }>,
): PiDelegationCardState {
  const rowId = `msg:${input.itemId}`;
  const mode = input.mode ?? "append";
  // The raw accumulation is keyed by the MESSAGE, not by the row: a `replace`
  // frame and a different message both start a new answer, everything else
  // extends the one in flight.
  const carried =
    mode === "replace" || state.openMessageStream?.itemId !== input.itemId
      ? ""
      : state.openMessageStream.raw;
  const raw = appendAssistantStreamDelta(carried, input.text);
  const text = boundText(sanitizeChildCompactText(raw), CARD_ROW_TEXT_MAX);

  // A message head with no body yet is not an answer: it reports that the child
  // is writing, and the live marker says the row may still grow.
  const activity: PiCardActivityState =
    text.length > 0
      ? { kind: "say", text, live: true }
      : { kind: "say", text: `${state.agentName} is writing`, live: true };

  const opened: PiDelegationCardState = {
    ...state,
    phase: "responding",
    openMessageId: input.itemId,
    openMessageStream: { itemId: input.itemId, raw },
    activity,
  };
  // A `message_start` OPENS a lifecycle; it is not something the child wrote.
  // Its fragment is empty by construction, and materializing it put a blank
  // `▌ shuttle` row in the expanded viewport — a row §1.12's literal bottom
  // slice must not invent, because nothing on the child's transcript
  // corresponds to it. The lifecycle still moves the Native Line (`is
  // writing`), and the row appears with the first text the child actually
  // wrote. An existing row is still rewritten, so a `replace` frame that
  // clears an answer is not silently ignored.
  if (text.length === 0 && !hasRow(state, rowId)) return opened;

  return pushRow(opened, {
    id: rowId,
    kind: "msg",
    head: state.agentName,
    text,
  });
}

function applyAssistantEnd(
  state: PiDelegationCardState,
  input: Extract<ChildCompactReducerInput, { kind: "assistant_end" }>,
): PiDelegationCardState {
  const rowId = `msg:${input.itemId}`;
  const existing = state.rows.find((row) => row.id === rowId);
  // The terminal message carries the whole answer, so it replaces the
  // accumulation. Without one, the streamed answer this card already holds is
  // the honest text — including when the row itself was evicted from the ring.
  const streamed =
    state.openMessageStream?.itemId === input.itemId
      ? sanitizeChildCompactText(state.openMessageStream.raw)
      : (existing?.text ?? "");
  const ended =
    input.text !== undefined
      ? sanitizeChildCompactText(appendAssistantStreamDelta("", input.text))
      : "";
  const text = boundText(
    ended.length > 0 ? ended : streamed,
    CARD_ROW_TEXT_MAX,
  );

  // An ended message is NOT a completion. It stays `say`, so `✓` remains
  // reserved for the settlement-named output.
  const activity: PiCardActivityState =
    text.length > 0
      ? { kind: "say", text, live: false }
      : { kind: "say", text: `${state.agentName} is writing`, live: false };

  const closed: PiDelegationCardState = {
    ...state,
    openMessageId: undefined,
    openMessageStream: undefined,
    usage: mergeUsage(state.usage, input.usage),
    activity,
  };
  // A message that ended having said nothing leaves no row behind either: the
  // viewport prints what the child wrote, and an empty message is not it.
  if (text.length === 0 && !hasRow(state, rowId)) return closed;

  return pushRow(closed, {
    id: rowId,
    kind: "msg",
    head: state.agentName,
    text,
  });
}

/**
 * The child reasoned, stated as a bare fact.
 *
 * NEVER SHOW RAW CHAIN-OF-THOUGHT. The input kind carries no text at all, so
 * the row, the model-visible activity line and the persisted card details all
 * hold the same content-free word. The card never claims to summarize what it
 * has not been given: see {@link applyReasoningSummary} for the one trusted
 * surface that may print prose.
 */
function applyThinking(
  state: PiDelegationCardState,
  input: Extract<ChildCompactReducerInput, { kind: "thinking" }>,
): PiDelegationCardState {
  const text = "reasoning";
  return {
    ...pushRow(state, {
      id: `think:${input.itemId}`,
      kind: "think",
      head: "thinking",
      text,
    }),
    phase: "reasoning",
    activity: { kind: "think", text, live: true },
  };
}

/**
 * An explicit host-published reasoning summary, and the only reasoning prose
 * the card will ever print. It is bounded and sanitized like every other
 * child-authored string.
 */
function applyReasoningSummary(
  state: PiDelegationCardState,
  input: Extract<ChildCompactReducerInput, { kind: "reasoning_summary" }>,
): PiDelegationCardState {
  const summary = boundText(
    sanitizeChildCompactText(input.summary),
    CARD_ROW_TEXT_MAX - "summary · ".length,
  );
  const text = `summary · ${summary.length > 0 ? summary : "…"}`;
  return {
    ...pushRow(state, {
      id: `think:${input.itemId}`,
      kind: "think",
      head: "thinking",
      text,
    }),
    phase: "reasoning",
    activity: { kind: "think", text, live: true },
  };
}

/**
 * Tool activity, reported as NAME PLUS CANONICAL STATE and nothing else.
 *
 * `input.detail` is child-authored tool payload prose: a command's stdout, a
 * file read, a raw provider error body, an exception message. The delegation
 * card is not a place that prose may reach. Its facts become the model-visible
 * activity line of every tool result AND the `details` payload Pi persists with
 * the transcript entry and replays in a later session, so a single tool result
 * carrying an absolute path, a credential, a signed URL, or a stack frame would
 * copy that value into the parent's own context and onto disk.
 *
 * The rule is structural omission, not redaction: no pattern matcher decides
 * what is safe here, because the payload is simply never read. The card states
 * which tool ran and whether it is running, done, or failed - facts the card
 * derives from the event TYPE. The rich child payload stays where it already
 * lives, in the child overlay and the child transcript, which the human opens
 * deliberately and which the parent model never reads.
 */
function applyTool(
  state: PiDelegationCardState,
  input: Extract<ChildCompactReducerInput, { kind: "tool" }>,
): PiDelegationCardState {
  const phase = input.phase ?? "call";
  const toolName = boundText(
    sanitizeChildCompactText(input.toolName ?? ""),
    CARD_ROW_HEAD_MAX,
  );
  const call =
    toolName.length > 0
      ? toolName
      : (state.toolCalls.get(input.itemId) ?? "tool");
  const toolCalls =
    toolName.length > 0 && state.toolCalls.get(input.itemId) !== toolName
      ? extendToolCalls(state.toolCalls, input.itemId, toolName)
      : state.toolCalls;

  if (phase === "call") {
    return {
      ...pushRow(state, {
        id: `tool:${input.itemId}`,
        kind: "tool",
        head: call,
        text: "",
      }),
      phase: "tool call",
      toolCalls,
      activity: { kind: "tool", text: call, live: true },
    };
  }

  // A RESULT IS REPORTED AS ITS CALL PLUS ITS CANONICAL STATE - never the
  // result payload itself.
  const term = phaseTerm(phase);
  const text = boundText(`${call} · ${term}`, CARD_ROW_TEXT_MAX);
  const failed = phase === "error";
  const withRow = pushRow(state, {
    id: `result:${input.itemId}`,
    kind: failed ? "error" : "result",
    head: call,
    text: term,
  });
  return {
    ...withRow,
    phase: "tool call",
    toolCalls,
    // Progress ticks keep a call open; a terminal closes it.
    lastToolEvidence:
      phase === "partial" ? state.lastToolEvidence : { call, term },
    activity: {
      kind: failed ? "error" : "tool",
      text,
      live: phase === "partial",
    },
  };
}

function applyQueue(
  state: PiDelegationCardState,
  input: Extract<ChildCompactReducerInput, { kind: "queue" }>,
): PiDelegationCardState {
  const size = input.size;
  const text =
    size === undefined
      ? "parent steered the child"
      : `${size} queued · parent steered the child`;
  return {
    ...pushRow(state, {
      id: `queue:${input.itemId}:${size ?? "n"}`,
      kind: "queue",
      head: "queue",
      text,
    }),
    phase: "steered",
    activity: { kind: "queue", text, live: false },
  };
}

function applyStatus(
  state: PiDelegationCardState,
  input: Extract<ChildCompactReducerInput, { kind: "status" }>,
): PiDelegationCardState {
  // A status report is a lifecycle fact, not a transcript row: it renames the
  // footer's phase and adds nothing to the viewport or the Native Line.
  const phase = boundText(
    sanitizeChildCompactText(input.status ?? input.message ?? ""),
    CARD_PHASE_MAX,
  );
  return phase.length > 0 ? { ...state, phase } : state;
}

function applyRetry(
  state: PiDelegationCardState,
  input: Extract<ChildCompactReducerInput, { kind: "retry" }>,
): PiDelegationCardState {
  const reason = boundText(
    sanitizeChildCompactText(input.reason ?? ""),
    CARD_ROW_TEXT_MAX,
  );
  const attempt = input.attempt;
  const parts = [
    attempt === undefined ? "retrying" : `retry ${attempt}`,
    ...(reason.length > 0 ? [reason] : []),
  ];
  const text = boundText(parts.join(" · "), CARD_ROW_TEXT_MAX);
  return {
    ...pushRow(state, {
      id: `retry:${input.itemId}:${attempt ?? "n"}`,
      kind: "retry",
      head: "retry",
      text,
    }),
    runAction: "retry",
    // The attempt the child itself named. An unnamed attempt stays absent
    // rather than becoming a fabricated `1`.
    runAttempt: attempt ?? state.runAttempt,
    phase: "bootstrap",
    activity: { kind: "boot", text, live: false },
  };
}

function applySettle(
  state: PiDelegationCardState,
  input: Extract<ChildCompactReducerInput, { kind: "settle" }>,
): PiDelegationCardState {
  // A settled run is settled once. A second settlement is a protocol duplicate
  // and never rewrites the authoritative one.
  if (state.settlement !== undefined) return state;
  const settled: PiDelegationCardState = {
    ...state,
    settlement: input.settlement,
    failureClass: input.failureClass,
    phase: "settled",
    openMessageId: undefined,
  };
  const terminal = deriveTerminal(settled);
  if (terminal === undefined) {
    return { ...settled, activity: freezeActivity(settled.activity) };
  }
  // NATIVE SETTLE (prototype item 10, §1.13). The settlement rewrites the rail
  // word, the Native Line and the footer verb, and ADDS NOTHING: no row, no
  // banner, no border verdict, no action deck. The expanded viewport is a
  // literal bottom slice of the child's own transcript (§1.12), so a
  // card-authored `✓ COMPLETED` row would be a line the child never wrote,
  // printed directly under the identical text the terminal message already
  // holds. `terminal` carries the same verdict to the footer, and the Native
  // Line states the headline once.
  return {
    ...settled,
    activity: {
      kind: terminalActivityKind(terminal.outcome),
      text: terminal.headline,
      live: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

/** The pure projection the renderer and the persisted details payload read. */
export function projectDelegationCardFacts(
  state: PiDelegationCardState,
): PiDelegationCardFacts {
  const terminal = deriveTerminal(state);
  const settled = state.settlement !== undefined;
  const rows = state.rows.slice(-CARD_VIEWPORT_ROWS).map(projectRow);
  const above = state.producedRows - rows.length;
  const activity = state.activity ?? {
    kind: "boot" as const,
    text: `${state.agentName} is starting`,
    live: true,
  };

  return {
    schemaVersion: CARD_FACTS_SCHEMA_VERSION,
    tool: CARD_TOOL_NAME,
    agentName: state.agentName,
    ...(state.appliedIdentity !== undefined
      ? { appliedIdentity: state.appliedIdentity }
      : {}),
    ...(state.fallback !== undefined ? { fallback: state.fallback } : {}),
    run: {
      number: state.runNumber,
      action: state.runAction,
      phase: boundText(state.phase, CARD_PHASE_MAX),
      ...(state.runAttempt !== undefined ? { attempt: state.runAttempt } : {}),
    },
    status: boundText(statusWord(state), CARD_STATUS_MAX),
    tone: toneOf(state),
    settled,
    assignment: state.assignment,
    activity: {
      kind: activity.kind,
      text: boundText(activity.text, CARD_ROW_TEXT_MAX),
      live: settled ? false : activity.live,
    },
    telemetry: projectTelemetry(state),
    viewport: {
      rows,
      above: Math.max(0, above),
      atBottom: Math.max(0, above) + rows.length === state.producedRows,
    },
    ...(terminal !== undefined ? { terminal } : {}),
  };
}

function projectRow(row: PiCardRingRow): PiCardViewportRow {
  return { kind: row.kind, head: row.head, text: row.text };
}

function cardAppliedIdentity(
  identity: PiModelFailoverIdentity,
): PiCardAppliedIdentity {
  return identity.name === undefined
    ? { provider: identity.provider, id: identity.id }
    : { provider: identity.provider, id: identity.id, name: identity.name };
}

function projectTelemetry(
  state: PiDelegationCardState,
): PiDelegationCardFacts["telemetry"] {
  const elapsed =
    state.elapsedMs === undefined ? undefined : formatElapsed(state.elapsedMs);
  const tokens = totalTokensOf(state.usage);
  const cost = state.usage?.costUsd;
  return {
    ...(elapsed !== undefined
      ? { elapsed: boundText(elapsed, CARD_TELEMETRY_MAX) }
      : {}),
    ...(tokens !== undefined
      ? { tokens: boundText(formatTokens(tokens), CARD_TELEMETRY_MAX) }
      : {}),
    ...(cost !== undefined
      ? { cost: boundText(formatCost(cost), CARD_TELEMETRY_MAX) }
      : {}),
  };
}

/**
 * THE ONE GATE. Terminal facts exist only when an authoritative settlement has
 * landed AND that settlement named text, so the settled card cannot be reached
 * one microstep early even if a renderer wanted it.
 */
function deriveTerminal(
  state: PiDelegationCardState,
): PiCardTerminalFacts | undefined {
  const settlement = state.settlement;
  if (settlement === undefined) return undefined;

  if (settlement.outcome === "completed") {
    // Only the authoritative assistant output — never a completion CANDIDATE.
    const headline = boundText(
      sanitizeChildCompactText(settlement.assistantOutput ?? ""),
      CARD_TERMINAL_TEXT_MAX,
    );
    if (headline.length === 0) return undefined;
    const evidence = state.lastToolEvidence;
    return {
      outcome: "completed",
      verdict: "COMPLETED",
      glyph: "✓",
      headline,
      evidence: boundText(
        `verified · ${
          evidence === undefined
            ? CARD_NO_TOOL_EVIDENCE
            : `${evidence.call} · ${evidence.term}`
        }`,
        CARD_TERMINAL_TEXT_MAX,
      ),
    };
  }

  if (settlement.outcome === "failed") {
    const headline = boundText(
      sanitizeChildCompactText(settlement.reason),
      CARD_TERMINAL_TEXT_MAX,
    );
    if (headline.length === 0) return undefined;
    const failureClass = state.failureClass;
    const recovery =
      failureClass !== undefined && RECOVERABLE.has(failureClass)
        ? boundText(
            `${failureClass} · re-delegation from the parent is the documented recovery`,
            CARD_TERMINAL_TEXT_MAX,
          )
        : undefined;
    return {
      outcome: "failed",
      verdict: "FAILED",
      glyph: "✕",
      headline,
      evidence: boundText(
        `${failureClass ?? "failure"} · child no longer running`,
        CARD_TERMINAL_TEXT_MAX,
      ),
      ...(recovery !== undefined ? { recovery } : {}),
    };
  }

  return {
    outcome: "cancelled",
    verdict: "CANCELLED",
    glyph: "⊘",
    headline: CARD_CANCELLED_RECORD,
    evidence: "stopped by the parent · nothing verified",
  };
}

function terminalActivityKind(
  outcome: PiCardTerminalFacts["outcome"],
): PiCardActivityKind {
  if (outcome === "completed") return "reply";
  if (outcome === "failed") return "error";
  return "cancel";
}

function statusWord(state: PiDelegationCardState): string {
  const settlement = state.settlement;
  if (settlement !== undefined) return settlement.outcome;
  if (state.startedAtMs === undefined) return "pending";
  if (state.activity === undefined) return "starting";
  return "running";
}

function toneOf(state: PiDelegationCardState): PiCardTone {
  const settlement = state.settlement;
  if (settlement?.outcome === "completed") return "ok";
  if (settlement?.outcome === "failed") return "bad";
  if (settlement?.outcome === "cancelled") return "mute";
  if (state.activity?.kind === "error") return "bad";
  if (state.activity?.kind === "queue" || state.activity?.kind === "fallback")
    return "warn";
  if (state.startedAtMs === undefined) return "mute";
  return "run";
}

function freezeActivity(
  activity: PiCardActivityState | undefined,
): PiCardActivityState | undefined {
  return activity === undefined ? undefined : { ...activity, live: false };
}

// ---------------------------------------------------------------------------
// Ring
// ---------------------------------------------------------------------------

/**
 * Append or grow one viewport row.
 *
 * A row that already exists grows IN PLACE and does not advance the produced
 * count; a new row advances it by exactly one and may evict the oldest retained
 * row. `producedRows` is therefore monotone, which is what keeps `above` exact
 * after eviction.
 */
function pushRow(
  state: PiDelegationCardState,
  row: PiCardRingRow,
): PiDelegationCardState {
  const bounded: PiCardRingRow = {
    id: row.id,
    kind: row.kind,
    head: boundText(row.head, CARD_ROW_HEAD_MAX),
    text: boundText(row.text, CARD_ROW_TEXT_MAX),
  };
  const index = state.rows.findIndex((entry) => entry.id === bounded.id);
  if (index !== -1) {
    const rows = [...state.rows];
    rows[index] = bounded;
    return { ...state, rows };
  }
  const rows = [...state.rows, bounded].slice(-CARD_VIEWPORT_RING_ROWS);
  return { ...state, rows, producedRows: state.producedRows + 1 };
}

/** True when the ring already holds a row under this id. */
function hasRow(state: PiDelegationCardState, id: string): boolean {
  return state.rows.some((row) => row.id === id);
}

function extendToolCalls(
  calls: ReadonlyMap<string, string>,
  itemId: string,
  toolName: string,
): ReadonlyMap<string, string> {
  const next = new Map(calls);
  next.set(itemId, toolName);
  if (next.size <= CARD_VIEWPORT_RING_ROWS) return next;
  return new Map([...next].slice(-CARD_VIEWPORT_RING_ROWS));
}

// ---------------------------------------------------------------------------
// Clock and telemetry helpers
// ---------------------------------------------------------------------------

function readClock(now: PiCardClock): number | undefined {
  const value = now();
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

/** Elapsed is stamped at EVENT time and frozen once the child has settled. */
function withClock(
  state: PiDelegationCardState,
  atMs: number,
): PiDelegationCardState {
  if (state.settlement !== undefined) return state;
  if (state.startedAtMs === undefined) return state;
  const elapsedMs = Math.max(0, atMs - state.startedAtMs);
  return { ...state, elapsedMs };
}

/**
 * LATEST AUTHORITATIVE, NEVER SUMMED. Each report replaces the fields it
 * carries; fields it does not carry keep the last figure the host reported.
 */
function mergeUsage(
  previous: ChildCompactUsageFacts | undefined,
  next: ChildCompactUsageFacts | undefined,
): ChildCompactUsageFacts | undefined {
  if (next === undefined || Object.keys(next).length === 0) return previous;
  if (previous === undefined) return next;
  return { ...previous, ...next };
}

function totalTokensOf(
  usage: ChildCompactUsageFacts | undefined,
): number | undefined {
  if (usage === undefined) return undefined;
  if (usage.totalTokens !== undefined) return usage.totalTokens;
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  if (input === undefined && output === undefined) return undefined;
  return (input ?? 0) + (output ?? 0);
}

function phaseTerm(phase: "partial" | "result" | "error"): string {
  if (phase === "error") return "failed";
  if (phase === "partial") return "running";
  return "done";
}

/** `0.4s` · `38s` · `4m 12s` · `1h 03m`. Never rounded up into a claim. */
export function formatElapsed(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (safe < 10_000) return `${(safe / 1000).toFixed(1)}s`;
  const seconds = Math.floor(safe / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${pad2(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${pad2(minutes % 60)}m`;
}

/** `840 tok` · `4.2k tok` · `1.3M tok`. */
export function formatTokens(count: number): string {
  const safe = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (safe < 1000) return `${safe} tok`;
  if (safe < 1_000_000) return `${trimZero(safe / 1000)}k tok`;
  return `${trimZero(safe / 1_000_000)}M tok`;
}

/** `$0.00`, always two decimals: money is reported, never estimated. */
export function formatCost(cost: number): string {
  const safe = Number.isFinite(cost) && cost > 0 ? cost : 0;
  return `$${safe.toFixed(2)}`;
}

function trimZero(value: number): string {
  const fixed = value.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

// ---------------------------------------------------------------------------
// Bounds helpers
// ---------------------------------------------------------------------------

/** Bounds to `max` CODE POINTS, marking the cut so nothing reads as complete. */
function boundText(value: string, max: number): string {
  const limit = Math.max(1, max);
  const points = [...value];
  if (points.length <= limit) return value;
  return `${points.slice(0, limit - 1).join("")}…`;
}

function boundOptional(
  value: string | undefined,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  const clean = boundText(sanitizeChildCompactText(value), max);
  return clean.length > 0 ? clean : undefined;
}

function boundName(value: string): string {
  const clean = boundText(sanitizeChildCompactText(value), CARD_AGENT_NAME_MAX);
  return clean.length > 0 ? clean : "delegate";
}

function boundRunNumber(value: number): number {
  if (!Number.isSafeInteger(value)) return 1;
  return Math.min(CARD_MAX_RUN_NUMBER, Math.max(1, value));
}

// ---------------------------------------------------------------------------
// Provider failure
// ---------------------------------------------------------------------------

/** The head the card prints on a sanitized provider-failure row. */
export const CARD_PROVIDER_ERROR_HEAD = "provider";
/** The lifecycle phase a sanitized provider failure names. */
export const CARD_PROVIDER_ERROR_PHASE = "provider error";

/**
 * Fold ONE sanitized provider failure into the card.
 *
 * The text is produced by `child-provider-error-render.ts`, which is the exact
 * formatter the child overlay prints, so the card and the overlay can never
 * report the same failure in two different vocabularies. No provider payload,
 * exception text, or raw message reaches this function: only the closed,
 * already-sanitized projection does.
 *
 * The class is retained as the run's failure class, so a later failed
 * settlement can name the documented recovery for it — and only for it.
 */
export function applyDelegationCardProviderError(
  state: PiDelegationCardState,
  error: PiChildProviderError,
  now: PiCardClock,
): Result<PiDelegationCardState, PiDelegationCardError> {
  const stamp = readClock(now);
  if (stamp === undefined) {
    return err({
      type: "PiDelegationCardFailed",
      operation: "apply",
      detail: "invalid_clock",
    });
  }
  // A settled run is a closed record: a late provider failure cannot rewrite it.
  if (state.settlement !== undefined) return ok(state);
  const text = boundText(
    sanitizeChildCompactText(formatPiChildProviderError(error)),
    CARD_ROW_TEXT_MAX,
  );
  const timed = withClock(state, stamp);
  return ok({
    ...pushRow(timed, {
      // Repeats of the same canonical failure grow in place rather than
      // stacking, so `producedRows` stays an honest count of distinct facts.
      id: `provider-error:${text}`,
      kind: "error",
      head: CARD_PROVIDER_ERROR_HEAD,
      text,
    }),
    phase: CARD_PROVIDER_ERROR_PHASE,
    failureClass: error.class,
    activity: { kind: "error", text, live: false },
  });
}

// ---------------------------------------------------------------------------
// Projection (owns state; correlates ids; dedups; freezes prior runs)
// ---------------------------------------------------------------------------

export interface PiChildCardProjectionConfig {
  /** Opaque logical thread id. Correlation only; the card never prints it. */
  readonly threadId: string;
  readonly agentName: string;
  /** One imperative sentence in the parent's own words. */
  readonly assignment: string;
  readonly model?: string;
  readonly runNumber?: number;
  readonly action?: ChildCompactRunAction;
  /** Injected clock. Elapsed is read at event time, never at render time. */
  readonly now?: PiCardClock;
  /** Controller-authenticated identity labels for provider failures, if any. */
  readonly providerErrorDescriptor?: PiChildProviderErrorDescriptor;
}

export interface PiChildCardStartRunInput {
  readonly runNumber: number;
  readonly action: ChildCompactRunAction;
  readonly agentName?: string;
  readonly assignment?: string;
}

/**
 * The single authoritative reducer behind one delegation card.
 *
 * It correlates stable message ids across `message_start`/`update`/`end`, uses
 * `toolCallId` for tools, suppresses a repeated frame only where the mapper
 * gave it an authoritative dedup key (never by matching text), routes sanitized
 * provider failures through the overlay's formatter, and settles only from an
 * authoritative settlement.
 *
 * Two freezes make the honesty structural rather than remembered:
 *
 * - **A settled run is frozen.** Late, duplicate, and out-of-order events after
 *   settlement — including a second settlement — change nothing.
 * - **A superseded run is frozen.** Starting run N+1 snapshots run N, and no
 *   later event can reach that snapshot.
 *
 * It owns no timers and publishes nothing: the caller decides when an update
 * leaves. Malformed input keeps the facts the card already had, so one bad
 * event can never blank a running card.
 */
export class PiChildCardProjection {
  private state: PiDelegationCardState;
  private readonly now: PiCardClock;
  private readonly threadId: string;
  private readonly config: PiChildCardProjectionConfig;
  private readonly frozenRuns = new Map<number, PiDelegationCardFacts>();
  private dedupKeys = new Set<string>();
  private activeMessageId: string | undefined;
  /**
   * True when {@link PiChildCardProjection.activeMessageId} was INVENTED here
   * because the host named no message.
   *
   * Pi 0.84 sends `message_start` and every `message_update` of an answer with
   * no id at all, and may name the message for the first time on
   * `message_end`. Treating that late name as a new lifecycle split one
   * message across two rows: the streamed row kept the partial answer while a
   * second row appeared with the terminal body.
   */
  private activeMessageIdInvented = false;
  private messageSeq = 0;
  private runNumber: number;
  private assignment: string;
  private agentName: string;
  private settled = false;
  /**
   * One authenticated switch has two phases with the same transition id:
   * `applied` updates the identity, then `recovery-confirmed` publishes the
   * durable visible fallback fact. Keep the phase, not only a flat id set, so
   * the second phase is admitted exactly once.
   */
  private modelTransitionPhases = new Map<
    string,
    PiModelTransitionBody["phase"]
  >();

  constructor(config: PiChildCardProjectionConfig) {
    this.config = config;
    this.now = config.now ?? (() => Date.now());
    this.threadId = boundChildCompactId(config.threadId);
    this.runNumber = config.runNumber ?? 1;
    this.assignment = config.assignment;
    this.agentName = config.agentName;
    this.state = createDelegationCardState({
      agentName: config.agentName,
      assignment: config.assignment,
      ...(config.model !== undefined ? { model: config.model } : {}),
      runNumber: this.runNumber,
      action: config.action ?? "start",
    });
    this.applyInput({
      kind: "start_run",
      threadId: this.threadId,
      runNumber: this.runNumber,
      action: config.action ?? "start",
      agentName: config.agentName,
    });
  }

  /** The opaque card state. Only the projection itself may fold it forward. */
  getState(): PiDelegationCardState {
    return this.state;
  }

  /** The frozen facts of a superseded run, for parity checks and tests. */
  frozenRunFacts(runNumber: number): PiDelegationCardFacts | undefined {
    return this.frozenRuns.get(runNumber);
  }

  /** True once an authoritative settlement has closed this run. */
  isSettled(): boolean {
    return this.settled;
  }

  /**
   * Opens a run. A run number at or below the current one is a late or
   * out-of-order report and changes nothing; a higher one freezes the run in
   * progress and opens a fresh card for the new one.
   */
  startRun(input: PiChildCardStartRunInput): PiDelegationCardFacts {
    if (input.runNumber <= this.runNumber) return this.facts();
    this.frozenRuns.set(this.runNumber, this.facts());
    this.runNumber = input.runNumber;
    this.agentName = input.agentName ?? this.agentName;
    this.assignment = input.assignment ?? this.assignment;
    this.dedupKeys = new Set<string>();
    this.modelTransitionPhases = new Map<
      string,
      PiModelTransitionBody["phase"]
    >();
    this.activeMessageId = undefined;
    this.activeMessageIdInvented = false;
    this.settled = false;
    const appliedIdentity = this.state.appliedIdentity;
    this.state = createDelegationCardState({
      agentName: this.agentName,
      assignment: this.assignment,
      ...(this.config.model !== undefined ? { model: this.config.model } : {}),
      runNumber: this.runNumber,
      action: input.action,
    });
    if (appliedIdentity !== undefined) {
      this.state = { ...this.state, appliedIdentity };
    }
    this.applyInput({
      kind: "start_run",
      threadId: this.threadId,
      runNumber: this.runNumber,
      action: input.action,
      agentName: this.agentName,
    });
    return this.facts();
  }

  /**
   * Folds one parser-approved session event in. A terminal assistant message
   * that reports a provider failure is routed through the same sanitized
   * projection the overlay prints.
   */
  applySessionEvent(event: PiChildSessionEvent): PiDelegationCardFacts {
    if (this.settled) return this.facts();
    const itemId = this.correlateItemId(event);
    const mapped = mapPiChildSessionEventToCompactInput(event, itemId);
    if (mapped.isErr() || mapped.value === undefined) {
      return this.applyEventProviderError(event);
    }
    const input = mapped.value;
    if (input.kind === "settle") return this.facts();
    // Only a fragment the mapper could identify authoritatively is eligible for
    // duplicate suppression. Streamed deltas carry no identity on the wire, so
    // they arrive unkeyed and are always applied: repeating a word is not
    // repeating a frame, and dropping the repeat printed an answer the child
    // never gave.
    if (input.kind === "assistant_fragment" && input.dedupKey !== undefined) {
      const dedupKey = boundChildCompactId(input.dedupKey);
      if (this.dedupKeys.has(dedupKey)) return this.facts();
      this.retainDedupKey(dedupKey);
    }
    this.applyInput(input);
    return this.applyEventProviderError(event);
  }

  /** Folds one already-sanitized provider failure in. */
  applyProviderError(error: PiChildProviderError): PiDelegationCardFacts {
    if (this.settled) return this.facts();
    applyDelegationCardProviderError(this.state, error, this.now).match(
      (next) => {
        this.state = next;
      },
      () => undefined,
    );
    return this.facts();
  }

  /**
   * Applies one authenticated model transition. The applied identity is one
   * immutable atom: provider, id, and optional name are replaced together.
   * Recovery confirmation rewrites the existing Native Line and never adds a
   * viewport row or any other card chrome.
   */
  applyModelTransition(
    transition: PiModelTransitionBody,
  ): PiDelegationCardFacts {
    if (this.settled) return this.facts();
    const priorPhase = this.modelTransitionPhases.get(transition.transitionId);
    if (
      priorPhase === "recovery-confirmed" ||
      (transition.phase === "applied" && priorPhase === "applied")
    ) {
      return this.facts();
    }
    const record = modelFailoverRecordFromTransition(transition);
    if (record.isErr()) return this.facts();
    const appliedIdentity = cardAppliedIdentity(transition.to);
    if (transition.phase === "applied") {
      this.modelTransitionPhases.set(transition.transitionId, "applied");
      this.state = { ...this.state, appliedIdentity };
      return this.facts();
    }
    if (priorPhase !== "applied" || record.value === undefined) {
      return this.facts();
    }
    this.modelTransitionPhases.set(
      transition.transitionId,
      "recovery-confirmed",
    );
    const destination = `${appliedIdentity.provider}/${appliedIdentity.id}`;
    this.state = {
      ...this.state,
      appliedIdentity,
      fallback: record.value,
      activity: {
        kind: "fallback",
        text: `model fallback · ${destination}`,
        live: false,
      },
    };
    return this.facts();
  }

  /**
   * Applies the ONE authoritative settlement. A repeated settlement is a
   * protocol duplicate: it is ignored and the first record stands.
   */
  settle(
    settlement: PiChildSettlement,
    failureClass?: PiChildErrorClass,
  ): PiDelegationCardFacts {
    if (this.settled) return this.facts();
    // A caller-named class wins; otherwise the class a sanitized provider
    // failure already established stands. Nothing invents one.
    const named = failureClass ?? this.state.failureClass;
    this.applyInput({
      kind: "settle",
      settlement,
      ...(named !== undefined ? { failureClass: named } : {}),
    });
    this.settled = true;
    this.activeMessageId = undefined;
    return this.facts();
  }

  facts(): PiDelegationCardFacts {
    return projectDelegationCardFacts(this.state);
  }

  private applyEventProviderError(
    event: PiChildSessionEvent,
  ): PiDelegationCardFacts {
    const projected = parsePiChildProviderError(
      event,
      this.config.providerErrorDescriptor,
    );
    if (projected.isErr()) return this.facts();
    return this.applyProviderError(projected.value);
  }

  private applyInput(input: unknown): void {
    applyDelegationCardInput(this.state, input, this.now).match(
      (next) => {
        this.state = next;
      },
      () => undefined,
    );
  }

  private retainDedupKey(key: string): void {
    this.dedupKeys.add(key);
    if (this.dedupKeys.size <= CHILD_COMPACT_MAX_DEDUP_KEYS) return;
    this.dedupKeys = new Set(
      [...this.dedupKeys].slice(-CHILD_COMPACT_MAX_DEDUP_KEYS),
    );
  }

  private correlateItemId(event: PiChildSessionEvent): string {
    switch (event.type) {
      case "message_start": {
        const named = messageIdFromUnknown(event.message);
        const id = named ?? this.allocateMessageId();
        this.activeMessageId = id;
        this.activeMessageIdInvented = named === undefined;
        return id;
      }
      case "message_update":
        return this.openLifecycleId(messageIdFromMessageUpdate(event));
      case "message_end":
        return this.openLifecycleId(messageIdFromUnknown(event.message));
      case "tool_call":
      case "tool_partial_result":
      case "tool_result":
      case "tool_error": {
        if (
          typeof event.toolCallId === "string" &&
          event.toolCallId.length > 0
        ) {
          return boundChildCompactId(event.toolCallId);
        }
        return boundChildCompactId(`tool:${this.allocateMessageId()}`);
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

  /**
   * The identity of the assistant lifecycle in flight, for an update or an end
   * frame.
   *
   * ONE lifecycle keeps ONE identity from `message_start` to `message_end`. A
   * host id that appears part-way through NAMES the message already in flight
   * whenever this projection had to invent that message's identity, so the
   * terminal body updates the row the deltas were written into instead of
   * opening a second one beside it. A host that named the start and then names
   * a DIFFERENT message is reporting a different message, and that id is
   * honoured.
   */
  private openLifecycleId(named: string | undefined): string {
    const active = this.activeMessageId;
    if (active === undefined) {
      const id = named ?? this.allocateMessageId();
      this.activeMessageId = id;
      this.activeMessageIdInvented = named === undefined;
      return id;
    }
    if (named === undefined || this.activeMessageIdInvented) return active;
    this.activeMessageId = named;
    this.activeMessageIdInvented = false;
    return named;
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
    return boundChildCompactId(record.messageId);
  }
  if (typeof record.id === "string" && record.id.length > 0) {
    return boundChildCompactId(record.id);
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
