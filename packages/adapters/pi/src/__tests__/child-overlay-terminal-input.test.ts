import { describe, expect, test } from "bun:test";
import {
  type PiChildOverlayAction,
  planChildOverlayKeyRegistrations,
} from "../child-overlay-keys.js";
import {
  maxScrollRows,
  type OverlayScrollState,
  scrollDelta,
} from "../child-overlay-scroll.js";
import {
  createChildOverlayTerminalInputBinder,
  isChildOverlayScrollFrame,
  normalizeChildOverlayScrollFrame,
  type PiChildOverlayTerminalInputState,
  releaseChildOverlayTerminalInput,
} from "../child-overlay-terminal-input.js";
import { SCROLL_KEYS, SCROLL_PAGE } from "../child-overlay-types.js";
import type { PiTerminalInputHandler } from "../types.js";

/** The six frames the mounted overlay owns, in the order Task 20(b) proves. */
const SCROLL_FRAMES = [
  SCROLL_KEYS.pageUp,
  SCROLL_KEYS.pageDown,
  SCROLL_KEYS.shiftUp,
  SCROLL_KEYS.shiftDown,
  SCROLL_KEYS.home,
  SCROLL_KEYS.end,
] as const;

/**
 * Mirrors Pi's TUI listener set: extension listeners run before any component,
 * overlay, or shortcut route, and a consuming listener stops the frame.
 */
function terminalInputHost(): {
  readonly onTerminalInput: (handler: PiTerminalInputHandler) => () => void;
  readonly listeners: PiTerminalInputHandler[];
  readonly emit: (data: string) => boolean;
} {
  const listeners: PiTerminalInputHandler[] = [];
  return {
    listeners,
    onTerminalInput: (handler: PiTerminalInputHandler) => {
      listeners.push(handler);
      return () => {
        const index = listeners.indexOf(handler);
        if (index !== -1) listeners.splice(index, 1);
      };
    },
    emit: (data: string) => {
      for (const listener of [...listeners]) {
        if (listener(data)?.consume === true) return true;
      }
      return false;
    },
  };
}

function boundBinder(options: {
  readonly overlayOpen: () => boolean;
  readonly activeGenerationId?: () => string | undefined;
  readonly scrollDelivered?: boolean;
}): {
  readonly host: ReturnType<typeof terminalInputHost>;
  readonly state: PiChildOverlayTerminalInputState;
  readonly scrolls: { data: string; generationId: string }[];
  readonly actions: { action: PiChildOverlayAction; generationId: string }[];
} {
  const host = terminalInputHost();
  const plan = planChildOverlayKeyRegistrations({
    conflicts: { ownerOf: () => undefined },
  })._unsafeUnwrap();
  const state: PiChildOverlayTerminalInputState = {
    status: "applied",
    plan,
    terminalInput: undefined,
    terminalInputHost: undefined,
    diagnostics: Object.freeze([]),
    generationId: undefined,
  };
  const scrolls: { data: string; generationId: string }[] = [];
  const actions: { action: PiChildOverlayAction; generationId: string }[] = [];
  const ctx = {
    cwd: "/repo",
    hasUI: true,
    ui: {
      notify: () => undefined,
      select: async () => undefined,
      onTerminalInput: host.onTerminalInput,
    },
  } as never;
  const binder = createChildOverlayTerminalInputBinder({
    state,
    latestSessionCtx: () => ctx,
    isOverlayOpen: options.overlayOpen,
    activeGenerationId: options.activeGenerationId ?? (() => "gen-1"),
    dispatchOverlayAction: (action, generationId) => {
      actions.push({ action, generationId });
    },
    dispatchOverlayScroll: (data, generationId) => {
      scrolls.push({ data, generationId });
      return options.scrollDelivered ?? true;
    },
  });
  binder.bind("gen-1", []);
  expect(host.listeners.length).toBe(1);
  return { host, state, scrolls, actions };
}

/**
 * The exact bytes a live Pi 0.83 / Herdr PTY delivered for one semantic
 * Shift+Up, captured in the Task 20 pane probe: an incidental terminal size
 * report followed by the event-aware Kitty-compatible key frame. The key
 * frame is *not* the legacy `ESC [ 1;2 A` the raw binder used to require.
 */
