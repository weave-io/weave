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
  boundText,
  degradedCapacityEntry,
  mergeReplaySteps,
  messageText,
  nonEmptyString,
  recordOf,
  safeEntryId,
  transcriptFromOverlayEntries,
} from "./child-overlay-replay.js";
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
  clampPageSize,
  clampWindowCap,
  OverlayTextSchema,
  SCROLL_KEYS,
  SCROLL_PAGE,
} from "./child-overlay-types.js";
import {
  type PiChildSessionEvent,
  parsePiChildSessionEvent,
} from "./child-session-events.js";
import {
  createPiChildTranscriptState,
  type PiChildTranscriptEntry,
  type PiChildTranscriptState,
  reducePiChildTranscript,
} from "./child-transcript.js";

// ---------------------------------------------------------------------------
// Per-child saved state (LRU)
// ---------------------------------------------------------------------------

interface SavedChildState {
  draft: string;
  searchQuery: string;
  scrollOffset: number;
  liveTail: boolean;
  globalExpanded: boolean;
  activeRun: number | undefined;
  activeBranchId: string | undefined;
  olderCursor: string | undefined;
  newerCursor: string | undefined;
  hasOlderFlag: boolean;
  hasNewerFlag: boolean;
  entries: ChildOverlayEntry[];
  compact: ChildCompactState;
  transcript: PiChildTranscriptState;
  anchor: ChildOverlayAnchor | undefined;
  width: number;
  height: number;
  lastTouched: number;
}

