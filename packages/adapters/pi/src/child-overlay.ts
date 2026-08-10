/**
 * Bounded full-screen child overlay facade (Spec 33 §7, plan Task 12 phases
 * A–B1).
 *
 * Owns the overlay source adapters and re-exports the overlay runtime that is
 * split across focused modules:
 *
 * - {@link ./child-overlay-types.js} — bounds, opaque schemas, overlay types
 * - {@link ./child-overlay-replay.js} — native entry → replay mapping
 * - {@link ./child-overlay-controller.js} — pagination, search, live-tail, LRU
 * - {@link ./child-overlay-component.js} — Pi TUI custom component + fallback
 *
 * Imports flow types → replay → controller → component → this facade; no
 * overlay module imports this file, so the runtime graph stays acyclic.
 *
 * Historical pages adapt Task 4 {@link PiNativeSessionStore.readSessionEntryPage}
 * output through {@link mapNativeSessionEntryToOverlay} without copying
 * transcript bytes into adapter storage and without ever materializing a full
 * transcript. Live events use the shared Task 11 parser + compact map / reduce
 * pipeline, then project into the overlay window via the existing
 * child-transcript reducer.
 */

import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from "neverthrow";
import type {
  PiNativeSessionEntryPage,
  PiNativeSessionEntryPageOptions,
  PiNativeSessionError,
} from "./child-native-sessions.js";
import {
  boundLabel,
  boundText,
  degradedCapacityEntry,
  mapNativeSessionEntryToOverlay,
  pushReplayEvent,
  safeEntryId,
} from "./child-overlay-replay.js";
import {
  CHILD_OVERLAY_BOUNDS,
  type ChildOverlayChild,
  ChildOverlayChildSchema,
  type ChildOverlayEntry,
  type ChildOverlayPage,
  type ChildOverlayReplayStep,
  type ChildOverlaySourceError,
  type ChildOverlaySourcePort,
  clampPageSize,
  OpaqueCursorSchema,
} from "./child-overlay-types.js";
import type {
  PiChildTranscriptEntry,
  PiChildTranscriptState,
} from "./child-transcript.js";
import type { PiAdapterFailure } from "./errors.js";

/**
 * Maps a delegation-controller failure onto the overlay source error that
 * describes it.
 *
 * Every branch stays inside the fallback-classified source errors, so the
 * overlay still falls back to the custom editor exactly as before; only the
 * reported reason changes. Collapsing every controller failure into
 * `ChildNotFound` made an absent thread source, a corrupt thread record, and a
 * genuinely unknown child indistinguishable in `/weave:health`, which is the
 * distinction a live run needs to name its blocker.
 *
 * Nothing but the failure discriminant and its bounded reason is read, and the
 * only identifier that crosses into the result is the child id the caller
 * already supplied.
 */
export function mapPiDelegationFailureToOverlaySourceError(
  failure: PiAdapterFailure,
  childId: string,
): ChildOverlaySourceError {
  if (failure.code === "ThreadNotFound") {
    // Only `refs-unavailable` means the source itself could not be consulted;
    // an unknown or origin-mismatched thread really is "no such child here".
    return failure.correlation?.["reason"] === "refs-unavailable"
      ? { type: "SourceUnavailable", operation: "describe" }
      : { type: "ChildNotFound", childId };
  }
  if (failure.code === "ThreadIntegrityError") {
    return { type: "SourceCorrupt", operation: "describe" };
  }
  return { type: "SourceUnavailable", operation: "describe" };
}

// ---------------------------------------------------------------------------
// In-memory source helper (tests + adapters that already hold entry pages)
// ---------------------------------------------------------------------------

export interface MemoryOverlaySourceEntry {
  readonly id: string;
  readonly payload: unknown;
}

export interface MemoryOverlaySourceChild extends ChildOverlayChild {
  readonly entries: readonly MemoryOverlaySourceEntry[];
}

/**
 * Creates a {@link ChildOverlaySourcePort} over an in-memory child catalog.
 * Pagination uses opaque cursors that encode entry ids only (never paths).
 */
