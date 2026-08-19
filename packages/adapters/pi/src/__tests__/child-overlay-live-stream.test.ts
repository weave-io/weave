/**
 * The live streaming contract behind both Weave surfaces, proved end to end.
 *
 * Six properties are asserted here, each of which a reader depends on but none
 * of which the reducer alone can guarantee:
 *
 * 1. **Replay parity.** A window rebuilt through
 *    `transcriptFromOverlayEntries` + `mergeReplaySteps` reproduces the same
 *    transcript the live pipeline produced, for every fact the redesign reads.
 * 2. **Late and misdirected events are dropped.** An event for an unfocused
 *    child, a replaced generation, or a settled child cannot mutate a view the
 *    reader is entitled to read as final.
 * 3. **Bounds stay authoritative.** Window cap, page size, LRU and the search
 *    page budget are the ones declared in `CHILD_OVERLAY_BOUNDS`, and a match
 *    trimmed out of the window still counts toward the reported total.
 * 4. **Backpressure.** A 5,000-event burst costs a documented, constant number
 *    of repaints, scheduled only through the injected timer.
 * 5. **Malformed events.** A schema-invalid event never reaches the pane as
 *    raw prose; the bounded `unknown` variant is suppressed there.
 * 6. **A settled child is read-only.** No editor, no caret, no mutation, and
 *    the state word on both the frame and the rail.
 * 7. **Settlement refreshes the descriptor before it repaints.** The one final
 *    frame is drawn from re-read identity and status facts, not from the live
 *    snapshot captured when the reader opened the child, and an unanswerable
 *    refresh fails closed to read-only instead of leaving a live prompt.
 */

import { describe, expect, it } from "bun:test";
import {
  initTheme,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, TUI } from "@earendil-works/pi-tui";
import { err, type Result, ResultAsync } from "neverthrow";
import {
  createPiLiveReasoningRegistry,
  type PiLiveReasoningUpdate,
} from "../child-live-reasoning.js";
import {
  createChildOverlayController,
  createChildOverlayCustomComponent,
  createChildOverlayLiveStream,
  createMemoryChildOverlaySource,
  type MemoryOverlaySourceChild,
  mergeChildOverlayReplaySteps,
} from "../child-overlay.js";
import { childOverlayTranscriptInput } from "../child-overlay-facts.js";
import { renderOverlayPiNative } from "../child-overlay-pi-native.js";
import { transcriptFromOverlayEntries } from "../child-overlay-replay.js";
import {
  CHILD_OVERLAY_BURST_REPAINT_CEILING,
  CHILD_OVERLAY_REPAINT_INTERVAL_MS,
  type ChildOverlayLiveEventOutcome,
} from "../child-overlay-stream.js";
import {
  CHILD_OVERLAY_BOUNDS,
  type ChildOverlayChild,
  type ChildOverlayEntry,
  type ChildOverlaySourceError,
  type ChildOverlaySourcePort,
  type ChildOverlayView,
} from "../child-overlay-types.js";
import { preserveUnknownChildEvent } from "../child-session-events.js";
import type { TimerHandle, TimerPort } from "../child-timer.js";
import type { PiChildTranscriptState } from "../child-transcript.js";
import { createChildUiEventDiagnostics } from "../child-ui-event-diagnostics.js";
import type { PiUiThemePort } from "../types.js";
import { plainPaint } from "../ui-paint.js";

initTheme("default");

const CHILD_ID = "live-stream-child-1";
const OTHER_CHILD_ID = "live-stream-child-2";
const GENERATION = "generation-1";
const WIDTH = 72;
const ROWS = 34;

const TEST_THEME: PiUiThemePort = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

// ---------------------------------------------------------------------------
// A timer the test drives
// ---------------------------------------------------------------------------

/**
 * Records every scheduled callback instead of reaching the host clock. If any
 * overlay stream path ever called `setTimeout` itself, the repaint counts
 * below would stop adding up.
 */
class ScriptedTimerPort implements TimerPort {
  readonly delays: number[] = [];
  private pending: (() => void)[] = [];
  cancelled = 0;

  schedule(callback: () => void, delayMs: number): TimerHandle {
    this.delays.push(delayMs);
    let live = true;
    this.pending.push(() => {
      if (live) callback();
    });
    return {
      cancel: () => {
        if (live) this.cancelled += 1;
        live = false;
      },
    };
  }

  /** Closes every window currently open. */
  fire(): void {
    const due = this.pending;
    this.pending = [];
    for (const tick of due) tick();
  }

