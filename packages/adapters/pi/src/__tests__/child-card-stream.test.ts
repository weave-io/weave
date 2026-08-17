/**
 * The live delegation card, end to end: authoritative events in, coalesced
 * frames out, one settled record, and a replay that is byte-identical to the
 * final live frame.
 */
import { describe, expect, it } from "bun:test";
import {
  CARD_CANCELLED_RECORD,
  CARD_PROVIDER_ERROR_HEAD,
  PiChildCardProjection,
  type PiChildCardProjectionConfig,
  type PiDelegationCardFacts,
} from "../child-card-model.js";
import { renderDelegationCard } from "../child-card-render.js";
import { CHILD_ERROR_CANONICAL_MESSAGE } from "../child-provider-error.js";
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

// ---------------------------------------------------------------------------
// A timer the test drives
// ---------------------------------------------------------------------------

/**
 * Records every scheduled callback instead of reaching the host clock, so a
 * refresh window opens and closes exactly when the test says so. Nothing here
 * touches `setTimeout`; if the coalescer ever did, these counts would not add
 * up.
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

  /** Closes every window, including ones reopened by the frames it released. */
  fireAll(maxRounds = 8): void {
    for (let round = 0; round < maxRounds && this.pending.length > 0; round++) {
      this.fire();
    }
  }

  get open(): number {
    return this.pending.length;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CLOCK_STEP_MS = 25;

function scriptedClock(): () => number {
  let now = 1_000;
  return () => {
    now += CLOCK_STEP_MS;
    return now;
  };
}

function streamConfig(
  over: Partial<PiDelegationCardFactsConfig> = {},
): PiDelegationCardFactsConfig {
  return {
    threadId: "thread-opaque-1",
    agentName: "shuttle",
    assignment: "Fix the header suffix width handling.",
    runNumber: 1,
    action: "start",
    now: scriptedClock(),
    ...over,
  };
}

type PiDelegationCardFactsConfig = PiChildCardProjectionConfig;

function textDelta(delta: string, messageId = "asst-1"): PiChildSessionEvent {
  return {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta, messageId },
  } as unknown as PiChildSessionEvent;
}

function messageEnd(text: string, id = "asst-1"): PiChildSessionEvent {
  return {
    type: "message_end",
    message: {
      id,
      role: "assistant",
      content: [{ type: "text", text }],
    },
  } as unknown as PiChildSessionEvent;
}

function failedMessageEnd(errorMessage: string): PiChildSessionEvent {
  return {
    type: "message_end",
    message: {
      id: "asst-err",
      role: "assistant",
      stopReason: "error",
      errorMessage,
      // Nothing outside the anchored evidence may reach the card.
      providerBody: "acme-secret-host said too many requests",
      content: [],
    },
  } as unknown as PiChildSessionEvent;
}

function collect(): {
  readonly updates: PiToolResult[];
  readonly onUpdate: (update: PiToolResult) => void;
} {
  const updates: PiToolResult[] = [];
  return { updates, onUpdate: (update) => updates.push(update) };
}

function detailsOf(update: PiToolResult | undefined): PiDelegationCardDetails {
  return update?.details as PiDelegationCardDetails;
}

/** The exact bytes one frame would be persisted as. */
function frameBytes(facts: PiDelegationCardFacts): string {
  return JSON.stringify(boundDelegationCardDetails(facts));
}

/** The exact lines the card draws at a fixed width. */
function frameLines(facts: PiDelegationCardFacts, width = 72): string[] {
  return renderDelegationCard(facts, { width, paint: plainPaint() });
}

// ---------------------------------------------------------------------------
// The coalescer
// ---------------------------------------------------------------------------

