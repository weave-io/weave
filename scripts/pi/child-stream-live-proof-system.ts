import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import type { LiveProofFailureCode } from "./child-stream-live-proof-contract.js";

/**
 * The production live proof touches processes, the filesystem, the clock, and
 * the environment. Every one of those effects crosses this boundary so the
 * command can be tested without a host, and so no host string can reach the
 * report: each method fails with a closed code only.
 */
export interface LiveProofSystemFailure {
  readonly code: LiveProofFailureCode;
}

export function systemFailure(
  code: LiveProofFailureCode,
): LiveProofSystemFailure {
  return { code };
}

export type LiveProofPathKind = "missing" | "file" | "symlink" | "other";

export interface LiveProofSpawnInput {
  readonly cmd: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * A started process. `lines` yields stdout/stderr text lines; the caller owns
 * the iteration deadline. No method returns host error text.
 */
export interface LiveProofProcess {
  readonly writeLine: (line: string) => Result<void, LiveProofSystemFailure>;
  readonly lines: () => AsyncIterable<string>;
  readonly terminate: () => ResultAsync<void, LiveProofSystemFailure>;
  readonly running: () => boolean;
}

/** A cancellable timer owned by the injectable live-proof system. */
export interface LiveProofTimer {
  readonly cancel: () => void;
}

export interface LiveProofCommandOutput {
  readonly exitCode: number;
  readonly stdout: string;
}

export interface LiveProofSystem {
  readonly now: () => number;
  /** Schedule a real deadline without coupling it to stream output. */
  readonly setTimer: (callback: () => void, delayMs: number) => LiveProofTimer;
  readonly environment: () => Readonly<Record<string, string>>;
  readonly temporaryRoot: () => string;
  readonly uniqueToken: () => string;
  readonly spawn: (
    input: LiveProofSpawnInput,
  ) => Result<LiveProofProcess, LiveProofSystemFailure>;
  readonly run: (input: {
    readonly cmd: readonly string[];
    readonly cwd: string;
  }) => ResultAsync<LiveProofCommandOutput, LiveProofSystemFailure>;
  readonly makeDirectory: (
    path: string,
  ) => ResultAsync<void, LiveProofSystemFailure>;
  readonly writeText: (
    path: string,
    text: string,
  ) => ResultAsync<void, LiveProofSystemFailure>;
  readonly readBytes: (
    path: string,
  ) => ResultAsync<Uint8Array, LiveProofSystemFailure>;
  readonly writeBytes: (
    path: string,
    bytes: Uint8Array,
  ) => ResultAsync<void, LiveProofSystemFailure>;
  /** Create `path` only if it does not exist, with owner-only permissions. */
  readonly createPrivateFile: (
    path: string,
  ) => ResultAsync<void, LiveProofSystemFailure>;
  readonly renamePath: (
    from: string,
    to: string,
  ) => ResultAsync<void, LiveProofSystemFailure>;
  readonly removePath: (
    path: string,
  ) => ResultAsync<void, LiveProofSystemFailure>;
  readonly pathKind: (
    path: string,
  ) => ResultAsync<LiveProofPathKind, LiveProofSystemFailure>;
  readonly delay: (ms: number) => ResultAsync<void, LiveProofSystemFailure>;
}

const MAX_GUARDED_BYTES = 1024 * 1024;

/** Hard bounds for process output retained by the live-proof reader. */
export const MAX_LIVE_PROOF_LINE_BYTES = 64 * 1024;
export const MAX_LIVE_PROOF_UNDECODED_BUFFER_BYTES = 64 * 1024;
export const MAX_LIVE_PROOF_QUEUED_LINES_PER_STREAM = 256;
export const MAX_LIVE_PROOF_QUEUED_BYTES_PER_STREAM = 512 * 1024;
export const MAX_LIVE_PROOF_TOTAL_QUEUED_LINES =
  MAX_LIVE_PROOF_QUEUED_LINES_PER_STREAM * 2;
export const MAX_LIVE_PROOF_TOTAL_QUEUED_BYTES = 1024 * 1024;

/** The only stream failure that is allowed to cross the process boundary. */
export const LIVE_PROOF_STREAM_OVERFLOW = Symbol("live-proof-stream-overflow");

export function isLiveProofStreamOverflow(
  value: unknown,
): value is typeof LIVE_PROOF_STREAM_OVERFLOW {
  return value === LIVE_PROOF_STREAM_OVERFLOW;
}

/** Drop credential-shaped variables before any spawned proof process. */
export function safeProofEnvironment(
  source: Readonly<Record<string, string>>,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE)/iu.test(key)) {
      continue;
    }
    output[key] = value;
  }
  return output;
}

function currentEnvironment(): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (typeof value === "string") output[key] = value;
  }
  return output;
}

type ProcessByteStream = ReadableStream<Uint8Array<ArrayBuffer>>;

type BoundedProcessStreamName = "stdout" | "stderr";
type BoundedProcessSignal = "SIGTERM" | "SIGKILL";