  get open(): number {
    return this.pending.length;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function liveChild(
  childId = CHILD_ID,
  entries: MemoryOverlaySourceChild["entries"] = [],
): MemoryOverlaySourceChild {
  return {
    childId,
    threadId: childId,
    status: "live",
    title: "live stream child",
    generationId: GENERATION,
    parentChildId: undefined,
    agentName: "shuttle",
    model: "test-model",
    runs: [{ run: 1, action: "start" }],
    branchIds: ["main"],
    descendantChildIds: [],
    entries,
  };
}

function settledChild(
  childId = CHILD_ID,
  entries: MemoryOverlaySourceChild["entries"] = [],
): MemoryOverlaySourceChild {
  return { ...liveChild(childId, entries), status: "settled" };
}

/** One persisted assistant message, in the shape the native session file uses. */
function persistedEntry(index: number, text: string) {
  return {
    id: `entry-${index}`,
    payload: {
      type: "message",
      id: `entry-${index}`,
      parentId: index === 0 ? null : `entry-${index - 1}`,
      timestamp: new Date(1_700_000_000_000 + index).toISOString(),
      message: { role: "assistant", content: [{ type: "text", text }] },
    },
  };
}

function openLive(
  child: MemoryOverlaySourceChild = liveChild(),
  others: readonly MemoryOverlaySourceChild[] = [],
  config: Parameters<typeof createChildOverlayController>[1] = {},
) {
  const source = createMemoryChildOverlaySource([child, ...others]);
  const controller = createChildOverlayController(source, config);
  return { source, controller };
}

/**
 * The transcript-relevant shape of one reduced entry.
 *
 * The reducer-local `id` (`assistant-62`) is deliberately excluded: it counts
 * reduced actions, and a streaming `message_update` is transcript-neutral on
 * rebuild (its terminal `message_end` carries the whole message), so the two
 * paths legitimately reach the same entry at different action counts. The
 * identity the UI anchors on is `overlayEntryId`, and that is compared.
 */
function transcriptFacts(state: PiChildTranscriptState): unknown[] {
  return state.entries.map((entry) => {
    const record = entry as unknown as Record<string, unknown>;
    return {
      kind: record.kind,
      text: record.text ?? "",
      thinking: record.thinking ?? "",
      overlayEntryId: record.overlayEntryId,
      size: record.size,
      toolName: record.toolName,
      isError: record.isError,
    };
  });
}

/** One realistic live turn: reasoning, a tool with a continuation, an answer. */
function turnEvents(index: number): readonly unknown[] {
  const toolCallId = `call-${index}`;
  return [
    { type: "thinking", text: `reasoning summary head ${index}` },
    {
      type: "tool_call",
      toolCallId,
      toolName: "read",
      arguments: { target: `target-${index}` },
    },
    {
      type: "tool_partial_result",
      toolCallId,
      toolName: "read",
      partialResult: { content: `partial-${index}` },
    },
    {
      type: "tool_result",
      toolCallId,
      toolName: "read",
      result: { content: `whole-${index}`, isError: false },
    },
    { type: "queue_change", size: index + 1, queue: [`queued-${index}`] },
    {
      type: "tool_error",
      toolCallId: `failing-${index}`,
      toolName: "bash",
      error: `tool failed ${index}`,
    },
    {
      type: "message_start",
      message: { role: "assistant", model: "test-model", content: [] },
    },
    { type: "message_update", delta: { text: `stream-${index}` } },
    {
      type: "message_end",
      message: {
        role: "assistant",
        model: "test-model",
        content: [{ type: "text", text: `answer ${index}` }],
        usage: { input: 10, output: 20 },
      },
    },
  ];
}

function testTui(rows = ROWS): TUI & { requestRender(): void } {
  return Object.assign(Object.create(TUI.prototype) as TUI, {
    terminal: { rows },
    requestRender: () => {},
  });
}

function testKeybindings(): KeybindingsManager {
  return getKeybindings() as unknown as KeybindingsManager;
}

function mountPane(
  controller: ReturnType<typeof createChildOverlayController>,
) {
  return createChildOverlayCustomComponent(
    testTui(),
    TEST_THEME,
    testKeybindings(),
    controller,
    () => {},
    () => {},
    { cwd: "/workspace" },
  );
}

// ---------------------------------------------------------------------------
// 1. Replay parity
// ---------------------------------------------------------------------------

describe("overlay replay reproduces the live projection", () => {
  it("rebuilds reasoning heads, tool continuations, queue rows and error rows", async () => {
    const { controller } = openLive();
    expect((await controller.open(CHILD_ID)).isOk()).toBe(true);
    for (const event of turnEvents(0)) {
      expect(controller.applyLiveEvent(event).isOk()).toBe(true);
    }
    const view = controller.view()._unsafeUnwrap();
    const rebuilt = transcriptFromOverlayEntries(view.entries);

    // Every live fact family is present, and the rebuild reproduces each one.
    const liveFacts = transcriptFacts(view.transcript);
    const kinds = liveFacts.map((fact) => (fact as { kind: string }).kind);
    expect(kinds).toContain("thinking");
    expect(kinds).toContain("tool");
    expect(kinds).toContain("queue");
    expect(kinds).toContain("assistant");
    expect(transcriptFacts(rebuilt)).toEqual(liveFacts);

    // The tool call and its result are ONE entry: the result continues the
    // call rather than opening a second row.
    const toolEntries = view.entries.filter((entry) => entry.kind === "tool");
    expect(toolEntries).toHaveLength(1);
    expect(toolEntries[0]?.id).toBe("call-0");
    // The error row is its own entry and keeps error identity.
    const errorEntries = view.entries.filter((entry) => entry.kind === "error");
    expect(errorEntries).toHaveLength(1);
    expect(errorEntries[0]?.id).toBe("failing-0");
  });

  it("carries the queue fact as a replay step so a rebuilt window still shows it", async () => {
    const { controller } = openLive();
    expect((await controller.open(CHILD_ID)).isOk()).toBe(true);
    expect(
      controller
        .applyLiveEvent({ type: "queue_change", size: 3, queue: ["a"] })
        .isOk(),
    ).toBe(true);
    const view = controller.view()._unsafeUnwrap();
    const queueEntry = view.entries.find((entry) =>
      entry.id.startsWith("live-queue-"),
    );
    expect(queueEntry).toBeDefined();
    expect(queueEntry?.replay?.length).toBe(1);

    const rebuilt = transcriptFromOverlayEntries(view.entries);
    const rebuiltQueue = rebuilt.entries.find(
      (entry) => (entry as { kind: string }).kind === "queue",
    ) as { size?: number } | undefined;
    expect(rebuiltQueue).toBeDefined();
    expect(rebuiltQueue?.size).toBe(3);
  });

  it("merges a tool continuation into one bounded replay sequence", async () => {
    const { controller } = openLive();
    expect((await controller.open(CHILD_ID)).isOk()).toBe(true);
    for (const event of turnEvents(0).slice(0, 4)) {
      expect(controller.applyLiveEvent(event).isOk()).toBe(true);
    }
    const entry = controller
      .view()
      ._unsafeUnwrap()
      .entries.find((item) => item.id === "call-0");
    expect(entry).toBeDefined();

    // The merged sequence is exactly what `mergeReplaySteps` produces from the
    // same parts, and it stays inside the replay-step bound.
    const merged = mergeChildOverlayReplaySteps(
      entry?.replay?.slice(0, 1),
      entry?.replay?.slice(1),
    );
    expect(merged.isOk()).toBe(true);
    expect(entry?.replay?.length).toBeLessThanOrEqual(
      CHILD_OVERLAY_BOUNDS.maxEntryReplaySteps,
    );
    const types = (entry?.replay ?? []).map((step) =>
      step.kind === "event" ? step.event.type : step.kind,
    );
    expect(types).toEqual(["tool_call", "tool_partial_result", "tool_result"]);
  });

  it("stays byte-identical across eight replayed turns", async () => {
    const { controller } = openLive();
    expect((await controller.open(CHILD_ID)).isOk()).toBe(true);
    for (let index = 0; index < 8; index += 1) {
      for (const event of turnEvents(index)) {
        expect(controller.applyLiveEvent(event).isOk()).toBe(true);
      }
    }
    const view = controller.view()._unsafeUnwrap();
    const rebuilt = transcriptFromOverlayEntries(view.entries);
    expect(transcriptFacts(rebuilt)).toEqual(transcriptFacts(view.transcript));
    // The anchoring identity survives the rebuild entry for entry.
    const overlayIds = (state: PiChildTranscriptState) =>
      state.entries.map(
        (entry) => (entry as unknown as Record<string, unknown>).overlayEntryId,
      );
    expect(overlayIds(rebuilt)).toEqual(overlayIds(view.transcript));
    expect(overlayIds(rebuilt).filter((id) => id === undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Late, misdirected and post-settlement events
// ---------------------------------------------------------------------------

interface StreamHarness {
  readonly controller: ReturnType<typeof createChildOverlayController>;
  stream: ReturnType<typeof createChildOverlayLiveStream>;
  readonly timer: ScriptedTimerPort;
  repaints: number;
  invalidates: number;
  generation: string;
  liveChildren: Set<string>;
  diagnostics: ReturnType<typeof createChildUiEventDiagnostics>;
}

async function harness(
  child: MemoryOverlaySourceChild = liveChild(),
  others: readonly MemoryOverlaySourceChild[] = [],
  config: Parameters<typeof createChildOverlayController>[1] = {},
): Promise<StreamHarness> {
  const { controller } = openLive(child, others, config);
  expect((await controller.open(child.childId)).isOk()).toBe(true);
  const timer = new ScriptedTimerPort();
  const diagnostics = createChildUiEventDiagnostics();
  const state: StreamHarness = {
    controller,
    timer,
    repaints: 0,
    invalidates: 0,
    generation: GENERATION,
    liveChildren: new Set(
      [child, ...others]
        .filter((candidate) => candidate.status === "live")
        .map((candidate) => candidate.childId),
    ),
    diagnostics,
    stream: undefined as never,
  };
  // The harness IS the mutable state the stream reads: a copy would let the
  // test change a generation the stream never sees.
  state.stream = createChildOverlayLiveStream({
    controller,
    repaint: {
      invalidate: () => {
        state.invalidates += 1;
      },
      requestRender: () => {
        state.repaints += 1;
      },
    },
    timer,
    generationId: GENERATION,
    currentGenerationId: () => state.generation,
    resolveLiveThreadId: (childId) =>
      state.liveChildren.has(childId) ? childId : undefined,
    diagnostics,
  });
  return state;
}

function entrySnapshot(view: ChildOverlayView): readonly ChildOverlayEntry[] {
  return JSON.parse(JSON.stringify(view.entries)) as ChildOverlayEntry[];
}

function drops(
  outcomes: readonly ChildOverlayLiveEventOutcome[],
): readonly string[] {
  return outcomes.map((outcome) =>
    outcome.kind === "dropped" ? outcome.reason : "applied",
  );
}

function reasoningUpdate(
  phase: PiLiveReasoningUpdate["phase"],
  text: string,
  options: {
    readonly childId?: string;
    readonly generationId?: string;
    readonly lifecycleEpoch?: number;
    readonly contentIndex?: number;
  } = {},
): PiLiveReasoningUpdate {
  return {
    childId: options.childId ?? CHILD_ID,
    generationId: options.generationId ?? GENERATION,
    lifecycleEpoch: options.lifecycleEpoch ?? 1,
    phase,
    contentIndex: options.contentIndex ?? 0,
    text,
  };
}

function nativeRows(
  controller: ReturnType<typeof createChildOverlayController>,
): string[] {
  const view = controller.view()._unsafeUnwrap();
  return renderOverlayPiNative(
    plainPaint(),
    childOverlayTranscriptInput(view),
    WIDTH,
  ).plain.map((row) => row.replace(/\s+$/u, ""));
}

describe("the live stream drops what must not reach the pane", () => {
  it("applies an event for the focused live child", async () => {
    const h = await harness();
    const outcome = h.stream.ingest(CHILD_ID, {
      type: "thinking",
      text: "focused",
    });
    expect(outcome.kind).toBe("applied");
    expect(h.controller.view()._unsafeUnwrap().entries).toHaveLength(1);
  });

  it("shows the first authoritative text delta through the full live path", async () => {
    const h = await harness();
    const ingest = (event: unknown): void => {
      expect(h.stream.ingest(CHILD_ID, event)).toEqual({ kind: "applied" });
    };

    // Pre-fix red evidence from Pi 0.84.2: parser, fanout, overlay mapping,
    // reduction and replay all returned content, but native-render printed
    // `● shuttle · streaming reply` with only `  ▍` after message_start. The
    // first content-free contract failure was therefore the renderer seam,
    // not message correlation or a missing text delta.
    ingest({
      type: "message_start",
      message: { role: "assistant", model: "test-model", content: [] },
    });
    expect(nativeRows(h.controller)).not.toContain("shuttle · streaming reply");

    ingest({
      type: "message_update",
      usage: { input: 1, output: 1 },
      assistantMessageEvent: { type: "text_start", contentIndex: 1 },
    });
    expect(nativeRows(h.controller)).not.toContain("shuttle · streaming reply");

    ingest({
      type: "message_update",
      usage: { input: 1, output: 1 },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: "first valid fragment",
      },
    });
    expect(nativeRows(h.controller)).toContain("shuttle · streaming reply");
    expect(nativeRows(h.controller)).toContain("  first valid fragment");
    expect(nativeRows(h.controller)).not.toContain(
      "● shuttle · streaming reply",
    );

    ingest({
      type: "message_update",
      usage: { input: 1, output: 2 },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: " and the next fragment",
      },
    });
    const growing = nativeRows(h.controller);
    expect(
      growing.filter((row) => row === "shuttle · streaming reply"),
    ).toHaveLength(1);
    expect(growing).toContain("  first valid fragment and the next fragment");

    ingest({
      type: "message_update",
      usage: { input: 1, output: 3 },
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 1,
        content: "first valid fragment and the next fragment",
      },
    });
    ingest({
      type: "message_end",
      message: {
        role: "assistant",
        model: "test-model",
        content: [
          { type: "text", text: "first valid fragment and the next fragment" },
        ],
      },
    });
    const settled = nativeRows(h.controller);
    expect(settled.some((row) => row === "shuttle · streaming reply")).toBe(
      false,
    );
    expect(
      settled.filter((row) =>
        row.includes("first valid fragment and the next fragment"),
      ),
    ).toHaveLength(1);
    h.stream.dispose();
  });

  it("drops an event addressed to a child the reader is not looking at", async () => {
    const h = await harness(liveChild(), [liveChild(OTHER_CHILD_ID)]);
    const before = entrySnapshot(h.controller.view()._unsafeUnwrap());
    const outcome = h.stream.ingest(OTHER_CHILD_ID, {
      type: "thinking",
      text: "belongs to the other child",
    });
    expect(drops([outcome])).toEqual(["unfocused-child"]);
    expect(entrySnapshot(h.controller.view()._unsafeUnwrap())).toEqual(before);
    expect(h.repaints).toBe(0);
  });

  it("drops an event from a generation that has been replaced", async () => {
    const h = await harness();
    const before = entrySnapshot(h.controller.view()._unsafeUnwrap());
    h.generation = "generation-2";
    const outcome = h.stream.ingest(CHILD_ID, {
      type: "thinking",
      text: "from the old generation",
    });
    expect(drops([outcome])).toEqual(["stale-generation"]);
    expect(entrySnapshot(h.controller.view()._unsafeUnwrap())).toEqual(before);
    expect(h.repaints).toBe(0);
  });

  it("returns a typed stream failure when overlay application rejects", async () => {
    const h = await harness();
    const originalApply = h.controller.applyLiveEvent;
    h.controller.applyLiveEvent = () => err({ type: "OverlayNotOpen" });
    const outcome = h.stream.ingest(CHILD_ID, {
      type: "thinking",
      text: "rejected",
    });
    h.controller.applyLiveEvent = originalApply;

    expect(outcome).toEqual({
      kind: "failed",
      stage: "stream-ingest",
      reason: "stream-apply-failed",
    });
    expect(h.diagnostics.snapshot().buckets).toContainEqual(
      expect.objectContaining({
        stage: "stream-ingest",
        reason: "stream-apply-failed",
        disposition: "failed",
      }),
    );
  });

  it("drops every event that arrives after the focused child settled", async () => {
    const h = await harness();
    expect(
      h.stream.ingest(CHILD_ID, { type: "thinking", text: "a" }).kind,
    ).toBe("applied");
    // The child leaves the live set: the delegation tree change is the only
    // settlement signal the overlay gets.
    h.liveChildren.delete(CHILD_ID);
    h.stream.noteTreeChanged();
    // Settlement re-reads the authoritative descriptor first; the final frame
    // is published when that answer lands.
    await h.stream.settlementPending();
    expect(h.stream.isSettled()).toBe(true);
    const frozen = entrySnapshot(h.controller.view()._unsafeUnwrap());

    const late = [
      h.stream.ingest(CHILD_ID, { type: "thinking", text: "late 1" }),
      h.stream.ingest(CHILD_ID, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "b" }] },
      }),
    ];
    expect(drops(late)).toEqual(["settled", "settled"]);
    expect(entrySnapshot(h.controller.view()._unsafeUnwrap())).toEqual(frozen);
  });

  it("drops events for an already-settled child without repainting", async () => {
    const h = await harness(settledChild());
    const before = entrySnapshot(h.controller.view()._unsafeUnwrap());
    const outcome = h.stream.ingest(CHILD_ID, {
      type: "thinking",
      text: "history cannot change",
    });
    expect(drops([outcome])).toEqual(["settled"]);
    expect(entrySnapshot(h.controller.view()._unsafeUnwrap())).toEqual(before);
    expect(h.repaints).toBe(0);
  });

  it("drops everything once the overlay closed or the stream was disposed", async () => {
    const h = await harness();
    expect(h.controller.close().isOk()).toBe(true);
    expect(
      drops([h.stream.ingest(CHILD_ID, { type: "thinking", text: "x" })]),
    ).toEqual(["overlay-closed"]);
    h.stream.dispose();
    expect(
      drops([h.stream.ingest(CHILD_ID, { type: "thinking", text: "x" })]),
    ).toEqual(["stream-disposed"]);
    expect(h.diagnostics.snapshot().buckets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "overlay-closed" }),
        expect.objectContaining({ reason: "stream-disposed" }),
      ]),
    );
  });

  it("renders only the dedicated live reasoning lane and releases it on close", async () => {
    const registry = createPiLiveReasoningRegistry();
    const h = await harness(liveChild(), [], {
      liveReasoningGenerationId: GENERATION,
      liveReasoningRegistry: registry,
    });
    const pane = mountPane(h.controller);
    const raw = "RAW_REASONING_SENTINEL";

    expect(registry.size()).toBe(1);
    expect(h.stream.ingestReasoning(reasoningUpdate("start", "")).kind).toBe(
      "applied",
    );
    expect(pane.render(WIDTH).join("\n")).not.toContain("↪ reasoning •");
    expect(h.stream.ingestReasoning(reasoningUpdate("delta", raw)).kind).toBe(
      "applied",
    );
    // The real stream wires this invalidation to the mounted component. Keep
    // the test's render port explicit so it proves the cache is refreshed.
    pane.invalidate();

    const live = h.controller.view()._unsafeUnwrap();
    expect(live.liveReasoning?.text).toBe(raw);
    expect(live.liveReasoning?.inspectorRows).toEqual([raw]);
    expect(live.entries).toHaveLength(0);
    expect(JSON.stringify(live.transcript)).not.toContain(raw);
    expect(JSON.stringify(live.entries)).not.toContain(raw);
    expect(pane.render(WIDTH).join("\n")).toContain(`↪ reasoning • ${raw}`);
    expect(pane.render(WIDTH).join("\n")).not.toContain("✻ reasoning");
    expect(pane.render(WIDTH).join("\n")).not.toContain("reasoning · SUMMARY");

    // The first update paints immediately; the next one is folded into the
    // same 50 ms window and paints exactly once when that window closes.
    expect(h.repaints).toBe(1);
    expect(h.timer.delays).toEqual([CHILD_OVERLAY_REPAINT_INTERVAL_MS]);
    h.timer.fire();
    expect(h.repaints).toBe(2);
    expect(h.invalidates).toBe(2);

    expect(h.controller.close().isOk()).toBe(true);
    expect(registry.size()).toBe(0);
    expect(registry.retainedBytes()).toBe(0);
    expect(h.controller.liveReasoning.snapshot()).toMatchObject({
      text: "",
      inspectorRows: [],
      retainedBytes: 0,
      active: false,
      registryEntries: 0,
    });
    const saved = (h.controller as unknown as { saved: Map<string, unknown> })
      .saved;
    expect(JSON.stringify(saved)).not.toContain(raw);

    expect((await h.controller.open(CHILD_ID)).isOk()).toBe(true);
    const reopened = h.controller.view()._unsafeUnwrap();
    expect(reopened.liveReasoning?.text).toBe("");
    expect(reopened.liveReasoning?.inspectorRows).toEqual([]);
    pane.invalidate();
    expect(pane.render(WIDTH).join("\n")).not.toContain(raw);
  });

  it("keeps the inspector to three rows and marks omitted non-empty text", async () => {
    const registry = createPiLiveReasoningRegistry();
    const h = await harness(liveChild(), [], {
      liveReasoningGenerationId: GENERATION,
      liveReasoningRegistry: registry,
    });
    const pane = mountPane(h.controller);
    const long = [
      "first reasoning row",
      "second reasoning row",
      "third reasoning row",
      "fourth reasoning row",
    ].join("\n");
    expect(h.stream.ingestReasoning(reasoningUpdate("start", "")).kind).toBe(
      "applied",
    );
    expect(h.stream.ingestReasoning(reasoningUpdate("delta", long)).kind).toBe(
      "applied",
    );

    const snapshot = h.controller.liveReasoning.snapshot();
    expect(snapshot.inspectorRows).toHaveLength(3);
    expect(snapshot.inspectorRows.at(-1)).toEndWith("… [truncated]");
    expect(pane.render(WIDTH).join("\n")).toContain(
      "↪ reasoning • second reasoning row",
    );
    expect(pane.render(WIDTH).join("\n")).toContain("… [truncated]");
    expect(registry.retainedBytes()).toBeGreaterThan(0);
  });

  it("rejects stale, wrong, closed and settled reasoning updates without content diagnostics", async () => {
    const registry = createPiLiveReasoningRegistry();
    const h = await harness(liveChild(), [liveChild(OTHER_CHILD_ID)], {
      liveReasoningGenerationId: GENERATION,
      liveReasoningRegistry: registry,
    });
    const raw = "DROP_REASONING_SENTINEL";
    expect(h.stream.ingestReasoning(reasoningUpdate("start", "")).kind).toBe(
      "applied",
    );
    expect(h.stream.ingestReasoning(reasoningUpdate("delta", raw)).kind).toBe(
      "applied",
    );

    h.generation = "generation-2";
    expect(
      drops([h.stream.ingestReasoning(reasoningUpdate("delta", raw))]),
    ).toEqual(["stale-generation"]);
    expect(h.controller.liveReasoning.snapshot().text).toBe("");
    expect(registry.retainedBytes()).toBe(0);

    h.generation = GENERATION;
    // An authenticated resolver that cannot resolve the child is not allowed
    // to fall back to the caller-supplied child id.
    h.liveChildren.delete(OTHER_CHILD_ID);
    expect(
      drops([
        h.stream.ingestReasoning(
          reasoningUpdate("start", "", { childId: OTHER_CHILD_ID }),
        ),
      ]),
    ).toEqual(["unfocused-child"]);
    expect(registry.size()).toBe(0);

    const closedRegistry = createPiLiveReasoningRegistry();
    const closed = await harness(liveChild(), [], {
      liveReasoningGenerationId: GENERATION,
      liveReasoningRegistry: closedRegistry,
    });
    expect(closedRegistry.size()).toBe(1);
    expect(closed.controller.close().isOk()).toBe(true);
    expect(
      drops([closed.stream.ingestReasoning(reasoningUpdate("delta", raw))]),
    ).toEqual(["overlay-closed"]);
    expect(closed.controller.liveReasoning.snapshot().text).toBe("");
    expect(closedRegistry.size()).toBe(0);
    expect(closedRegistry.retainedBytes()).toBe(0);

    const settledRegistry = createPiLiveReasoningRegistry();
    const settled = await harness(liveChild(), [], {
      liveReasoningGenerationId: GENERATION,
      liveReasoningRegistry: settledRegistry,
    });
    expect(
      settled.stream.ingestReasoning(reasoningUpdate("start", "")).kind,
    ).toBe("applied");
    settled.stream.settle(CHILD_ID);
    expect(
      drops([settled.stream.ingestReasoning(reasoningUpdate("delta", raw))]),
    ).toEqual(["settled"]);
    expect(settled.controller.liveReasoning.snapshot().text).toBe("");
    expect(settledRegistry.size()).toBe(0);

    const diagnostics = h.diagnostics.snapshot();
    expect(diagnostics.buckets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "stale-generation" }),
        expect.objectContaining({ reason: "unfocused-child" }),
      ]),
    );
    expect(JSON.stringify(diagnostics)).not.toContain(raw);
  });

  it("clears the projector on focus changes, orphaning and component disposal", async () => {
    const registry = createPiLiveReasoningRegistry();
    const h = await harness(liveChild(), [liveChild(OTHER_CHILD_ID)], {
      liveReasoningGenerationId: GENERATION,
      liveReasoningRegistry: registry,
    });
    const raw = "LIFECYCLE_REASONING_SENTINEL";
    expect(h.stream.ingestReasoning(reasoningUpdate("start", "")).kind).toBe(
      "applied",
    );
    expect(h.stream.ingestReasoning(reasoningUpdate("delta", raw)).kind).toBe(
      "applied",
    );
    expect(h.controller.liveReasoning.snapshot().text).toBe(raw);

    expect((await h.controller.open(OTHER_CHILD_ID)).isOk()).toBe(true);
    expect(h.controller.liveReasoning.snapshot().text).toBe("");
    expect(registry.size()).toBe(1);

    expect(h.controller.markOpenChildReadOnly().isOk()).toBe(true);
    expect(h.controller.liveReasoning.snapshot().text).toBe("");
    expect(registry.size()).toBe(0);

    const reopened = await harness(liveChild(), [], {
      liveReasoningGenerationId: GENERATION,
      liveReasoningRegistry: registry,
    });
    expect(
      reopened.stream.ingestReasoning(reasoningUpdate("start", "")).kind,
    ).toBe("applied");
    expect(
      reopened.stream.ingestReasoning(reasoningUpdate("delta", raw)).kind,
    ).toBe("applied");
    const pane = mountPane(reopened.controller);
    pane.handleInput("\x1b");
    expect(reopened.controller.liveReasoning.snapshot().text).toBe("");
    expect(registry.size()).toBe(0);
    expect(registry.retainedBytes()).toBe(0);
    expect(pane.render(WIDTH).join("\n")).not.toContain(raw);
  });
});

