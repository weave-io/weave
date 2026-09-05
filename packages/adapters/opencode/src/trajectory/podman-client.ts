/**
 * Thin seam over `Bun.spawn` for invoking `podman` from the
 * `OpenCodeTrajectoryRunner`. Kept intentionally minimal: this class owns no
 * business logic, only process-spawning mechanics, so tests can substitute
 * `MockPodmanClient` without any real container runtime.
 *
 * # Secret handling
 *
 * `run()` accepts an optional `env` map of *values* that must reach the
 * child process (e.g. `OPENROUTER_API_KEY`). These values are never placed
 * into `args`/`argv` — Podman argv (and therefore process listings such as
 * `ps`, `/proc/<pid>/cmdline`, and any logging of `args`) must never contain
 * a secret value. Instead:
 *
 *   - Callers pass Podman *name-only* env pass-through flags in `args`
 *     (e.g. `-e OPENROUTER_API_KEY` with no `=value`), which tells Podman to
 *     forward that variable from its own process environment into the
 *     container.
 *   - `BunPodmanClient` merges the caller-supplied `env` values into the
 *     `Bun.spawn` child process environment (inheriting the current
 *     process's environment alongside them, so unrelated env vars such as
 *     `PATH` still resolve), so the *podman* process itself has the secret
 *     available to forward — but the secret never appears as a literal
 *     command-line argument.
 */

import { ResultAsync } from "neverthrow";

export interface PodmanRunResult {
  exitCode: number;
  stderr: string;
}

export type PodmanClientError =
  | { type: "PodmanSpawnFailed"; message: string }
  | { type: "PodmanKillFailed"; message: string };

/**
 * Adapter-owned interface over the `podman` CLI. Implemented by
 * `PodmanClient` (real `Bun.spawn` calls) and `MockPodmanClient` (tests).
 */
export interface PodmanClient {
  /**
   * Runs `podman run <args>` and resolves once the process exits (or is
   * killed). Collects stderr into memory as it streams.
   *
   * @param args - Podman CLI arguments. Must never contain a literal secret
   *   value; secrets are name-only pass-through (`-e`, `VAR_NAME`) and the
   *   actual value is supplied via `env`.
   * @param env - Secret/sensitive environment variable values to make
   *   available to the spawned `podman` process itself (not logged, not
   *   placed in argv). `BunPodmanClient` merges these with the inherited
   *   process environment.
   */
  run(
    args: string[],
    env?: Record<string, string>,
  ): ResultAsync<PodmanRunResult, PodmanClientError>;

  /**
   * Runs `podman kill <containerName>` to tear down a running container.
   * Used on the timeout path.
   */
  kill(containerName: string): ResultAsync<void, PodmanClientError>;
}

/**
 * Real `PodmanClient` implementation. Spawns `podman` as a child process via
 * `Bun.spawn`. Never used directly in unit tests — see
 * `__tests__/opencode-trajectory-runner.test.ts` for the `MockPodmanClient`
 * used instead.
 */
export class BunPodmanClient implements PodmanClient {
  run(
    args: string[],
    env?: Record<string, string>,
  ): ResultAsync<PodmanRunResult, PodmanClientError> {
    return ResultAsync.fromPromise(
      this.spawnAndCollect(args, env),
      (cause): PodmanClientError => ({
        type: "PodmanSpawnFailed",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    );
  }

  kill(containerName: string): ResultAsync<void, PodmanClientError> {
    return ResultAsync.fromPromise(
      this.spawnKill(containerName),
      (cause): PodmanClientError => ({
        type: "PodmanKillFailed",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    );
  }

  private async spawnAndCollect(
    args: string[],
    env?: Record<string, string>,
  ): Promise<PodmanRunResult> {
    // Merge onto the inherited process environment (never replace it wholesale)
    // so unrelated variables (PATH, HOME, etc.) that podman itself needs still
    // resolve. Only the caller-supplied secret values are added on top.
    const spawnEnv = env === undefined ? undefined : { ...Bun.env, ...env };
    const proc = Bun.spawn(["podman", "run", ...args], {
      stdout: "ignore",
      stderr: "pipe",
      env: spawnEnv,
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { exitCode, stderr };
  }

  private async spawnKill(containerName: string): Promise<void> {
    const proc = Bun.spawn(["podman", "kill", containerName], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
  }
}
