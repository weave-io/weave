import { describe, expect, it } from "bun:test";
import { err, ok, okAsync, type Result, ResultAsync } from "neverthrow";
import {
  bytesToHex,
  WebCryptoHmacPort,
  WebCryptoRandomPort,
} from "../child-crypto.js";
import {
  WEAVE_CHILD_ID_ENV,
  WEAVE_CHILD_SECRET_ENV,
  WEAVE_CONTROLLER_GENERATION_ENV,
} from "../child-env.js";
import { verifyEnvelope } from "../child-envelope.js";
import {
  type PiChildOutputError,
  type PiChildOutputPort,
  type PiChildOutputWrite,
  PiChildRuntime,
} from "../child-runtime.js";
import type { TimerHandle, TimerPort } from "../child-timer.js";
import type { JsonValue } from "../strict-json.js";
import type { PiEnvPort } from "../types.js";

const randomPort = new WebCryptoRandomPort();
const hmacPort = new WebCryptoHmacPort();

class FakeEnvPort implements PiEnvPort {
  constructor(private readonly values: Map<string, string>) {}

  read(name: string): string | undefined {
    return this.values.get(name);
  }

  deleteValue(name: string): void {
    this.values.delete(name);
  }
}

class FakeClock implements TimerPort {
  private nowMs = 0;
  private nextOrder = 0;
  private readonly entries: {
    readonly callback: () => void;
    readonly delayMs: number;
    readonly dueMs: number;
    readonly order: number;
    cancelled: boolean;
    fired: boolean;
  }[] = [];

  schedule(callback: () => void, delayMs: number): TimerHandle {
    const entry = {
      callback,
      delayMs,
      dueMs: this.nowMs + delayMs,
      order: this.nextOrder,
      cancelled: false,
      fired: false,
    };
    this.nextOrder += 1;
    this.entries.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  }

  advanceBy(delayMs: number): void {
    if (delayMs < 0) throw new Error("fake clock cannot move backwards");
    this.nowMs += delayMs;
    for (;;) {
      const entry = this.entries
        .filter(
          (candidate) =>
            !candidate.cancelled &&
            !candidate.fired &&
            candidate.dueMs <= this.nowMs,
        )
        .sort(
          (left, right) => left.dueMs - right.dueMs || left.order - right.order,
        )[0];
      if (entry === undefined) return;
      entry.fired = true;
      entry.callback();
    }
  }

  pending(): readonly (typeof this.entries)[number][] {
    return this.entries.filter((entry) => !entry.cancelled && !entry.fired);
  }

  all(): readonly (typeof this.entries)[number][] {
    return this.entries;
  }
}

type DeferredWrite = {
  readonly envelope: Record<string, unknown>;
  readonly commit: () => void;
  readonly settle: (result: Result<void, PiChildOutputError>) => void;
};

class DeferredOutputPort implements PiChildOutputPort {
  readonly lines: Record<string, unknown>[] = [];
  readonly deferred: DeferredWrite[] = [];
  writeAttempts = 0;
  cancelCalls = 0;
  lateCallbacks = 0;
  private deferredControlWrites = 0;

  constructor(readonly commitModelTransitions = false) {}

  deferNextControlWrite(): void {
    this.deferredControlWrites += 1;
  }

  commitNext(): void {
    const deferred = this.deferred[0];
    if (deferred === undefined) throw new Error("no deferred write pending");
    deferred.commit();
  }

