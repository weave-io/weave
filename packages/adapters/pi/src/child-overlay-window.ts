/**
 * The per-child saved window and its bounded page merges (Spec 33 §7).
 *
 * Split out of `child-overlay-controller.ts` so the controller keeps only
 * request handling and view projection while the window state, its LRU-scoped
 * initializer, the older/newer merge rules, and the transcript resync live
 * together. Everything here is a pure mutation of one already-validated saved
 * state: it never touches the source port, the harness, or the filesystem.
 */

import {
  type ChildCompactState,
  createChildCompactState,
} from "./child-compact-render.js";
import { transcriptFromOverlayEntries } from "./child-overlay-replay.js";
import {
  markTailGrowth,
  type OverlayScrollState,
  restoreAfterOlderEntries,
  restoreScrollAnchor,
} from "./child-overlay-scroll.js";
import {
  type ChildTerminalErrorEvidence,
  latestUsageInWindow,
  NO_TERMINAL_ERROR_EVIDENCE,
  pageEvidence,
} from "./child-overlay-telemetry.js";
import type {
  ChildOverlayAnchor,
  ChildOverlayChild,
  ChildOverlayEntry,
  ChildOverlayPage,
} from "./child-overlay-types.js";
import type { PiChildUsageReport } from "./child-session-events.js";
import {
  createPiChildTranscriptState,
  type PiChildTranscriptState,
} from "./child-transcript.js";

export interface SavedChildState extends OverlayScrollState {
  draft: string;
  searchQuery: string;
  /**
   * Every match for {@link SavedChildState.searchQuery}, in stable transcript
   * order (oldest first), deduplicated by entry id. Fetching older pages trims
   * the newest entries out of the bounded window, so matches cannot be derived
   * from the window alone without losing every match scrolled out of it. This
   * list is authoritative and is rebuilt on each `search` call.
   */
  searchMatchIds: string[];
  /**
   * The ANSI-free text of the rows the component last PAINTED, keyed by the
   * same entry identity the viewport anchors on.
   *
   * Search matches this as well as the window entry's own short `text`
   * projection, because they are not the same thing: a tool window entry
   * carries only its tool name, while the reader is looking at
   * `bash(timeout: 180)` and its result. Only the component knows what fit on
   * screen at the current width, so — exactly like the measured scroll extent
   * — it is reported to the controller rather than derived here.
   */
  renderedSearchText: ReadonlyMap<string, string>;
  globalExpanded: boolean;
  activeRun: number | undefined;
  activeBranchId: string | undefined;
  olderCursor: string | undefined;
  newerCursor: string | undefined;
  hasOlderFlag: boolean;
  hasNewerFlag: boolean;
  /**
   * Shared bounded run/item reducer state. Saved beside the rest of the child's
   * view state so it survives focus switches within this controller, stays
   * isolated per child, and is gone when the controller (and its LRU) is
   * discarded.
   */
  compact: ChildCompactState;
  usage: PiChildUsageReport | undefined;
  evidence: ChildTerminalErrorEvidence;
  transcript: PiChildTranscriptState;
  /**
   * Overlay entry id of the assistant message lifecycle currently in flight,
   * or undefined when no `message_start` is open.
   *
   * Pi 0.84 `AssistantMessage` carries no `id`, and `message_start` /
   * `message_end` carry the message directly, so the only place a lifecycle
   * identity can live is here, beside the child it belongs to. It is one
   * optional string, so it stays bounded, isolated per child, and is discarded
   * with the child's LRU slot on controller teardown.
   */
  liveAssistantEntryId: string | undefined;
  /**
   * Bounded monotonic allocator for {@link SavedChildState.liveAssistantEntryId}.
   * Advances once per lifecycle and wraps at
   * {@link MAX_LIVE_ASSISTANT_LIFECYCLES}.
   */
  liveAssistantCounter: number;
  width: number;
  height: number;
  lastTouched: number;
}

export function emptySaved(threadId: string, touched: number): SavedChildState {
  return {
    draft: "",
    searchQuery: "",
    searchMatchIds: [],
    renderedSearchText: new Map(),
    scrollOffset: 0,
    scrollExtent: undefined,
    liveTail: true,
    pendingTailExtentAdjustment: false,
    globalExpanded: false,
    activeRun: undefined,
    activeBranchId: undefined,
    olderCursor: undefined,
    newerCursor: undefined,
    hasOlderFlag: false,
    hasNewerFlag: false,
    entries: [],
    layoutSpans: undefined,
    pendingViewportAnchor: undefined,
    pendingViewportLiveTail: false,
    compact: createChildCompactState(threadId),
    usage: undefined,
    evidence: NO_TERMINAL_ERROR_EVIDENCE,
    transcript: createPiChildTranscriptState(),
    liveAssistantEntryId: undefined,
    liveAssistantCounter: 0,
    anchor: undefined,
    width: 80,
    height: 24,
    lastTouched: touched,
  };
}

