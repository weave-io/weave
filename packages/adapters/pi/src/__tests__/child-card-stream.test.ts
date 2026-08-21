/**
 * Task 5 parent-card boundary tests.
 *
 * The card owns lifecycle framing only. Child assistant text, tool payloads,
 * and reasoning prose stay outside its persisted facts and model-visible
 * partial updates. Raw reasoning is tested through the separate renderer seam.
 */
import { describe, expect, it } from "bun:test";
import {
  CARD_CANCELLED_RECORD,
  CARD_COMPLETED_RECORD,
  PiChildCardProjection,
  type PiChildCardProjectionConfig,
  type PiDelegationCardFacts,
} from "../child-card-model.js";
import { renderDelegationCard } from "../child-card-render.js";
import {
  createPiLiveReasoningRegistry,
  PiLiveReasoningProjector,
} from "../child-live-reasoning.js";
import type { PiChildSessionEvent } from "../child-session-events.js";
import type { TimerHandle, TimerPort } from "../child-timer.js";
import {
  boundDelegationCardDetails,
  CARD_REFRESH_INTERVAL_MS,
  PiCardUpdateCoalescer,
  type PiDelegationCardDetails,
  PiDelegationCardStream,
  parseDelegationCardDetails,
} from "../delegation-tool.js";
import type { PiToolResult } from "../types.js";
import { plainPaint } from "../ui-paint.js";

const RAW_REASONING_SENTINEL = "RAW_REASONING_SENTINEL";
const LIVE_ASSISTANT_SENTINEL = "LIVE_ASSISTANT_SENTINEL";
const TOOL_ACTIVITY_SENTINEL = "TOOL_ACTIVITY_SENTINEL";
const STDOUT_STDERR_SENTINEL = "STDOUT_STDERR_SENTINEL";
const INSPECTOR_SENTINEL = "INSPECTOR_SENTINEL";

class ScriptedTimerPort implements TimerPort {
  readonly delays: number[] = [];
  private pending: (() => void)[] = [];
  cancelled = 0;

  schedule(callback: () => void, delayMs: number): TimerHandle {
    this.delays.push(delayMs);
    let active = true;
    this.pending.push(() => {
      if (active) callback();
    });
    return {
      cancel: () => {
        if (active) this.cancelled += 1;
        active = false;
      },
    };
  }

  fire(): void {
    const pending = this.pending;
    this.pending = [];
    for (const callback of pending) callback();
  }

  fireAll(): void {
    while (this.pending.length > 0) this.fire();
  }
}

function now(): () => number {
  let value = 1_000;
  return () => {
    value += 25;
    return value;
  };
}

function config(
  overrides: Partial<PiChildCardProjectionConfig> = {},
): PiChildCardProjectionConfig {
  return {
    threadId: "thread-1",
    agentName: "shuttle",
    assignment: "Fix the parent card projection.",
    runNumber: 1,
    action: "start",
    now: now(),
    ...overrides,
  };
}

function textDelta(text: string): PiChildSessionEvent {
  return {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: text },
  } as unknown as PiChildSessionEvent;
}

function event(
  type: string,
  fields: Record<string, unknown> = {},
): PiChildSessionEvent {
  return { type, ...fields } as unknown as PiChildSessionEvent;
}

function assertContentFreeCardFacts(facts: PiDelegationCardFacts): void {
  expect(facts.activity).toEqual({ kind: "boot", text: "", live: false });
  expect(facts.viewport).toEqual({ rows: [], above: 0, atBottom: true });
  const serialized = JSON.stringify(facts);
  for (const sentinel of [
    RAW_REASONING_SENTINEL,
    LIVE_ASSISTANT_SENTINEL,
    TOOL_ACTIVITY_SENTINEL,
    STDOUT_STDERR_SENTINEL,
    INSPECTOR_SENTINEL,
  ]) {
    expect(serialized).not.toContain(sentinel);
  }
}

function rendered(facts: PiDelegationCardFacts, expanded = false): string {
  return renderDelegationCard(facts, {
    width: 80,
    expanded,
    paint: plainPaint(),
  }).join("\n");
}

describe("PiCardUpdateCoalescer", () => {
  it("publishes at once, coalesces within 100 ms, and flushes the tail", () => {
    const timer = new ScriptedTimerPort();
    let published = 0;
    const coalescer = new PiCardUpdateCoalescer(() => {
      published += 1;
    }, timer);

    coalescer.request("coalesced");
    expect(published).toBe(1);
    expect(timer.delays).toEqual([CARD_REFRESH_INTERVAL_MS]);
    expect(CARD_REFRESH_INTERVAL_MS).toBe(100);
    for (let index = 0; index < 500; index += 1) coalescer.request("coalesced");
    expect(published).toBe(1);
    timer.fire();
    expect(published).toBe(2);
    coalescer.dispose();
    timer.fireAll();
    expect(published).toBe(2);
  });

  it("does not let an update publisher failure escape", () => {
    const timer = new ScriptedTimerPort();
    const coalescer = new PiCardUpdateCoalescer(() => {
      throw new Error("expected test publisher failure");
    }, timer);
    expect(() => coalescer.request("immediate")).not.toThrow();
    expect(() => coalescer.flush()).not.toThrow();
  });
});

