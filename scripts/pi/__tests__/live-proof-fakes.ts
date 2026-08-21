import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
} from "neverthrow";
import {
  LIVE_PROOF_STREAM_OVERFLOW,
  type LiveProofCommandOutput,
  type LiveProofPathKind,
  type LiveProofProcess,
  type LiveProofSpawnInput,
  type LiveProofSystem,
  type LiveProofSystemFailure,
  systemFailure,
} from "../child-stream-live-proof-system.js";

export interface FakeProcessScript {
  /** Lines the process emits on stdout, in order. */
  readonly lines: readonly string[];
  /** When true, `spawn` fails instead of returning a process. */
  readonly spawnFails?: boolean;
  /** When true, the line iterator never completes within the test deadline. */
  readonly hang?: boolean;
  /** Never resolve the next iterator step. */
  readonly neverYields?: boolean;
  /** Resolve one late line after the deadline, after which silence remains. */
  readonly lateLine?: string;
  readonly lateDelayMs?: number;
  /** Reject one late iterator step after the deadline. */
  readonly lateReject?: boolean;
  /** Reject the next iterator step with the closed stream-overflow signal. */
  readonly overflow?: boolean;
  readonly overflowDelayMs?: number;
  /** Make iterator return fail or remain pending. */
  readonly iteratorReturnFails?: boolean;
  readonly iteratorReturnHangs?: boolean;
  /** Make process termination fail or remain pending. */
  readonly terminateFails?: boolean;
  readonly terminateHangs?: boolean;
  /** When true, `running()` still reports true after `terminate()`. */
  readonly survivesTermination?: boolean;
}

export interface FakeProcessRecord {
  readonly input: LiveProofSpawnInput;
  readonly written: string[];
  terminations: number;
  iteratorReturns: number;
  alive: boolean;
}

export interface FakeSystemOptions {
  readonly processes?: readonly FakeProcessScript[];
  readonly files?: ReadonlyMap<string, Uint8Array>;
  readonly kinds?: ReadonlyMap<string, LiveProofPathKind>;
  readonly runOutput?: LiveProofCommandOutput;
  readonly runFails?: boolean;
  readonly failCreatePrivateFile?: boolean;
  readonly failWriteBytes?: boolean;
  readonly failRename?: boolean;
  readonly failRemove?: boolean;
}

export interface FakeSystem {
  readonly system: LiveProofSystem;
  readonly files: Map<string, Uint8Array>;
  readonly privateFiles: Set<string>;
  readonly removed: string[];
  readonly renames: { from: string; to: string }[];
  readonly spawns: FakeProcessRecord[];
  readonly runs: (readonly string[])[];
  readonly timersCreated: number;
  readonly timersDisposed: number;
  readonly activeTimers: number;
}

const encoder = new TextEncoder();

export function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

export function text(value: Uint8Array | undefined): string {
  return value === undefined ? "" : new TextDecoder().decode(value);
}

