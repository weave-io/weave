import { describe, expect, it } from "bun:test";
import {
  type ChildFallbackEpoch,
  PiChildAbortSettlementGate,
  PiChildFallbackSettlementGate,
} from "../child-compaction-settlement.js";
import type { TimerHandle, TimerPort } from "../child-timer.js";

class FakeTimerPort implements TimerPort {
  readonly entries: {
    readonly callback: () => void;
    cancelled: boolean;
    fired: boolean;
    readonly delayMs: number;
  }[] = [];

  schedule(callback: () => void, delayMs: number): TimerHandle {
    const entry = { callback, cancelled: false, fired: false, delayMs };
    this.entries.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  }

  fireAll(): void {
    for (const entry of [...this.entries]) {
      if (entry.cancelled || entry.fired) continue;
      entry.fired = true;
      entry.callback();
    }
  }

  pending(): number {
    return this.entries.filter((entry) => !entry.cancelled && !entry.fired)
      .length;
  }
}

const failure = (reason: string) => ({ reason });
const compactionEpoch = { turn: 1, assistantMessageId: "failed" } as const;
const fallbackEpoch = (attempt: number): ChildFallbackEpoch => ({
  generation: 1,
  attempt,
});

function admitFallback(
  gate: PiChildFallbackSettlementGate,
  epoch: ChildFallbackEpoch,
): void {
  expect(gate.beginFallback(failure("original"), epoch)).toEqual({
    kind: "admit",
  });
  expect(gate.observeMarker(epoch)).toEqual({ kind: "admit" });
  expect(gate.observeContextRepair(epoch)).toEqual({ kind: "admit" });
}

