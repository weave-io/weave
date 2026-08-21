import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import {
  DEFAULT_BOUNDED_PROCESS_LIMITS,
  runBoundedProcess,
} from "./child-stream-live-proof-system.js";
import {
  blocked,
  type VerifyChildStreamingFailure,
} from "./child-stream-verify-types.js";

const IDENTITY_PROBE_FILESYSTEM_LIMITS = {
  ...DEFAULT_BOUNDED_PROCESS_LIMITS,
  firstOutputMs: 1_000,
  totalReadMs: 5_000,
  maxCaptureBytes: 4 * 1024,
} as const;

type VerifierCommandOutput = {
  readonly exitCode: number;
  readonly stdout: string;
};

function verifierPath(): string {
  return typeof Bun.env.PATH === "string" ? Bun.env.PATH : "/usr/bin:/bin";
}

/**
 * The verifier's only process boundary. The shared live-proof runner owns
 * stream draining, byte/line limits, deadlines, termination, and cleanup.
 */
export function runVerifierProcess(
  input: Parameters<typeof runBoundedProcess>[0],
): ReturnType<typeof runBoundedProcess> {
  return runBoundedProcess(input);
}

export function runVerifierCommand(
  command: readonly string[],
  cwd: string,
): ResultAsync<VerifierCommandOutput, VerifyChildStreamingFailure> {
  return runVerifierProcess({
    cmd: command,
    cwd,
    env: { PATH: verifierPath() },
    limits: DEFAULT_BOUNDED_PROCESS_LIMITS,
  })
    .mapErr(() => blocked("probe-failed"))
    .map(({ exitCode, stdout }) => ({ exitCode, stdout }));
}

export function runIdentityProbeFilesystemCommand(
  command: readonly string[],
): ResultAsync<void, VerifyChildStreamingFailure> {
  return runVerifierProcess({
    cmd: command,
    cwd: ".",
    env: { PATH: verifierPath() },
    limits: IDENTITY_PROBE_FILESYSTEM_LIMITS,
  })
    .mapErr(() => blocked("probe-failed"))
    .andThen(({ exitCode }) =>
      exitCode === 0
        ? okAsync<void, VerifyChildStreamingFailure>(undefined)
        : errAsync(blocked("probe-failed")),
    );
}
