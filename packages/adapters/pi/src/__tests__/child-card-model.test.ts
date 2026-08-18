import { describe, expect, it } from "bun:test";
import {
  applyDelegationCardEvent,
  applyDelegationCardInput,
  CARD_ASSIGNMENT_MAX,
  CARD_CANCELLED_RECORD,
  CARD_FACTS_SCHEMA_VERSION,
  CARD_MODEL_MAX,
  CARD_NO_TOOL_EVIDENCE,
  CARD_PHASE_MAX,
  CARD_ROW_HEAD_MAX,
  CARD_ROW_TEXT_MAX,
  CARD_STATUS_MAX,
  CARD_TELEMETRY_MAX,
  CARD_TOOL_NAME,
  CARD_VIEWPORT_RING_ROWS,
  CARD_VIEWPORT_ROWS,
  createDelegationCardState,
  type PiDelegationCardFacts,
  type PiDelegationCardState,
  projectDelegationCardFacts,
} from "../child-card-model.js";
import type { PiChildSessionEvent } from "../child-session-events.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A deterministic clock: every read returns the caller-set stamp. */
function clockAt(ms: number): () => number {
  return () => ms;
}

function baseState(): PiDelegationCardState {
  return createDelegationCardState({
    agentName: "shuttle",
    assignment: "Fix header suffix width handling and run the focused sweep.",
    model: "gpt-5.6-sol",
  });
}

function started(atMs = 1_000): PiDelegationCardState {
  return apply(
    baseState(),
    {
      kind: "start_run",
      threadId: "thread-opaque-1",
      runNumber: 1,
      action: "start",
      agentName: "shuttle",
    },
    atMs,
  );
}

function apply(
  state: PiDelegationCardState,
  input: unknown,
  atMs = 2_000,
): PiDelegationCardState {
  const result = applyDelegationCardInput(state, input, clockAt(atMs));
  return result.match(
    (next) => next,
    (error) => {
      throw new Error(`unexpected card error: ${error.detail}`);
    },
  );
}

function applyEvent(
  state: PiDelegationCardState,
  event: PiChildSessionEvent,
  atMs = 2_000,
  itemId = "assistant",
): PiDelegationCardState {
  return applyDelegationCardEvent(state, event, clockAt(atMs), itemId).match(
    (next) => next,
    (error) => {
      throw new Error(`unexpected card error: ${error.detail}`);
    },
  );
}

function facts(state: PiDelegationCardState): PiDelegationCardFacts {
  return projectDelegationCardFacts(state);
}

const codePoints = (value: string): number => [...value].length;

// ---------------------------------------------------------------------------
// Shape and identity
// ---------------------------------------------------------------------------

describe("child-card-model shape", () => {
  it("projects the versioned card fact shape with absent unknowns", () => {
    const f = facts(baseState());
    expect(f.schemaVersion).toBe(CARD_FACTS_SCHEMA_VERSION);
    expect(f.tool).toBe(CARD_TOOL_NAME);
    expect(f.agentName).toBe("shuttle");
    expect(f.model).toBe("gpt-5.6-sol");
    expect(f.run).toEqual({ number: 1, action: "start", phase: "bootstrap" });
    expect(f.status).toBe("pending");
    expect(f.tone).toBe("mute");
    expect(f.settled).toBe(false);
    expect(f.assignment).toBe(
      "Fix header suffix width handling and run the focused sweep.",
    );
    // Absent is absent: no zero elapsed, no zero tokens, no `$0.00` guess.
    expect(f.telemetry).toEqual({});
    expect(f.viewport).toEqual({ rows: [], above: 0, atBottom: true });
    expect(f.terminal).toBeUndefined();
  });

  it("omits the model entirely when the caller has none", () => {
    const f = facts(
      createDelegationCardState({ agentName: "shuttle", assignment: "Do it." }),
    );
    expect("model" in f).toBe(false);
  });

  it("sanitizes and bounds identity, assignment, and model", () => {
    const state = createDelegationCardState({
      agentName: `\u001b[31m${"a".repeat(200)}\u001b[0m`,
      assignment: `\u001b]0;title\u0007${"b".repeat(600)}`,
      model: "c".repeat(400),
    });
    const f = facts(state);
    expect(f.agentName).not.toContain("\u001b");
    expect(codePoints(f.agentName)).toBeLessThanOrEqual(64);
    expect(codePoints(f.assignment)).toBeLessThanOrEqual(CARD_ASSIGNMENT_MAX);
    expect(f.assignment).not.toContain("title");
    expect(codePoints(f.model ?? "")).toBeLessThanOrEqual(CARD_MODEL_MAX);
  });

  it("falls back to a safe agent name rather than an empty rail", () => {
    const f = facts(
      createDelegationCardState({ agentName: "   ", assignment: "Do it." }),
    );
    expect(f.agentName).toBe("delegate");
  });
});

