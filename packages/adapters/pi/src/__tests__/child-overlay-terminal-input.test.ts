import { describe, expect, test } from "bun:test";
import {
  type PiChildOverlayAction,
  planChildOverlayKeyRegistrations,
} from "../child-overlay-keys.js";
import {
  createChildOverlayTerminalInputBinder,
  isChildOverlayScrollFrame,
  type PiChildOverlayTerminalInputState,
} from "../child-overlay-terminal-input.js";
import { SCROLL_KEYS } from "../child-overlay-types.js";
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

  test("every overlay scroll frame dispatches once for the active generation", () => {
    const { host, scrolls } = boundBinder({ overlayOpen: () => true });

    for (const frame of SCROLL_FRAMES) {
      expect(host.emit(frame)).toBe(true);
    }

    expect(scrolls).toEqual(
      SCROLL_FRAMES.map((data) => ({ data, generationId: "gen-1" })),
    );
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

    for (const data of [
      "\r",
      "\x1b\r",
      "\x1b",
      "\x1bi",
      "\x1b1",
      "\x1b9",
      "a",
      "hello",
      "\x1b[Z",
      "\x1b[A",
      "\x1b[1;3D",
      "\u0003",
    ]) {
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

    for (const frame of SCROLL_FRAMES) {
      expect(host.emit(frame)).toBe(false);
    }

    expect(scrolls).toEqual([]);
    expect(actions).toEqual([]);
  });
});
