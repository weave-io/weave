import type { Result, ResultAsync } from "neverthrow";
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

export type ProcessByteStream = ReadableStream<Uint8Array<ArrayBuffer>>;

export type BoundedProcessStreamName = "stdout" | "stderr";
export type BoundedProcessSignal = "SIGTERM" | "SIGKILL";

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