// ---------------------------------------------------------------------------
// Every parser-approved event type maps to a typed fact
// ---------------------------------------------------------------------------

describe("child-card-model event coverage", () => {
  it("message_start reports the child is writing, not an answer", () => {
    const f = facts(
      applyEvent(started(), {
        type: "message_start",
        message: { id: "m1", role: "assistant", content: [] },
      }),
    );
    expect(f.activity).toEqual({
      kind: "say",
      text: "shuttle is writing",
      live: true,
    });
    expect(f.status).toBe("running");
    expect(f.run.phase).toBe("responding");
    expect(f.terminal).toBeUndefined();
  });

  it("message_update grows one message row in place", () => {
    let state = applyEvent(started(), {
      type: "message_start",
      message: { id: "m1", role: "assistant", content: [] },
    });
    state = applyEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "reserving the " },
    });
    // Deltas are concatenated exactly: the wire owns the spacing, and a delta
    // is as often half a word as a whole one.
    state = applyEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "suffix" },
    });
    const f = facts(state);
    expect(f.activity).toEqual({
      kind: "say",
      text: "reserving the suffix",
      live: true,
    });
    // One message is one row, however many deltas grew it.
    expect(f.viewport.rows).toHaveLength(1);
    expect(f.viewport.above).toBe(0);
  });

  it("message_end freezes the row but never settles or claims completion", () => {
    let state = applyEvent(started(), {
      type: "message_start",
      message: { id: "m1", role: "assistant", content: [] },
    });
    state = applyEvent(state, {
      type: "message_end",
      message: {
        id: "m1",
        role: "assistant",
        content: [{ type: "text", text: "done reserving" }],
      },
    });
    const f = facts(state);
    expect(f.activity).toEqual({
      kind: "say",
      text: "done reserving",
      live: false,
    });
    expect(f.settled).toBe(false);
    expect(f.terminal).toBeUndefined();
    expect(f.status).toBe("running");
  });

  it("text is an assistant fragment and markdown behaves the same", () => {
    const fromText = facts(
      applyEvent(started(), { type: "text", text: "plain reply" }),
    );
    expect(fromText.activity.kind).toBe("say");
    expect(fromText.activity.text).toBe("plain reply");

    const fromMarkdown = facts(
      applyEvent(started(), { type: "markdown", text: "**bold** reply" }),
    );
    expect(fromMarkdown.activity.text).toBe("**bold** reply");
  });

  it("raw thinking becomes a content-free reasoning marker, never a summary", () => {
    const state = applyEvent(started(), {
      type: "thinking",
      text: "step one then step two",
    });
    const f = facts(state);
    expect(f.activity.kind).toBe("think");
    expect(f.activity.text).toBe("reasoning");
    expect(f.activity.text).not.toContain("summary");
    expect(f.run.phase).toBe("reasoning");
    expect(JSON.stringify(state)).not.toContain("step one");
  });

  it("an explicit host reasoning summary is named a summary", () => {
    const f = facts(
      applyEvent(started(), {
        type: "reasoning_summary",
        text: "step one then step two",
      }),
    );
    expect(f.activity.kind).toBe("think");
    expect(f.activity.text).toBe("summary · step one then step two");
    expect(f.run.phase).toBe("reasoning");
  });

  it("bounds a long reasoning summary and never retains more than it prints", () => {
    const state = applyEvent(started(), {
      type: "reasoning_summary",
      text: "x".repeat(5_000),
    });
    const f = facts(state);
    expect(codePoints(f.activity.text)).toBeLessThanOrEqual(CARD_ROW_TEXT_MAX);
    expect(JSON.stringify(state).length).toBeLessThan(5_000);
  });

  it("tool_call names the call and keeps it live", () => {
    const f = facts(
      applyEvent(started(), {
        type: "tool_call",
        toolCallId: "call-1",
        toolName: "bash",
      }),
    );
    expect(f.activity).toEqual({ kind: "tool", text: "bash", live: true });
    expect(f.run.phase).toBe("tool call");
    expect(f.viewport.rows[0]).toEqual({
      kind: "tool",
      head: "bash",
      text: "",
    });
  });

  it("tool_partial_result reports the call as running and stays live, without its payload", () => {
    let state = applyEvent(started(), {
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "bash",
    });
    state = applyEvent(state, {
      type: "tool_partial_result",
      toolCallId: "call-1",
      partialResult: "18 of 24",
    });
    const f = facts(state);
    // Tool payload prose never crosses the card boundary; the canonical
    // lifecycle state derived from the event type does.
    expect(f.activity).toEqual({
      kind: "tool",
      text: "bash · running",
      live: true,
    });
    expect(JSON.stringify(f)).not.toContain("18 of 24");
  });

  it("tool_result states the call as done, never its result payload", () => {
    let state = applyEvent(started(), {
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "edit",
    });
    state = applyEvent(state, {
      type: "tool_result",
      toolCallId: "call-1",
      content: [{ type: "text", text: "1 replacement · +6 −3" }],
    });
    const f = facts(state);
    expect(f.activity).toEqual({
      kind: "tool",
      text: "edit · done",
      live: false,
    });
    expect(JSON.stringify(f)).not.toContain("1 replacement");
  });

  it("tool_error keeps error vocabulary and error tone", () => {
    let state = applyEvent(started(), {
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "bash",
    });
    state = applyEvent(state, {
      type: "tool_error",
      toolCallId: "call-1",
      error: "exit status 1",
    });
    const f = facts(state);
    expect(f.activity).toEqual({
      kind: "error",
      text: "bash · failed",
      live: false,
    });
    expect(JSON.stringify(f)).not.toContain("exit status 1");
    expect(f.tone).toBe("bad");
    expect(f.viewport.rows.at(-1)?.kind).toBe("error");
  });

  it("usage sets telemetry, replaces rather than sums, and moves no row", () => {
    let state = applyEvent(started(), {
      type: "usage",
      usage: { input: 1_000, output: 200, totalTokens: 1_200 },
    });
    expect(facts(state).telemetry.tokens).toBe("1.2k tok");
    expect(facts(state).viewport.rows).toHaveLength(0);

    state = applyEvent(state, {
      type: "usage",
      usage: { totalTokens: 4_200, cost: { total: 0.37 } },
    });
    const f = facts(state);
    // Latest authoritative, NEVER 1_200 + 4_200.
    expect(f.telemetry.tokens).toBe("4.2k tok");
    expect(f.telemetry.cost).toBe("$0.37");
  });

  it("queue_change becomes the steered fact with warning tone", () => {
    const f = facts(applyEvent(started(), { type: "queue_change", size: 2 }));
    expect(f.activity).toEqual({
      kind: "queue",
      text: "2 queued · parent steered the child",
      live: false,
    });
    expect(f.tone).toBe("warn");
    expect(f.run.phase).toBe("steered");
  });

  it("status renames the lifecycle phase and adds no transcript row", () => {
    const state = applyEvent(started(), {
      type: "status",
      status: "compacting context",
    });
    const f = facts(state);
    expect(f.run.phase).toBe("compacting context");
    expect(f.viewport.rows).toHaveLength(0);
    expect(f.viewport.above).toBe(0);
  });

  it("retry becomes the run action, a boot row, and a bootstrap phase", () => {
    const f = facts(
      applyEvent(started(), {
        type: "retry",
        attempt: 2,
        reason: "provider overloaded",
      }),
    );
    expect(f.run.action).toBe("retry");
    expect(f.run.phase).toBe("bootstrap");
    expect(f.activity).toEqual({
      kind: "boot",
      text: "retry 2 · provider overloaded",
      live: false,
    });
  });

  it("unknown, image and extension UI events move nothing on the card", () => {
    const before = facts(started(1_000));
    for (const event of [
      { type: "unknown", originalType: "host_only", payload: {} },
      { type: "image", mimeType: "image/png" },
      {
        type: "extension_ui_request",
        requestType: "notification",
        requestId: "r1",
      },
    ] satisfies PiChildSessionEvent[]) {
      const after = facts(applyEvent(started(1_000), event, 1_000));
      expect(after).toEqual(before);
    }
  });
});

