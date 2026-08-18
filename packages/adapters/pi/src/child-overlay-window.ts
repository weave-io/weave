/**
 * The per-child saved window and its bounded page merges (Spec 33 §7).
 *
 * Split out of `child-overlay-controller.ts` so the controller keeps only
 * request handling and view projection while the window state, its LRU-scoped
 * initializer, the older/newer merge rules, and the transcript resync live
 * together. Everything here is a pure mutation of one already-validated saved
 * state: it never touches the source port, the harness, or the filesystem.
 */

import { appendAssistantStreamDelta } from "./assistant-stream-text.js";
import {
  type ChildCompactState,
  createChildCompactState,
} from "./child-compact-render.js";
import {
  allocateLiveAssistantEntryId,
  boundText,
  type LiveAssistantLifecyclePhase,
  liveAssistantStreamEntry,
  transcriptFromOverlayEntries,
} from "./child-overlay-replay.js";
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
  /**
   * The ANSWER text of the lifecycle in flight, accumulated from its own text
   * deltas and bounded by `boundText`.
   *
   * It is the canonical live assistant state: the window entry and its single
   * replay step are both written from it, so an unfinished answer survives
   * every window reconstruction (trim, page merge, search fetch) instead of
   * collapsing to whatever the last delta happened to be. Raw chain-of-thought
   * never reaches it — only text deltas are accumulated.
   */
  liveAssistantText: string;
  /**
   * True once a real `message_start` framed the lifecycle in flight.
   *
   * An UNFRAMED row is a provisional partial: the reader opened the inspector
   * mid-message, or caught up from the child's own answer snapshot, so no
   * start was ever observed for it. A later genuine `message_start` therefore
   * reuses that row instead of leaving an orphan partial beside the real one.
   */
  liveAssistantFramed: boolean;
  /**
   * The child's own live-answer lifecycle id this window adopted a row from,
   * or `undefined` when the row in flight came from live events.
   *
   * This is the WHOLE of the catch-up correlation, and it is an identity, not
   * a comparison of prose. The previous rule — "do not adopt a snapshot whose
   * words a retained entry already contains" — could not tell a snapshot left
   * over from a finished message apart from a new message that happened to
   * repeat an old answer, so it either duplicated the answer or hid it.
   */
  liveAssistantSeedId: number | undefined;
  /**
   * The newest child live-answer lifecycle id this window has been told about,
   * adopted or not.
   *
   * Kept so that ending a message can retire the right lifecycle even when the
   * row in flight came from live events rather than from a snapshot.
   */
  liveAssistantObservedId: number | undefined;
  /**
   * A child lifecycle this window considers finished, and will not adopt a
   * snapshot of again.
   *
   * One slot, because only the most recent matters: a snapshot older than the
   * message the window has already ended is the only stale case, and it always
   * names the lifecycle just retired.
   */
  liveAssistantRetiredId: number | undefined;
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
    liveAssistantText: "",
    liveAssistantFramed: false,
    liveAssistantSeedId: undefined,
    liveAssistantObservedId: undefined,
    liveAssistantRetiredId: undefined,
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

// ---------------------------------------------------------------------------
// The assistant message being written right now
// ---------------------------------------------------------------------------

/**
 * Resolves the overlay entry one assistant lifecycle event belongs to.
 *
 * Pi 0.84 `AssistantMessage` carries no id, so the lifecycle identity lives
 * here and is allocated once per message. Three cases, and only the third is
 * new:
 *
 * - `start` opens a message and allocates an id;
 * - `continue` / `end` reuse the open id, allocating on first sight for a
 *   lifecycle whose start was never observed;
 * - a `start` that finds a PROVISIONAL row (one no `message_start` ever
 *   framed: a mid-stream open, or a catch-up from the child's own answer
 *   snapshot) takes that row over and discards it whole, so a partial can
 *   neither survive beside the real message nor prepend itself to it.
 */
export function resolveLiveAssistantEntry(
  state: SavedChildState,
  phase: LiveAssistantLifecyclePhase,
): string {
  const provisionalId =
    phase === "start" && !state.liveAssistantFramed
      ? state.liveAssistantEntryId
      : undefined;
  if (provisionalId !== undefined) {
    state.entries = state.entries.filter((entry) => entry.id !== provisionalId);
    syncTranscriptFromEntries(state);
    // The snapshot's lifecycle is now live-owned; a later snapshot of it is
    // stale by construction rather than by resemblance.
    if (state.liveAssistantSeedId !== undefined) {
      state.liveAssistantRetiredId = state.liveAssistantSeedId;
    }
  } else if (phase === "start" || state.liveAssistantEntryId === undefined) {
    const allocated = allocateLiveAssistantEntryId(state.liveAssistantCounter);
    state.liveAssistantEntryId = allocated.entryId;
    state.liveAssistantCounter = allocated.nextCounter;
  }
  if (phase === "start") {
    state.liveAssistantText = "";
    state.liveAssistantFramed = true;
    // Live events own the row from here: it is no longer a snapshot's.
    state.liveAssistantSeedId = undefined;
  }
  return state.liveAssistantEntryId ?? "";
}

/**
 * Folds one streamed answer delta into the open lifecycle and returns the
 * canonical window entry for it.
 *
 * The window keeps the whole answer, not the last fragment: every
 * reconstruction the overlay performs replays entries, and an entry holding
 * one delta rebuilds into an empty message.
 */
