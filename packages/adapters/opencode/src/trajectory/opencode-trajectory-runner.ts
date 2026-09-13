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
 *      artifacts directory), then set it up for the case (Spec 35): copy
 *      the fixture, write the tool-call observer plugin, and for the
 *      `opencode-local` profile write the working-tree plugin bundle.
 *   3. Invoke `podman run` against the sandbox image (see
 *      `sandboxes/opencode/README.md` for the mount/env contract) via the
 *      injected `PodmanClient`.
 *   4. Race the podman invocation against `max_duration_seconds`. On
 *      timeout, issue `podman kill` and return `TimeoutExceeded`.
 *   5. Parse the captured stderr into normalized `TrajectoryEvent` records
 *      via the injected `LogParser`, and join the observer's tool-call
 *      records into that stream as `tool-call-after` events.
 *   6. If the case has a verifier, run it in a second container against
 *      the finished workspace.
 *   7. Score the events against `expectedSpawns`/`expectedTools` to produce
 *      the four-field publishable `TrajectorySummary`.
 *   8. Return a `TrajectoryResult` (event stream + summary + local-only raw
 *      artifact reference + local-only verifier outcome).
 *
 * # Design
 *
 * All external dependencies (`PodmanClient`, `LogParser`, `PromptProvider`,
 * `TrajectoryWorkspaceFactory`, `TrajectoryFileSystem`) are injected via the
 * constructor so tests can substitute in-memory stubs. No real Podman invocation, no real file
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

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { getBuiltinConfig } from "@weaveio/weave-config";
import type {
  TrajectoryCase,
  TrajectoryEvent,
  TrajectoryResult,
  TrajectoryRunner,
  TrajectoryRunnerError,
  TrajectorySummary,
  TrajectoryVerifierResult,
  TrajectoryWorkspace,
} from "@weaveio/weave-core";
import { logger, redactSecrets } from "@weaveio/weave-engine";
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
import {
  joinObserverRecords,
  OBSERVER_PLUGIN_PATH,
  OBSERVER_PLUGIN_SOURCE,
  OBSERVER_RECORDS_FILE,
  parseObserverRecords,
} from "./observer.js";
import type { PodmanClient, PodmanRunResult } from "./podman-client.js";

const log = logger.child({ module: "opencode-trajectory-runner" });

/**
 * Detects whether the current process is running in a CI or publish
 * context, where the `WEAVE_TRAJECTORY_DUMP_STDERR` local diagnostic dump
 * must be refused outright regardless of redaction. Mirrors the `isCI`
 * check used by `packages/cli/src/evals/input-validation.ts` for
 * `--raw-artifacts`, plus an explicit publish-mode signal.
 */
function isCIOrPublishContext(
  env: Record<string, string | undefined>,
): boolean {
  const ci = env.CI;
  const isCI = ci !== undefined && ci !== "" && ci !== "0" && ci !== "false";
  const publish = env.WEAVE_EVAL_PUBLISH_MODE;
  const isPublish =
    publish !== undefined &&
    publish !== "" &&
    publish !== "0" &&
    publish !== "false";
  return isCI || isPublish;
}

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

/**
 * File operations the runner performs on the host side of the workspace
 * (Spec 35): copying a fixture in, writing the observer plugin, the local
 * plugin bundle, and the generated global config, and reading the
 * observer's records back. Injected so unit tests do no real file I/O.
 */
export interface TrajectoryFileSystem {
  /** Copies every file under `from` into `to`, keeping relative paths. */
  copyDirectory(from: string, to: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
  /** Returns the file's text, or `undefined` when it does not exist. */
  readText(path: string): Promise<string | undefined>;
}

/** Default `TrajectoryFileSystem` backed by Bun file APIs. */
export class BunTrajectoryFileSystem implements TrajectoryFileSystem {
  async copyDirectory(from: string, to: string): Promise<void> {
    const glob = new Bun.Glob("**/*");
    for await (const relative of glob.scan({
      cwd: from,
      dot: true,
      onlyFiles: true,
    })) {
      await Bun.write(join(to, relative), Bun.file(join(from, relative)));
    }
  }