// ---------------------------------------------------------------------------
// Native Line rules
// ---------------------------------------------------------------------------

describe("child-card-model native line", () => {
  it("follows the latest visible event", () => {
    let state = applyEvent(started(), { type: "thinking", text: "planning" });
    expect(facts(state).activity.kind).toBe("think");
    state = applyEvent(state, {
      type: "tool_call",
      toolCallId: "c1",
      toolName: "read",
    });
    expect(facts(state).activity.kind).toBe("tool");
    state = applyEvent(state, { type: "text", text: "the answer" });
    expect(facts(state).activity.kind).toBe("say");
    state = applyEvent(state, { type: "queue_change", size: 1 });
    expect(facts(state).activity.kind).toBe("queue");
  });

  it("reserves `reply` for the settlement-named output", () => {
    let state = started();
    for (const turn of [1, 2, 3]) {
      state = applyEvent(
        state,
        {
          type: "message_end",
          message: {
            id: `m${turn}`,
            role: "assistant",
            content: [{ type: "text", text: `ended message ${turn}` }],
          },
        },
        2_000 + turn,
        `assistant-${turn}`,
      );
      expect(facts(state).activity.kind).toBe("say");
    }
    state = apply(state, {
      kind: "settle",
      settlement: { outcome: "completed", assistantOutput: "the final answer" },
    });
    expect(facts(state).activity.kind).toBe("reply");
  });

  it("degrades to a starting note before any activity exists", () => {
    const f = facts(started());
    expect(f.activity).toEqual({
      kind: "boot",
      text: "shuttle is starting",
      live: true,
    });
    expect(f.status).toBe("starting");
  });
});

