import { basename, resolve } from "node:path";
import { err, ok, Result, ResultAsync } from "neverthrow";
import {
  CLEANUP_FORCE_TIMEOUT_MS,
  CLEANUP_GRACE_TIMEOUT_MS,
  type CleanupClock,
  type CleanupProcessHandle,
  type CleanupResourceKind,
  type CleanupResourceTracker,
  type CleanupVerification,
  type CommandResult,
  DEFAULT_COMMAND_TIMEOUT_MS,
  failure,
  MAX_CAPTURE_BYTES,
  type SmokeFailure,
  type SpawnedProcessLike,
  type SpawnFactory,
  safeDiagnostic,
} from "./contract.js";

class CleanupResourceTrackerImpl implements CleanupResourceTracker {
  readonly root: string;
  private readonly owned = new Set<string>();
  private readonly processes = new Map<string, CleanupProcessHandle>();
  private readonly disposers = new Map<number, () => void | Promise<void>>();
  private readonly timers = new Map<number, () => void>();
  private nextDisposerId = 1;
  private remembered?: Result<CleanupVerification, SmokeFailure>;
  private inFlight?: Promise<Result<CleanupVerification, SmokeFailure>>;

  constructor(root: string) {
    this.root = resolve(root);
    this.owned.add(this.root);
  }

  get ownedPaths(): readonly string[] {
    return [...this.owned];
  }

  get processHandles(): readonly CleanupProcessHandle[] {
    return [...this.processes.values()];
  }

  get activeResourceCount(): number {
    return this.processes.size + this.disposers.size + this.timers.size;
  }

  registerOwnedPath(path: string): boolean {
    const absolute = resolve(path);
    if (absolute !== this.root && !absolute.startsWith(`${this.root}/`))
      return false;
    this.owned.add(absolute);
    return true;
  }

  registerProcess(handle: CleanupProcessHandle): () => void {
    const id = this.processes.has(handle.id)
      ? `${handle.id}-${this.processes.size}`
      : handle.id;
    const stored = { ...handle, id };
    this.processes.set(id, stored);
    void handle.exited.then(
      () => {
        if (this.processes.get(id) === stored) this.processes.delete(id);
      },
      () => undefined,
    );
    return () => {
      this.processes.delete(id);
    };
  }

  registerDisposer(disposer: () => void | Promise<void>): () => void {
    const id = this.nextDisposerId;
    this.nextDisposerId += 1;
    this.disposers.set(id, disposer);
    return () => {
      this.disposers.delete(id);
    };
  }

  registerTimer(disposer: () => void): () => void {
    const id = this.nextDisposerId;
    this.nextDisposerId += 1;
    this.timers.set(id, disposer);
    return () => {
      this.timers.delete(id);
    };
  }

  async disposeResources(): Promise<boolean> {
    let disposed = true;
    for (const [id, disposer] of this.timers) {
      const result = await ResultAsync.fromThrowable(
        async () => disposer(),
        () => undefined,
      )();
      if (result.isErr()) disposed = false;
      this.timers.delete(id);
    }
    for (const [id, disposer] of this.disposers) {
      const result = await ResultAsync.fromThrowable(
        async () => disposer(),
        () => undefined,
      )();
      if (result.isErr()) disposed = false;
      this.disposers.delete(id);
    }
    for (const handle of this.processes.values()) {
      if (handle.dispose === undefined) continue;
      const result = await ResultAsync.fromThrowable(
        async () => handle.dispose?.(),
        () => undefined,
      )();
      if (result.isErr()) disposed = false;
    }
    return disposed && this.activeResourceCount === this.processes.size;
  }

  rememberCleanup(result: Result<CleanupVerification, SmokeFailure>): void {
    this.remembered = result;
  }

  rememberedCleanup(): Result<CleanupVerification, SmokeFailure> | undefined {
    return this.remembered;
  }

  cleanupInFlight():
    | Promise<Result<CleanupVerification, SmokeFailure>>
    | undefined {
    return this.inFlight;
  }

  rememberCleanupInFlight(
    promise: Promise<Result<CleanupVerification, SmokeFailure>>,
  ): void {
    this.inFlight = promise;
  }

  pruneExited(): void {
    for (const [id, handle] of this.processes) {
      if (handleExited(handle)) this.processes.delete(id);
    }
  }
}

export function createCleanupResourceTracker(
  root: string,
): CleanupResourceTracker {
  return new CleanupResourceTrackerImpl(root);
}

function handleExited(handle: CleanupProcessHandle): boolean {
  const process = handle as CleanupProcessHandle & {
    readonly exitCode?: number | null;
    readonly killed?: boolean;
  };
  return process.exitCode !== undefined && process.exitCode !== null;
}

