/**
 * Delegation card fact model (Pi adapter contract §6, UI design record §1).
 *
 * A pure, bounded view model for the inline `weave_delegate` card. It answers
 * four questions and nothing else: who is running, what they were asked to do,
 * what the run has cost, and — only once an authoritative settlement says so —
 * how it ended. Child activity is a transient renderer concern, not a card
 * fact.
 *
 * Honesty rules this module makes structural rather than remembered:
 *
 * - **Settlement is the only completion authority.** {@link PiDelegationCardFacts.terminal}
 *   is `undefined` until a `settle` input arrives. A `message_end` can therefore
 *   never produce a settled card, a `✓` glyph, or a completion claim, however
 *   many assistant messages end.
 * - **Recovery is named only where the failure class documents one.** The gate
 *   is {@link CARD_RECOVERABLE_FAILURE_CLASSES}; an unclassified failure gets no
 *   advice at all.
 * - **Unknowns are absent, never zero.** Elapsed, tokens, cost, and the model
 *   are omitted rather than guessed, so the renderer prints `—`.
 * - **Usage is latest-authoritative, never summed.** Each report replaces the
 *   previous one, matching the rule `child-overlay-telemetry.ts` applies.
 * - **Reasoning is renderer-only.** A bounded raw-reasoning snapshot lives in
 *   process memory and never enters card facts, details, or model-visible text.
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
import { err, ok, Result } from "neverthrow";
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
import {
  type PiChildErrorClass,
  type PiChildProviderError,
  type PiChildProviderErrorDescriptor,
  parsePiChildProviderError,
} from "./child-provider-error.js";
import type { PiChildSessionEvent } from "./child-session-events.js";
import {
  type ChildUiEventDiagnosticsSink,
  recordChildUiEventFailure,
} from "./child-ui-event-diagnostics.js";
import type { PiChildSettlement } from "./rpc-child.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Payload version of {@link PiDelegationCardFacts}. Bumped on any shape change. */
export const CARD_FACTS_SCHEMA_VERSION = 1;

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
/** Fixed terminal framing; settled child output stays in the tool API only. */
export const CARD_COMPLETED_RECORD = "child completed";
export const CARD_FAILED_RECORD = "child failed";
export const CARD_SETTLEMENT_EVIDENCE = "authoritative settlement";

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/** The tone the rail and the glyph are painted in. */
export type PiCardTone = "run" | "ok" | "warn" | "bad" | "mute";

/**
 * Compatibility vocabulary for the content-free activity placeholder.
 *
 * New parent-card renders do not project a child activity kind or text. The
 * placeholder remains versioned so older details payloads parse safely.
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
  | "cancel";

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
export interface PiDelegationCardFacts {
  readonly schemaVersion: number;
  readonly tool: string;
  readonly agentName: string;
  readonly model?: string;
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
  readonly model: string | undefined;
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
   * Legacy message-stream fields are retained in the state shape for replay
   * compatibility. Task 5 never populates them, because assistant text belongs
   * to the child inspector and the authoritative settled tool result.
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
  _input: Extract<ChildCompactReducerInput, { kind: "assistant_fragment" }>,
): PiDelegationCardState {
  // Assistant text belongs to the authoritative settled tool result and the
  // child inspector, never to the parent card. Keep only lifecycle and usage
  // facts here; in particular, do not retain even a transient fragment in the
  // card state that is later serialized as details.
  return {
    ...state,
    phase: "responding",
    openMessageId: undefined,
    openMessageStream: undefined,
  };
}

function applyAssistantEnd(
  state: PiDelegationCardState,
  input: Extract<ChildCompactReducerInput, { kind: "assistant_end" }>,
): PiDelegationCardState {
  return {
    ...state,
    phase: "responding",
    openMessageId: undefined,
    openMessageStream: undefined,
    usage: mergeUsage(state.usage, input.usage),
  };
}

/** The child entered generic reasoning; its raw text uses the live projector. */
function applyThinking(
  state: PiDelegationCardState,
  _input: Extract<ChildCompactReducerInput, { kind: "thinking" }>,
): PiDelegationCardState {
  // Generic thinking prose has its own process-memory projector. The durable
  // card reducer keeps only the lifecycle phase; the renderer reads the
  // projector through its TUI invalidation seam.
  return { ...state, phase: "reasoning", activity: undefined };
}

/** A summary event changes lifecycle only; it is not parent-card activity. */
function applyReasoningSummary(
  state: PiDelegationCardState,
  _input: Extract<ChildCompactReducerInput, { kind: "reasoning_summary" }>,
): PiDelegationCardState {
  // A host summary is not the parent card's live activity source. Keep the
  // phase for footer telemetry, but never copy summary prose into facts.
  return { ...state, phase: "reasoning", activity: undefined };
}

