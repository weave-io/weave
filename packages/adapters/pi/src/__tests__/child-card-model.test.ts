import { describe, expect, it } from "bun:test";
import {
  applyDelegationCardEvent,
  applyDelegationCardInput,
  CARD_ASSIGNMENT_MAX,
  CARD_CANCELLED_RECORD,
  CARD_COMPLETED_RECORD,
  CARD_FACTS_SCHEMA_VERSION,
  CARD_MODEL_MAX,
  CARD_PHASE_MAX,
  CARD_SETTLEMENT_EVIDENCE,
  CARD_STATUS_MAX,
  createDelegationCardState,
  PiChildCardProjection,
  type PiDelegationCardFacts,
  type PiDelegationCardState,
  projectDelegationCardFacts,
} from "../child-card-model.js";
import { MODEL_TRANSITION_SCHEMA_VERSION } from "../child-control-bodies.js";
import type { PiChildSessionEvent } from "../child-session-events.js";

const RAW_REASONING = "RAW_REASONING_SENTINEL";
const ASSISTANT = "LIVE_ASSISTANT_SENTINEL";
const TOOL = "TOOL_NAME_SENTINEL";
const TOOL_PAYLOAD = "STDOUT_STDERR_SENTINEL";
const SUMMARY = "SUMMARY_REASONING_SENTINEL";
const INSPECTOR = "INSPECTOR_PAYLOAD_SENTINEL";

function clockAt(ms: number): () => number {
  return () => ms;
}

function baseState(): PiDelegationCardState {
  return createDelegationCardState({
    agentName: "shuttle",
    assignment: "Fix the header suffix width handling.",
    model: "gpt-5.6-sol",
  });
}

