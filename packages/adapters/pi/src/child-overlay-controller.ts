/**
 * Child overlay controller (Spec 33 §7, plan Task 12 phase A/B).
 *
 * Owns per-child saved state and the LRU that bounds it, page/cursor
 * adoption, the rendered view projection, search, live-tail projection,
 * scroll anchoring, and run/branch navigation.
 *
 * Depends on `child-overlay-types.js` and `child-overlay-replay.js` only; it
 * never imports the native component or the `child-overlay.js` facade.
 */

import { matchesKey } from "@earendil-works/pi-tui";
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from "neverthrow";
import {
  type ChildCompactState,
  createChildCompactState,
  mapPiChildSessionEventToCompactInput,
  reduceChildCompactSafe,
} from "./child-compact-render.js";
import {
  allocateLiveAssistantEntryId,
  boundText,
  degradedCapacityEntry,
  liveAssistantLifecyclePhase,
  mergeReplaySteps,
  messageText,
  projectLiveEntry,
  transcriptFromOverlayEntries,
} from "./child-overlay-replay.js";
import {
  anchorFromScroll,
  applyMeasuredExtent,
  captureViewportForLayoutChange,
  clearTailGrowth,
  markTailGrowth,
  maxScrollRows,
  type OverlayLayoutSpan,
  type OverlayScrollState,
  restoreAfterOlderEntries,
  restoreScrollAnchor,
  scrollDelta,
} from "./child-overlay-scroll.js";
import {
  matchingEntryIds,
  matchingTerminalErrorEntryIds,
  mergeMatchIds,
  stripPathLike,
} from "./child-overlay-search.js";
import {
  applyProviderErrorEvent,
  type ChildOverlayPlanContextPort,
  deriveChildOverlayIdentity,
  deriveChildOverlayTelemetry,
  latestUsageInWindow,
  NO_TERMINAL_ERROR_EVIDENCE,
  pageEvidence,
  readChildOverlayPlanContext,
  terminalErrorOf,
  terminalErrorView,
} from "./child-overlay-telemetry.js";
import {
  CHILD_OVERLAY_BOUNDS,
  type ChildOverlayAnchor,
  type ChildOverlayChild,
  ChildOverlayChildSchema,
  type ChildOverlayConfig,
  type ChildOverlayEntry,
  type ChildOverlayError,
  type ChildOverlayFallbackMetadata,
  type ChildOverlayFallbackReason,
  type ChildOverlayFallbackRequired,
  type ChildOverlayInputOutcome,
  type ChildOverlayMutationPort,
  type ChildOverlayPage,
  type ChildOverlayReplayStep,
  type ChildOverlaySourceError,
  type ChildOverlaySourcePort,
  type ChildOverlayView,
  type ChildOverlayViewMode,
  clampPageSize,
  clampWindowCap,
  DEFAULT_CHILD_OVERLAY_VIEW_MODE,
  OverlayTextSchema,
} from "./child-overlay-types.js";
import {
  appendOverlayPage,
  dedupEntries,
  emptySaved,
  isReadOnly,
  prependOverlayPage,
  type SavedChildState,
  syncTranscriptFromEntries,
} from "./child-overlay-window.js";
import {
  type PiChildUsageReport,
  parsePiChildSessionEvent,
  parsePiChildUsageReport,
} from "./child-session-events.js";
import {
  createPiChildTranscriptState,
  type PiChildTranscriptState,
  reducePiChildTranscript,
} from "./child-transcript.js";

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class ChildOverlayController {
  private readonly source: ChildOverlaySourcePort;
  private readonly mutations: ChildOverlayMutationPort | undefined;
  private readonly pageSize: number;
  private readonly windowCap: number;
  private readonly maxLruChildren: number;
  private readonly maxSearchPages: number;
  private readonly saved = new Map<string, SavedChildState>();
  private readonly planContext: ChildOverlayPlanContextPort | undefined;
  private openChild: ChildOverlayChild | undefined;
  private clock = 0;

  constructor(
    source: ChildOverlaySourcePort,
    config: ChildOverlayConfig = {},
    mutations?: ChildOverlayMutationPort,
    planContext?: ChildOverlayPlanContextPort,
  ) {
    this.source = source;
    this.mutations = mutations;
    this.planContext = planContext;
    this.pageSize = clampPageSize(
      config.pageSize ?? CHILD_OVERLAY_BOUNDS.defaultPageSize,
    );
    this.windowCap = clampWindowCap(
      config.windowCap ?? CHILD_OVERLAY_BOUNDS.defaultWindowCap,
    );
    this.maxLruChildren = Math.max(
      1,
      Math.min(
        CHILD_OVERLAY_BOUNDS.maxLruChildren,
        config.maxLruChildren ?? CHILD_OVERLAY_BOUNDS.maxLruChildren,
      ),
    );
    this.maxSearchPages = Math.max(
      1,
      Math.min(
        CHILD_OVERLAY_BOUNDS.maxSearchPages,
        config.maxSearchPages ?? CHILD_OVERLAY_BOUNDS.maxSearchPages,
      ),
    );
  }

  isOpen(): boolean {
    return this.openChild !== undefined;
  }

  currentChildId(): string | undefined {
    return this.openChild?.childId;
  }

  view(): Result<ChildOverlayView, ChildOverlayError> {
    const child = this.openChild;
    if (child === undefined) return err({ type: "OverlayNotOpen" });
    const state = this.saved.get(child.childId);
    if (state === undefined) return err({ type: "OverlayNotOpen" });
    return ok(this.toView(child, state));
  }

  open(
    childInput: ChildOverlayChild | string,
  ): ResultAsync<ChildOverlayView, ChildOverlayError> {
    const childId =
      typeof childInput === "string" ? childInput : childInput.childId;
    if (this.openChild !== undefined && this.openChild.childId !== childId) {
      this.persistOpen();
    }
    return this.source
      .describe(childId)
      .mapErr(
        (error): ChildOverlayError =>
          error.type === "SourceUnavailable" ||
          error.type === "SourceCorrupt" ||
          error.type === "SourceStartupNotReady" ||
          error.type === "ChildNotFound"
            ? this.fallbackFromError(childId, "describe-failed", error)
            : error,
      )
      .andThen((described) => {
        const parsed = ChildOverlayChildSchema.safeParse(
          typeof childInput === "string"
            ? described
            : { ...described, ...childInput, childId },
        );
        if (!parsed.success) {
          return errAsync<ChildOverlayView, ChildOverlayError>({
            type: "OverlayInvalidChild",
            issues: parsed.error.issues.map((issue) => issue.path.join(".")),
          });
        }
        const child = parsed.data;
        this.touch(child.childId);
        const existing = this.saved.get(child.childId);
        const state = existing ?? emptySaved(child.threadId, this.clock);
        if (existing === undefined) this.saved.set(child.childId, state);
        this.openChild = child;
        this.evictLru();
        if (state.entries.length > 0) {
          return okAsync(this.toView(child, state));
        }
        return this.source
          .loadNewest(child.childId, this.pageSize)
          .orElse((error): ResultAsync<ChildOverlayPage, ChildOverlayError> => {
            // A live child often has no persisted history yet: the run is
            // still in flight, so its thread record, session ref, and native
            // session file may all arrive after the overlay is asked to open.
            // Demanding a historical page here made every real active child
            // fall back to the custom-editor inspection, which borrows the
            // primary editor from whoever owns it (for example `pi-vim`). A
            // live child therefore opens on an empty live-tail window and
            // fills from its live event stream instead.
            //
            // The recovery is deliberately narrow. Only the transient
            // `SourceStartupNotReady` gap qualifies; permission errors, root
            // violations, malformed headers, parent mismatch, and corruption
            // stay fail-closed even for a live child, and every failure for a
            // settled, orphaned, or unknown child stays fail-closed too.
            if (
              child.status !== "live" ||
              error.type !== "SourceStartupNotReady"
            ) {
              return errAsync(
                this.fallbackFromError(child.childId, "source-failed", error),
              );
            }
            return okAsync<ChildOverlayPage, ChildOverlayError>({
              entries: [],
              olderCursor: undefined,
              newerCursor: undefined,
              hasOlder: false,
              hasNewer: false,
            });
          })
          .map((page) => {
            this.applyPage(state, page, "replace");
            state.liveTail = true;
            state.scrollOffset = 0;
            state.activeRun =
              child.runs.length > 0
                ? child.runs[child.runs.length - 1]?.run
                : undefined;
            state.activeBranchId = child.branchIds[0];
            return this.toView(child, state);
          });
      });
  }

  close(): Result<void, ChildOverlayError> {
    if (this.openChild === undefined) return err({ type: "OverlayNotOpen" });
    this.persistOpen();
    this.openChild = undefined;
    return ok(undefined);
  }

  loadOlder(): ResultAsync<ChildOverlayView, ChildOverlayError> {
    return this.withOpen((child, state) => {
      if (state.olderCursor === undefined) {
        return okAsync(this.toView(child, state));
      }
      return this.source
        .loadOlder(child.childId, state.olderCursor, this.pageSize)
        .mapErr(
          (error): ChildOverlayError =>
            this.fallbackFromError(child.childId, "source-failed", error),
        )
        .map((page) => {
          this.applyPage(state, page, "prepend");
          return this.toView(child, state);
        });
    });
  }

  loadNewer(): ResultAsync<ChildOverlayView, ChildOverlayError> {
    return this.withOpen((child, state) => {
      if (state.newerCursor === undefined) {
        return okAsync(this.toView(child, state));
      }
      return this.source
        .loadNewer(child.childId, state.newerCursor, this.pageSize)
        .mapErr(
          (error): ChildOverlayError =>
            this.fallbackFromError(child.childId, "source-failed", error),
        )
        .map((page) => {
          this.applyPage(state, page, "append");
          if (state.liveTail) state.scrollOffset = 0;
          return this.toView(child, state);
        });
    });
  }

  /**
   * Searches the whole bounded historical range, not just the loaded window.
   * Stopping at the first page with a match reported a fraction of the real
   * matches and made `n` / `N` navigation skip the rest, because fetching
   * older pages trims the newest entries out of the window. Every page within
   * the existing `maxSearchPages` budget is scanned, and matches from all of
   * them are merged in transcript order without duplicates.
   */
  search(query: string): ResultAsync<ChildOverlayView, ChildOverlayError> {
    const bounded = OverlayTextSchema.safeParse(query);
    const text = bounded.success
      ? bounded.data
      : query.slice(0, CHILD_OVERLAY_BOUNDS.maxTextLength);
    return this.withOpen((child, state) => {
      state.searchQuery = text;
      state.searchMatchIds = [];
      if (text.length === 0) return okAsync(this.toView(child, state));
      const needle = text.toLowerCase();
      // Seed from the loaded window; older pages prepend ahead of it.
      state.searchMatchIds = matchingEntryIds(state.entries, needle);
      return this.searchFetchPages(child, state, needle, 0);
    });
  }
  /**
   * Fetches one older page per step until the page budget is spent or the
   * transcript start is reached. Unlike the load-more paths this never stops
   * early on a hit: a match on a newer page says nothing about older ones.
   */
  private searchFetchPages(
    child: ChildOverlayChild,
    state: SavedChildState,
    needle: string,
    pagesFetched: number,
  ): ResultAsync<ChildOverlayView, ChildOverlayError> {
    if (
      pagesFetched >= this.maxSearchPages ||
      state.olderCursor === undefined
    ) {
      return okAsync(this.toView(child, state));
    }
    return this.source
      .loadOlder(child.childId, state.olderCursor, this.pageSize)
      .mapErr(
        (error): ChildOverlayError =>
          this.fallbackFromError(child.childId, "source-failed", error),
      )
      .andThen((page) => {
        this.applyPage(state, page, "prepend");
        // `applyPage` may trim the window; a trimmed entry is still a match.
        state.searchMatchIds = mergeMatchIds(
          matchingEntryIds(page.entries, needle),
          state.searchMatchIds,
        );
        if (!page.hasOlder) return okAsync(this.toView(child, state));
        return this.searchFetchPages(child, state, needle, pagesFetched + 1);
      });
  }

  /**
   * Applies one parser-approved live child event through the Task 11 map /
   * reduce pipeline and projects a window entry when meaningful.
   */
  applyLiveEvent(event: unknown): Result<ChildOverlayView, ChildOverlayError> {
    const child = this.openChild;
    if (child === undefined) return err({ type: "OverlayNotOpen" });
    const state = this.saved.get(child.childId);
    if (state === undefined) return err({ type: "OverlayNotOpen" });
    if (child.status !== "live") {
      return ok(this.toView(child, state));
    }

    const parsed = parsePiChildSessionEvent(event);
    if (!parsed.success) return ok(this.toView(child, state));
    const applied = applyProviderErrorEvent(state.evidence, parsed.data);
    const sessionEvent = applied.event;
    state.evidence = applied.evidence;

    const mapped = mapPiChildSessionEventToCompactInput(sessionEvent);
    if (mapped.isOk() && mapped.value !== undefined) {
      state.compact = reduceChildCompactSafe(state.compact, mapped.value);
    }

    // Latest-wins: a parsed report replaces the prior one outright, while an
    // unparsable one carries no information and leaves it untouched.
    const usage = parsePiChildUsageReport(sessionEvent);
    if (usage.isOk()) state.usage = usage.value;

    // Project first so the transcript reduce can be told which overlay entry
    // this event belongs to. Reducing first would label full-layout rows with
    // reducer-local ids (`thinking-0`) while the compact layout uses overlay
    // ids (`live-thinking-0`), and a live full<->compact toggle would lose the
    // viewport anchor. Projection is pure, so ordering it earlier changes
    // nothing else.
    // Real Pi 0.84 assistant lifecycle identity. `AssistantMessage` has no
    // `id`, and `state.entries.length` changes between `message_start` and
    // `message_end`, so one stable overlay id is allocated at start and reused
    // for every update/end of that lifecycle even when thinking and tool
    // entries interleave. A lifecycle that arrives without its start
    // (historical, truncated, or unusual host sequence) allocates on first
    // sight, so update/end still share one entry instead of fanning out.
    const phase = liveAssistantLifecyclePhase(sessionEvent);
    let assistantEntryId: string | undefined;
    if (phase !== undefined) {
      if (phase === "start" || state.liveAssistantEntryId === undefined) {
        const allocated = allocateLiveAssistantEntryId(
          state.liveAssistantCounter,
        );
        state.liveAssistantEntryId = allocated.entryId;
        state.liveAssistantCounter = allocated.nextCounter;
      }
      assistantEntryId = state.liveAssistantEntryId;
    }

    const projected = projectLiveEntry(
      sessionEvent,
      state.entries.length,
      state.globalExpanded,
      assistantEntryId,
    );
    // Identity is owned by the lifecycle, not by the projection. A real Pi
    // 0.84 update can legitimately project nothing (a `thinking_delta`, or a
    // text delta that is empty once bounded), and an earlier version read the
    // id off `projected` alone: the lifecycle id was allocated, the transcript
    // action carried none, and the placeholder transcript entry stayed
    // unlabelled forever - `message_end` can only stamp entries the action it
    // accompanies created, so nothing repaired it later. Whenever the event
    // belongs to an assistant lifecycle, the transcript is told which entry it
    // belongs to. A merge into an existing window entry reuses that entry's
    // id, and the transcript only stamps entries this action created, so an
    // update never re-labels the entry it merges into.
    const overlayEntryId = assistantEntryId ?? projected?.id;

    const transcriptNext = reducePiChildTranscript(state.transcript, {
      kind: "event",
      event: sessionEvent,
      ...(overlayEntryId === undefined ? {} : { overlayEntryId }),
    });
    if (transcriptNext.isOk()) state.transcript = transcriptNext.value;

    if (projected !== undefined) {
      this.mergeEntry(state, projected);
      // The new rows land below a manually scrolled viewport; hold position
      // once the component reports how many rows they occupy.
      markTailGrowth(state);
    }
    if (state.liveTail) state.scrollOffset = 0;
    // Cleared only now: both the transcript reduce and the overlay projection
    // above needed the lifecycle identity.
    if (phase === "end") state.liveAssistantEntryId = undefined;
    return ok(this.toView(child, state));
  }

  /**
   * Record the rendered-row layout measured by the component so scroll clamping
   * uses visual rows. Only the component knows wrapped row counts, so the
   * controller cannot derive this itself.
   */
  /**
   * Adopt what the component just painted.
   *
   * `spans` describes how many rendered rows each loaded entry occupies in the
   * layout that produced `extent`. It is what lets a logical viewport survive a
   * layout change; callers that cannot measure it (tests of pure row
   * bookkeeping) may omit it and keep the previous row-only behaviour.
   */
  setScrollExtent(
    extent: number,
    spans?: readonly OverlayLayoutSpan[],
  ): Result<ChildOverlayView, ChildOverlayError> {
    return this.mutateOpen((child, state) => {
      applyMeasuredExtent(state, extent, spans);
      return this.toView(child, state);
    });
  }

  setScrollOffset(offset: number): Result<ChildOverlayView, ChildOverlayError> {
    return this.mutateOpen((child, state) => {
      const max = maxScrollRows(state);
      const next = Math.min(Math.max(0, Math.floor(offset)), max);
      state.scrollOffset = next;
      state.liveTail = next === 0;
      state.anchor = anchorFromScroll(state);
      return this.toView(child, state);
    });
  }

  scrollBy(delta: number): Result<ChildOverlayView, ChildOverlayError> {
    return this.mutateOpen((child, state) => {
      const max = maxScrollRows(state);
      const next = Math.min(
        Math.max(0, state.scrollOffset + Math.trunc(delta)),
        max,
      );
      state.scrollOffset = next;
      state.liveTail = next === 0;
      state.anchor = anchorFromScroll(state);
      return this.toView(child, state);
    });
  }

  resize(
    width: number,
    height: number,
  ): Result<ChildOverlayView, ChildOverlayError> {
    return this.mutateOpen((child, state) => {
      const anchor = state.anchor ?? anchorFromScroll(state);
      const nextWidth = Math.max(1, Math.floor(width));
      const nextHeight = Math.max(1, Math.floor(height));
      // The component calls resize on every render, so only a real geometry
      // change may drop a pending tail adjustment. Re-wrapping changes row
      // counts everywhere, and the next measured extent delta would no longer
      // isolate tail growth.
      if (nextWidth !== state.width || nextHeight !== state.height) {
        clearTailGrowth(state);
      }
      state.width = nextWidth;
      state.height = nextHeight;
      state.anchor = anchor;
      // Row counts change with width, so the next render re-measures the extent
      // and clamps. Rewriting the offset from the anchor's entry index here
      // would convert rows back into entries and pin the viewport to the tail.
      return this.toView(child, state);
    });
  }

  toggleGlobalExpansion(): Result<ChildOverlayView, ChildOverlayError> {
    return this.mutateOpen((child, state) => {
      state.globalExpanded = !state.globalExpanded;
      state.entries = state.entries.map((entry) => ({
        ...entry,
        expanded: state.globalExpanded,
      }));
      // Keep the rendered transcript visibility in lockstep with the overlay
      // window without rebuilding (live thinking/tool rows must stay).
      state.transcript = {
        ...state.transcript,
        entries: state.transcript.entries.map((entry) => ({
          ...entry,
          expanded: state.globalExpanded,
        })),
      };
      return this.toView(child, state);
    });
  }

  /**
   * Flips this child between the full transcript and the compact one-line
   * projection.
   *
   * Entry state is untouched: compact is a render-time projection, so nothing
   * is dropped or rewritten here.
   *
   * The two layouts do not share a row coordinate system — full can render many
   * rows for an entry that compact renders in one — so the current rendered-row
   * offset is meaningless in the target layout and is never carried over. The
   * logical viewport (the entry at the viewport bottom, plus the row inside it)
   * is captured instead and re-placed once the target layout has been measured.
   * The measured extent and spans are discarded to force that re-measure, and
   * any pending tail adjustment is dropped because its delta would no longer
   * isolate tail growth.
   */
  toggleViewMode(): Result<ChildOverlayView, ChildOverlayError> {
    return this.mutateOpen((child, state) => {
      state.viewMode = state.viewMode === "compact" ? "full" : "compact";
      clearTailGrowth(state);
      captureViewportForLayoutChange(state);
      state.anchor = state.pendingViewportAnchor ?? state.anchor;
      state.scrollExtent = undefined;
      return this.toView(child, state);
    });
  }

  navigateRun(delta: number): Result<ChildOverlayView, ChildOverlayError> {
    return this.mutateOpen((child, state) => {
      const runs = child.runs;
      if (runs.length === 0) return this.toView(child, state);
      const currentIndex = Math.max(
        0,
        runs.findIndex((run) => run.run === state.activeRun),
      );
      const nextIndex = Math.min(
        runs.length - 1,
        Math.max(0, currentIndex + Math.trunc(delta)),
      );
      state.activeRun = runs[nextIndex]?.run;
      return this.toView(child, state);
    });
  }

  navigateBranch(delta: number): Result<ChildOverlayView, ChildOverlayError> {
    return this.mutateOpen((child, state) => {
      const branches = child.branchIds;
      if (branches.length === 0) return this.toView(child, state);
      const currentIndex = Math.max(
        0,
        branches.findIndex((id) => id === state.activeBranchId),
      );
      const nextIndex = Math.min(
        branches.length - 1,
        Math.max(0, currentIndex + Math.trunc(delta)),
      );
      state.activeBranchId = branches[nextIndex];
      return this.toView(child, state);
    });
  }

  updateDraft(draft: string): Result<ChildOverlayView, ChildOverlayError> {
    const bounded = OverlayTextSchema.safeParse(draft);
    const text = bounded.success
      ? bounded.data
      : draft.slice(0, CHILD_OVERLAY_BOUNDS.maxTextLength);
    return this.mutateOpen((child, state) => {
      if (isReadOnly(child)) return this.toView(child, state);
      state.draft = text;
      return this.toView(child, state);
    });
  }

  submitSteer(
    submittedText: string,
  ): ResultAsync<ChildOverlayInputOutcome, ChildOverlayError> {
    return this.submitDraftMutation("steer", submittedText);
  }

  submitFollowUp(
    submittedText: string,
  ): ResultAsync<ChildOverlayInputOutcome, ChildOverlayError> {
    return this.submitDraftMutation("follow-up", submittedText);
  }

  /**
   * Consumes every key while mounted. Never routes text or keys to a primary
   * editor. Settled/orphan children are read-only for mutation actions.
   */
  handleInput(
    data: string,
  ): ResultAsync<ChildOverlayInputOutcome, ChildOverlayError> {
    const child = this.openChild;
    if (child === undefined) {
      return errAsync({ type: "OverlayNotOpen" });
    }
    const state = this.saved.get(child.childId);
    if (state === undefined) {
      return errAsync({ type: "OverlayNotOpen" });
    }

    const scroll = scrollDelta(data);
    if (scroll !== undefined) {
      if (scroll === "oldest") {
        state.scrollOffset = maxScrollRows(state);
        state.liveTail = state.scrollOffset === 0;
      } else if (scroll === "follow") {
        state.scrollOffset = 0;
        state.liveTail = true;
      } else {
        state.scrollOffset = Math.min(
          Math.max(0, state.scrollOffset + scroll),
          maxScrollRows(state),
        );
        state.liveTail = state.scrollOffset === 0;
      }
      state.anchor = anchorFromScroll(state);
      return okAsync({ kind: "scroll", scrollOffset: state.scrollOffset });
    }

    if (matchesKey(data, "enter")) {
      return this.submitSteer(state.draft);
    }

    if (matchesKey(data, "alt+enter")) {
      return this.submitFollowUp(state.draft);
    }

    if (matchesKey(data, "ctrl+e") || data === "\x05") {
      const toggled = this.toggleGlobalExpansion();
      if (toggled.isErr()) return errAsync(toggled.error);
      return okAsync({
        kind: "expanded",
        globalExpanded: toggled.value.globalExpanded,
      });
    }

    // `Ctrl+O` is deliberately absent: it is Pi's own tool-expand action, and
    // the overlay has a single view, so Weave claims it nowhere.

    if (data === "\x1b[1;3D" || matchesKey(data, "alt+left")) {
      const nav = this.navigateRun(-1);
      if (nav.isErr()) return errAsync(nav.error);
      return okAsync({ kind: "navigate-run", activeRun: nav.value.activeRun });
    }
    if (data === "\x1b[1;3C" || matchesKey(data, "alt+right")) {
      const nav = this.navigateRun(1);
      if (nav.isErr()) return errAsync(nav.error);
      return okAsync({ kind: "navigate-run", activeRun: nav.value.activeRun });
    }
    if (data === "\x1b[1;3A" || matchesKey(data, "alt+up")) {
      const nav = this.navigateBranch(-1);
      if (nav.isErr()) return errAsync(nav.error);
      return okAsync({
        kind: "navigate-branch",
        activeBranchId: nav.value.activeBranchId,
      });
    }
    if (data === "\x1b[1;3B" || matchesKey(data, "alt+down")) {
      const nav = this.navigateBranch(1);
      if (nav.isErr()) return errAsync(nav.error);
      return okAsync({
        kind: "navigate-branch",
        activeBranchId: nav.value.activeBranchId,
      });
    }

    // Everything else is consumed and changes nothing here. Draft text is
    // owned by the overlay's editor component, which knows where the cursor
    // is; it mirrors the resulting text back through `updateDraft`. Rebuilding
    // the draft from raw bytes at this layer could only ever append at the end
    // and delete from the end, which is not editing.
    return okAsync({ kind: "consumed" });
  }

  /**
   * Explicit render-boundary failure used by a later TUI layer. Returns only
   * bounded metadata + transcript model — never exception text or paths.
   */
  requireFallback(
    reason: ChildOverlayFallbackReason = "render-failed",
  ): ChildOverlayFallbackRequired {
    const child = this.openChild;
    const state =
      child !== undefined ? this.saved.get(child.childId) : undefined;
    return {
      kind: "fallback-required",
      metadata: {
        childId: child?.childId ?? "unknown",
        threadId: child?.threadId ?? "unknown",
        status: child?.status ?? "settled",
        entryCount: state?.entries.length ?? 0,
        reason,
        readOnly: child === undefined ? true : isReadOnly(child),
      },
      ...(state === undefined ? {} : terminalErrorView(state.evidence)),
      transcript: state?.transcript ?? createPiChildTranscriptState(),
    };
  }

  private submitDraftMutation(
    kind: "steer" | "follow-up",
    submittedText: string,
  ): ResultAsync<ChildOverlayInputOutcome, ChildOverlayError> {
    const child = this.openChild;
    if (child === undefined) return errAsync({ type: "OverlayNotOpen" });
    const state = this.saved.get(child.childId);
    if (state === undefined) return errAsync({ type: "OverlayNotOpen" });
    if (isReadOnly(child) || !child.generationId) {
      return okAsync({ kind: "consumed" });
    }
    const bounded = OverlayTextSchema.safeParse(submittedText.trim());
    const text = bounded.success
      ? bounded.data
      : submittedText.trim().slice(0, CHILD_OVERLAY_BOUNDS.maxTextLength);
    if (text.length === 0) return okAsync({ kind: "consumed" });

    const draftAtSubmit = state.draft;
    const clearSubmittedDraft = (): void => {
      if (state.draft === draftAtSubmit) state.draft = "";
    };
    const outcome = (): ChildOverlayInputOutcome => ({
      kind,
      childId: child.childId,
      text,
    });
    const mutation = this.mutations;
    if (mutation === undefined) {
      clearSubmittedDraft();
      return okAsync(outcome());
    }
    const request =
      kind === "steer"
        ? mutation.steer(child.childId, child.generationId, text)
        : mutation.followUp(child.childId, child.generationId, text);
    return request
      .map(() => {
        clearSubmittedDraft();
        return outcome();
      })
      .mapErr(
        (): ChildOverlayError =>
          this.fallbackFromError(child.childId, "render-failed", {
            type: "SourceUnavailable",
            operation: kind,
          }),
      );
  }

  private withOpen(
    fn: (
      child: ChildOverlayChild,
      state: SavedChildState,
    ) => ResultAsync<ChildOverlayView, ChildOverlayError>,
  ): ResultAsync<ChildOverlayView, ChildOverlayError> {
    const child = this.openChild;
    if (child === undefined) return errAsync({ type: "OverlayNotOpen" });
    const state = this.saved.get(child.childId);
    if (state === undefined) return errAsync({ type: "OverlayNotOpen" });
    this.touch(child.childId);
    return fn(child, state);
  }

  private mutateOpen(
    fn: (child: ChildOverlayChild, state: SavedChildState) => ChildOverlayView,
  ): Result<ChildOverlayView, ChildOverlayError> {
    const child = this.openChild;
    if (child === undefined) return err({ type: "OverlayNotOpen" });
    const state = this.saved.get(child.childId);
    if (state === undefined) return err({ type: "OverlayNotOpen" });
    this.touch(child.childId);
    return ok(fn(child, state));
  }

  private persistOpen(): void {
    const child = this.openChild;
    if (child === undefined) return;
    const state = this.saved.get(child.childId);
    if (state !== undefined) state.lastTouched = ++this.clock;
  }

  private touch(childId: string): void {
    const state = this.saved.get(childId);
    if (state !== undefined) state.lastTouched = ++this.clock;
  }

  private evictLru(): void {
    while (this.saved.size > this.maxLruChildren) {
      let victim: string | undefined;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [id, state] of this.saved) {
        if (id === this.openChild?.childId) continue;
        if (state.lastTouched < oldest) {
          oldest = state.lastTouched;
          victim = id;
        }
      }
      if (victim === undefined) break;
      this.saved.delete(victim);
    }
  }

  private applyPage(
    state: SavedChildState,
    page: ChildOverlayPage,
    mode: "replace" | "prepend" | "append",
  ): void {
    const incoming = page.entries.map((entry) => ({
      ...entry,
      expanded: state.globalExpanded,
      text: stripPathLike(entry.text),
    }));
    const priorAnchor = state.anchor ?? anchorFromScroll(state);

    if (mode === "replace") {
      state.entries = dedupEntries(incoming).slice(-this.windowCap);
      state.olderCursor = page.olderCursor;
      state.newerCursor = page.newerCursor;
      state.hasOlderFlag = page.hasOlder;
      state.hasNewerFlag = page.hasNewer;
      syncTranscriptFromEntries(state);
      // Historical telemetry may come only from a usage event replayed in the
      // loaded window; a window without one leaves a live report untouched.
      state.usage = latestUsageInWindow(state.entries) ?? state.usage;
      state.evidence = pageEvidence(state.evidence, state.entries, "newer");
      return;
    }

    if (mode === "prepend") {
      prependOverlayPage(state, page, incoming, priorAnchor, this.windowCap);
      return;
    }
    appendOverlayPage(state, page, incoming, priorAnchor, this.windowCap);
  }

  private mergeEntry(state: SavedChildState, entry: ChildOverlayEntry): void {
    const index = state.entries.findIndex((item) => item.id === entry.id);
    if (index >= 0) {
      const existing = state.entries[index];
      const next = [...state.entries];
      const mergedReplay = mergeReplaySteps(existing?.replay, entry.replay);
      if (mergedReplay.isErr()) {
        next[index] = degradedCapacityEntry(
          entry.id,
          entry.sequence,
          mergedReplay.error,
        );
        state.entries = next;
        return;
      }
      next[index] = {
        ...entry,
        expanded: state.globalExpanded,
        replay: mergedReplay.value,
      };
      state.entries = next;
      return;
    }
    const merged = dedupEntries([
      ...state.entries,
      { ...entry, expanded: state.globalExpanded },
    ]);
    const retained = merged.slice(-this.windowCap);
    const trimmed = retained.length < merged.length;
    state.entries = retained;
    // Live append keeps the incremental transcript reduce; only rebuild when
    // the window trims so stale older transcript rows cannot outlive entries.
    if (trimmed) syncTranscriptFromEntries(state);
  }

  private toView(
    child: ChildOverlayChild,
    state: SavedChildState,
  ): ChildOverlayView {
    const needle = state.searchQuery.trim().toLowerCase();
    const terminalError = terminalErrorOf(state.evidence);
    const terminalErrorMatches = matchingTerminalErrorEntryIds(
      state.transcript.entries,
      terminalError,
      needle,
    );
    const searchMatches =
      needle.length === 0
        ? []
        : mergeMatchIds(
            mergeMatchIds(
              state.searchMatchIds,
              matchingEntryIds(state.entries, needle),
            ),
            terminalErrorMatches,
          );
    return {
      child,
      entries: state.entries,
      draft: state.draft,
      searchQuery: state.searchQuery,
      searchMatches,
      scrollOffset: state.scrollOffset,
      scrollExtent: maxScrollRows(state),
      liveTail: state.liveTail,
      globalExpanded: state.globalExpanded,
      activeRun: state.activeRun,
      activeBranchId: state.activeBranchId,
      olderCursor: state.olderCursor,
      newerCursor: state.newerCursor,
      hasOlder: state.hasOlderFlag,
      hasNewer: state.hasNewerFlag,
      readOnly: isReadOnly(child),
      width: state.width,
      height: state.height,
      anchor: state.anchor,
      viewMode: state.viewMode,
      compact: state.compact,
      transcript: state.transcript,
      telemetry: deriveChildOverlayTelemetry(state.usage, child),
      identity: deriveChildOverlayIdentity(child),
      planContext: readChildOverlayPlanContext(this.planContext),
      ...(terminalError === undefined ? {} : { terminalError }),
    };
  }

  private fallbackFromError(
    childId: string,
    reason: ChildOverlayFallbackReason,
    error: ChildOverlaySourceError,
  ): ChildOverlayFallbackRequired {
    const child = this.openChild;
    const state = this.saved.get(childId);
    const metadata: ChildOverlayFallbackMetadata = {
      childId,
      threadId: child?.threadId ?? childId,
      status: child?.status ?? "settled",
      entryCount: state?.entries.length ?? 0,
      reason,
      readOnly: child === undefined ? true : isReadOnly(child),
      sourceErrorType: error.type, // discriminant only, never free-form
    };
    // Ensure no path-like strings leak through error channels.
    return {
      kind: "fallback-required",
      metadata,
      ...(state === undefined ? {} : terminalErrorView(state.evidence)),
      transcript: state?.transcript ?? createPiChildTranscriptState(),
    };
  }
}

export function createChildOverlayController(
  source: ChildOverlaySourcePort,
  config?: ChildOverlayConfig,
  mutations?: ChildOverlayMutationPort,
  planContext?: ChildOverlayPlanContextPort,
): ChildOverlayController {
  return new ChildOverlayController(source, config, mutations, planContext);
}
