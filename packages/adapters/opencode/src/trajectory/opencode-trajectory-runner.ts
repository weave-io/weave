/**
 * OpenCode `TrajectoryRunner` implementation.
 *
 * Implements the engine-owned `TrajectoryRunner` interface
 * (`@weaveio/weave-core`, see `trajectory-events.ts`) for the OpenCode
 * adapter. Executes one harness-trajectory eval case end to end:
 *
 *   1. Resolve the prompt text via the injected `PromptProvider`.
 *   2. Prepare an ephemeral workspace via the injected
 *      `TrajectoryWorkspaceFactory` (writes `prompt.txt`, creates the
 *      artifacts directory).
 *   3. Invoke `podman run` against the `opencode-default` sandbox (see
 *      `sandboxes/opencode/README.md` for the mount/env contract) via the
 *      injected `PodmanClient`.
 *   4. Race the podman invocation against `max_duration_seconds`. On
 *      timeout, issue `podman kill` and return `TimeoutExceeded`.
 *   5. Parse the captured stderr into normalized `TrajectoryEvent` records
 *      via the injected `LogParser`.
 *   6. Score the events against `expectedSpawns`/`expectedTools` to produce
 *      the four-field publishable `TrajectorySummary`.
 *   7. Return a `TrajectoryResult` (event stream + summary + local-only raw
 *      artifact reference).
 *
 * # Design
 *
 * All external dependencies (`PodmanClient`, `LogParser`, `PromptProvider`,
 * `TrajectoryWorkspaceFactory`) are injected via the constructor so tests
 * can substitute in-memory stubs. No real Podman invocation, no real file
 * I/O, and no real harness process is used in unit tests — see
 * `__tests__/opencode-trajectory-runner.test.ts`.
 *
 * # Raw-data boundary
 *
 * `events` (the full parsed stream) and `rawArtifactRef` (a path reference
 * to the captured stderr) are local-only, exactly as required by
 * docs/specs/33-spec-harness-trajectory-evals. Only `summary` — the bounded
 * four-field `TrajectorySummary` — is eligible for a publishable artifact.
 */

import type {
  TrajectoryCase,
  TrajectoryEvent,
  TrajectoryResult,
  TrajectoryRunner,
  TrajectoryRunnerError,
  TrajectorySummary,
  TrajectoryWorkspace,
} from "@weaveio/weave-core";
import { logger } from "@weaveio/weave-engine";
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
} from "neverthrow";
import {
  parseTrajectoryEvents,
  type TrajectoryParseError,
} from "./log-parser.js";
import type { PodmanClient, PodmanRunResult } from "./podman-client.js";

const log = logger.child({ module: "opencode-trajectory-runner" });

// ---------------------------------------------------------------------------
// Injected collaborator interfaces
// ---------------------------------------------------------------------------

/**
 * Parses raw sandbox stderr into normalized `TrajectoryEvent` records.
 * Default implementation wraps `parseTrajectoryEvents` from `log-parser.ts`.
 */
export interface LogParser {
  parse(stderr: string): Result<TrajectoryEvent[], TrajectoryParseError[]>;
}

export class DefaultLogParser implements LogParser {
  parse(stderr: string): Result<TrajectoryEvent[], TrajectoryParseError[]> {
    return parseTrajectoryEvents(stderr);
  }
}

/**
 * Resolves the prompt text to write into the ephemeral workspace's
 * `prompt.txt` for a given trajectory case.
 */
export interface PromptProvider {
  getPrompt(
    testCase: TrajectoryCase,
  ): ResultAsync<string, TrajectoryRunnerError>;
}

/**
 * Prepares (and later can tear down) the ephemeral per-case workspace: a
 * mounted `/workspace` directory containing `prompt.txt`, and a mounted
 * `/artifacts` directory that the sandbox writes `exit-code` into.
 * (The sandbox's stderr, which carries the trajectory log stream, is
 * inherited by the parent `podman run` process, not written into
 * `/artifacts`.)
 */
export interface TrajectoryWorkspaceFactory {
  create(
    testCaseId: string,
    prompt: string,
  ): ResultAsync<TrajectoryWorkspace, TrajectoryRunnerError>;
}