export function createMemoryChildOverlaySource(
  children: readonly MemoryOverlaySourceChild[],
): ChildOverlaySourcePort {
  const byId = new Map(children.map((child) => [child.childId, child]));

  const pageFrom = (
    child: MemoryOverlaySourceChild,
    startInclusive: number,
    endExclusive: number,
  ): ChildOverlayPage => {
    const slice = child.entries.slice(startInclusive, endExclusive);
    const mapped: ChildOverlayEntry[] = [];
    for (let i = 0; i < slice.length; i += 1) {
      const item = slice[i];
      if (item === undefined) continue;
      const mappedEntry = mapNativeSessionEntryToOverlay(
        item.payload,
        startInclusive + i,
      );
      if (mappedEntry.isErr()) {
        mapped.push({
          ...degradedCapacityEntry(
            item.id,
            startInclusive + i,
            mappedEntry.error,
          ),
          id: item.id,
        });
        continue;
      }
      if (mappedEntry.value === undefined) continue;
      mapped.push({ ...mappedEntry.value, id: item.id });
    }
    // Cursors address the oldest/newest entry already in the page so the next
    // loadOlder/loadNewer call continues contiguously (exclusive of that edge).
    const olderCursor =
      startInclusive > 0 ? child.entries[startInclusive]?.id : undefined;
    const newerCursor =
      endExclusive < child.entries.length && endExclusive > startInclusive
        ? child.entries[endExclusive - 1]?.id
        : undefined;
    return {
      entries: mapped,
      olderCursor,
      newerCursor,
      hasOlder: startInclusive > 0,
      hasNewer: endExclusive < child.entries.length,
    };
  };

  const indexOf = (
    child: MemoryOverlaySourceChild,
    cursor: string,
  ): Result<number, ChildOverlaySourceError> => {
    const parsed = OpaqueCursorSchema.safeParse(cursor);
    if (!parsed.success) {
      return err({ type: "SourceInvalidCursor", operation: "page" });
    }
    const index = child.entries.findIndex((entry) => entry.id === parsed.data);
    if (index < 0) {
      return err({ type: "SourceInvalidCursor", operation: "page" });
    }
    return ok(index);
  };

  return {
    describe(childId) {
      const child = byId.get(childId);
      if (child === undefined) {
        return errAsync({ type: "ChildNotFound", childId });
      }
      const parsed = ChildOverlayChildSchema.safeParse({
        childId: child.childId,
        threadId: child.threadId,
        parentChildId: child.parentChildId,
        status: child.status,
        title: child.title,
        generationId: child.generationId,
        runs: child.runs,
        branchIds: child.branchIds,
        descendantChildIds: child.descendantChildIds,
      });
      if (!parsed.success) {
        return errAsync({
          type: "SourceCorrupt",
          operation: "describe",
        });
      }
      return okAsync(parsed.data);
    },
    loadNewest(childId, pageSize) {
      const child = byId.get(childId);
      if (child === undefined) {
        return errAsync({ type: "ChildNotFound", childId });
      }
      const size = clampPageSize(pageSize);
      const end = child.entries.length;
      const start = Math.max(0, end - size);
      return okAsync(pageFrom(child, start, end));
    },
    loadOlder(childId, cursor, pageSize) {
      const child = byId.get(childId);
      if (child === undefined) {
        return errAsync({ type: "ChildNotFound", childId });
      }
      const index = indexOf(child, cursor);
      if (index.isErr()) return errAsync(index.error);
      const size = clampPageSize(pageSize);
      // Cursor is the oldest entry already loaded; load strictly older than it.
      const end = index.value;
      const start = Math.max(0, end - size);
      return okAsync(pageFrom(child, start, end));
    },
    loadNewer(childId, cursor, pageSize) {
      const child = byId.get(childId);
      if (child === undefined) {
        return errAsync({ type: "ChildNotFound", childId });
      }
      const index = indexOf(child, cursor);
      if (index.isErr()) return errAsync(index.error);
      const size = clampPageSize(pageSize);
      // Cursor is the newest entry already loaded; load strictly newer than it.
      const start = index.value + 1;
      const end = Math.min(child.entries.length, start + size);
      return okAsync(pageFrom(child, start, end));
    },
  };
}

/**
 * Maps one Task 4 bounded native entry page into an overlay page.
 *
 * Opaque older/newer cursors pass through unchanged. Corrupt lines become
 * bounded `unknown` facts. No full transcript is retained.
 */
export function mapNativeSessionEntryPageToOverlay(
  page: PiNativeSessionEntryPage,
): ChildOverlayPage {
  const mapped: ChildOverlayEntry[] = [];
  for (const item of page.entries) {
    if (item.kind === "corrupt") {
      const corruptSteps: ChildOverlayReplayStep[] = [];
      void pushReplayEvent(corruptSteps, {
        type: "unknown",
        originalType: "corrupt",
        payload: { reason: boundLabel(item.reason) },
      });
      mapped.push({
        id: safeEntryId(`corrupt-${item.offset}`, `corrupt-${item.offset}`),
        sequence: item.offset,
        kind: "unknown",
        text: boundText(`corrupt:${item.reason}`),
        expanded: false,
        replay: corruptSteps,
      });
      continue;
    }
    const entry = mapNativeSessionEntryToOverlay(item.value, item.offset);
    if (entry.isErr()) {
      mapped.push(
        degradedCapacityEntry(
          safeEntryId(`capacity-${item.offset}`, `capacity-${item.offset}`),
          item.offset,
          entry.error,
        ),
      );
      continue;
    }
    if (entry.value !== undefined) mapped.push(entry.value);
  }
  return {
    entries: mapped,
    olderCursor: page.olderCursor,
    newerCursor: page.newerCursor,
    hasOlder: page.olderCursor !== undefined,
    hasNewer: page.newerCursor !== undefined,
  };
}

