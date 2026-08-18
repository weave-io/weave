/**
 * The two modal keyboards the mounted child overlay owns: in-overlay search
 * and the cancel confirmation.
 *
 * Both are pure: a key plus the current mode yields the next mode and an
 * effect for the component to run. Keeping them out of the component is what
 * lets the precedence chain
 *
 *     cancel confirmation › search › overlay keys › draft editor
 *
 * be read as four ordered calls rather than as four inlined state machines,
 * and it lets every key rule be asserted without a TUI, a controller, or a
 * rendered frame.
 *
 * Neither machine ever reports a key as unclaimed once its mode is open: a
 * modal surface that leaks keys to the layer below is not modal.
 */
import { matchesKey } from "@earendil-works/pi-tui";
import {
  isChildOverlaySearchAliasInput,
  isChildOverlaySearchOpenInput,
  PI_CHILD_OVERLAY_SEARCH_OPEN_KEY,
} from "./child-overlay-keys.js";

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Longest search query the prompt accepts before it stops taking input. */
export const OVERLAY_SEARCH_QUERY_MAX = 120;

/** Raw terminal data the search prompt understands. */
const SEARCH_KEYS = {
  commit: ["\r", "\n"],
  cancel: "\x1b",
  backspace: ["\x7f", "\b"],
  /** `n` and `j` walk forward; `Down` is matched by key identity, not by byte. */
  nextMatch: ["n", "j"],
  /** `N` and `k` walk back; `Up` is matched by key identity, not by byte. */
  previousMatch: ["N", "k"],
} as const;

/**
 * How the overlay is routing keyboard input.
 *
 * `off` is the ordinary overlay; `typing` collects a query and consumes every
 * key; `navigate` walks committed matches. Neither open state ever forwards a
 * key to the draft editor, the key interceptor, or Pi.
 */
export type OverlaySearchMode = "off" | "typing" | "navigate";

export interface OverlaySearchState {
  readonly mode: OverlaySearchMode;
  /** The query being typed, or the last one typed while navigating. */
  readonly query: string;
  /** Signed match ordinal; the caller wraps it against the live match list. */
  readonly matchIndex: number;
  /** Enter latched a jump, so the transcript stays anchored on the match. */
  readonly accepted: boolean;
}

export const CLOSED_OVERLAY_SEARCH: OverlaySearchState = Object.freeze({
  mode: "off",
  query: "",
  matchIndex: 0,
  accepted: false,
});

const OPEN_OVERLAY_SEARCH: OverlaySearchState = Object.freeze({
  mode: "typing",
  query: "",
  matchIndex: 0,
  accepted: false,
});

export type OverlaySearchEffect =
  /** Consumed, and nothing on screen changed. */
  | { readonly kind: "none" }
  /**
   * Search re-opened on the query it already committed, to edit it again.
   *
   * It is its own effect rather than a bare repaint because a re-open is a
   * new reading: the reader has said they are done with the answer to the
   * committed query, so the pages still fetching for it lose their licence
   * BEFORE anything repaints — even if the reader types nothing afterwards.
   * A bare repaint let a page that landed between the re-open and the first
   * keystroke prepend itself, recount the rail and jump the viewport.
   */
  | { readonly kind: "reopen" }
  /**
   * The query being typed changed: match it against the loaded window, without
   * moving the viewport and without fetching history.
   *
   * This exists so the rail can never print one query and count another. The
   * rail prints the query the reader is TYPING, so the counter beside it must
   * describe that same query; before this effect existed it described the last
   * COMMITTED query - `""` until Enter - and the rail therefore answered `match
   * 0/0 · no match in this transcript` about text plainly on screen.
   */
  | { readonly kind: "preview"; readonly query: string }
  /** Run this query, then focus the first match. */
  | { readonly kind: "run"; readonly query: string }
  /** Focus the match the new `matchIndex` points at. */
  | { readonly kind: "focus" }
  /** Leave search; the query is dropped with it. */
  | { readonly kind: "close" };

export interface OverlaySearchTransition {
  /** False only when search is closed and the key is not one of its openers. */
  readonly claimed: boolean;
  readonly state: OverlaySearchState;
  readonly effect: OverlaySearchEffect;
}

const unclaimed = (state: OverlaySearchState): OverlaySearchTransition =>
  Object.freeze({ claimed: false, state, effect: { kind: "none" } as const });

const claimed = (
  state: OverlaySearchState,
  effect: OverlaySearchEffect,
): OverlaySearchTransition => Object.freeze({ claimed: true, state, effect });

/** Printable ASCII only; control sequences never edit the query. */
const isQueryText = (data: string): boolean =>
  data.length > 0 && /^[\x20-\x7e]+$/.test(data);

