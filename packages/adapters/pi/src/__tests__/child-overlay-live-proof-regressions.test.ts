/**
 * Regressions for the three defects the Pi 0.84.2 real-harness proof found.
 *
 * Each case is written from a frame or an event that was OBSERVED live, not
 * from a shape this adapter would like the host to send:
 *
 * 1. **Scroll frames.** Pi 0.84 negotiates the Kitty keyboard protocol, so a
 *    real pane delivers Shift+Up as `ESC [ 1;2:1 A`, and a driver that cannot
 *    name PageUp/Home/End still delivers their legacy and SS3 forms. Every
 *    encoding observed live must reach the controller as one canonical frame,
 *    and a Kitty RELEASE frame must reach nothing at all.
 * 2. **Search.** `⚙ bash(timeout: 180)` was plainly on screen while the search
 *    rail reported `match 0/0 · no match in this transcript`, because search
 *    indexed the overlay window entry (a tool entry carries only its tool
 *    name) instead of the rows the reader was reading. The same pane's Kitty
 *    frames also reach the search keyboard itself: Enter, Backspace and the
 *    `Ctrl+F` alias all arrive as `ESC [ … u`, so every one of them is matched
 *    by key identity rather than by byte, and a RELEASE reaches none of them.
 * 3. **Queue reporting.** Pi 0.84 `AgentSession` emits
 *    `{ type: "queue_update", steering, followUp }`. The adapter read only
 *    `queue_change`, so a steered or queued live child kept `queue 0` and
 *    never reached the card's `steered` frame.
 */
import { describe, expect, it } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import {
  applyDelegationCardEvent,
  applyDelegationCardInput,
  createDelegationCardState,
  projectDelegationCardFacts,
} from "../child-card-model.js";
import {
  createChildOverlayController,
  createChildOverlayCustomComponent,
  createMemoryChildOverlaySource,
} from "../child-overlay.js";
import { childOverlayTranscriptInput } from "../child-overlay-facts.js";
import {
  CLOSED_OVERLAY_SEARCH,
  stepOverlaySearch,
} from "../child-overlay-input-modes.js";
import {
  isChildOverlaySearchOpenInput,
  PI_CHILD_OVERLAY_SEARCH_TRIGGER,
} from "../child-overlay-keys.js";
import {
  overlayTranscriptSearchIndex,
  renderOverlayTranscript,
} from "../child-overlay-pi-native.js";
import { matchingEntryIds } from "../child-overlay-search.js";
import { normalizeChildOverlayScrollFrame } from "../child-overlay-terminal-input.js";
import { SCROLL_KEYS } from "../child-overlay-types.js";
import { parsePiChildSessionEvent } from "../child-session-events.js";
import { plainPaint } from "../ui-paint.js";

initTheme("default");

/** The parser returns a Zod `safeParse` result, not a neverthrow `Result`. */
function parseEvent(value: unknown) {
  const parsed = parsePiChildSessionEvent(value);
  if (!parsed.success) throw new Error("event did not parse");
  return parsed.data;
}

describe("live scroll frame encodings (Pi 0.84.2)", () => {
  it("normalizes every encoding observed in a live pane", () => {
    const cases: readonly (readonly [string, string, string])[] = [
      ["legacy PageUp", "\x1b[5~", SCROLL_KEYS.pageUp],
      ["legacy PageDown", "\x1b[6~", SCROLL_KEYS.pageDown],
      ["Kitty PageUp with event type", "\x1b[5;1:1~", SCROLL_KEYS.pageUp],
      ["Kitty Shift+Up with event type", "\x1b[1;2:1A", SCROLL_KEYS.pageUp],
      ["Kitty Shift+Down with event type", "\x1b[1;2:1B", SCROLL_KEYS.pageDown],
      ["legacy Shift+Up", "\x1b[1;2A", SCROLL_KEYS.pageUp],
      ["legacy Shift+Down", "\x1b[1;2B", SCROLL_KEYS.pageDown],
      ["application Home", "\x1b[H", SCROLL_KEYS.home],
      ["application End", "\x1b[F", SCROLL_KEYS.end],
      ["SS3 Home", "\x1bOH", SCROLL_KEYS.home],
      ["SS3 End", "\x1bOF", SCROLL_KEYS.end],
      ["VT Home", "\x1b[1~", SCROLL_KEYS.home],
      ["VT End", "\x1b[4~", SCROLL_KEYS.end],
    ];
    for (const [name, frame, canonical] of cases) {
      expect(`${name}:${normalizeChildOverlayScrollFrame(frame)}`).toBe(
        `${name}:${canonical}`,
      );
    }
  });

  it("ignores Kitty release frames so one press never pages twice", () => {
    expect(normalizeChildOverlayScrollFrame("\x1b[5;1:3~")).toBeUndefined();
    expect(normalizeChildOverlayScrollFrame("\x1b[1;2:3A")).toBeUndefined();
  });

  it("claims nothing that is not a scroll press", () => {
    // The exact Alt+I frame a live Kitty pane delivered.
    expect(normalizeChildOverlayScrollFrame("\x1b[105;3:1u")).toBeUndefined();
    expect(normalizeChildOverlayScrollFrame("\x1b[6;38;15t")).toBeUndefined();
    expect(normalizeChildOverlayScrollFrame("timeout")).toBeUndefined();
    expect(normalizeChildOverlayScrollFrame("")).toBeUndefined();
  });
});

