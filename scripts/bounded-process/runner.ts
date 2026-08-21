import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import {
  type BoundedProcess,
  type BoundedProcessFailure,
  type BoundedProcessLimits,
  type BoundedProcessOutput,
  type BoundedProcessRunnerInput,
  type BoundedProcessSpawnInput,
  type BoundedProcessStreamName,
  boundedProcessFailure,
  type ProcessByteStream,
} from "./contract.js";
import {
  type BoundedWaitOutcome,
  normalizedBoundedProcessLimits,
  observeBoundedPromise,
  terminateBoundedProcess,
} from "./control.js";
import {
  MAX_BOUNDED_PROCESS_LINE_BYTES,
  MAX_BOUNDED_PROCESS_QUEUED_BYTES_PER_STREAM,
  MAX_BOUNDED_PROCESS_QUEUED_LINES_PER_STREAM,
  MAX_BOUNDED_PROCESS_TOTAL_QUEUED_BYTES,
  MAX_BOUNDED_PROCESS_TOTAL_QUEUED_LINES,
  MAX_BOUNDED_PROCESS_TOTAL_READ_BYTES,
  MAX_BOUNDED_PROCESS_UNDECODED_BUFFER_BYTES,
} from "./stream.js";

function spawnBunProcess(
  input: Pick<
    BoundedProcessRunnerInput,
    "cmd" | "cwd" | "env" | "stdin" | "stdinText"
  >,
): Result<BoundedProcess, BoundedProcessFailure> {
  return Result.fromThrowable(
    () =>
      Bun.spawn({
        cmd: [...input.cmd],
        cwd: input.cwd,
        env: { ...input.env },
        stdin:
          input.stdin ?? (input.stdinText === undefined ? "ignore" : "pipe"),
        stdout: "pipe",
        stderr: "pipe",
      }),
    () => boundedProcessFailure("spawn-failed"),
  )();
}

/**
 * Spawn the interactive process through the same Bun boundary as the
 * non-interactive runner. Its callers must use the bounded line reader and
 * bounded TERM/KILL termination helpers.
 */
export function spawnBoundedInteractiveProcess(
  input: BoundedProcessSpawnInput,
): Result<BoundedProcess, BoundedProcessFailure> {
  return spawnBunProcess({
    cmd: input.cmd,
    cwd: input.cwd,
    env: input.env,
    stdin: "pipe",
  });
}

interface BoundedPendingLine {
  readonly stream: BoundedProcessStreamName;
  readonly value: string;
  readonly bytes: number;
}

