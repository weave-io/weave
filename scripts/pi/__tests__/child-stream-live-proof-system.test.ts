import { describe, expect, it } from "bun:test";
import {
  createLiveProofSystem,
  isLiveProofStreamOverflow,
  MAX_LIVE_PROOF_LINE_BYTES,
  MAX_LIVE_PROOF_QUEUED_LINES_PER_STREAM,
} from "../child-stream-live-proof-system.js";

const REPO_ROOT = process.cwd();

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function spawnShell(script: string) {
  return createLiveProofSystem().spawn({
    cmd: ["/bin/sh", "-c", script],
    cwd: REPO_ROOT,
    env: { PATH: "/usr/bin:/bin" },
  });
}

describe("live proof system timers", () => {
  it("fires an output-independent deadline", async () => {
    const system = createLiveProofSystem();
    let fired = 0;
    system.setTimer(() => {
      fired += 1;
    }, 5);

    await sleep(40);

    expect(fired).toBe(1);
  });

  it("cancels a pending deadline and tolerates repeated cancellation", async () => {
    const system = createLiveProofSystem();
    let fired = 0;
    const timer = system.setTimer(() => {
      fired += 1;
    }, 5);
    timer.cancel();
    timer.cancel();

    await sleep(40);

    expect(fired).toBe(0);
  });
});

