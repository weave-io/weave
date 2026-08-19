/**
 * The child inspector against the shapes a REAL Pi host emits.
 *
 * The existing live-parity suite drives synthetic events: `tool_result` with a
 * flat `{ content: "120 lines read" }`, `tool_error` with a bare string. A real
 * Pi 0.83/0.84 child emits none of those. It emits
 * `tool_execution_start/update/end`, and the answer it carries is a pi-ai
 * `ToolResultMessage` — `{ role: "toolResult", toolCallId, toolName, content:
 * [{ type: "text", text }], isError, timestamp }` — which the adapter then
 * projects through its own closed privacy allowlist before a row ever sees it.
 *
 * Every gap a fresh Pi 0.83 smoke found lived in exactly that distance:
 *
 *   1. tool rows printed the projection's fallback sentence as an argument
 *      (`bash(command: Tool result details unavailable.)`) and the CONTENT
 *      BLOCK's shape as a result (`⎿ type: text, text: …`);
 *   2. a finished call still read `⎿ running`;
 *   3. a deliberate failure produced no `⎿` outcome at all;
 *   5. `· child ui widget` bookkeeping rows leaked into the transcript;
 *   6. empty `● shuttle · reply` headers appeared with no body;
 *   7. the prompt said `turn 3` while the rail said `turn 7` in one frame;
 *   8. SPEND printed one message's accounting as the run's total.
 *
 * So this file starts from the host event, not from the reducer. The red
 * control still calls `redactProviderErrorFromEvent` directly, while the
 * repaired live seam sends native tool events through the bounded inspector
 * lane without that provider-error projection. Nothing is hand-built, and no
 * fixture carries a real prompt, secret, absolute path, or provider payload.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { okAsync } from "neverthrow";
import {
  readFixtureAndManifest,
  replayFixtureThroughAdapter,
  validateFixtureStructure,
  verifyCaptureManifest,
} from "../../../../../scripts/pi/child-stream-capture.js";
import { createChildCompactState } from "../child-compact-render.js";
import {
  createMemoryChildOverlaySource,
  type MemoryOverlaySourceChild,
} from "../child-overlay.js";
import {
  ChildOverlayController,
  createChildOverlayController,
} from "../child-overlay-controller.js";
import {
  childOverlayPromptFacts,
  childOverlayRailFacts,
  childOverlaySettlementFacts,
  childOverlayTranscriptInput,
} from "../child-overlay-facts.js";
import { renderOverlayPiNative } from "../child-overlay-pi-native.js";
import { createChildOverlayLiveStream } from "../child-overlay-stream.js";
import type {
  ChildOverlayChild,
  ChildOverlayPage,
  ChildOverlaySourceError,
  ChildOverlaySourcePort,
  ChildOverlayView,
} from "../child-overlay-types.js";
import {
  redactProviderErrorFromEvent,
  TOOL_ERROR_DETAILS_UNAVAILABLE,
  TOOL_RESULT_DETAILS_UNAVAILABLE,
  toolDetailProjectionLossKey,
} from "../child-provider-error.js";
import {
  isPiAuthoritativeToolEvent,
  parsePiChildSessionEvent,
} from "../child-session-events.js";
import type { TimerHandle, TimerPort } from "../child-timer.js";
import {
  createPiChildTranscriptState,
  type PiChildTranscriptState,
  reducePiChildTranscript,
} from "../child-transcript.js";
import { createChildUiEventDiagnostics } from "../child-ui-event-diagnostics.js";
import { PiDelegationCardStream } from "../delegation-tool.js";
import { plainPaint } from "../ui-paint.js";

// ---------------------------------------------------------------------------
// The real production seam, driven end to end
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
    event: isPiAuthoritativeToolEvent(parsed.data)
      ? parsed.data
      : redactProviderErrorFromEvent(parsed.data),
  });
  expect(next.isOk()).toBe(true);
  return next.isOk() ? next.value : state;
}

function transcriptOf(hostEvents: readonly unknown[]): PiChildTranscriptState {
  let state = createPiChildTranscriptState();
  for (const event of hostEvents) state = ingest(state, event);
  return state;
}

/** The rows a reader actually sees, ANSI-free and right-trimmed. */
function rowsOf(
  hostEvents: readonly unknown[],
  settled = false,
): readonly string[] {
  return renderOverlayPiNative(
    plainPaint(),
    {
      entries: transcriptOf(hostEvents).entries,
      childName: "shuttle",
      settled,
    },
    96,
  ).plain.map((line) => line.replace(/\s+$/u, ""));
}

