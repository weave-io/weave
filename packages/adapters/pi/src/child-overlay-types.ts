/**
 * Shared bounded overlay contract: capacity bounds, opaque input schemas, and
 * the UI-agnostic overlay types (Spec 33 §7, plan Task 12 phases A–B1).
 *
 * This module is the acyclic root of the child-overlay runtime: replay
 * mapping, the controller, the native component, and the source adapters all
 * depend on it and never the other way round. It holds no behavior beyond
 * schema validation and bound clamping.
 */

import type { ResultAsync } from "neverthrow";
import { z } from "zod";
import type { ChildCompactState } from "./child-compact-render.js";
import type { PiChildProviderError } from "./child-provider-error.js";
import {
  MAX_CHILD_EVENT_ITEMS,
  MAX_CHILD_USAGE_MODEL_LENGTH,
  MAX_CHILD_USAGE_TOKENS,
  type PiChildSessionEvent,
} from "./child-session-events.js";
import type { PiChildTranscriptState } from "./child-transcript.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Admitted content-block ceiling for one native message entry.
 *
 * Replay framing needs headroom beyond this: `message_start`, an optional
 * standalone `text` step, and terminal `message_end` (tool call/result facts
 * expand 1:1 from admitted blocks and must not crowd out the terminal).
 */
const MAX_ENTRY_CONTENT_BLOCKS = 32;
/** `message_start` + `text` + `message_end` framing beside admitted blocks. */
const ENTRY_REPLAY_FRAME_STEPS = 3;

export const CHILD_OVERLAY_BOUNDS = Object.freeze({
  /** Entries loaded by one page request. */
  defaultPageSize: 50,
  /** Hard ceiling for one page request. */
  maxPageSize: 100,
  /** Maximum entries retained in the in-memory window. */
  defaultWindowCap: 200,
  /** Hard ceiling for the in-memory window. */
  maxWindowCap: 512,
  /** Per-child saved view states retained (LRU). */
  maxLruChildren: 8,
  /** Maximum older pages fetched during one search. */
  maxSearchPages: 4,
  /** Ceiling on opaque cursor characters. */
  maxCursorLength: 512,
  /** Ceiling on draft / search query characters. */
  maxTextLength: 16_384,
  /** Ceiling on child / thread / entry ids. */
  maxIdLength: 256,
  /** Ceiling on run-divider labels. */
  maxLabelLength: 128,
  /**
   * Ceiling on a child descriptor title.
   *
   * A descriptor title is not a label: it is the already-validated title of a
   * persisted child ref, so this bound must equal the ref store's own
   * `PI_CHILD_REF_BOUNDS.maxTitleLength`. Capping it at the shorter label bound
   * rejected every real prompt-derived title, which surfaced as an
   * `OverlayInvalidChild` on `title` and sent historical children to the
   * custom-editor fallback. The equality is pinned by test.
   */
  maxTitleLength: 200,
  /** Ceiling on run dividers retained per child descriptor. */
  maxRuns: 64,
  /**
   * Ceiling on a run *ordinal*. The overlay retains a bounded newest-last
   * window of dividers, so run 65, run 1,001, and run 1,000,001 are ordinary
   * values inside a 64-entry window; capping the ordinal at the window size,
   * or at any cumulative count a healthy thread can reach, rejected long-lived
   * threads outright.
   *
   * Restated rather than imported because this module is the acyclic root of
   * the overlay runtime and must not depend on the ref store. Equality with
   * `PI_CHILD_REF_BOUNDS.maxRunOrdinal` is pinned by test.
   */
  maxRunOrdinal: 8_204_889_600_000,
  /** Ceiling on nested hierarchy depth reported in descriptors. */
  maxHierarchyDepth: 16,
  /** Ceiling on content blocks read from one native message entry. */
  maxEntryContentBlocks: MAX_ENTRY_CONTENT_BLOCKS,
  /**
   * Ceiling on replay steps retained per overlay entry.
   *
   * Derived so every admitted content block plus start/text/end framing fits;
   * mapping must fail typed when input would exceed either ceiling rather than
   * silently drop `message_end` (which leaves assistants falsely streaming).
   */
  maxEntryReplaySteps: MAX_ENTRY_CONTENT_BLOCKS + ENTRY_REPLAY_FRAME_STEPS,
  /**
   * Ceiling on the child's own assignment sentence.
   *
   * The assignment is the exact dispatched task text, bounded here so a long
   * prompt cannot grow the descriptor. It is never parsed for identity.
   */
  maxAssignmentLength: 240,
  /** Ceiling on a reported conversation turn ordinal. */
  maxTurn: 1_000_000,
  /** Ceiling on a reported queued-prompt depth (pinned to the event parser). */
  maxQueueDepth: MAX_CHILD_EVENT_ITEMS,
  /** Ceiling on reported elapsed milliseconds (one year). */
  maxElapsedMs: 31_536_000_000,
  /** Ceiling on any single reported usage token count (pinned to the parser). */
  maxUsageTokens: MAX_CHILD_USAGE_TOKENS,
  /** Ceiling on a reported aggregate cost. */
  maxUsageCost: 1_000_000,
});