// ---------------------------------------------------------------------------
// 3. Bounded history
// ---------------------------------------------------------------------------

describe("bounded history stays at the declared bounds", () => {
  it("keeps the window at the configured cap while a burst streams in", async () => {
    const cap = 24;
    const { controller } = openLive(liveChild(), [], { windowCap: cap });
    expect((await controller.open(CHILD_ID)).isOk()).toBe(true);
    for (let index = 0; index < 500; index += 1) {
      expect(
        controller
          .applyLiveEvent({
            type: "reasoning_summary",
            text: `burst-${index}`,
          })
          .isOk(),
      ).toBe(true);
    }
    const view = controller.view()._unsafeUnwrap();
    expect(view.entries).toHaveLength(cap);
    expect(view.entries.at(-1)?.text).toBe("burst-499");
  });

  it("never retains more children than the LRU allows", async () => {
    const children = Array.from({ length: 20 }, (_, index) =>
      liveChild(`lru-child-${index}`),
    );
    const source = createMemoryChildOverlaySource(children);
    const controller = createChildOverlayController(source);
    for (const child of children) {
      expect((await controller.open(child.childId)).isOk()).toBe(true);
      expect(
        controller.applyLiveEvent({ type: "thinking", text: "seen" }).isOk(),
      ).toBe(true);
    }
    const saved = (controller as unknown as { saved: Map<string, unknown> })
      .saved;
    expect(saved.size).toBeLessThanOrEqual(CHILD_OVERLAY_BOUNDS.maxLruChildren);
  });

  it("counts a trimmed match in the reported total and spends no more than the page budget", async () => {
    const pageSize = 10;
    const windowCap = 15;
    // Every entry matches, so any page fetched contributes matches that the
    // window itself can no longer hold.
    const entries = Array.from({ length: 400 }, (_, index) =>
      persistedEntry(index, `needle body-${index}`),
    );
    const child = { ...settledChild(CHILD_ID, entries) };
    const source = createMemoryChildOverlaySource([child]);
    let olderCalls = 0;
    const counted = {
      ...source,
      loadOlder: (childId: string, cursor: string, size: number) => {
        olderCalls += 1;
        return source.loadOlder(childId, cursor, size);
      },
    };
    const controller = createChildOverlayController(counted, {
      pageSize,
      windowCap,
    });
    expect((await controller.open(CHILD_ID)).isOk()).toBe(true);
    const searched = await controller.search("needle");
    expect(searched.isOk()).toBe(true);
    const view = searched._unsafeUnwrap();

    // The budget is the declared one; nothing widened it.
    expect(olderCalls).toBeLessThanOrEqual(CHILD_OVERLAY_BOUNDS.maxSearchPages);
    expect(view.entries.length).toBeLessThanOrEqual(windowCap);
    // Matches trimmed out of the window still count: the reported total is
    // larger than the window could possibly hold.
    expect(view.searchMatches.length).toBeGreaterThan(view.entries.length);
    expect(view.searchMatches.length).toBe(
      new Set(view.searchMatches).size, // and it is a set, not a double count
    );
  });

  it("clamps a caller-supplied page size and window cap to the declared ceilings", () => {
    const source = createMemoryChildOverlaySource([liveChild()]);
    const controller = createChildOverlayController(source, {
      pageSize: 10_000,
      windowCap: 10_000,
      maxLruChildren: 10_000,
      maxSearchPages: 10_000,
    });
    const inner = controller as unknown as {
      pageSize: number;
      windowCap: number;
      maxLruChildren: number;
      maxSearchPages: number;
    };
    expect(inner.pageSize).toBe(CHILD_OVERLAY_BOUNDS.maxPageSize);
    expect(inner.windowCap).toBe(CHILD_OVERLAY_BOUNDS.maxWindowCap);
    expect(inner.maxLruChildren).toBe(CHILD_OVERLAY_BOUNDS.maxLruChildren);
    expect(inner.maxSearchPages).toBe(CHILD_OVERLAY_BOUNDS.maxSearchPages);
  });
});