/**
 * Default `TrajectoryWorkspaceFactory`: creates an ephemeral per-case
 * directory pair under the OS temp directory (`os.tmpdir()`), writes
 * `prompt.txt` into the workspace root via `Bun.write`, and creates the
 * artifacts directory (also via `Bun.write`, since Bun creates parent
 * directories for a written file automatically).
 */
export class EphemeralWorkspaceFactory implements TrajectoryWorkspaceFactory {
  create(
    testCaseId: string,
    prompt: string,
  ): ResultAsync<TrajectoryWorkspace, TrajectoryRunnerError> {
    return ResultAsync.fromPromise(
      this.writeWorkspace(testCaseId, prompt),
      (cause): TrajectoryRunnerError => {
        log.error(
          { testCaseId, error: cause },
          "failed to prepare ephemeral workspace",
        );
        return {
          type: "WorkspaceUnavailable",
          testCaseId,
          model: "unknown",
        };
      },
    );
  }

  private async writeWorkspace(
    testCaseId: string,
    prompt: string,
  ): Promise<TrajectoryWorkspace> {
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const base = join(
      tmpdir(),
      "weave-trajectory",
      testCaseId,
      crypto.randomUUID(),
    );
    const root = join(base, "workspace");
    const artifactsDir = join(base, "artifacts");
    await Bun.write(join(root, "prompt.txt"), prompt);
    await Bun.write(join(artifactsDir, ".keep"), "");
    return { root, artifactsDir };
  }
}

// ---------------------------------------------------------------------------
// Sandbox profile resolution
// ---------------------------------------------------------------------------

/**
 * Maps a symbolic `sandbox_profile` name to the concrete container image tag
 * built from `sandboxes/opencode/Containerfile`. See
 * `sandboxes/opencode/README.md` for the build command.
 */
const SANDBOX_PROFILE_IMAGES: Record<string, string> = {
  "opencode-default": "weave-sandbox-opencode-default",
};

/**
 * Resolve a symbolic `sandbox_profile` name to its concrete container image
 * tag. Returns `undefined` for unknown profiles.
 *
 * Exported so callers outside this module (e.g. the CLI eval orchestrator's
 * dry-run sandbox-image existence check) can resolve the same tag without
 * duplicating the profile map.
 */
export function resolveSandboxProfileImage(
  sandboxProfile: string,
): string | undefined {
  return SANDBOX_PROFILE_IMAGES[sandboxProfile];
}

// ---------------------------------------------------------------------------
// OpenCodeTrajectoryRunner
// ---------------------------------------------------------------------------

export interface OpenCodeTrajectoryRunnerOptions {
  podmanClient: PodmanClient;
  logParser: LogParser;
  promptProvider: PromptProvider;
  workspaceFactory: TrajectoryWorkspaceFactory;
  /** OpenRouter API key passed to the sandbox as an env var only. */
  openRouterApiKey: string;
  /**
   * Absolute path to the repository root. Used to mount the repo's `.weave/`
   * config directory read-only into the sandbox, so OpenCode's config
   * discovery finds Loom/Shuttle/categories instead of falling back to its
   * baked-in `build` default agent. Constructor-injected, no default:
   * callers must resolve this explicitly (e.g. `process.cwd()` at CLI
   * invocation time). The Weave plugin itself is installed globally inside
   * the sandbox image from npm (see `sandboxes/opencode/Containerfile`);
   * it is not bind-mounted from the repo.
   */
  repoRoot: string;
  /**
   * Maximum time, in milliseconds, to wait for the podman run stderr stream
   * to drain after issuing `podman kill` in `handleTimeout`. If the drain
   * completes within this window, the partial trajectory is salvaged and
   * scored. If not, the timeout is reported without a partial result. Kept
   * small so a wedged container never blocks the runner indefinitely.
   * Defaults to 2000ms; tests may pass a smaller value.
   */
  timeoutDrainGraceMs?: number;
}

