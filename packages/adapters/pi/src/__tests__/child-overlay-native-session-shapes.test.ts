/**
 * The child inspector against REAL NATIVE SESSION message shapes.
 *
 * Every earlier suite in this area starts from `tool_execution_*` event
 * fixtures. A real Pi 0.84 child session file contains none of those. It
 * contains pi-ai MESSAGES, and the run's whole tool story is spread across
 * two message kinds that only a correlation id ties together:
 *
 *   - an `AssistantMessage` whose `content` carries `{ type: "toolCall", id,
 *     name, arguments }` blocks and no text at all, and
 *   - a separate `ToolResultMessage` — `{ role: "toolResult", toolCallId,
 *     toolName, content: [{ type: "text", text }], isError, timestamp }` —
 *     written as its own session entry.
 *
 * Pi replays both of those to a live listener as ordinary `message_start` /
 * `message_end` pairs, so the SAME two shapes are the live stream and the
 * persisted history. A fresh 0.84.2 smoke proved what the adapter did with
 * them: three calls rendered `running`, `running`, `done`, the deliberate
 * failure carried no error tone, an ordinary argument vanished into `bash()`,
 * a bare `● shuttle · reply` appeared over the bash tool's own `(no output)`
 * text, and SPEND printed a summed per-turn total that disagreed with both the
 * host's latest report and the parent's delegation card.
 *
 * So this file starts from the session entry and from the message, drives the
 * production paging / replay / settlement reconciliation seam, and asserts the
 * two paths reach byte-identical rows. No fixture carries a real prompt, a
 * secret, an absolute path, or a provider payload.
 */

import { describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";
import { createChildCompactState } from "../child-compact-render.js";
import { createChildOverlayController } from "../child-overlay-controller.js";
import {
  childOverlayRailFacts,
  childOverlayTranscriptInput,
} from "../child-overlay-facts.js";
import { renderOverlayPiNative } from "../child-overlay-pi-native.js";
import {
  mapNativeSessionEntryToOverlay,
  transcriptFromOverlayEntries,
} from "../child-overlay-replay.js";
import { createChildOverlayLiveStream } from "../child-overlay-stream.js";
import type {
  ChildOverlayChild,
  ChildOverlayEntry,
  ChildOverlayPage,
  ChildOverlaySourceError,
  ChildOverlaySourcePort,
  ChildOverlayView,
} from "../child-overlay-types.js";
import {
  redactProviderErrorFromEvent,
  TOOL_ERROR_DETAILS_UNAVAILABLE,
  TOOL_RESULT_DETAILS_UNAVAILABLE,
} from "../child-provider-error.js";
import { parsePiChildSessionEvent } from "../child-session-events.js";
import type { TimerHandle, TimerPort } from "../child-timer.js";
import {
  createPiChildTranscriptState,
  type PiChildTranscriptState,
  reducePiChildTranscript,
} from "../child-transcript.js";
import { plainPaint } from "../ui-paint.js";

// ---------------------------------------------------------------------------
// The fixture: one settled run, in the exact shapes a host session holds
// ---------------------------------------------------------------------------

const CALL_ONE = "toolu01AbCdEfGhIjKlMnOp";
const CALL_TWO = "toolu02BcDeFgHiJkLmNoPq";
const CALL_THREE = "toolu03CdEfGhIjKlMnOpQr";

/**
 * Per-turn accounting exactly as pi-ai reports it: each turn re-sends the
 * whole context, so `input` stays tiny while `cacheRead` carries the context
 * and `totalTokens` is the sum of every component. The LAST report is the
 * authoritative one; the figures are the shape a real 0.84.2 run produced.
 */
const USAGE_REPORTS = [
  {
    input: 4,
    output: 30,
    cacheRead: 9_000,
    cacheWrite: 120,
    totalTokens: 9_154,
    cost: {
      input: 0.0001,
      output: 0.0004,
      cacheRead: 0.004,
      cacheWrite: 0.0006,
      total: 0.0051,
    },
  },
  {
    input: 3,
    output: 26,
    cacheRead: 19_400,
    cacheWrite: 96,
    totalTokens: 19_525,
    cost: {
      input: 0.0001,
      output: 0.0003,
      cacheRead: 0.0093,
      cacheWrite: 0.0005,
      total: 0.0102,
    },
  },
  {
    input: 3,
    output: 24,
    cacheRead: 29_100,
    cacheWrite: 90,
    totalTokens: 29_217,
    cost: {
      input: 0.0001,
      output: 0.0003,
      cacheRead: 0.0145,
      cacheWrite: 0.0005,
      total: 0.0154,
    },
  },
  {
    input: 2,
    output: 22,
    cacheRead: 38_798,
    cacheWrite: 87,
    totalTokens: 38_909,
    cost: {
      input: 0.0001,
      output: 0.0003,
      cacheRead: 0.0196,
      cacheWrite: 0.0005,
      total: 0.0205,
    },
  },
] as const;

/** The authoritative latest report, restated as the acceptance figures. */
const LATEST = USAGE_REPORTS[3];

/** One pi-ai `AssistantMessage`, without the `id` the real type does not have. */
function assistantMessage(
  content: readonly unknown[],
  usage: (typeof USAGE_REPORTS)[number],
  stopReason: string,
): Record<string, unknown> {
  return {
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    content,
    usage,
    stopReason,
    timestamp: 1_700_000_000_000,
  };
}

/** One pi-ai `ToolResultMessage`, as its own persisted session message. */
function toolResultMessage(
  toolCallId: string,
  toolName: string,
  text: string,
  isError: boolean,
): Record<string, unknown> {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError,
    timestamp: 1_700_000_000_000,
  };
}