describe("in-overlay search keyboard", () => {
  /**
   * The search ALIAS under the same protocol the live pane negotiated.
   *
   * The pane whose frames this file records delivered Alt+I as the Kitty
   * `ESC [ 105 ; 3 : 1 u` above, so it spells Ctrl+F `ESC [ 102 ; 5 u` and
   * `ESC [ 102 ; 5 : 1 u` — never the legacy `\x06` a byte-only alias was
   * written for. Ctrl+F therefore did nothing in that pane, on a draft where
   * `/` belongs to the steer and the alias is the ONLY opener.
   */
  it("opens on the alias in every encoding that pane can send", () => {
    for (const press of ["\x06", "\x1b[102;5u", "\x1b[102;5:1u"]) {
      const opened = stepOverlaySearch(
        CLOSED_OVERLAY_SEARCH,
        press,
        "fix packages/",
        PI_CHILD_OVERLAY_SEARCH_TRIGGER,
      );
      expect(`${JSON.stringify(press)}:${opened.state.mode}`).toBe(
        `${JSON.stringify(press)}:typing`,
      );
      // And the same press re-opens the committed query for editing.
      const reopened = stepOverlaySearch(
        { mode: "navigate", query: "needle", matchIndex: 2, accepted: true },
        press,
        "fix packages/",
        PI_CHILD_OVERLAY_SEARCH_TRIGGER,
      );
      expect(`${JSON.stringify(press)}:${reopened.effect.kind}`).toBe(
        `${JSON.stringify(press)}:reopen`,
      );
      expect(reopened.state.query).toBe("needle");
    }
  });

  it("ignores the alias release, so one press never toggles twice", () => {
    const release = "\x1b[102;5:3u";
    expect(
      stepOverlaySearch(
        CLOSED_OVERLAY_SEARCH,
        release,
        "",
        PI_CHILD_OVERLAY_SEARCH_TRIGGER,
      ).claimed,
    ).toBe(false);
    // The mounted component drops releases before its precedence chain; the
    // predicate refuses them too, so neither layer can act on the same press.
    expect(
      isChildOverlaySearchOpenInput(
        release,
        "",
        PI_CHILD_OVERLAY_SEARCH_TRIGGER,
      ),
    ).toBe(false);
  });

  it("leaves every encoding to the host when the alias is disabled", () => {
    for (const press of ["\x06", "\x1b[102;5u", "\x1b[102;5:1u"]) {
      expect(
        `${JSON.stringify(press)}:${isChildOverlaySearchOpenInput(press, "", undefined)}`,
      ).toBe(`${JSON.stringify(press)}:false`);
    }
    // Losing the alias never loses search.
    expect(isChildOverlaySearchOpenInput("/", "", undefined)).toBe(true);
  });

  it("commits and edits under Kitty encodings, not only raw bytes", () => {
    const typing = stepOverlaySearch(
      CLOSED_OVERLAY_SEARCH,
      "/",
      "",
      undefined,
    ).state;
    const typed = stepOverlaySearch(typing, "a", "", undefined).state;
    // Kitty Backspace.
    const edited = stepOverlaySearch(typed, "\x1b[127;1u", "", undefined);
    expect(edited.claimed).toBe(true);
    expect(edited.state.query).toBe("");

    const withQuery = stepOverlaySearch(typed, "b", "", undefined).state;
    // Kitty Enter.
    const committed = stepOverlaySearch(withQuery, "\x1b[13;1u", "", undefined);
    expect(committed.state.mode).toBe("navigate");
    expect(committed.effect).toEqual({ kind: "run", query: "ab" });
  });
});

