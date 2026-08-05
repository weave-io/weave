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
import type { PiChildSessionEvent } from "./child-session-events.js";
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
  /** Ceiling on run dividers retained per child descriptor. */
  maxRuns: 64,
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

export const ChildOverlayRunDividerSchema = z
  .object({
    run: z.number().int().min(1).max(CHILD_OVERLAY_BOUNDS.maxRuns),
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

export const ChildOverlayChildSchema = z
  .object({
    childId: OpaqueIdSchema,
    threadId: OpaqueIdSchema,
    parentChildId: OpaqueIdSchema.optional(),
    status: ChildOverlayStatusSchema,
    title: z.string().max(CHILD_OVERLAY_BOUNDS.maxLabelLength).optional(),
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
  | { readonly type: "SourceInvalidCursor"; readonly operation: string }
  | { readonly type: "ChildNotFound"; readonly childId: string };

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
}

export interface ChildOverlayFallbackRequired {
  readonly kind: "fallback-required";
  readonly metadata: ChildOverlayFallbackMetadata;
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
  readonly scrollOffset: number;
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
  readonly compact: ChildCompactState;
  readonly transcript: PiChildTranscriptState;
}

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