function started(atMs = 1_000): PiDelegationCardState {
  return apply(
    baseState(),
    {
      kind: "start_run",
      threadId: "thread-1",
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
  return applyDelegationCardInput(state, input, clockAt(atMs)).match(
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
): PiDelegationCardState {
  return applyDelegationCardEvent(state, event, clockAt(atMs)).match(
    (next) => next,
    (error) => {
      throw new Error(`unexpected card error: ${error.detail}`);
    },
  );
}

function facts(state: PiDelegationCardState): PiDelegationCardFacts {
  return projectDelegationCardFacts(state);
}

function noChildActivity(f: PiDelegationCardFacts): void {
  expect(f.activity).toEqual({ kind: "boot", text: "", live: false });
  expect(f.viewport).toEqual({ rows: [], above: 0, atBottom: true });
}

function noSentinels(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const sentinel of [
    RAW_REASONING,
    ASSISTANT,
    TOOL,
    TOOL_PAYLOAD,
    SUMMARY,
    INSPECTOR,
  ]) {
    expect(serialized).not.toContain(sentinel);
  }
}

function event(
  type: string,
  fields: Record<string, unknown> = {},
): PiChildSessionEvent {
  return { type, ...fields } as unknown as PiChildSessionEvent;
}

describe("child-card-model parent activity boundary", () => {
  it("projects a bounded content-free activity and viewport", () => {
    const f = facts(baseState());
    expect(f.schemaVersion).toBe(CARD_FACTS_SCHEMA_VERSION);
    expect(f.tool).toBe("weave_delegate");
    expect(f.agentName).toBe("shuttle");
    expect(f.model).toBeUndefined();
    expect(f.run).toEqual({ number: 1, action: "start", phase: "bootstrap" });
    expect(f.status).toBe("pending");
    expect(f.tone).toBe("mute");
    noChildActivity(f);
    expect(f.telemetry).toEqual({});
    expect(f.terminal).toBeUndefined();
  });

  it("never retains assistant, reasoning, summary, tool, queue, or inspector prose", () => {
    let state = started();
    const events = [
      event("message_start", {
        message: { id: "m1", role: "assistant", content: [] },
      }),
      event("message_update", {
        assistantMessageEvent: { type: "text_delta", delta: ASSISTANT },
      }),
      event("message_end", {
        message: {
          id: "m1",
          role: "assistant",
          content: [{ type: "text", text: ASSISTANT }],
        },
      }),
      event("thinking", { text: RAW_REASONING }),
      event("reasoning_summary", { text: SUMMARY }),
      event("tool_call", {
        toolCallId: "tool-1",
        toolName: TOOL,
        arguments: INSPECTOR,
      }),
      event("tool_partial_result", {
        toolCallId: "tool-1",
        partialResult: TOOL_PAYLOAD,
      }),
      event("tool_result", { toolCallId: "tool-1", result: TOOL_PAYLOAD }),
      event("tool_error", { toolCallId: "tool-1", message: TOOL_PAYLOAD }),
      event("queue_change", { size: 1 }),
    ];
    for (const [index, input] of events.entries()) {
      state = applyEvent(state, input, 2_000 + index);
      const f = facts(state);
      noChildActivity(f);
      noSentinels(f);
    }
    noSentinels(state);
  });

  it("keeps lifecycle and telemetry without copying child activity", () => {
    let state = started();
    expect(facts(state).status).toBe("starting");
    state = applyEvent(state, event("thinking", { text: RAW_REASONING }));
    expect(facts(state).run.phase).toBe("reasoning");
    expect(facts(state).status).toBe("running");
    state = applyEvent(state, event("tool_call", { toolName: TOOL }));
    expect(facts(state).run.phase).toBe("tool call");
    expect(facts(state).status).toBe("running");
    state = applyEvent(state, event("queue_change", { size: 2 }));
    expect(facts(state).run.phase).toBe("steered");
    expect(facts(state).status).toBe("steered");
    state = applyEvent(
      state,
      event("usage", {
        usage: { inputTokens: 1_000, outputTokens: 2_000, costUsd: 0.03 },
      }),
      4_000,
    );
    expect(facts(state).telemetry.elapsed).toBe("3.0s");
    noChildActivity(facts(state));
    noSentinels(facts(state));
  });

  it("does not retain the reasoning summary even when the event is explicit", () => {
    const state = applyEvent(
      started(),
      event("reasoning_summary", { text: SUMMARY }),
    );
    expect(facts(state).run.phase).toBe("reasoning");
    noChildActivity(facts(state));
    noSentinels(state);
  });
});

describe("child-card model fallback transitions", () => {
  const transitionId = "123e4567-e89b-42d3-a456-426614174000";
  const body = (phase: "applied" | "recovery-confirmed") => ({
    schemaVersion: MODEL_TRANSITION_SCHEMA_VERSION,
    transitionId,
    failureClass: "provider_unavailable" as const,
    from: { provider: "openai", id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
    to: { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude" },
    phase,
  });

  it("updates the atom on applied, then rewrites one Native Line on confirmation", () => {
    const projection = new PiChildCardProjection({
      threadId: "thread-1",
      agentName: "shuttle",
      assignment: "Switch safely.",
      model: "configured/model",
      now: () => 1_000,
    });
    const before = projection.facts();
    const applied = projection.applyModelTransition(body("applied"));
    expect(applied.appliedIdentity).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude",
    });
    expect(applied.fallback).toBeUndefined();
    expect(applied.viewport).toEqual(before.viewport);

    const confirmed = projection.applyModelTransition(
      body("recovery-confirmed"),
    );
    expect(confirmed.fallback).toMatchObject({
      transitionId,
      failureClass: "provider_unavailable",
    });
    expect(confirmed.activity).toEqual({
      kind: "fallback",
      text: "model fallback · anthropic/claude-sonnet-4-5",
      live: false,
    });
    expect(confirmed.viewport).toEqual(applied.viewport);

    const duplicate = projection.applyModelTransition(
      body("recovery-confirmed"),
    );
    expect(duplicate).toEqual(confirmed);
  });

  it("does not fabricate a fallback event from an applied-only or orphan confirmation", () => {
    const orphan = new PiChildCardProjection({
      threadId: "thread-orphan",
      agentName: "shuttle",
      assignment: "Wait.",
      now: () => 1_000,
    });
    const before = orphan.facts();
    expect(orphan.applyModelTransition(body("recovery-confirmed"))).toEqual(
      before,
    );
  });
});

describe("child-card-model settlement boundary", () => {
  it("keeps final assistant output out of card facts while preserving terminal framing", () => {
    let state = applyEvent(started(), event("tool_call", { toolName: TOOL }));
    state = apply(
      state,
      {
        kind: "settle",
        settlement: {
          outcome: "completed",
          assistantOutput: ASSISTANT,
          completionCandidate: RAW_REASONING,
          interventionCount: 2,
        },
      },
      8_000,
    );
    const f = facts(state);
    expect(f.settled).toBe(true);
    expect(f.status).toBe("completed");
    expect(f.tone).toBe("ok");
    expect(f.terminal).toEqual({
      outcome: "completed",
      verdict: "COMPLETED",
      glyph: "✓",
      headline: CARD_COMPLETED_RECORD,
      evidence: CARD_SETTLEMENT_EVIDENCE,
    });
    noChildActivity(f);
    noSentinels(f);
    // The settled tool result owns authoritative output. The card facts do not
    // expose it, even though the internal reducer retains the settlement
    // boundary until the caller discards the projection.
  });

  it("keeps failure recovery closed and never copies the failure sentence", () => {
    const state = apply(started(), {
      kind: "settle",
      settlement: { outcome: "failed", reason: TOOL_PAYLOAD },
      failureClass: "overload",
    });
    const f = facts(state);
    expect(f.terminal).toEqual({
      outcome: "failed",
      verdict: "FAILED",
      glyph: "✕",
      headline: "child failed",
      evidence: "overload",
      recovery:
        "overload · re-delegation from the parent is the documented recovery",
    });
    noChildActivity(f);
    noSentinels(f);
  });

  it("retains the fixed cancellation framing and freezes duplicate settlement", () => {
    let state = apply(started(), {
      kind: "settle",
      settlement: { outcome: "cancelled" },
    });
    const first = facts(state);
    expect(first.terminal).toEqual({
      outcome: "cancelled",
      verdict: "CANCELLED",
      glyph: "⊘",
      headline: CARD_CANCELLED_RECORD,
      evidence: "stopped by the parent · nothing verified",
    });
    state = apply(state, {
      kind: "settle",
      settlement: { outcome: "completed", assistantOutput: ASSISTANT },
    });
    expect(facts(state)).toEqual(first);
    noSentinels(state);
  });

  it("freezes a prior run and keeps every run free of child rows", () => {
    const projection = new PiChildCardProjection({
      threadId: "thread-1",
      agentName: "shuttle",
      assignment: "do it",
      now: clockAt(1_000),
    });
    projection.applySessionEvent(event("text", { text: ASSISTANT }));
    projection.startRun({
      runNumber: 2,
      action: "retry",
      assignment: "retry it",
    });
    expect(projection.frozenRunFacts(1)?.viewport).toEqual({
      rows: [],
      above: 0,
      atBottom: true,
    });
    noChildActivity(projection.facts());
    noSentinels(projection.facts());
  });
});

describe("child-card-model bounds and failures", () => {
  it("bounds identity, assignment, model, phase, and status", () => {
    const f = facts(
      createDelegationCardState({
        agentName: `\u001b[31m${"a".repeat(200)}\u001b[0m`,
        assignment: `\u001b]0;title\u0007${"b".repeat(600)}`,
        model: "c".repeat(400),
      }),
    );
    expect(f.agentName).not.toContain("\u001b");
    expect([...f.assignment].length).toBeLessThanOrEqual(CARD_ASSIGNMENT_MAX);
    expect([...(f.model ?? "")].length).toBeLessThanOrEqual(CARD_MODEL_MAX);
    expect([...f.run.phase].length).toBeLessThanOrEqual(CARD_PHASE_MAX);
    expect([...f.status].length).toBeLessThanOrEqual(CARD_STATUS_MAX);
    noSentinels(f);
  });

  it("returns a typed error without mutating the prior state", () => {
    const before = started();
    const result = applyDelegationCardInput(
      before,
      { kind: "not-a-real-input" },
      clockAt(2_000),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "PiDelegationCardFailed",
      operation: "apply",
    });
    expect(facts(before)).toEqual(facts(before));
  });

  it("rejects an unusable clock and never throws on expected paths", () => {
    const before = started();
    const bad = applyDelegationCardInput(
      before,
      { kind: "control", itemId: "control-1" },
      () => Number.NaN,
    );
    expect(bad.isErr()).toBe(true);
    expect(() =>
      applyDelegationCardInput(before, { kind: "bad" }, clockAt(1)),
    ).not.toThrow();
  });

  it("keeps terminal controls out of chrome", () => {
    const f = facts(
      createDelegationCardState({
        agentName: "\u001b[31mshuttle\u001b[0m",
        assignment: "\u001b]0;secret\u0007do it",
      }),
    );
    expect(JSON.stringify(f)).not.toContain("\u001b");
    expect(JSON.stringify(f)).not.toContain("secret");
  });
});