const LIVE_PROBE = {
  /** `ESC [ 6;38;15 t` - incidental terminal report, never a key. */
  incidentalReport: "\x1b[6;38;15t",
  /** `ESC [ 1;2:1 A` - Shift+Up, event type 1 (press). */
  shiftUpPress: "\x1b[1;2:1A",
  /** `ESC [ 1;2:1 B` - Shift+Down, event type 1 (press). */
  shiftDownPress: "\x1b[1;2:1B",
  /** `ESC [ 1;2:2 A` - Shift+Up, event type 2 (repeat). */
  shiftUpRepeat: "\x1b[1;2:2A",
  /** `ESC [ 1;2:3 A` - Shift+Up, event type 3 (release). */
  shiftUpRelease: "\x1b[1;2:3A",
  /** `ESC [ 1;2:3 B` - Shift+Down, event type 3 (release). */
  shiftDownRelease: "\x1b[1;2:3B",
} as const;

/** Frames that must never be treated as overlay scrolling. */
const NON_SCROLL_FRAMES = [
  LIVE_PROBE.incidentalReport,
  "\r",
  "\x1b\r",
  "\x1b",
  "\x1bi",
  "\x1b1",
  "\x1b9",
  "\x7f",
  "a",
  "hello",
  "\x1b[A",
  "\x1b[B",
  "\x1b[Z",
  "\x1b[1;3D",
  "\x1b[200~",
  "\x1b[99;99Z",
  "\u0003",
  "",
] as const;

describe("normalizeChildOverlayScrollFrame", () => {
  test("the exact live Shift+Up probe bytes normalize to canonical PageUp", () => {
    // Pre-fix regression: Pi 0.83 negotiates Kitty event reporting, so the
    // live PTY sent the event-aware form while the binder only accepted the
    // legacy one, and semantic Shift+Up never moved the mounted overlay.
    expect(LIVE_PROBE.shiftUpPress).not.toBe(SCROLL_KEYS.shiftUp);
    expect(normalizeChildOverlayScrollFrame(LIVE_PROBE.shiftUpPress)).toBe(
      SCROLL_KEYS.pageUp,
    );
  });

  test("the live Shift+Down event-aware form normalizes to canonical PageDown", () => {
    expect(LIVE_PROBE.shiftDownPress).not.toBe(SCROLL_KEYS.shiftDown);
    expect(normalizeChildOverlayScrollFrame(LIVE_PROBE.shiftDownPress)).toBe(
      SCROLL_KEYS.pageDown,
    );
  });

  test("legacy Shift+Up / Shift+Down also page, not crawl one row", () => {
    // The conflict-safe terminal aliases must page on both encodings so a
    // press reaches the component's bounded older/newer pagination at the
    // viewport edges.
    expect(normalizeChildOverlayScrollFrame(SCROLL_KEYS.shiftUp)).toBe(
      SCROLL_KEYS.pageUp,
    );
    expect(normalizeChildOverlayScrollFrame(SCROLL_KEYS.shiftDown)).toBe(
      SCROLL_KEYS.pageDown,
    );
  });

  test("legacy and Kitty PageUp/PageDown/Home/End reach their canonical constants", () => {
    for (const [frame, canonical] of [
      // Legacy encodings.
      ["\x1b[5~", SCROLL_KEYS.pageUp],
      ["\x1b[6~", SCROLL_KEYS.pageDown],
      ["\x1b[H", SCROLL_KEYS.home],
      ["\x1b[F", SCROLL_KEYS.end],
      ["\x1b[1~", SCROLL_KEYS.home],
      ["\x1b[4~", SCROLL_KEYS.end],
      // Event-aware Kitty-compatible press encodings.
      ["\x1b[5;1:1~", SCROLL_KEYS.pageUp],
      ["\x1b[6;1:1~", SCROLL_KEYS.pageDown],
      ["\x1b[1;1:1H", SCROLL_KEYS.home],
      ["\x1b[1;1:1F", SCROLL_KEYS.end],
      // Repeat frames are still real scroll intent (key held down).
      ["\x1b[5;1:2~", SCROLL_KEYS.pageUp],
      [LIVE_PROBE.shiftUpRepeat, SCROLL_KEYS.pageUp],
    ] as const) {
      expect(normalizeChildOverlayScrollFrame(frame)).toBe(canonical);
    }
  });

  test("release frames normalize to nothing so one press cannot scroll twice", () => {
    for (const frame of [
      LIVE_PROBE.shiftUpRelease,
      LIVE_PROBE.shiftDownRelease,
      "\x1b[5;1:3~",
      "\x1b[6;1:3~",
      "\x1b[1;1:3H",
      "\x1b[1;1:3F",
    ]) {
      expect(normalizeChildOverlayScrollFrame(frame)).toBeUndefined();
    }
  });

  test("the incidental terminal report and ordinary input normalize to nothing", () => {
    for (const frame of NON_SCROLL_FRAMES) {
      expect(normalizeChildOverlayScrollFrame(frame)).toBeUndefined();
    }
  });

  test("oversized frames are rejected without walking the payload", () => {
    expect(
      normalizeChildOverlayScrollFrame(`${"x".repeat(64)}\x1b[5~`),
    ).toBeUndefined();
  });
});