describe("PiCardUpdateCoalescer", () => {
  it("publishes the first frame at once and coalesces the rest of the window", () => {
    const timer = new ScriptedTimerPort();
    let published = 0;
    const coalescer = new PiCardUpdateCoalescer(() => {
      published += 1;
    }, timer);

    coalescer.request("coalesced");
    expect(published).toBe(1);
    expect(timer.delays).toEqual([CARD_REFRESH_INTERVAL_MS]);

    for (let i = 0; i < 50; i += 1) coalescer.request("coalesced");
    expect(published).toBe(1);

    // Trailing flush: the frames inside the window are not lost.
    timer.fire();
    expect(published).toBe(2);

    // A window with nothing pending simply closes.
    timer.fire();
    expect(published).toBe(2);
    expect(timer.open).toBe(0);
  });

  it("publishes an immediate frame without waiting for the window", () => {
    const timer = new ScriptedTimerPort();
    let published = 0;
    const coalescer = new PiCardUpdateCoalescer(() => {
      published += 1;
    }, timer);

    coalescer.request("coalesced");
    coalescer.request("coalesced");
    coalescer.request("immediate");
    expect(published).toBe(2);

    coalescer.flush();
    expect(published).toBe(3);
    coalescer.dispose();
    coalescer.request("immediate");
    coalescer.flush();
    expect(published).toBe(3);
  });

  it("never lets a publisher failure escape", () => {
    const timer = new ScriptedTimerPort();
    const coalescer = new PiCardUpdateCoalescer(() => {
      throw new Error("host render exploded");
    }, timer);
    expect(() => coalescer.request("immediate")).not.toThrow();
    expect(() => coalescer.flush()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The ordered frame script
// ---------------------------------------------------------------------------

describe("PiDelegationCardStream", () => {
  it("drives an ordered frame script from authoritative events", () => {
    const timer = new ScriptedTimerPort();
    const sink = collect();
    const stream = new PiDelegationCardStream({
      ...streamConfig(),
      onUpdate: sink.onUpdate,
      timerPort: timer,
    });

    stream.start();
    expect(sink.updates).toHaveLength(1);
    const opening = detailsOf(sink.updates[0]);
    expect(opening.facts.agentName).toBe("shuttle");
    expect(opening.facts.run).toMatchObject({ number: 1, action: "start" });
    expect(opening.facts.settled).toBe(false);

    stream.applyEvent(textDelta("reading the renderer"));
    stream.applyEvent(textDelta(" and the tests"));
    // Both deltas fall inside the opening frame's window.
    expect(sink.updates).toHaveLength(1);
    timer.fire();
    expect(sink.updates).toHaveLength(2);
    expect(detailsOf(sink.updates[1]).facts.activity.text).toContain(
      "reading the renderer",
    );

    // A tool failure is acted on, so it never waits for the window.
    stream.applyEvent({
      type: "tool_error",
      toolCallId: "tool-1",
      toolName: "bash",
      error: "exit status 1",
    } as unknown as PiChildSessionEvent);
    expect(sink.updates).toHaveLength(3);
    expect(detailsOf(sink.updates[2]).facts.activity.kind).toBe("error");

    // So is the parent steering the child.
    stream.applyEvent({
      type: "queue_change",
      size: 2,
    } as unknown as PiChildSessionEvent);
    expect(sink.updates).toHaveLength(4);
    expect(detailsOf(sink.updates[3]).facts.activity.kind).toBe("queue");
    expect(detailsOf(sink.updates[3]).facts.activity.text).toContain(
      "2 queued",
    );

    // Usage is latest-authoritative, and a retry names its attempt.
    stream.applyEvent({
      type: "usage",
      usage: { inputTokens: 100, outputTokens: 40 },
    } as unknown as PiChildSessionEvent);
    stream.applyEvent({
      type: "usage",
      usage: { totalTokens: 900 },
    } as unknown as PiChildSessionEvent);
    stream.applyEvent({
      type: "retry",
      attempt: 3,
      reason: "provider overloaded",
    } as unknown as PiChildSessionEvent);
    stream.applyEvent({
      type: "status",
      status: "recovering",
    } as unknown as PiChildSessionEvent);
    timer.fire();
    const live = detailsOf(sink.updates[sink.updates.length - 1]).facts;
    expect(live.telemetry.tokens).toBe("900 tok");
    expect(live.run.attempt).toBe(3);
    expect(live.run.action).toBe("retry");
    expect(live.run.phase).toBe("recovering");
    expect(live.settled).toBe(false);

    const publishedBeforeSettle = sink.updates.length;
    const settled = stream.settle({
      outcome: "completed",
      assistantOutput: "header widths fixed",
      completionCandidate: "must-not-appear",
    });
    // Settlement always flushes: it can never be the coalesced frame.
    expect(sink.updates.length).toBe(publishedBeforeSettle + 1);
    expect(settled?.facts.settled).toBe(true);
    expect(settled?.facts.terminal?.verdict).toBe("COMPLETED");
    expect(JSON.stringify(settled)).not.toContain("must-not-appear");
    stream.dispose();
  });

  it("bounds updates across a 500-delta burst and lands the same final frame", () => {
    const timer = new ScriptedTimerPort();
    const sink = collect();
    const stream = new PiDelegationCardStream({
      ...streamConfig({ now: () => 5_000 }),
      onUpdate: sink.onUpdate,
      timerPort: timer,
    });
    stream.start();

    for (let i = 0; i < 500; i += 1) {
      stream.applyEvent(textDelta(` d${i}`));
      // Close a window every fiftieth delta, as a real clock would.
      if (i % 50 === 49) timer.fire();
    }
    // 1 opening frame + at most one trailing frame per closed window.
    expect(sink.updates.length).toBeLessThanOrEqual(12);
    expect(sink.updates.length).toBeGreaterThan(1);

    const coalescedFinal = stream.settle({
      outcome: "completed",
      assistantOutput: "burst complete",
    });
    stream.dispose();

    // The same script with every frame published produces the same card.
    const eager = new PiChildCardProjection(streamConfig({ now: () => 5_000 }));
    for (let i = 0; i < 500; i += 1)
      eager.applySessionEvent(textDelta(` d${i}`));
    eager.settle({ outcome: "completed", assistantOutput: "burst complete" });

    expect(frameBytes(eager.facts())).toBe(JSON.stringify(coalescedFinal));
    expect(frameLines(eager.facts())).toEqual(
      frameLines(coalescedFinal?.facts as PiDelegationCardFacts),
    );
  });

  it("ignores a repeated settlement and every event after it", () => {
    const timer = new ScriptedTimerPort();
    const sink = collect();
    const stream = new PiDelegationCardStream({
      ...streamConfig(),
      onUpdate: sink.onUpdate,
      timerPort: timer,
    });
    stream.start();
    stream.applyEvent(textDelta("working"));
    const beforeSettle = sink.updates.length;
    const first = stream.settle({
      outcome: "completed",
      assistantOutput: "the authoritative answer",
    });
    // The first settlement flushes EXACTLY one final update.
    expect(sink.updates.length).toBe(beforeSettle + 1);
    const settledUpdates = sink.updates.length;

    // A duplicate settlement, a contradicting one, and late traffic all leave
    // the authoritative record exactly as it was.
    const duplicate = stream.settle({
      outcome: "failed",
      reason: "a second settlement that must not win",
    });
    // A duplicate returns the existing details without publishing again.
    expect(sink.updates.length).toBe(settledUpdates);
    expect(JSON.stringify(duplicate)).toBe(JSON.stringify(first));

    stream.applyEvent(textDelta("late text after settlement"));
    stream.applyEvent(messageEnd("late terminal message"));
    stream.applyProviderError({
      class: "rate-limit",
      message: CHILD_ERROR_CANONICAL_MESSAGE["rate-limit"],
    });
    // Late traffic must not even SCHEDULE a repaint: firing every pending
    // timer publishes nothing.
    timer.fireAll();
    expect(sink.updates.length).toBe(settledUpdates);
    const afterLate = stream.details();

    expect(duplicate?.facts.terminal?.headline).toBe(
      "the authoritative answer",
    );
    expect(JSON.stringify(first)).toBe(JSON.stringify(afterLate));
    expect(JSON.stringify(afterLate)).not.toContain("late text");
    expect(JSON.stringify(afterLate)).not.toContain("must not win");
    // The last frame a reader saw is still the settled one.
    expect(JSON.stringify(detailsOf(sink.updates[settledUpdates - 1]))).toBe(
      JSON.stringify(first),
    );
    stream.dispose();
  });

  it("reopens the stream for a strictly newer run and ignores older ones", () => {
    const timer = new ScriptedTimerPort();
    const sink = collect();
    const stream = new PiDelegationCardStream({
      ...streamConfig(),
      onUpdate: sink.onUpdate,
      timerPort: timer,
    });
    stream.start();
    stream.settle({ outcome: "failed", reason: "retryable failure" });
    const afterSettle = sink.updates.length;

    // A run at or below the settled one is a late report: no repaint.
    stream.startRun({ runNumber: 1, action: "retry" });
    expect(sink.updates.length).toBe(afterSettle);

    // A strictly newer run reopens the card and publishes immediately.
    stream.startRun({ runNumber: 2, action: "retry" });
    expect(sink.updates.length).toBe(afterSettle + 1);
    expect(detailsOf(sink.updates[afterSettle]).facts.settled).toBe(false);

    // The reopened stream streams again.
    stream.applyEvent(textDelta("second run working"));
    timer.fireAll();
    expect(sink.updates.length).toBeGreaterThan(afterSettle + 1);
    expect(stream.facts().settled).toBe(false);

    const second = stream.settle({
      outcome: "completed",
      assistantOutput: "second run answer",
    });
    expect(second?.facts.terminal?.headline).toBe("second run answer");
    stream.dispose();
  });
});

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

describe("PiChildCardProjection", () => {
  it("correlates message ids, keeps repeated deltas, and hides raw reasoning", () => {
    const projection = new PiChildCardProjection(streamConfig());
    const start = {
      type: "message_start",
      message: { id: "asst-42", role: "assistant", content: [] },
    } as unknown as PiChildSessionEvent;
    projection.applySessionEvent(start);
    projection.applySessionEvent(textDelta("hello", "asst-42"));
    // The same delta again is the child saying the word twice. The wire gives
    // a delta no identity, so matching on its text would delete a real word.
    projection.applySessionEvent(textDelta("hello", "asst-42"));
    expect(projection.facts().activity.text).toBe("hello hello");
    // The message's own start IS identified, and its repeat is suppressed:
    // applying it again would replace the streamed answer with nothing.
    projection.applySessionEvent(start);
    expect(projection.facts().activity.text).toBe("hello hello");
    projection.applySessionEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: "secret chain of thought",
      },
    } as unknown as PiChildSessionEvent);
    const facts = projection.applySessionEvent(
      messageEnd("hello world", "asst-42"),
    );

    expect(facts.activity.text).toBe("hello world");
    expect(JSON.stringify(facts)).not.toContain("secret chain of thought");
    const messageRows = facts.viewport.rows.filter((row) => row.kind === "msg");
    expect(messageRows).toHaveLength(1);
    expect(messageRows[0]?.text).toBe("hello world");
  });

  it("freezes a prior run and refuses out-of-order run reports", () => {
    const projection = new PiChildCardProjection(streamConfig());
    projection.applySessionEvent(textDelta("first run output"));
    projection.settle({ outcome: "failed", reason: "retryable failure" });

    const retried = projection.startRun({ runNumber: 2, action: "retry" });
    expect(retried.run.number).toBe(2);
    expect(retried.settled).toBe(false);
    expect(retried.terminal).toBeUndefined();

    const frozen = projection.frozenRunFacts(1);
    expect(frozen?.terminal?.headline).toBe("retryable failure");

    const snapshot = JSON.stringify(frozen);
    expect(snapshot).toContain("first run output");
    projection.applySessionEvent(textDelta("second run output"));
    // The frozen snapshot is a record, not a live view.
    expect(JSON.stringify(projection.frozenRunFacts(1))).toBe(snapshot);
    expect(JSON.stringify(projection.frozenRunFacts(1))).not.toContain(
      "second run output",
    );
    expect(projection.facts().activity.text).toBe("second run output");

    // A late report of an already-superseded run changes nothing.
    const stale = projection.startRun({ runNumber: 1, action: "start" });
    expect(stale.run.number).toBe(2);
    expect(stale.activity.text).toBe("second run output");
  });

  it("routes a provider failure through the overlay's own canonical wording", () => {
    const projection = new PiChildCardProjection(streamConfig());
    projection.applySessionEvent(textDelta("partial work kept"));
    const facts = projection.applySessionEvent(
      failedMessageEnd("429 rate_limit_exceeded"),
    );

    const errorRow = facts.viewport.rows.find(
      (row) => row.head === CARD_PROVIDER_ERROR_HEAD,
    );
    expect(errorRow).toBeDefined();
    expect(errorRow?.text).toContain("assistant error");
    expect(errorRow?.text).toContain("rate limit");
    expect(errorRow?.text).toContain(
      CHILD_ERROR_CANONICAL_MESSAGE["rate-limit"],
    );
    // No provider prose survives the sanitized projection.
    expect(JSON.stringify(facts)).not.toContain("acme-secret-host");
    expect(JSON.stringify(facts)).not.toContain("too many requests");
    expect(facts.activity.kind).toBe("error");

    // The class it named is the only gate on the documented recovery.
    const settled = projection.settle({
      outcome: "failed",
      reason: "child reported a provider failure",
    });
    expect(settled.terminal?.evidence).toContain("rate-limit");
    expect(settled.terminal?.recovery).toContain("re-delegation");
    // Partial work is retained beside the failure.
    expect(
      settled.viewport.rows.some((row) =>
        row.text.includes("partial work kept"),
      ),
    ).toBe(true);
  });

  it("records a cancellation explicitly, keeps partial work, and verifies nothing", () => {
    const projection = new PiChildCardProjection(streamConfig());
    projection.applySessionEvent(textDelta("half-written answer"));
    projection.applySessionEvent({
      type: "tool_result",
      toolCallId: "tool-9",
      toolName: "read",
      result: "opened one file",
    } as unknown as PiChildSessionEvent);
    const facts = projection.settle({ outcome: "cancelled" });

    expect(facts.terminal?.outcome).toBe("cancelled");
    expect(facts.terminal?.verdict).toBe("CANCELLED");
    expect(facts.terminal?.headline).toBe(CARD_CANCELLED_RECORD);
    // Names the safe initiator, keeps partial work, claims nothing verified.
    expect(facts.terminal?.headline).toContain("stopped by the parent");
    expect(facts.terminal?.headline).toContain("partial work kept");
    expect(facts.terminal?.evidence).toContain("nothing verified");
    expect(facts.terminal?.evidence).not.toContain("verified ·");
    expect(facts.terminal?.recovery).toBeUndefined();
    expect(
      facts.viewport.rows.some((row) =>
        row.text.includes("half-written answer"),
      ),
    ).toBe(true);
    expect(facts.activity.kind).toBe("cancel");
    expect(facts.activity.live).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

describe("persisted card replay", () => {
  const outcomes = [
    {
      name: "completed",
      settlement: {
        outcome: "completed" as const,
        assistantOutput: "the delegated work is done",
      },
    },
    {
      name: "failed",
      settlement: {
        outcome: "failed" as const,
        reason: "the child could not finish",
      },
    },
    { name: "cancelled", settlement: { outcome: "cancelled" as const } },
  ];

  for (const outcome of outcomes) {
    it(`replays a ${outcome.name} run byte-identically from persisted details`, () => {
      const timer = new ScriptedTimerPort();
      const sink = collect();
      const stream = new PiDelegationCardStream({
        ...streamConfig({ now: () => 9_000 }),
        onUpdate: sink.onUpdate,
        timerPort: timer,
      });
      stream.start();
      stream.applyEvent(textDelta("investigating"));
      stream.applyEvent({
        type: "tool_call",
        toolCallId: "tool-1",
        toolName: "read",
      } as unknown as PiChildSessionEvent);
      stream.applyEvent({
        type: "tool_result",
        toolCallId: "tool-1",
        toolName: "read",
        result: "read 40 lines",
      } as unknown as PiChildSessionEvent);
      stream.applyEvent({
        type: "usage",
        usage: { totalTokens: 1_234, cost: { total: 0.12 } },
      } as unknown as PiChildSessionEvent);
      timer.fire();
      const finalDetails = stream.settle(outcome.settlement);
      stream.dispose();

      const liveFrame = detailsOf(sink.updates[sink.updates.length - 1]);
      expect(JSON.stringify(liveFrame)).toBe(JSON.stringify(finalDetails));

      // What Pi persists is what Pi hands back.
      const persisted = JSON.parse(
        JSON.stringify(finalDetails),
      ) as PiDelegationCardDetails;
      const parsed = parseDelegationCardDetails(persisted);
      expect(parsed.isOk()).toBe(true);
      const replayed = parsed._unsafeUnwrap().facts;

      expect(JSON.stringify(replayed)).toBe(
        JSON.stringify(finalDetails?.facts),
      );
      for (const width of [40, 72, 120]) {
        expect(frameLines(replayed, width)).toEqual(
          frameLines(finalDetails?.facts as PiDelegationCardFacts, width),
        );
      }
    });
  }
});