/** Tool events change lifecycle only; names and payloads stay in the inspector. */
function applyTool(
  state: PiDelegationCardState,
  input: Extract<ChildCompactReducerInput, { kind: "tool" }>,
): PiDelegationCardState {
  // Tool names, states, arguments, and result payloads belong to the child
  // inspector. The parent card keeps only a closed lifecycle phase and never
  // stores a tool label that could reach details or a viewport row.
  return {
    ...state,
    phase: input.phase === "error" ? "tool error" : "tool call",
    activity: undefined,
    toolCalls: new Map<string, string>(),
    lastToolEvidence: undefined,
  };
}

function applyQueue(
  state: PiDelegationCardState,
  _input: Extract<ChildCompactReducerInput, { kind: "queue" }>,
): PiDelegationCardState {
  // Queue/intervention details are lifecycle facts, not parent-card child
  // activity. The exact intervention count remains authoritative in the final
  // tool result, outside this visual fact model.
  return { ...state, phase: "steered", activity: undefined };
}

function applyStatus(
  state: PiDelegationCardState,
  input: Extract<ChildCompactReducerInput, { kind: "status" }>,
): PiDelegationCardState {
  // A status report is a lifecycle fact, not a transcript row. Its status and
  // message fields are host prose, so neither is copied into the footer phase;
  // a non-empty report only keeps the closed lifecycle word "running".
  const hasStatus =
    sanitizeChildCompactText(input.status ?? "").length > 0 ||
    sanitizeChildCompactText(input.message ?? "").length > 0;
  return hasStatus ? { ...state, phase: "running" } : state;
}