function mapNativePageError(
  error: PiNativeSessionError,
  operation: string,
): ChildOverlaySourceError {
  if (
    error.type === "SessionCorrupt" &&
    (error.reason === "invalid-cursor" || error.reason === "stale-cursor")
  ) {
    return { type: "SourceInvalidCursor", operation };
  }
  if (error.type === "SessionMissing") {
    // The child's thread record, session ref, or native session file has not
    // been written yet. Everything else - permission errors, root violations,
    // malformed headers, parent mismatch, corruption - stays `SourceCorrupt`.
    return { type: "SourceStartupNotReady", operation };
  }
  return { type: "SourceCorrupt", operation };
}

/**
 * Adapts Task 4 `readSessionEntryPage` into a paginated overlay source.
 *
 * Each page request performs one injected bounded native page read — never
 * `readSessionEntries`, `SessionManager.getEntries`, or a full-file cache.
 * Opaque older/newer cursors are forwarded verbatim. The overlay controller
 * still retains only its hard in-memory window.
 */
export function createReadSessionEntryPageOverlaySource(deps: {
  readonly describe: (
    childId: string,
  ) => ResultAsync<ChildOverlayChild, ChildOverlaySourceError>;
  readonly readSessionEntryPage: (
    childId: string,
    options: PiNativeSessionEntryPageOptions,
  ) => ResultAsync<PiNativeSessionEntryPage, PiNativeSessionError>;
}): ChildOverlaySourcePort {
  const loadPage = (
    childId: string,
    options: PiNativeSessionEntryPageOptions,
    operation: string,
  ): ResultAsync<ChildOverlayPage, ChildOverlaySourceError> =>
    deps
      .readSessionEntryPage(childId, options)
      .map(mapNativeSessionEntryPageToOverlay)
      .mapErr((error) => mapNativePageError(error, operation));

  return {
    describe: deps.describe,
    loadNewest(childId, pageSize) {
      return loadPage(
        childId,
        { direction: "newest", limit: clampPageSize(pageSize) },
        "loadNewest",
      );
    },
    loadOlder(childId, cursor, pageSize) {
      const parsed = OpaqueCursorSchema.safeParse(cursor);
      if (!parsed.success) {
        return errAsync({
          type: "SourceInvalidCursor",
          operation: "loadOlder",
        });
      }
      return loadPage(
        childId,
        {
          direction: "older",
          cursor: parsed.data,
          limit: clampPageSize(pageSize),
        },
        "loadOlder",
      );
    },
    loadNewer(childId, cursor, pageSize) {
      const parsed = OpaqueCursorSchema.safeParse(cursor);
      if (!parsed.success) {
        return errAsync({
          type: "SourceInvalidCursor",
          operation: "loadNewer",
        });
      }
      return loadPage(
        childId,
        {
          direction: "newer",
          cursor: parsed.data,
          limit: clampPageSize(pageSize),
        },
        "loadNewer",
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Public overlay runtime surface (re-exported from the focused modules)
// ---------------------------------------------------------------------------

export {
  createChildOverlayCustomComponent,
  createChildOverlayDraftEditor,
  PI_CHILD_OVERLAY_CUSTOM_OPTIONS,
  type PiChildOverlayCustomComponent,
} from "./child-overlay-component.js";
export {
  ChildOverlayController,
  createChildOverlayController,
} from "./child-overlay-controller.js";
export {
  mapNativeSessionEntryToOverlay,
  mergeChildOverlayReplaySteps,
  transcriptFromOverlayEntries,
} from "./child-overlay-replay.js";
export type {
  ChildOverlayAnchor,
  ChildOverlayChild,
  ChildOverlayConfig,
  ChildOverlayEntry,
  ChildOverlayEntryKind,
  ChildOverlayError,
  ChildOverlayFallbackMetadata,
  ChildOverlayFallbackReason,
  ChildOverlayFallbackRequired,
  ChildOverlayInputOutcome,
  ChildOverlayMappingError,
  ChildOverlayMutationPort,
  ChildOverlayPage,
  ChildOverlayReplayStep,
  ChildOverlayRunDivider,
  ChildOverlaySourceError,
  ChildOverlaySourceErrorType,
  ChildOverlaySourcePort,
  ChildOverlayStatus,
  ChildOverlayView,
} from "./child-overlay-types.js";
export {
  CHILD_OVERLAY_BOUNDS,
  ChildOverlayChildSchema,
  ChildOverlayRunDividerSchema,
  ChildOverlayStatusSchema,
} from "./child-overlay-types.js";

/** Re-export transcript entry type for handoff consumers. */
export type { PiChildTranscriptEntry, PiChildTranscriptState };
