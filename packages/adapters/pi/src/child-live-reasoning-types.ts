import type { PiLiveReasoningRegistry } from "./child-live-reasoning-registry.js";
import type { ChildUiEventDiagnosticsSink } from "./child-ui-event-diagnostics.js";

/** The shared in-memory ceiling for one live thinking block. */
export const PI_LIVE_REASONING_MAX_BYTES = 4 * 1024;
/** Alias used by callers that name the Pi surface explicitly. */
export const MAX_PI_LIVE_REASONING_BYTES = PI_LIVE_REASONING_MAX_BYTES;
/** Maximum code points in the parent card's one-line reasoning content. */
export const PI_LIVE_REASONING_PARENT_MAX_CODE_POINTS = 240;
/** Maximum number of rows in the focused inspector's live reasoning view. */
export const PI_LIVE_REASONING_INSPECTOR_MAX_ROWS = 3;
/** Maximum code points in one inspector row before terminal truncation. */
export const PI_LIVE_REASONING_INSPECTOR_ROW_MAX_CODE_POINTS = 240;
/** The captured Pi content-index bound. */
export const PI_LIVE_REASONING_MAX_CONTENT_INDEX = 255;
/** Maximum input accepted after the parser-approved boundary. */
export const PI_LIVE_REASONING_MAX_INPUT_BYTES = 16_384;

export const PI_LIVE_REASONING_TRUNCATION_MARKER = "… [truncated]";
export const PI_LIVE_REASONING_UNPRINTABLE_MARKER = "[unprintable reasoning]";
export const PI_LIVE_REASONING_PARENT_PREFIX = "↪ reasoning • ";

/** Generic Pi 0.84.2 phases that are allowed into the live projector. */
export const PI_LIVE_REASONING_PHASES = ["start", "delta", "end"] as const;
/** Maximum number of concurrent card/inspector projectors in one generation. */
export const PI_LIVE_REASONING_MAX_REGISTRY_ENTRIES = 64;
export type PiLiveReasoningPhase = (typeof PI_LIVE_REASONING_PHASES)[number];

/** A bounded, terminal-safe update that is never a session event. */
export interface PiLiveReasoningUpdate {
  readonly childId: string;
  readonly generationId: string;
  readonly lifecycleEpoch: number;
  readonly phase: PiLiveReasoningPhase;
  readonly contentIndex: number;
  /** The current bounded display buffer, not a durable transcript fragment. */
  readonly text: string;
}

export type PiLiveReasoningRejectionReason =
  | "unreadable"
  | "invalid-carrier"
  | "mixed-carriers"
  | "missing-text"
  | "invalid-text"
  | "missing-correlation"
  | "correlation-out-of-bounds"
  | "stale-child"
  | "stale-generation"
  | "stale-epoch"
  | "out-of-order"
  | "no-active-block"
  | "duplicate-delta"
  | "settled"
  | "disposed";

/** Rejections never contain source text, identities, or exception messages. */
export interface PiLiveReasoningRejection {
  readonly type: "PiLiveReasoningRejected";
  readonly reason: PiLiveReasoningRejectionReason;
}

/** Result-like values are inspected, but observers may return any UI value. */
export type PiLiveReasoningObserverResult = unknown;

/** One UI-only sink. It must never be used as a session-event callback. */
export type PiLiveReasoningObserver = (
  update: PiLiveReasoningUpdate,
) => PiLiveReasoningObserverResult;

export interface PiLiveReasoningSnapshot {
  readonly childId: string | undefined;
  readonly generationId: string | undefined;
  readonly lifecycleEpoch: number;
  readonly phase: PiLiveReasoningPhase | "idle";
  readonly contentIndex: number | undefined;
  /** Current normalized content held only for the live UI projection. */
  readonly text: string;
  /** Parent-card content, without the parent-card prefix. */
  readonly parentCardText: string;
  /** Focused-inspector rows. Empty means that no row should be rendered. */
  readonly inspectorRows: readonly string[];
  /** A complete parent-card line, or the empty string when no row is valid. */
  readonly parentCardLine: string;
  readonly active: boolean;
  readonly retainedBytes: number;
  readonly omitted: boolean;
  readonly unprintable: boolean;
  readonly registryEntries: number;
}

/** Empty display-only state used when no inspector projector is mounted. */
export function emptyPiLiveReasoningSnapshot(
  registryEntries = 0,
): PiLiveReasoningSnapshot {
  return {
    childId: undefined,
    generationId: undefined,
    lifecycleEpoch: 0,
    phase: "idle",
    contentIndex: undefined,
    text: "",
    parentCardText: "",
    inspectorRows: [],
    parentCardLine: "",
    active: false,
    retainedBytes: 0,
    omitted: false,
    unprintable: false,
    registryEntries,
  };
}

export interface PiLiveReasoningProjectorConfig {
  readonly childId: string;
  readonly generationId: string;
  readonly parentCardObserver?: PiLiveReasoningObserver;
  readonly inspectorObserver?: PiLiveReasoningObserver;
  /** Aliases make the two independent UI sinks explicit at call sites. */
  readonly onParentCardReasoning?: PiLiveReasoningObserver;
  readonly onInspectorReasoning?: PiLiveReasoningObserver;
  readonly diagnostics?: ChildUiEventDiagnosticsSink;
  readonly registry?: PiLiveReasoningRegistry;
  readonly registryKey?: string;
}