  async copyFile(from: string, to: string): Promise<void> {
    await Bun.write(to, Bun.file(from));
  }

  async writeFile(path: string, content: string): Promise<void> {
    await Bun.write(path, content);
  }

  async readText(path: string): Promise<string | undefined> {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return undefined;
    }
    return file.text();
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
  // Same image; the runner supplies the working-tree plugin bundle instead of
  // the npm pin (Spec 35).
  "opencode-local": "weave-sandbox-opencode-default",
};

/** Profiles that load the working-tree plugin bundle from the workspace. */
const LOCAL_PLUGIN_PROFILES: ReadonlySet<string> = new Set(["opencode-local"]);

/** Where the working-tree bundle goes; OpenCode auto-loads this directory. */
const LOCAL_PLUGIN_WORKSPACE_PATH = ".opencode/plugin/weave.js";

/** `opencode.jsonc` for local-plugin runs: no npm plugin entry. */
const LOCAL_PLUGIN_OPENCODE_CONFIG = `${JSON.stringify(
  { $schema: "https://opencode.ai/config.json", permission: "allow" },
  null,
  2,
)}\n`;

/** Container path of Weave's global config (`~/.weave` for root). */
const GLOBAL_CONFIG_CONTAINER_PATH = "/root/.weave/config.weave";

/** Floor for the verifier's time budget, even when the session ran long. */
const VERIFIER_MIN_SECONDS = 30;

/**
 * Builds the global Weave config mounted into fixture runs (Spec 35). It
 * pins every builtin sub-agent to the model under test in OpenCode's
 * `openrouter/<provider>/<model>` form. Without it, sub-agents keep the
 * builtin model id, which OpenCode cannot resolve under OpenRouter, so every
 * delegation fails. Config merge puts these entries ahead of the builtin
 * ones; a fixture's own project config can still override them.
 */
export function buildSubagentModelOverlay(model: string): string {
  const openCodeModel =
    model.startsWith("openrouter/") || model.startsWith("opencode/")
      ? model
      : `openrouter/${model}`;
  const builtins = getBuiltinConfig();
  const agents = builtins.isOk() ? Object.entries(builtins.value.agents) : [];
  const blocks = agents
    .filter(([, agent]) => agent.mode === "subagent")
    .map(
      ([name]) =>
        `agent ${name} {\n  models [${JSON.stringify(openCodeModel)}]\n}`,
    );
  return [
    "# Generated by the Weave trajectory runner (Spec 35). Pins builtin",
    "# sub-agents to the model under test so OpenCode can resolve them.",
    ...blocks,
    "",
  ].join("\n");
}

/** Host-side paths produced by workspace setup, consumed by the sandbox run. */
interface WorkspaceSetup {
  /** Generated global config to mount, for fixture runs only. */
  globalConfigPath: string | undefined;
}

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
  /**
   * Host file operations for workspace setup and reading observer records.
   * Defaults to `BunTrajectoryFileSystem`; tests inject an in-memory fake.
   */
  fileSystem?: TrajectoryFileSystem;
  /**
   * Absolute path of a `bun build` bundle of the working tree's
   * `packages/adapters/opencode/src/plugin.ts`. Required by the
   * `opencode-local` profile, ignored otherwise.
   */
  localPluginBundlePath?: string;
}

export class OpenCodeTrajectoryRunner implements TrajectoryRunner {
  private readonly podmanClient: PodmanClient;
  private readonly logParser: LogParser;
  private readonly promptProvider: PromptProvider;
  private readonly workspaceFactory: TrajectoryWorkspaceFactory;
  private readonly openRouterApiKey: string;
  private readonly repoRoot: string;
  private readonly timeoutDrainGraceMs: number;
  private readonly fileSystem: TrajectoryFileSystem;
  private readonly localPluginBundlePath: string | undefined;