function toolCallBlock(
  id: string,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return { type: "toolCall", id, name, arguments: args };
}

/**
 * The run, message by message, in session order.
 *
 * Call two's command names a storage location, so the closed reducer
 * projection withholds it — that argument is legitimately absent. Calls one
 * and three carry ordinary arguments, which must survive to the row.
 */
const RUN_MESSAGES: readonly Record<string, unknown>[] = [
  {
    role: "user",
    content: "run the three checks",
    timestamp: 1_700_000_000_000,
  },
  assistantMessage(
    [toolCallBlock(CALL_ONE, "bash", { command: "echo one" })],
    USAGE_REPORTS[0],
    "toolUse",
  ),
  toolResultMessage(CALL_ONE, "bash", "one", false),
  assistantMessage(
    [toolCallBlock(CALL_TWO, "bash", { command: "ls -la /tmp/example" })],
    USAGE_REPORTS[1],
    "toolUse",
  ),
  toolResultMessage(CALL_TWO, "bash", "command failed", true),
  assistantMessage(
    [toolCallBlock(CALL_THREE, "bash", { command: "echo three" })],
    USAGE_REPORTS[2],
    "toolUse",
  ),
  toolResultMessage(CALL_THREE, "bash", "three", false),
  assistantMessage(
    [{ type: "text", text: "all three checks ran" }],
    USAGE_REPORTS[3],
    "stop",
  ),
];

/** The persisted session entries a bounded native page yields. */
const NATIVE_ENTRIES: readonly unknown[] = RUN_MESSAGES.map(
  (message, index) => ({
    type: "message",
    id: `entry-${index + 1}`,
    message,
    timestamp: "2026-01-01T00:00:00.000Z",
  }),
);

/**
 * The same run as a LIVE stream.
 *
 * Pi publishes every message it appends to a live listener as a
 * `message_start` / `message_end` pair, tool results included, which is why a
 * `message_end` can carry a `ToolResultMessage` rather than an assistant turn.
 * The delegation prompt is not among them: a live listener receives the task
 * through the input path, and only the persisted session replays it as a
 * `user` message.
 */
const LIVE_EVENTS: readonly unknown[] = RUN_MESSAGES.filter(
  (message) => message.role !== "user",
).flatMap((message) => [
  { type: "message_start", message },
  { type: "message_end", message },
]);

// ---------------------------------------------------------------------------
// The two production paths, driven end to end
// ---------------------------------------------------------------------------

/** One host event through the exact pipeline a live child event travels. */
function ingest(
  state: PiChildTranscriptState,
  hostEvent: unknown,
): PiChildTranscriptState {
  const parsed = parsePiChildSessionEvent(hostEvent);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return state;
  const next = reducePiChildTranscript(state, {
    kind: "event",
    event: redactProviderErrorFromEvent(parsed.data),
  });
  expect(next.isOk()).toBe(true);
  return next.isOk() ? next.value : state;
}