describe("isChildOverlayScrollFrame", () => {
  test("recognizes exactly the six overlay scroll frames", () => {
    for (const frame of SCROLL_FRAMES) {
      expect(isChildOverlayScrollFrame(frame)).toBe(true);
    }
    for (const other of [
      "\r",
      "\x1b\r",
      "\x1b",
      "\x1bi",
      "\x1b1",
      "\x1b9",
      "hello",
      "\x1b[A",
      "\x1b[B",
      "\x1b[Z",
      "\x1b[200~",
      "",
    ]) {
      expect(isChildOverlayScrollFrame(other)).toBe(false);
    }
  });

  test("recognizes the live event-aware press forms and rejects releases", () => {
    expect(isChildOverlayScrollFrame(LIVE_PROBE.shiftUpPress)).toBe(true);
    expect(isChildOverlayScrollFrame(LIVE_PROBE.shiftDownPress)).toBe(true);
    expect(isChildOverlayScrollFrame(LIVE_PROBE.shiftUpRelease)).toBe(false);
    expect(isChildOverlayScrollFrame(LIVE_PROBE.incidentalReport)).toBe(false);
  });
});

describe("raw scroll frames while the native overlay is mounted", () => {
  test("raw PageUp reaches the mounted overlay and is consumed", () => {
    // Pre-fix regression: the listener returned immediately while the overlay
    // was open, so Pi's own paging route saw PageUp and the overlay never
    // disengaged live tail under a real PTY.
    const { host, scrolls } = boundBinder({ overlayOpen: () => true });

    expect(host.emit("\x1b[5~")).toBe(true);

    expect(scrolls).toEqual([{ data: "\x1b[5~", generationId: "gen-1" }]);
  });

  test("every overlay scroll frame dispatches its canonical form once", () => {
    const { host, scrolls } = boundBinder({ overlayOpen: () => true });

    for (const frame of SCROLL_FRAMES) {
      expect(host.emit(frame)).toBe(true);
    }

    // Shift+Up / Shift+Down are conflict-safe aliases for paging, so the
    // mounted overlay only ever sees the four canonical frames.
    expect(scrolls).toEqual([
      { data: SCROLL_KEYS.pageUp, generationId: "gen-1" },
      { data: SCROLL_KEYS.pageDown, generationId: "gen-1" },
      { data: SCROLL_KEYS.pageUp, generationId: "gen-1" },
      { data: SCROLL_KEYS.pageDown, generationId: "gen-1" },
      { data: SCROLL_KEYS.home, generationId: "gen-1" },
      { data: SCROLL_KEYS.end, generationId: "gen-1" },
    ]);
  });

  test("the live Shift+Up frame dispatches canonical PageUp exactly once", () => {
    const { host, scrolls, actions } = boundBinder({ overlayOpen: () => true });

    // The live PTY emits an incidental report before the key frame; only the
    // key frame is ours.
    expect(host.emit(LIVE_PROBE.incidentalReport)).toBe(false);
    expect(host.emit(LIVE_PROBE.shiftUpPress)).toBe(true);
    // Event reporting also delivers the matching release; it must not scroll.
    expect(host.emit(LIVE_PROBE.shiftUpRelease)).toBe(false);

    expect(scrolls).toEqual([
      { data: SCROLL_KEYS.pageUp, generationId: "gen-1" },
    ]);
    expect(actions).toEqual([]);
  });

  test("the live Shift+Down frame dispatches canonical PageDown exactly once", () => {
    const { host, scrolls } = boundBinder({ overlayOpen: () => true });

    expect(host.emit(LIVE_PROBE.shiftDownPress)).toBe(true);
    expect(host.emit(LIVE_PROBE.shiftDownRelease)).toBe(false);

    expect(scrolls).toEqual([
      { data: SCROLL_KEYS.pageDown, generationId: "gen-1" },
    ]);
  });

  test("no frame is dispatched twice for one press", () => {
    const { host, scrolls, actions } = boundBinder({ overlayOpen: () => true });

    host.emit("\x1b[6~");

    expect(scrolls.length).toBe(1);
    // The overlay-action route must not also fire for a scroll frame.
    expect(actions).toEqual([]);
  });

  test("non-scroll frames stay on their existing routes while mounted", () => {
    const { host, scrolls, actions } = boundBinder({ overlayOpen: () => true });

    for (const data of NON_SCROLL_FRAMES) {
      expect(host.emit(data)).toBe(false);
    }

    expect(scrolls).toEqual([]);
    expect(actions).toEqual([]);
  });

  test("an undelivered scroll frame is left on the host route", () => {
    // No mounted component, a replaced generation, a stale context, or a
    // throwing dispatch target all report "not delivered"; consuming such a
    // frame would swallow input without acting on it.
    const { host, scrolls } = boundBinder({
      overlayOpen: () => true,
      scrollDelivered: false,
    });

    expect(host.emit("\x1b[5~")).toBe(false);
    expect(scrolls.length).toBe(1);
  });

  test("no live generation means no dispatch target and no consumption", () => {
    const { host, scrolls } = boundBinder({
      overlayOpen: () => true,
      activeGenerationId: () => undefined,
    });

    expect(host.emit("\x1b[5~")).toBe(false);
    expect(scrolls).toEqual([]);
  });

  test("with no overlay mounted, scroll frames keep the pre-mount behaviour", () => {
    const { host, scrolls, actions } = boundBinder({
      overlayOpen: () => false,
    });

    for (const frame of [
      ...SCROLL_FRAMES,
      LIVE_PROBE.shiftUpPress,
      LIVE_PROBE.shiftDownPress,
    ]) {
      expect(host.emit(frame)).toBe(false);
    }

    expect(scrolls).toEqual([]);
    expect(actions).toEqual([]);
  });
});