/** A pi-ai `ToolResultMessage`, exactly as `tool_execution_end` carries it. */
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

const CALL_ID = "toolu01AbCdEfGhIjKlMnOp";

// ---------------------------------------------------------------------------
// 1. Tool arguments and results never print a shape or a withheld sentence
// ---------------------------------------------------------------------------

describe("real Pi tool payloads reach rows as text, never as shapes", () => {
  it("never prints a content block's keys as a tool result", () => {
    const rows = rowsOf([
      {
        type: "tool_execution_start",
        toolCallId: CALL_ID,
        toolName: "bash",
        args: { command: "bun test" },
      },
      {
        type: "tool_execution_end",
        toolCallId: CALL_ID,
        toolName: "bash",
        isError: false,
        result: toolResultMessage(CALL_ID, "bash", "3 files pass", false),
      },
    ]);
    const joined = rows.join("\n");
    expect(joined).toContain("⚙ bash(command: bun test)");
    expect(joined).toContain("⎿ 3 files pass");
    // The block's own shape, and the correlation bookkeeping that travels
    // with it, are the two things a reader cannot use.
    expect(joined).not.toContain("type: text");
    expect(joined).not.toContain("text:");
    expect(joined).not.toContain("role: toolResult");
    expect(joined).not.toContain("toolCallId");
    expect(joined).not.toContain("timestamp");
  });

  it("never prints a withheld sentence as an argument or a result", () => {
    // A command carrying a storage location is withheld by the closed
    // reducer projection. That is a privacy outcome, not a fact about the
    // run: printing it made the row read as if the child had literally run
    // `Tool result details unavailable.`
    const rows = rowsOf([
      {
        type: "tool_execution_start",
        toolCallId: CALL_ID,
        toolName: "bash",
        args: { command: "ls -la /tmp/example" },
      },
      {
        type: "tool_execution_update",
        toolCallId: CALL_ID,
        toolName: "bash",
        partialResult: { content: [{ type: "text", text: "total 8\ndrwx" }] },
      },
    ]);
    const joined = rows.join("\n");
    expect(joined).toContain("⚙ bash(");
    expect(joined).not.toContain(TOOL_RESULT_DETAILS_UNAVAILABLE);
    expect(joined).not.toContain(TOOL_ERROR_DETAILS_UNAVAILABLE);
    expect(joined).not.toContain("details unavailable");
    expect(joined).not.toContain("type: text");
  });

  it("keeps the same discipline on the rail", () => {
    const state = transcriptOf([
      {
        type: "tool_execution_start",
        toolCallId: CALL_ID,
        toolName: "bash",
        args: { command: "ls -la /tmp/example" },
      },
      {
        type: "tool_execution_update",
        toolCallId: CALL_ID,
        toolName: "bash",
        partialResult: { content: [{ type: "text", text: "total 8\ndrwx" }] },
      },
    ]);
    const rail = childOverlayRailFacts(viewOf(state));
    for (const value of [rail.args, rail.target, rail.toolOutcome]) {
      expect(value ?? "").not.toContain("type: text");
      expect(value ?? "").not.toContain("details unavailable");
    }
  });
});

// ---------------------------------------------------------------------------
// 2 & 3. A terminal event settles the call it belongs to, exactly once
// ---------------------------------------------------------------------------