function applyRetry(
  state: PiDelegationCardState,
  input: Extract<ChildCompactReducerInput, { kind: "retry" }>,
): PiDelegationCardState {
  return {
    ...state,
    runAction: "retry",
    runAttempt: input.attempt ?? state.runAttempt,
    phase: "bootstrap",
    activity: undefined,
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
  // Settlement changes only lifecycle framing. The authoritative child output
  // is deliberately not copied into the card's activity or terminal facts.
  return {
    ...settled,
    activity: undefined,
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
  // The parent card has no durable child transcript. Even if a caller hands a
  // projection an older state shape, the persisted fact boundary is empty.
  const rows: readonly PiCardViewportRow[] = [];

  return {
    schemaVersion: CARD_FACTS_SCHEMA_VERSION,
    tool: CARD_TOOL_NAME,
    agentName: state.agentName,
    ...(state.model !== undefined ? { model: state.model } : {}),
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
      kind: "boot",
      text: "",
      live: false,
    },
    telemetry: projectTelemetry(state),
    viewport: {
      rows,
      above: 0,
      atBottom: true,
    },
    ...(terminal !== undefined ? { terminal } : {}),
  };
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

/** Terminal facts appear only after an authoritative settlement arrives. */
function deriveTerminal(
  state: PiDelegationCardState,
): PiCardTerminalFacts | undefined {
  const settlement = state.settlement;
  if (settlement === undefined) return undefined;

  if (settlement.outcome === "completed") {
    return {
      outcome: "completed",
      verdict: "COMPLETED",
      glyph: "✓",
      headline: CARD_COMPLETED_RECORD,
      evidence: CARD_SETTLEMENT_EVIDENCE,
    };
  }

  if (settlement.outcome === "failed") {
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
      headline: CARD_FAILED_RECORD,
      evidence:
        failureClass === undefined
          ? CARD_SETTLEMENT_EVIDENCE
          : boundText(failureClass, CARD_TERMINAL_TEXT_MAX),
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

function statusWord(state: PiDelegationCardState): string {
  const settlement = state.settlement;
  if (settlement !== undefined) return settlement.outcome;
  if (state.startedAtMs === undefined) return "pending";
  // The parent card deliberately retains no child activity text. Lifecycle
  // status therefore follows the reducer's closed phase vocabulary rather than
  // the presence of an activity row.
  if (state.phase === "bootstrap") return "starting";
  if (state.phase === "steered") return "steered";
  return "running";
}

function toneOf(state: PiDelegationCardState): PiCardTone {
  const settlement = state.settlement;
  if (settlement?.outcome === "completed") return "ok";
  if (settlement?.outcome === "failed") return "bad";
  if (settlement?.outcome === "cancelled") return "mute";
  if (state.phase === "tool error" || state.phase === CARD_PROVIDER_ERROR_PHASE)
    return "bad";
  if (state.phase === "steered") return "warn";
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
  const timed = withClock(state, stamp);
  return ok({
    ...timed,
    // Keep only the closed failure class for recovery framing. Provider
    // message text is child payload and must not enter card facts/details.
    phase: CARD_PROVIDER_ERROR_PHASE,
    failureClass: error.class,
    activity: undefined,
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
  /** Content-free aggregate sink for rejected card mapping/reduction. */
  readonly diagnostics?: ChildUiEventDiagnosticsSink;
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
    this.activeMessageId = undefined;
    this.activeMessageIdInvented = false;
    this.settled = false;
    this.state = createDelegationCardState({
      agentName: this.agentName,
      assignment: this.assignment,
      ...(this.config.model !== undefined ? { model: this.config.model } : {}),
      runNumber: this.runNumber,
      action: input.action,
    });
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
    return this.applySessionEventResult(event).match(
      (facts) => facts,
      () => this.facts(),
    );
  }

  /**
   * Result-bearing event projection. The compatibility wrapper above keeps the
   * historical facts-only API, while callers that own a fanout boundary can
   * identify the first card mapping or reduction failure.
   */
  applySessionEventResult(
    event: PiChildSessionEvent,
  ): Result<PiDelegationCardFacts, PiDelegationCardError> {
    if (this.settled) return ok(this.facts());
    const itemId = this.correlateItemId(event);
    const mapped = Result.fromThrowable(
      () => mapPiChildSessionEventToCompactInput(event, itemId),
      () => ({
        type: "PiDelegationCardFailed" as const,
        operation: "map" as const,
        detail: "mapper_exception",
      }),
    )();
    if (mapped.isErr()) {
      recordChildUiEventFailure(
        this.config.diagnostics,
        "card-reduction",
        "card-mapping-failed",
      );
      return err(mapped.error);
    }
    if (mapped.value.isErr()) {
      recordChildUiEventFailure(
        this.config.diagnostics,
        "card-reduction",
        "card-mapping-failed",
      );
      return err({
        type: "PiDelegationCardFailed",
        operation: "map",
        detail: "mapper_rejected",
      });
    }
    if (mapped.value.value === undefined)
      return this.applyEventProviderErrorResult(event);
    const input = mapped.value.value;
    if (input.kind === "settle") return ok(this.facts());
    // Only a fragment the mapper could identify authoritatively is eligible for
    // duplicate suppression. Streamed deltas carry no identity on the wire, so
    // they arrive unkeyed and are always applied: repeating a word is not
    // repeating a frame, and dropping the repeat printed an answer the child
    // never gave.
    if (input.kind === "assistant_fragment" && input.dedupKey !== undefined) {
      const dedupKey = boundChildCompactId(input.dedupKey);
      if (this.dedupKeys.has(dedupKey)) return ok(this.facts());
      this.retainDedupKey(dedupKey);
    }
    const reduced = this.applyInputResult(input);
    if (reduced.isErr()) {
      recordChildUiEventFailure(
        this.config.diagnostics,
        "card-reduction",
        "card-reduction-failed",
      );
      return err(reduced.error);
    }
    return this.applyEventProviderErrorResult(event);
  }

  /** Folds one already-sanitized provider failure in. */
  applyProviderError(error: PiChildProviderError): PiDelegationCardFacts {
    return this.applyProviderErrorResult(error).match(
      (facts) => facts,
      () => this.facts(),
    );
  }

  private applyProviderErrorResult(
    error: PiChildProviderError,
  ): Result<PiDelegationCardFacts, PiDelegationCardError> {
    if (this.settled) return ok(this.facts());
    const reduced = Result.fromThrowable(
      () => applyDelegationCardProviderError(this.state, error, this.now),
      () => ({
        type: "PiDelegationCardFailed" as const,
        operation: "apply" as const,
        detail: "provider_reducer_exception",
      }),
    )();
    if (reduced.isErr()) {
      recordChildUiEventFailure(
        this.config.diagnostics,
        "card-reduction",
        "card-reduction-failed",
      );
      return err(reduced.error);
    }
    if (reduced.value.isErr()) {
      recordChildUiEventFailure(
        this.config.diagnostics,
        "card-reduction",
        "card-reduction-failed",
      );
      return err(reduced.value.error);
    }
    this.state = reduced.value.value;
    return ok(this.facts());
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

  private applyEventProviderErrorResult(
    event: PiChildSessionEvent,
  ): Result<PiDelegationCardFacts, PiDelegationCardError> {
    const projected = Result.fromThrowable(
      () =>
        parsePiChildProviderError(event, this.config.providerErrorDescriptor),
      () => ({
        type: "PiDelegationCardFailed" as const,
        operation: "map" as const,
        detail: "provider_mapper_exception",
      }),
    )();
    if (projected.isErr()) {
      recordChildUiEventFailure(
        this.config.diagnostics,
        "card-reduction",
        "card-mapping-failed",
      );
      return err(projected.error);
    }
    if (projected.value.isErr()) return ok(this.facts());
    return this.applyProviderErrorResult(projected.value.value);
  }

  private applyInputResult(
    input: unknown,
  ): Result<PiDelegationCardState, PiDelegationCardError> {
    const reduced = Result.fromThrowable(
      () => applyDelegationCardInput(this.state, input, this.now),
      () => ({
        type: "PiDelegationCardFailed" as const,
        operation: "apply" as const,
        detail: "reducer_exception",
      }),
    )();
    if (reduced.isErr()) return err(reduced.error);
    if (reduced.value.isErr()) return err(reduced.value.error);
    this.state = reduced.value.value;
    return ok(this.state);
  }

  private applyInput(input: unknown): void {
    this.applyInputResult(input).match(
      () => undefined,
      () =>
        recordChildUiEventFailure(
          this.config.diagnostics,
          "card-reduction",
          "card-reduction-failed",
        ),
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