export const SCROLL_KEYS = {
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  shiftUp: "\x1b[1;2A",
  shiftDown: "\x1b[1;2B",
  home: "\x1b[H",
  end: "\x1b[F",
} as const;

export const SCROLL_PAGE = 10;

// ---------------------------------------------------------------------------
// Schemas (persisted / opaque input)
// ---------------------------------------------------------------------------

export const OpaqueIdSchema = z
  .string()
  .min(1)
  .max(CHILD_OVERLAY_BOUNDS.maxIdLength)
  .regex(/^[A-Za-z0-9._:-]+$/u);

export const OpaqueCursorSchema = z
  .string()
  .min(1)
  .max(CHILD_OVERLAY_BOUNDS.maxCursorLength);

export const OverlayTextSchema = z
  .string()
  .max(CHILD_OVERLAY_BOUNDS.maxTextLength);

export const RunActionSchema = z.enum(["start", "retry", "continue"]);

/** One run ordinal. Bounded by the ordinal ceiling, not the window size. */
export const ChildOverlayRunOrdinalSchema = z
  .number()
  .int()
  .min(1)
  .max(CHILD_OVERLAY_BOUNDS.maxRunOrdinal);

export const ChildOverlayRunDividerSchema = z
  .object({
    run: ChildOverlayRunOrdinalSchema,
    action: RunActionSchema,
    startedAt: z.number().int().nonnegative().optional(),
    priorOutcome: z
      .string()
      .max(CHILD_OVERLAY_BOUNDS.maxLabelLength)
      .optional(),
    initiator: z.string().max(CHILD_OVERLAY_BOUNDS.maxLabelLength).optional(),
    model: z.string().max(CHILD_OVERLAY_BOUNDS.maxLabelLength).optional(),
    reasoning: z.string().max(CHILD_OVERLAY_BOUNDS.maxLabelLength).optional(),
  })
  .strict();
export type ChildOverlayRunDivider = z.infer<
  typeof ChildOverlayRunDividerSchema
>;

export const ChildOverlayStatusSchema = z.enum(["live", "settled", "orphan"]);
export type ChildOverlayStatus = z.infer<typeof ChildOverlayStatusSchema>;

/** One bounded identity label (agent, parent agent, role, model, reasoning). */
export const ChildOverlayLabelSchema = z
  .string()
  .min(1)
  .max(CHILD_OVERLAY_BOUNDS.maxLabelLength);

/**
 * Bounded, all-optional aggregate usage the host reported for this child.
 *
 * Distinct from {@link ChildOverlayTelemetry}: this is the delegation tree's
 * own aggregate for the child process, not the latest assistant usage report.
 * Any field the tree did not report is absent rather than zero.
 */
export const ChildOverlayDescriptorUsageSchema = z
  .object({
    inputTokens: z
      .number()
      .int()
      .min(0)
      .max(CHILD_OVERLAY_BOUNDS.maxUsageTokens)
      .optional(),
    outputTokens: z
      .number()
      .int()
      .min(0)
      .max(CHILD_OVERLAY_BOUNDS.maxUsageTokens)
      .optional(),
    cacheReadTokens: z
      .number()
      .int()
      .min(0)
      .max(CHILD_OVERLAY_BOUNDS.maxUsageTokens)
      .optional(),
    cacheWriteTokens: z
      .number()
      .int()
      .min(0)
      .max(CHILD_OVERLAY_BOUNDS.maxUsageTokens)
      .optional(),
    cost: z.number().min(0).max(CHILD_OVERLAY_BOUNDS.maxUsageCost).optional(),
  })
  .strict();
export type ChildOverlayDescriptorUsage = z.infer<
  typeof ChildOverlayDescriptorUsageSchema
>;