/**
 * Frames captured from a live Pi 0.83 PTY (Task 1 diagnosis, Herdr pane probe
 * plus the isolated 0.83 pi-tui `matchesKey` / `isKeyRelease` table).
 */
const CAPTURED = {
  /** `ESC [ 5 ~` - legacy CSI PageUp. */
  legacyPageUp: "\x1b[5~",
  /** `ESC [ 6 ~` - legacy CSI PageDown. */
  legacyPageDown: "\x1b[6~",
  /** `ESC [ 5;1:1 ~` - Kitty event-aware PageUp press. */
  kittyPageUpPress: "\x1b[5;1:1~",
  /** `ESC [ 5;1:3 ~` - Kitty event-aware PageUp release. */
  kittyPageUpRelease: "\x1b[5;1:3~",
  /** `ESC [ 6;1:1 ~` - Kitty event-aware PageDown press. */
  kittyPageDownPress: "\x1b[6;1:1~",
  /** `ESC [ 6;1:3 ~` - Kitty event-aware PageDown release. */
  kittyPageDownRelease: "\x1b[6;1:3~",
  /** `ESC O H` - SS3 Home. */
  ss3Home: "\x1bOH",
  /** `ESC O F` - SS3 End. */
  ss3End: "\x1bOF",
} as const;

/**
 * The full route under test, wired end to end: a Pi 0.83 shaped host, the real
 * binder, and a controller that applies the real scroll model.
 *
 * `resetExtensionUI()` reproduces the exact Pi 0.83 behaviour Task 1 proved:
 * `clearExtensionTerminalInputListeners()` drops every extension listener while
 * `runner.uiContext` - and therefore `ctx.ui` - stays the *same object*. A
 * binder that reads liveness from host identity is pinned dead from here on.
 */
