/**
 * Drives a real OpenCode 2 host for the live check, in an isolated root.
 *
 * Only the `opencode2` CLI is used: `service start|stop`, `api <operation>`
 * and `run`. The check deliberately avoids the `@opencode/client` library so
 * that a host release that reshapes the client API cannot break the check
 * itself; it can only break what the check observes, which is the point.
 * `scripts/opencode2/verify-runtime.ts` went stale exactly that way.
 *
 * Isolation: HOME, every XDG directory, the runtime directory and Weave's
 * global config directory point inside the root, so the check never touches
 * the developer's OpenCode service, config, plugin cache or Weave config.
 */

import { join } from "node:path";
import { errAsync, okAsync, ResultAsync } from "neverthrow";

export type LiveHostError =
  | {
      readonly type: "CommandFailed";
      readonly step: string;
      readonly exitCode: number;
      readonly output: string;
    }
  | {
      readonly type: "SpawnFailed";
      readonly step: string;
      readonly detail: string;
    }
  | {
      readonly type: "InvalidHostResponse";
      readonly operation: string;
      readonly detail: string;
    }
  | {
      readonly type: "FileFailed";
      readonly path: string;
      readonly detail: string;
    };

export interface CommandOutcome {
  readonly exitCode: number;
  readonly output: string;
}

export interface LivePaths {
  readonly root: string;
  readonly hostDir: string;
  readonly home: string;
  readonly project: string;
}

const MAX_OUTPUT = 2000;

export function livePaths(root: string): LivePaths {
  return {
    root,
    hostDir: join(root, "host"),
    home: join(root, "home"),
    project: join(root, "project"),
  };
}

function detail(cause: unknown): string {
  if (cause instanceof Error) return cause.message.slice(0, 400);
  return "unknown failure";
}

function tail(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return text.slice(-MAX_OUTPUT);
}

/** Runs one process to completion with a hard timeout. */
export function runProcess(
  step: string,
  command: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly timeoutMs: number;
    /** Write stdout to this file instead of capturing it (large JSON). */
    readonly stdoutFile?: string;
  },
): ResultAsync<CommandOutcome, LiveHostError> {
  return ResultAsync.fromPromise(
    (async () => {
      const proc = Bun.spawn([...command], {
        cwd: options.cwd,
        env: options.env,
        stdin: "ignore",
        stdout:
          options.stdoutFile === undefined
            ? "pipe"
            : Bun.file(options.stdoutFile),
        stderr: "pipe",
      });
      const timer = setTimeout(() => proc.kill(), options.timeoutMs);
      const [stdout, stderr, exitCode] = await Promise.all([
        proc.stdout instanceof ReadableStream
          ? new Response(proc.stdout).text()
          : Promise.resolve(""),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(timer);
      return { exitCode, output: tail(`${stdout}${stderr}`) };
    })(),
    (cause): LiveHostError => ({
      type: "SpawnFailed",
      step,
      detail: detail(cause),
    }),
  );
}

/** Like `runProcess`, but a non-zero exit is an error. */
export function mustRun(
  step: string,
  command: readonly string[],
  options: Parameters<typeof runProcess>[2],
): ResultAsync<CommandOutcome, LiveHostError> {
  return runProcess(step, command, options).andThen((outcome) => {
    if (outcome.exitCode === 0) return okAsync(outcome);
    return errAsync<CommandOutcome, LiveHostError>({
      type: "CommandFailed",
      step,
      exitCode: outcome.exitCode,
      output: outcome.output,
    });
  });
}

export function writeText(
  path: string,
  text: string,
): ResultAsync<void, LiveHostError> {
  return ResultAsync.fromPromise(
    Bun.write(path, text).then(() => undefined),
    (cause): LiveHostError => ({
      type: "FileFailed",
      path,
      detail: detail(cause),
    }),
  );
}

export class OpenCode2Host {
  constructor(
    private readonly paths: LivePaths,
    private readonly requestedVersion: string,
  ) {}

  /** Environment every host process runs with. */
  env(): Record<string, string> {
    const { home, hostDir } = this.paths;
    return {
      PATH: `${join(hostDir, "node_modules", ".bin")}:${Bun.env.PATH ?? ""}`,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_RUNTIME_DIR: join(home, ".run"),
      WEAVE_GLOBAL_CONFIG_DIR: join(home, ".weave"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    };
  }

  /** Global host config: the file that names the scripted provider. */
  globalConfigPath(): string {
    return join(this.paths.home, ".config", "opencode", "opencode.json");
  }

  /** Installs `@opencode/cli@<version>` into the isolated host directory. */
  install(): ResultAsync<void, LiveHostError> {
    const { hostDir } = this.paths;
    return writeText(
      join(hostDir, "package.json"),
      `${JSON.stringify({ name: "weave-opencode2-live-host", private: true })}\n`,
    )
      .andThen(() =>
        mustRun(
          "install host",
          ["bun", "add", "--trust", `@opencode/cli@${this.requestedVersion}`],
          { cwd: hostDir, env: this.env(), timeoutMs: 600_000 },
        ),
      )
      .map(() => undefined);
  }

  version(): ResultAsync<string, LiveHostError> {
    return mustRun("host version", [this.binary(), "--version"], {
      cwd: this.paths.project,
      env: this.env(),
      timeoutMs: 30_000,
    }).map((outcome) => outcome.output.trim());
  }

  startService(): ResultAsync<void, LiveHostError> {
    return mustRun("start service", [this.binary(), "service", "start"], {
      cwd: this.paths.home,
      env: this.env(),
      timeoutMs: 120_000,
    }).map(() => undefined);
  }

  stopService(): ResultAsync<void, LiveHostError> {
    return mustRun("stop service", [this.binary(), "service", "stop"], {
      cwd: this.paths.home,
      env: this.env(),
      timeoutMs: 60_000,
    }).map(() => undefined);
  }

  /**
   * Calls one API operation for the project Location and returns `data`.
   * Stdout goes to a file: the host truncates large responses written to a
   * pipe, and the agent list (with every system prompt) is large.
   */
  api(operation: string): ResultAsync<unknown, LiveHostError> {
    const file = join(this.paths.root, `api-${operation}.json`);
    return mustRun(
      `api ${operation}`,
      [
        this.binary(),
        "api",
        operation,
        "-H",
        `x-opencode-directory:${this.paths.project}`,
      ],
      {
        cwd: this.paths.project,
        env: this.env(),
        timeoutMs: 60_000,
        stdoutFile: file,
      },
    ).andThen(() =>
      ResultAsync.fromPromise(
        Bun.file(file).json() as Promise<{ data?: unknown }>,
        (cause): LiveHostError => ({
          type: "InvalidHostResponse",
          operation,
          detail: detail(cause),
        }),
      ).andThen((response) => {
        if (!Array.isArray(response.data)) {
          return errAsync<unknown, LiveHostError>({
            type: "InvalidHostResponse",
            operation,
            detail: "response has no data array",
          });
        }
        return okAsync<unknown, LiveHostError>(response.data);
      }),
    );
  }

  /** Sends one message to `agent` in the project, as a user would. */
  run(
    agent: string,
    message: string,
  ): ResultAsync<CommandOutcome, LiveHostError> {
    return runProcess(
      `run ${agent}`,
      [this.binary(), "run", "--agent", agent, message],
      { cwd: this.paths.project, env: this.env(), timeoutMs: 240_000 },
    );
  }

  private binary(): string {
    return join(this.paths.hostDir, "node_modules", ".bin", "opencode2");
  }
}