const SETTLED_CHILD_ID = "settled-search-1";

/** A settled child whose session holds one tool call and its result. */
function settledChildSource() {
  return createMemoryChildOverlaySource([
    {
      childId: SETTLED_CHILD_ID,
      threadId: SETTLED_CHILD_ID,
      status: "settled",
      outcome: "completed",
      generationId: "gen-1",
      runs: [{ run: 1, action: "start" }],
      branchIds: ["main"],
      descendantChildIds: [],
      agentName: "shuttle",
      entries: [
        {
          id: "e0",
          payload: {
            type: "message",
            id: "e0",
            parentId: null,
            timestamp: "2026-01-01T00:00:00.000Z",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "running the suite" },
                {
                  type: "toolCall",
                  id: "toolu01",
                  name: "bash",
                  arguments: { timeout: 180 },
                },
              ],
            },
          },
        },
        {
          id: "e1",
          payload: {
            type: "message",
            id: "e1",
            parentId: "e0",
            timestamp: "2026-01-01T00:00:01.000Z",
            message: {
              role: "toolResult",
              toolCallId: "toolu01",
              toolName: "bash",
              content: [{ type: "text", text: "3 files pass" }],
              isError: false,
              timestamp: 1_700_000_000_000,
            },
          },
        },
      ],
    },
  ]);
}

/** The overlay as Pi mounts it, with a render host that never paints back. */
function mountedOverlay(
  controller: ReturnType<typeof createChildOverlayController>,
) {
  return createChildOverlayCustomComponent(
    { requestRender: () => undefined } as never,
    {} as never,
    getKeybindings() as never,
    controller,
    () => undefined,
    () => undefined,
    { cwd: "/workspace" },
  );
}