export const ChildOverlayChildSchema = z
  .object({
    childId: OpaqueIdSchema,
    threadId: OpaqueIdSchema,
    parentChildId: OpaqueIdSchema.optional(),
    status: ChildOverlayStatusSchema,
    title: z.string().max(CHILD_OVERLAY_BOUNDS.maxTitleLength).optional(),
    generationId: OpaqueIdSchema.optional(),
    runs: z
      .array(ChildOverlayRunDividerSchema)
      .max(CHILD_OVERLAY_BOUNDS.maxRuns)
      .default([]),
    branchIds: z
      .array(OpaqueIdSchema)
      .max(CHILD_OVERLAY_BOUNDS.maxRuns)
      .default([]),
    /** Nested descendant child ids, shallow and bounded (no paths). */
    descendantChildIds: z
      .array(OpaqueIdSchema)
      .max(CHILD_OVERLAY_BOUNDS.maxHierarchyDepth)
      .default([]),
    /**
     * Authoritative identity and operational facts (Spec 33 §7 header/rail).
     *
     * Every one is optional and every one is absent unless an authoritative
     * source named it: live thread/tree state for a running child, the child's
     * own `weave.child.thread` metadata for a historical one. None of them is
     * ever inferred from a title, a parent's model, or another child's usage.
     */
    agentName: ChildOverlayLabelSchema.optional(),
    parentAgentName: ChildOverlayLabelSchema.optional(),
    /** Configured category name for this agent. Never invented. */
    role: ChildOverlayLabelSchema.optional(),
    model: ChildOverlayLabelSchema.optional(),
    reasoning: ChildOverlayLabelSchema.optional(),
    /** Bounded copy of the exact dispatched task text. */
    assignment: z
      .string()
      .max(CHILD_OVERLAY_BOUNDS.maxAssignmentLength)
      .optional(),
    turn: z.number().int().min(0).max(CHILD_OVERLAY_BOUNDS.maxTurn).optional(),
    queueDepth: z
      .number()
      .int()
      .min(0)
      .max(CHILD_OVERLAY_BOUNDS.maxQueueDepth)
      .optional(),
    elapsedMs: z
      .number()
      .int()
      .min(0)
      .max(CHILD_OVERLAY_BOUNDS.maxElapsedMs)
      .optional(),
    usage: ChildOverlayDescriptorUsageSchema.optional(),
  })
  .strict();
export type ChildOverlayChild = z.infer<typeof ChildOverlayChildSchema>;

// ---------------------------------------------------------------------------
// Overlay entries (UI-agnostic transcript facts)
// ---------------------------------------------------------------------------

export type ChildOverlayEntryKind =
  | "prompt"
  | "user"
  | "steering"
  | "follow-up"
  | "assistant"
  | "thinking"
  | "tool"
  | "error"
  | "retry"
  | "run-divider"
  | "image"
  | "status"
  | "unknown";

/**
 * One bounded transcript-reducer step retained beside an overlay entry.
 *
 * Replay steps are the fidelity contract between paged history and the live
 * reducer: every projected fact carries the schema-validated child events (or
 * input actions) that reproduce it, so {@link transcriptFromOverlayEntries}
 * rebuilds the same ordered transcript the live pipeline would have produced.
 * Steps never carry raw host payloads, image bytes, or filesystem paths.
 */
export type ChildOverlayReplayStep =
  | {
      readonly kind: "input";
      readonly input: "task" | "steering" | "follow_up";
      readonly text: string;
    }
  | { readonly kind: "event"; readonly event: PiChildSessionEvent };

export interface ChildOverlayEntry {
  readonly id: string;
  readonly sequence: number;
  readonly kind: ChildOverlayEntryKind;
  /** Searchable, sanitized text projection (never a filesystem path). */
  readonly text: string;
  readonly runNumber?: number;
  readonly branchId?: string;
  readonly expanded: boolean;
  /**
   * Bounded reducer steps that reproduce this fact. `undefined` means the
   * entry predates strict mapping and falls back to a kind heuristic; an empty
   * array means the fact is intentionally transcript-neutral (a streaming
   * delta already covered by its terminal message).
   */
  readonly replay?: readonly ChildOverlayReplayStep[];
}

export interface ChildOverlayPage {
  readonly entries: readonly ChildOverlayEntry[];
  readonly olderCursor: string | undefined;
  readonly newerCursor: string | undefined;
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
}

export type ChildOverlaySourceError =
  | { readonly type: "SourceUnavailable"; readonly operation: string }
  | { readonly type: "SourceCorrupt"; readonly operation: string }
  /**
   * Transient startup gap: the child has begun, but its persisted thread
   * record, session reference, or native session file does not exist yet.
   * This is the only source failure a live child may recover from; every
   * other failure (permission, root violation, malformed header, parent
   * mismatch, corruption) stays fail-closed.
   */
  | { readonly type: "SourceStartupNotReady"; readonly operation: string }
  | { readonly type: "SourceInvalidCursor"; readonly operation: string }
  | { readonly type: "ChildNotFound"; readonly childId: string };