// ---------------------------------------------------------------------------
// 4. Backpressure
// ---------------------------------------------------------------------------

describe("repaint backpressure", () => {
  it("keeps a 5,000-event burst inside the documented repaint ceiling", async () => {
    const h = await harness();
    for (let index = 0; index < 5_000; index += 1) {
      const outcome = h.stream.ingest(CHILD_ID, {
        type: "reasoning_summary",
        text: `burst-${index}`,
      });
      expect(outcome.kind).toBe("applied");
    }
    // One leading frame; every other event folded into the open window.
    expect(h.repaints).toBe(1);
    // The trailing frame is not lost when the window closes.
    h.timer.fire();
    expect(h.repaints).toBe(CHILD_OVERLAY_BURST_REPAINT_CEILING);
    expect(h.repaints).toBeLessThanOrEqual(CHILD_OVERLAY_BURST_REPAINT_CEILING);
    // Invalidate and requestRender move together, once per painted frame.
    expect(h.invalidates).toBe(h.repaints);
    // Every event still landed: coalescing drops frames, never facts.
    expect(h.controller.view()._unsafeUnwrap().entries.at(-1)?.text).toBe(
      "burst-4999",
    );
    // The window that had nothing pending simply closes.
    h.timer.fire();
    expect(h.repaints).toBe(CHILD_OVERLAY_BURST_REPAINT_CEILING);
  });

  it("schedules only through the injected timer, at the documented interval", async () => {
    const h = await harness();
    h.stream.ingest(CHILD_ID, { type: "thinking", text: "one" });
    expect(h.timer.delays).toEqual([CHILD_OVERLAY_REPAINT_INTERVAL_MS]);
    expect(h.timer.open).toBe(1);
  });

  it("publishes the settled frame once the refresh lands, exactly once", async () => {
    const h = await harness();
    h.stream.ingest(CHILD_ID, { type: "thinking", text: "one" });
    const beforeSettle = h.repaints;
    h.liveChildren.delete(CHILD_ID);

    h.stream.noteTreeChanged();
    // A repeated signal while the refresh is in flight starts nothing new.
    h.stream.noteTreeChanged();
    await h.stream.settlementPending();
    expect(h.repaints).toBe(beforeSettle + 1);
    // Idempotent: a repeated settlement signal repaints nothing further.
    h.stream.noteTreeChanged();
    await h.stream.settlementPending();
    h.stream.settle();
    expect(h.repaints).toBe(beforeSettle + 1);
    // And no queued window can repaint over the settled frame afterwards.
    h.timer.fire();
    expect(h.repaints).toBe(beforeSettle + 1);
  });

  it("survives a pane whose repaint throws", async () => {
    const { controller } = openLive();
    expect((await controller.open(CHILD_ID)).isOk()).toBe(true);
    const stream = createChildOverlayLiveStream({
      controller,
      repaint: {
        invalidate: () => {
          throw new Error("pane exploded");
        },
        requestRender: () => undefined,
      },
      timer: new ScriptedTimerPort(),
      generationId: GENERATION,
      currentGenerationId: () => GENERATION,
    });
    expect(() =>
      stream.ingest(CHILD_ID, { type: "thinking", text: "boom" }),
    ).not.toThrow();
    expect(controller.view()._unsafeUnwrap().entries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Malformed events
// ---------------------------------------------------------------------------

describe("malformed events never reach the pane as prose", () => {
  it("ignores a schema-invalid event without touching the window", async () => {
    const h = await harness();
    const before = entrySnapshot(h.controller.view()._unsafeUnwrap());
    const outcome = h.stream.ingest(CHILD_ID, {
      type: "thinking",
      text: 42, // not a string: the bounded schema rejects it
    });
    // The event is admitted by the gate and then ignored by the parser: the
    // window is unchanged either way.
    expect(outcome.kind).toBe("applied");
    expect(entrySnapshot(h.controller.view()._unsafeUnwrap())).toEqual(before);
  });

  it("bounds an unrecognised host event into the unknown variant", () => {
    const preserved = preserveUnknownChildEvent({
      type: "totally_unheard_of_host_event",
      note: "LEAKED_RAW_PROSE",
    });
    expect(preserved.type).toBe("unknown");
    expect((preserved as { originalType: string }).originalType).toBe(
      "totally_unheard_of_host_event",
    );
  });

  it("suppresses the unknown variant from the rendered pane", async () => {
    const { controller } = openLive();
    expect((await controller.open(CHILD_ID)).isOk()).toBe(true);
    const pane = mountPane(controller);
    expect(
      controller
        .applyLiveEvent(
          preserveUnknownChildEvent({
            type: "totally_unheard_of_host_event",
            note: "LEAKED_RAW_PROSE",
          }),
        )
        .isOk(),
    ).toBe(true);
    expect(
      controller
        .applyLiveEvent({
          type: "reasoning_summary",
          text: "VISIBLE_REASONING",
        })
        .isOk(),
    ).toBe(true);
    const rendered = pane.render(WIDTH).join("\n");
    expect(rendered).not.toContain("VISIBLE_REASONING");
    expect(rendered).not.toContain("LEAKED_RAW_PROSE");
    expect(rendered).not.toContain("totally_unheard_of_host_event");
  });
});

// ---------------------------------------------------------------------------
// 6. A settled child is read-only
// ---------------------------------------------------------------------------

describe("a settled child renders read-only", () => {
  it("names the state word on the frame and the rail and offers no editor", async () => {
    const entries = Array.from({ length: 6 }, (_, index) =>
      persistedEntry(index, `settled body-${index}`),
    );
    const { controller } = openLive(settledChild(CHILD_ID, entries));
    expect((await controller.open(CHILD_ID)).isOk()).toBe(true);
    const pane = mountPane(controller);
    const rendered = pane.render(WIDTH).join("\n");

    expect(controller.view()._unsafeUnwrap().readOnly).toBe(true);
    expect(rendered.toLowerCase()).toContain("settled");
    expect(rendered.toLowerCase()).toContain("read-only");
    // The live prompt editor is a component with a caret; a settled child gets
    // the layout's own text instead, so no draft prompt line is painted.
    expect(rendered).not.toContain("> ");
  });

  it("consumes mutating keys without steering or following up", async () => {
    const { controller } = openLive(settledChild());
    expect((await controller.open(CHILD_ID)).isOk()).toBe(true);

    const typed = controller.updateDraft("cannot type here");
    expect(typed.isOk()).toBe(true);
    expect(typed._unsafeUnwrap().draft).toBe("");

    const steered = await controller.submitSteer("steer me");
    expect(steered._unsafeUnwrap().kind).toBe("consumed");
    const followed = await controller.submitFollowUp("follow me");
    expect(followed._unsafeUnwrap().kind).toBe("consumed");
  });
});

// ---------------------------------------------------------------------------
// 7. Settlement refreshes the authoritative descriptor before it repaints
// ---------------------------------------------------------------------------

/** What the controlled source is allowed to say, and when. */
interface SourceControl {
  /** Status the source reports for a child on the next describe. */
  readonly status: Map<string, ChildOverlayChild["status"]>;
  /** Children whose describe fails. */
  readonly fail: Set<string>;
  /** When set, every describe waits for this gate before answering. */
  gate:
    | { readonly promise: Promise<void>; readonly release: () => void }
    | undefined;
  describeCalls: number;
}

function newSourceControl(): SourceControl {
  return {
    status: new Map(),
    fail: new Set(),
    gate: undefined,
    describeCalls: 0,
  };
}

function openGate(): {
  readonly promise: Promise<void>;
  readonly release: () => void;
} {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * A memory source whose `describe` answers can change between calls.
 *
 * This is the whole point of the refresh: a real source reports `live` while
 * the run is in flight and a different status afterwards, and the overlay must
 * re-read it rather than trust the snapshot it opened with. Paging is
 * delegated untouched to the ordinary memory source.
 */
function controlledSource(
  children: readonly MemoryOverlaySourceChild[],
  control: SourceControl,
): ChildOverlaySourcePort {
  const base = createMemoryChildOverlaySource(children);
  return {
    ...base,
    describe: (childId: string) => {
      control.describeCalls += 1;
      const answer = async (): Promise<
        Result<ChildOverlayChild, ChildOverlaySourceError>
      > => {
        const gate = control.gate;
        if (gate !== undefined) await gate.promise;
        if (control.fail.has(childId)) {
          return err<ChildOverlayChild, ChildOverlaySourceError>({
            type: "SourceUnavailable",
            operation: "describe",
          });
        }
        return (await base.describe(childId)).map((described) => {
          const status = control.status.get(childId);
          return status === undefined ? described : { ...described, status };
        });
      };
      return ResultAsync.fromSafePromise(answer()).andThen((result) => result);
    },
  };
}

/** One paint, described by the facts a reader can actually see in it. */
interface PaintedFrame {
  readonly readOnly: boolean;
  readonly status: string;
  readonly draft: string;
  readonly scrollOffset: number;
  readonly entryIds: readonly string[];
  readonly rendered: string;
}

interface SettlementHarness {
  readonly controller: ReturnType<typeof createChildOverlayController>;
  stream: ReturnType<typeof createChildOverlayLiveStream>;
  readonly control: SourceControl;
  readonly frames: PaintedFrame[];
  readonly liveChildren: Set<string>;
  generation: string;
}

/**
 * The production wiring: controller over a live child, a mounted pane, and the
 * stream that repaints it. Every paint is captured with the view AND the
 * rendered text it produced, so a claim about "the final frame" is a claim
 * about what the reader saw, not about state read afterwards.
 */
async function settlementHarness(
  children: readonly MemoryOverlaySourceChild[] = [liveChild()],
): Promise<SettlementHarness> {
  const control = newSourceControl();
  const source = controlledSource(children, control);
  const controller = createChildOverlayController(source);
  const first = children[0];
  expect(first).toBeDefined();
  expect((await controller.open(first?.childId ?? CHILD_ID)).isOk()).toBe(true);
  const pane = mountPane(controller);
  const frames: PaintedFrame[] = [];
  const state: SettlementHarness = {
    controller,
    control,
    frames,
    generation: GENERATION,
    liveChildren: new Set(
      children
        .filter((candidate) => candidate.status === "live")
        .map((candidate) => candidate.childId),
    ),
    stream: undefined as never,
  };
  // The harness IS the mutable state the stream reads, exactly as above.
  state.stream = createChildOverlayLiveStream({
    controller,
    repaint: {
      invalidate: () => {},
      requestRender: () => {
        const view = controller.view();
        if (view.isErr()) return;
        frames.push({
          readOnly: view.value.readOnly,
          status: view.value.child.status,
          draft: view.value.draft,
          scrollOffset: view.value.scrollOffset,
          entryIds: view.value.entries.map((entry) => entry.id),
          rendered: pane.render(WIDTH).join("\n"),
        });
      },
    },
    timer: new ScriptedTimerPort(),
    generationId: GENERATION,
    currentGenerationId: () => state.generation,
    resolveLiveThreadId: (childId) =>
      state.liveChildren.has(childId) ? childId : undefined,
  });
  return state;
}

/** Reading state a settlement must not disturb. */
async function seedReaderState(h: SettlementHarness): Promise<void> {
  for (const event of turnEvents(0)) {
    expect(h.controller.applyLiveEvent(event).isOk()).toBe(true);
  }
  expect(h.controller.updateDraft("half typed steer").isOk()).toBe(true);
  expect(h.controller.setScrollExtent(50).isOk()).toBe(true);
  expect(h.controller.setScrollOffset(7).isOk()).toBe(true);
  expect((await h.controller.search("reasoning")).isOk()).toBe(true);
}

describe("settlement refreshes the descriptor before the final repaint", () => {
  it("draws the one final frame from the refreshed settled descriptor", async () => {
    const h = await settlementHarness();
    await seedReaderState(h);
    const before = h.controller.view()._unsafeUnwrap();
    const entriesBefore = entrySnapshot(before);
    expect(before.readOnly).toBe(false);
    const framesBefore = h.frames.length;

    // The run ends: the source now reports a settled child and the delegation
    // tree drops it from the live set.
    h.control.status.set(CHILD_ID, "settled");
    h.liveChildren.delete(CHILD_ID);
    h.stream.noteTreeChanged();
    await h.stream.settlementPending();

    // Exactly one further paint, and it is the settled one.
    expect(h.frames).toHaveLength(framesBefore + 1);
    const final = h.frames.at(-1);
    expect(final).toBeDefined();
    expect(final?.readOnly).toBe(true);
    expect(final?.status).toBe("settled");
    // The state word is on the frame and the rail, and no caret or prompt
    // editor is painted for a child that can no longer be steered.
    expect(final?.rendered.toLowerCase()).toContain("settled");
    expect(final?.rendered.toLowerCase()).toContain("read-only");
    expect(final?.rendered).not.toContain("> ");
    expect(final?.rendered).not.toContain("half typed steer");

    // The transcript the reader was reading survived, along with their draft,
    // their scroll position and their search.
    expect(final?.entryIds).toEqual(entriesBefore.map((entry) => entry.id));
    expect(final?.draft).toBe("half typed steer");
    expect(final?.scrollOffset).toBe(7);
    const after = h.controller.view()._unsafeUnwrap();
    expect(entrySnapshot(after)).toEqual(entriesBefore);
    expect(after.transcript.entries.length).toBe(
      before.transcript.entries.length,
    );
    expect(after.searchQuery).toBe("reasoning");
    // The query survives the settlement, and the settled frame's own published
    // index can only ADD the rows the reader is looking at: the component
    // reports the rendered transcript on every paint, not only while the
    // search field is open, so a match never depends on which frame the reader
    // happened to type in. Every match is still a current window entry.
    expect(after.searchMatches.length).toBeGreaterThanOrEqual(
      before.searchMatches.length,
    );
    expect(
      after.searchMatches.every((id) =>
        after.entries.some((entry) => entry.id === id),
      ),
    ).toBe(true);
    expect(h.controller.currentChildId()).toBe(CHILD_ID);

    // And the settled child is inert: mutating keys change nothing.
    expect(
      h.controller.updateDraft("cannot type here")._unsafeUnwrap().draft,
    ).toBe("half typed steer");
    expect(
      (await h.controller.submitSteer("steer me"))._unsafeUnwrap().kind,
    ).toBe("consumed");
    expect(
      (await h.controller.submitFollowUp("follow me"))._unsafeUnwrap().kind,
    ).toBe("consumed");
    expect(h.frames).toHaveLength(framesBefore + 1);
  });

  it("fails closed to read-only when the refresh cannot answer", async () => {
    const h = await settlementHarness();
    await seedReaderState(h);
    const entriesBefore = entrySnapshot(h.controller.view()._unsafeUnwrap());
    const framesBefore = h.frames.length;

    h.control.fail.add(CHILD_ID);
    h.liveChildren.delete(CHILD_ID);
    h.stream.noteTreeChanged();
    await h.stream.settlementPending();

    expect(h.frames).toHaveLength(framesBefore + 1);
    const final = h.frames.at(-1);
    // No invented completion: the child left the live set and the source could
    // not say how, so it is read-only history rather than a live prompt.
    expect(final?.readOnly).toBe(true);
    expect(final?.status).toBe("orphan");
    expect(final?.rendered.toLowerCase()).toContain("read-only");
    expect(final?.rendered).not.toContain("> ");
    expect(final?.draft).toBe("half typed steer");
    expect(final?.entryIds).toEqual(entriesBefore.map((entry) => entry.id));
    expect(h.stream.isSettled()).toBe(true);
    expect(
      (await h.controller.submitSteer("steer me"))._unsafeUnwrap().kind,
    ).toBe("consumed");
  });

  it("fails closed when the refreshed descriptor still claims the child is live", async () => {
    const h = await settlementHarness();
    // The source keeps saying `live`; the delegation tree is the authority.
    h.liveChildren.delete(CHILD_ID);
    h.stream.noteTreeChanged();
    await h.stream.settlementPending();

    const final = h.frames.at(-1);
    expect(final?.readOnly).toBe(true);
    expect(final?.status).toBe("orphan");
    expect(h.controller.view()._unsafeUnwrap().readOnly).toBe(true);
  });

  it("never settles a child the reader moved to while the refresh was pending", async () => {
    const other = liveChild(OTHER_CHILD_ID);
    const h = await settlementHarness([liveChild(), other]);
    const gate = openGate();
    h.control.gate = gate;
    h.control.status.set(CHILD_ID, "settled");

    h.liveChildren.delete(CHILD_ID);
    h.stream.noteTreeChanged();
    // The reader opens another, still-live child before the refresh answers.
    h.control.gate = undefined;
    expect((await h.controller.open(OTHER_CHILD_ID)).isOk()).toBe(true);
    const framesBefore = h.frames.length;
    gate.release();
    await h.stream.settlementPending();

    // The late answer belonged to the first child; the newly focused one is
    // untouched, unsettled and still editable.
    expect(h.controller.currentChildId()).toBe(OTHER_CHILD_ID);
    const view = h.controller.view()._unsafeUnwrap();
    expect(view.child.status).toBe("live");
    expect(view.readOnly).toBe(false);
    expect(h.stream.isSettled()).toBe(false);
    expect(h.frames).toHaveLength(framesBefore);
  });

  it("never settles anything once the generation was replaced", async () => {
    const h = await settlementHarness();
    const gate = openGate();
    h.control.gate = gate;
    h.control.status.set(CHILD_ID, "settled");

    h.liveChildren.delete(CHILD_ID);
    h.stream.noteTreeChanged();
    h.generation = "generation-2";
    const framesBefore = h.frames.length;
    gate.release();
    await h.stream.settlementPending();

    expect(h.frames).toHaveLength(framesBefore);
    expect(h.stream.isSettled()).toBe(false);
  });

  it("re-reads the descriptor once, however many tree changes arrive", async () => {
    const h = await settlementHarness();
    const describeAfterOpen = h.control.describeCalls;
    h.control.status.set(CHILD_ID, "settled");
    h.liveChildren.delete(CHILD_ID);

    h.stream.noteTreeChanged();
    h.stream.noteTreeChanged();
    h.stream.noteTreeChanged();
    await h.stream.settlementPending();
    const framesAfterSettlement = h.frames.length;
    h.stream.noteTreeChanged();
    await h.stream.settlementPending();

    expect(h.control.describeCalls).toBe(describeAfterOpen + 1);
    expect(h.frames).toHaveLength(framesAfterSettlement);
  });
});