  writeLine(bytes: Uint8Array): PiChildOutputWrite {
    this.writeAttempts += 1;
    const envelope = JSON.parse(new TextDecoder().decode(bytes)) as Record<
      string,
      unknown
    >;
    const shouldDefer =
      envelope.kind === "model-transition" || this.deferredControlWrites > 0;
    if (!shouldDefer) {
      this.lines.push(envelope);
      return { result: okAsync(undefined), cancel: () => "committed" };
    }
    if (envelope.kind !== "model-transition") this.deferredControlWrites -= 1;

    let settled = false;
    let ownership: "pending" | "cancelled" | "committed" = "pending";
    let cancellationObserved = false;
    let settle!: (result: Result<void, PiChildOutputError>) => void;
    const pending = new Promise<Result<void, PiChildOutputError>>((resolve) => {
      settle = resolve;
    });
    const commit = (): void => {
      if (ownership !== "pending") return;
      ownership = "committed";
      this.lines.push(envelope);
    };
    const cancel = (): "cancelled" | "committed" => {
      if (!cancellationObserved) {
        cancellationObserved = true;
        this.cancelCalls += 1;
      }
      if (ownership === "committed") {
        if (!settled) {
          settled = true;
          settle(
            err({
              type: "ChildOutputWriteCancelled",
              reason: "output-write-cancelled",
            }),
          );
        }
        return "committed";
      }
      if (ownership === "cancelled") return "cancelled";
      ownership = "cancelled";
      settled = true;
      settle(
        err({
          type: "ChildOutputWriteCancelled",
          reason: "output-write-cancelled",
        }),
      );
      return "cancelled";
    };
    this.deferred.push({
      envelope,
      commit,
      settle: (result) => {
        if (settled) {
          this.lateCallbacks += 1;
          return;
        }
        settled = true;
        if (result.isOk()) commit();
        else if (ownership === "pending") ownership = "cancelled";
        settle(result);
      },
    });
    if (this.commitModelTransitions) commit();
    return { result: new ResultAsync(pending), cancel };
  }

  settleNext(outcome: "resolve" | "reject"): void {
    const deferred = this.deferred.shift();
    if (deferred === undefined) throw new Error("no deferred write pending");
    deferred.settle(
      outcome === "resolve"
        ? ok(undefined)
        : err({
            type: "ChildOutputWriteFailed",
            reason: "late-output-write-failure",
          }),
    );
  }
}

function noopLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function appliedTransition() {
  return {
    schemaVersion: 1 as const,
    transitionId: "123e4567-e89b-42d3-a456-426614174000",
    failureClass: "provider_unavailable" as const,
    from: { provider: "origin", id: "model-a", name: "Origin" },
    to: { provider: "fallback", id: "model-b", name: "Fallback" },
    phase: "applied" as const,
  };
}