/** A Bun process shape that is also easy to exercise with a fake process. */
export interface BoundedProcess {
  readonly stdout?: ProcessByteStream | number;
  readonly stderr?: ProcessByteStream | number;
  readonly exited: PromiseLike<number>;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly kill: (signal: BoundedProcessSignal) => unknown;
}

export interface BoundedProcessLimits {
  readonly spawnMs: number;
  readonly firstOutputMs: number;
  readonly totalReadMs: number;
  readonly gracefulTermMs: number;
  readonly postKillMs: number;
  readonly cleanupMs: number;
  readonly maxCaptureBytes: number;
}

/** Deadlines and capture limits shared by every non-interactive verifier run. */
export const DEFAULT_BOUNDED_PROCESS_LIMITS: BoundedProcessLimits =
  Object.freeze({
    spawnMs: 1_000,
    firstOutputMs: 5_000,
    totalReadMs: 20_000,
    gracefulTermMs: 1_000,
    postKillMs: 1_000,
    cleanupMs: 3_000,
    maxCaptureBytes: 32 * 1024,
  });

export interface BoundedProcessOutput {
  readonly exitCode: number;
  /** Only stdout is returned. Stderr is drained and discarded. */
  readonly stdout: string;
}

export interface BoundedProcessRunnerInput {
  readonly cmd: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: "ignore" | "pipe";
  readonly limits?: Partial<BoundedProcessLimits>;
  /** Test seam; production uses Bun.spawn. */
  readonly spawn?: () => BoundedProcess | PromiseLike<BoundedProcess>;
  /** Called for bounded complete lines. Returning true stops the process. */
  readonly onLine?: (
    stream: BoundedProcessStreamName,
    line: string,
  ) => boolean | undefined;
}

interface BoundedPendingLine {
  readonly stream: BoundedProcessStreamName;
  readonly value: string;
  readonly bytes: number;
}

type BoundedWaitOutcome<T> =
  | { readonly kind: "resolved"; readonly value: T }
  | { readonly kind: "rejected" }
  | { readonly kind: "timeout" };

type BoundedTerminal =
  | { readonly kind: "normal" }
  | { readonly kind: "stop" }
  | { readonly kind: "failure"; readonly failure: LiveProofSystemFailure };

interface BoundedReaderState {
  readonly name: BoundedProcessStreamName;
  readonly stream: ProcessByteStream;
  readonly lineBuffer: Uint8Array;
  reader?: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>;
  cancelRequested: boolean;
  lineBytes: number;
  queuedLines: number;
  queuedBytes: number;
}

interface BoundedRunnerState {
  readonly input: BoundedProcessRunnerInput;
  readonly limits: BoundedProcessLimits;
  readonly readers: BoundedReaderState[];
  readonly queue: BoundedPendingLine[];
  readonly pumpPromises: Promise<void>[];
  closed: boolean;
  openReaders: number;
  totalReadBytes: number;
  totalQueuedLines: number;
  totalQueuedBytes: number;
  stdout: string;
  stdoutBytes: number;
  firstOutputSeen: boolean;
  exitOutcome?: BoundedWaitOutcome<number>;
  consumerDone: boolean;
  terminal?: BoundedTerminal;
  wake?: () => void;
  resolveTerminal?: (terminal: BoundedTerminal) => void;
}

const MAX_BOUNDED_PROCESS_TOTAL_READ_BYTES =
  MAX_LIVE_PROOF_TOTAL_QUEUED_BYTES * 2;

function normalizedBoundedProcessLimits(
  supplied: Partial<BoundedProcessLimits> | undefined,
): BoundedProcessLimits {
  const defaults = DEFAULT_BOUNDED_PROCESS_LIMITS;
  const positive = (value: number | undefined, fallback: number): number =>
    value !== undefined && Number.isFinite(value) && value > 0
      ? value
      : fallback;
  return {
    spawnMs: positive(supplied?.spawnMs, defaults.spawnMs),
    firstOutputMs: positive(supplied?.firstOutputMs, defaults.firstOutputMs),
    totalReadMs: positive(supplied?.totalReadMs, defaults.totalReadMs),
    gracefulTermMs: positive(supplied?.gracefulTermMs, defaults.gracefulTermMs),
    postKillMs: positive(supplied?.postKillMs, defaults.postKillMs),
    cleanupMs: positive(supplied?.cleanupMs, defaults.cleanupMs),
    maxCaptureBytes: positive(
      supplied?.maxCaptureBytes,
      defaults.maxCaptureBytes,
    ),
  };
}

/**
 * Observe a promise and an independent timer. The losing promise always has
 * a rejection handler, so a late host failure cannot become an unhandled
 * rejection after the process boundary has closed.
 */
function observeBoundedPromise<T>(
  promiseLike: PromiseLike<T>,
  timeoutMs?: number,
): Promise<BoundedWaitOutcome<T>> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: BoundedWaitOutcome<T>): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(outcome);
    };

    if (timeoutMs !== undefined) {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        finish({ kind: "timeout" });
        return;
      }
      timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    }
    const observed = Result.fromThrowable(
      () => Promise.resolve(promiseLike),
      () => undefined,
    )();
    if (observed.isErr()) {
      finish({ kind: "rejected" });
      return;
    }
    observed.value.then(
      (value) => finish({ kind: "resolved", value }),
      () => finish({ kind: "rejected" }),
    );
  });
}