/** A settled or orphaned child is history: the inspector may not mutate it. */
export function isReadOnly(child: ChildOverlayChild): boolean {
  return child.status === "settled" || child.status === "orphan";
}

export function prependOverlayPage(
  state: SavedChildState,
  page: ChildOverlayPage,
  incoming: readonly ChildOverlayEntry[],
  priorAnchor: ChildOverlayAnchor | undefined,
  windowCap: number,
): void {
  const existingIds = new Set(state.entries.map((entry) => entry.id));
  const uniqueOlder = incoming.filter((entry) => !existingIds.has(entry.id));
  const merged = dedupEntries([...uniqueOlder, ...state.entries]);
  const retained = merged.slice(0, windowCap);
  const trimmedNewest = merged.length - retained.length;
  state.entries = retained;
  state.olderCursor = page.olderCursor;
  state.hasOlderFlag = page.hasOlder;
  if (trimmedNewest > 0) {
    state.newerCursor = page.newerCursor;
    state.hasNewerFlag = true;
    state.liveTail = false;
  }
  restoreAfterOlderEntries(state, priorAnchor, uniqueOlder[0], retained.length);
  syncTranscriptFromEntries(state);
  state.usage ??= latestUsageInWindow(incoming);
  state.evidence = pageEvidence(state.evidence, incoming, "older");
}

export function appendOverlayPage(
  state: SavedChildState,
  page: ChildOverlayPage,
  incoming: readonly ChildOverlayEntry[],
  priorAnchor: ChildOverlayAnchor | undefined,
  windowCap: number,
): void {
  const existingIds = new Set(state.entries.map((entry) => entry.id));
  const uniqueNewer = incoming.filter((entry) => !existingIds.has(entry.id));
  const merged = dedupEntries([...state.entries, ...uniqueNewer]);
  const retained = merged.slice(-windowCap);
  const trimmedOldest = merged.length - retained.length;
  state.entries = retained;
  if (trimmedOldest > 0) {
    state.olderCursor = page.olderCursor;
    state.hasOlderFlag = true;
  }
  state.newerCursor = page.newerCursor;
  state.hasNewerFlag = page.hasNewer;
  restoreScrollAnchor(state, priorAnchor);
  if (uniqueNewer.length > 0) markTailGrowth(state);
  syncTranscriptFromEntries(state);
  state.usage = latestUsageInWindow(uniqueNewer) ?? state.usage;
  state.evidence = pageEvidence(state.evidence, uniqueNewer, "newer");
}

export function dedupEntries(
  entries: readonly ChildOverlayEntry[],
): ChildOverlayEntry[] {
  const seen = new Set<string>();
  const result: ChildOverlayEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push(entry);
  }
  return result;
}

/**
 * Rebuilds {@link SavedChildState.transcript} from the retained overlay window
 * so paged merges (older/newer/search/replace) cannot leave the render model
 * pointing at a stale tip-only transcript. Preserves expanded IDs that still
 * resolve; scroll anchors are owned by {@link restoreAfterOlderPrepend}.
 */
export function syncTranscriptFromEntries(state: SavedChildState): void {
  const priorExpandedIds = new Set<string>();
  const priorExpandedTexts = new Set<string>();
  for (const entry of state.transcript.entries) {
    if (!entry.expanded) continue;
    priorExpandedIds.add(entry.id);
    if ("messageId" in entry && typeof entry.messageId === "string") {
      priorExpandedIds.add(entry.messageId);
    }
    if ("text" in entry && typeof entry.text === "string") {
      priorExpandedTexts.add(entry.text);
    }
  }
  for (const entry of state.entries) {
    if (!entry.expanded) continue;
    priorExpandedIds.add(entry.id);
    priorExpandedTexts.add(entry.text);
  }

  const rebuilt = transcriptFromOverlayEntries(state.entries);
  if (priorExpandedIds.size === 0 && !state.globalExpanded) {
    state.transcript = rebuilt;
    return;
  }

  state.transcript = {
    ...rebuilt,
    entries: rebuilt.entries.map((entry) => {
      const messageId =
        "messageId" in entry && typeof entry.messageId === "string"
          ? entry.messageId
          : undefined;
      const text =
        "text" in entry && typeof entry.text === "string"
          ? entry.text
          : undefined;
      const expanded =
        state.globalExpanded ||
        priorExpandedIds.has(entry.id) ||
        (messageId !== undefined && priorExpandedIds.has(messageId)) ||
        (text !== undefined && priorExpandedTexts.has(text));
      return expanded === entry.expanded ? entry : { ...entry, expanded };
    }),
  };
}
