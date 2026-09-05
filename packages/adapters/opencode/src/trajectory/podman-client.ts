/**
 * Thin seam over `Bun.spawn` for invoking `podman` from the
 * `OpenCodeTrajectoryRunner`. Kept intentionally minimal: this class owns no
 * business logic, only process-spawning mechanics, so tests can substitute
 * `MockPodmanClient` without any real container runtime.
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
   */
  run(args: string[]): ResultAsync<PodmanRunResult, PodmanClientError>;

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
  run(args: string[]): ResultAsync<PodmanRunResult, PodmanClientError> {
    return ResultAsync.fromPromise(
      this.spawnAndCollect(args),
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

  private async spawnAndCollect(args: string[]): Promise<PodmanRunResult> {
    const proc = Bun.spawn(["podman", "run", ...args], {
      stdout: "ignore",
      stderr: "pipe",
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