function processAlreadyExited(process: BoundedProcess): boolean {
  const inspected = Result.fromThrowable(
    () => process.exitCode !== null || process.signalCode !== null,
    () => false,
  )();
  return inspected.isOk() && inspected.value;
}

function signalProcess(
  process: BoundedProcess,
  signal: BoundedProcessSignal,
  timeoutMs: number,
): Promise<boolean> {
  const sent = Result.fromThrowable(
    () => process.kill(signal),
    () => undefined,
  )();
  if (sent.isErr()) return Promise.resolve(false);
  if (sent.value === undefined || sent.value === null) {
    return Promise.resolve(true);
  }
  const promise = Result.fromThrowable(
    () => Promise.resolve(sent.value),
    () => undefined,
  )();
  if (promise.isErr()) return Promise.resolve(false);
  return observeBoundedPromise(promise.value, timeoutMs).then(
    (outcome) => outcome.kind === "resolved",
    () => false,
  );
}

async function waitForBoundedProcessExit(
  process: BoundedProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (processAlreadyExited(process)) return true;
  const exited = Result.fromThrowable(
    () => process.exited,
    () => undefined,
  )();
  if (exited.isErr()) return false;
  const outcome = await observeBoundedPromise(exited.value, timeoutMs);
  return outcome.kind === "resolved";
}

/** TERM, then KILL, with an independent bounded wait for each phase. */
async function terminateBoundedProcess(
  process: BoundedProcess,
  limits: BoundedProcessLimits,
): Promise<boolean> {
  if (await waitForBoundedProcessExit(process, 0)) return true;
  await signalProcess(process, "SIGTERM", limits.gracefulTermMs);
  if (await waitForBoundedProcessExit(process, limits.gracefulTermMs)) {
    return true;
  }
  await signalProcess(process, "SIGKILL", limits.postKillMs);
  return waitForBoundedProcessExit(process, limits.postKillMs);
}

function notifyBoundedRunner(state: BoundedRunnerState): void {
  const pending = state.wake;
  state.wake = undefined;
  pending?.();
}

function maybeFinishBoundedRunner(state: BoundedRunnerState): void {
  if (
    state.terminal === undefined &&
    state.exitOutcome?.kind === "resolved" &&
    state.openReaders <= 0 &&
    state.consumerDone &&
    state.queue.length === 0
  ) {
    finishBoundedRunner(state, { kind: "normal" });
  }
}

function clearBoundedQueue(state: BoundedRunnerState): void {
  state.queue.length = 0;
  state.totalQueuedLines = 0;
  state.totalQueuedBytes = 0;
  for (const reader of state.readers) {
    reader.queuedLines = 0;
    reader.queuedBytes = 0;
  }
}

function finishBoundedRunner(
  state: BoundedRunnerState,
  terminal: BoundedTerminal,
): void {
  if (state.terminal !== undefined) return;
  state.terminal = terminal;
  state.closed = true;
  clearBoundedQueue(state);
  notifyBoundedRunner(state);
  state.resolveTerminal?.(terminal);
}

function finishBoundedLine(
  state: BoundedRunnerState,
  reader: BoundedReaderState,
): boolean {
  let contentBytes = reader.lineBytes;
  if (contentBytes > 0 && reader.lineBuffer[contentBytes - 1] === 0x0d) {
    contentBytes -= 1;
  }
  const decoded = Result.fromThrowable(
    () =>
      new TextDecoder("utf-8", { fatal: true }).decode(
        reader.lineBuffer.subarray(0, contentBytes),
      ),
    () => undefined,
  )();
  reader.lineBytes = 0;
  if (decoded.isErr()) {
    finishBoundedRunner(state, {
      kind: "failure",
      failure: systemFailure("spawn-failed"),
    });
    return false;
  }
  const bytes = contentBytes;
  if (
    reader.queuedLines >= MAX_LIVE_PROOF_QUEUED_LINES_PER_STREAM ||
    reader.queuedBytes > MAX_LIVE_PROOF_QUEUED_BYTES_PER_STREAM - bytes ||
    state.totalQueuedLines >= MAX_LIVE_PROOF_TOTAL_QUEUED_LINES ||
    state.totalQueuedBytes > MAX_LIVE_PROOF_TOTAL_QUEUED_BYTES - bytes
  ) {
    finishBoundedRunner(state, {
      kind: "failure",
      failure: systemFailure("spawn-failed"),
    });
    return false;
  }
  state.queue.push({ stream: reader.name, value: decoded.value, bytes });
  reader.queuedLines += 1;
  reader.queuedBytes += bytes;
  state.totalQueuedLines += 1;
  state.totalQueuedBytes += bytes;
  notifyBoundedRunner(state);
  return true;
}

