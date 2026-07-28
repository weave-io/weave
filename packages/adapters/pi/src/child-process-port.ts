/**
 * Injected process port for spawning a private RPC child (Pi adapter contract).
 * Production implementation uses only `Bun.spawn` - no `node:child_process`.
 * Tests always inject a scripted fake; no automated test may spawn a real
 * process (see AGENTS.md and the Pi adapter contract).
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
  writeStdin(bytes: Uint8Array): ResultAsync<void, ChildProcessError>;
  readonly stdout: PiChildStdout;
  /**
   * Cooperative/default termination (SIGTERM). Never throws, regardless of
   * the underlying process's state. A stopped (`SIGSTOP`'d) or otherwise
   * non-cooperative process is free to leave a signal with this default
   * disposition pending indefinitely rather than acting on it - callers
   * that must *guarantee* the process is gone (any bounded/terminal
   * cleanup path) need `forceKill()`, not this.
   */
  kill(): void;
  /**
   * Mandatory force-kill (`SIGKILL`-equivalent): the one signal whose
   * default disposition can never be caught, blocked, or ignored, and
   * which the kernel delivers even to a stopped process instead of
   * leaving it pending. Every terminal/bounded-grace cleanup path must use
   * this, not `kill()`, to actually guarantee the process is gone.
   * Never throws, regardless of the underlying process's state.
   */
  forceKill(): void;
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
 * (Pi adapter contract), and mirrors the same closed-reason pattern already used
 * by `child-crypto.ts`'s own `describeThrown`.
 */
const SPAWN_FAILED_REASON = "child-process-spawn-failed";
const WRITE_FAILED_REASON = "child-process-write-failed";
const READ_FAILED_REASON = "child-process-read-failed";

/**
 * Cooperative/default termination sends no explicit signal at all -
 * `Bun.spawn`'s own `Subprocess.kill()` then applies its own default
 * (`SIGTERM`). Mandatory force-kill always sends this exact numeric
 * signal (`SIGKILL`) - passed as a number, matching `Bun.spawn`'s own
 * `kill(exitCode?: number | NodeJS.Signals)` signature, so it never
 * depends on the host platform's string-to-signal-name mapping. `SIGKILL`
 * is the one signal whose default disposition can never be caught,
 * blocked, or ignored, and the kernel delivers it to a stopped
 * (`SIGSTOP`'d) process immediately rather than leaving it pending until
 * the process is resumed - this is exactly what a plain default-signal
 * `kill()` cannot guarantee (Pi adapter contract).
 */
export const FORCE_KILL_SIGNAL = 9;

export interface PiChildStdinSink {
  write(bytes: Uint8Array): number | Promise<number>;
  flush(): void | number | Promise<void | number>;
}

/**
 * Writes every byte in order and waits for the sink to flush after each
 * accepted segment. A partial write retains the untouched suffix; a sink
 * that remains unable to accept data after a flush fails closed.
 */
export function writeAllToSink(
  sink: PiChildStdinSink,
  bytes: Uint8Array,
): ResultAsync<void, ChildProcessError> {
  const write = ResultAsync.fromThrowable(
    async (): Promise<Result<void, ChildProcessError>> => {
      let offset = 0;
      let zeroWrites = 0;
      while (offset < bytes.byteLength) {
        const remaining = bytes.subarray(offset);
        const accepted = await sink.write(remaining);
        if (
          !Number.isInteger(accepted) ||
          accepted < 0 ||
          accepted > remaining.byteLength
        ) {
          return err({ type: "WriteFailed", reason: WRITE_FAILED_REASON });
        }
        if (accepted === 0) {
          zeroWrites += 1;
          if (zeroWrites > 1) {
            return err({ type: "WriteFailed", reason: WRITE_FAILED_REASON });
          }
        } else {
          zeroWrites = 0;
          offset += accepted;
        }
        await sink.flush();
      }
      return ok(undefined);
    },
    (): ChildProcessError => ({
      type: "WriteFailed",
      reason: WRITE_FAILED_REASON,
    }),
  )();
  return write.andThen((result) => result);
}

/**
 * The pure signal-selection mapping underlying {@link PiSpawnedChildProcess.kill}
 * vs {@link PiSpawnedChildProcess.forceKill}: cooperative termination sends
 * no explicit signal (letting the runtime apply its own default, `SIGTERM`);
 * mandatory force-kill always sends {@link FORCE_KILL_SIGNAL} (`SIGKILL`)
 * explicitly. Exported and unit-tested on its own because the surrounding
 * process boundary - the real `Bun.spawn` call
 * itself - is deliberately never exercised by an automated test; this pure
 * mapping is the one piece of "which signal do we actually ask for" logic
 * that can be proven without spawning a real process.
 */
export function resolveKillSignal(
  mode: "cooperative" | "force",
): number | undefined {
  if (mode === "force") return FORCE_KILL_SIGNAL;
  return undefined;
}

/**
 * Sends `signal` (or, when `undefined`, no explicit signal at all - the
 * runtime's own default) to `subprocess.kill()`. Killing an already-dead
 * process can throw; this helper's own contract is "best-effort, never
 * throws" - every caller (both {@link PiSpawnedChildProcess.kill} and
 * {@link PiSpawnedChildProcess.forceKill}) relies on that.
 */
function sendSignal(
  subprocess: { kill(signal?: number): void },
  signal: number | undefined,
): void {
  try {
    if (signal === undefined) {
      subprocess.kill();
    } else {
      subprocess.kill(signal);
    }
  } catch {
    // Intentionally swallowed: nothing upstream can act on a failed kill of
    // an already-gone process, and this helper must not itself become a
    // new source of unhandled exceptions.
  }
}

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
      writeStdin: (bytes) =>
        writeAllToSink(
          {
            write: (chunk) => subprocess.stdin.write(chunk),
            flush: () => subprocess.stdin.flush(),
          },
          bytes,
        ),
      stdout: {
        onData: (cb) => dataHandlers.push(cb),
        onEnd: (cb) => endHandlers.push(cb),
        onError: (cb) => errorHandlers.push(cb),
      },
      kill: () => sendSignal(subprocess, resolveKillSignal("cooperative")),
      forceKill: () => sendSignal(subprocess, resolveKillSignal("force")),
      exited: subprocess.exited,
    };
  }
}