export class OpenCodeTrajectoryRunner implements TrajectoryRunner {
  private readonly podmanClient: PodmanClient;
  private readonly logParser: LogParser;
  private readonly promptProvider: PromptProvider;
  private readonly workspaceFactory: TrajectoryWorkspaceFactory;
  private readonly openRouterApiKey: string;
  private readonly repoRoot: string;
  private readonly timeoutDrainGraceMs: number;

  constructor(options: OpenCodeTrajectoryRunnerOptions) {
    this.podmanClient = options.podmanClient;
    this.logParser = options.logParser;
    this.promptProvider = options.promptProvider;
    this.workspaceFactory = options.workspaceFactory;
    this.openRouterApiKey = options.openRouterApiKey;
    this.repoRoot = options.repoRoot;
    this.timeoutDrainGraceMs = options.timeoutDrainGraceMs ?? 2_000;
  }

  run(
    testCase: TrajectoryCase,
    model: string,
    workspace: TrajectoryWorkspace,
  ): ResultAsync<TrajectoryResult, TrajectoryRunnerError> {
    // The `workspace` parameter is only honored when it has a non-empty root.
    // Callers may pass a placeholder (e.g. `{ root: "", artifactsDir: "" }`) to
    // indicate that the runner should build its own workspace via the injected
    // `TrajectoryWorkspaceFactory`. This keeps tests deterministic (a mock
    // factory returns a fixed path) while allowing production to construct a
    // real ephemeral workspace under `os.tmpdir()`.
    const workspaceStep: ResultAsync<
      TrajectoryWorkspace,
      TrajectoryRunnerError
    > =
      workspace.root === ""
        ? this.promptProvider
            .getPrompt(testCase)
            .andThen((prompt) =>
              this.workspaceFactory.create(testCase.testCaseId, prompt),
            )
        : this.promptProvider
            .getPrompt(testCase)
            .andThen((prompt) =>
              this.workspaceFactory
                .create(testCase.testCaseId, prompt)
                .map(() => workspace),
            );

    return workspaceStep
      .andThen((resolvedWorkspace) =>
        this.resolveImage(testCase, model).map((image) => ({
          workspace: resolvedWorkspace,
          image,
        })),
      )
      .andThen(({ workspace: resolvedWorkspace, image }) =>
        this.invokeSandbox(testCase, model, resolvedWorkspace, image).map(
          (sandboxOutput) => ({ workspace: resolvedWorkspace, sandboxOutput }),
        ),
      )
      .andThen(({ workspace: resolvedWorkspace, sandboxOutput }) =>
        this.buildResult(testCase, model, resolvedWorkspace, sandboxOutput),
      );
  }

  private resolveImage(
    testCase: TrajectoryCase,
    model: string,
  ): ResultAsync<string, TrajectoryRunnerError> {
    const image = SANDBOX_PROFILE_IMAGES[testCase.sandboxProfile];
    if (image === undefined) {
      log.error(
        {
          testCaseId: testCase.testCaseId,
          sandboxProfile: testCase.sandboxProfile,
        },
        "unknown sandbox profile",
      );
      return errAsync({
        type: "SandboxStartFailed",
        testCaseId: testCase.testCaseId,
        model,
      });
    }
    return okAsync(image);
  }