export function createFakeSystem(options: FakeSystemOptions = {}): FakeSystem {
  const files = new Map<string, Uint8Array>(options.files ?? []);
  const kinds = new Map<string, LiveProofPathKind>(options.kinds ?? []);
  const privateFiles = new Set<string>();
  const removed: string[] = [];
  const renames: { from: string; to: string }[] = [];
  const spawns: FakeProcessRecord[] = [];
  const runs: (readonly string[])[] = [];
  const scripts = [...(options.processes ?? [])];
  let clock = 1_000;
  let token = 0;
  let timersCreated = 0;
  let timersDisposed = 0;
  const activeTimers = new Set<ReturnType<typeof setTimeout>>();

  const pathKindOf = (path: string): LiveProofPathKind => {
    const declared = kinds.get(path);
    if (declared !== undefined) return declared;
    return files.has(path) ? "file" : "missing";
  };

  const system: LiveProofSystem = {
    now: () => {
      clock += 1;
      return clock;
    },
    setTimer: (callback, delayMs) => {
      timersCreated += 1;
      let cancelled = false;
      const handle = setTimeout(() => {
        if (!cancelled) timersDisposed += 1;
        activeTimers.delete(handle);
        callback();
      }, delayMs);
      activeTimers.add(handle);
      return {
        cancel: () => {
          if (cancelled) return;
          cancelled = true;
          clearTimeout(handle);
          if (activeTimers.delete(handle)) timersDisposed += 1;
        },
      };
    },
    environment: () => ({ PATH: "/usr/bin", OPENAI_API_KEY: "secret" }),
    temporaryRoot: () => "/tmp",
    uniqueToken: () => {
      token += 1;
      return `token-${token}`;
    },
    spawn: (input): Result<LiveProofProcess, LiveProofSystemFailure> => {
      const script = scripts.shift() ?? { lines: [] };
      if (script.spawnFails === true) {
        return err(systemFailure("spawn-failed"));
      }
      const record: FakeProcessRecord = {
        input,
        written: [],
        terminations: 0,
        iteratorReturns: 0,
        alive: true,
      };
      spawns.push(record);
      const process: LiveProofProcess = {
        writeLine: (line) => {
          record.written.push(line);
          return ok(undefined);
        },
        lines: () => {
          let index = 0;
          let silenceStarted = false;
          const next = (): Promise<IteratorResult<string>> => {
            const line = script.lines[index];
            if (line !== undefined) {
              index += 1;
              return Promise.resolve({ done: false, value: line });
            }
            if (script.hang === true && !silenceStarted) {
              silenceStarted = true;
              return new Promise((resolveHang) =>
                setTimeout(() => resolveHang({ done: false, value: "" }), 50),
              );
            }
            if (script.overflow === true && !silenceStarted) {
              silenceStarted = true;
              const rejectOverflow = (): Promise<IteratorResult<string>> =>
                Promise.reject(LIVE_PROOF_STREAM_OVERFLOW);
              return script.overflowDelayMs === undefined
                ? rejectOverflow()
                : new Promise<IteratorResult<string>>((_, rejectLate) =>
                    setTimeout(
                      () => rejectLate(LIVE_PROOF_STREAM_OVERFLOW),
                      script.overflowDelayMs,
                    ),
                  );
            }
            if (
              (script.neverYields === true ||
                script.lateLine !== undefined ||
                script.lateReject === true) &&
              !silenceStarted
            ) {
              silenceStarted = true;
              if (script.lateLine !== undefined) {
                return new Promise((resolveLate) =>
                  setTimeout(
                    () =>
                      resolveLate({
                        done: false,
                        value: script.lateLine ?? "",
                      }),
                    script.lateDelayMs ?? 25,
                  ),
                );
              }
              if (script.lateReject === true) {
                return new Promise<IteratorResult<string>>((_, rejectLate) =>
                  setTimeout(
                    () => rejectLate(new Error("late iterator failure")),
                    script.lateDelayMs ?? 25,
                  ),
                );
              }
              return new Promise(() => undefined);
            }
            return Promise.resolve({ done: true, value: undefined });
          };
          const iterator: AsyncIterableIterator<string> = {
            next,
            return: () => {
              record.iteratorReturns += 1;
              if (script.iteratorReturnHangs === true) {
                return new Promise(() => undefined);
              }
              if (script.iteratorReturnFails === true) {
                return Promise.reject(new Error("iterator close failure"));
              }
              return Promise.resolve({ done: true, value: undefined });
            },
            [Symbol.asyncIterator]() {
              return this;
            },
          };
          return iterator;
        },
        terminate: () => {
          record.terminations += 1;
          if (script.terminateHangs === true) {
            return ResultAsync.fromPromise(
              new Promise<void>(() => undefined),
              () => systemFailure("cleanup-failed"),
            );
          }
          if (script.terminateFails === true) {
            return errAsync(systemFailure("cleanup-failed"));
          }
          if (script.survivesTermination !== true) record.alive = false;
          return okAsync(undefined);
        },
        running: () => record.alive,
      };
      return ok(process);
    },
    run: (input) => {
      runs.push(input.cmd);
      if (options.runFails === true) {
        return errAsync(systemFailure("cleanup-failed"));
      }
      return okAsync(
        options.runOutput ?? { exitCode: 0, stdout: "  No active lease.\n" },
      );
    },
    makeDirectory: () => okAsync(undefined),
    writeText: (path, value) => {
      files.set(path, bytes(value));
      return okAsync(undefined);
    },
    readBytes: (path) => {
      const value = files.get(path);
      return value === undefined
        ? errAsync(systemFailure("cleanup-failed"))
        : okAsync(value);
    },
    writeBytes: (path, value) => {
      if (options.failWriteBytes === true) {
        return errAsync(systemFailure("report-invalid"));
      }
      files.set(path, value);
      return okAsync(undefined);
    },
    createPrivateFile: (path) => {
      if (options.failCreatePrivateFile === true) {
        return errAsync(systemFailure("report-invalid"));
      }
      if (pathKindOf(path) !== "missing") {
        return errAsync(systemFailure("report-invalid"));
      }
      files.set(path, new Uint8Array());
      privateFiles.add(path);
      return okAsync(undefined);
    },
    renamePath: (from, to) => {
      if (options.failRename === true) {
        return errAsync(systemFailure("report-invalid"));
      }
      const value = files.get(from);
      if (value === undefined) {
        return errAsync(systemFailure("report-invalid"));
      }
      files.delete(from);
      files.set(to, value);
      renames.push({ from, to });
      return okAsync(undefined);
    },
    removePath: (path) => {
      removed.push(path);
      if (options.failRemove === true) {
        return errAsync(systemFailure("cleanup-failed"));
      }
      files.delete(path);
      privateFiles.delete(path);
      return okAsync(undefined);
    },
    pathKind: (path) => okAsync(pathKindOf(path)),
    delay: () => ResultAsync.fromSafePromise(Promise.resolve(undefined)),
  };

  return {
    system,
    files,
    privateFiles,
    removed,
    renames,
    spawns,
    runs,
    get timersCreated() {
      return timersCreated;
    },
    get timersDisposed() {
      return timersDisposed;
    },
    get activeTimers() {
      return activeTimers.size;
    },
  };
}