  constructor(options: OpenCodeTrajectoryRunnerOptions) {
    this.podmanClient = options.podmanClient;
    this.logParser = options.logParser;
    this.promptProvider = options.promptProvider;
    this.workspaceFactory = options.workspaceFactory;
    this.openRouterApiKey = options.openRouterApiKey;
    this.repoRoot = options.repoRoot;
    this.timeoutDrainGraceMs = options.timeoutDrainGraceMs ?? 2_000;
    this.fileSystem = options.fileSystem ?? new BunTrajectoryFileSystem();
    this.localPluginBundlePath = options.localPluginBundlePath;
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

    const startedAt = Date.now();
    return workspaceStep
      .andThen((resolvedWorkspace) =>
        this.resolveImage(testCase, model).map((image) => ({
          workspace: resolvedWorkspace,
          image,
        })),
      )
      .andThen(({ workspace: resolvedWorkspace, image }) =>
        this.prepareWorkspace(testCase, model, resolvedWorkspace).map(
          (setup) => ({ workspace: resolvedWorkspace, image, setup }),
        ),
      )
      .andThen(({ workspace: resolvedWorkspace, image, setup }) =>
        this.invokeSandbox(
          testCase,
          model,
          resolvedWorkspace,
          image,
          setup,
        ).map((sandboxOutput) => ({
          workspace: resolvedWorkspace,
          image,
          sandboxOutput,
        })),
      )
      .andThen(({ workspace: resolvedWorkspace, image, sandboxOutput }) =>
        this.buildResult(
          testCase,
          model,
          resolvedWorkspace,
          sandboxOutput,
          image,
          startedAt,
        ),
      );
  }

