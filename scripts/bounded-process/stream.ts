import { Result } from "neverthrow";
import type { BoundedProcess, ProcessByteStream } from "./contract.js";

/** Hard bounds for process output retained by the bounded reader. */
export const MAX_BOUNDED_PROCESS_LINE_BYTES = 64 * 1024;
export const MAX_BOUNDED_PROCESS_UNDECODED_BUFFER_BYTES = 64 * 1024;
export const MAX_BOUNDED_PROCESS_QUEUED_LINES_PER_STREAM = 256;
export const MAX_BOUNDED_PROCESS_QUEUED_BYTES_PER_STREAM = 512 * 1024;
export const MAX_BOUNDED_PROCESS_TOTAL_QUEUED_LINES =
  MAX_BOUNDED_PROCESS_QUEUED_LINES_PER_STREAM * 2;
export const MAX_BOUNDED_PROCESS_TOTAL_QUEUED_BYTES = 1024 * 1024;

/** The only stream failure that is allowed to cross the process boundary. */
export const BOUNDED_PROCESS_STREAM_OVERFLOW = Symbol(
  "bounded-process-stream-overflow",
);

export function isBoundedProcessStreamOverflow(
  value: unknown,
): value is typeof BOUNDED_PROCESS_STREAM_OVERFLOW {
  return value === BOUNDED_PROCESS_STREAM_OVERFLOW;
}

/**
 * Keep the total bytes read bounded even when a child never emits a newline.
 * This is deliberately derived from the queue bound so the reader and runner
 * cannot drift apart.
 */
export const MAX_BOUNDED_PROCESS_TOTAL_READ_BYTES =
  MAX_BOUNDED_PROCESS_TOTAL_QUEUED_BYTES * 2;

/**
 * Read stdout and stderr as text lines. The returned iterator closes on
 * demand: `return()` cancels the readers and wakes a parked consumer instead
 * of waiting for output that a silent process may never produce.
 */
export function readProcessLines(
  process: Pick<BoundedProcess, "stdout" | "stderr">,
): AsyncIterable<string> {
  const streams = [process.stdout, process.stderr].filter(
    (stream): stream is ProcessByteStream =>
      stream !== undefined && stream !== null && typeof stream !== "number",
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
    lineBuffer: new Uint8Array(MAX_BOUNDED_PROCESS_UNDECODED_BUFFER_BYTES),
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
      bytes > MAX_BOUNDED_PROCESS_LINE_BYTES ||
      state.queuedLines >= MAX_BOUNDED_PROCESS_QUEUED_LINES_PER_STREAM ||
      state.queuedBytes > MAX_BOUNDED_PROCESS_QUEUED_BYTES_PER_STREAM - bytes ||
      totalQueuedLines >= MAX_BOUNDED_PROCESS_TOTAL_QUEUED_LINES ||
      totalQueuedBytes > MAX_BOUNDED_PROCESS_TOTAL_QUEUED_BYTES - bytes
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
        state.lineBytes >= MAX_BOUNDED_PROCESS_LINE_BYTES ||
        state.lineBytes >= MAX_BOUNDED_PROCESS_UNDECODED_BUFFER_BYTES
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
      if (overflowed) throw BOUNDED_PROCESS_STREAM_OVERFLOW;
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
