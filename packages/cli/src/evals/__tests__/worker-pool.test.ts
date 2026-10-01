/**
 * Tests for `evals/worker-pool.ts` — the bounded pool `weave eval run
 * --concurrency` runs independent units of work through.
 *
 * The work is stubbed: each item is a deferred the test settles by hand, so
 * the order things finish in is chosen by the test, never by timers.
 */

import { describe, expect, it } from "bun:test";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { WorkerPool } from "../worker-pool.js";

/** A promise the test resolves from outside. */
class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (cause: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

/** Let every queued microtask and resolved promise run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

type Failure = { type: "Failed"; item: string } | { type: "Defect" };

/** Work whose outcome per item the test decides, recording what started. */
class ManualWork {
  readonly started: string[] = [];
  readonly gates = new Map<string, Deferred<Result<string, Failure>>>();
  inFlight = 0;
  maxInFlight = 0;

  run = (item: string): ResultAsync<string, Failure> => {
    this.started.push(item);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const gate = new Deferred<Result<string, Failure>>();
    this.gates.set(item, gate);
    return new ResultAsync(
      gate.promise.finally(() => {
        this.inFlight -= 1;
      }),
    );
  };

  finish(item: string, result: Result<string, Failure> = ok(item)): void {
    const gate = this.gates.get(item);
    if (gate === undefined) throw new Error(`${item} has not started`);
    gate.resolve(result);
  }
}

const defect = (): Failure => ({ type: "Defect" });

describe("WorkerPool", () => {
  it("returns results in the order of the items, not the order they finished", async () => {
    const work = new ManualWork();
    const pool = new WorkerPool(3);
    const done = pool.run(["a", "b", "c"], work.run, defect);
    await settle();

    work.finish("c");
    await settle();
    work.finish("a");
    await settle();
    work.finish("b");

    const results = await done;
    expect(results.map((r) => r._unsafeUnwrap())).toEqual(["a", "b", "c"]);
  });

  it("never runs more items at once than its concurrency", async () => {
    const work = new ManualWork();
    const pool = new WorkerPool(2);
    const items = ["a", "b", "c", "d", "e"];
    const done = pool.run(items, work.run, defect);
    await settle();

    expect(work.started).toEqual(["a", "b"]);
    work.finish("b");
    await settle();
    expect(work.started).toEqual(["a", "b", "c"]);
    for (const item of ["a", "c", "d", "e"]) {
      work.finish(item);
      await settle();
    }

    await done;
    expect(work.maxInFlight).toBe(2);
    expect(work.started).toEqual(items);
  });

  it("starts items in their order, so a concurrency of 1 runs them one after another", async () => {
    const work = new ManualWork();
    const pool = new WorkerPool(1);
    const done = pool.run(["a", "b", "c"], work.run, defect);

    for (const item of ["a", "b", "c"]) {
      await settle();
      expect(work.started.at(-1)).toBe(item);
      expect(work.inFlight).toBe(1);
      work.finish(item);
    }

    await done;
    expect(work.maxInFlight).toBe(1);
  });

  it("keeps running the other items when one fails", async () => {
    const work = new ManualWork();
    const pool = new WorkerPool(2);
    const done = pool.run(["a", "b", "c"], work.run, defect);
    await settle();

    work.finish("a", err({ type: "Failed", item: "a" }));
    await settle();
    work.finish("b");
    await settle();
    work.finish("c");

    const results = await done;
    expect(results[0]?._unsafeUnwrapErr()).toEqual({
      type: "Failed",
      item: "a",
    });
    expect(results[1]?._unsafeUnwrap()).toBe("b");
    expect(results[2]?._unsafeUnwrap()).toBe("c");
  });

  it("turns work that throws or rejects into that item's error, and keeps going", async () => {
    const pool = new WorkerPool(2);
    const results = await pool.run(
      ["throws", "rejects", "fine"],
      (item) => {
        if (item === "throws") throw new Error("boom");
        if (item === "rejects") {
          return new ResultAsync<string, Failure>(
            Promise.reject(new Error("bang")),
          );
        }
        return ResultAsync.fromSafePromise(Promise.resolve(item));
      },
      defect,
    );

    expect(results.map((r) => (r.isOk() ? r.value : r.error))).toEqual([
      { type: "Defect" },
      { type: "Defect" },
      "fine",
    ]);
  });

  it("passes each item's index to the work", async () => {
    const pool = new WorkerPool(4);
    const results = await pool.run(
      ["a", "b", "c"],
      (item, index) =>
        ResultAsync.fromSafePromise(Promise.resolve(`${index}:${item}`)),
      defect,
    );

    expect(results.map((r) => r._unsafeUnwrap())).toEqual([
      "0:a",
      "1:b",
      "2:c",
    ]);
  });

  it("returns nothing for no items", async () => {
    const results = await new WorkerPool(4).run(
      [],
      new ManualWork().run,
      defect,
    );
    expect(results).toEqual([]);
  });

  it("treats a concurrency below 1 as 1", async () => {
    const work = new ManualWork();
    const done = new WorkerPool(0).run(["a", "b"], work.run, defect);
    await settle();

    expect(work.started).toEqual(["a"]);
    work.finish("a");
    await settle();
    work.finish("b");
    await done;
    expect(work.maxInFlight).toBe(1);
  });
});
