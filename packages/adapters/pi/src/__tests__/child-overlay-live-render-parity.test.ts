/**
 * Live-seam parity between the shipped child inspector and its normative
 * prototype, `prototypes/weave-pi-tui-grilling.ts`.
 *
 * The existing prototype-parity suite pins the SHELL: it hands the compositor
 * pre-rendered transcript strings and hand-built rail facts, so it proves the
 * regions and the geometry and nothing about what a real child actually looks
 * like on screen. Two production bugs lived directly under that blind spot:
 *
 *   1. streamed message rows were the transcript renderer's DIAGNOSTIC strings
 *      (`assistant (streaming): …`, `tool: read [known] state:call`) instead of
 *      the prototype's `renderPiNative` design;
 *   2. the Status Matrix rail printed `—` for every WORK fact forever, because
 *      the facts were projected from the descriptor snapshot captured at open
 *      and no live event ever touched them.
 *
 * So this file drives PARSER-APPROVED LIVE EVENTS through the real seam —
 * `controller.applyLiveEvent` → `controller.view()` → the mounted `ui.custom`
 * component — and asserts the exact plain-text rows and the exact rail values
 * that come out. Nothing here is hand-rendered.
 */

import { describe, expect, it } from "bun:test";
import {
  initTheme,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, TUI } from "@earendil-works/pi-tui";
import {
  createChildOverlayController,
  createChildOverlayCustomComponent,
  createMemoryChildOverlaySource,
  type MemoryOverlaySourceChild,
} from "../child-overlay.js";
import {
  childOverlayRailFacts,
  childOverlayTranscriptInput,
} from "../child-overlay-facts.js";
import type { OverlayRailFacts } from "../child-overlay-layout.js";
import { renderOverlayPiNative } from "../child-overlay-pi-native.js";
import { transcriptFromOverlayEntries } from "../child-overlay-replay.js";
import {
  CHILD_OVERLAY_BURST_REPAINT_CEILING,
  createChildOverlayLiveStream,
} from "../child-overlay-stream.js";
import type { ChildOverlayView } from "../child-overlay-types.js";
import type { TimerHandle, TimerPort } from "../child-timer.js";
import type { PiUiThemePort } from "../types.js";
import { plainPaint } from "../ui-paint.js";

/** A timer the test drives, so no repaint can reach the host clock. */
class ScriptedTimerPort implements TimerPort {
  private pending: (() => void)[] = [];

  schedule(callback: () => void, _delayMs: number): TimerHandle {
    let live = true;
    this.pending.push(() => {
      if (live) callback();
    });
    return {
      cancel: () => {
        live = false;
      },
    };
  }

  fire(): void {
    const due = this.pending;
    this.pending = [];
    for (const tick of due) tick();
  }
}

initTheme("default");

const CHILD_ID = "render-parity-child";
const GENERATION = "generation-1";
/** Wide enough that no representative row is clipped by the pane. */
const WIDTH = 120;
/** Tall enough that the transcript window keeps every row it produced. */
const ROWS = 80;

const TEST_THEME: PiUiThemePort = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

/** Built from a code point so the source carries no control character. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");

function stripAnsi(value: string): string {
  return value.replace(ANSI, "");
}

function liveChild(): MemoryOverlaySourceChild {
  return {
    childId: CHILD_ID,
    threadId: CHILD_ID,
    status: "live",
    title: "render parity child",
    generationId: GENERATION,
    parentChildId: undefined,
    agentName: "shuttle",
    parentAgentName: "loom",
    model: "test-model",
    runs: [{ run: 3, action: "start" }],
    branchIds: ["main"],
    descendantChildIds: [],
    entries: [
      {
        id: "entry-0",
        payload: {
          type: "message",
          id: "entry-0",
          parentId: null,
          timestamp: new Date(1_700_000_000_000).toISOString(),
          message: {
            role: "user",
            content: [{ type: "text", text: "summarize the failing suite" }],
          },
        },
      },
    ],
  };
}

function testTui(): TUI & { requestRender(): void } {
  return Object.assign(Object.create(TUI.prototype) as TUI, {
    terminal: { rows: ROWS },
    requestRender: () => {},
  });
}

function open() {
  const source = createMemoryChildOverlaySource([liveChild()]);
  const controller = createChildOverlayController(source);
  const component = createChildOverlayCustomComponent(
    testTui(),
    TEST_THEME,
    getKeybindings() as unknown as KeybindingsManager,
    controller,
    () => {},
    () => {},
  );
  return { controller, component };
}

/**
 * Every ANSI-free row the inspector currently paints, frame columns removed.
 *
 * This is what a reader sees. Row identity is preserved: one rendered row in,
 * one string out, in order.
 */