describe("PiDelegationCardStream parent boundary", () => {
  it("keeps every partial frame content-free while preserving lifecycle and telemetry", () => {
    const timer = new ScriptedTimerPort();
    const updates: PiToolResult[] = [];
    const stream = new PiDelegationCardStream({
      ...config(),
      onUpdate: (update) => updates.push(update),
      timerPort: timer,
    });

    stream.start();
    stream.applyEvent(textDelta(LIVE_ASSISTANT_SENTINEL));
    stream.applyEvent(event("thinking", { text: RAW_REASONING_SENTINEL }));
    stream.applyEvent(
      event("tool_call", {
        toolCallId: "tool-1",
        toolName: TOOL_ACTIVITY_SENTINEL,
        arguments: INSPECTOR_SENTINEL,
      }),
    );
    stream.applyEvent(
      event("tool_result", {
        toolCallId: "tool-1",
        toolName: TOOL_ACTIVITY_SENTINEL,
        result: STDOUT_STDERR_SENTINEL,
      }),
    );
    stream.applyEvent(
      event("queue_change", { size: 2, text: INSPECTOR_SENTINEL }),
    );
    stream.applyEvent(event("usage", { usage: { totalTokens: 900 } }));
    timer.fireAll();

    expect(updates.length).toBeGreaterThan(1);
    for (const update of updates) {
      const details = update.details as PiDelegationCardDetails;
      expect((update.content[0] as { text: string }).text).toBe("…");
      expect(details.kind).toBe("weave-delegation-card");
      assertContentFreeCardFacts(details.facts);
      expect(JSON.stringify(details)).not.toContain(RAW_REASONING_SENTINEL);
    }
    expect(stream.facts().telemetry.tokens).toBe("900 tok");
    expect(stream.facts().run.phase).toBe("steered");
    stream.dispose();
  });

  it("clears the card registry before the final frame and cannot replay reasoning", () => {
    const registry = createPiLiveReasoningRegistry();
    const projector = new PiLiveReasoningProjector({
      childId: "child-1",
      generationId: "generation-1",
      registry,
      registryKey: "tool-call-1",
    });
    const timer = new ScriptedTimerPort();
    const updates: PiToolResult[] = [];
    const stream = new PiDelegationCardStream({
      ...config(),
      onUpdate: (update) => updates.push(update),
      timerPort: timer,
      liveReasoningProjector: projector,
    });
    stream.start();
    projector
      .apply({
        childId: "child-1",
        generationId: "generation-1",
        lifecycleEpoch: 1,
        phase: "start",
        contentIndex: 0,
        text: "",
      })
      ._unsafeUnwrap();
    projector
      .apply({
        childId: "child-1",
        generationId: "generation-1",
        lifecycleEpoch: 1,
        phase: "delta",
        contentIndex: 0,
        text: RAW_REASONING_SENTINEL,
      })
      ._unsafeUnwrap();
    expect(registry.size()).toBe(1);
    expect(registry.retainedBytes()).toBeGreaterThan(0);

    const settled = stream.settle({
      outcome: "completed",
      assistantOutput: LIVE_ASSISTANT_SENTINEL,
      completionCandidate: RAW_REASONING_SENTINEL,
    });
    expect(settled?.facts.terminal?.headline).toBe(CARD_COMPLETED_RECORD);
    expect(registry.size()).toBe(0);
    expect(registry.retainedBytes()).toBe(0);
    expect(JSON.stringify(settled)).not.toContain(RAW_REASONING_SENTINEL);
    expect(JSON.stringify(settled)).not.toContain(LIVE_ASSISTANT_SENTINEL);
    const finalUpdate = updates.at(-1);
    expect(finalUpdate?.content[0]?.text).toBe("…");
    expect(rendered(settled?.facts as PiDelegationCardFacts)).not.toContain(
      RAW_REASONING_SENTINEL,
    );
    stream.dispose();
    expect(registry.size()).toBe(0);
    expect(registry.retainedBytes()).toBe(0);
  });

  it("preserves one authoritative settlement and ignores late or duplicate frames", () => {
    const timer = new ScriptedTimerPort();
    const updates: PiToolResult[] = [];
    const stream = new PiDelegationCardStream({
      ...config(),
      onUpdate: (update) => updates.push(update),
      timerPort: timer,
    });
    stream.start();
    const before = updates.length;
    const first = stream.settle({
      outcome: "completed",
      assistantOutput: LIVE_ASSISTANT_SENTINEL,
    });
    expect(updates.length).toBe(before + 1);
    const count = updates.length;
    const duplicate = stream.settle({
      outcome: "failed",
      reason: STDOUT_STDERR_SENTINEL,
    });
    stream.applyEvent(textDelta("late"));
    timer.fireAll();
    expect(updates.length).toBe(count);
    expect(JSON.stringify(duplicate)).toBe(JSON.stringify(first));
    expect(first?.facts.terminal?.headline).toBe(CARD_COMPLETED_RECORD);
    expect(JSON.stringify(first)).not.toContain(LIVE_ASSISTANT_SENTINEL);
    stream.dispose();
  });

  it("reopens only for a newer run and keeps both runs content-free", () => {
    const timer = new ScriptedTimerPort();
    const stream = new PiDelegationCardStream({
      ...config(),
      timerPort: timer,
    });
    stream.start();
    stream.settle({ outcome: "failed", reason: TOOL_ACTIVITY_SENTINEL });
    const frozen = stream.facts();
    expect(frozen.terminal?.outcome).toBe("failed");
    assertContentFreeCardFacts(frozen);

    stream.startRun({ runNumber: 1, action: "retry" });
    expect(stream.facts().settled).toBe(true);
    stream.startRun({ runNumber: 2, action: "retry" });
    expect(stream.facts().settled).toBe(false);
    expect(stream.facts().run.number).toBe(2);
    assertContentFreeCardFacts(stream.facts());
    stream.applyEvent(textDelta(LIVE_ASSISTANT_SENTINEL));
    timer.fireAll();
    assertContentFreeCardFacts(stream.facts());
    stream.dispose();
  });
});