describe("real terminal tool events replace the call state", () => {
  it("renders one bounded, useful row for each supported tool shape", () => {
    const rows = rowsOf([
      {
        type: "tool_execution_start",
        toolCallId: "read-call",
        toolName: "read",
        args: {
          path: "src/main.ts",
          startLine: 12,
          endLine: 18,
          startColumn: 2,
        },
      },
      {
        type: "tool_execution_update",
        toolCallId: "read-call",
        toolName: "read",
        partialResult: { stdout: "lines 12-18" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "read-call",
        toolName: "read",
        result: { stdout: "lines 12-18" },
        isError: false,
      },
      {
        type: "tool_execution_start",
        toolCallId: "edit-call",
        toolName: "edit",
        args: { path: "src/main.ts", operation: "replace", oldText: "secret" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "edit-call",
        toolName: "edit",
        result: { stdout: "edited 1 occurrence" },
        isError: false,
      },
      {
        type: "tool_execution_start",
        toolCallId: "other-call",
        toolName: "question",
        args: { question: "which check?", options: ["unit", "integration"] },
      },
      {
        type: "tool_execution_end",
        toolCallId: "other-call",
        toolName: "question",
        result: { content: "unit" },
        isError: false,
      },
    ]);
    const joined = rows.join("\n");
    expect(joined).toContain(
      "⚙ read(path: src/main.ts, startLine: 12, endLine: 18",
    );
    expect(joined).toContain("⎿ lines 12-18");
    expect(joined).toContain("⚙ edit(path: src/main.ts, operation: replace)");
    expect(joined).toContain("⎿ edited 1 occurrence");
    expect(joined).toContain("⚙ question(question: which check?");
    expect(joined).toContain("⎿ unit");
    expect(joined).not.toContain("oldText");
    expect(joined).not.toContain("/Users/");
    expect(joined).not.toContain("secret");
  });

  it("renders the controlled bash command and result in one row", () => {
    const rows = rowsOf([
      {
        type: "tool_execution_start",
        toolCallId: CALL_ID,
        toolName: "bash",
        args: { command: "bun test --filter inspector" },
      },
      {
        type: "tool_execution_update",
        toolCallId: CALL_ID,
        toolName: "bash",
        partialResult: { stdout: "83 tests passed" },
      },
      {
        type: "tool_execution_end",
        toolCallId: CALL_ID,
        toolName: "bash",
        result: { stdout: "83 tests passed", stderr: "" },
        isError: false,
      },
    ]);
    const joined = rows.join("\n");
    expect(joined).toContain("⚙ bash(command: bun test --filter inspector)");
    expect(joined).toContain("⎿ 83 tests passed");
    expect(joined.match(/⚙ bash\(/gu)?.length).toBe(1);
    expect(joined.match(/⎿ 83 tests passed/gu)?.length).toBe(1);
    expect(joined).not.toContain("running");
  });

  it("turns running into a result once the call ends", () => {
    const call = {
      type: "tool_execution_start",
      toolCallId: CALL_ID,
      toolName: "bash",
      args: { command: "bun test" },
    };
    expect(rowsOf([call]).join("\n")).toContain("⎿ running");

    const rows = rowsOf([
      call,
      {
        type: "tool_execution_end",
        toolCallId: CALL_ID,
        toolName: "bash",
        isError: false,
        result: toolResultMessage(CALL_ID, "bash", "3 files pass", false),
      },
    ]);
    const joined = rows.join("\n");
    expect(joined).not.toContain("running");
    expect(joined.match(/⚙ bash\(/gu)?.length).toBe(1);
    expect(joined.match(/⎿/gu)?.length).toBe(1);
  });

  it("settles a call whose id survives only inside the result message", () => {
    // A host that reports the correlation id on the answer rather than on the
    // envelope still ends the call it belongs to; it never opens a second row.
    const rows = rowsOf([
      {
        type: "tool_execution_start",
        toolCallId: CALL_ID,
        toolName: "bash",
        args: { command: "bun test" },
      },
      {
        type: "tool_result",
        result: toolResultMessage(CALL_ID, "bash", "3 files pass", false),
      },
    ]);
    const joined = rows.join("\n");
    expect(joined.match(/⚙ bash\(/gu)?.length).toBe(1);
    expect(joined).toContain("⎿ 3 files pass");
    expect(joined).not.toContain("running");
  });

  it("states an error outcome when only the result message says it failed", () => {
    const rows = rowsOf([
      {
        type: "tool_execution_start",
        toolCallId: CALL_ID,
        toolName: "read",
        args: { file: "missing" },
      },
      {
        type: "tool_execution_end",
        toolCallId: CALL_ID,
        toolName: "read",
        result: toolResultMessage(CALL_ID, "read", "no such file", true),
      },
    ]);
    const joined = rows.join("\n");
    expect(joined).toContain("⎿ no such file");
    expect(joined).not.toContain("running");

    const state = transcriptOf([
      {
        type: "tool_execution_start",
        toolCallId: CALL_ID,
        toolName: "read",
        args: { file: "missing" },
      },
      {
        type: "tool_execution_end",
        toolCallId: CALL_ID,
        toolName: "read",
        result: toolResultMessage(CALL_ID, "read", "no such file", true),
      },
    ]);
    const rail = childOverlayRailFacts(viewOf(state));
    expect(rail.failed).toBe(true);
    expect(rail.toolTone).toBe("bad");
    expect(rail.live).toBe("read failed");
  });

  it("never re-settles a call that already answered", () => {
    const rows = rowsOf([
      {
        type: "tool_execution_start",
        toolCallId: CALL_ID,
        toolName: "bash",
        args: { command: "bun test" },
      },
      {
        type: "tool_execution_end",
        toolCallId: CALL_ID,
        toolName: "bash",
        isError: false,
        result: toolResultMessage(CALL_ID, "bash", "3 files pass", false),
      },
      // A second, un-correlated answer belongs to a different call.
      { type: "tool_result", result: { content: "9 files pass" } },
    ]);
    const joined = rows.join("\n");
    expect(joined).toContain("⎿ 3 files pass");
    expect(joined).toContain("⎿ 9 files pass");
  });

  it("rejects impossible native order and duplicate terminal events once", () => {
    const beforeStart = parsePiChildSessionEvent({
      type: "tool_execution_update",
      toolCallId: CALL_ID,
      toolName: "read",
      partialResult: { content: "too early" },
    });
    expect(beforeStart.success).toBe(true);
    if (!beforeStart.success) return;
    const empty = createPiChildTranscriptState();
    const rejected = reducePiChildTranscript(empty, {
      kind: "event",
      event: beforeStart.data,
    });
    expect(rejected.isErr()).toBe(true);
    if (rejected.isOk()) return;
    expect(rejected.error).toEqual({
      type: "TranscriptToolEventInvalid",
      operation: "tool-event",
      reason: "tool-event-before-start",
    });

    const started = parsePiChildSessionEvent({
      type: "tool_execution_start",
      toolCallId: CALL_ID,
      toolName: "read",
      args: { path: "src/main.ts" },
    });
    const ended = parsePiChildSessionEvent({
      type: "tool_execution_end",
      toolCallId: CALL_ID,
      toolName: "read",
      result: { content: "done" },
      isError: false,
    });
    expect(started.success).toBe(true);
    expect(ended.success).toBe(true);
    if (!started.success || !ended.success) return;
    const afterStart = reducePiChildTranscript(empty, {
      kind: "event",
      event: started.data,
    });
    expect(afterStart.isOk()).toBe(true);
    if (afterStart.isErr()) return;
    const afterEnd = reducePiChildTranscript(afterStart.value, {
      kind: "event",
      event: ended.data,
    });
    expect(afterEnd.isOk()).toBe(true);
    if (afterEnd.isErr()) return;
    const duplicate = reducePiChildTranscript(afterEnd.value, {
      kind: "event",
      event: ended.data,
    });
    expect(duplicate.isErr()).toBe(true);
    if (duplicate.isOk()) return;
    expect(duplicate.error).toEqual({
      type: "TranscriptToolEventInvalid",
      operation: "tool-event",
      reason: "duplicate-terminal",
    });
    expect(
      afterEnd.value.entries.filter((entry) => entry.kind === "tool"),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5 & 6. Bookkeeping never becomes a transcript row
// ---------------------------------------------------------------------------

describe("non-conversation events render nothing", () => {
  it("keeps a child's UI widget request out of the transcript", () => {
    // What Pi's RPC `setStatus` normalizes to on the way in.
    expect(
      rowsOf([
        {
          type: "extension_ui_request",
          requestType: "widget",
          requestId: "req-1",
          widget: { method: "setStatus" },
        },
      ]),
    ).toEqual([]);
  });

  it("keeps a tool-use turn from printing an empty reply header", () => {
    const assistant = (
      content: readonly unknown[],
      stopReason: string,
    ): Record<string, unknown> => ({
      id: "m1",
      role: "assistant",
      model: "test-model",
      content,
      stopReason,
    });
    const rows = rowsOf([
      { type: "message_start", message: assistant([], "toolUse") },
      {
        type: "message_end",
        message: assistant(
          [
            {
              type: "toolCall",
              id: CALL_ID,
              name: "bash",
              arguments: { command: "bun test" },
            },
          ],
          "toolUse",
        ),
      },
    ]);
    // The turn's reply IS the call it made, so the call is the only thing on
    // screen: no empty header, and no bare message with nothing under it.
    expect(rows.join("\n")).not.toContain("· reply");
    expect(rows).toEqual(["⚙ bash(command: bun test)", "  ⎿ running", ""]);
  });

  it("prints a reply with prose, and announces raw reasoning without quoting it", () => {
    const rows = rowsOf([
      {
        type: "message_start",
        message: { id: "m2", role: "assistant", content: [] },
      },
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "check the reporter first",
        },
      },
      {
        type: "message_end",
        message: {
          id: "m2",
          role: "assistant",
          content: [{ type: "text", text: "the reporter drops rows" }],
          stopReason: "stop",
        },
      },
    ]);
    const joined = rows.join("\n");
    // A real `thinking_delta` reaches only the mounted live-reasoning lane;
    // retained transcript markers render no historical reasoning row.
    expect(joined).not.toContain("✻ reasoning");
    expect(joined).not.toContain("SUMMARY");
    expect(joined).not.toContain("check the reporter first");
    expect(joined).toContain("● shuttle · reply");
    expect(joined).toContain("the reporter drops rows");
  });

  it("prints an explicit host reasoning summary as a SUMMARY", () => {
    const rows = rowsOf([
      {
        type: "message_start",
        message: { id: "m3", role: "assistant", content: [] },
      },
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "reasoning_summary",
          contentIndex: 0,
          delta: "weighed two reporters",
        },
      },
      {
        type: "message_end",
        message: {
          id: "m3",
          role: "assistant",
          content: [{ type: "text", text: "the reporter drops rows" }],
          stopReason: "stop",
        },
      },
    ]);
    const joined = rows.join("\n");
    expect(joined).not.toContain("✻ reasoning · SUMMARY");
    expect(joined).not.toContain("weighed two reporters");
  });
});

// ---------------------------------------------------------------------------
// 7 & 8. One turn, one spend authority
// ---------------------------------------------------------------------------

describe("the prompt and the rail state the same live facts", () => {
  it("agrees on the turn in one frame", () => {
    const state = transcriptOf(
      [1, 2, 3, 4].flatMap((index) => [
        {
          type: "message_start",
          message: { id: `m${index}`, role: "assistant", content: [] },
        },
        {
          type: "message_end",
          message: {
            id: `m${index}`,
            role: "assistant",
            content: [{ type: "text", text: `answer ${index}` }],
            stopReason: "stop",
          },
        },
      ]),
    );
    // The descriptor snapshot is older than the stream, exactly as a real one
    // taken when the reader opened the child is.
    const view = viewOf(state, { turn: 3 });
    const rail = childOverlayRailFacts(view);
    const prompt = childOverlayPromptFacts(view, {
      draft: "",
      confirmingCancel: false,
    });
    expect(rail.turn).toBe("4");
    expect(String(prompt.turn)).toBe(rail.turn ?? "");
  });

  it("states the latest host report as the run's spend", async () => {
    // Real Pi carries `usage` on every terminal assistant message, and each
    // turn re-sends the whole context, so a report is the run SO FAR priced
    // again — not a slice that could be added up. The latest one is therefore
    // the run's own figure, and summing them would count the context once per
    // turn. This runs through the controller, because that is where the latest
    // usage report is retained and turned into view telemetry.
    const source = settlingSource();
    const controller = createChildOverlayController(source.port);
    (await controller.open("settle-child"))._unsafeUnwrap();
    for (const event of [
      {
        type: "message_start",
        message: { id: "m1", role: "assistant", content: [] },
      },
      {
        type: "message_end",
        message: {
          id: "m1",
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
          usage: {
            input: 2,
            output: 101,
            cacheRead: 4_000,
            totalTokens: 4_103,
            cost: { total: 0.0205 },
          },
        },
      },
    ]) {
      controller.applyLiveEvent(event)._unsafeUnwrap();
    }
    const view = controller.view()._unsafeUnwrap();
    expect(view.telemetry?.inputTokens).toBe(2);
    const rail = childOverlayRailFacts(view);
    // The input side carries the host's cache accounting, so the two printed
    // figures add back up to the host's own `totalTokens`.
    expect(rail.tokensIn).toBe("4k");
    expect(rail.tokensOut).toBe("101");
    expect(rail.cost).toBe("$0.0205");
  });

  it("falls back to the delegation tree's aggregate when no report exists", () => {
    // The aggregate the parent's delegation card prints, on the rail beside a
    // transcript whose own turns reported no usage at all.
    const state = transcriptOf([
      {
        type: "message_start",
        message: { id: "m1", role: "assistant", content: [] },
      },
      {
        type: "message_end",
        message: {
          id: "m1",
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
        },
      },
    ]);
    const rail = childOverlayRailFacts(
      viewOf(state, {
        usage: { inputTokens: 184_200, outputTokens: 12_400, cost: 0.42 },
      }),
    );
    expect(rail.tokensIn).toBe("184.2k");
    expect(rail.tokensOut).toBe("12.4k");
    expect(rail.cost).toBe("$0.4200");
  });
});

// ---------------------------------------------------------------------------
// A view over one transcript, with only the facts these assertions read
// ---------------------------------------------------------------------------

function viewOf(
  transcript: PiChildTranscriptState,
  identity: Partial<NonNullable<ChildOverlayView["identity"]>> = {},
): ChildOverlayView {
  return {
    child: {
      childId: "child-1",
      threadId: "thread-1",
      status: "live",
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
    readOnly: false,
    width: 96,
    height: 40,
    anchor: undefined,
    compact: createChildCompactState("thread-1"),
    transcript,
    telemetry: undefined,
    identity: { agentName: "shuttle", ...identity },
    planContext: undefined,
  };
}

// The transcript input projection is shared by every row assertion above, so
// it is exercised once here rather than repeated in each case.
describe("the pane and the facts describe the same child", () => {
  it("projects one transcript input from the view", () => {
    const view = viewOf(createPiChildTranscriptState());
    expect(childOverlayTranscriptInput(view).childName).toBe("shuttle");
    expect(childOverlayTranscriptInput(view).settled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Settlement produces ONE final frame every surface agrees with
// ---------------------------------------------------------------------------

/**
 * The authoritative source, with a descriptor the test moves the way the
 * delegation tree really moves it: live with a growing elapsed time, then
 * settled with the run's final elapsed time, turn and aggregate spend.
 */
function settlingSource(): {
  readonly port: ChildOverlaySourcePort;
  settle(): void;
  advance(): void;
  live(): boolean;
} {
  let descriptor: ChildOverlayChild = {
    childId: "settle-child",
    threadId: "settle-thread",
    status: "live",
    generationId: "gen-1",
    runs: [],
    branchIds: [],
    descendantChildIds: [],
    agentName: "shuttle",
    turn: 1,
    elapsedMs: 4_000,
  };
  const emptyPage = okAsync<ChildOverlayPage, ChildOverlaySourceError>({
    entries: [],
    olderCursor: undefined,
    newerCursor: undefined,
    hasOlder: false,
    hasNewer: false,
  });
  return {
    port: {
      describe: () => okAsync(descriptor),
      loadNewest: () => emptyPage,
      loadOlder: () => emptyPage,
      loadNewer: () => emptyPage,
    },
    advance: () => {
      descriptor = { ...descriptor, elapsedMs: 61_000 };
    },
    settle: () => {
      descriptor = {
        ...descriptor,
        status: "settled",
        turn: 7,
        elapsedMs: 92_000,
        usage: { inputTokens: 184_200, outputTokens: 12_400 },
      };
    },
    live: () => descriptor.status === "live",
  };
}

describe("settlement refreshes the mounted overlay from the tree", () => {
  it("makes the frame, the rail, the prompt and the elapsed time agree", async () => {
    const source = settlingSource();
    const controller = createChildOverlayController(source.port);
    (await controller.open("settle-child"))._unsafeUnwrap();

    let painted = 0;
    const timer = new ImmediateTimerPort();
    const stream = createChildOverlayLiveStream({
      controller,
      repaint: {
        invalidate: () => {
          painted += 1;
        },
        requestRender: () => {},
      },
      timer,
      generationId: "gen-1",
      currentGenerationId: () => "gen-1",
      // Exactly the contract `resolveThreadIdForLiveChild` now honours: a
      // thread id for a RUNNING child, and nothing once it settled.
      resolveLiveThreadId: () => (source.live() ? "settle-thread" : undefined),
    });

    // Still running: the tree's own elapsed time reaches the open descriptor.
    source.advance();
    stream.noteTreeChanged();
    await drain();
    expect(
      childOverlayRailFacts(controller.view()._unsafeUnwrap()).elapsed,
    ).toBe("1m 1s");

    source.settle();
    stream.noteTreeChanged();
    await stream.settlementPending();
    await drain();

    const view = controller.view()._unsafeUnwrap();
    const settlement = childOverlaySettlementFacts(view);
    const rail = childOverlayRailFacts(view);
    const prompt = childOverlayPromptFacts(view, {
      draft: "a steering message",
      confirmingCancel: false,
    });
    expect(settlement.phase).toBe("completed");
    expect(settlement.word).toBe("SETTLED");
    expect(rail.status).toBe("SETTLED");
    expect(rail.tone).toBe(settlement.tone);
    // Current, not the value captured when the reader opened the child.
    expect(rail.elapsed).toBe("1m 32s");
    expect(rail.tokensIn).toBe("184.2k");
    expect(rail.live).toBeUndefined();
    // Read-only, caretless, and with no draft carried into a settled child.
    expect(prompt.settled).toBe(true);
    expect(prompt.draft).toBe("");
    expect(String(prompt.turn)).toBe(rail.turn ?? "");
    expect(view.readOnly).toBe(true);
    expect(painted).toBeGreaterThan(0);

    // A late event cannot revert the final frame.
    expect(stream.isSettled()).toBe(true);
    expect(
      stream.ingest("settle-child", { type: "text", text: "too late" }).kind,
    ).toBe("dropped");
    expect(controller.view()._unsafeUnwrap().child.status).toBe("settled");
    stream.dispose();
  });
});

describe("authoritative Pi 0.84.2 capture shape", () => {
  it("keeps thinking, incremental answer, read, and bash ordering replayable", async () => {
    const fixturePath = join(
      import.meta.dir,
      "../__fixtures__/pi-0.84.2-child-ui-events.v1.json",
    );
    const loaded = await readFixtureAndManifest(fixturePath);
    expect(loaded.isOk()).toBe(true);
    if (loaded.isErr()) return;
    const verified = verifyCaptureManifest(
      loaded.value.fixtureText,
      loaded.value.manifestText,
    );
    expect(verified.isOk()).toBe(true);
    if (verified.isErr()) return;
    const structure = validateFixtureStructure(verified.value.fixture);
    expect(structure.isOk()).toBe(true);
    if (structure.isErr()) return;
    expect(structure.value.hasThinkingLifecycle).toBe(true);
    expect(structure.value.textDeltaCount).toBeGreaterThanOrEqual(2);
    expect(structure.value.hasReadTool).toBe(true);
    expect(structure.value.hasBashTool).toBe(true);

    const replay = replayFixtureThroughAdapter(verified.value.fixture, {
      injectControlledReasoningInMemory: true,
    });
    expect(replay.isOk()).toBe(true);
    if (replay.isErr()) return;
    expect(replay.value.syntheticReasoningLeaked).toBe(false);
    expect(replay.value.inspectorToolDetailsLaneAvailable).toBe(true);
    expect(replay.value.inspectorAssistantReplyLaneAvailable).toBe(true);
  });

  it("diagnoses the first live tool-detail loss through both sinks", async () => {
    const fixturePath = join(
      import.meta.dir,
      "../__fixtures__/pi-0.84.2-child-ui-events.v1.json",
    );
    const loaded = await readFixtureAndManifest(fixturePath);
    expect(loaded.isOk()).toBe(true);
    if (loaded.isErr()) return;
    const verified = verifyCaptureManifest(
      loaded.value.fixtureText,
      loaded.value.manifestText,
    );
    expect(verified.isOk()).toBe(true);
    if (verified.isErr()) return;

    const child: MemoryOverlaySourceChild = {
      childId: "fixture-child",
      threadId: "fixture-child",
      status: "live",
      title: "fixture child",
      generationId: "fixture-generation",
      parentChildId: undefined,
      agentName: "shuttle",
      model: "fixture-model",
      runs: [{ run: 1, action: "start" }],
      branchIds: ["main"],
      descendantChildIds: [],
      entries: [],
    };
    const diagnostics = createChildUiEventDiagnostics({
      now: () => 1_700_000_000_000,
    });
    const controller = new ChildOverlayController(
      createMemoryChildOverlaySource([child]),
      {},
      undefined,
      undefined,
      diagnostics,
    );
    const opened = await controller.open(child.childId);
    expect(opened.isOk()).toBe(true);
    if (opened.isErr()) return;

    const stream = createChildOverlayLiveStream({
      controller,
      repaint: { invalidate: () => {}, requestRender: () => {} },
      timer: new ImmediateTimerPort(),
      generationId: "fixture-generation",
      currentGenerationId: () => "fixture-generation",
      resolveLiveThreadId: () => child.threadId,
      diagnostics,
    });
    const cardUpdates: Array<{
      readonly content: readonly unknown[];
      readonly details?: unknown;
    }> = [];
    const card = new PiDelegationCardStream({
      threadId: child.threadId,
      agentName: child.agentName ?? "shuttle",
      assignment: "replay the authoritative capture",
      model: child.model,
      timerPort: new ImmediateTimerPort(),
      diagnostics,
      onUpdate: (update) => cardUpdates.push(update),
    });
    card.start();

    const renderRows = (): readonly string[] =>
      renderOverlayPiNative(
        plainPaint(),
        childOverlayTranscriptInput(controller.view()._unsafeUnwrap()),
        96,
      ).plain.map((line) => line.replace(/\s+$/u, ""));
    const toolBuckets = () =>
      diagnostics
        .snapshot()
        .buckets.filter(
          (bucket) =>
            bucket.stage === "overlay-mapping" &&
            bucket.reason === "tool-detail-redacted",
        );

    const event13 = verified.value.fixture.events.find(
      (captured) => captured.ordinalId === 13,
    );
    expect(event13).toBeDefined();
    if (event13 === undefined) return;
    const event13Parsed = parsePiChildSessionEvent(event13.payload);
    expect(event13Parsed.success).toBe(true);
    if (!event13Parsed.success) return;
    // Task 3's red control remains red at the old projection seam: the
    // normalized event is known to carry useful detail, and that projection
    // still replaces it with the closed privacy placeholder.
    const redControl = redactProviderErrorFromEvent(event13Parsed.data);
    expect(toolDetailProjectionLossKey(event13Parsed.data, redControl)).toBe(
      "tool-call-1",
    );
    expect(JSON.stringify(redControl)).not.toContain(
      "weave capture deterministic workspace file",
    );

    let appliedCount = 0;
    for (const captured of verified.value.fixture.events) {
      const parsed = parsePiChildSessionEvent(captured.payload);
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;

      // This is the same order as PiDelegationController's observer fanout:
      // checkpoint-approved events reach the focused overlay first, then the
      // independent delegation-card sink. Both sinks receive the same parsed
      // event; neither reads the other's projection.
      const outcome = stream.ingest(child.childId, parsed.data);
      card.applyEvent(parsed.data);
      expect(outcome.kind).toBe("applied");
      if (outcome.kind === "applied") appliedCount += 1;

      const bucket = toolBuckets()[0];

      if (captured.ordinalId === 13) {
        const rows = renderRows().join("\n");
        expect(bucket).toBeUndefined();
        expect(rows).toContain("⚙ read(path: weave-capture-sample.txt)");
        expect(rows).toContain("⎿ weave capture deterministic workspace file");
        expect(rows).not.toContain(TOOL_RESULT_DETAILS_UNAVAILABLE);
      }
      if (captured.ordinalId === 28) {
        const rows = renderRows().join("\n");
        expect(bucket).toBeUndefined();
        expect(rows).toContain("⚙ bash(command: echo weave-capture-ok)");
        expect(rows).toContain("⎿ weave-capture-ok");
      }
      if (captured.ordinalId === 29) {
        const rows = renderRows().join("\n");
        expect(bucket).toBeUndefined();
        expect(rows).toContain("⚙ bash(command: echo weave-capture-ok)");
        expect(rows).toContain("⎿ weave-capture-ok");
        // The update and terminal are one in-place correlated row.
        expect(rows.match(/⚙ bash\(/gu)?.length).toBe(1);
        expect(rows.match(/⎿ weave-capture-ok/gu)?.length).toBe(1);
      }
    }

    const snapshot = diagnostics.snapshot();
    expect(appliedCount).toBe(verified.value.fixture.events.length);
    // The old projection still has a red control above, but the live native
    // path no longer visits it, so no tool-detail-loss bucket is emitted.
    expect(toolBuckets()).toEqual([]);
    // Diagnostic state is a bounded closed-code aggregate, not a transcript.
    const serializedDiagnostics = JSON.stringify(snapshot);
    expect(serializedDiagnostics).not.toContain("weave-capture");
    expect(serializedDiagnostics).not.toContain("<reasoning-omitted>");

    const finalRows = renderRows().join("\n");
    expect(finalRows).toContain("Weave capture deterministic final answer.");
    // The authoritative answer remains in the inspector's settled transcript;
    // the parent card keeps its child-activity boundary content-free.
    expect(card.facts().activity).toEqual({
      kind: "boot",
      text: "",
      live: false,
    });
    const parentCardSurface = JSON.stringify({
      facts: card.facts(),
      details: card.details(),
      updates: cardUpdates,
    });
    expect(parentCardSurface).not.toMatch(
      /read|bash|tool-call-1|tool-call-2|weave-capture-ok|stdout|stderr|83 tests passed/iu,
    );
    expect(parentCardSurface).not.toContain(
      "Weave capture deterministic final answer.",
    );
    stream.dispose();
    card.dispose();
  });
});
