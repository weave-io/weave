import { describe, expect, it } from "bun:test";
import {
  observeBoundedPromise,
  terminateBoundedProcess,
} from "../child-stream-live-proof-process-control.js";
import type {
  BoundedProcess,
  BoundedProcessLimits,
} from "../child-stream-live-proof-system-contract.js";

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

const limits: BoundedProcessLimits = {
  spawnMs: 10,
  firstOutputMs: 10,
  totalReadMs: 20,
  gracefulTermMs: 10,
  postKillMs: 10,
  cleanupMs: 20,
  maxCaptureBytes: 1024,
};

describe("bounded process promise observation", () => {
  it.each([
    0,
    -1,
    Number.NaN,
  ])("observes a promise after an immediate timeout (%d)", async (timeoutMs) => {
    let settle: ((value: number) => void) | undefined;
    const late = new Promise<number>((resolve) => {
      settle = resolve;
    });

    const outcome = await observeBoundedPromise(late, timeoutMs);
    expect(outcome).toEqual({ kind: "timeout" });

    settle?.(42);
    await sleep(20);
  });

  it.each([
    0, -1,
  ])("observes a late rejection after an immediate timeout (%d)", async (timeoutMs) => {
    let rejectLate: ((reason: Error) => void) | undefined;
    const late = new Promise<number>((_, reject) => {
      rejectLate = reject;
    });

    const outcome = await observeBoundedPromise(late, timeoutMs);
    expect(outcome).toEqual({ kind: "timeout" });

    rejectLate?.(new Error("late rejection"));
    await sleep(20);
  });
});

describe("bounded process termination", () => {
  it("observes a settled exit promise on the zero-timeout probe", async () => {
    const signals: string[] = [];
    const process: BoundedProcess = {
      stdout: new ReadableStream<Uint8Array<ArrayBuffer>>(),
      stderr: new ReadableStream<Uint8Array<ArrayBuffer>>(),
      exited: Promise.resolve(0),
      exitCode: null,
      signalCode: null,
      kill: (signal) => {
        signals.push(signal);
      },
    };

    const terminated = await terminateBoundedProcess(process, limits);

    expect(terminated).toBe(true);
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("bounds kill rejection, kill hangs, and an exit that never resolves", async () => {
    const signals: string[] = [];
    const process: BoundedProcess = {
      stdout: new ReadableStream<Uint8Array<ArrayBuffer>>(),
      stderr: new ReadableStream<Uint8Array<ArrayBuffer>>(),
      exited: new Promise<number>(() => undefined),
      exitCode: null,
      signalCode: null,
      kill: (signal) => {
        signals.push(signal);
        if (signal === "SIGTERM") {
          return Promise.reject(new Error("TERM failed"));
        }
        return new Promise<void>(() => undefined);
      },
    };

    const started = Date.now();
    const terminated = await terminateBoundedProcess(process, limits);

    expect(terminated).toBe(false);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("does not signal a process that already reports an exit", async () => {
    const signals: string[] = [];
    const process: BoundedProcess = {
      exited: Promise.resolve(0),
      exitCode: 0,
      signalCode: null,
      kill: (signal) => {
        signals.push(signal);
      },
    };

    expect(await terminateBoundedProcess(process, limits)).toBe(true);
    expect(signals).toEqual([]);
  });
});
