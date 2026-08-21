import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from "neverthrow";
import {
  type BoundedProcessLimits,
  type BoundedProcessRunnerInput,
  DEFAULT_BOUNDED_PROCESS_LIMITS,
} from "./bounded-process/contract.js";
import { runBoundedProcess } from "./bounded-process/runner.js";
import type { PublicPackageBuildError } from "./build-public-packages-shared.js";

export const BUILD_GIT_PROCESS_LIMITS: BoundedProcessLimits = Object.freeze({
  ...DEFAULT_BOUNDED_PROCESS_LIMITS,
  firstOutputMs: 1_000,
  totalReadMs: 5_000,
  maxCaptureBytes: 4 * 1024,
});

export type GitBuildReason =
  | "git-subject-unavailable"
  | "git-state-unavailable";

export type GitProcessOptions = {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly limits?: Partial<BoundedProcessLimits>;
  readonly spawn?: BoundedProcessRunnerInput["spawn"];
};

function currentBuildEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (typeof value === "string") environment[key] = value;
  }
  if (environment.PATH === undefined) environment.PATH = "/usr/bin:/bin";
  return environment;
}

/** Run a read-only Git probe through the shared bounded process boundary. */
export function runGit(
  command: readonly string[],
  reason: GitBuildReason,
  options: GitProcessOptions = {},
): ResultAsync<string, PublicPackageBuildError> {
  return runBoundedProcess({
    cmd: ["git", ...command],
    cwd: options.cwd ?? ".",
    env: options.env ?? currentBuildEnvironment(),
    limits: options.limits ?? BUILD_GIT_PROCESS_LIMITS,
    spawn: options.spawn,
  })
    .andThen(({ exitCode, stdout }) =>
      exitCode === 0
        ? okAsync(stdout)
        : errAsync({ type: "BuildIdentity" as const, reason }),
    )
    .mapErr(() => ({ type: "BuildIdentity" as const, reason }));
}

export type GitBuildProbe = (
  command: readonly string[],
  reason: GitBuildReason,
) => ResultAsync<string, PublicPackageBuildError>;

export function parseGitBuildIdentity(
  subject: string,
  status: string,
): Result<
  { readonly subject: string; readonly dirty: boolean },
  PublicPackageBuildError
> {
  const normalizedSubject = subject.trim();
  if (!/^[0-9a-f]{40}$/u.test(normalizedSubject)) {
    return err({
      type: "BuildIdentity",
      reason: "git-subject-unavailable",
    });
  }
  return ok({
    subject: normalizedSubject,
    dirty: status.trim().length > 0,
  });
}

export function readGitBuildIdentity(
  probe: GitBuildProbe = runGit,
): ResultAsync<
  { readonly subject: string; readonly dirty: boolean },
  PublicPackageBuildError
> {
  return probe(["rev-parse", "HEAD"], "git-subject-unavailable").andThen(
    (subject) =>
      probe(
        ["status", "--porcelain", "--untracked-files=all"],
        "git-state-unavailable",
      ).andThen((status) => {
        const parsed = parseGitBuildIdentity(subject, status);
        return parsed.isOk() ? okAsync(parsed.value) : errAsync(parsed.error);
      }),
  );
}
