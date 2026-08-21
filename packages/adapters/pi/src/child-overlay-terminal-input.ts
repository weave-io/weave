/**
 * Ownership-independent raw terminal-input route for Task 13 overlay keys.
 *
 * `pi.registerShortcut` is dispatched by Pi's *default* editor, so when
 * another extension (for example `pi-vim`) owns the primary editor the
 * registered handlers never fire. Pi's TUI consults extension terminal-input
 * listeners before every component, overlay, and shortcut route, so a single
 * listener is the editor-ownership-independent route to the same dispatch.
 *
 * This module owns everything that route needs: reading it from a possibly
 * invalidated session context, binding exactly one *proven live* listener,
 * retrying a binding for an already-applied plan, and releasing it on
 * teardown. It depends only on the narrow
 * {@link PiChildOverlayTerminalInputState} slice of the overlay-keys cell and
 * on the ports in {@link PiChildOverlayTerminalInputDeps}; it never reaches
 * into the inspection runtime, so generation ownership stays with the caller.
 */
import { isKeyRelease, type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { Result } from "neverthrow";
import {
  classifyChildOverlayKey,
  PI_CHILD_OVERLAY_KEY_BOUNDS,
  type PiChildOverlayAction,
  type PiChildOverlayKeyPlan,
} from "./child-overlay-keys.js";
import { SCROLL_KEYS } from "./child-overlay-types.js";
import type { PiSessionContext, PiTerminalInputHandler } from "./types.js";

/**
 * Longest raw frame this route will even try to classify as scrolling.
 *
 * Every scroll frame is a short CSI sequence; the longest event-aware Kitty
 * form in the wild is well under this. Bounding the input keeps a pasted
 * block or a bracketed-paste payload from being walked by the key parser on
 * every keystroke, and makes the normalizer's cost independent of input size.
 */
const MAX_SCROLL_FRAME_LENGTH = 32;

/**
 * Semantic scroll aliases, in the order they are matched.
 *
 * Each entry maps a *semantic* key identity - what the user pressed, however
 * their terminal chose to encode it - onto the one canonical frame the rest
 * of Weave's overlay stack already understands ({@link SCROLL_KEYS}).
 *
 * Shift+Up / Shift+Down are the conflict-safe terminal aliases for paging:
 * they resolve to canonical PageUp / PageDown so one press moves a page and
 * reaches the component's existing bounded older/newer pagination at the
 * viewport edges, rather than crawling one rendered row at a time.
 */
const SCROLL_ALIASES: readonly {
  readonly key: KeyId;
  readonly canonical: string;
}[] = [
  { key: "pageUp", canonical: SCROLL_KEYS.pageUp },
  { key: "pageDown", canonical: SCROLL_KEYS.pageDown },
  { key: "shift+up", canonical: SCROLL_KEYS.pageUp },
  { key: "shift+down", canonical: SCROLL_KEYS.pageDown },
  { key: "home", canonical: SCROLL_KEYS.home },
  { key: "end", canonical: SCROLL_KEYS.end },
];

/**
 * Canonical overlay scroll frame for a raw terminal frame, or none.
 *
 * Pi 0.83 negotiates the Kitty keyboard protocol (flags including event
 * types), so a real PTY delivers Shift+Up as the event-aware form
 * `ESC [ 1;2:1 A` rather than the legacy `ESC [ 1;2 A`. Comparing raw bytes
 * against {@link SCROLL_KEYS} therefore rejected every live scroll press and
 * the mounted overlay never moved. Matching *semantically* through Pi TUI's
 * own `matchesKey` accepts legacy, disambiguated, and event-aware encodings
 * alike, and collapsing the match back onto a canonical frame means nothing
 * downstream - the scroll model, the controller, the component - has to
 * learn about terminal encodings at all.
 *
 * Release frames are ignored. With event reporting active a single physical
 * press arrives as press *and* release; treating both as scroll input would
 * silently double every page.
 *
 * Returns `undefined` for everything else, including repeat-only ambiguity,
 * terminal reports such as the incidental `ESC [ 6;38;15 t` size probe,
 * ordinary text, and unrecognized CSI sequences.
 */
export function normalizeChildOverlayScrollFrame(
  data: string,
): string | undefined {
  if (data.length === 0 || data.length > MAX_SCROLL_FRAME_LENGTH) {
    return undefined;
  }
  if (isKeyRelease(data)) return undefined;
  for (const alias of SCROLL_ALIASES) {
    if (matchesKey(data, alias.key)) return alias.canonical;
  }
  return undefined;
}

/**
 * Whether a raw frame is one of the overlay scroll frames.
 *
 * Delegates to {@link normalizeChildOverlayScrollFrame} so the mounted
 * overlay and this route can never disagree about which frames belong to
 * scrolling, whatever encoding the terminal used. Anything else, from
 * ordinary text to an unrecognized CSI sequence, is not a scroll frame.
 */
export function isChildOverlayScrollFrame(data: string): boolean {
  return normalizeChildOverlayScrollFrame(data) !== undefined;
}

/**
 * The overlay-keys state this module reads and owns.
 *
 * Deliberately structural and narrow: the full overlay-keys cell satisfies it,
 * but nothing here can reach the plan machinery, the interceptor, or the
 * mounted overlay.
 */
export interface PiChildOverlayTerminalInputState {
  status: "pending" | "applied";
  plan: PiChildOverlayKeyPlan | undefined;
  /** Unsubscribe handle for the live listener, or none when unbound. */
  terminalInput: (() => void) | undefined;
  /**
   * The host UI object the listener was last installed on, or none.
   *
   * Kept for teardown bookkeeping and diagnostics only. It is deliberately
   * *not* evidence of liveness: Pi 0.83 clears extension listeners without
   * replacing this object.
   */
  terminalInputHost: unknown;
  diagnostics: readonly string[];
  generationId: string | undefined;
}

export interface PiChildOverlayTerminalInputDeps {
  readonly state: PiChildOverlayTerminalInputState;
  /** The most recent session context, or none when no session is live. */
  readonly latestSessionCtx: () => PiSessionContext | undefined;
  /** Whether the native overlay is mounted and owns raw input itself. */
  readonly isOverlayOpen: () => boolean;
  /** The generation the live session belongs to, or none. */
  readonly activeGenerationId: () => string | undefined;
  /** Runs one overlay key action against the generation that owns it. */
  readonly dispatchOverlayAction: (
    action: PiChildOverlayAction,
    generationId: string,
  ) => void;
  /**
   * Hands one raw overlay scroll frame to the mounted overlay of the
   * generation that owns it, reporting whether it was actually delivered.
   *
   * `false` means "not delivered" for every reason - no mounted component, a
   * generation that is no longer current, a stale session context, a throwing
   * dispatch target - and the frame is then left on its existing host route
   * rather than silently swallowed.
   */
  readonly dispatchOverlayScroll: (
    data: string,
    generationId: string,
  ) => boolean;
}

export interface PiChildOverlayTerminalInputBinder {
  /**
   * Installs the listener for a generation when one is missing, appending any
   * degraded reason to the caller's bounded diagnostic buffer.
   */
  readonly bind: (generationId: string, diagnostics: string[]) => void;
  /**
   * Re-installs the listener for an already-applied plan, keeping the cell's
   * bounded diagnostics free of repeated identical lines.
   */
  readonly retry: (generationId: string) => void;
}

/**
 * Removes the raw terminal-input listener, if one is installed.
 *
 * Unlike raw shortcut registration - which Pi keeps for the extension
 * lifetime and which therefore must never be repeated - the listener is owned
 * by Weave, so it is released whenever the state behind it goes away. A
 * released cell re-installs exactly one listener on the next registration.
 */
export function releaseChildOverlayTerminalInput(
  state: PiChildOverlayTerminalInputState,
): void {
  const unsubscribe = state.terminalInput;
  state.terminalInput = undefined;
  state.terminalInputHost = undefined;
  if (unsubscribe === undefined) return;
  Result.fromThrowable(
    () => unsubscribe(),
    () => "terminal_input_release_failed" as const,
  )().match(
    () => undefined,
    () => undefined,
  );
}

export function createChildOverlayTerminalInputBinder(
  deps: PiChildOverlayTerminalInputDeps,
): PiChildOverlayTerminalInputBinder {
  const state = deps.state;
  /**
   * Monotonic id of the listener this binder currently owns.
   *
   * Only the handler installed by the most recent successful `bind` acts; a
   * closure from an earlier binding returns without touching any route.
   */
  let installedEpoch = 0;

  /**
   * Resolves the live raw-input route, or `undefined` when there is none.
   *
   * Pi exposes `ctx.ui` through a getter that calls `assertActive()` and
   * throws once the extension runner has been marked stale, so a context
   * retained from a replaced session can throw on plain property access.
   * Reading it through `Result.fromThrowable` keeps an invalidated host from
   * throwing out of a lifecycle callback and degrades it to "no route", which
   * is exactly what an invalidated context is.
   *
   * The returned `ui` is the host object itself, recorded on the state only
   * so teardown and diagnostics can name the host the listener went to.
   */
  const readTerminalInputRoute = ():
    | {
        readonly ui: unknown;
        readonly subscribe: (handler: PiTerminalInputHandler) => () => void;
      }
    | undefined =>
    Result.fromThrowable(
      () => {
        const ctx = deps.latestSessionCtx();
        if (ctx === undefined) return undefined;
        const ui = ctx.ui;
        const subscribe = ui.onTerminalInput;
        if (subscribe === undefined) return undefined;
        return {
          ui,
          subscribe: (handler: PiTerminalInputHandler) =>
            subscribe.call(ui, handler),
        };
      },
      () => undefined,
    )().match(
      (route) => route,
      () => undefined,
    );

  /**
   * Installs the ownership-independent raw-input route for overlay keys.
   *
   * It is deliberately conservative:
   *
   * - only frames the live plan itself classifies as a Weave overlay action
   *   are consumed; every other frame - ordinary text, `pi-vim` Escape,
   *   unrelated Alt keys, host shortcuts - is returned untouched;
   * - while the native overlay is mounted the overlay's own interceptor owns
   *   input, so the listener stays inert and no action is handled twice;
   * - consuming a matched frame is what keeps the default-editor shortcut path
   *   from dispatching the same action a second time, since Pi stops routing a
   *   consumed frame.
   *
   * Exactly one listener exists per live host UI, and generation teardown
   * releases it through {@link releaseChildOverlayTerminalInput}. Liveness is
   * proven by installation, never inferred: see the comment on the release
   * inside {@link bind}.
   */
  const bind = (generationId: string, diagnostics: string[]): void => {
    const route = readTerminalInputRoute();
    if (route === undefined) {
      // No live route to install on. A handle taken from an earlier host is
      // left in place: it cannot be replaced yet, and the next lifecycle call
      // that does find a route releases it before rebinding.
      if (state.terminalInput !== undefined) return;
      if (diagnostics.length < PI_CHILD_OVERLAY_KEY_BOUNDS.maxDiagnostics) {
        diagnostics.push(
          "weave overlay keys degraded: host exposes no ui.onTerminalInput, shortcuts reach the overlay only under Pi's default editor",
        );
      }
      return;
    }
    // Liveness is proven by installation, not inferred from the host object.
    //
    // Pi exposes no way to ask whether a listener is still installed:
    // `ui.onTerminalInput` hands back an unsubscribe and nothing else. Pi
    // 0.83's `resetExtensionUI()` - reached from session invalidation and
    // from `/reload` - runs `clearExtensionTerminalInputListeners()` while
    // leaving `runner.uiContext`, and therefore `ctx.ui`, the *same* object.
    // Treating an unchanged host as proof that the retained handle is still
    // live therefore pinned the route dead after any reset: the handle was an
    // inert closure, both `bind` and `retry` returned early forever, and
    // every overlay scroll frame fell through to Pi's own paging route.
    //
    // So each bind releases whatever handle it holds and subscribes once. The
    // handle it keeps was returned by the subscribe call it just made, which
    // is the only route-independent proof available. Releasing first is what
    // keeps a second listener from stacking on a host that is still live;
    // calling a stale handle is safe, because Pi's per-listener unsubscribe
    // is a remove-then-delete that no-ops once the listener is already gone.
    releaseChildOverlayTerminalInput(state);
    installedEpoch += 1;
    const epoch = installedEpoch;
    const handler: PiTerminalInputHandler = (data) => {
      // Belt and braces for the single-listener invariant: if a host ever
      // fails to remove a released listener, the superseded closure is inert
      // rather than a second delivery path. One counter, so state stays
      // bounded however many times the route is rebound.
      if (epoch !== installedEpoch) return undefined;
      if (deps.isOverlayOpen()) {
        // The mounted overlay owns raw input through its own interceptor -
        // except for paging. Pi 0.83 claims PageUp/PageDown for its own
        // editor/global paging route *before* the mounted custom component
        // sees them, so under a real PTY the overlay never disengaged live
        // tail and never showed the newer-lines cue. Extension terminal-input
        // listeners run before that route, so the six overlay scroll frames -
        // and only those - are claimed here and dispatched to the mounted
        // overlay exactly once. Every other frame still falls through to the
        // component, which keeps Enter, Alt+Enter, Escape, the draft editor,
        // and search on their existing routes.
        //
        // The frame is normalized first, so the overlay receives the canonical
        // encoding it already understands no matter how the live terminal
        // encoded the press, and release frames never reach it at all.
        const canonical = normalizeChildOverlayScrollFrame(data);
        if (canonical === undefined) return undefined;
        const mounted = deps.activeGenerationId();
        if (mounted === undefined) return undefined;
        if (!deps.dispatchOverlayScroll(canonical, mounted)) return undefined;
        return { consume: true };
      }
      const plan = state.plan;
      if (plan === undefined) return undefined;
      const action = classifyChildOverlayKey(plan, data);
      if (action === undefined) return undefined;
      const target = deps.activeGenerationId();
      if (target === undefined) return undefined;
      deps.dispatchOverlayAction(action, target);
      return { consume: true };
    };
    const installed = Result.fromThrowable(
      () => route.subscribe(handler),
      () => "terminal_input_subscribe_failed" as const,
    )();
    installed.match(
      (unsubscribe) => {
        state.terminalInput = unsubscribe;
        state.terminalInputHost = route.ui;
        state.generationId = generationId;
      },
      () => {
        if (diagnostics.length < PI_CHILD_OVERLAY_KEY_BOUNDS.maxDiagnostics) {
          diagnostics.push(
            "weave overlay keys degraded: ui.onTerminalInput refused the listener",
          );
        }
      },
    );
  };

  /**
   * Retries the raw-input binding for a plan that is already applied.
   *
   * Planning keys and installing the listener have different preconditions:
   * planning needs only an inspectable host keybindings source, while the
   * listener needs a live session context that exposes `ui.onTerminalInput`.
   * A lifecycle call can satisfy the first and not the second, and overlay-key
   * registration then returns early on every later call
   * (`status === "applied" && plan !== undefined`), so the generation keeps an
   * applied plan with no listener for the rest of its life - which is exactly
   * the state in which Alt+I / Alt+1..Alt+9 look registered and never reach
   * the overlay under a foreign primary editor.
   *
   * This runs on every later lifecycle call so the missing listener is
   * installed as soon as a session context can carry it. It changes nothing
   * else: raw shortcut registration stays exactly-once for the extension
   * lifetime, and {@link PiChildOverlayTerminalInputBinder.bind} keeps its own
   * single-listener guard, so repeated calls never stack a second listener.
   */
  const retry = (generationId: string): void => {
    if (state.status !== "applied") return;
    if (state.plan === undefined) return;
    // No liveness guard here on purpose. A retained handle proves nothing
    // once Pi can clear listeners behind an unchanged `ctx.ui`, so the retry
    // delegates to `bind`, which releases and re-installs exactly one
    // listener and therefore always leaves a provably live route behind.
    const previous = state.diagnostics;
    const diagnostics = [...previous];
    bind(generationId, diagnostics);
    // A retry that still finds no listener route repeats the same degraded
    // reason, so only genuinely new lines are kept: a session that never
    // gains `ui.onTerminalInput` must not fill the bounded diagnostic list
    // with one identical line per turn.
    const added = diagnostics
      .slice(previous.length)
      .filter((line) => !previous.includes(line));
    if (added.length === 0) return;
    state.diagnostics = Object.freeze(
      [...previous, ...added].slice(
        0,
        PI_CHILD_OVERLAY_KEY_BOUNDS.maxDiagnostics,
      ),
    );
  };

  return { bind, retry };
}