function processHandleFor(
  child: SpawnedProcessLike,
  kind: CleanupResourceKind,
  dispose?: () => void | Promise<void>,
): CleanupProcessHandle {
  const id = `${kind}:${child.pid ?? crypto.randomUUID()}`;
  return {
    id,
    kind,
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    ...(child.exitCode === undefined ? {} : { exitCode: child.exitCode }),
    ...(child.killed === undefined ? {} : { killed: child.killed }),
    exited: child.exited,
    terminate: (signal) => killQuietly(child, signal),
    ...(dispose === undefined ? {} : { dispose }),
  };
}

interface BoundedReader {
  readonly promise: Promise<string>;
  readonly cancel: () => void;
}

function startBoundedReader(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maximum: number,
): BoundedReader {
  if (stream === null || stream === undefined)
    return { promise: Promise.resolve(""), cancel: () => undefined };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let cancelled = false;
  const promise = (async (): Promise<string> => {
    let text = "";
    let totalBytes = 0;
    try {
      while (!cancelled) {
        const next = await reader.read();
        if (next.done) break;
        totalBytes += next.value.byteLength;
        if (text.length < maximum) {
          text += decoder.decode(next.value, { stream: true });
          if (text.length > maximum) text = text.slice(0, maximum);
        }
      }
    } catch {
      // A timeout cancels the reader. The command result is already bounded.
    } finally {
      reader.releaseLock();
    }
    if (totalBytes > maximum) return `${text}\n[output truncated]`;
    return text + decoder.decode();
  })();
  return {
    promise,
    cancel: () => {
      cancelled = true;
      void ResultAsync.fromPromise(reader.cancel(), () => undefined);
    },
  };
}

const defaultSpawn: SpawnFactory = (args, options) =>
  Bun.spawn([...args], {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  }) as unknown as SpawnedProcessLike;

function killQuietly(
  child: SpawnedProcessLike,
  signal: "SIGTERM" | "SIGKILL",
): void {
  Result.fromThrowable(
    () => child.kill(signal),
    () => undefined,
  )();
}

export function signalPidQuietly(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
): void {
  Result.fromThrowable(
    () => process.kill(pid, signal),
    () => undefined,
  )();
}

export function createCleanupClock(): CleanupClock {
  const timers = new Map<Promise<void>, ReturnType<typeof setTimeout>>();
  return {
    wait: (milliseconds) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let waitPromise: Promise<void>;
      waitPromise = new Promise((resolveWait) => {
        timer = setTimeout(() => {
          timers.delete(waitPromise);
          resolveWait();
        }, milliseconds);
      });
      if (timer !== undefined) timers.set(waitPromise, timer);
      return waitPromise;
    },
    cancel: (waitPromise) => {
      const timer = timers.get(waitPromise);
      if (timer === undefined) return;
      clearTimeout(timer);
      timers.delete(waitPromise);
    },
  };
}

async function waitForExit(
  exited: Promise<unknown>,
  milliseconds: number,
  clock: CleanupClock,
): Promise<boolean> {
  const timeout = clock.wait(milliseconds);
  const completed = await Promise.race([
    exited.then(
      () => true,
      () => false,
    ),
    timeout.then(() => false),
  ]);
  if (completed) clock.cancel?.(timeout);
  return completed;
}

export async function waitForHandles(
  handles: readonly CleanupProcessHandle[],
  milliseconds: number,
  clock: CleanupClock,
): Promise<void> {
  const timeout = clock.wait(milliseconds);
  const completed = await Promise.race([
    Promise.all(
      handles.map((handle) =>
        handle.exited.then(
          () => undefined,
          () => undefined,
        ),
      ),
    ).then(() => true),
    timeout.then(() => false),
  ]);
  if (completed) clock.cancel?.(timeout);
}

async function terminateHandle(
  handle: CleanupProcessHandle,
  clock: CleanupClock,
): Promise<boolean> {
  handle.terminate?.("SIGTERM");
  const graceful = await waitForExit(
    handle.exited,
    CLEANUP_GRACE_TIMEOUT_MS,
    clock,
  );
  if (graceful) return true;
  handle.terminate?.("SIGKILL");
  return waitForExit(handle.exited, CLEANUP_FORCE_TIMEOUT_MS, clock);
}