// ---------------------------------------------------------------------------
// Settlement is the only completion authority
// ---------------------------------------------------------------------------

describe("child-card-model settlement", () => {
  it("keeps terminal absent through three ended messages without settlement", () => {
    let state = started();
    for (const turn of [1, 2, 3]) {
      state = applyEvent(
        state,
        {
          type: "message_start",
          message: { id: `m${turn}`, role: "assistant", content: [] },
        },
        2_000,
        `assistant-${turn}`,
      );
      state = applyEvent(
        state,
        {
          type: "message_end",
          message: {
            id: `m${turn}`,
            role: "assistant",
            content: [{ type: "text", text: `candidate ${turn}` }],
          },
        },
        2_100,
        `assistant-${turn}`,
      );
      const f = facts(state);
      expect(f.terminal).toBeUndefined();
      expect(f.settled).toBe(false);
      expect(f.tone).toBe("run");
      expect(f.activity.kind).not.toBe("reply");
    }
  });

  it("derives completed terminal facts from the authoritative output only", () => {
    let state = applyEvent(started(), {
      type: "tool_call",
      toolCallId: "c1",
      toolName: "bun test",
    });
    state = applyEvent(state, {
      type: "tool_result",
      toolCallId: "c1",
      content: [{ type: "text", text: "24 pass" }],
    });
    state = apply(
      state,
      {
        kind: "settle",
        settlement: {
          outcome: "completed",
          assistantOutput: "Suffix reserved and the sweep is green.",
          completionCandidate: "never printed",
        },
      },
      41_000,
    );
    const f = facts(state);
    expect(f.settled).toBe(true);
    expect(f.status).toBe("completed");
    expect(f.tone).toBe("ok");
    expect(f.terminal).toEqual({
      outcome: "completed",
      verdict: "COMPLETED",
      glyph: "✓",
      headline: "Suffix reserved and the sweep is green.",
      // The evidence names the last tool and its canonical state. The tool's
      // own output stays in the child transcript.
      evidence: "verified · bun test · done",
    });
    expect(JSON.stringify(f)).not.toContain("24 pass");
    expect(JSON.stringify(f)).not.toContain("never printed");
  });

  it("says so plainly when the child reported no tool evidence", () => {
    const state = apply(started(), {
      kind: "settle",
      settlement: { outcome: "completed", assistantOutput: "done" },
    });
    expect(facts(state).terminal?.evidence).toBe(
      `verified · ${CARD_NO_TOOL_EVIDENCE}`,
    );
  });

  it("withholds terminal facts when a settlement named no text", () => {
    const state = apply(started(), {
      kind: "settle",
      settlement: { outcome: "completed", completionCandidate: "candidate" },
    });
    const f = facts(state);
    expect(f.settled).toBe(true);
    expect(f.terminal).toBeUndefined();
    expect(f.activity.kind).not.toBe("reply");
  });

  it("names recovery only for a documented recoverable failure class", () => {
    const recoverable = facts(
      apply(started(), {
        kind: "settle",
        settlement: { outcome: "failed", reason: "Provider is overloaded." },
        failureClass: "overload",
      }),
    );
    expect(recoverable.terminal?.verdict).toBe("FAILED");
    expect(recoverable.terminal?.recovery).toBe(
      "overload · re-delegation from the parent is the documented recovery",
    );
    expect(recoverable.tone).toBe("bad");

    for (const failureClass of ["auth", "unknown", "malformed-response"]) {
      const guarded = facts(
        apply(started(), {
          kind: "settle",
          settlement: { outcome: "failed", reason: "Provider request failed." },
          failureClass,
        }),
      );
      expect(guarded.terminal?.recovery).toBeUndefined();
    }

    const unclassified = facts(
      apply(started(), {
        kind: "settle",
        settlement: { outcome: "failed", reason: "Provider request failed." },
      }),
    );
    expect(unclassified.terminal?.recovery).toBeUndefined();
    expect(unclassified.terminal?.evidence).toBe(
      "failure · child no longer running",
    );
  });

  it("cancels without claiming success", () => {
    const f = facts(
      apply(started(), {
        kind: "settle",
        settlement: { outcome: "cancelled" },
      }),
    );
    expect(f.terminal).toEqual({
      outcome: "cancelled",
      verdict: "CANCELLED",
      glyph: "⊘",
      headline: CARD_CANCELLED_RECORD,
      evidence: "stopped by the parent · nothing verified",
    });
    expect(f.tone).toBe("mute");
    expect(f.activity.kind).toBe("cancel");
    expect(f.activity.live).toBe(false);
  });

  it("ignores a duplicate settlement", () => {
    let state = apply(started(), {
      kind: "settle",
      settlement: { outcome: "completed", assistantOutput: "first" },
    });
    state = apply(state, {
      kind: "settle",
      settlement: { outcome: "failed", reason: "second" },
    });
    expect(facts(state).terminal?.headline).toBe("first");
    expect(facts(state).status).toBe("completed");
  });

  it("adds NO viewport row and never marks activity live afterwards", () => {
    // NATIVE SETTLE (§1.13): the settlement rewrites the rail word, the Native
    // Line and the footer verb, and adds nothing. The expanded viewport is a
    // literal bottom slice of the child's transcript (§1.12), so a card-authored
    // verdict row would be a line the child never wrote — printed directly
    // under the terminal message that already says it.
    const running = facts(applyEvent(started(), { type: "text", text: "hi" }));
    const settled = facts(
      apply(applyEvent(started(), { type: "text", text: "hi" }), {
        kind: "settle",
        settlement: { outcome: "completed", assistantOutput: "bye" },
      }),
    );
    expect(settled.viewport.rows).toEqual(running.viewport.rows);
    expect(settled.viewport.above).toBe(running.viewport.above);
    expect(settled.viewport.rows.some((row) => row.kind === "settled")).toBe(
      false,
    );
    // The verdict still reaches the reader, exactly three times over: the rail
    // word, the Native Line, and the footer's terminal facts.
    expect(settled.status).toBe("completed");
    expect(settled.activity.text).toBe("bye");
    expect(settled.terminal?.headline).toBe("bye");
    expect(settled.activity.live).toBe(false);
  });

  it("adds no row when the settlement carries the answer already on screen", () => {
    // The live proof's shape: the child's terminal message and the settlement
    // say the same sentence, so a settlement row printed it twice.
    const answer = "the suite is green";
    const state = apply(applyEvent(started(), { type: "text", text: answer }), {
      kind: "settle",
      settlement: { outcome: "completed", assistantOutput: answer },
    });
    const f = facts(state);
    expect(
      f.viewport.rows.filter((row) => row.text.includes(answer)),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Viewport ring
// ---------------------------------------------------------------------------

describe("child-card-model viewport ring", () => {
  it("keeps at most the window rows and an exact rows-above count", () => {
    let state = started();
    const produced = 30;
    for (let index = 0; index < produced; index += 1) {
      state = applyEvent(
        state,
        { type: "text", text: `row ${index}` },
        2_000 + index,
        `assistant-${index}`,
      );
    }
    const f = facts(state);
    expect(f.viewport.rows).toHaveLength(CARD_VIEWPORT_ROWS);
    expect(f.viewport.above).toBe(produced - CARD_VIEWPORT_ROWS);
    expect(f.viewport.atBottom).toBe(true);
    expect(f.viewport.rows.at(-1)?.text).toBe(`row ${produced - 1}`);
  });

  it("keeps `above` exact after ring eviction", () => {
    let state = started();
    const produced = CARD_VIEWPORT_RING_ROWS + 40;
    for (let index = 0; index < produced; index += 1) {
      state = applyEvent(
        state,
        { type: "text", text: `row ${index}` },
        2_000 + index,
        `assistant-${index}`,
      );
    }
    const f = facts(state);
    // Retained rows were evicted, but the produced count is monotone.
    expect(f.viewport.rows).toHaveLength(CARD_VIEWPORT_ROWS);
    expect(f.viewport.above).toBe(produced - CARD_VIEWPORT_ROWS);
    expect(f.viewport.above + f.viewport.rows.length).toBe(produced);
    expect(f.viewport.atBottom).toBe(true);
  });

  it("growing one row in place never advances the produced count", () => {
    let state = applyEvent(started(), {
      type: "message_start",
      message: { id: "m1", role: "assistant", content: [] },
    });
    for (const delta of ["a", "b", "c", "d"]) {
      state = applyEvent(state, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta },
      });
    }
    const f = facts(state);
    expect(f.viewport.rows).toHaveLength(1);
    expect(f.viewport.above).toBe(0);
  });

  it("bounds every row fact", () => {
    let state = started();
    state = applyEvent(state, {
      type: "tool_call",
      toolCallId: "c1",
      toolName: "t".repeat(300),
    });
    state = applyEvent(state, {
      type: "tool_result",
      toolCallId: "c1",
      result: "r".repeat(9_000),
    });
    state = applyEvent(state, { type: "text", text: "z".repeat(9_000) });
    const f = facts(state);
    for (const row of f.viewport.rows) {
      expect(codePoints(row.head)).toBeLessThanOrEqual(CARD_ROW_HEAD_MAX);
      expect(codePoints(row.text)).toBeLessThanOrEqual(CARD_ROW_TEXT_MAX);
    }
    expect(codePoints(f.activity.text)).toBeLessThanOrEqual(CARD_ROW_TEXT_MAX);
  });
});

// ---------------------------------------------------------------------------
// Clock and telemetry
// ---------------------------------------------------------------------------

describe("child-card-model telemetry", () => {
  it("computes elapsed from the injected clock at event time", () => {
    let state = started(1_000);
    expect(facts(state).telemetry.elapsed).toBe("0.0s");
    state = applyEvent(state, { type: "text", text: "one" }, 1_400);
    expect(facts(state).telemetry.elapsed).toBe("0.4s");
    state = applyEvent(state, { type: "text", text: "two" }, 39_000);
    expect(facts(state).telemetry.elapsed).toBe("38s");
    state = applyEvent(state, { type: "text", text: "three" }, 253_000);
    expect(facts(state).telemetry.elapsed).toBe("4m 12s");
  });

  it("freezes elapsed at the settlement and ignores later clock reads", () => {
    let state = applyEvent(started(1_000), { type: "text", text: "x" }, 5_000);
    state = apply(
      state,
      {
        kind: "settle",
        settlement: { outcome: "completed", assistantOutput: "done" },
      },
      11_000,
    );
    const settledElapsed = facts(state).telemetry.elapsed;
    expect(settledElapsed).toBe("10s");
    // A later event cannot age a settled child.
    state = applyEvent(state, { type: "text", text: "late" }, 999_000);
    expect(facts(state).telemetry.elapsed).toBe(settledElapsed);
  });

  it("leaves elapsed absent until a run has started", () => {
    const state = applyEvent(baseState(), { type: "text", text: "orphan" });
    expect(facts(state).telemetry.elapsed).toBeUndefined();
  });

  it("bounds every formatted telemetry figure", () => {
    const state = applyEvent(started(), {
      type: "usage",
      usage: { totalTokens: 987_654_321, cost: { total: 999_999 } },
    });
    const { telemetry } = facts(state);
    expect(telemetry.tokens).toBe("987.7M tok");
    expect(codePoints(telemetry.tokens ?? "")).toBeLessThanOrEqual(
      CARD_TELEMETRY_MAX,
    );
    expect(codePoints(telemetry.cost ?? "")).toBeLessThanOrEqual(
      CARD_TELEMETRY_MAX,
    );
  });
});

// ---------------------------------------------------------------------------
// Failure isolation
// ---------------------------------------------------------------------------

describe("child-card-model failure isolation", () => {
  it("returns a typed error and leaves prior facts unchanged", () => {
    const state = applyEvent(started(), { type: "text", text: "kept" });
    const before = facts(state);

    for (const malformed of [
      null,
      undefined,
      42,
      "settle",
      [],
      { kind: "not-a-real-kind" },
      { kind: "tool" },
      { kind: "settle", settlement: { outcome: "weird" } },
      { kind: "start_run", threadId: "t", runNumber: "one", agentName: "a" },
    ]) {
      const result = applyDelegationCardInput(state, malformed, clockAt(9_000));
      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.type).toBe("PiDelegationCardFailed");
      expect(error.operation).toBe("apply");
      expect(typeof error.detail).toBe("string");
    }

    // Prior facts survive every rejected input.
    expect(facts(state)).toEqual(before);
  });

  it("rejects an unusable clock rather than inventing an elapsed", () => {
    const state = started();
    const result = applyDelegationCardInput(
      state,
      { kind: "control", itemId: "c" },
      () => Number.NaN,
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().detail).toBe("invalid_clock");
  });

  it("never throws on an expected path", () => {
    expect(() =>
      applyDelegationCardInput(started(), { kind: "\u0000" }, clockAt(1)),
    ).not.toThrow();
    expect(() => projectDelegationCardFacts(baseState())).not.toThrow();
  });

  it("keeps chrome free of terminal control sequences", () => {
    const state = applyEvent(started(), {
      type: "text",
      text: "\u001b[2Jcleared\u0007",
    });
    const serialized = JSON.stringify(facts(state));
    expect(serialized).not.toContain("\\u001b");
    expect(serialized).not.toContain("\\u0007");
  });

  it("bounds the status word and the lifecycle phase", () => {
    const state = applyEvent(started(), {
      type: "status",
      status: "p".repeat(500),
    });
    const f = facts(state);
    expect(codePoints(f.run.phase)).toBeLessThanOrEqual(CARD_PHASE_MAX);
    expect(codePoints(f.status)).toBeLessThanOrEqual(CARD_STATUS_MAX);
  });
});