  /**
   * Sets the workspace up for the case (Spec 35): copies the fixture,
   * writes the tool-call observer plugin, writes the working-tree plugin
   * bundle and a plugin-less `opencode.jsonc` for `opencode-local`, and
   * writes the sub-agent model overlay for fixture runs.
   */
  private prepareWorkspace(
    testCase: TrajectoryCase,
    model: string,
    workspace: TrajectoryWorkspace,
  ): ResultAsync<WorkspaceSetup, TrajectoryRunnerError> {
    const usesLocalPlugin = LOCAL_PLUGIN_PROFILES.has(testCase.sandboxProfile);
    const bundlePath = this.localPluginBundlePath;
    if (usesLocalPlugin && bundlePath === undefined) {
      log.error(
        {
          testCaseId: testCase.testCaseId,
          sandboxProfile: testCase.sandboxProfile,
        },
        "local-plugin sandbox profile requires localPluginBundlePath",
      );
      return errAsync({
        type: "SandboxStartFailed",
        testCaseId: testCase.testCaseId,
        model,
      });
    }

    const globalConfigPath =
      testCase.fixturePath !== undefined
        ? join(dirname(workspace.root), "weave-global", "config.weave")
        : undefined;

    const setup = async (): Promise<WorkspaceSetup> => {
      if (testCase.fixturePath !== undefined) {
        await this.fileSystem.copyDirectory(
          testCase.fixturePath,
          workspace.root,
        );
      }
      await this.fileSystem.writeFile(
        join(workspace.root, OBSERVER_PLUGIN_PATH),
        OBSERVER_PLUGIN_SOURCE,
      );
      if (usesLocalPlugin && bundlePath !== undefined) {
        await this.fileSystem.copyFile(
          bundlePath,
          join(workspace.root, LOCAL_PLUGIN_WORKSPACE_PATH),
        );
        await this.fileSystem.writeFile(
          join(workspace.root, "opencode.jsonc"),
          LOCAL_PLUGIN_OPENCODE_CONFIG,
        );
      }
      if (globalConfigPath !== undefined) {
        await this.fileSystem.writeFile(
          globalConfigPath,
          buildSubagentModelOverlay(model),
        );
      }
      return { globalConfigPath };
    };

    return ResultAsync.fromPromise(setup(), (cause): TrajectoryRunnerError => {
      log.error(
        { testCaseId: testCase.testCaseId, error: cause },
        "failed to set up trajectory workspace",
      );
      return {
        type: "WorkspaceUnavailable",
        testCaseId: testCase.testCaseId,
        model,
      };
    });
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
    setup: WorkspaceSetup,
  ): ResultAsync<PodmanRunResult, TrajectoryRunnerError> {
    // Volume mount option. `:Z` requests an SELinux private relabel; it is
    // valid only on Linux hosts with SELinux enforcing (typical for RHEL/Fedora)
    // and causes Podman to fail with exit 125 on Windows and macOS podman-machine
    // hosts, and on Linux distros without SELinux. We apply it only when the
    // host is Linux to keep the runner portable across dev boxes and CI runners
    // (ubuntu-latest runs rootless Podman without SELinux enforcement).
    const volumeOpt = process.platform === "linux" ? ":Z" : "";
    const containerName = `weave-traj-${testCase.testCaseId}-${crypto.randomUUID()}`;
    // SECURITY: `OPENROUTER_API_KEY` is passed to podman as a *name-only*
    // env pass-through flag (`-e`, `OPENROUTER_API_KEY` — no `=value`). This
    // tells Podman to forward the variable from its own process
    // environment into the container. The actual secret value is supplied
    // only via `PodmanClient.run`'s `env` parameter, which
    // `BunPodmanClient` merges into `Bun.spawn`'s child process
    // environment — never into argv. This means the key never appears in
    // `args` (and therefore never in process listings, `/proc/<pid>/cmdline`,
    // or any logging that includes `args`).
    const args = [
      "--rm",
      "--name",
      containerName,
      "--timeout",
      String(testCase.maxDurationSeconds),
      "-e",
      "OPENROUTER_API_KEY",
      "-e",
      `WEAVE_TRAJECTORY_MODEL=${model}`,
      "-v",
      `${workspace.root}:/workspace${volumeOpt}`,
      "-v",
      `${workspace.artifactsDir}:/artifacts${volumeOpt}`,
      // Only the two `.weave/` inputs OpenCode's config discovery actually
      // reads are mounted — `config.weave` and `prompts/` (see
      // `packages/config/src/resolve.ts`, which resolves `prompt_file`
      // entries relative to the scope's `prompts/` sub-directory). The rest
      // of `.weave/` (`runtime/` session snapshots and journal, `weave.log`,
      // `plans/`, `learnings/`) is never read by config discovery and must
      // not be exposed inside the sandbox, since `runtime/` and
      // `weave.log` can carry prior session content. `prompts/` is mounted
      // as a directory (not individually enumerated file mounts) because
      // Podman `-v` requires the mount source to exist; if a project has no
      // `prompts/` directory yet, skip that mount rather than failing.
      //
      // A fixture run (Spec 35) mounts neither: the fixture's own `.weave/`
      // was copied into the workspace and is the project config, so the
      // eval measures builtin behaviour rather than this repository's local
      // overrides. It mounts the generated sub-agent model overlay as the
      // container's global config instead.
      ...this.weaveConfigMounts(testCase, setup),
      ...(testCase.startAgent !== undefined
        ? ["-e", `WEAVE_TRAJECTORY_START_AGENT=${testCase.startAgent}`]
        : []),
      image,
    ];

    return ResultAsync.fromSafePromise(
      this.raceWithTimeout(
        this.podmanClient.run(args, {
          OPENROUTER_API_KEY: this.openRouterApiKey,
        }),
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
        // flood the log. Redact known secret shapes (API keys, bearer
        // tokens, GitHub PATs, etc.) before slicing/logging — redaction
        // must run regardless of the truncation boundary so a secret is
        // never split across the cut point and partially leaked.
        log.error(
          {
            testCaseId: testCase.testCaseId,
            exitCode: raced.result.value.exitCode,
            stderrTail: redactSecrets(raced.result.value.stderr).slice(-400),
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

  private weaveConfigMounts(
    testCase: TrajectoryCase,
    setup: WorkspaceSetup,
  ): string[] {
    if (testCase.fixturePath !== undefined) {
      return setup.globalConfigPath !== undefined
        ? ["-v", `${setup.globalConfigPath}:${GLOBAL_CONFIG_CONTAINER_PATH}:ro`]
        : [];
    }
    return [
      "-v",
      `${this.repoRoot}/.weave/config.weave:/workspace/.weave/config.weave:ro`,
      ...(existsSync(`${this.repoRoot}/.weave/prompts`)
        ? ["-v", `${this.repoRoot}/.weave/prompts:/workspace/.weave/prompts:ro`]
        : []),
    ];
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{
      kind: "timeout";
      pending: Promise<Result<PodmanRunResult, unknown>>;
    }>((resolve) => {
      timer = setTimeout(
        () => resolve({ kind: "timeout" as const, pending }),
        maxDurationSeconds * 1000,
      );
    });
    // Clear the timer once the race settles: an uncleared timer keeps the
    // process alive for the full `max_duration_seconds` after a run that
    // finished early.
    return Promise.race([completed, timeout]).finally(() =>
      clearTimeout(timer),
    );
  }

  private buildResult(
    testCase: TrajectoryCase,
    model: string,
    workspace: TrajectoryWorkspace,
    sandboxOutput: PodmanRunResult,
    image: string,
    startedAt: number,
  ): ResultAsync<TrajectoryResult, TrajectoryRunnerError> {
    // Diagnostic hook: when WEAVE_TRAJECTORY_DUMP_STDERR is set to an absolute
    // directory path, write the raw sandbox stderr for this case there so we
    // can inspect what the log parser is actually seeing. Local-only, opt-in,
    // never enabled by default. Failure to write is not fatal; we log and
    // continue so eval scoring still proceeds.
    //
    // SECURITY: the OpenCode DEBUG stream this dump captures can contain
    // secrets (the `OPENROUTER_API_KEY` value, bearer tokens, etc.) if the
    // harness logs its own outbound request headers. Two safeguards apply:
    //   1. The dump mechanism is refused outright in CI/publish contexts —
    //      those pipelines have no legitimate use for a local diagnostic
    //      dump, and a stray env var leaking into a CI run must not produce
    //      an on-disk artifact.
    //   2. Content written to disk is always passed through `redactSecrets`
    //      first; only the redacted text ever reaches the filesystem.
    const dumpDir = Bun.env.WEAVE_TRAJECTORY_DUMP_STDERR;
    if (dumpDir !== undefined && dumpDir.trim().length > 0) {
      if (isCIOrPublishContext(Bun.env)) {
        log.warn(
          { testCaseId: testCase.testCaseId },
          "WEAVE_TRAJECTORY_DUMP_STDERR is set but ignored in CI/publish contexts",
        );
      } else {
        const path = `${dumpDir}/${testCase.testCaseId}.stderr.log`;
        const redacted = redactSecrets(sandboxOutput.stderr);
        Bun.write(path, redacted, { mode: 0o600 }).then(
          () =>
            log.info(
              { testCaseId: testCase.testCaseId, path },
              "dumped redacted stderr",
            ),
          (cause) =>
            log.warn(
              { testCaseId: testCase.testCaseId, path, error: cause },
              "failed to dump redacted stderr",
            ),
        );
      }
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

    const channelAEvents = parsed.value;
    return ResultAsync.fromSafePromise(
      this.joinObserverEvents(testCase, workspace, channelAEvents),
    )
      .andThen((events) =>
        this.runVerifier(testCase, workspace, image, startedAt).map(
          (verifier) => ({ events, verifier }),
        ),
      )
      .map(
        ({ events, verifier }): TrajectoryResult => ({
          events,
          summary: this.scoreEvents(testCase, events),
          rawArtifactRef: {
            path: `${testCase.testCaseId}/stderr.log`,
          },
          ...(verifier !== undefined ? { verifier } : {}),
        }),
      );
  }

  /**
   * Joins the observer plugin's tool-call records into the Channel-A event
   * stream. A missing or unreadable observer file is not fatal: the run is
   * scored on the Channel-A events alone, with a warning.
   */
  private async joinObserverEvents(
    testCase: TrajectoryCase,
    workspace: TrajectoryWorkspace,
    events: TrajectoryEvent[],
  ): Promise<TrajectoryEvent[]> {
    const path = join(workspace.artifactsDir, OBSERVER_RECORDS_FILE);
    const text = await this.fileSystem.readText(path).catch((cause) => {
      log.warn(
        { testCaseId: testCase.testCaseId, error: cause },
        "failed to read tool-call observer records",
      );
      return undefined;
    });
    if (text === undefined) {
      log.warn(
        { testCaseId: testCase.testCaseId },
        "no tool-call observer records; scoring Channel-A events only",
      );
      return events;
    }
    const { records, malformedLines } = parseObserverRecords(text);
    if (malformedLines > 0) {
      log.warn(
        { testCaseId: testCase.testCaseId, malformedLines },
        "skipped malformed tool-call observer records",
      );
    }
    return joinObserverRecords(events, records);
  }

  /**
   * Runs the case's verifier (Spec 35) in a second container: the finished
   * workspace at /workspace, the verifier fixture read-only at /verifier, no
   * model API key. The agent's container never mounted /verifier. Exit 0
   * means passed; a failure to start, a timeout, or a non-zero exit means
   * not passed.
   */
  private runVerifier(
    testCase: TrajectoryCase,
    workspace: TrajectoryWorkspace,
    image: string,
    startedAt: number,
  ): ResultAsync<TrajectoryVerifierResult | undefined, never> {
    const verifier = testCase.verifier;
    if (verifier === undefined) {
      return okAsync(undefined);
    }

    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    const budgetSeconds = Math.max(
      VERIFIER_MIN_SECONDS,
      Math.floor(testCase.maxDurationSeconds - elapsedSeconds),
    );
    const volumeOpt = process.platform === "linux" ? ":Z" : "";
    const containerName = `weave-verify-${testCase.testCaseId}-${crypto.randomUUID()}`;
    const args = [
      "--rm",
      "--name",
      containerName,
      "--timeout",
      String(budgetSeconds),
      "-v",
      `${workspace.root}:/workspace${volumeOpt}`,
      "-v",
      `${verifier.fixturePath}:/verifier:ro`,
      "-w",
      "/workspace",
      "--entrypoint",
      "sh",
      image,
      "-c",
      verifier.command,
    ];

    return ResultAsync.fromSafePromise(
      this.raceWithTimeout(this.podmanClient.run(args), budgetSeconds),
    ).andThen((raced): ResultAsync<TrajectoryVerifierResult, never> => {
      if (raced.kind === "timeout") {
        log.warn(
          { testCaseId: testCase.testCaseId, containerName },
          "verifier exceeded its time budget, killing container",
        );
        return this.podmanClient
          .kill(containerName)
          .orElse(() => okAsync(undefined))
          .map((): TrajectoryVerifierResult => ({ passed: false }));
      }
      if (raced.result.isErr()) {
        log.error(
          { testCaseId: testCase.testCaseId, error: raced.result.error },
          "verifier container failed to run",
        );
        return okAsync({ passed: false });
      }
      const passed = raced.result.value.exitCode === 0;
      log.info(
        {
          testCaseId: testCase.testCaseId,
          exitCode: raced.result.value.exitCode,
          stderrTail: redactSecrets(raced.result.value.stderr).slice(-400),
        },
        passed ? "verifier passed" : "verifier failed",
      );
      return okAsync({ passed });
    });
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