type BoundedTerminal =
  | { readonly kind: "normal" }
  | { readonly kind: "stop" }
  | { readonly kind: "failure"; readonly failure: BoundedProcessFailure };

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
  inputOutcome?: BoundedWaitOutcome<unknown>;
  consumerDone: boolean;
  terminal?: BoundedTerminal;
  wake?: () => void;
  resolveTerminal?: (terminal: BoundedTerminal) => void;
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
    state.inputOutcome?.kind === "resolved" &&
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
      failure: boundedProcessFailure("spawn-failed"),
    });
    return false;
  }
  const bytes = contentBytes;
  if (
    reader.queuedLines >= MAX_BOUNDED_PROCESS_QUEUED_LINES_PER_STREAM ||
    reader.queuedBytes > MAX_BOUNDED_PROCESS_QUEUED_BYTES_PER_STREAM - bytes ||
    state.totalQueuedLines >= MAX_BOUNDED_PROCESS_TOTAL_QUEUED_LINES ||
    state.totalQueuedBytes > MAX_BOUNDED_PROCESS_TOTAL_QUEUED_BYTES - bytes
  ) {
    finishBoundedRunner(state, {
      kind: "failure",
      failure: boundedProcessFailure("overflow"),
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
      failure: boundedProcessFailure("overflow"),
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
      reader.lineBytes >= MAX_BOUNDED_PROCESS_LINE_BYTES ||
      reader.lineBytes >= MAX_BOUNDED_PROCESS_UNDECODED_BUFFER_BYTES
    ) {
      finishBoundedRunner(state, {
        kind: "failure",
        failure: boundedProcessFailure("overflow"),
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
      failure: boundedProcessFailure("spawn-failed"),
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
        failure: boundedProcessFailure("spawn-failed"),
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
            failure: boundedProcessFailure("overflow"),
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
            failure: boundedProcessFailure("spawn-failed"),
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

function utf8PrefixForBytes(value: string, bytes: number): string | undefined {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return undefined;
  if (bytes === 0) return "";
  const encoder = new TextEncoder();
  let consumedBytes = 0;
  let consumedCodeUnits = 0;
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (consumedBytes > bytes - characterBytes) return undefined;
    consumedBytes += characterBytes;
    consumedCodeUnits += character.length;
    if (consumedBytes === bytes) return value.slice(0, consumedCodeUnits);
  }
  return undefined;
}

async function writeBoundedProcessInput(
  process: BoundedProcess,
  input: string,
  timeoutMs: number,
): Promise<BoundedWaitOutcome<unknown>> {
  if (input.length > MAX_BOUNDED_PROCESS_LINE_BYTES) {
    return { kind: "rejected" };
  }
  const encoded = new Uint8Array(MAX_BOUNDED_PROCESS_LINE_BYTES + 1);
  const measured = Result.fromThrowable(
    () => new TextEncoder().encodeInto(input, encoded),
    () => undefined,
  )();
  if (
    measured.isErr() ||
    measured.value.read !== input.length ||
    measured.value.written > MAX_BOUNDED_PROCESS_LINE_BYTES
  ) {
    return { kind: "rejected" };
  }
  const stdin = process.stdin;
  if (stdin === undefined || stdin === null || typeof stdin === "number") {
    return { kind: "rejected" };
  }
  const write = Result.fromThrowable(
    () =>
      (async () => {
        let offset = 0;
        while (offset < input.length) {
          const remaining = input.slice(offset);
          const accepted = await Promise.resolve(stdin.write(remaining));
          if (accepted === undefined) {
            offset = input.length;
          } else {
            const acceptedPrefix = utf8PrefixForBytes(remaining, accepted);
            if (acceptedPrefix === undefined || acceptedPrefix.length === 0) {
              throw new Error("bounded stdin write failed");
            }
            offset += acceptedPrefix.length;
          }
          if (stdin.flush !== undefined) {
            await Promise.resolve(stdin.flush());
          }
        }
      })(),
    () => undefined,
  )();
  if (write.isErr()) return { kind: "rejected" };
  return observeBoundedPromise(write.value, timeoutMs);
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

async function cancelLateProcessStream(
  stream: ProcessByteStream,
  timeoutMs: number,
): Promise<boolean> {
  const cancelled = Result.fromThrowable(
    () => stream.cancel(),
    () => undefined,
  )();
  if (cancelled.isErr()) return false;
  const observed = Result.fromThrowable(
    () => Promise.resolve(cancelled.value),
    () => undefined,
  )();
  if (observed.isErr()) return false;
  const outcome = await observeBoundedPromise(observed.value, timeoutMs);
  return outcome.kind === "resolved";
}

/**
 * A spawn deadline can win before the host hands us its process. Once that
 * process arrives, cancel both inherited pipes and terminate it in one
 * bounded, independently observed cleanup operation.
 */
async function cleanupLateBoundedProcess(
  process: BoundedProcess,
  limits: BoundedProcessLimits,
): Promise<boolean> {
  const streams = Result.fromThrowable(
    () => [process.stdout, process.stderr],
    () => undefined,
  )();
  const cancellations: Promise<boolean>[] = [];
  if (streams.isOk()) {
    for (const stream of streams.value) {
      if (stream === undefined || stream === null || typeof stream === "number")
        continue;
      cancellations.push(cancelLateProcessStream(stream, limits.cleanupMs));
    }
  }

  const termination = Result.fromThrowable(
    () => terminateBoundedProcess(process, limits),
    () => undefined,
  )();
  const observedTermination = termination.isErr()
    ? Promise.resolve(false)
    : observeBoundedPromise(termination.value, limits.cleanupMs).then(
        (outcome) => outcome.kind === "resolved" && outcome.value,
        () => false,
      );
  const outcomes = await Promise.all([
    ...cancellations.map((cancellation) =>
      cancellation.then(
        (result) => result,
        () => false,
      ),
    ),
    observedTermination,
  ]);
  return streams.isOk() && outcomes.every((outcome) => outcome);
}

async function runBoundedProcessValue(
  input: BoundedProcessRunnerInput,
): Promise<Result<BoundedProcessOutput, BoundedProcessFailure>> {
  const limits = normalizedBoundedProcessLimits(input.limits);
  const spawn = input.spawn;
  const spawned =
    spawn === undefined
      ? spawnBunProcess(input)
      : Result.fromThrowable(
          () => spawn(),
          () => boundedProcessFailure("spawn-failed"),
        )();
  if (spawned.isErr()) return err(spawned.error);
  const spawnedPromise = Result.fromThrowable(
    () => Promise.resolve(spawned.value),
    () => undefined,
  )();
  if (spawnedPromise.isErr()) return err(boundedProcessFailure("spawn-failed"));

  // Keep this continuation attached before the deadline race. A late
  // fulfillment owns a real process even though the caller has already
  // received its timeout, so it must be cleaned up independently. The
  // post-race check covers the narrow turn where both handlers run before the
  // await continuation records the timeout winner.
  let spawnRaceFinished = false;
  let spawnTimedOut = false;
  let lateProcess: BoundedProcess | undefined;
  let lateCleanupStarted = false;
  const startLateCleanup = (process: BoundedProcess): void => {
    if (lateCleanupStarted) return;
    lateCleanupStarted = true;
    const cleanup = Result.fromThrowable(
      () => cleanupLateBoundedProcess(process, limits),
      () => undefined,
    )();
    if (cleanup.isErr()) return;
    void cleanup.value.then(
      () => undefined,
      () => undefined,
    );
  };
  const spawnContinuation = spawnedPromise.value
    .then(
      (process) => {
        lateProcess = process;
        if (spawnRaceFinished && spawnTimedOut) startLateCleanup(process);
        return process;
      },
      () => undefined,
    )
    .catch(() => undefined);
  void spawnContinuation;

  const started = await observeBoundedPromise(
    spawnedPromise.value,
    limits.spawnMs,
  );
  spawnRaceFinished = true;
  if (started.kind === "timeout") {
    spawnTimedOut = true;
    if (lateProcess !== undefined) startLateCleanup(lateProcess);
  }
  if (started.kind !== "resolved") {
    return err(
      boundedProcessFailure(
        started.kind === "timeout" ? "timeout" : "spawn-failed",
      ),
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
    streams.value[0] === null ||
    streams.value[1] === undefined ||
    streams.value[1] === null ||
    typeof streams.value[0] === "number" ||
    typeof streams.value[1] === "number"
  ) {
    const terminated = await terminateBoundedProcess(process, limits);
    return terminated
      ? err(boundedProcessFailure("spawn-failed"))
      : err(boundedProcessFailure("cleanup-failed"));
  }

  const state: BoundedRunnerState = {
    input: { ...input, limits },
    limits,
    readers: [
      {
        name: "stdout",
        stream: streams.value[0],
        lineBuffer: new Uint8Array(MAX_BOUNDED_PROCESS_UNDECODED_BUFFER_BYTES),
        cancelRequested: false,
        lineBytes: 0,
        queuedLines: 0,
        queuedBytes: 0,
      },
      {
        name: "stderr",
        stream: streams.value[1],
        lineBuffer: new Uint8Array(MAX_BOUNDED_PROCESS_UNDECODED_BUFFER_BYTES),
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
    inputOutcome:
      input.stdinText === undefined
        ? { kind: "resolved", value: undefined }
        : undefined,
    consumerDone: false,
  };
  const terminal = new Promise<BoundedTerminal>((resolveTerminal) => {
    state.resolveTerminal = resolveTerminal;
  });
  const firstOutputTimer = setTimeout(() => {
    if (!state.firstOutputSeen) {
      finishBoundedRunner(state, {
        kind: "failure",
        failure: boundedProcessFailure("timeout"),
      });
    }
  }, limits.firstOutputMs);
  const totalReadTimer = setTimeout(
    () =>
      finishBoundedRunner(state, {
        kind: "failure",
        failure: boundedProcessFailure("timeout"),
      }),
    limits.totalReadMs,
  );

  const processExited = Result.fromThrowable(
    () => process.exited,
    () => undefined,
  )();
  const processExit = processExited.isErr()
    ? Promise.resolve<BoundedWaitOutcome<number>>({ kind: "rejected" })
    : observeBoundedPromise(processExited.value, limits.totalReadMs);
  const observedExit = processExit.then((outcome) => {
    if (state.terminal !== undefined) return;
    state.exitOutcome = outcome;
    if (outcome.kind === "rejected" || outcome.kind === "timeout") {
      finishBoundedRunner(state, {
        kind: "failure",
        failure: boundedProcessFailure("timeout"),
      });
      return;
    }
    maybeFinishBoundedRunner(state);
  });
  const observedExitSafe = observedExit.catch(() => {
    finishBoundedRunner(state, {
      kind: "failure",
      failure: boundedProcessFailure("spawn-failed"),
    });
  });

  const consumer = consumeBoundedQueue(state);
  const observedConsumer = consumer.catch(() => {
    finishBoundedRunner(state, {
      kind: "failure",
      failure: boundedProcessFailure("spawn-failed"),
    });
  });

  for (const reader of state.readers) {
    const pump = boundedPump(state, reader);
    const observedPump = pump.catch(() => {
      finishBoundedRunner(state, {
        kind: "failure",
        failure: boundedProcessFailure("spawn-failed"),
      });
    });
    state.pumpPromises.push(observedPump);
  }

  const inputPromise =
    input.stdinText === undefined
      ? Promise.resolve<BoundedWaitOutcome<unknown>>({
          kind: "resolved",
          value: undefined,
        })
      : writeBoundedProcessInput(process, input.stdinText, limits.spawnMs);
  const observedInput = inputPromise.then((outcome) => {
    state.inputOutcome = outcome;
    if (outcome.kind !== "resolved") {
      finishBoundedRunner(state, {
        kind: "failure",
        failure: boundedProcessFailure(
          outcome.kind === "timeout" ? "timeout" : "spawn-failed",
        ),
      });
      return;
    }
    maybeFinishBoundedRunner(state);
  });
  const observedInputSafe = observedInput.catch(() => {
    state.inputOutcome = { kind: "rejected" };
    finishBoundedRunner(state, {
      kind: "failure",
      failure: boundedProcessFailure("spawn-failed"),
    });
  });

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
    observeBoundedPromise(observedInputSafe, limits.cleanupMs),
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
  if (!cleanupOk) return err(boundedProcessFailure("cleanup-failed"));
  if (finalTerminal.kind === "failure") return err(finalTerminal.failure);
  const exitCode =
    state.exitOutcome?.kind === "resolved" ? state.exitOutcome.value : -1;
  return ok({ exitCode, stdout: state.stdout });
}

/**
 * Run one bounded, content-free subprocess. Both pipes are pumped from the
 * moment of spawn, and every timeout, reader failure, and cleanup failure is
 * translated to a closed `BoundedProcessFailure` code.
 */
export function runBoundedProcess(
  input: BoundedProcessRunnerInput,
): ResultAsync<BoundedProcessOutput, BoundedProcessFailure> {
  return ResultAsync.fromThrowable(
    () => runBoundedProcessValue(input),
    (): BoundedProcessFailure => boundedProcessFailure("spawn-failed"),
  )().andThen((result) =>
    result.isOk() ? okAsync(result.value) : errAsync(result.error),
  );
}