export function appendLiveAssistantDelta(
  state: SavedChildState,
  entryId: string,
  delta: string,
  sequence: number,
): ChildOverlayEntry {
  // The same exact-concatenation rule the card and the tree preview use, so
  // the two surfaces cannot disagree about what the child said.
  state.liveAssistantText = boundText(
    appendAssistantStreamDelta(state.liveAssistantText, delta),
  );
  return liveAssistantStreamEntry({
    id: entryId,
    sequence,
    expanded: state.globalExpanded,
    text: state.liveAssistantText,
    framed: !state.liveAssistantFramed,
  });
}

/**
 * Releases the open lifecycle once its terminal message arrived. The terminal
 * message carries the whole answer, so the accumulated deltas go with it.
 */
export function endLiveAssistantLifecycle(state: SavedChildState): void {
  // The message the window just finished is retired, so a snapshot taken a
  // moment before it ended cannot reopen it as a live row.
  const retiring = state.liveAssistantSeedId ?? state.liveAssistantObservedId;
  if (retiring !== undefined) state.liveAssistantRetiredId = retiring;
  state.liveAssistantEntryId = undefined;
  state.liveAssistantText = "";
  state.liveAssistantFramed = false;
  state.liveAssistantSeedId = undefined;
}

/**
 * Reconciles the window with the child's own live-answer lifecycle, and
 * returns the provisional row to merge, if any.
 *
 * Correlation is by LIFECYCLE IDENTITY only. The child publishes
 * `streamedAnswer` exactly while one assistant message is open and has
 * produced text, and stamps it with that message's own id; the window
 * remembers which id it adopted. Nothing here reads, compares, or hashes the
 * answer's prose, which is what makes the two failures it replaces impossible
 * rather than unlikely:
 *
 * - a snapshot left over from a message that already ended has no
 *   `streamedAnswer` at all, so it cannot be adopted a second time;
 * - a NEW message whose text happens to equal an older terminal answer has a
 *   new id, so it is adopted rather than mistaken for the old one.
 *
 * Three further narrowings keep it from inventing or duplicating a message:
 * live children only; never while live events own the row (they are ahead of
 * any snapshot); and a row adopted from a lifecycle the child is no longer
 * writing is DROPPED rather than left behind as a stale partial.
 */
export function reconcileLiveAssistantAnswer(
  state: SavedChildState,
  child: ChildOverlayChild,
): ChildOverlayEntry | undefined {
  const answer =
    child.status === "live" && child.streamedAnswer !== undefined
      ? child.streamedAnswer
      : undefined;
  if (answer !== undefined) state.liveAssistantObservedId = answer.id;

  // A row this window adopted from a snapshot survives only while the child is
  // still writing that same message.
  if (
    state.liveAssistantSeedId !== undefined &&
    state.liveAssistantSeedId !== answer?.id
  ) {
    dropSeededLiveAssistantRow(state);
  }
  if (answer === undefined) return undefined;
  // A lifecycle this window already finished is never reopened, however
  // recently the child sampled it.
  if (answer.id === state.liveAssistantRetiredId) return undefined;
  // Live events own the row and are ahead of any snapshot of it.
  if (
    state.liveAssistantEntryId !== undefined &&
    state.liveAssistantSeedId === undefined
  ) {
    return undefined;
  }

  const text = boundText(answer.text);
  if (text.trim().length === 0) return undefined;

  if (state.liveAssistantSeedId === answer.id) {
    // Same message, more text: refresh the row in place. Nothing is added, so
    // a repeated catch-up cannot duplicate anything.
    const entryId = state.liveAssistantEntryId;
    if (entryId === undefined) return undefined;
    state.liveAssistantText = text;
    return liveAssistantStreamEntry({
      id: entryId,
      sequence: sequenceOfEntry(state, entryId),
      expanded: state.globalExpanded,
      text,
      framed: true,
    });
  }

  const allocated = allocateLiveAssistantEntryId(state.liveAssistantCounter);
  state.liveAssistantEntryId = allocated.entryId;
  state.liveAssistantCounter = allocated.nextCounter;
  state.liveAssistantText = text;
  state.liveAssistantFramed = false;
  state.liveAssistantSeedId = answer.id;
  return liveAssistantStreamEntry({
    id: allocated.entryId,
    sequence: state.entries.length,
    expanded: state.globalExpanded,
    text,
    framed: true,
  });
}

/** Removes the snapshot-adopted row and forgets the lifecycle it named. */
function dropSeededLiveAssistantRow(state: SavedChildState): void {
  const seededId = state.liveAssistantEntryId;
  if (seededId !== undefined) {
    state.entries = state.entries.filter((entry) => entry.id !== seededId);
    syncTranscriptFromEntries(state);
  }
  state.liveAssistantEntryId = undefined;
  state.liveAssistantText = "";
  state.liveAssistantFramed = false;
  state.liveAssistantSeedId = undefined;
}

/** The retained sequence of an entry, or the next one when it is gone. */
function sequenceOfEntry(state: SavedChildState, entryId: string): number {
  const found = state.entries.find((entry) => entry.id === entryId);
  return found?.sequence ?? state.entries.length;
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