function screenRows(component: {
  render(width: number): readonly string[];
}): string[] {
  return component
    .render(WIDTH)
    .map(stripAnsi)
    .slice(1, -1)
    .map((line) => line.slice(1, -1));
}

/** The transcript column alone: everything left of the rail separator. */
function transcriptRows(component: {
  render(width: number): readonly string[];
}): string[] {
  return screenRows(component).map((line) => {
    const split = line.indexOf("│");
    return (split === -1 ? line : line.slice(0, split)).replace(/\s+$/u, "");
  });
}

function currentView(controller: {
  view(): { isOk(): boolean; _unsafeUnwrap(): ChildOverlayView };
}): ChildOverlayView {
  const view = controller.view();
  expect(view.isOk()).toBe(true);
  return view._unsafeUnwrap();
}

function rail(controller: {
  view(): { isOk(): boolean; _unsafeUnwrap(): ChildOverlayView };
}): OverlayRailFacts {
  return childOverlayRailFacts(currentView(controller));
}

/** The ANSI-free transcript pane a view produces, rendered directly. */
function paneRows(view: ChildOverlayView, width = 76): readonly string[] {
  return renderOverlayPiNative(
    plainPaint(),
    childOverlayTranscriptInput(view),
    width,
  ).plain.map((line) => line.replace(/\s+$/u, ""));
}

// ---------------------------------------------------------------------------
// 1. Streamed message rows — exact prototype `renderPiNative` visuals
// ---------------------------------------------------------------------------