describe("live proof system process streams", () => {
  it("accepts an exact line bound and rejects the next byte", async () => {
    for (const length of [
      MAX_LIVE_PROOF_LINE_BYTES,
      MAX_LIVE_PROOF_LINE_BYTES + 1,
    ]) {
      const spawned = spawnShell(
        `head -c ${length} /dev/zero | tr '\\0' x; printf '\\n'`,
      );
      expect(spawned.isOk()).toBe(true);
      const child = spawned._unsafeUnwrap();
      const iterator = child.lines()[Symbol.asyncIterator]();
      let overflow: unknown;
      try {
        const next = await iterator.next();
        if (length === MAX_LIVE_PROOF_LINE_BYTES) {
          expect(next.done).toBe(false);
          expect(next.value).toHaveLength(MAX_LIVE_PROOF_LINE_BYTES);
        }
      } catch (error) {
        overflow = error;
      }
      if (length === MAX_LIVE_PROOF_LINE_BYTES + 1) {
        expect(isLiveProofStreamOverflow(overflow)).toBe(true);
      }
      await iterator.return?.();
      expect((await child.terminate()).isOk()).toBe(true);
    }
  });

  it("fails a newline-free stdout and stderr flood before a deadline", async () => {
    for (const command of [
      `head -c ${MAX_LIVE_PROOF_LINE_BYTES + 1} /dev/zero | tr '\\0' x`,
      `head -c ${MAX_LIVE_PROOF_LINE_BYTES + 1} /dev/zero | tr '\\0' x >&2`,
    ]) {
      const spawned = spawnShell(command);
      expect(spawned.isOk()).toBe(true);
      const child = spawned._unsafeUnwrap();
      const iterator = child.lines()[Symbol.asyncIterator]();
      let failure: unknown;
      try {
        await iterator.next();
      } catch (error) {
        failure = error;
      }
      expect(isLiveProofStreamOverflow(failure)).toBe(true);
      await iterator.return?.();
      expect((await child.terminate()).isOk()).toBe(true);
      expect(child.running()).toBe(false);
    }
  });

  it("fails stdout, stderr, and mixed many-short-lines floods closed", async () => {
    const lines = MAX_LIVE_PROOF_QUEUED_LINES_PER_STREAM + 1;
    for (const command of [
      `yes stdout | head -n ${lines}`,
      `yes stderr | head -n ${lines} >&2`,
      `(yes stdout | head -n ${lines}) & (yes stderr | head -n ${lines} >&2); wait`,
    ]) {
      const spawned = spawnShell(command);
      expect(spawned.isOk()).toBe(true);
      const child = spawned._unsafeUnwrap();
      const iterator = child.lines()[Symbol.asyncIterator]();
      let failure: unknown;
      try {
        await iterator.next();
      } catch (error) {
        failure = error;
      }
      expect(isLiveProofStreamOverflow(failure)).toBe(true);
      await iterator.return?.();
      expect((await child.terminate()).isOk()).toBe(true);
      expect(child.running()).toBe(false);
    }
  });

  it("keeps a multibyte line intact when bytes arrive in split chunks", async () => {
    const spawned = spawnShell(
      "printf '\\360'; sleep 0.01; printf '\\237'; sleep 0.01; printf '\\230'; sleep 0.01; printf '\\200\\n'",
    );
    expect(spawned.isOk()).toBe(true);
    const child = spawned._unsafeUnwrap();
    const iterator = child.lines()[Symbol.asyncIterator]();
    const next = await iterator.next();

    expect(next.done).toBe(false);
    expect(next.value).toBe("😀");
    await iterator.return?.();
    expect((await child.terminate()).isOk()).toBe(true);
  });

  it("ignores chunks and reader failures that arrive after overflow", async () => {
    const spawned = spawnShell(
      `{ head -c ${MAX_LIVE_PROOF_LINE_BYTES + 1} /dev/zero | tr '\\0' x; sleep 0.05; printf 'late\\n'; }`,
    );
    expect(spawned.isOk()).toBe(true);
    const child = spawned._unsafeUnwrap();
    const iterator = child.lines()[Symbol.asyncIterator]();
    let failure: unknown;
    try {
      await iterator.next();
    } catch (error) {
      failure = error;
    }
    expect(isLiveProofStreamOverflow(failure)).toBe(true);
    await sleep(100);
    await iterator.return?.();
    expect((await child.terminate()).isOk()).toBe(true);
    expect(child.running()).toBe(false);
  });

  it("closes a silent process line iterator on demand", async () => {
    const spawned = spawnShell("while true; do sleep 5; done");
    expect(spawned.isOk()).toBe(true);
    const child = spawned._unsafeUnwrap();

    const iterator = child.lines()[Symbol.asyncIterator]();
    const pending = iterator.next();
    await sleep(20);

    const started = Date.now();
    const closed = await iterator.return?.();
    const elapsed = Date.now() - started;
    // The parked reader must observe the close instead of leaking.
    const settled = await Promise.race([
      pending.then(
        () => "settled" as const,
        () => "settled" as const,
      ),
      sleep(200).then(() => "pending" as const),
    ]);
    const terminated = await child.terminate();

    expect(closed?.done).toBe(true);
    expect(elapsed).toBeLessThan(1_000);
    expect(settled).toBe("settled");
    expect(terminated.isOk()).toBe(true);
    expect(child.running()).toBe(false);
  });

  it("yields lines and completes when the process exits", async () => {
    const spawned = spawnShell("printf 'alpha\\nbeta\\n'");
    expect(spawned.isOk()).toBe(true);
    const child = spawned._unsafeUnwrap();

    const seen: string[] = [];
    for await (const line of child.lines()) {
      if (line.length > 0) seen.push(line);
      if (seen.length === 2) break;
    }
    const terminated = await child.terminate();

    expect(seen).toEqual(["alpha", "beta"]);
    expect(terminated.isOk()).toBe(true);
  });

  it("bounds termination of a process that ignores SIGTERM", async () => {
    const spawned = spawnShell("trap '' TERM; while true; do sleep 0.2; done");
    expect(spawned.isOk()).toBe(true);
    const child = spawned._unsafeUnwrap();
    await sleep(50);

    const started = Date.now();
    const terminated = await child.terminate();
    const elapsed = Date.now() - started;

    expect(terminated.isOk()).toBe(true);
    // SIGTERM wait plus one SIGKILL escalation, never an unbounded wait.
    expect(elapsed).toBeLessThan(4_000);
    expect(child.running()).toBe(false);
  });
});
