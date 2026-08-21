export type BoundedProcessFailureCode =
  | "overflow"
  | "cleanup-failed"
  | "spawn-failed"
  | "timeout";

export interface BoundedProcessFailure {
  readonly code: BoundedProcessFailureCode;
}

export function boundedProcessFailure(
  code: BoundedProcessFailureCode,
): BoundedProcessFailure {
  return { code };
}

export type ProcessByteStream = ReadableStream<Uint8Array<ArrayBuffer>>;

export type BoundedProcessStreamName = "stdout" | "stderr";
export type BoundedProcessSignal = "SIGTERM" | "SIGKILL";

/** The process fields required before a bounded runner can start reading. */
export interface BoundedProcessSpawnInput {
  readonly cmd: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** The small writable surface needed to send one bounded request to a child. */
export interface BoundedProcessStdin {
  readonly write: (chunk: string) => number | PromiseLike<number> | undefined;
  readonly flush?: () => number | PromiseLike<number> | undefined;
}

/** A Bun process shape that is also easy to exercise with a fake process. */
export interface BoundedProcess {
  readonly stdin?: BoundedProcessStdin | number | null;
  readonly stdout?: ProcessByteStream | number | null;
  readonly stderr?: ProcessByteStream | number | null;
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

/** Deadlines and capture limits shared by every bounded process run. */
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

export interface BoundedProcessRunnerInput extends BoundedProcessSpawnInput {
  readonly stdin?: "ignore" | "pipe";
  /** Optional one-shot input. The runner writes and flushes it in-bounds. */
  readonly stdinText?: string;
  readonly limits?: Partial<BoundedProcessLimits>;
  /** Test seam; production uses Bun.spawn. */
  readonly spawn?: () => BoundedProcess | PromiseLike<BoundedProcess>;
  /** Called for bounded complete lines. Returning true stops the process. */
  readonly onLine?: (
    stream: BoundedProcessStreamName,
    line: string,
  ) => boolean | undefined;
}