/**
 * The closed set of source-error discriminants, carried through fallback
 * metadata so a fallback decision names which source failure caused it.
 * A discriminant is a fixed literal, never an identifier or free-form text.
 */
export type ChildOverlaySourceErrorType = ChildOverlaySourceError["type"];

export interface ChildOverlaySourcePort {
  describe(
    childId: string,
  ): ResultAsync<ChildOverlayChild, ChildOverlaySourceError>;
  loadNewest(
    childId: string,
    pageSize: number,
  ): ResultAsync<ChildOverlayPage, ChildOverlaySourceError>;
  loadOlder(
    childId: string,
    cursor: string,
    pageSize: number,
  ): ResultAsync<ChildOverlayPage, ChildOverlaySourceError>;
  loadNewer(
    childId: string,
    cursor: string,
    pageSize: number,
  ): ResultAsync<ChildOverlayPage, ChildOverlaySourceError>;
}

export type ChildOverlayMutationPort = {
  steer(
    childId: string,
    generationId: string,
    text: string,
  ): ResultAsync<void, { readonly type: "MutationFailed" }>;
  followUp(
    childId: string,
    generationId: string,
    text: string,
  ): ResultAsync<void, { readonly type: "MutationFailed" }>;
};

export interface ChildOverlayConfig {
  readonly pageSize?: number;
  readonly windowCap?: number;
  readonly maxLruChildren?: number;
  readonly maxSearchPages?: number;
}

export type ChildOverlayFallbackReason =
  | "source-failed"
  | "render-failed"
  | "describe-failed";

/** Bounded safe metadata for custom-editor handoff — never paths or secrets. */
export interface ChildOverlayFallbackMetadata {
  readonly childId: string;
  readonly threadId: string;
  readonly status: ChildOverlayStatus;
  readonly entryCount: number;
  readonly reason: ChildOverlayFallbackReason;
  readonly readOnly: boolean;
  /**
   * The source-error discriminant that forced the fallback, when one exists.
   * Present so a `describe-failed` or `source-failed` decision can be reported
   * as a specific bounded reason code instead of collapsing four distinct
   * source failures into one indistinguishable code. Absent for fallbacks that
   * no source error produced (for example a render failure).
   */
  readonly sourceErrorType?: ChildOverlaySourceErrorType;
}

export interface ChildOverlayFallbackRequired {
  readonly kind: "fallback-required";
  readonly metadata: ChildOverlayFallbackMetadata;
  /** Latest bounded sanitized provider error, when authoritative evidence exists. */
  readonly terminalError?: PiChildProviderError;
  readonly transcript: PiChildTranscriptState;
}

export type ChildOverlayMappingError = {
  readonly type: "OverlayCapacityExceeded";
  readonly operation: "entry-content-blocks" | "entry-replay-steps";
};

export type ChildOverlayError =
  | ChildOverlaySourceError
  | { readonly type: "OverlayNotOpen" }
  | { readonly type: "OverlayInvalidChild"; readonly issues: readonly string[] }
  | { readonly type: "OverlayCapacityExceeded"; readonly operation: string }
  | ChildOverlayFallbackRequired;

export interface ChildOverlayAnchor {
  readonly entryId: string;
  readonly lineOffset: number;
}

export interface ChildOverlayView {
  readonly child: ChildOverlayChild;
  readonly entries: readonly ChildOverlayEntry[];
  readonly draft: string;
  readonly searchQuery: string;
  readonly searchMatches: readonly string[];
  /** Hidden rendered rows below the viewport bottom (visual rows, not entries). */
  readonly scrollOffset: number;
  /** Largest valid `scrollOffset` from the last measured render. */
  readonly scrollExtent: number;
  readonly liveTail: boolean;
  readonly globalExpanded: boolean;
  readonly activeRun: number | undefined;
  readonly activeBranchId: string | undefined;
  readonly olderCursor: string | undefined;
  readonly newerCursor: string | undefined;
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
  readonly readOnly: boolean;
  readonly width: number;
  readonly height: number;
  readonly anchor: ChildOverlayAnchor | undefined;
  /**
   * Shared bounded run/item reducer state for this child. The delegation card
   * folds the same inputs, so both surfaces agree on run structure.
   */
  readonly compact: ChildCompactState;
  readonly transcript: PiChildTranscriptState;
  /**
   * Latest authoritative usage report for this child, or `undefined` when the
   * host has reported nothing usable. Never summed across runs and never
   * estimated: absent means unavailable.
   */
  readonly telemetry: ChildOverlayTelemetry | undefined;
  /**
   * Authoritative identity and operational facts for the finalized inspector
   * header and rail, projected from the descriptor. `undefined` when no
   * authoritative source named a single fact: an unknown is never guessed.
   */
  readonly identity: ChildOverlayIdentity | undefined;
  /**
   * The *parent* session's own plan breadcrumb (header row 2), resolved by
   * `active-plan-ui-state.ts`. `undefined` when the parent tracks no active
   * plan. Never derived from the child's title or assignment.
   */
  readonly planContext: ChildOverlayPlanContext | undefined;
  /**
   * Latest terminal provider error for this child, sanitized and bounded by
   * `child-provider-error.ts`. Absent when the child's newest terminal
   * assistant message did not fail, or when nothing authoritative was
   * observed. Only the projection is retained: no raw `errorMessage` and no
   * provider payload reaches this state.
   */
  readonly terminalError?: PiChildProviderError;
}