function emptySaved(threadId: string, touched: number): SavedChildState {
  return {
    draft: "",
    searchQuery: "",
    scrollOffset: 0,
    liveTail: true,
    globalExpanded: false,
    activeRun: undefined,
    activeBranchId: undefined,
    olderCursor: undefined,
    newerCursor: undefined,
    hasOlderFlag: false,
    hasNewerFlag: false,
    entries: [],
    compact: createChildCompactState(threadId),
    transcript: createPiChildTranscriptState(),
    anchor: undefined,
    width: 80,
    height: 24,
    lastTouched: touched,
  };
}

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
  private openChild: ChildOverlayChild | undefined;
  private clock = 0;

  constructor(
    source: ChildOverlaySourcePort,
    config: ChildOverlayConfig = {},
    mutations?: ChildOverlayMutationPort,
  ) {
    this.source = source;
    this.mutations = mutations;
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
          .mapErr(
            (error): ChildOverlayError =>
              this.fallbackFromError(child.childId, "source-failed", error),
          )
          .orElse((error): ResultAsync<ChildOverlayPage, ChildOverlayError> => {
            // A live child usually has no readable historical page yet: the
            // run is still in flight, so its thread record, session ref, and
            // native session file may all arrive after the overlay is asked
            // to open. Demanding a historical page here made every real
            // active child fall back to the custom-editor inspection, which
            // borrows the primary editor from whoever owns it (for example
            // `pi-vim`). A live child therefore opens on an empty live-tail
            // window and fills from its live event stream instead.
            //
            // Settled, orphaned, and unknown children keep the fail-closed
            // fallback: for them an unreadable source is a real gap, not a
            // race with their own startup.
            if (child.status !== "live") return errAsync(error);
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

  search(query: string): ResultAsync<ChildOverlayView, ChildOverlayError> {
    const bounded = OverlayTextSchema.safeParse(query);
    const text = bounded.success
      ? bounded.data
      : query.slice(0, CHILD_OVERLAY_BOUNDS.maxTextLength);
    return this.withOpen((child, state) => {
      state.searchQuery = text;
      if (text.length === 0) {
        return okAsync(this.toView(child, state));
      }
      const needle = text.toLowerCase();
      if (
        state.entries.some((entry) => entry.text.toLowerCase().includes(needle))
      ) {
        return okAsync(this.toView(child, state));
      }
      return this.searchFetchPages(child, state, needle, 0);
    });
  }

  private searchFetchPages(
    child: ChildOverlayChild,
    state: SavedChildState,
    needle: string,
    pagesFetched: number,
  ): ResultAsync<ChildOverlayView, ChildOverlayError> {
    if (
      pagesFetched >= this.maxSearchPages ||
      state.olderCursor === undefined ||
      state.entries.some((entry) => entry.text.toLowerCase().includes(needle))
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
    const sessionEvent = parsed.data;

    const mapped = mapPiChildSessionEventToCompactInput(sessionEvent);
    if (mapped.isOk() && mapped.value !== undefined) {
      state.compact = reduceChildCompactSafe(state.compact, mapped.value);
    }

    const transcriptNext = reducePiChildTranscript(state.transcript, {
      kind: "event",
      event: sessionEvent,
    });
    if (transcriptNext.isOk()) state.transcript = transcriptNext.value;

    const projected = projectLiveEntry(
      sessionEvent,
      state.entries.length,
      state.globalExpanded,
    );
    if (projected !== undefined) {
      this.mergeEntry(state, projected);
    }
    if (state.liveTail) state.scrollOffset = 0;
    return ok(this.toView(child, state));
  }

  setScrollOffset(offset: number): Result<ChildOverlayView, ChildOverlayError> {
    return this.mutateOpen((child, state) => {
      const max = Math.max(0, state.entries.length);
      const next = Math.min(Math.max(0, Math.floor(offset)), max);
      state.scrollOffset = next;
      state.liveTail = next === 0;
      state.anchor = anchorFromScroll(state);
      return this.toView(child, state);
    });
  }

  scrollBy(delta: number): Result<ChildOverlayView, ChildOverlayError> {
    return this.mutateOpen((child, state) => {
      const max = Math.max(0, state.entries.length);
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
      state.width = Math.max(1, Math.floor(width));
      state.height = Math.max(1, Math.floor(height));
      state.anchor = anchor;
      if (anchor !== undefined) {
        const index = state.entries.findIndex(
          (entry) => entry.id === anchor.entryId,
        );
        if (index >= 0) {
          state.scrollOffset = Math.max(0, state.entries.length - 1 - index);
          state.liveTail = state.scrollOffset === 0;
        }
      }
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
        state.scrollOffset = Math.max(0, state.entries.length);
        state.liveTail = false;
      } else if (scroll === "follow") {
        state.scrollOffset = 0;
        state.liveTail = true;
      } else {
        state.scrollOffset = Math.min(
          Math.max(0, state.scrollOffset + scroll),
          Math.max(0, state.entries.length),
        );
        state.liveTail = state.scrollOffset === 0;
      }
      state.anchor = anchorFromScroll(state);
      return okAsync({ kind: "scroll", scrollOffset: state.scrollOffset });
    }

    if (matchesKey(data, "enter")) {
      if (isReadOnly(child) || !child.generationId) {
        return okAsync({ kind: "consumed" });
      }
      const text = state.draft.trim();
      if (text.length === 0) return okAsync({ kind: "consumed" });
      state.draft = "";
      const mutation = this.mutations;
      if (mutation === undefined) {
        return okAsync({
          kind: "steer",
          childId: child.childId,
          text,
        });
      }
      return mutation
        .steer(child.childId, child.generationId, text)
        .map(() => ({
          kind: "steer" as const,
          childId: child.childId,
          text,
        }))
        .mapErr(
          (): ChildOverlayError =>
            this.fallbackFromError(child.childId, "render-failed", {
              type: "SourceUnavailable",
              operation: "steer",
            }),
        );
    }

    if (matchesKey(data, "alt+enter")) {
      if (isReadOnly(child) || !child.generationId) {
        return okAsync({ kind: "consumed" });
      }
      const text = state.draft.trim();
      if (text.length === 0) return okAsync({ kind: "consumed" });
      state.draft = "";
      const mutation = this.mutations;
      if (mutation === undefined) {
        return okAsync({
          kind: "follow-up",
          childId: child.childId,
          text,
        });
      }
      return mutation
        .followUp(child.childId, child.generationId, text)
        .map(() => ({
          kind: "follow-up" as const,
          childId: child.childId,
          text,
        }))
        .mapErr(
          (): ChildOverlayError =>
            this.fallbackFromError(child.childId, "render-failed", {
              type: "SourceUnavailable",
              operation: "follow-up",
            }),
        );
    }

    if (matchesKey(data, "ctrl+e") || data === "\x05") {
      const toggled = this.toggleGlobalExpansion();
      if (toggled.isErr()) return errAsync(toggled.error);
      return okAsync({
        kind: "expanded",
        globalExpanded: toggled.value.globalExpanded,
      });
    }

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

    // All other input updates the overlay draft (or is swallowed). Never leak.
    if (!isReadOnly(child) && data.length > 0 && !data.startsWith("\x1b")) {
      if (data === "\x7f" || data === "\b") {
        state.draft = state.draft.slice(0, -1);
      } else if (!data.includes("\x00")) {
        const next = boundText(state.draft + data);
        state.draft = next;
      }
      return okAsync({ kind: "draft-updated", draft: state.draft });
    }

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
      transcript: state?.transcript ?? createPiChildTranscriptState(),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

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
      return;
    }

    if (mode === "prepend") {
      // Prepend only entries not already retained. Middle-overlapping pages
      // (resume from a page newer/older boundary inside the window) must not
      // reorder the chronological window via naive [...incoming, ...state].
      const existingIds = new Set(state.entries.map((entry) => entry.id));
      const uniqueOlder = incoming.filter(
        (entry) => !existingIds.has(entry.id),
      );
      const merged = dedupEntries([...uniqueOlder, ...state.entries]);
      // Keep fetched older entries; trim the newest tail when over cap.
      const retained = merged.slice(0, this.windowCap);
      const trimmedNewest = merged.length - retained.length;

      state.entries = retained;
      // Always adopt the page older boundary. Overlapping pages must still
      // advance the opaque cursor so loadOlder can reach the start.
      state.olderCursor = page.olderCursor;
      state.hasOlderFlag = page.hasOlder;
      if (trimmedNewest > 0) {
        // Never substitute retained entry ids for source opaque cursors.
        // The page newer cursor is the boundary that can reload trimmed newer
        // entries; when nothing was trimmed, keep the existing newer cursor.
        state.newerCursor = page.newerCursor;
        state.hasNewerFlag = true;
        state.liveTail = false;
      }
      restoreScrollAnchor(state, priorAnchor);
      syncTranscriptFromEntries(state);
      return;
    }

    const existingIds = new Set(state.entries.map((entry) => entry.id));
    const uniqueNewer = incoming.filter((entry) => !existingIds.has(entry.id));
    const merged = dedupEntries([...state.entries, ...uniqueNewer]);
    // Append keeps the newest side; trim the oldest head when over cap.
    const retained = merged.slice(-this.windowCap);
    const trimmedOldest = merged.length - retained.length;

    state.entries = retained;
    if (trimmedOldest > 0) {
      // Never substitute retained entry ids for source opaque cursors.
      // The page older cursor reloads trimmed older entries; when nothing was
      // trimmed, keep the existing older cursor.
      state.olderCursor = page.olderCursor;
      state.hasOlderFlag = true;
    }
    // Always adopt the page newer boundary. Overlapping pages (common after
    // prepend trim, which resumes from the older page's newer cursor) must
    // still advance the opaque cursor so loadNewer can reach the tip.
    state.newerCursor = page.newerCursor;
    state.hasNewerFlag = page.hasNewer;
    restoreScrollAnchor(state, priorAnchor);
    syncTranscriptFromEntries(state);
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
    const searchMatches =
      needle.length === 0
        ? []
        : state.entries
            .filter((entry) => entry.text.toLowerCase().includes(needle))
            .map((entry) => entry.id);
    return {
      child,
      entries: state.entries,
      draft: state.draft,
      searchQuery: state.searchQuery,
      searchMatches,
      scrollOffset: state.scrollOffset,
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
      compact: state.compact,
      transcript: state.transcript,
    };
  }

  private fallbackFromError(
    childId: string,
    reason: ChildOverlayFallbackReason,
    _error: ChildOverlaySourceError,
  ): ChildOverlayFallbackRequired {
    void _error;
    const child = this.openChild;
    const state = this.saved.get(childId);
    const metadata: ChildOverlayFallbackMetadata = {
      childId,
      threadId: child?.threadId ?? childId,
      status: child?.status ?? "settled",
      entryCount: state?.entries.length ?? 0,
      reason,
      readOnly: child === undefined ? true : isReadOnly(child),
    };
    // Ensure no path-like strings leak through error channels.
    return {
      kind: "fallback-required",
      metadata,
      transcript: state?.transcript ?? createPiChildTranscriptState(),
    };
  }
}

function isReadOnly(child: ChildOverlayChild): boolean {
  return child.status === "settled" || child.status === "orphan";
}

function dedupEntries(
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
 * resolve after the rebuild; scroll anchors are owned by {@link restoreScrollAnchor}.
 */
function syncTranscriptFromEntries(state: SavedChildState): void {
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

function stripPathLike(value: string): string {
  // Drop absolute path prefixes that would leak storage locations.
  return boundText(
    value
      .replace(
        /(?:^|[\s"])(?:\/(?:Users|home|var|tmp|private)\/\S+)/gu,
        " [path]",
      )
      .replace(/(?:[A-Za-z]:\\[^\s"]+)/gu, " [path]"),
  );
}

function anchorFromScroll(
  state: SavedChildState,
): ChildOverlayAnchor | undefined {
  if (state.entries.length === 0) return undefined;
  const index = Math.max(
    0,
    Math.min(
      state.entries.length - 1,
      state.entries.length - 1 - state.scrollOffset,
    ),
  );
  const entry = state.entries[index];
  if (entry === undefined) return undefined;
  return { entryId: entry.id, lineOffset: 0 };
}

/** Recompute scrollOffset so a retained entry stays the logical viewport anchor. */
function restoreScrollAnchor(
  state: SavedChildState,
  anchor: ChildOverlayAnchor | undefined,
): void {
  if (anchor === undefined || state.entries.length === 0) {
    state.anchor = anchorFromScroll(state);
    return;
  }
  const index = state.entries.findIndex((entry) => entry.id === anchor.entryId);
  if (index < 0) {
    // Anchor was trimmed; clamp to the nearest retained edge.
    state.scrollOffset = Math.min(
      state.scrollOffset,
      Math.max(0, state.entries.length - 1),
    );
    state.liveTail = state.scrollOffset === 0;
    state.anchor = anchorFromScroll(state);
    return;
  }
  state.scrollOffset = Math.max(0, state.entries.length - 1 - index);
  state.liveTail = state.scrollOffset === 0;
  state.anchor = { entryId: anchor.entryId, lineOffset: anchor.lineOffset };
}

function scrollDelta(data: string): number | "oldest" | "follow" | undefined {
  if (data === SCROLL_KEYS.pageUp) return SCROLL_PAGE;
  if (data === SCROLL_KEYS.pageDown) return -SCROLL_PAGE;
  if (data === SCROLL_KEYS.shiftUp) return 1;
  if (data === SCROLL_KEYS.shiftDown) return -1;
  if (data === SCROLL_KEYS.home) return "oldest";
  if (data === SCROLL_KEYS.end) return "follow";
  return undefined;
}

function projectLiveEntry(
  event: PiChildSessionEvent,
  sequence: number,
  expanded: boolean,
): ChildOverlayEntry | undefined {
  const replay: readonly ChildOverlayReplayStep[] = [{ kind: "event", event }];
  switch (event.type) {
    case "message_start":
    case "message_update":
    case "message_end": {
      let text = "";
      if (event.type === "message_end") {
        text = messageText(event.message).text;
      } else if (event.type === "message_update") {
        const deltaText = (event as { delta?: { text?: string } }).delta?.text;
        if (typeof deltaText === "string") {
          text = boundText(deltaText);
        }
      }
      const id = liveAssistantEntryId(event, sequence);
      if (event.type === "message_update" && text.length === 0)
        return undefined;
      return {
        id,
        sequence,
        kind: "assistant",
        text,
        expanded,
        // A streaming delta is transcript-neutral on rebuild: its terminal
        // `message_end` carries the whole message, so replaying the delta too
        // would append the same text twice.
        replay: event.type === "message_update" ? [] : replay,
      };
    }
    case "text":
    case "markdown":
      return {
        id: `live-text-${sequence}`,
        sequence,
        kind: "assistant",
        text: boundText(typeof event.text === "string" ? event.text : ""),
        expanded,
        replay,
      };
    case "thinking":
      return {
        id: `live-thinking-${sequence}`,
        sequence,
        kind: "thinking",
        text: boundText(typeof event.text === "string" ? event.text : ""),
        expanded,
        replay,
      };
    case "tool_call":
    case "tool_partial_result":
    case "tool_result":
    case "tool_error": {
      const toolId =
        typeof event.toolCallId === "string" && event.toolCallId.length > 0
          ? safeEntryId(event.toolCallId, `live-tool-${sequence}`)
          : `live-tool-${sequence}`;
      return {
        id: toolId,
        sequence,
        kind: event.type === "tool_error" ? "error" : "tool",
        text: boundText(
          typeof event.toolName === "string" ? event.toolName : event.type,
        ),
        expanded,
        replay,
      };
    }
    case "retry":
      return {
        id: `live-retry-${sequence}`,
        sequence,
        kind: "retry",
        text: boundText(
          `retry ${event.attempt ?? "?"} ${event.reason ?? ""}`.trim(),
        ),
        runNumber:
          typeof event.attempt === "number" ? event.attempt : undefined,
        expanded,
        replay,
      };
    case "image":
      return {
        id: `live-image-${sequence}`,
        sequence,
        kind: "image",
        text: "image",
        expanded,
        replay,
      };
    case "status":
      return {
        id: `live-status-${sequence}`,
        sequence,
        kind: "status",
        text: boundText(
          typeof event.status === "string" ? event.status : "status",
        ),
        expanded,
        replay,
      };
    default:
      return undefined;
  }
}

/**
 * Resolves the assistant entry id from the message the event carries so a
 * `message_start` and its `message_end` project one window entry instead of
 * two, matching the single assistant entry the transcript reducer keeps.
 */
function liveAssistantEntryId(
  event: PiChildSessionEvent,
  sequence: number,
): string {
  const record = event as unknown as Record<string, unknown>;
  const message = recordOf(record.message);
  const delta = recordOf(record.delta);
  const assistantEvent = recordOf(record.assistantMessageEvent);
  const id =
    nonEmptyString(message?.id) ??
    nonEmptyString(delta?.messageId) ??
    nonEmptyString(delta?.id) ??
    nonEmptyString(assistantEvent?.messageId);
  return id === undefined
    ? `live-assistant-${sequence}`
    : safeEntryId(id, `live-assistant-${sequence}`);
}

export function createChildOverlayController(
  source: ChildOverlaySourcePort,
  config?: ChildOverlayConfig,
  mutations?: ChildOverlayMutationPort,
): ChildOverlayController {
  return new ChildOverlayController(source, config, mutations);
}
