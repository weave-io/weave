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
 * invalidated session context, comparing host identity, binding exactly one
 * listener, retrying a binding for an already-applied plan, and releasing it
 * on teardown. It depends only on the narrow
 * {@link PiChildOverlayTerminalInputState} slice of the overlay-keys cell and
 * on the ports in {@link PiChildOverlayTerminalInputDeps}; it never reaches
 * into the inspection runtime, so generation ownership stays with the caller.
 */
import { Result } from "neverthrow";
import {
  classifyChildOverlayKey,
  PI_CHILD_OVERLAY_KEY_BOUNDS,
  type PiChildOverlayAction,
  type PiChildOverlayKeyPlan,
} from "./child-overlay-keys.js";
import { scrollDelta } from "./child-overlay-scroll.js";
import type { PiSessionContext, PiTerminalInputHandler } from "./types.js";

/**
 * Whether a raw frame is one of the six overlay scroll frames.
 *
 * The set is exactly {@link scrollDelta}'s domain - PageUp, PageDown,
 * Shift+Up, Shift+Down, Home, End - so the mounted overlay and this route can
 * never disagree about which frames belong to scrolling. Anything else, from
 * ordinary text to an unrecognized CSI sequence, is not a scroll frame.
 */
export function isChildOverlayScrollFrame(data: string): boolean {
  return scrollDelta(data) !== undefined;
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
  /** The host UI object the live listener was installed on, or none. */
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
   * Resolves the live raw-input route, or `undefined` when there is none.
   *
   * Pi exposes `ctx.ui` through a getter that calls `assertActive()` and
   * throws once the extension runner has been marked stale, so a context
   * retained from a replaced session can throw on plain property access.
   * Reading it through `Result.fromThrowable` keeps an invalidated host from
   * throwing out of a lifecycle callback and degrades it to "no route", which
   * is exactly what an invalidated context is.
   *
   * The returned `ui` is the host object itself, kept only so the caller can
   * compare identity against
   * {@link PiChildOverlayTerminalInputState.terminalInputHost}.
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
   * releases it through {@link releaseChildOverlayTerminalInput}. When Pi
   * silently clears listeners on session invalidation or reload, the next
   * lifecycle call sees a new UI context and rebinds exactly once.
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
    if (state.terminalInput !== undefined) {
      // The live host already carries this generation's listener, so there is
      // nothing to install and a second one must never be stacked.
      if (state.terminalInputHost === route.ui) return;
      // A different UI context is live, so Pi invalidated or reloaded the
      // session since the handle was taken. `resetExtensionUI` already ran
      // `clearExtensionTerminalInputListeners`, so the old listener is gone
      // and the retained handle is inert; forgetting it here is what keeps
      // the single-listener guard from skipping the rebind forever. Calling
      // the stale handle is safe - Pi's per-listener unsubscribe is a
      // remove-then-delete that no-ops once the listener is already gone.
      releaseChildOverlayTerminalInput(state);
    }
    const handler: PiTerminalInputHandler = (data) => {
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
        if (!isChildOverlayScrollFrame(data)) return undefined;
        const mounted = deps.activeGenerationId();
        if (mounted === undefined) return undefined;
        if (!deps.dispatchOverlayScroll(data, mounted)) return undefined;
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
    // A handle is only proof of a live listener while the host UI it was
    // installed on is still the live one; after an invalidation or reload it
    // is an inert closure and this generation still needs a listener.
    if (
      state.terminalInput !== undefined &&
      state.terminalInputHost === readTerminalInputRoute()?.ui
    ) {
      return;
    }
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
