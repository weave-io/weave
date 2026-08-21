/**
 * Everything the overlay's search owns that is not a rendered row: text
 * normalization, the match helpers, and the COMMITTED search itself — the one
 * overlay read that spans several awaits.
 *
 * The text helpers live outside `child-overlay-replay.ts` on purpose: `biome
 * check --write` rewrites that module's `String.raw` control-character pattern
 * into a regex literal and then rejects its own fix, so every commit that
 * touches it fails the pre-commit hook. Keeping the search helpers here leaves
 * that module untouched.
 */
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import { boundText } from "./child-overlay-replay.js";
import type {
  ChildOverlayChild,
  ChildOverlayError,
  ChildOverlayPage,
  ChildOverlaySourceError,
  ChildOverlayView,
} from "./child-overlay-types.js";
import type { SavedChildState } from "./child-overlay-window.js";
import type { PiChildProviderError } from "./child-provider-error.js";
import { formatPiChildProviderError } from "./child-provider-error-render.js";
import { PI_MODEL_FAILOVER_MARKER_TYPE } from "./model-failover-contract.js";

/** Bounded entry text with absolute path prefixes removed. */
export function stripPathLike(value: string): string {
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

/**
 * Ids of entries whose rendered text contains the lowercased needle, in the
 * order given. Matching uses the same {@link stripPathLike} normalization the
 * window applies, so a page scanned before it is merged matches exactly what
 * the reader sees afterwards.
 *
 * `rendered` is the ANSI-free transcript index keyed by the same entry
 * identity (see `overlayTranscriptSearchIndex`). It is what makes search agree
 * with the screen: the window entry's own `text` is a short projection — a
 * tool entry carries only its tool name — while the reader is looking at the
 * rendered rows. Both are matched, so nothing that matched before stops
 * matching and everything on screen starts matching.
 */
export function matchingEntryIds(
  entries: readonly {
    readonly id: string;
    readonly text: string;
    /** Optional exact native-event type for defensive marker suppression. */
    readonly originalType?: string;
  }[],
  needle: string,
  rendered?: ReadonlyMap<string, string>,
): string[] {
  const result: string[] = [];
  for (const entry of entries) {
    // Suppress only the exact durable recovery marker. A broad `weave.*`
    // filter would hide user-visible custom entries that share the namespace.
    if (entry.originalType === PI_MODEL_FAILOVER_MARKER_TYPE) continue;
    if (stripPathLike(entry.text).toLowerCase().includes(needle)) {
      result.push(entry.id);
      continue;
    }
    const visible = rendered?.get(entry.id);
    if (
      visible !== undefined &&
      stripPathLike(visible).toLowerCase().includes(needle)
    ) {
      result.push(entry.id);
    }
  }
  return result;
}

/** Match the canonical visible terminal error to its transcript entry. */
export function matchingTerminalErrorEntryIds(
  entries: readonly {
    readonly kind: string;
    readonly overlayEntryId?: string;
    readonly terminalError?: PiChildProviderError;
  }[],
  error: PiChildProviderError | undefined,
  needle: string,
): string[] {
  if (
    error === undefined ||
    !formatPiChildProviderError(error).toLowerCase().includes(needle)
  ) {
    return [];
  }
  const entryId = [...entries]
    .reverse()
    .find(
      (entry) =>
        entry.kind === "assistant" && entry.terminalError !== undefined,
    )?.overlayEntryId;
  return entryId === undefined ? [] : [entryId];
}

/** Concatenates two ordered id lists, keeping the first occurrence of each. */
export function mergeMatchIds(
  older: readonly string[],
  newer: readonly string[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of [...older, ...newer]) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

// ---------------------------------------------------------------------------
// The committed search
// ---------------------------------------------------------------------------

/**
 * What one committed search's asynchronous paging is allowed to write to.
 *
 * Committing a query starts bounded historical paging: one older page per
 * step, each one a real source read. A reader does not wait for it. They edit
 * the query, re-open search, walk to another child, or close the inspector
 * while a page is still on its way, and the answer to a query nobody is asking
 * lands afterwards.
 *
 * The token is that answer's licence to write: an IMMUTABLE child identity plus
 * the monotonic revision the search was committed on, captured before the first
 * read and re-checked after every await. It is never mutated and never
 * re-derived from current state, so a late page can only ever prove it is still
 * the search in charge — never make itself current.
 */
interface CommittedSearchToken {
  readonly childId: string;
  readonly revision: number;
}

/** The still-current child and window a committed search may write to. */
interface CommittedSearchTarget {
  readonly child: ChildOverlayChild;
  readonly state: SavedChildState;
}

/** One fetched older page, or the news that the search lost its licence. */
type CommittedSearchPage =
  | { readonly kind: "page"; readonly page: ChildOverlayPage }
  | { readonly kind: "superseded" };

/**
 * The controller-owned facts and effects a committed search borrows.
 *
 * Everything here is state the CONTROLLER owns: which child is open, that
 * child's saved window, how a page is merged into it, how a view is projected,
 * and what a source failure becomes. The committed search owns only the
 * question of whether it is still allowed to use any of them.
 */
export interface CommittedSearchPort {
  /** Older pages one committed search may fetch before it stops. */
  readonly maxPages: number;
  readonly pageSize: number;
  readonly openChild: () => ChildOverlayChild | undefined;
  readonly savedState: (childId: string) => SavedChildState | undefined;
  readonly loadOlder: (
    childId: string,
    cursor: string,
    pageSize: number,
  ) => ResultAsync<ChildOverlayPage, ChildOverlaySourceError>;
  /** Merges one older page into the window it was fetched for. */
  readonly prependPage: (
    state: SavedChildState,
    page: ChildOverlayPage,
  ) => void;
  readonly view: (
    child: ChildOverlayChild,
    state: SavedChildState,
  ) => ChildOverlayView;
  /** The typed failure a live source read turns into. */
  readonly sourceFailed: (
    childId: string,
    error: ChildOverlaySourceError,
  ) => ChildOverlayError;
}

export interface CommittedSearch {
  /**
   * Retires every committed search still in flight.
   *
   * Called by everything that makes an earlier search the wrong answer: a
   * query edit, a new commit, closing or re-opening the search, opening a
   * child, and closing the overlay.
   */
  invalidate(): void;
  /**
   * The epoch a committed search must still belong to in order to write.
   *
   * This is the SAME monotonic counter the token carries, published read-only
   * and as one plain number. It exists because the controller is not the only
   * thing a late page can damage: the surface owns the viewport jump and the
   * fallback, and it cannot see a child walk or an overlay close that happened
   * on the controller alone. Carrying this epoch in the surface's own run
   * token is what lets it apply exactly the same rule to exactly the same
   * reading, instead of a weaker local approximation of it.
   *
   * Reading it can never make anything current: it is a getter with no
   * argument and no effect, and only {@link CommittedSearch.invalidate} and a
   * new reading move it.
   */
  epoch(): number;
  /**
   * Runs the bounded historical paging for a query just committed against
   * `child`, seeded from the loaded window.
   */
  run(
    child: ChildOverlayChild,
    state: SavedChildState,
    needle: string,
  ): ResultAsync<ChildOverlayView, ChildOverlayError>;
}

export function createCommittedSearch(
  port: CommittedSearchPort,
): CommittedSearch {
  let revision = 0;

  const tokenNow = (childId: string): CommittedSearchToken =>
    Object.freeze({ childId, revision });

  /**
   * The child and window `token` may still write to, or `undefined`.
   *
   * Both halves are load-bearing. The revision catches a query edit, a second
   * commit, a search close and a re-open of the same child; the child identity
   * catches a walk to another child, whose window belongs to a different
   * reading altogether.
   */
  const target = (
    token: CommittedSearchToken,
  ): CommittedSearchTarget | undefined => {
    if (revision !== token.revision) return undefined;
    const child = port.openChild();
    if (child === undefined || child.childId !== token.childId)
      return undefined;
    const state = port.savedState(child.childId);
    return state === undefined ? undefined : { child, state };
  };

  /**
   * What a search that lost resolves to: the view the reader is ACTUALLY
   * looking at, with nothing merged, nothing paged and no viewport moved.
   *
   * It stays inside the existing contract — the same view every search returns,
   * and the same `OverlayNotOpen` a closed overlay already answers with — so a
   * superseded completion reads as an ordinary no-op to every caller instead of
   * as a new failure mode they must learn.
   */
  const superseded = (): ResultAsync<ChildOverlayView, ChildOverlayError> => {
    const child = port.openChild();
    const state =
      child === undefined ? undefined : port.savedState(child.childId);
    if (child === undefined || state === undefined) {
      return errAsync<ChildOverlayView, ChildOverlayError>({
        type: "OverlayNotOpen",
      });
    }
    return okAsync(port.view(child, state));
  };

  /**
   * One older page for a committed search, or the news that it was superseded
   * while the source was answering.
   *
   * The check straddles BOTH outcomes on purpose. A page that arrives late may
   * not be merged, and a read that FAILS late may not be turned into a fallback
   * either: that failure collapses the whole inspector into the custom-editor
   * inspection, and a query nobody is looking at may not take the surface down
   * with it.
   */
  const loadOlderPage = (
    token: CommittedSearchToken,
    cursor: string,
  ): ResultAsync<CommittedSearchPage, ChildOverlayError> =>
    port
      .loadOlder(token.childId, cursor, port.pageSize)
      .map(
        (page): CommittedSearchPage =>
          target(token) === undefined
            ? { kind: "superseded" }
            : { kind: "page", page },
      )
      .orElse(
        (error): ResultAsync<CommittedSearchPage, ChildOverlayError> =>
          target(token) === undefined
            ? okAsync<CommittedSearchPage, ChildOverlayError>({
                kind: "superseded",
              })
            : errAsync(port.sourceFailed(token.childId, error)),
      );

  /**
   * Fetches one older page per step until the page budget is spent or the
   * transcript start is reached. Unlike the load-more paths this never stops
   * early on a hit: a match on a newer page says nothing about older ones.
   *
   * Nothing is captured across an await. The child and the window are resolved
   * from `token` before the read is issued and AGAIN before anything is
   * written, so a late page cannot prepend into a window, merge its ids into a
   * counter, restore a viewport around its own entries, or return a child that
   * the reader has since replaced.
   */
  const fetchPages = (
    token: CommittedSearchToken,
    needle: string,
    pagesFetched: number,
  ): ResultAsync<ChildOverlayView, ChildOverlayError> => {
    const active = target(token);
    if (active === undefined) return superseded();
    const cursor = active.state.olderCursor;
    if (pagesFetched >= port.maxPages || cursor === undefined) {
      return okAsync(port.view(active.child, active.state));
    }
    return loadOlderPage(token, cursor).andThen((fetched) => {
      if (fetched.kind === "superseded") return superseded();
      const current = target(token);
      if (current === undefined) return superseded();
      const { child, state } = current;
      port.prependPage(state, fetched.page);
      // The prepend may trim the window; a trimmed entry is still a match.
      state.searchMatchIds = mergeMatchIds(
        matchingEntryIds(fetched.page.entries, needle),
        state.searchMatchIds,
      );
      if (!fetched.page.hasOlder) return okAsync(port.view(child, state));
      return fetchPages(token, needle, pagesFetched + 1);
    });
  };

  return {
    invalidate(): void {
      revision += 1;
    },
    epoch(): number {
      return revision;
    },
    run(child, state, needle) {
      // Seed from the loaded window; older pages prepend ahead of it.
      state.searchMatchIds = matchingEntryIds(
        state.entries,
        needle,
        state.renderedSearchText,
      );
      return fetchPages(tokenNow(child.childId), needle, 0);
    },
  };
}