describe("overlay search indexes the rendered transcript", () => {
  const liveChildWithToolCall = async () => {
    const source = createMemoryChildOverlaySource([
      {
        childId: "search-1",
        threadId: "search-1",
        status: "live",
        generationId: "gen-1",
        runs: [{ run: 1, action: "start" }],
        branchIds: ["main"],
        descendantChildIds: [],
        agentName: "shuttle",
        entries: [],
      },
    ]);
    const controller = createChildOverlayController(source);
    (await controller.open("search-1"))._unsafeUnwrap();
    controller.applyLiveEvent({
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "bash",
      arguments: { timeout: 180 },
    });
    return controller;
  };

  it("indexes exactly the rows the reader is looking at", async () => {
    const controller = await liveChildWithToolCall();
    const view = controller.view()._unsafeUnwrap();
    const rendered = renderOverlayTranscript(
      plainPaint(),
      {
        entries: view.transcript.entries,
        childName: "shuttle",
        settled: false,
        windowEntries: view.entries,
        terminalErrorStated: false,
      },
      120,
    );
    const index = overlayTranscriptSearchIndex({
      plain: rendered.lines,
      spans: rendered.spans,
    });
    // The rendered tool row the live proof read on screen.
    expect([...index.values()].join("\n")).toContain("timeout: 180");

    // The overlay WINDOW entry for that same tool carries only the tool name,
    // which is why search reported `match 0/0` for text plainly on screen.
    const windowEntries = view.entries.map((entry) => ({
      id: entry.id,
      text: entry.text,
    }));
    expect(windowEntries.some((entry) => entry.text === "bash")).toBe(true);
    expect(matchingEntryIds(windowEntries, "timeout")).toEqual([]);
    expect(matchingEntryIds(windowEntries, "timeout", index).length).toBe(1);
  });

  it("finds a live tool row through the mounted overlay's own keys", async () => {
    const controller = await liveChildWithToolCall();
    const component = createChildOverlayCustomComponent(
      { requestRender: () => undefined } as never,
      {} as never,
      getKeybindings() as never,
      controller,
      () => undefined,
      () => undefined,
      { cwd: "/workspace" },
    );
    // One paint, exactly as a mounted overlay does before any key arrives.
    component.render(160);

    // The live keystrokes: `/`, the query, Enter.
    component.handleInput("/");
    component.render(160);
    for (const character of "timeout") component.handleInput(character);
    component.render(160);
    component.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.view()._unsafeUnwrap().searchMatches.length).toBe(1);

    // A query for nothing on screen still reports nothing.
    expect(
      (await controller.search("no-such-token-zz"))._unsafeUnwrap()
        .searchMatches,
    ).toEqual([]);
  });

  it("matches a live child when the whole query arrives in one frame", async () => {
    const controller = await liveChildWithToolCall();
    const component = mountedOverlay(controller);
    // The ONLY paint: exactly what a mounted overlay has drawn before the
    // reader touches the keyboard. Pi coalesces repaints, so `/timeout` and
    // Enter can all land inside one frame, and the index the query is matched
    // against is the one this render published.
    component.render(160);
    for (const character of "/timeout\r") component.handleInput(character);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const view = controller.view()._unsafeUnwrap();
    expect(view.searchQuery).toBe("timeout");
    expect(view.searchMatches.length).toBe(1);
  });

  it("matches a settled child when the whole query arrives in one frame", async () => {
    const controller = createChildOverlayController(settledChildSource());
    (await controller.open(SETTLED_CHILD_ID))._unsafeUnwrap();
    const component = mountedOverlay(controller);
    component.render(160);
    for (const character of "/timeout\r") component.handleInput(character);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const view = controller.view()._unsafeUnwrap();
    expect(view.searchQuery).toBe("timeout");
    expect(view.searchMatches.length).toBe(1);
    // The word is on screen and nowhere in the window entry's own short text,
    // so only the published render index can have matched it.
    expect(view.entries.some((entry) => entry.text.includes("timeout"))).toBe(
      false,
    );
  });

  it("publishes an empty query as no match, not as every entry", async () => {
    const controller = await liveChildWithToolCall();
    const component = mountedOverlay(controller);
    component.render(160);
    for (const character of "/\r") component.handleInput(character);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.view()._unsafeUnwrap().searchMatches).toEqual([]);
  });

  it("keys the published index by CURRENT window entry ids only", async () => {
    const controller = createChildOverlayController(settledChildSource());
    (await controller.open(SETTLED_CHILD_ID))._unsafeUnwrap();
    const view = controller.view()._unsafeUnwrap();
    const windowIds = new Set(view.entries.map((entry) => entry.id));
    expect(windowIds.size).toBeGreaterThan(0);

    const rendered = renderOverlayTranscript(
      plainPaint(),
      childOverlayTranscriptInput(view),
      120,
    );
    expect(rendered.searchIndex.size).toBeGreaterThan(0);
    for (const key of rendered.searchIndex.keys()) {
      expect(windowIds.has(key)).toBe(true);
    }

    // A rendered identity the window no longer holds is not an identity search
    // can look up, so it is never published — the retained index is bounded by
    // the window, not by the run.
    const orphaned = renderOverlayTranscript(
      plainPaint(),
      { ...childOverlayTranscriptInput(view), windowEntries: [] },
      120,
    );
    expect(orphaned.searchIndex.size).toBe(0);
  });
});

describe("Pi 0.84 queue_update reporting", () => {
  it("normalizes the host's own queue event into the queue fact", () => {
    const parsed = parseEvent({
      type: "queue_update",
      steering: ["steer one"],
      followUp: ["follow one", "follow two"],
    });
    expect(parsed).toEqual({
      type: "queue_change",
      size: 3,
      queue: ["steer one", "follow one", "follow two"],
    });
  });

  it("reports an empty queue as an authoritative zero", () => {
    expect(
      parseEvent({
        type: "queue_update",
        steering: [],
        followUp: [],
      }),
    ).toEqual({ type: "queue_change", size: 0, queue: [] });
  });

  it("makes the steered state observable on the delegation card", () => {
    const clock = (): number => 2_000;
    const started = applyDelegationCardInput(
      createDelegationCardState({ agentName: "shuttle", assignment: "probe" }),
      {
        kind: "start_run",
        threadId: "thread-opaque-1",
        runNumber: 1,
        action: "start",
        agentName: "shuttle",
      },
      clock,
    )._unsafeUnwrap();
    const event = parseEvent({
      type: "queue_update",
      steering: ["steer one"],
      followUp: [],
    });
    const steered = applyDelegationCardEvent(
      started,
      event,
      clock,
      "assistant",
    )._unsafeUnwrap();
    const facts = projectDelegationCardFacts(steered);
    expect(facts.run.phase).toBe("steered");
    expect(facts.activity).toEqual({
      kind: "queue",
      text: "1 queued · parent steered the child",
      live: false,
    });
  });
});