function scrollRoute(): {
  readonly host: ReturnType<typeof terminalInputHost>;
  readonly state: PiChildOverlayTerminalInputState;
  readonly binder: ReturnType<typeof createChildOverlayTerminalInputBinder>;
  readonly controller: OverlayScrollState;
  readonly dispatched: string[];
  readonly resetExtensionUI: () => void;
  readonly uiIdentity: () => unknown;
} {
  const host = terminalInputHost();
  const plan = planChildOverlayKeyRegistrations({
    conflicts: { ownerOf: () => undefined },
  })._unsafeUnwrap();
  const state: PiChildOverlayTerminalInputState = {
    status: "applied",
    plan,
    terminalInput: undefined,
    terminalInputHost: undefined,
    diagnostics: Object.freeze([]),
    generationId: undefined,
  };
  const ui = {
    notify: () => undefined,
    select: async () => undefined,
    onTerminalInput: host.onTerminalInput,
  };
  const ctx = { cwd: "/repo", hasUI: true, ui } as never;
  const controller: OverlayScrollState = {
    scrollOffset: 0,
    scrollExtent: 40,
    liveTail: true,
    pendingTailExtentAdjustment: false,
    entries: [],
    anchor: undefined,
    layoutSpans: undefined,
    pendingViewportAnchor: undefined,
    pendingViewportLiveTail: false,
  };
  const dispatched: string[] = [];
  const binder = createChildOverlayTerminalInputBinder({
    state,
    latestSessionCtx: () => ctx,
    isOverlayOpen: () => true,
    activeGenerationId: () => "gen-1",
    dispatchOverlayAction: () => undefined,
    dispatchOverlayScroll: (data) => {
      const delta = scrollDelta(data);
      if (delta === undefined) return false;
      dispatched.push(data);
      const bound = maxScrollRows(controller);
      if (delta === "oldest") controller.scrollOffset = bound;
      else if (delta === "follow") controller.scrollOffset = 0;
      else {
        controller.scrollOffset = Math.min(
          Math.max(controller.scrollOffset + delta, 0),
          bound,
        );
      }
      controller.liveTail = controller.scrollOffset === 0;
      return true;
    },
  });
  return {
    host,
    state,
    binder,
    controller,
    dispatched,
    resetExtensionUI: () => {
      // Pi 0.83 `resetExtensionUI()`: listeners cleared, UI context retained.
      for (const release of [...host.listeners]) void release;
      host.listeners.splice(0, host.listeners.length);
    },
    uiIdentity: () => ui,
  };
}