async function buildRuntime(
  generationId = "gen-1",
  output = new DeferredOutputPort(),
  clock = new FakeClock(),
) {
  const secretBytes = randomPort.randomBytes(32);
  const env = new FakeEnvPort(
    new Map([
      [WEAVE_CHILD_SECRET_ENV, bytesToHex(secretBytes)],
      [WEAVE_CHILD_ID_ENV, "child-1"],
      [WEAVE_CONTROLLER_GENERATION_ENV, generationId],
    ]),
  );
  const runtime = new PiChildRuntime({
    envPort: env,
    randomPort,
    hmacPort,
    outputPort: output,
    logger: noopLogger(),
    timerPort: clock,
  });
  const started = await runtime.start();
  expect(started.isOk()).toBe(true);
  return { runtime, output, clock, secretBytes, generationId };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

async function waitForDeferred(
  output: DeferredOutputPort,
  expected = 1,
): Promise<void> {
  for (
    let index = 0;
    index < 20 && output.deferred.length < expected;
    index += 1
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  expect(output.deferred.length).toBeGreaterThanOrEqual(expected);
}

async function verifyLines(
  lines: readonly Record<string, unknown>[],
  secretBytes: Uint8Array,
  expectedGenerationId: string,
): Promise<void> {
  let expectedSequence = 1;
  for (const line of lines) {
    const verified = await verifyEnvelope(
      line as unknown as JsonValue,
      secretBytes,
      hmacPort,
    );
    expect(verified.isOk()).toBe(true);
    const envelope = verified._unsafeUnwrap();
    expect(envelope.childId).toBe("child-1");
    expect(envelope.generationId).toBe(expectedGenerationId);
    expect(envelope.direction).toBe("child-to-parent");
    expect(envelope.sequence).toBe(expectedSequence);
    expectedSequence += 1;
  }
}

describe("PiChildRuntime model-transition transport lane", () => {
  it("cancels a hung transition and writes the terminal at the next valid sequence", async () => {
    const { runtime, output, clock, secretBytes, generationId } =
      await buildRuntime();
    const transition = runtime.reportModelTransition(appliedTransition());
    await waitForDeferred(output);

    // The terminal request arrives while the transition owns the lane. It
    // must wait for the runtime-owned deadline, not retain the old promise.
    const terminal = runtime.reportSettled("failed", { reason: "hung" });
    expect(output.lines.filter((line) => line.kind === "settled")).toHaveLength(
      0,
    );

    clock.advanceBy(4_999);
    await flushMicrotasks();
    expect(output.lines.filter((line) => line.kind === "settled")).toHaveLength(
      0,
    );

    clock.advanceBy(1);
    await flushMicrotasks();
    expect((await transition).isErr()).toBe(true);
    expect((await terminal).isOk()).toBe(true);
    expect(output.lines.map((line) => line.kind)).toEqual([
      "handshake",
      "settled",
    ]);
    expect(output.lines.map((line) => line.sequence)).toEqual([1, 2]);
    expect(output.lines.some((line) => line.kind === "model-transition")).toBe(
      false,
    );
    expect(output.cancelCalls).toBe(1);
    expect(clock.pending()).toHaveLength(0);
    await verifyLines(output.lines, secretBytes, generationId);

    // The deferred transition was cancelled, then its host callback was left
    // pending to prove that it cannot append after the terminal envelope.
    expect(output.deferred).toHaveLength(1);
    const streamBeforeLateCallback = structuredClone(output.lines);
    output.settleNext("resolve");
    await flushMicrotasks();
    expect(output.lines).toEqual(streamBeforeLateCallback);
    expect(output.lateCallbacks).toBe(1);
    runtime.dispose();
  });

  it("keeps a delayed transition ahead of a terminal write and cleans its timer", async () => {
    const { runtime, output, clock, secretBytes, generationId } =
      await buildRuntime();
    const transition = runtime.reportModelTransition(appliedTransition());
    await waitForDeferred(output);
    const terminal = runtime.reportSettled("completed", {});

    output.settleNext("resolve");
    await flushMicrotasks();
    expect((await transition).isOk()).toBe(true);
    expect((await terminal).isOk()).toBe(true);
    expect(output.lines.map((line) => line.kind)).toEqual([
      "handshake",
      "model-transition",
      "settled",
    ]);
    expect(output.lines.map((line) => line.sequence)).toEqual([1, 2, 3]);
    expect(output.cancelCalls).toBe(0);
    expect(clock.pending()).toHaveLength(0);
    await verifyLines(output.lines, secretBytes, generationId);
  });

  it("ignores late resolve and reject callbacks after repeated transition timeouts", async () => {
    const { runtime, output, clock } = await buildRuntime();
    const first = runtime.reportModelTransition(appliedTransition());
    await waitForDeferred(output);
    clock.advanceBy(5_000);
    // Start the next attempt before the first ResultAsync's mapErr callback
    // gets a chance to run. The attempt token must keep the first completion
    // from clearing the second attempt's in-flight authority.
    const second = runtime.reportModelTransition(appliedTransition());
    await waitForDeferred(output, 2);
    expect((await first).isErr()).toBe(true);
    expect(clock.pending()).toHaveLength(1);
    clock.advanceBy(5_000);
    await flushMicrotasks();
    expect((await second).isErr()).toBe(true);
    expect(clock.pending()).toHaveLength(0);

    const terminal = runtime.reportSettled("failed", { reason: "repeated" });
    await flushMicrotasks();
    expect((await terminal).isOk()).toBe(true);
    expect(output.lines.map((line) => line.kind)).toEqual([
      "handshake",
      "settled",
    ]);
    expect(output.lines.map((line) => line.sequence)).toEqual([1, 2]);
    expect(output.cancelCalls).toBe(2);

    // Neither stale callback can mutate the transition cursor or produce a
    // second terminal result. The first callback rejects; the second resolves
    // after the terminal write has already completed.
    const streamBeforeLateCallbacks = structuredClone(output.lines);
    output.settleNext("reject");
    output.settleNext("resolve");
    await flushMicrotasks();
    expect(output.lines).toEqual(streamBeforeLateCallbacks);
    expect(output.lateCallbacks).toBe(2);
    expect(output.lines.map((line) => line.kind)).toEqual([
      "handshake",
      "settled",
    ]);
    expect(output.lines.map((line) => line.sequence)).toEqual([1, 2]);
    expect((await runtime.reportSettled("completed", {})).isErr()).toBe(true);
    expect(
      (await runtime.reportModelTransition(appliedTransition())).isErr(),
    ).toBe(true);
    expect(clock.pending()).toHaveLength(0);
  });

  it("keeps a committed timed-out write's sequence out of terminal reuse", async () => {
    const output = new DeferredOutputPort(true);
    const { runtime, clock, secretBytes } = await buildRuntime(
      "gen-committed",
      output,
      new FakeClock(),
    );
    const transition = runtime.reportModelTransition(appliedTransition());
    await waitForDeferred(output);
    expect(output.lines.map((line) => line.kind)).toEqual([
      "handshake",
      "model-transition",
    ]);

    const terminal = runtime.reportSettled("failed", { reason: "flush" });
    clock.advanceBy(5_000);
    await flushMicrotasks();
    expect((await transition).isErr()).toBe(true);
    expect((await terminal).isOk()).toBe(true);
    expect(output.lines.map((line) => line.kind)).toEqual([
      "handshake",
      "model-transition",
      "settled",
    ]);
    expect(output.lines.map((line) => line.sequence)).toEqual([1, 2, 3]);
    expect(output.cancelCalls).toBe(1);

    const streamBeforeLateCallback = structuredClone(output.lines);
    output.settleNext("resolve");
    await flushMicrotasks();
    expect(output.lines).toEqual(streamBeforeLateCallback);
    expect(output.lateCallbacks).toBe(1);
    expect(clock.pending()).toHaveLength(0);
    await verifyLines(output.lines, secretBytes, "gen-committed");
  });

  it("keeps an immediately committed write's sequence at the timeout boundary without flushed reactions", async () => {
    const output = new DeferredOutputPort();
    const { runtime, clock, secretBytes } = await buildRuntime(
      "gen-atomic-boundary",
      output,
      new FakeClock(),
    );
    const transition = runtime.reportModelTransition(appliedTransition());
    await waitForDeferred(output);
    const terminal = runtime.reportSettled("failed", { reason: "boundary" });

    // Commit the bytes synchronously, then fire the deadline before any
    // promise reaction from the output operation is allowed to run. The
    // cancellation result, not a stale snapshot, owns the sequence decision.
    output.commitNext();
    clock.advanceBy(5_000);
    await flushMicrotasks();

    expect((await transition).isErr()).toBe(true);
    expect((await terminal).isOk()).toBe(true);
    expect(output.lines.map((line) => `${line.kind}:${line.sequence}`)).toEqual(
      ["handshake:1", "model-transition:2", "settled:3"],
    );
    expect(output.cancelCalls).toBe(1);
    expect(clock.pending()).toHaveLength(0);

    const streamBeforeLateCallback = structuredClone(output.lines);
    output.settleNext("resolve");
    await flushMicrotasks();
    expect(output.lines).toEqual(streamBeforeLateCallback);
    expect(output.lateCallbacks).toBe(1);
    await verifyLines(output.lines, secretBytes, "gen-atomic-boundary");
  });

  it("waits for a deferred prior control write before arming or bypassing the transition lane", async () => {
    const output = new DeferredOutputPort();
    const { runtime, clock, secretBytes } = await buildRuntime(
      "gen-prior-lane",
      output,
      new FakeClock(),
    );
    output.deferNextControlWrite();
    const prior = runtime.reportBootstrapAck({});
    await waitForDeferred(output);

    const transition = runtime.reportModelTransition(appliedTransition());
    await flushMicrotasks();
    expect(clock.pending()).toHaveLength(0);
    expect(output.deferred).toHaveLength(1);

    const terminal = runtime.reportSettled("completed", {});
    clock.advanceBy(5_000);
    await flushMicrotasks();
    // The transition has no deadline while it is queued. Terminal output also
    // remains behind the prior operation; a transition timeout never grants
    // authority to bypass that unrelated write.
    expect(output.lines.map((line) => line.kind)).toEqual(["handshake"]);
    expect(clock.pending()).toHaveLength(0);

    output.settleNext("resolve");
    await waitForDeferred(output);
    await flushMicrotasks();
    expect((await prior).isOk()).toBe(true);
    expect(output.lines.map((line) => line.kind)).toEqual([
      "handshake",
      "bootstrap-ack",
    ]);
    expect(output.deferred).toHaveLength(1);
    expect(clock.pending()).toHaveLength(1);

    output.settleNext("resolve");
    await flushMicrotasks();
    expect((await transition).isOk()).toBe(true);
    expect((await terminal).isOk()).toBe(true);
    expect(output.lines.map((line) => `${line.kind}:${line.sequence}`)).toEqual(
      ["handshake:1", "bootstrap-ack:2", "model-transition:3", "settled:4"],
    );
    expect(output.deferred).toHaveLength(0);
    expect(clock.pending()).toHaveLength(0);
    const streamAfterTerminal = structuredClone(output.lines);
    await flushMicrotasks();
    expect(output.lines).toEqual(streamAfterTerminal);
    await verifyLines(output.lines, secretBytes, "gen-prior-lane");
  });

  it("wins the timeout boundary with a normal transition completion", async () => {
    const { runtime, output, clock, secretBytes, generationId } =
      await buildRuntime();
    const transition = runtime.reportModelTransition(appliedTransition());
    await waitForDeferred(output);
    const terminal = runtime.reportSettled("completed", {});

    // The write completes at the deadline boundary before the timer callback
    // runs. The timer must already be cancelled, so timeout cannot cancel a
    // successful transition or append a second terminal envelope.
    output.settleNext("resolve");
    await flushMicrotasks();
    clock.advanceBy(5_000);
    await flushMicrotasks();
    expect((await transition).isOk()).toBe(true);
    expect((await terminal).isOk()).toBe(true);
    expect(output.lines.map((line) => line.kind)).toEqual([
      "handshake",
      "model-transition",
      "settled",
    ]);
    expect(output.lines.map((line) => line.sequence)).toEqual([1, 2, 3]);
    expect(output.cancelCalls).toBe(0);
    expect(clock.pending()).toHaveLength(0);
    await verifyLines(output.lines, secretBytes, generationId);
  });

  it("gives authenticated cancellation precedence and clears the transition deadline", async () => {
    const { runtime, output, clock, secretBytes } = await buildRuntime();
    const transition = runtime.reportModelTransition(appliedTransition());
    await waitForDeferred(output);

    const cancel = runtime.reportCancelled();
    await flushMicrotasks();
    expect((await transition).isErr()).toBe(true);
    expect((await cancel).isOk()).toBe(true);
    expect(output.lines.map((line) => line.kind)).toEqual([
      "handshake",
      "cancelled",
    ]);
    expect(output.lines.map((line) => line.sequence)).toEqual([1, 2]);
    expect(output.cancelCalls).toBe(1);
    expect(clock.pending()).toHaveLength(0);

    const streamBeforeLateCallback = structuredClone(output.lines);
    output.settleNext("reject");
    await flushMicrotasks();
    expect(output.lines).toEqual(streamBeforeLateCallback);
    expect(output.lateCallbacks).toBe(1);
    expect((await runtime.reportSettled("completed", {})).isErr()).toBe(true);
    expect((await runtime.reportCancelled()).isErr()).toBe(true);
    await verifyLines(output.lines, secretBytes, "gen-1");
  });

  it("does not replay an old-generation transition on a shared replacement stream", async () => {
    const output = new DeferredOutputPort();
    const old = await buildRuntime("gen-old", output, new FakeClock());
    const transition = old.runtime.reportModelTransition(appliedTransition());
    await waitForDeferred(output);
    old.runtime.dispose();
    await flushMicrotasks();
    expect((await transition).isErr()).toBe(true);
    expect(old.clock.pending()).toHaveLength(0);

    const next = await buildRuntime("gen-next", output, new FakeClock());
    expect((await next.runtime.reportSettled("completed", {})).isOk()).toBe(
      true,
    );
    const streamBeforeLateCallback = structuredClone(output.lines);

    // Resolve the old host callback only after the replacement generation has
    // completed on the same byte stream.
    output.settleNext("resolve");
    await flushMicrotasks();
    expect(output.lines).toEqual(streamBeforeLateCallback);
    expect(output.lateCallbacks).toBe(1);
    expect(output.lines.map((line) => line.kind)).toEqual([
      "handshake",
      "handshake",
      "settled",
    ]);
    expect(
      output.lines.some(
        (line) =>
          line.kind === "model-transition" && line.generationId === "gen-old",
      ),
    ).toBe(false);
    expect(output.lines.map((line) => line.sequence)).toEqual([1, 1, 2]);
    await verifyLines(
      output.lines.filter((line) => line.generationId === "gen-old"),
      old.secretBytes,
      "gen-old",
    );
    await verifyLines(
      output.lines.filter((line) => line.generationId === "gen-next"),
      next.secretBytes,
      "gen-next",
    );
  });
});