function consumeBoundedChunk(
  state: BoundedRunnerState,
  reader: BoundedReaderState,
  chunk: Uint8Array<ArrayBuffer>,
): void {
  if (chunk.byteLength === 0 || state.closed) return;
  if (
    state.totalReadBytes >
    MAX_BOUNDED_PROCESS_TOTAL_READ_BYTES - chunk.byteLength
  ) {
    finishBoundedRunner(state, {
      kind: "failure",
      failure: systemFailure("spawn-failed"),
    });
    return;
  }
  state.totalReadBytes += chunk.byteLength;
  if (!state.firstOutputSeen) state.firstOutputSeen = true;
  for (let index = 0; index < chunk.byteLength; index += 1) {
    if (state.closed) return;
    const byte = chunk[index];
    if (byte === 0x0a) {
      if (!finishBoundedLine(state, reader)) return;
      continue;
    }
    if (
      reader.lineBytes >= MAX_LIVE_PROOF_LINE_BYTES ||
      reader.lineBytes >= MAX_LIVE_PROOF_UNDECODED_BUFFER_BYTES
    ) {
      finishBoundedRunner(state, {
        kind: "failure",
        failure: systemFailure("spawn-failed"),
      });
      return;
    }
    reader.lineBuffer[reader.lineBytes] = byte ?? 0;
    reader.lineBytes += 1;
  }
}

async function boundedPump(
  state: BoundedRunnerState,
  reader: BoundedReaderState,
): Promise<void> {
  const acquired = Result.fromThrowable(
    () => reader.stream.getReader(),
    () => undefined,
  )();
  if (acquired.isErr()) {
    state.openReaders -= 1;
    finishBoundedRunner(state, {
      kind: "failure",
      failure: systemFailure("spawn-failed"),
    });
    notifyBoundedRunner(state);
    return;
  }
  reader.reader = acquired.value;
  try {
    while (!state.closed) {
      const next = await reader.reader.read();
      if (next.done) {
        if (reader.lineBytes > 0) finishBoundedLine(state, reader);
        break;
      }
      consumeBoundedChunk(state, reader, next.value);
    }
  } catch {
    if (!state.closed) {
      finishBoundedRunner(state, {
        kind: "failure",
        failure: systemFailure("spawn-failed"),
      });
    }
  } finally {
    Result.fromThrowable(
      () => reader.reader?.releaseLock(),
      () => undefined,
    )();
    reader.reader = undefined;
    state.openReaders -= 1;
    notifyBoundedRunner(state);
    maybeFinishBoundedRunner(state);
  }
}

async function consumeBoundedQueue(state: BoundedRunnerState): Promise<void> {
  const encoder = new TextEncoder();
  while (!state.closed) {
    const next = state.queue.shift();
    if (next !== undefined) {
      const reader = state.readers.find(
        (candidate) => candidate.name === next.stream,
      );
      if (reader !== undefined) {
        reader.queuedLines -= 1;
        reader.queuedBytes -= next.bytes;
      }
      state.totalQueuedLines -= 1;
      state.totalQueuedBytes -= next.bytes;
      if (next.stream === "stdout") {
        const suffix = `${next.value}\n`;
        const bytes = encoder.encode(suffix).byteLength;
        if (state.stdoutBytes > state.limits.maxCaptureBytes - bytes) {
          finishBoundedRunner(state, {
            kind: "failure",
            failure: systemFailure("spawn-failed"),
          });
          break;
        }
        state.stdout += suffix;
        state.stdoutBytes += bytes;
      }
      const callback = state.input.onLine;
      if (callback !== undefined) {
        const called = Result.fromThrowable(
          () => callback(next.stream, next.value),
          () => undefined,
        )();
        if (called.isErr()) {
          finishBoundedRunner(state, {
            kind: "failure",
            failure: systemFailure("spawn-failed"),
          });
          break;
        }
        if (called.value === true) {
          finishBoundedRunner(state, { kind: "stop" });
          break;
        }
      }
      continue;
    }
    if (state.openReaders <= 0) break;
    await new Promise<void>((resolveWake) => {
      state.wake = resolveWake;
      if (state.closed || state.queue.length > 0 || state.openReaders <= 0) {
        state.wake = undefined;
        resolveWake();
      }
    });
  }
  state.consumerDone = true;
  notifyBoundedRunner(state);
  maybeFinishBoundedRunner(state);
}

async function closeBoundedReaders(
  state: BoundedRunnerState,
): Promise<boolean> {
  state.closed = true;
  clearBoundedQueue(state);
  notifyBoundedRunner(state);
  const cancellations: Promise<BoundedWaitOutcome<unknown>>[] = [];
  let cancellationFailure = false;
  for (const reader of state.readers) {
    if (reader.reader === undefined || reader.cancelRequested) continue;
    reader.cancelRequested = true;
    const cancelled = Result.fromThrowable(
      () => reader.reader?.cancel(),
      () => undefined,
    )();
    if (cancelled.isErr()) {
      cancellationFailure = true;
      continue;
    }
    if (cancelled.value === undefined) continue;
    const observed = Result.fromThrowable(
      () => Promise.resolve(cancelled.value),
      () => undefined,
    )();
    if (observed.isErr()) return false;
    cancellations.push(
      observeBoundedPromise(observed.value, state.limits.cleanupMs),
    );
  }
  const outcomes = await Promise.all(cancellations);
  return (
    !cancellationFailure &&
    outcomes.every((outcome) => outcome.kind === "resolved")
  );
}