describe("PiChildCardProjection durable card boundary", () => {
  it("drops assistant, generic reasoning, tool, queue, and inspector activity", () => {
    const projection = new PiChildCardProjection(config());
    const inputs = [
      textDelta(LIVE_ASSISTANT_SENTINEL),
      event("thinking", { text: RAW_REASONING_SENTINEL }),
      event("reasoning_summary", { text: RAW_REASONING_SENTINEL }),
      event("tool_call", {
        toolCallId: "tool-1",
        toolName: TOOL_ACTIVITY_SENTINEL,
      }),
      event("tool_partial_result", {
        toolCallId: "tool-1",
        partialResult: STDOUT_STDERR_SENTINEL,
      }),
      event("tool_error", {
        toolCallId: "tool-1",
        error: STDOUT_STDERR_SENTINEL,
      }),
      event("queue_change", { size: 1 }),
    ];
    for (const input of inputs) {
      projection.applySessionEvent(input);
      assertContentFreeCardFacts(projection.facts());
    }
  });

  it("keeps fixed terminal framing without adding a child-authored row", () => {
    const projection = new PiChildCardProjection(config());
    projection.applySessionEvent(textDelta(LIVE_ASSISTANT_SENTINEL));
    const completed = projection.settle({
      outcome: "completed",
      assistantOutput: LIVE_ASSISTANT_SENTINEL,
    });
    expect(completed.terminal).toEqual({
      outcome: "completed",
      verdict: "COMPLETED",
      glyph: "✓",
      headline: CARD_COMPLETED_RECORD,
      evidence: "authoritative settlement",
    });
    assertContentFreeCardFacts(completed);
    expect(rendered(completed)).not.toContain(LIVE_ASSISTANT_SENTINEL);
    expect(rendered(completed, true)).not.toContain(LIVE_ASSISTANT_SENTINEL);

    const cancelled = new PiChildCardProjection(config()).settle({
      outcome: "cancelled",
    });
    expect(cancelled.terminal?.headline).toBe(CARD_CANCELLED_RECORD);
    assertContentFreeCardFacts(cancelled);
  });

  it("freezes a prior run as a content-free visual record", () => {
    const projection = new PiChildCardProjection(config());
    projection.applySessionEvent(textDelta(LIVE_ASSISTANT_SENTINEL));
    projection.settle({ outcome: "failed", reason: TOOL_ACTIVITY_SENTINEL });
    projection.startRun({ runNumber: 2, action: "retry" });
    const prior = projection.frozenRunFacts(1);
    expect(prior).toBeDefined();
    assertContentFreeCardFacts(prior as PiDelegationCardFacts);
    assertContentFreeCardFacts(projection.facts());
  });
});

describe("persisted card replay", () => {
  it("replays the bounded final details byte-identically", () => {
    const stream = new PiDelegationCardStream({
      ...config({ now: () => 9_000 }),
      timerPort: new ScriptedTimerPort(),
    });
    stream.start();
    stream.applyEvent(textDelta(LIVE_ASSISTANT_SENTINEL));
    stream.applyEvent(event("tool_call", { toolName: TOOL_ACTIVITY_SENTINEL }));
    const finalDetails = stream.settle({
      outcome: "completed",
      assistantOutput: LIVE_ASSISTANT_SENTINEL,
    });
    stream.dispose();

    const bounded = boundDelegationCardDetails(
      finalDetails?.facts as PiDelegationCardFacts,
    );
    expect(JSON.stringify(bounded)).toBe(JSON.stringify(finalDetails));
    const parsed = parseDelegationCardDetails(
      JSON.parse(JSON.stringify(finalDetails)),
    );
    expect(parsed.isOk()).toBe(true);
    assertContentFreeCardFacts(parsed._unsafeUnwrap().facts);
  });
});