function liveTranscript(): PiChildTranscriptState {
  let state = createPiChildTranscriptState();
  for (const event of LIVE_EVENTS) state = ingest(state, event);
  return state;
}

/** The persisted page, through the shipped native → overlay entry mapping. */
function nativeOverlayEntries(): readonly ChildOverlayEntry[] {
  const entries: ChildOverlayEntry[] = [];
  NATIVE_ENTRIES.forEach((entry, index) => {
    const mapped = mapNativeSessionEntryToOverlay(entry, index);
    expect(mapped.isOk()).toBe(true);
    if (mapped.isOk() && mapped.value !== undefined) entries.push(mapped.value);
  });
  return entries;
}

function nativeTranscript(): PiChildTranscriptState {
  return transcriptFromOverlayEntries(nativeOverlayEntries());
}

/** The rows a reader actually sees, ANSI-free and right-trimmed. */
function rowsOf(state: PiChildTranscriptState): readonly string[] {
  return renderOverlayPiNative(
    plainPaint(),
    { entries: state.entries, childName: "shuttle", settled: true },
    96,
  ).plain.map((line) => line.replace(/\s+$/u, ""));
}

// ---------------------------------------------------------------------------
// 1. Every persisted call/result pair reaches the reducer
// ---------------------------------------------------------------------------