  private invokeSandbox(
    testCase: TrajectoryCase,
    model: string,
    workspace: TrajectoryWorkspace,
    image: string,
  ): ResultAsync<PodmanRunResult, TrajectoryRunnerError> {
    // Volume mount option. `:Z` requests an SELinux private relabel; it is
    // valid only on Linux hosts with SELinux enforcing (typical for RHEL/Fedora)
    // and causes Podman to fail with exit 125 on Windows and macOS podman-machine
    // hosts, and on Linux distros without SELinux. We apply it only when the
    // host is Linux to keep the runner portable across dev boxes and CI runners
    // (ubuntu-latest runs rootless Podman without SELinux enforcement).
    const volumeOpt = process.platform === "linux" ? ":Z" : "";
    const containerName = `weave-traj-${testCase.testCaseId}-${crypto.randomUUID()}`;
    const args = [
      "--rm",
      "--name",
      containerName,
      "--timeout",
      String(testCase.maxDurationSeconds),
      "-e",
      `OPENROUTER_API_KEY=${this.openRouterApiKey}`,
      "-e",
      `WEAVE_TRAJECTORY_MODEL=${model}`,
      "-v",
      `${workspace.root}:/workspace${volumeOpt}`,
      "-v",
      `${workspace.artifactsDir}:/artifacts${volumeOpt}`,
      "-v",
      `${this.repoRoot}/.weave:/workspace/.weave:ro`,
      image,
    ];

    return ResultAsync.fromSafePromise(
      this.raceWithTimeout(
        this.podmanClient.run(args),
        testCase.maxDurationSeconds,
      ),
    ).andThen((raced) => {
      if (raced.kind === "timeout") {
        return this.handleTimeout(
          testCase,
          model,
          containerName,
          raced.pending,
        );
      }
      if (raced.result.isErr()) {
        log.error(
          { testCaseId: testCase.testCaseId, error: raced.result.error },
          "podman run failed",
        );
        return err<PodmanRunResult, TrajectoryRunnerError>({
          type: "SandboxStartFailed",
          testCaseId: testCase.testCaseId,
          model,
        });
      }
      if (raced.result.value.exitCode !== 0) {
        // Keep the tail bounded and behind a coarse ceiling so an opencode
        // DEBUG stream with embedded secrets or arbitrary content doesn't
        // flood the log. 400 bytes is enough to surface the final error line
        // without leaking substantial context.
        log.error(
          {
            testCaseId: testCase.testCaseId,
            exitCode: raced.result.value.exitCode,
            stderrTail: raced.result.value.stderr.slice(-400),
          },
          "harness process exited non-zero",
        );
        return err<PodmanRunResult, TrajectoryRunnerError>({
          type: "HarnessCrashed",
          testCaseId: testCase.testCaseId,
          model,
        });
      }
      return ok(raced.result.value);
    });
  }

  private handleTimeout(
    testCase: TrajectoryCase,
    model: string,
    containerName: string,
    pending: Promise<Result<PodmanRunResult, unknown>>,
  ): ResultAsync<PodmanRunResult, TrajectoryRunnerError> {
    log.warn(
      { testCaseId: testCase.testCaseId, containerName },
      "trajectory run exceeded max_duration_seconds, killing container",
    );
    // After `podman kill`, the in-flight `podman run` invocation will drain
    // its stderr stream and resolve. Give it a short grace period so we can
    // collect the partial trajectory and score it. If the drain itself
    // exceeds the grace window, fall back to reporting TimeoutExceeded with
    // no partial result.
    const graceMs = this.timeoutDrainGraceMs;
    return this.podmanClient
      .kill(containerName)
      .orElse((killError) => {
        log.error(
          { testCaseId: testCase.testCaseId, error: killError },
          "podman kill failed after timeout",
        );
        return okAsync(undefined);
      })
      .andThen(() =>
        ResultAsync.fromSafePromise(
          Promise.race<
            | { kind: "drained"; result: Result<PodmanRunResult, unknown> }
            | { kind: "drain-timeout" }
          >([
            pending.then((result) => ({ kind: "drained" as const, result })),
            new Promise((resolve) =>
              setTimeout(
                () => resolve({ kind: "drain-timeout" as const }),
                graceMs,
              ),
            ),
          ]),
        ),
      )
      .andThen((drained) => {
        if (drained.kind === "drain-timeout" || drained.result.isErr()) {
          return err<PodmanRunResult, TrajectoryRunnerError>({
            type: "TimeoutExceeded",
            testCaseId: testCase.testCaseId,
            model,
          });
        }
        // Return the partial PodmanRunResult so buildResult can parse and
        // score whatever trajectory events did stream before the timeout.
        // exitCode will typically be non-zero (SIGKILL), but the caller of
        // handleTimeout returns via `ok`, and buildResult only cares about
        // stderr for parsing.
        log.info(
          {
            testCaseId: testCase.testCaseId,
            stderrBytes: drained.result.value.stderr.length,
          },
          "salvaged partial trajectory after timeout",
        );
        return ok<PodmanRunResult, TrajectoryRunnerError>(drained.result.value);
      });
  }