async function observeBoundedBackgroundPromises(
  state: BoundedRunnerState,
): Promise<boolean> {
  if (state.pumpPromises.length === 0) return true;
  const allPumps = Result.fromThrowable(
    () => Promise.all(state.pumpPromises),
    () => undefined,
  )();
  if (allPumps.isErr()) return false;
  const outcome = await observeBoundedPromise(
    allPumps.value,
    state.limits.cleanupMs,
  );
  return outcome.kind === "resolved";
}

async function runBoundedProcessValue(
  input: BoundedProcessRunnerInput,
): Promise<Result<BoundedProcessOutput, LiveProofSystemFailure>> {
  const limits = normalizedBoundedProcessLimits(input.limits);
  const spawned = Result.fromThrowable(
    () =>
      input.spawn?.() ??
      Bun.spawn({
        cmd: [...input.cmd],
        cwd: input.cwd,
        env: { ...input.env },
        stdin: input.stdin ?? "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    () => systemFailure("spawn-failed"),
  )();
  if (spawned.isErr()) return err(spawned.error);
  const spawnedPromise = Result.fromThrowable(
    () => Promise.resolve(spawned.value),
    () => undefined,
  )();
  if (spawnedPromise.isErr()) return err(systemFailure("spawn-failed"));
  const started = await observeBoundedPromise(
    spawnedPromise.value,
    limits.spawnMs,
  );
  if (started.kind !== "resolved") {
    return err(
      systemFailure(started.kind === "timeout" ? "timeout" : "spawn-failed"),
    );
  }
  const process = started.value;
  const streams = Result.fromThrowable(
    () => [process.stdout, process.stderr],
    () => undefined,
  )();
  if (
    streams.isErr() ||
    streams.value[0] === undefined ||
    streams.value[1] === undefined ||
    typeof streams.value[0] === "number" ||
    typeof streams.value[1] === "number"
  ) {
    const terminated = await terminateBoundedProcess(process, limits);
    return terminated
      ? err(systemFailure("spawn-failed"))
      : err(systemFailure("cleanup-failed"));
  }

  const state: BoundedRunnerState = {
    input: { ...input, limits },
    limits,
    readers: [
      {
        name: "stdout",
        stream: streams.value[0],
        lineBuffer: new Uint8Array(MAX_LIVE_PROOF_UNDECODED_BUFFER_BYTES),
        cancelRequested: false,
        lineBytes: 0,
        queuedLines: 0,
        queuedBytes: 0,
      },
      {
        name: "stderr",
        stream: streams.value[1],
        lineBuffer: new Uint8Array(MAX_LIVE_PROOF_UNDECODED_BUFFER_BYTES),
        cancelRequested: false,
        lineBytes: 0,
        queuedLines: 0,
        queuedBytes: 0,
      },
    ],
    queue: [],
    pumpPromises: [],
    closed: false,
    openReaders: 2,
    totalReadBytes: 0,
    totalQueuedLines: 0,
    totalQueuedBytes: 0,
    stdout: "",
    stdoutBytes: 0,
    firstOutputSeen: false,
    consumerDone: false,
  };
  const terminal = new Promise<BoundedTerminal>((resolveTerminal) => {
    state.resolveTerminal = resolveTerminal;
  });
  const firstOutputTimer = setTimeout(() => {
    if (!state.firstOutputSeen) {
      finishBoundedRunner(state, {
        kind: "failure",
        failure: systemFailure("timeout"),
      });
    }
  }, limits.firstOutputMs);
  const totalReadTimer = setTimeout(
    () =>
      finishBoundedRunner(state, {
        kind: "failure",
        failure: systemFailure("timeout"),
      }),
    limits.totalReadMs,
  );

  const processExited = Result.fromThrowable(
    () => process.exited,
    () => undefined,
  )();
  const processExit = processExited.isErr()
    ? Promise.resolve<BoundedWaitOutcome<number>>({ kind: "rejected" })
    : observeBoundedPromise(processExited.value);
  const observedExit = processExit.then((outcome) => {
    if (state.terminal !== undefined) return;
    state.exitOutcome = outcome;
    if (outcome.kind === "rejected" || outcome.kind === "timeout") {
      finishBoundedRunner(state, {
        kind: "failure",
        failure: systemFailure("timeout"),
      });
      return;
    }
    maybeFinishBoundedRunner(state);
  });
  const observedExitSafe = observedExit.catch(() => {
    finishBoundedRunner(state, {
      kind: "failure",
      failure: systemFailure("spawn-failed"),
    });
  });

  const consumer = consumeBoundedQueue(state);
  const observedConsumer = consumer.catch(() => {
    finishBoundedRunner(state, {
      kind: "failure",
      failure: systemFailure("spawn-failed"),
    });
  });

  for (const reader of state.readers) {
    const pump = boundedPump(state, reader);
    const observedPump = pump.catch(() => {
      finishBoundedRunner(state, {
        kind: "failure",
        failure: systemFailure("spawn-failed"),
      });
    });
    state.pumpPromises.push(observedPump);
  }

  // The terminal promise has a timer and every reader/exit promise has an
  // observer. It cannot remain pending after a bounded failure or process exit.
  const finalTerminal = await terminal;
  clearTimeout(firstOutputTimer);
  clearTimeout(totalReadTimer);
  const shouldTerminate = finalTerminal.kind !== "normal";
  const closePromise = closeBoundedReaders(state);
  const terminationPromise = shouldTerminate
    ? terminateBoundedProcess(process, limits)
    : Promise.resolve(true);
  const cleanupPromises = [
    observeBoundedPromise(closePromise, limits.cleanupMs),
    observeBoundedPromise(terminationPromise, limits.cleanupMs),
    observeBoundedPromise(observedExitSafe, limits.cleanupMs),
    observeBoundedPromise(observedConsumer, limits.cleanupMs),
    observeBoundedPromise(
      observeBoundedBackgroundPromises(state),
      limits.cleanupMs,
    ),
  ];
  const cleanupOutcomes = await Promise.all(cleanupPromises);
  const cleanupOk = cleanupOutcomes.every(
    (outcome) =>
      outcome.kind === "resolved" &&
      (typeof outcome.value !== "boolean" || outcome.value === true),
  );
  if (!cleanupOk) return err(systemFailure("cleanup-failed"));
  if (finalTerminal.kind === "failure") return err(finalTerminal.failure);
  const exitCode =
    state.exitOutcome?.kind === "resolved" ? state.exitOutcome.value : -1;
  return ok({ exitCode, stdout: state.stdout });
}

/**
 * Run one bounded, content-free subprocess. Both pipes are pumped from the
 * moment of spawn, and every timeout, reader failure, and cleanup failure is
 * translated to a closed `LiveProofSystemFailure` code.
 */
export function runBoundedProcess(
  input: BoundedProcessRunnerInput,
): ResultAsync<BoundedProcessOutput, LiveProofSystemFailure> {
  return ResultAsync.fromThrowable(
    () => runBoundedProcessValue(input),
    (): LiveProofSystemFailure => systemFailure("spawn-failed"),
  )().andThen((result) =>
    result.isOk() ? okAsync(result.value) : errAsync(result.error),
  );
}

/**
 * Read stdout and stderr as text lines. The returned iterator closes on
 * demand: `return()` cancels the readers and wakes a parked consumer instead
 * of waiting for output that a silent process may never produce.
 */
function readProcessLines(
  process: ReturnType<typeof Bun.spawn>,
): AsyncIterable<string> {
  const streams = [process.stdout, process.stderr].filter(
    (stream): stream is ProcessByteStream =>
      stream !== undefined && typeof stream !== "number",
  );
  type Reader = ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>;
  interface OutputStreamState {
    readonly stream: ProcessByteStream;
    readonly lineBuffer: Uint8Array;
    reader?: Reader;
    cancelRequested: boolean;
    lineBytes: number;
    queuedLines: number;
    queuedBytes: number;
  }
  interface PendingLine {
    readonly value: string;
    readonly bytes: number;
    readonly stream: OutputStreamState;
  }

  const states: OutputStreamState[] = streams.map((stream) => ({
    stream,
    // Keep raw bytes until a complete line arrives. This makes a split UTF-8
    // sequence bounded by the same byte budget as every other line.
    lineBuffer: new Uint8Array(MAX_LIVE_PROOF_UNDECODED_BUFFER_BYTES),
    cancelRequested: false,
    lineBytes: 0,
    queuedLines: 0,
    queuedBytes: 0,
  }));
  const queue: PendingLine[] = [];
  const encoder = new TextEncoder();
  let totalQueuedLines = 0;
  let totalQueuedBytes = 0;
  let totalReadBytes = 0;
  let closed = false;
  let overflowed = false;
  let open = states.length;
  let wake: (() => void) | undefined;

  const notify = (): void => {
    const pending = wake;
    wake = undefined;
    pending?.();
  };

  const clearQueue = (): void => {
    queue.length = 0;
    totalQueuedLines = 0;
    totalQueuedBytes = 0;
    for (const state of states) {
      state.queuedLines = 0;
      state.queuedBytes = 0;
    }
  };

  const cancelReader = (state: OutputStreamState): void => {
    const reader = state.reader;
    if (reader === undefined || state.cancelRequested) return;
    state.cancelRequested = true;
    const cancelled = Result.fromThrowable(
      () => reader.cancel(),
      () => undefined,
    )();
    if (cancelled.isOk()) {
      // Cancellation is best effort, but its rejection must always be
      // observed after an overflow or an explicit iterator close.
      void Promise.resolve(cancelled.value).catch(() => undefined);
    }
  };

  const signalOverflow = (): void => {
    if (overflowed) return;
    overflowed = true;
    closed = true;
    clearQueue();
    for (const state of states) cancelReader(state);
    notify();
  };

  const enqueue = (state: OutputStreamState, value: string): boolean => {
    const bytes = encoder.encode(value).byteLength;
    if (
      bytes > MAX_LIVE_PROOF_LINE_BYTES ||
      state.queuedLines >= MAX_LIVE_PROOF_QUEUED_LINES_PER_STREAM ||
      state.queuedBytes > MAX_LIVE_PROOF_QUEUED_BYTES_PER_STREAM - bytes ||
      totalQueuedLines >= MAX_LIVE_PROOF_TOTAL_QUEUED_LINES ||
      totalQueuedBytes > MAX_LIVE_PROOF_TOTAL_QUEUED_BYTES - bytes
    ) {
      signalOverflow();
      return false;
    }
    queue.push({ value, bytes, stream: state });
    state.queuedLines += 1;
    state.queuedBytes += bytes;
    totalQueuedLines += 1;
    totalQueuedBytes += bytes;
    return true;
  };

  const finishLine = (state: OutputStreamState): boolean => {
    let contentBytes = state.lineBytes;
    if (contentBytes > 0 && state.lineBuffer[contentBytes - 1] === 0x0d) {
      contentBytes -= 1;
    }
    const decoded = Result.fromThrowable(
      () =>
        new TextDecoder("utf-8", { fatal: true }).decode(
          state.lineBuffer.subarray(0, contentBytes),
        ),
      () => undefined,
    )();
    state.lineBytes = 0;
    if (decoded.isErr()) {
      signalOverflow();
      return false;
    }
    return enqueue(state, decoded.value);
  };

  const consumeChunk = (
    state: OutputStreamState,
    chunk: Uint8Array<ArrayBuffer>,
  ): void => {
    if (chunk.byteLength === 0 || closed) return;
    if (
      totalReadBytes >
      MAX_BOUNDED_PROCESS_TOTAL_READ_BYTES - chunk.byteLength
    ) {
      signalOverflow();
      return;
    }
    totalReadBytes += chunk.byteLength;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (closed) return;
      const byte = chunk[index];
      if (byte === 0x0a) {
        if (!finishLine(state)) return;
        continue;
      }
      if (
        state.lineBytes >= MAX_LIVE_PROOF_LINE_BYTES ||
        state.lineBytes >= MAX_LIVE_PROOF_UNDECODED_BUFFER_BYTES
      ) {
        signalOverflow();
        return;
      }
      state.lineBuffer[state.lineBytes] = byte ?? 0;
      state.lineBytes += 1;
    }
  };

  const pump = async (state: OutputStreamState): Promise<void> => {
    const acquired = Result.fromThrowable(
      () => state.stream.getReader(),
      () => undefined,
    )();
    if (acquired.isErr()) {
      open -= 1;
      notify();
      return;
    }
    const reader = acquired.value;
    state.reader = reader;
    if (closed) cancelReader(state);
    try {
      while (!closed) {
        const chunk = await reader.read();
        if (chunk.done || closed) break;
        consumeChunk(state, chunk.value);
        notify();
      }
    } finally {
      Result.fromThrowable(
        () => reader.releaseLock(),
        () => undefined,
      )();
      state.reader = undefined;
      open -= 1;
      notify();
    }
  };

  for (const state of states) {
    // A reader can reject after the caller has timed out or overflowed. Keep
    // that late host failure inside this closed stream boundary.
    void pump(state).catch(() => undefined);
  }

  const removeQueuedLine = (line: PendingLine): void => {
    line.stream.queuedLines -= 1;
    line.stream.queuedBytes -= line.bytes;
    totalQueuedLines -= 1;
    totalQueuedBytes -= line.bytes;
  };

  async function* iterate(): AsyncGenerator<string, void, undefined> {
    while (true) {
      const next = queue.shift();
      if (next !== undefined) {
        removeQueuedLine(next);
        yield next.value;
        continue;
      }
      if (overflowed) throw LIVE_PROOF_STREAM_OVERFLOW;
      if (closed || open <= 0) return;
      await new Promise<void>((resolveWake) => {
        wake = resolveWake;
        if (closed || overflowed || queue.length > 0 || open <= 0) {
          wake = undefined;
          resolveWake();
        }
      });
    }
  }

  const close = (
    inner: AsyncGenerator<string, void, undefined>,
  ): Promise<IteratorResult<string, void>> => {
    closed = true;
    clearQueue();
    for (const state of states) cancelReader(state);
    notify();
    return inner.return(undefined);
  };

  return {
    [Symbol.asyncIterator](): AsyncIterator<string, void, undefined> {
      const inner = iterate();
      return {
        next: () => inner.next(),
        return: () => close(inner),
      };
    },
  };
}

function bunSpawn(
  input: LiveProofSpawnInput,
): Result<LiveProofProcess, LiveProofSystemFailure> {
  const spawned = Result.fromThrowable(
    () =>
      Bun.spawn({
        cmd: [...input.cmd],
        cwd: input.cwd,
        env: { ...input.env },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }),
    (): LiveProofSystemFailure => systemFailure("spawn-failed"),
  )();
  if (spawned.isErr()) return err(spawned.error);
  const child = spawned.value;
  return Result.fromThrowable(
    (): LiveProofProcess => ({
      writeLine: (line) =>
        Result.fromThrowable(
          () => {
            const stdin = child.stdin;
            if (stdin === undefined || typeof stdin === "number") {
              throw new Error("no stdin");
            }
            stdin.write(`${line}\n`);
            stdin.flush();
          },
          (): LiveProofSystemFailure => systemFailure("spawn-failed"),
        )(),
      lines: () => readProcessLines(child),
      terminate: () =>
        ResultAsync.fromPromise(
          terminateBoundedProcess(child, DEFAULT_BOUNDED_PROCESS_LIMITS),
          (): LiveProofSystemFailure => systemFailure("cleanup-failed"),
        ).andThen((terminated) =>
          terminated
            ? okAsync<void, LiveProofSystemFailure>(undefined)
            : errAsync(systemFailure("cleanup-failed")),
        ),
      running: () => child.exitCode === null && child.signalCode === null,
    }),
    (): LiveProofSystemFailure => systemFailure("spawn-failed"),
  )();
}

function shell(
  operation: () => Promise<unknown>,
  code: LiveProofFailureCode,
): ResultAsync<void, LiveProofSystemFailure> {
  return ResultAsync.fromPromise(operation(), () => systemFailure(code)).map(
    () => undefined,
  );
}

/** Bun-backed system used by the real command. */
export function createLiveProofSystem(): LiveProofSystem {
  return {
    now: () => Date.now(),
    setTimer: (callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      let cancelled = false;
      return {
        cancel: () => {
          if (cancelled) return;
          cancelled = true;
          clearTimeout(handle);
        },
      };
    },
    environment: () => currentEnvironment(),
    temporaryRoot: () => tmpdir(),
    uniqueToken: () => crypto.randomUUID(),
    spawn: bunSpawn,
    run: (input) =>
      runBoundedProcess({
        cmd: input.cmd,
        cwd: input.cwd,
        env: safeProofEnvironment(currentEnvironment()),
      }).map(({ exitCode, stdout }) => ({ exitCode, stdout })),
    makeDirectory: (path) =>
      shell(() => $`mkdir -p ${path}`.quiet(), "spawn-failed"),
    writeText: (path, text) =>
      shell(() => Bun.write(path, text), "spawn-failed"),
    readBytes: (path) =>
      ResultAsync.fromPromise(
        Bun.file(path).arrayBuffer(),
        (): LiveProofSystemFailure => systemFailure("cleanup-failed"),
      ).andThen((bytes) =>
        bytes.byteLength > MAX_GUARDED_BYTES
          ? errAsync(systemFailure("cleanup-failed"))
          : okAsync(new Uint8Array(bytes)),
      ),
    writeBytes: (path, bytes) =>
      shell(() => Bun.write(path, bytes), "cleanup-failed"),
    // `set -C` plus `umask 077` is the portable owner-only exclusive create.
    // Bun's shell has no noclobber, so this runs in a real POSIX shell.
    createPrivateFile: (path) =>
      runBoundedProcess({
        cmd: [
          "/bin/sh",
          "-c",
          'umask 077; set -C; : > "$1"; chmod 600 "$1"',
          "sh",
          path,
        ],
        cwd: ".",
        env: safeProofEnvironment(currentEnvironment()),
      }).andThen(({ exitCode }) =>
        exitCode === 0
          ? okAsync<void, LiveProofSystemFailure>(undefined)
          : errAsync(systemFailure("report-invalid")),
      ),
    renamePath: (from, to) =>
      shell(() => $`mv -f ${from} ${to}`.quiet(), "report-invalid"),
    removePath: (path) =>
      shell(() => $`rm -rf ${path}`.quiet(), "cleanup-failed"),
    pathKind: (path) =>
      ResultAsync.fromPromise(
        (async () => {
          const link = await $`test -L ${path}`.quiet().nothrow();
          if (link.exitCode === 0) return "symlink" as const;
          const file = await $`test -f ${path}`.quiet().nothrow();
          if (file.exitCode === 0) return "file" as const;
          const exists = await $`test -e ${path}`.quiet().nothrow();
          return exists.exitCode === 0
            ? ("other" as const)
            : ("missing" as const);
        })(),
        (): LiveProofSystemFailure => systemFailure("report-invalid"),
      ),
    delay: (ms) =>
      ResultAsync.fromPromise(
        new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms)),
        (): LiveProofSystemFailure => systemFailure("timeout"),
      ),
  };
}

/** Join a workspace-relative name onto a live-proof temporary root. */
export function workspacePath(root: string, name: string): string {
  return join(root, name);
}