/**
 * One key against the search keyboard.
 *
 * `draft` gates the printable opener: `/` opens search only on an empty draft,
 * so a reader typing a steer that contains a slash keeps typing it.
 * `aliasTrigger` is the resolved `Ctrl+F` alias, or `undefined` when the host
 * already owns that key — which never removes search, because `/` still opens
 * it. Both alias readings below go through
 * {@link isChildOverlaySearchAliasInput}, so opening and re-opening can never
 * accept different encodings of the same press.
 */
export function stepOverlaySearch(
  state: OverlaySearchState,
  data: string,
  draft: string,
  aliasTrigger: string | undefined,
): OverlaySearchTransition {
  if (state.mode === "off") {
    if (!isChildOverlaySearchOpenInput(data, draft, aliasTrigger)) {
      return unclaimed(state);
    }
    // Opening starts from an empty query, and the empty query matches nothing:
    // the rail opens with no counter rather than with the previous search's.
    return claimed(OPEN_OVERLAY_SEARCH, { kind: "preview", query: "" });
  }
  // Escape closes SEARCH ONLY. The overlay stays open and the child keeps
  // running; that is the whole reason search outranks the overlay keys.
  if (data === SEARCH_KEYS.cancel || matchesKey(data, "escape")) {
    return claimed(CLOSED_OVERLAY_SEARCH, { kind: "close" });
  }
  if (isChildOverlaySearchAliasInput(data, aliasTrigger)) {
    // Re-opening from navigate mode edits the committed query again. It is
    // matched by the same authority the opener uses, because a reader whose
    // terminal sends the Kitty form opened search with it and would otherwise
    // find that the very same key no longer works once search is open.
    return claimed({ ...state, mode: "typing" }, { kind: "reopen" });
  }
  if (state.mode === "navigate") {
    if (
      SEARCH_KEYS.nextMatch.includes(data as never) ||
      matchesKey(data, "down")
    ) {
      return claimed(
        { ...state, matchIndex: state.matchIndex + 1 },
        { kind: "focus" },
      );
    }
    if (
      SEARCH_KEYS.previousMatch.includes(data as never) ||
      matchesKey(data, "up")
    ) {
      return claimed(
        { ...state, matchIndex: state.matchIndex - 1 },
        { kind: "focus" },
      );
    }
    // Every other key stays consumed: search owns the keyboard until Escape.
    return claimed(state, { kind: "none" });
  }
  // Enter and Backspace are matched SEMANTICALLY as well as by byte. Pi 0.84
  // negotiates the Kitty keyboard protocol, so a real terminal can deliver
  // Enter as `ESC [ 13 ; 1 u` and Backspace as `ESC [ 127 ; 1 u`; a byte-only
  // comparison then swallows them and search never leaves the typing mode.
  if (SEARCH_KEYS.commit.includes(data as never) || matchesKey(data, "enter")) {
    return claimed(
      { ...state, mode: "navigate", matchIndex: 0, accepted: true },
      { kind: "run", query: state.query },
    );
  }
  if (
    SEARCH_KEYS.backspace.includes(data as never) ||
    matchesKey(data, "backspace")
  ) {
    const edited = state.query.slice(0, -1);
    // A shortened query is a different query, so the counter must be recounted
    // rather than left describing the longer one.
    return claimed(
      { ...state, query: edited, matchIndex: 0 },
      { kind: "preview", query: edited },
    );
  }
  if (isQueryText(data) && state.query.length < OVERLAY_SEARCH_QUERY_MAX) {
    const edited = `${state.query}${data}`.slice(0, OVERLAY_SEARCH_QUERY_MAX);
    return claimed(
      { ...state, query: edited, matchIndex: 0 },
      { kind: "preview", query: edited },
    );
  }
  return claimed(state, { kind: "none" });
}

/** The query the rail should print for `state`, given the committed one. */
export function overlaySearchQuery(
  state: OverlaySearchState,
  committed: string,
): string {
  return state.mode === "typing" ? state.query : committed;
}

// ---------------------------------------------------------------------------
// Committed search runs
// ---------------------------------------------------------------------------

/**
 * One committed run: which search it was, whose transcript, and which reading.
 *
 * All three are captured before the run is awaited and are never re-derived,
 * so a settling run can only ever prove it is STILL the answer the reader is
 * waiting for — never make itself into one.
 *
 * `epoch` is the controller's own committed-search epoch. It is what catches
 * everything the surface cannot see: a walk to another child, a closed
 * overlay, and above all a re-open of the SAME child, which leaves both the
 * local revision and the child id identical while replacing the reading they
 * described.
 */
export interface OverlaySearchRun {
  readonly revision: number;
  readonly childId: string | undefined;
  readonly epoch: number;
}