  private async raceWithTimeout(
    runPromise: ResultAsync<PodmanRunResult, unknown>,
    maxDurationSeconds: number,
  ): Promise<
    | {
        kind: "completed";
        result: Result<PodmanRunResult, unknown>;
      }
    | {
        kind: "timeout";
        pending: Promise<Result<PodmanRunResult, unknown>>;
      }
  > {
    // Materialize the run promise once so both branches (completed and
    // timeout) can observe the same underlying invocation. The timeout
    // branch hands the pending promise to `handleTimeout` so it can await
    // the drain after issuing `podman kill`.
    const pending: Promise<Result<PodmanRunResult, unknown>> = (async () =>
      await runPromise)();
    const completed: Promise<{
      kind: "completed";
      result: Result<PodmanRunResult, unknown>;
    }> = pending.then((result) => ({ kind: "completed" as const, result }));
    const timeout = new Promise<{
      kind: "timeout";
      pending: Promise<Result<PodmanRunResult, unknown>>;
    }>((resolve) => {
      setTimeout(
        () => resolve({ kind: "timeout" as const, pending }),
        maxDurationSeconds * 1000,
      );
    });
    return Promise.race([completed, timeout]);
  }

  private buildResult(
    testCase: TrajectoryCase,
    model: string,
    workspace: TrajectoryWorkspace,
    sandboxOutput: PodmanRunResult,
  ): ResultAsync<TrajectoryResult, TrajectoryRunnerError> {
    // Diagnostic hook: when WEAVE_TRAJECTORY_DUMP_STDERR is set to an absolute
    // directory path, write the raw sandbox stderr for this case there so we
    // can inspect what the log parser is actually seeing. Local-only, opt-in,
    // never enabled by default. Failure to write is not fatal; we log and
    // continue so eval scoring still proceeds.
    const dumpDir = Bun.env.WEAVE_TRAJECTORY_DUMP_STDERR;
    if (dumpDir !== undefined && dumpDir.trim().length > 0) {
      const path = `${dumpDir}/${testCase.testCaseId}.stderr.log`;
      Bun.write(path, sandboxOutput.stderr).then(
        () =>
          log.info(
            { testCaseId: testCase.testCaseId, path },
            "dumped raw stderr",
          ),
        (cause) =>
          log.warn(
            { testCaseId: testCase.testCaseId, path, error: cause },
            "failed to dump raw stderr",
          ),
      );
    }
    const parsed = this.logParser.parse(sandboxOutput.stderr);
    if (parsed.isErr()) {
      log.error(
        { testCaseId: testCase.testCaseId, errors: parsed.error },
        "trajectory event stream malformed",
      );
      return errAsync({
        type: "EventStreamMalformed",
        testCaseId: testCase.testCaseId,
        model,
      });
    }

    const events = parsed.value;
    const summary = this.scoreEvents(testCase, events);
    const result: TrajectoryResult = {
      events,
      summary,
      rawArtifactRef: {
        path: `${testCase.testCaseId}/stderr.log`,
      },
    };
    void workspace;
    return okAsync(result);
  }

  private scoreEvents(
    testCase: TrajectoryCase,
    events: TrajectoryEvent[],
  ): TrajectorySummary {
    const observedSpawns = events
      .filter((event) => event.kind === "subagent-spawned")
      .map((event) => event.childAgentName);

    const harnessDelegatedCorrectly = testCase.expectedSpawns.every(
      (expected) => observedSpawns.includes(expected),
    );

    const observedToolCalls = events.filter(
      (event) => event.kind === "tool-call-after",
    ).length;

    const hasCompleted = events.some(
      (event) => event.kind === "session-completed",
    );
    const hasErrored = events.some((event) => event.kind === "session-errored");
    const harnessCompletedWithoutError = hasCompleted && !hasErrored;

    return {
      harnessDelegatedCorrectly,
      observedSpawns,
      observedToolCalls,
      harnessCompletedWithoutError,
    };
  }
}