describe("live transcript rows match the prototype's renderPiNative design", () => {
  it("renders every representative event kind in the prototype's own style", async () => {
    const { controller, component } = open();
    (await controller.open(CHILD_ID))._unsafeUnwrap();

    for (const event of [
      {
        type: "reasoning_summary",
        text: "check the suite, then read the reporter",
      },
      {
        type: "tool_call",
        toolCallId: "call-1",
        toolName: "read",
        arguments: { file: "reporter.ts", limit: 40 },
      },
      {
        type: "tool_partial_result",
        toolCallId: "call-1",
        toolName: "read",
        partialResult: { content: "40 of 120 lines" },
      },
      {
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "read",
        result: { content: "120 lines read" },
      },
      {
        type: "tool_call",
        toolCallId: "call-2",
        toolName: "bash",
        arguments: { command: "bun test" },
      },
      {
        type: "tool_error",
        toolCallId: "call-2",
        toolName: "bash",
        error: "exit status 1",
      },
      { type: "queue_change", size: 2, queue: ["fix the reporter"] },
      { type: "status", status: "working", message: "second attempt" },
      { type: "retry", attempt: 2, reason: "transient provider error" },
      {
        type: "message_start",
        message: { role: "assistant", model: "test-model", content: [] },
      },
      { type: "message_update", delta: { text: "the reporter drops rows" } },
    ]) {
      controller.applyLiveEvent(event)._unsafeUnwrap();
    }

    const rows = transcriptRows(component);
    const has = (needle: string): boolean =>
      rows.some((row) => row.includes(needle));

    // -- delegation prompt -------------------------------------------------
    expect(has("❯ loom → shuttle delegation prompt")).toBe(true);
    expect(has("  summarize the failing suite")).toBe(true);

    // -- reasoning summary (never a thought stream) ------------------------
    expect(has("✻ reasoning · SUMMARY")).toBe(true);
    expect(has("  check the suite, then read the reporter")).toBe(true);

    // -- tool call, progress, result ---------------------------------------
    expect(has("⚙ read(")).toBe(true);
    expect(has("⎿ 120 lines read")).toBe(true);

    // -- tool error --------------------------------------------------------
    expect(has("⚙ bash(")).toBe(true);
    expect(has("⎿ exit status 1")).toBe(true);

    // -- queue / control ---------------------------------------------------
    expect(has("↯ queue 2")).toBe(true);
    expect(has("· status")).toBe(true);

    // -- retry / run divider -----------------------------------------------
    expect(has("retry · attempt 2")).toBe(true);

    // -- streaming assistant reply ----------------------------------------
    expect(has("● shuttle · streaming reply")).toBe(true);
    expect(has("  the reporter drops rows")).toBe(true);

    // -- and NONE of the diagnostic strings the old renderer emitted -------
    for (const leak of [
      "assistant (streaming):",
      "tool: read [known]",
      "tool arguments:",
      "tool result:",
      "queue: size=",
      "thinking:",
      "retry: attempt=",
    ]) {
      expect(rows.some((row) => row.includes(leak))).toBe(false);
    }
  });

  it("settles the streaming reply into a final response and freezes it", async () => {
    const { controller, component } = open();
    (await controller.open(CHILD_ID))._unsafeUnwrap();
    for (const event of [
      {
        type: "message_start",
        message: { role: "assistant", model: "test-model", content: [] },
      },
      { type: "message_update", delta: { text: "partial" } },
      {
        type: "message_end",
        message: {
          role: "assistant",
          model: "test-model",
          content: [{ type: "text", text: "the suite is green" }],
          usage: { input: 120, output: 340 },
        },
      },
    ]) {
      controller.applyLiveEvent(event)._unsafeUnwrap();
    }
    const rows = transcriptRows(component);
    expect(rows.some((r) => r.includes("▍"))).toBe(false);
    expect(rows.some((r) => r.includes("● shuttle · reply"))).toBe(true);
    expect(rows.some((r) => r.includes("  the suite is green"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. The Status Matrix rail is live
// ---------------------------------------------------------------------------

describe("the Status Matrix rail updates from live events", () => {
  it("moves off `—` for every work fact as events arrive", async () => {
    const { controller } = open();
    (await controller.open(CHILD_ID))._unsafeUnwrap();

    const before = rail(controller);
    expect(before.tool).toBeUndefined();

    controller
      .applyLiveEvent({
        type: "tool_call",
        toolCallId: "call-1",
        toolName: "read",
        arguments: { limit: 40 },
      })
      ._unsafeUnwrap();
    const called = rail(controller);
    expect(called.tool).toBe("read");
    expect(called.args).toBe("limit: 40");
    expect(called.live).toBe("running read");

    controller
      .applyLiveEvent({
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "read",
        result: { content: "120 lines read" },
      })
      ._unsafeUnwrap();
    const resulted = rail(controller);
    expect(resulted.toolOutcome).toBe("120 lines read");
    expect(resulted.failed).toBe(false);
    expect(resulted.live).toBe("read done");

    controller
      .applyLiveEvent({
        type: "tool_call",
        toolCallId: "call-2",
        toolName: "bash",
        arguments: { command: "bun test" },
      })
      ._unsafeUnwrap();
    controller
      .applyLiveEvent({
        type: "tool_error",
        toolCallId: "call-2",
        toolName: "bash",
        error: "exit status 1",
      })
      ._unsafeUnwrap();
    const failed = rail(controller);
    expect(failed.tool).toBe("bash");
    expect(failed.target).toBe("bun test");
    expect(failed.failed).toBe(true);
    expect(failed.toolOutcome).toBe("exit status 1");
    // The alert pair already prints the outcome, so the detail row stays
    // absent rather than repeating it.
    expect(failed.errorDetail).toBeUndefined();

    controller
      .applyLiveEvent({
        type: "queue_change",
        size: 2,
        queue: ["fix the reporter"],
      })
      ._unsafeUnwrap();
    const queued = rail(controller);
    expect(queued.queueCount).toBe(2);
    // The queued PROMPTS are redacted upstream by the reducer-visible value
    // projection, so `next` stays unknown. The rail states that rather than
    // inventing a preview.
    expect(queued.firstQueued).toBeUndefined();

    controller
      .applyLiveEvent({
        type: "status",
        status: "working",
        message: "second attempt",
      })
      ._unsafeUnwrap();
    expect(rail(controller).status).toContain("working");

    controller
      .applyLiveEvent({
        type: "message_start",
        message: { role: "assistant", model: "test-model", content: [] },
      })
      ._unsafeUnwrap();
    controller
      .applyLiveEvent({
        type: "message_end",
        message: {
          role: "assistant",
          model: "test-model",
          content: [{ type: "text", text: "done" }],
          usage: { input: 1200, output: 3400, cost: { total: 0.42 } },
        },
      })
      ._unsafeUnwrap();
    const spent = rail(controller);
    expect(spent.turn).toBe("1");
    // SPEND is a RUN total, and the host's LATEST report is one: every turn
    // re-sends the whole context, so a report is the run so far priced again
    // rather than a slice to be added up. The rail states that report, which
    // is the same figure the parent's delegation card prints. This message
    // stated no `totalTokens`, so the input side is the components it did
    // state.
    expect(spent.tokensIn).toBe("1.2k");
    expect(spent.tokensOut).toBe("3.4k");
    expect(spent.cost).toBe("$0.4200");
  });
});

// ---------------------------------------------------------------------------
// 3. Direct prototype-parity fixtures, one per streamed event kind
// ---------------------------------------------------------------------------

/**
 * The exact rows one event kind produces, through the real seam.
 *
 * Each fixture opens a child, applies parser-approved events, and pins the
 * whole ANSI-free row block — glyph, spacing, label, continuation mark and the
 * trailing separator row included. A drift in any of them fails here, which is
 * what the shell-only parity suite could not do.
 */
async function rowsFor(events: readonly unknown[]): Promise<readonly string[]> {
  const { controller } = open();
  (await controller.open(CHILD_ID))._unsafeUnwrap();
  for (const event of events) controller.applyLiveEvent(event)._unsafeUnwrap();
  const view = currentView(controller);
  // Drop the seeded delegation prompt; each fixture pins its own kind.
  const rows = paneRows(view);
  const start = rows.indexOf("");
  return rows.slice(start + 1);
}

describe("every streamed event kind matches its prototype fixture", () => {
  it("delegation prompt", async () => {
    const { controller } = open();
    (await controller.open(CHILD_ID))._unsafeUnwrap();
    expect(paneRows(currentView(controller))).toEqual([
      "❯ loom → shuttle delegation prompt",
      "  summarize the failing suite",
      "",
    ]);
  });

  it("reasoning summary", async () => {
    expect(
      await rowsFor([{ type: "reasoning_summary", text: "read the reporter" }]),
    ).toEqual(["✻ reasoning · SUMMARY", "  read the reporter", ""]);
  });

  it("raw reasoning is a content-free marker, never a summary", async () => {
    const rows = await rowsFor([
      { type: "thinking", text: "RAW_CHAIN_OF_THOUGHT" },
    ]);
    expect(rows).toEqual(["✻ reasoning", ""]);
    expect(rows.join("\n")).not.toContain("RAW_CHAIN_OF_THOUGHT");
    expect(rows.join("\n")).not.toContain("SUMMARY");
  });

  it("tool call", async () => {
    expect(
      await rowsFor([
        {
          type: "tool_call",
          toolCallId: "c1",
          toolName: "read",
          arguments: { limit: 40 },
        },
      ]),
    ).toEqual(["⚙ read(limit: 40)", "  ⎿ running", ""]);
  });

  it("tool progress", async () => {
    expect(
      await rowsFor([
        {
          type: "tool_call",
          toolCallId: "c1",
          toolName: "read",
          arguments: {},
        },
        {
          type: "tool_partial_result",
          toolCallId: "c1",
          toolName: "read",
          partialResult: { content: "40 of 120 lines" },
        },
      ]),
    ).toEqual(["⚙ read()", "  ⎿ 40 of 120 lines", ""]);
  });

  it("tool result", async () => {
    expect(
      await rowsFor([
        {
          type: "tool_call",
          toolCallId: "c1",
          toolName: "read",
          arguments: {},
        },
        {
          type: "tool_result",
          toolCallId: "c1",
          toolName: "read",
          result: { content: "120 lines read" },
        },
      ]),
    ).toEqual(["⚙ read()", "  ⎿ 120 lines read", ""]);
  });

  it("tool error", async () => {
    expect(
      await rowsFor([
        {
          type: "tool_call",
          toolCallId: "c1",
          toolName: "bash",
          arguments: {},
        },
        {
          type: "tool_error",
          toolCallId: "c1",
          toolName: "bash",
          error: "exit status 1",
        },
      ]),
    ).toEqual(["⚙ bash()", "  ⎿ exit status 1", ""]);
  });

  it("queue control", async () => {
    expect(
      await rowsFor([{ type: "queue_change", size: 2, queue: ["later"] }]),
    ).toEqual(["↯ queue 2", ""]);
  });

  it("status control", async () => {
    expect(
      await rowsFor([
        { type: "status", status: "working", message: "second attempt" },
      ]),
    ).toEqual(["· status working · second attempt", ""]);
  });

  it("retry run divider", async () => {
    const rows = await rowsFor([
      { type: "retry", attempt: 2, reason: "transient provider error" },
    ]);
    expect(
      rows[0]?.startsWith("── retry · attempt 2 · transient provider error ──"),
    ).toBe(true);
    expect(rows[1]).toBe("");
  });

  it("assistant message streaming, then settled", async () => {
    const streaming = await rowsFor([
      {
        type: "message_start",
        message: { role: "assistant", model: "test-model", content: [] },
      },
      { type: "message_update", delta: { text: "half an answer" } },
    ]);
    expect(streaming).toEqual([
      "● shuttle · streaming reply",
      "  half an answer",
      "",
    ]);

    const ended = await rowsFor([
      {
        type: "message_start",
        message: { role: "assistant", model: "test-model", content: [] },
      },
      { type: "message_update", delta: { text: "half" } },
      {
        type: "message_end",
        message: {
          role: "assistant",
          model: "test-model",
          content: [{ type: "text", text: "the whole answer" }],
        },
      },
    ]);
    expect(ended).toEqual(["● shuttle · reply", "  the whole answer", ""]);
  });

  it("usage report", async () => {
    expect(
      await rowsFor([{ type: "usage", usage: { input: 10, output: 20 } }]),
    ).toEqual(["· usage input: 10, output: 20", ""]);
  });
});

// ---------------------------------------------------------------------------
// 4. Burst ordering, and replay/live equivalence
// ---------------------------------------------------------------------------

/** 500 parser-approved events across every family the pane draws. */
function burstEvents(count: number): readonly unknown[] {
  const events: unknown[] = [];
  for (let index = 0; events.length < count; index += 1) {
    events.push(
      { type: "reasoning_summary", text: `summary ${index}` },
      {
        type: "tool_call",
        toolCallId: `call-${index}`,
        toolName: "read",
        arguments: { limit: index },
      },
      {
        type: "tool_result",
        toolCallId: `call-${index}`,
        toolName: "read",
        result: { content: `read ${index}` },
      },
      { type: "queue_change", size: index % 3, queue: [] },
      {
        type: "message_start",
        message: { role: "assistant", model: "test-model", content: [] },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          model: "test-model",
          content: [{ type: "text", text: `answer ${index}` }],
          usage: { input: index, output: index * 2 },
        },
      },
    );
  }
  return events.slice(0, count);
}

describe("burst delivery and historical replay agree with ordered rendering", () => {
  it("a 500-event burst leaves the same transcript and rail as ordered rendering", async () => {
    const events = burstEvents(500);

    // Ordered: one repaint between every event.
    const ordered = open();
    (await ordered.controller.open(CHILD_ID))._unsafeUnwrap();
    for (const event of events) {
      ordered.controller.applyLiveEvent(event)._unsafeUnwrap();
      ordered.component.invalidate();
      ordered.component.render(WIDTH);
    }

    // Burst: every event ingested through the coalescing live stream before a
    // single frame is painted.
    const burst = open();
    (await burst.controller.open(CHILD_ID))._unsafeUnwrap();
    const timer = new ScriptedTimerPort();
    let repaints = 0;
    const stream = createChildOverlayLiveStream({
      controller: burst.controller,
      repaint: {
        invalidate: () => burst.component.invalidate(),
        requestRender: () => {
          repaints += 1;
          burst.component.render(WIDTH);
        },
      },
      currentGenerationId: () => GENERATION,
      generationId: GENERATION,
      timer,
    });
    for (const event of events) {
      expect(stream.ingest(CHILD_ID, event).kind).toBe("applied");
    }
    timer.fire();

    expect(paneRows(currentView(burst.controller))).toEqual(
      paneRows(currentView(ordered.controller)),
    );
    expect(rail(burst.controller)).toEqual(rail(ordered.controller));
    // Coalescing drops frames, never facts: the whole burst costs the same
    // documented, constant number of repaints one event does.
    expect(repaints).toBeLessThanOrEqual(CHILD_OVERLAY_BURST_REPAINT_CEILING);
    expect(transcriptRows(burst.component).length).toBeGreaterThan(0);
    stream.dispose();
  });

  it("a window rebuilt from replay steps renders the same rows and rail", async () => {
    const { controller } = open();
    (await controller.open(CHILD_ID))._unsafeUnwrap();
    for (const event of burstEvents(40)) {
      controller.applyLiveEvent(event)._unsafeUnwrap();
    }
    const live = currentView(controller);
    const replayed: ChildOverlayView = {
      ...live,
      transcript: transcriptFromOverlayEntries(live.entries),
    };
    expect(paneRows(replayed)).toEqual(paneRows(live));
    expect(childOverlayRailFacts(replayed)).toEqual(
      childOverlayRailFacts(live),
    );
  });
});