export async function runBoundedCommand(
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly timeoutMs?: number;
    readonly spawn?: SpawnFactory;
    readonly resources?: CleanupResourceTracker;
    readonly processKind?: CleanupResourceKind;
    readonly clock?: CleanupClock;
    readonly allowExitCodes?: readonly number[];
  },
): Promise<Result<CommandResult, SmokeFailure>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const spawn = options.spawn ?? defaultSpawn;
  const started = Result.fromThrowable(
    () => spawn(args, { cwd: options.cwd, env: options.env }),
    () => failure("CommandSpawnFailed", "could not start bounded command"),
  )();
  if (started.isErr()) return err(started.error);
  const child = started.value;
  const stdout = startBoundedReader(child.stdout, MAX_CAPTURE_BYTES);
  const stderr = startBoundedReader(child.stderr, MAX_CAPTURE_BYTES);
  const disposeReaders = () => {
    stdout.cancel();
    stderr.cancel();
  };
  const handle = processHandleFor(
    child,
    options.processKind ?? "helper",
    disposeReaders,
  );
  const unregister = options.resources?.registerProcess(handle);
  const processResult: Promise<Result<CommandResult, SmokeFailure>> =
    Promise.all([stdout.promise, stderr.promise, child.exited]).then(
      ([stdoutText, stderrText, code]) => {
        return ok({
          code,
          stdout: stdoutText,
          stderr: stderrText,
          timedOut: false,
        });
      },
      () =>
        err(
          failure("CommandFailed", "bounded command exited without a status"),
        ),
    );
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let unregisterTimeoutTimer: (() => void) | undefined;
  const clearCommandTimeout = (): void => {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
    unregisterTimeoutTimer?.();
    unregisterTimeoutTimer = undefined;
  };
  const timeoutResult = new Promise<"timeout">((resolveTimeout) => {
    timeoutHandle = setTimeout(() => resolveTimeout("timeout"), timeoutMs);
    unregisterTimeoutTimer = options.resources?.registerTimer(() => {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
    });
  });
  const winner = await Promise.race([processResult, timeoutResult]);
  clearCommandTimeout();
  if (winner === "timeout") {
    disposeReaders();
    const clock = options.clock ?? createCleanupClock();
    const terminated = await terminateHandle(handle, clock);
    if (terminated) {
      unregister?.();
    }
    if (!terminated) return err(failure("CleanupFailed", "process-survivor"));
    return err(
      failure(
        "CommandTimeout",
        `bounded command exceeded ${timeoutMs}ms: ${basename(args[0] ?? "command")}`,
      ),
    );
  }
  disposeReaders();
  if (winner.isErr()) {
    if (options.resources === undefined) unregister?.();
    return err(winner.error);
  }
  unregister?.();
  if (
    winner.value.code !== 0 &&
    !(options.allowExitCodes ?? []).includes(winner.value.code)
  ) {
    return err(
      failure(
        "CommandFailed",
        `${basename(args[0] ?? "command")} exited ${winner.value.code}: ${safeDiagnostic(`${winner.value.stdout} ${winner.value.stderr}`)}`,
      ),
    );
  }
  return ok(winner.value);
}

export interface CleanupSignalSource {
  on(signal: "SIGINT" | "SIGTERM", handler: () => void): () => void;
}

export async function runWithCleanup<T, E>(input: {
  readonly action: () => Promise<Result<T, E>>;
  readonly cleanup: () => Promise<Result<unknown, SmokeFailure>>;
  readonly signals?: CleanupSignalSource;
}): Promise<Result<T, E | SmokeFailure>> {
  let signalCleanup: Promise<Result<unknown, SmokeFailure>> | undefined;
  const requestCleanup = (): void => {
    if (signalCleanup !== undefined) return;
    signalCleanup = (async () => {
      const result = await ResultAsync.fromThrowable(input.cleanup, () =>
        failure("CleanupFailed", "resource-dispose-failed"),
      )();
      return result.isErr() ? err(result.error) : result.value;
    })();
  };
  const unregisterSignals =
    input.signals === undefined
      ? []
      : (["SIGINT", "SIGTERM"] as const).map((signal) =>
          input.signals?.on(signal, requestCleanup),
        );
  let actionResult: Result<T, E>;
  try {
    actionResult = await input.action();
  } catch (caught) {
    actionResult = err(caught as E);
  } finally {
    for (const unregister of unregisterSignals) unregister?.();
  }
  if (signalCleanup === undefined) requestCleanup();
  if (signalCleanup === undefined)
    return err(failure("CleanupFailed", "resource-dispose-failed"));
  const cleanupResult = await signalCleanup;
  if (cleanupResult.isErr()) return err(cleanupResult.error);
  return actionResult.isOk() ? ok(actionResult.value) : err(actionResult.error);
}
