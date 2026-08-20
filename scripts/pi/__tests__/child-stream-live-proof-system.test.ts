import { describe, expect, it } from "bun:test";
import { createLiveProofSystem } from "../child-stream-live-proof-system.js";

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