/** What a settling run is told about the surface it is answering. */
export interface OverlaySearchRunOutcome {
  /** Still the newest committed run, on the child and reading it started on. */
  readonly current: boolean;
  /** The run the surface is still waiting on has not settled yet. */
  readonly busy: boolean;
}

/** The facts the tracker reads from the controller, both read-only. */
export interface OverlaySearchRunFocus {
  currentChildId(): string | undefined;
  /** The controller's monotonic committed-search epoch. */
  searchEpoch(): number;
}

/**
 * Which committed search run this surface is still waiting on.
 *
 * Committing a query starts bounded historical paging, and a reader does not
 * wait for it: they edit the query, re-open search, walk to another child or
 * close the inspector while it is still fetching. The controller refuses to
 * WRITE anything for a search that lost; this is the other half of the same
 * rule, on the surface side — a run the reader has moved past may not jump the
 * viewport to a match and may not take the inspector down into the fallback.
 *
 * `busy` is the CURRENT run's own state, not a count of promises. A committed
 * page read has no timeout and no cancellation: the reader who abandons a
 * search leaves its promise pending, possibly forever. Counting those in
 * flight meant one abandoned read held the whole surface busy — no steer, no
 * follow-up, no paging — long after the search the reader was actually
 * waiting on had answered. Only a run that can still act on this surface can
 * still hold it, so an abandoned or superseded promise is simply not the
 * surface's business any more.
 */
export interface OverlaySearchRunTracker {
  /** Claims the newest run for the child and reading now on screen. */
  begin(): OverlaySearchRun;
  /** Retires the newest run without starting one. */
  abandon(): void;
  /** Settles one run and states what its completion is still allowed to do. */
  settle(run: OverlaySearchRun): OverlaySearchRunOutcome;
}

export function createOverlaySearchRunTracker(
  focus: OverlaySearchRunFocus,
): OverlaySearchRunTracker {
  let revision = 0;
  /** The one run this surface is still waiting on, if any. */
  let pending: OverlaySearchRun | undefined;

  /**
   * Whether `run` still describes the search, the child AND the reading the
   * reader is looking at. Every clause is compared against a fact owned
   * elsewhere; none of them is re-derived from the run itself.
   */
  const isCurrent = (run: OverlaySearchRun): boolean =>
    run.revision === revision &&
    run.childId !== undefined &&
    focus.currentChildId() === run.childId &&
    focus.searchEpoch() === run.epoch;

  return {
    begin(): OverlaySearchRun {
      revision += 1;
      const run = Object.freeze({
        revision,
        childId: focus.currentChildId(),
        epoch: focus.searchEpoch(),
      });
      // Beginning replaces whatever the surface was waiting on: the previous
      // run is superseded by this one and can no longer hold the surface.
      pending = run;
      return run;
    },
    abandon(): void {
      revision += 1;
      pending = undefined;
    },
    settle(run: OverlaySearchRun): OverlaySearchRunOutcome {
      const current = isCurrent(run);
      // A run settles once, so it stops being awaited whether it won or lost.
      if (pending !== undefined && pending.revision === run.revision) {
        pending = undefined;
      }
      return {
        current,
        // A run the reader has moved past cannot make this surface busy, so
        // the wait ends with the reading it belonged to.
        busy: pending !== undefined && isCurrent(pending),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Cancel confirmation
// ---------------------------------------------------------------------------

/** Raw terminal data the confirmation understands. */
const CANCEL_CONFIRM_KEYS = {
  yes: ["y", "Y"],
  no: ["n", "N"],
} as const;

export type OverlayCancelConfirmAnswer =
  | "confirm"
  | "dismiss"
  /** Consumed without answering: a destructive question is never guessed at. */
  | "swallow";

/**
 * One key against the open cancel confirmation.
 *
 * The confirmation consumes every key it is open for, which is what makes `n`
 * unambiguously NO and `y` unambiguously YES: neither byte can reach search
 * (where `n` steps matches), the overlay keys, or the draft editor while the
 * question is up. Escape dismisses the question and never closes the overlay.
 */
export function answerOverlayCancelConfirm(
  data: string,
): OverlayCancelConfirmAnswer {
  if (CANCEL_CONFIRM_KEYS.yes.includes(data as never)) return "confirm";
  if (
    CANCEL_CONFIRM_KEYS.no.includes(data as never) ||
    data === SEARCH_KEYS.cancel ||
    matchesKey(data, "escape")
  ) {
    return "dismiss";
  }
  return "swallow";
}

/** Documented openers, for help text and tests. */
export const OVERLAY_SEARCH_OPEN_KEY = PI_CHILD_OVERLAY_SEARCH_OPEN_KEY;