/**
 * Bounded, all-optional projection of the latest host usage report.
 *
 * Field provenance (Pi 0.83, isolated install) is documented on
 * `parsePiChildUsageReport` in `child-session-events.ts`. Any field the host
 * did not report authoritatively, or reported outside
 * {@link CHILD_OVERLAY_TELEMETRY_BOUNDS}, is absent rather than guessed.
 */
export interface ChildOverlayTelemetry {
  /** Only the prefix of an unambiguous `provider/model` identifier. */
  readonly provider?: string;
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
  readonly contextTokens?: number;
  readonly contextWindow?: number;
  /** Present only when the host reported both context tokens and window. */
  readonly contextPercent?: number;
}

/**
 * Bounded, all-optional identity/operational projection of the descriptor.
 *
 * Carries no child id, thread id, session ref, native session id, or path: it
 * is only what the header and rail print about *who* the child is and *what*
 * it is doing right now.
 */
export interface ChildOverlayIdentity {
  readonly agentName?: string;
  readonly parentAgentName?: string;
  readonly role?: string;
  readonly model?: string;
  readonly reasoning?: string;
  readonly assignment?: string;
  readonly turn?: number;
  readonly queueDepth?: number;
  readonly elapsedMs?: number;
  readonly usage?: ChildOverlayDescriptorUsage;
}

/**
 * The parent's plan breadcrumb for header row 2.
 *
 * `taskOrdinal`/`taskTotal` are the active parent task's own ordinal and the
 * plan's parent-task count; `subtask` is present only when the active task is
 * a child task. Every field is absent when the plan did not name it.
 */
export interface ChildOverlayPlanContext {
  readonly planName?: string;
  readonly taskOrdinal?: number;
  readonly taskTotal?: number;
  readonly taskTitle?: string;
  readonly subtask?: string;
}

export const CHILD_OVERLAY_TELEMETRY_BOUNDS = Object.freeze({
  /** Ceiling on any single reported token count (pinned to the parser). */
  maxTokens: MAX_CHILD_USAGE_TOKENS,
  /** Ceiling on model and provider label characters (pinned to the parser). */
  maxModelLength: MAX_CHILD_USAGE_MODEL_LENGTH,
});

export type ChildOverlayInputOutcome =
  | { readonly kind: "consumed" }
  | { readonly kind: "draft-updated"; readonly draft: string }
  | {
      readonly kind: "steer";
      readonly childId: string;
      readonly text: string;
    }
  | {
      readonly kind: "follow-up";
      readonly childId: string;
      readonly text: string;
    }
  | { readonly kind: "scroll"; readonly scrollOffset: number }
  | { readonly kind: "search"; readonly query: string }
  | { readonly kind: "expanded"; readonly globalExpanded: boolean }
  | {
      readonly kind: "navigate-run";
      readonly activeRun: number | undefined;
    }
  | {
      readonly kind: "navigate-branch";
      readonly activeBranchId: string | undefined;
    }
  | ChildOverlayFallbackRequired;

export function clampPageSize(pageSize: number): number {
  if (!Number.isFinite(pageSize)) return CHILD_OVERLAY_BOUNDS.defaultPageSize;
  return Math.max(
    1,
    Math.min(CHILD_OVERLAY_BOUNDS.maxPageSize, Math.floor(pageSize)),
  );
}

export function clampWindowCap(windowCap: number): number {
  if (!Number.isFinite(windowCap)) return CHILD_OVERLAY_BOUNDS.defaultWindowCap;
  return Math.max(
    1,
    Math.min(CHILD_OVERLAY_BOUNDS.maxWindowCap, Math.floor(windowCap)),
  );
}