describe("child RPC settlement epoch races", () => {
  it("keeps compaction and fallback evidence independent, then settles once", () => {
    const timer = new FakeTimerPort();
    const terminal: string[] = [];
    const compaction = new PiChildAbortSettlementGate({
      timerPort: timer,
      onExpire: (value) => terminal.push(`compaction:${value.reason}`),
      evidenceGraceMs: 10,
      resumeTimeoutMs: 20,
    });
    const fallback = new PiChildFallbackSettlementGate({
      timerPort: timer,
      onExpire: (value) => terminal.push(`fallback:${value.reason}`),
      recoveryTimeoutMs: 30,
    });

    compaction.observeAbortSettlement(failure("compaction"), compactionEpoch);
    admitFallback(fallback, fallbackEpoch(1));

    // Compaction lifecycle and its resumed turn touch only the compaction
    // epoch. They cannot admit or suppress the fallback recovery.
    compaction.observeCompactionLifecycle(compactionEpoch);
    expect(compaction.observeTurnStart()).toBe("resumed");
    expect(fallback.recovering).toBe(true);
    expect(fallback.admitSuccess(fallbackEpoch(1))).toEqual({ kind: "admit" });
    expect(terminal).toEqual([]);
    expect(timer.pending()).toBe(0);
  });

  it("does not let a bare turn_start release, suppress, or prove fallback", () => {
    const timer = new FakeTimerPort();
    const terminal: string[] = [];
    const compaction = new PiChildAbortSettlementGate({
      timerPort: timer,
      onExpire: (value) => terminal.push(value.reason),
    });
    const fallback = new PiChildFallbackSettlementGate({
      timerPort: timer,
      onExpire: (value) => terminal.push(value.reason),
    });
    const epoch = fallbackEpoch(1);

    expect(fallback.beginFallback(failure("original"), epoch)).toEqual({
      kind: "admit",
    });
    // The adapter's turn handler calls this only for compaction. Fallback has
    // no turn-start transition at all.
    compaction.observeTurnStart();
    expect(fallback.active).toBe(true);
    expect(fallback.recovering).toBe(false);
    expect(terminal).toEqual([]);
    expect(fallback.observeContextRepair(epoch)).toMatchObject({
      kind: "suppress",
    });
  });

  it("opens a new fallback epoch for a later failure without concatenating evidence", () => {
    const timer = new FakeTimerPort();
    const terminal: string[] = [];
    const fallback = new PiChildFallbackSettlementGate({
      timerPort: timer,
      onExpire: (value) => terminal.push(value.reason),
      recoveryTimeoutMs: 30,
    });
    const first = fallbackEpoch(1);
    const second = fallbackEpoch(2);

    admitFallback(fallback, first);
    expect(fallback.beginFallback(failure("later"), second)).toEqual({
      kind: "admit",
    });
    expect(fallback.observeMarker(first)).toMatchObject({ kind: "suppress" });
    expect(fallback.observeMarker(second)).toEqual({ kind: "admit" });
    expect(fallback.observeContextRepair(second)).toEqual({ kind: "admit" });
    fallback.fail(second);

    expect(terminal).toEqual(["later"]);
    expect(timer.pending()).toBe(0);
    expect(fallback.admitSuccess(second)).toEqual({ kind: "suppress" });
    fallback.fail(first);
    expect(terminal).toEqual(["later"]);
  });

  it("publishes the retained original exactly once on recovery timeout and ignores late events", () => {
    const timer = new FakeTimerPort();
    const terminal: string[] = [];
    const fallback = new PiChildFallbackSettlementGate({
      timerPort: timer,
      onExpire: (value) => terminal.push(value.reason),
      recoveryTimeoutMs: 30,
    });
    const epoch = fallbackEpoch(1);

    admitFallback(fallback, epoch);
    timer.fireAll();
    expect(terminal).toEqual(["original"]);
    expect(fallback.observeMarker(epoch)).toMatchObject({ kind: "suppress" });
    expect(fallback.observeContextRepair(epoch)).toMatchObject({
      kind: "suppress",
    });
    expect(fallback.admitSuccess(epoch)).toEqual({ kind: "suppress" });
    expect(terminal).toEqual(["original"]);
  });

  it("suppresses duplicate, ambiguous, and late fallback evidence after one epoch decision", () => {
    const timer = new FakeTimerPort();
    const terminal: string[] = [];
    const fallback = new PiChildFallbackSettlementGate({
      timerPort: timer,
      onExpire: (value) => terminal.push(value.reason),
      recoveryTimeoutMs: 30,
    });
    const epoch = fallbackEpoch(1);
    const wrongEpoch = fallbackEpoch(2);

    expect(fallback.beginFallback(failure("one-attempt"), epoch)).toEqual({
      kind: "admit",
    });
    expect(fallback.observeMarker(wrongEpoch)).toMatchObject({
      kind: "suppress",
    });
    expect(fallback.observeMarker(epoch)).toEqual({ kind: "admit" });
    expect(fallback.observeMarker(epoch)).toMatchObject({ kind: "suppress" });
    expect(fallback.observeContextRepair(wrongEpoch)).toMatchObject({
      kind: "suppress",
    });
    expect(fallback.observeContextRepair(epoch)).toEqual({ kind: "admit" });
    expect(fallback.observeContextRepair(epoch)).toMatchObject({
      kind: "suppress",
    });
    expect(fallback.admitSuccess(epoch)).toEqual({ kind: "admit" });
    expect(fallback.admitSuccess(epoch)).toMatchObject({ kind: "suppress" });
    fallback.fail(epoch);
    expect(terminal).toEqual([]);
    timer.fireAll();
    expect(terminal).toEqual([]);
    expect(timer.pending()).toBe(0);
  });

  it("closes both epochs on cancellation without publishing a failed race", () => {
    const timer = new FakeTimerPort();
    const terminal: string[] = [];
    const compaction = new PiChildAbortSettlementGate({
      timerPort: timer,
      onExpire: (value) => terminal.push(value.reason),
    });
    const fallback = new PiChildFallbackSettlementGate({
      timerPort: timer,
      onExpire: (value) => terminal.push(value.reason),
    });
    const epoch = fallbackEpoch(1);

    compaction.observeAbortSettlement(failure("compaction"), compactionEpoch);
    admitFallback(fallback, epoch);
    fallback.dispose();
    compaction.dispose();
    timer.fireAll();

    expect(terminal).toEqual([]);
    expect(timer.pending()).toBe(0);
  });
});