describe("native session messages produce one call entry per tool call", () => {
  it("keeps useful read, edit, bash, and other-tool previews in replay", () => {
    const messages = [
      assistantMessage(
        [
          toolCallBlock("read-replay", "read", {
            path: "src/main.ts",
            startLine: 4,
            endLine: 9,
          }),
        ],
        USAGE_REPORTS[0],
        "toolUse",
      ),
      toolResultMessage("read-replay", "read", "lines 4-9", false),
      assistantMessage(
        [
          toolCallBlock("edit-replay", "edit", {
            path: "src/main.ts",
            operation: "replace",
            oldText: "private sentinel",
          }),
        ],
        USAGE_REPORTS[1],
        "toolUse",
      ),
      toolResultMessage("edit-replay", "edit", "edited 1 occurrence", false),
      assistantMessage(
        [
          toolCallBlock("other-replay", "question", {
            question: "which check?",
            options: ["unit", "integration"],
          }),
        ],
        USAGE_REPORTS[2],
        "toolUse",
      ),
      toolResultMessage("other-replay", "question", "unit", false),
    ];
    const entries: ChildOverlayEntry[] = [];
    messages.forEach((message, index) => {
      const mapped = mapNativeSessionEntryToOverlay(
        { type: "message", id: `replay-${index}`, message },
        index,
      );
      expect(mapped.isOk()).toBe(true);
      if (mapped.isOk() && mapped.value !== undefined)
        entries.push(mapped.value);
    });
    const joined = rowsOf(transcriptFromOverlayEntries(entries)).join("\n");
    expect(joined).toContain(
      "⚙ read(path: src/main.ts, startLine: 4, endLine: 9)",
    );
    expect(joined).toContain("⎿ lines 4-9");
    expect(joined).toContain("⚙ edit(path: src/main.ts, operation: replace)");
    expect(joined).toContain("⎿ edited 1 occurrence");
    expect(joined).toContain("⚙ question(question: which check?");
    expect(joined).toContain("⎿ unit");
    expect(joined).not.toContain("private sentinel");
  });

  for (const [label, build] of [
    ["native session entries", nativeTranscript],
    ["the live message stream", liveTranscript],
  ] as const) {
    it(`renders three terminal outcomes in order from ${label}`, () => {
      const rows = rowsOf(build());
      const joined = rows.join("\n");

      // Three calls, three call rows, three outcomes — and no stale `running`.
      expect(joined.match(/⚙ bash\(/gu)?.length).toBe(3);
      expect(joined.match(/⎿/gu)?.length).toBe(3);
      expect(joined).not.toContain("running");

      const outcomes = rows
        .filter((line) => line.includes("⎿"))
        .map((line) => line.trim());
      expect(outcomes).toEqual(["⎿ one", "⎿ command failed", "⎿ three"]);
    });

    it(`keeps ordinary arguments and withholds only the unsafe one from ${label}`, () => {
      const joined = rowsOf(build()).join("\n");
      expect(joined).toContain("⚙ bash(command: echo one)");
      expect(joined).toContain("⚙ bash(command: echo three)");
      // The path-like command is withheld, and withholding is silent: no
      // fallback prose ever stands in for it.
      expect(joined).toContain("⚙ bash()");
      expect(joined).not.toContain(TOOL_RESULT_DETAILS_UNAVAILABLE);
      expect(joined).not.toContain(TOOL_ERROR_DETAILS_UNAVAILABLE);
      expect(joined).not.toContain("details unavailable");
      expect(joined).not.toContain("/tmp/example");
    });

    it(`prints exactly one assistant reply from ${label}`, () => {
      const rows = rowsOf(build());
      const joined = rows.join("\n");
      expect(joined.match(/shuttle · /gu)?.length).toBe(1);
      expect(joined).toContain("● shuttle · final response");
      expect(joined).toContain("all three checks ran");
      // The bash tool's own empty-output sentence is a TOOL RESULT. It may
      // never wear an assistant reply header.
      expect(joined).not.toContain("(no output)");
    });
  }

  it("renders the failed call in the error tone and no other", () => {
    const state = nativeTranscript();
    const tools = state.entries.filter((entry) => entry.kind === "tool");
    expect(tools.map((entry) => entry.kind)).toEqual(["tool", "tool", "tool"]);
    expect(
      tools.map((entry) =>
        entry.kind === "tool" ? entry.state : "not-a-tool",
      ),
    ).toEqual(["result", "error", "result"]);
    expect(
      tools.map((entry) =>
        entry.kind === "tool" ? entry.toolCallId : "not-a-tool",
      ),
    ).toEqual([CALL_ONE, CALL_TWO, CALL_THREE]);
  });

  it("never lets an unrelated answer overwrite a settled call", () => {
    let state = nativeTranscript();
    state = ingest(state, {
      type: "message_end",
      message: toolResultMessage(CALL_ONE, "bash", "a second answer", true),
    });
    const first = state.entries.find(
      (entry) => entry.kind === "tool" && entry.toolCallId === CALL_ONE,
    );
    expect(first?.kind).toBe("tool");
    if (first?.kind === "tool") {
      expect(first.state).toBe("result");
      expect(first.error).toBeUndefined();
    }
    expect(rowsOf(state).join("\n")).not.toContain("a second answer");
  });
});

// ---------------------------------------------------------------------------
// 2. Live and replayed history agree, byte for byte
// ---------------------------------------------------------------------------

describe("equivalent facts render identically from either carrier", () => {
  it("produces byte-identical rows from the live stream and the session", () => {
    // The persisted session additionally replays the delegation prompt, which
    // a live listener never receives as a message. Every row the two carriers
    // both describe is identical, byte for byte.
    const native = rowsOf(nativeTranscript());
    const promptRows = native.findIndex((line) => line.includes("⚙"));
    expect(promptRows).toBeGreaterThan(0);
    expect(native.slice(promptRows)).toEqual([...rowsOf(liveTranscript())]);
  });

  it("agrees on every rail work fact", () => {
    const nativeRail = childOverlayRailFacts(viewOf(nativeTranscript()));
    const liveRail = childOverlayRailFacts(viewOf(liveTranscript()));
    expect(nativeRail.tool).toBe(liveRail.tool);
    expect(nativeRail.args).toBe(liveRail.args);
    expect(nativeRail.toolOutcome).toBe(liveRail.toolOutcome);
    expect(nativeRail.toolTone).toBe(liveRail.toolTone);
  });

  it("keeps the latest tool row and the earlier outcomes on the rail", () => {
    const state = nativeTranscript();
    const rail = childOverlayRailFacts(viewOf(state));
    // The rail names the LATEST call, which succeeded.
    expect(rail.tool).toBe("bash");
    expect(rail.args).toBe("command: echo three");
    expect(rail.toolOutcome).toBe("three");
    expect(rail.toolTone).toBe("ok");
    expect(rail.failed).toBe(false);
    // The historical rows keep their own outcomes rather than adopting it.
    expect(rowsOf(state).join("\n")).toContain("⎿ command failed");
  });
});

// ---------------------------------------------------------------------------
// 3. SPEND follows the latest authoritative host report
// ---------------------------------------------------------------------------

describe("SPEND states the latest authoritative report", () => {
  it("matches the host's own totals and never sums the reports", async () => {
    const controller = createChildOverlayController(
      nativeSource({ status: "settled" }),
    );
    (await controller.open("native-child"))._unsafeUnwrap();
    const view = controller.view()._unsafeUnwrap();

    // The report the host wrote last, not the sum of the four.
    expect(view.telemetry?.totalTokens).toBe(LATEST.totalTokens);
    expect(view.telemetry?.outputTokens).toBe(LATEST.output);
    expect(view.telemetry?.cacheReadTokens).toBe(LATEST.cacheRead);
    expect(view.telemetry?.costTotal).toBeCloseTo(LATEST.cost.total, 6);

    const rail = childOverlayRailFacts(view);
    // The input side carries the host's cache accounting, so the two printed
    // figures add back up to the host's own `totalTokens`.
    expect(rail.tokensIn).toBe("38.9k");
    expect(rail.tokensOut).toBe("22");
    expect(rail.cost).toBe("$0.0205");

    const summed = USAGE_REPORTS.reduce(
      (total, report) => total + report.cost.total,
      0,
    );
    expect(rail.cost).not.toBe(`$${summed.toFixed(4)}`);
  });

  it("prefers the latest report over a disagreeing delegation aggregate", async () => {
    const controller = createChildOverlayController(
      nativeSource({
        status: "settled",
        // What summing per-turn full-context reports produces.
        usage: { inputTokens: 8, outputTokens: 244, cost: 0.0868 },
      }),
    );
    (await controller.open("native-child"))._unsafeUnwrap();
    const rail = childOverlayRailFacts(controller.view()._unsafeUnwrap());
    expect(rail.tokensIn).toBe("38.9k");
    expect(rail.tokensOut).toBe("22");
    expect(rail.cost).toBe("$0.0205");
  });

  it("leaves SPEND unknown when no authority reported one", () => {
    const rail = childOverlayRailFacts(viewOf(createPiChildTranscriptState()));
    expect(rail.tokensIn).toBeUndefined();
    expect(rail.tokensOut).toBeUndefined();
    expect(rail.cost).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Settlement reconciles the mounted transcript against the session
// ---------------------------------------------------------------------------

describe("settlement reconciles the mounted transcript", () => {
  it("recovers every persisted call/result pair the live window lost", async () => {
    const source = reconcilingSource();
    const controller = createChildOverlayController(source.port);
    (await controller.open("native-child"))._unsafeUnwrap();

    // The live window saw only the first call open — the terminal events for
    // the rest never reached this listener.
    controller
      .applyLiveEvent({
        type: "tool_execution_start",
        toolCallId: CALL_ONE,
        toolName: "bash",
        args: { command: "echo one" },
      })
      ._unsafeUnwrap();
    expect(
      rowsOf(controller.view()._unsafeUnwrap().transcript).join("\n"),
    ).toContain("running");

    const stream = createChildOverlayLiveStream({
      controller,
      repaint: { invalidate: () => {}, requestRender: () => {} },
      timer: new ImmediateTimerPort(),
      generationId: "gen-1",
      currentGenerationId: () => "gen-1",
      resolveLiveThreadId: () => (source.live() ? "native-thread" : undefined),
    });

    source.settle();
    stream.noteTreeChanged();
    await stream.settlementPending();
    await drain();

    const view = controller.view()._unsafeUnwrap();
    expect(view.readOnly).toBe(true);
    const joined = rowsOf(view.transcript).join("\n");
    expect(joined).not.toContain("running");
    expect(joined.match(/⚙ bash\(/gu)?.length).toBe(3);
    expect(joined).toContain("⎿ command failed");
    expect(joined).toContain("all three checks ran");
    expect(childOverlayRailFacts(view).cost).toBe("$0.0205");
    expect(childOverlayTranscriptInput(view).settled).toBe(true);
    stream.dispose();
  });

  it("never wipes a mounted transcript when the session answers nothing", async () => {
    const source = reconcilingSource({ emptyPage: true });
    const controller = createChildOverlayController(source.port);
    (await controller.open("native-child"))._unsafeUnwrap();
    for (const event of LIVE_EVENTS) {
      controller.applyLiveEvent(event)._unsafeUnwrap();
    }
    const before = rowsOf(controller.view()._unsafeUnwrap().transcript);

    const stream = createChildOverlayLiveStream({
      controller,
      repaint: { invalidate: () => {}, requestRender: () => {} },
      timer: new ImmediateTimerPort(),
      generationId: "gen-1",
      currentGenerationId: () => "gen-1",
      resolveLiveThreadId: () => (source.live() ? "native-thread" : undefined),
    });
    source.settle();
    stream.noteTreeChanged();
    await stream.settlementPending();
    await drain();

    expect(rowsOf(controller.view()._unsafeUnwrap().transcript)).toEqual(
      before,
    );
    stream.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** Lets every already-resolved source answer land before a frame is read. */
const drain = async (): Promise<void> => {
  for (let step = 0; step < 8; step += 1) await Promise.resolve();
};

/** Repaints run inline, so no frame here can reach the host clock. */
class ImmediateTimerPort implements TimerPort {
  schedule(callback: () => void, _delayMs: number): TimerHandle {
    let live = true;
    queueMicrotask(() => {
      if (live) callback();
    });
    return {
      cancel: () => {
        live = false;
      },
    };
  }
}

function nativePage(empty = false): ChildOverlayPage {
  return {
    entries: empty ? [] : [...nativeOverlayEntries()],
    olderCursor: undefined,
    newerCursor: undefined,
    hasOlder: false,
    hasNewer: false,
  };
}

function nativeSource(
  descriptor: Partial<ChildOverlayChild>,
): ChildOverlaySourcePort {
  const child: ChildOverlayChild = {
    childId: "native-child",
    threadId: "native-thread",
    status: "live",
    generationId: "gen-1",
    runs: [],
    branchIds: [],
    descendantChildIds: [],
    agentName: "shuttle",
    ...descriptor,
  };
  const page = okAsync<ChildOverlayPage, ChildOverlaySourceError>(nativePage());
  return {
    describe: () => okAsync(child),
    loadNewest: () => page,
    loadOlder: () => page,
    loadNewer: () => page,
  };
}

/** A live child that settles, with the session file behind it all along. */
function reconcilingSource(options: { readonly emptyPage?: boolean } = {}): {
  readonly port: ChildOverlaySourcePort;
  settle(): void;
  live(): boolean;
} {
  let descriptor: ChildOverlayChild = {
    childId: "native-child",
    threadId: "native-thread",
    status: "live",
    generationId: "gen-1",
    runs: [],
    branchIds: [],
    descendantChildIds: [],
    agentName: "shuttle",
  };
  const page = (): ChildOverlayPage =>
    descriptor.status === "live" && options.emptyPage !== true
      ? nativePage(true)
      : nativePage(options.emptyPage === true);
  return {
    port: {
      describe: () => okAsync(descriptor),
      loadNewest: () =>
        okAsync<ChildOverlayPage, ChildOverlaySourceError>(page()),
      loadOlder: () =>
        okAsync<ChildOverlayPage, ChildOverlaySourceError>(nativePage(true)),
      loadNewer: () =>
        okAsync<ChildOverlayPage, ChildOverlaySourceError>(nativePage(true)),
    },
    settle: () => {
      descriptor = { ...descriptor, status: "settled" };
    },
    live: () => descriptor.status === "live",
  };
}

function viewOf(transcript: PiChildTranscriptState): ChildOverlayView {
  return {
    child: {
      childId: "native-child",
      threadId: "native-thread",
      status: "settled",
      generationId: "gen-1",
      runs: [],
      branchIds: [],
      descendantChildIds: [],
    },
    entries: [],
    draft: "",
    searchQuery: "",
    searchMatches: [],
    scrollOffset: 0,
    scrollExtent: 0,
    liveTail: true,
    globalExpanded: false,
    activeRun: undefined,
    activeBranchId: undefined,
    olderCursor: undefined,
    newerCursor: undefined,
    hasOlder: false,
    hasNewer: false,
    readOnly: true,
    width: 96,
    height: 40,
    anchor: undefined,
    compact: createChildCompactState("native-thread"),
    transcript,
    telemetry: undefined,
    identity: { agentName: "shuttle" },
    planContext: undefined,
  };
}
