import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BoundedProcess,
  createLiveProofSystem,
  DEFAULT_BOUNDED_PROCESS_LIMITS,
  isLiveProofStreamOverflow,
  MAX_LIVE_PROOF_LINE_BYTES,
  MAX_LIVE_PROOF_QUEUED_LINES_PER_STREAM,
  runBoundedProcess,
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

function streamFromChunks(
  chunks: readonly Uint8Array<ArrayBuffer>[],
): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function trackedStream(
  onCancel: () => void,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    cancel() {
      onCancel();
    },
  });
}

function fakeProcess(input: {
  readonly stdout?: ReadableStream<Uint8Array<ArrayBuffer>>;
  readonly stderr?: ReadableStream<Uint8Array<ArrayBuffer>>;
  readonly exited?: PromiseLike<number>;
  readonly onKill?: (signal: "SIGTERM" | "SIGKILL") => unknown;
}): BoundedProcess {
  return {
    stdout: input.stdout ?? new ReadableStream<Uint8Array<ArrayBuffer>>(),
    stderr: input.stderr ?? new ReadableStream<Uint8Array<ArrayBuffer>>(),
    exited: input.exited ?? Promise.resolve(0),
    exitCode: null,
    signalCode: null,
    kill: (signal) => input.onKill?.(signal),
  };
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

describe("live proof host filesystem", () => {
  it("uses bounded host operations and refuses symlink reads and writes", async () => {
    const system = createLiveProofSystem();
    const root = join(tmpdir(), `weave-live-proof-host-${crypto.randomUUID()}`);
    const target = join(root, "target.txt");
    const privateFile = join(root, "private.txt");
    const link = join(root, "target-link.txt");
    try {
      expect((await system.makeDirectory(root)).isOk()).toBe(true);
      expect((await system.writeText(target, "safe")).isOk()).toBe(true);
      expect((await system.createPrivateFile(privateFile)).isOk()).toBe(true);
      const privateStat = await Bun.file(privateFile).stat();
      expect(privateStat.isFile()).toBe(true);
      expect(privateStat.mode & 0o7777).toBe(0o600);
      expect((await system.pathKind(target))._unsafeUnwrap()).toBe("file");
      expect(
        new TextDecoder().decode(
          (await system.readBytes(target))._unsafeUnwrap(),
        ),
      ).toBe("safe");

      const linked = Bun.spawn(["/bin/ln", "-s", target, link], {
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await linked.exited).toBe(0);
      expect((await system.pathKind(link))._unsafeUnwrap()).toBe("symlink");
      expect((await system.readBytes(link)).isErr()).toBe(true);
      expect((await system.writeText(link, "must-not-follow")).isErr()).toBe(
        true,
      );
      expect(await Bun.file(target).text()).toBe("safe");
    } finally {
      await system.removePath(root);
    }
  });

  it("keeps exclusive private-file creation closed across a symlink race", async () => {
    const system = createLiveProofSystem();
    const root = join(tmpdir(), `weave-live-proof-race-${crypto.randomUUID()}`);
    const target = join(root, "target.txt");
    const candidate = join(root, "candidate.txt");
    try {
      expect((await system.makeDirectory(root)).isOk()).toBe(true);
      await Bun.write(target, "unchanged");
      const linked = Bun.spawn(["/bin/ln", "-s", target, candidate], {
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await linked.exited).toBe(0);
      expect((await system.createPrivateFile(candidate)).isErr()).toBe(true);
      expect(await Bun.file(target).text()).toBe("unchanged");
    } finally {
      await system.removePath(root);
    }
  });
});

describe("shared bounded verifier process runner", () => {
  const limits = {
    ...DEFAULT_BOUNDED_PROCESS_LIMITS,
    spawnMs: 25,
    firstOutputMs: 25,
    totalReadMs: 100,
    gracefulTermMs: 15,
    postKillMs: 15,
    cleanupMs: 100,
    maxCaptureBytes: 4 * 1024,
  };

  it("drains stderr while stdout is quiet and returns normal success", async () => {
    const result = await runBoundedProcess({
      cmd: ["/bin/sh", "-c", "printf 'stderr-only\\n' >&2"],
      cwd: REPO_ROOT,
      env: { PATH: "/usr/bin:/bin" },
      limits,
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ exitCode: 0, stdout: "" });
  });

  it("writes bounded stdin before collecting both output streams", async () => {
    const result = await runBoundedProcess({
      cmd: [
        "/bin/sh",
        "-c",
        "read value; printf '%s\\n' \"$value\"; printf 'input-stderr\\n' >&2",
      ],
      cwd: REPO_ROOT,
      env: { PATH: "/usr/bin:/bin" },
      stdin: "pipe",
      stdinText: "bounded-input\n",
      limits,
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      exitCode: 0,
      stdout: "bounded-input\n",
    });
  });

  it("drains simultaneous stdout and stderr floods without deadlock", async () => {
    const result = await runBoundedProcess({
      cmd: [
        "/bin/sh",
        "-c",
        `(yes stdout | head -c 200000) & (yes stderr | head -c 200000 >&2) & wait`,
      ],
      cwd: REPO_ROOT,
      env: { PATH: "/usr/bin:/bin" },
      limits,
    });

    expect(result.isErr()).toBe(true);
  });

  it("closes when stdout ends but stderr remains open", async () => {
    const started = Date.now();
    const result = await runBoundedProcess({
      cmd: [
        "/bin/sh",
        "-c",
        "exec 1>&-; while true; do printf x >&2; sleep 0.01; done",
      ],
      cwd: REPO_ROOT,
      env: { PATH: "/usr/bin:/bin" },
      limits,
    });

    expect(result.isErr()).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("accepts split UTF-8 and rejects an overlong newline-free buffer", async () => {
    const emoji = new Uint8Array([0xf0, 0x9f, 0x98, 0x80, 0x0a]);
    const success = await runBoundedProcess({
      cmd: ["fake"],
      cwd: REPO_ROOT,
      env: {},
      limits,
      spawn: () =>
        fakeProcess({
          stdout: streamFromChunks([
            emoji.slice(0, 1),
            emoji.slice(1, 3),
            emoji.slice(3),
          ]),
          stderr: streamFromChunks([]),
        }),
    });
    expect(success.isOk()).toBe(true);
    expect(success._unsafeUnwrap().stdout).toBe("😀\n");

    const overlong = await runBoundedProcess({
      cmd: ["fake"],
      cwd: REPO_ROOT,
      env: {},
      limits,
      spawn: () =>
        fakeProcess({
          stdout: streamFromChunks([
            new Uint8Array(MAX_LIVE_PROOF_LINE_BYTES + 1).fill(0x78),
          ]),
          stderr: streamFromChunks([]),
        }),
    });
    expect(overlong.isErr()).toBe(true);
  });

  it("observes spawn and reader rejection without leaking host text", async () => {
    const spawnFailure = await runBoundedProcess({
      cmd: ["fake"],
      cwd: REPO_ROOT,
      env: {},
      limits,
      spawn: () => Promise.reject(new Error("secret spawn detail")),
    });
    expect(spawnFailure.isErr()).toBe(true);
    expect(JSON.stringify(spawnFailure)).not.toContain("secret");

    const rejectedStream = new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull: () => Promise.reject(new Error("secret reader detail")),
    });
    const readerFailure = await runBoundedProcess({
      cmd: ["fake"],
      cwd: REPO_ROOT,
      env: {},
      limits,
      spawn: () =>
        fakeProcess({
          stdout: rejectedStream,
          stderr: streamFromChunks([]),
        }),
    });
    expect(readerFailure.isErr()).toBe(true);
    expect(JSON.stringify(readerFailure)).not.toContain("secret");
  });

  it("terminates and cancels a process that resolves after spawn timeout", async () => {
    const signals: string[] = [];
    let stdoutCancellations = 0;
    let stderrCancellations = 0;
    let resolveExit: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const process = fakeProcess({
      stdout: trackedStream(() => {
        stdoutCancellations += 1;
      }),
      stderr: trackedStream(() => {
        stderrCancellations += 1;
      }),
      exited,
      onKill: (signal) => {
        signals.push(signal);
        if (signal === "SIGTERM") resolveExit(0);
      },
    });

    const result = await runBoundedProcess({
      cmd: ["fake"],
      cwd: REPO_ROOT,
      env: {},
      limits: { ...limits, spawnMs: 5 },
      spawn: () =>
        new Promise((resolve) => setTimeout(() => resolve(process), 25)),
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("timeout");
    expect(signals).toEqual([]);

    await sleep(100);

    expect(signals).toEqual(["SIGTERM"]);
    expect(stdoutCancellations).toBe(1);
    expect(stderrCancellations).toBe(1);
  });

  it("observes a spawn rejection that arrives after timeout", async () => {
    const result = await runBoundedProcess({
      cmd: ["fake"],
      cwd: REPO_ROOT,
      env: {},
      limits: { ...limits, spawnMs: 5 },
      spawn: () =>
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("late spawn detail")), 25),
        ),
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("timeout");
    await sleep(100);
    expect(JSON.stringify(result)).not.toContain("late spawn detail");
  });

  it("bounds late cleanup when stream cancellation, kill, and exit hang", async () => {
    const signals: string[] = [];
    const hangingStream = new ReadableStream<Uint8Array<ArrayBuffer>>({
      cancel: () => new Promise<void>(() => undefined),
    });
    const process = fakeProcess({
      stdout: hangingStream,
      stderr: new ReadableStream<Uint8Array<ArrayBuffer>>({
        cancel: () => new Promise<void>(() => undefined),
      }),
      exited: new Promise<number>(() => undefined),
      onKill: (signal) => {
        signals.push(signal);
        return new Promise<void>(() => undefined);
      },
    });

    const result = await runBoundedProcess({
      cmd: ["fake"],
      cwd: REPO_ROOT,
      env: {},
      limits: { ...limits, spawnMs: 5 },
      spawn: () =>
        new Promise((resolve) => setTimeout(() => resolve(process), 25)),
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("timeout");
    await sleep(150);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("cleans up a real process resolved after a spawn timeout", async () => {
    let child: Bun.Subprocess | undefined;
    const result = await runBoundedProcess({
      cmd: ["/bin/sleep", "10"],
      cwd: REPO_ROOT,
      env: { PATH: "/usr/bin:/bin" },
      limits: { ...limits, spawnMs: 5 },
      spawn: () =>
        new Promise<BoundedProcess>((resolve) => {
          setTimeout(() => {
            child = Bun.spawn({
              cmd: ["/bin/sleep", "10"],
              cwd: REPO_ROOT,
              env: { PATH: "/usr/bin:/bin" },
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
            });
            resolve(child as unknown as BoundedProcess);
          }, 25);
        }),
    });

    try {
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe("timeout");
      await sleep(100);
      expect(child).toBeDefined();
      expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
    } finally {
      if (child !== undefined && child.exitCode === null) {
        child.kill("SIGKILL");
        await Promise.race([child.exited, sleep(500)]);
      }
    }
  });

  it("bounds TERM and KILL when exit never resolves", async () => {
    const signals: string[] = [];
    const started = Date.now();
    const result = await runBoundedProcess({
      cmd: ["fake"],
      cwd: REPO_ROOT,
      env: {},
      limits,
      spawn: () =>
        fakeProcess({
          onKill: (signal) => signals.push(signal),
          exited: new Promise<number>(() => undefined),
        }),
    });

    expect(result.isErr()).toBe(true);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(Date.now() - started).toBeLessThan(500);
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