describe("listener liveness after Pi clears listeners behind the same UI context", () => {
  test("retry rebinds and every captured encoding reaches controller state", () => {
    // Pre-fix regression: `bind()` and `retry()` both read liveness from
    // `state.terminalInputHost === ctx.ui`. Pi 0.83's `resetExtensionUI()`
    // clears the listener without replacing that object, so both returned
    // early forever, the listener count stayed at 0, and every scroll frame
    // fell through to Pi's own editor paging route.
    const route = scrollRoute();
    route.binder.bind("gen-1", []);
    expect(route.host.listeners.length).toBe(1);

    // Legacy CSI PageUp, on the first binding.
    expect(route.host.emit(CAPTURED.legacyPageUp)).toBe(true);
    expect(route.controller.scrollOffset).toBe(SCROLL_PAGE);
    expect(route.controller.liveTail).toBe(false);

    const identityBefore = route.uiIdentity();
    route.resetExtensionUI();
    expect(route.host.listeners.length).toBe(0);
    // The host object did not change; only the listener went away.
    expect(route.uiIdentity()).toBe(identityBefore);
    expect(route.state.terminalInputHost).toBe(identityBefore);
    expect(route.state.terminalInput).not.toBeUndefined();
    // Nothing reaches the overlay while the route is dead.
    expect(route.host.emit(CAPTURED.legacyPageUp)).toBe(false);
    expect(route.controller.scrollOffset).toBe(SCROLL_PAGE);

    route.binder.retry("gen-1");

    // Proven live: the handle held is the one this subscribe call returned.
    expect(route.host.listeners.length).toBe(1);

    // Legacy CSI, after the rebind.
    expect(route.host.emit(CAPTURED.legacyPageUp)).toBe(true);
    expect(route.controller.scrollOffset).toBe(2 * SCROLL_PAGE);
    expect(route.host.emit(CAPTURED.legacyPageDown)).toBe(true);
    expect(route.controller.scrollOffset).toBe(SCROLL_PAGE);

    // Kitty event-aware press frames.
    expect(route.host.emit(CAPTURED.kittyPageUpPress)).toBe(true);
    expect(route.controller.scrollOffset).toBe(2 * SCROLL_PAGE);
    expect(route.host.emit(CAPTURED.kittyPageDownPress)).toBe(true);
    expect(route.controller.scrollOffset).toBe(SCROLL_PAGE);

    // Kitty release frames stay suppressed: one physical press must not page
    // twice under event reporting.
    expect(route.host.emit(CAPTURED.kittyPageUpRelease)).toBe(false);
    expect(route.host.emit(CAPTURED.kittyPageDownRelease)).toBe(false);
    expect(route.controller.scrollOffset).toBe(SCROLL_PAGE);

    // SS3 Home / End.
    expect(route.host.emit(CAPTURED.ss3Home)).toBe(true);
    expect(route.controller.scrollOffset).toBe(maxScrollRows(route.controller));
    expect(route.host.emit(CAPTURED.ss3End)).toBe(true);
    expect(route.controller.scrollOffset).toBe(0);
    expect(route.controller.liveTail).toBe(true);

    expect(route.dispatched).toEqual([
      SCROLL_KEYS.pageUp,
      SCROLL_KEYS.pageUp,
      SCROLL_KEYS.pageDown,
      SCROLL_KEYS.pageUp,
      SCROLL_KEYS.pageDown,
      SCROLL_KEYS.home,
      SCROLL_KEYS.end,
    ]);
    expect(route.state.diagnostics).toEqual([]);
  });

  test("bind also rebinds after a reset that kept the UI context", () => {
    const route = scrollRoute();
    route.binder.bind("gen-1", []);
    route.resetExtensionUI();

    const diagnostics: string[] = [];
    route.binder.bind("gen-1", diagnostics);

    expect(route.host.listeners.length).toBe(1);
    expect(diagnostics).toEqual([]);
    expect(route.host.emit(CAPTURED.legacyPageUp)).toBe(true);
    expect(route.controller.scrollOffset).toBe(SCROLL_PAGE);
  });

  test("repeated binds and retries keep exactly one listener and one delivery", () => {
    const route = scrollRoute();
    route.binder.bind("gen-1", []);
    route.binder.bind("gen-1", []);
    route.binder.retry("gen-1");
    route.binder.retry("gen-1");
    route.resetExtensionUI();
    route.binder.retry("gen-1");
    route.binder.retry("gen-1");

    expect(route.host.listeners.length).toBe(1);

    expect(route.host.emit(CAPTURED.legacyPageUp)).toBe(true);

    // One press, one dispatch, one page of controller movement.
    expect(route.dispatched).toEqual([SCROLL_KEYS.pageUp]);
    expect(route.controller.scrollOffset).toBe(SCROLL_PAGE);
  });

  test("a superseded listener that the host fails to remove stays inert", () => {
    // Belt and braces for the single-listener invariant: even a host whose
    // unsubscribe does nothing must not gain a second delivery path.
    const route = scrollRoute();
    route.binder.bind("gen-1", []);
    const stale = route.host.listeners[0];
    expect(stale).not.toBeUndefined();
    route.resetExtensionUI();
    route.binder.retry("gen-1");
    // Re-insert the superseded closure ahead of the live one.
    route.host.listeners.unshift(stale as PiTerminalInputHandler);
    expect(route.host.listeners.length).toBe(2);

    expect(route.host.emit(CAPTURED.legacyPageUp)).toBe(true);

    expect(route.dispatched).toEqual([SCROLL_KEYS.pageUp]);
    expect(route.controller.scrollOffset).toBe(SCROLL_PAGE);
  });

  test("teardown releases the listener and stops delivery", () => {
    const route = scrollRoute();
    route.binder.bind("gen-1", []);

    releaseChildOverlayTerminalInput(route.state);

    expect(route.host.listeners.length).toBe(0);
    expect(route.state.terminalInput).toBeUndefined();
    expect(route.state.terminalInputHost).toBeUndefined();
    expect(route.host.emit(CAPTURED.legacyPageUp)).toBe(false);
    expect(route.dispatched).toEqual([]);
    expect(route.controller.scrollOffset).toBe(0);
  });
});
