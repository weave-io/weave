/**
 * Injected process port for spawning a private RPC child (Spec 33 §11.2).
 * Production implementation uses only `Bun.spawn` - no `node:child_process`.
 * Tests always inject a scripted fake; no automated test may spawn a real
 * process (AGENTS.md, Spec 33 §24 layer D).
 */
import { err, ok, type Result, ResultAsync } from "neverthrow";

export type ChildProcessError =
  | { readonly type: "SpawnFailed"; readonly reason: string }
  | { readonly type: "WriteFailed"; readonly reason: string };

export interface PiChildStdout {
  onData(cb: (chunk: Uint8Array) => void): void;
  onEnd(cb: () => void): void;
  /**
   * A stream-read failure (e.g. the underlying pipe broke). Always fires
   * before `onEnd` for that same failure, never in place of it - callers
   * that only care about "the child is gone" can rely on `onEnd` alone;
   * callers that want to distinguish a clean exit from a broken pipe use
   * this in addition.
   */
  onError(cb: (reason: string) => void): void;
}

export interface PiSpawnedChildProcess {
  writeStdin(bytes: Uint8Array): Result<void, ChildProcessError>;
  readonly stdout: PiChildStdout;
  /** Never throws, regardless of the underlying process's state. */
  kill(): void;
  readonly exited: Promise<number | null>;
}

export interface PiChildSpawnInput {
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

export interface PiChildProcessPort {
  spawn(
    input: PiChildSpawnInput,
  ): ResultAsync<PiSpawnedChildProcess, ChildProcessError>;
}

/**
 * Every failure reason surfaced by this port is one of a small closed set
 * of fixed, bounded strings - never the raw `Error.message`/stack of
 * whatever the host process or OS actually threw. That content can't be
 * trusted not to carry paths, environment values, or other data that must
 * never reach an adapter failure's correlation fields, logs, or the TUI
 * (Spec 33 §19.1), and mirrors the same closed-reason pattern already used
 * by `child-crypto.ts`'s own `describeThrown`.
 */
const SPAWN_FAILED_REASON = "child-process-spawn-failed";
const WRITE_FAILED_REASON = "child-process-write-failed";
const READ_FAILED_REASON = "child-process-read-failed";

export class BunPiChildProcessPort implements PiChildProcessPort {
  spawn(
    input: PiChildSpawnInput,
  ): ResultAsync<PiSpawnedChildProcess, ChildProcessError> {
    return ResultAsync.fromThrowable(
      () => Promise.resolve(this.doSpawn(input)),
      (): ChildProcessError => ({
        type: "SpawnFailed",
        reason: SPAWN_FAILED_REASON,
      }),
    )();
  }

  private doSpawn(input: PiChildSpawnInput): PiSpawnedChildProcess {
    const subprocess = Bun.spawn(input.command as string[], {
      env: input.env as Record<string, string>,
      cwd: input.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    const dataHandlers: ((chunk: Uint8Array) => void)[] = [];
    const endHandlers: (() => void)[] = [];
    const errorHandlers: ((reason: string) => void)[] = [];
    void (async () => {
      const reader = subprocess.stdout.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value !== undefined) {
            for (const handler of dataHandlers) handler(value);
          }
        }
      } catch {
        // A broken pipe/stream-read failure must never become an unhandled
        // rejection - surface it through the port like any other terminal
        // signal, then fall through to the same `onEnd` every other exit
        // path fires, so callers that only watch `onEnd` still see it.
        for (const handler of errorHandlers) handler(READ_FAILED_REASON);
      }
      for (const handler of endHandlers) handler();
    })();
    return {
      writeStdin: (bytes: Uint8Array): Result<void, ChildProcessError> => {
        try {
          subprocess.stdin.write(bytes);
          return ok(undefined);
        } catch {
          return err({ type: "WriteFailed", reason: WRITE_FAILED_REASON });
        }
      },
      stdout: {
        onData: (cb) => dataHandlers.push(cb),
        onEnd: (cb) => endHandlers.push(cb),
        onError: (cb) => errorHandlers.push(cb),
      },
      kill: () => {
        // Killing an already-dead process can throw; this method's own
        // contract is "best-effort, never throws" - every caller (cleanup
        // paths above all) relies on that.
        try {
          subprocess.kill();
        } catch {
          // Intentionally swallowed: nothing upstream can act on a failed
          // kill of an already-gone process, and this method must not
          // itself become a new source of unhandled exceptions.
        }
      },
      exited: subprocess.exited,
    };
  }
}
