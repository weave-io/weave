import type { Result, ResultAsync } from "neverthrow";
import type { BoundedProcessSpawnInput } from "../bounded-process/contract.js";
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

export type LiveProofSpawnInput = BoundedProcessSpawnInput;

export type {
  BoundedProcess,
  BoundedProcessFailure,
  BoundedProcessFailureCode,
  BoundedProcessLimits,
  BoundedProcessOutput,
  BoundedProcessRunnerInput,
  BoundedProcessSignal,
  BoundedProcessSpawnInput,
  BoundedProcessStdin,
  BoundedProcessStreamName,
  ProcessByteStream,
} from "../bounded-process/contract.js";
export {
  boundedProcessFailure,
  DEFAULT_BOUNDED_PROCESS_LIMITS,
} from "../bounded-process/contract.js";
