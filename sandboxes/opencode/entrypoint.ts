#!/usr/bin/env bun
// Weave OpenCode sandbox entrypoint.
//
// Contract (see ../README.md for the full spec):
//   - Reads the prompt from /workspace/prompt.txt (UTF-8, no trailing
//     processing beyond a trim).
//   - Writes /workspace/opencode.jsonc (only if absent) with a versioned
//     `@weaveio/weave-adapter-opencode@<version>` plugin specifier, so
//     OpenCode's own plugin loader installs and resolves the Weave plugin
//     on first run. This matches how a real user configures Weave in
//     `~/.config/opencode/opencode.json`. `.weave/` is mounted read-only
//     into /workspace/.weave by the runner so config discovery finds Loom,
//     Shuttle, categories, etc.
//   - Runs `opencode run --print-logs --log-level DEBUG --model <model>
//     "<prompt>"` with cwd set to /workspace. The model comes from the
//     WEAVE_TRAJECTORY_MODEL env var (falls back to a sensible default for
//     manual container invocation without the runner).
//   - Inherits stderr from the entrypoint process so `podman run` on the
//     host captures opencode's DEBUG log stream directly. The trajectory
//     runner parses that stderr in real time. The bind-mounted
//     /artifacts/stderr.log is no longer written by this entrypoint because
//     Windows Podman + WSL2 bind mounts do not flush writes to the host
//     until the container exits, which loses trajectory data on timeout.
//   - Writes the process exit code, as a bare integer with no trailing
//     newline processing concerns, to /artifacts/exit-code.
//   - Does not read or write secrets to disk. OPENROUTER_API_KEY is read
//     from the environment only and forwarded to the child process
//     environment; it is never logged or written to any file.
//
// This script is intentionally thin. Heavier orchestration (timeout
// enforcement, JSONL trajectory assembly) lives in the runner that invokes
// this container, not inside the sandbox.

import { ok, err, Result, ResultAsync } from "neverthrow";

const WORKSPACE_DIR = "/workspace";
const ARTIFACTS_DIR = "/artifacts";
const PROMPT_PATH = `${WORKSPACE_DIR}/prompt.txt`;
const EXIT_CODE_PATH = `${ARTIFACTS_DIR}/exit-code`;
const OPENCODE_CONFIG_PATH = `${WORKSPACE_DIR}/opencode.jsonc`;
const DEFAULT_MODEL = "openai/gpt-4o-mini";
// The Weave OpenCode plugin specifier written into opencode.jsonc. Uses the
// versioned npm form (`@weaveio/weave-adapter-opencode@<version>`) so
// OpenCode's own plugin loader installs and resolves the plugin on first
// run, exactly the way a real user config declares it (see
// `~/.config/opencode/opencode.json` for the reference form). The version
// itself is pinned via the WEAVE_ADAPTER_OPENCODE_VERSION env var baked
// into the sandbox image at build time; see Containerfile.
const DEFAULT_WEAVE_ADAPTER_OPENCODE_VERSION = "0.1.2";
function resolveWeavePluginSpec(): string {
  const version =
    Bun.env.WEAVE_ADAPTER_OPENCODE_VERSION ?? DEFAULT_WEAVE_ADAPTER_OPENCODE_VERSION;
  return `@weaveio/weave-adapter-opencode@${version}`;
}

type EntrypointError =
  | { type: "PromptReadError"; path: string; cause: unknown }
  | { type: "PromptEmptyError"; path: string }
  | { type: "ProcessSpawnError"; cause: unknown }
  | { type: "ArtifactWriteError"; path: string; cause: unknown }
  | { type: "ConfigWriteError"; path: string; cause: unknown };

function resolveModel(): string {
  const model = Bun.env.WEAVE_TRAJECTORY_MODEL;
  const raw =
    model === undefined || model.trim().length === 0 ? DEFAULT_MODEL : model;
  // OpenCode addresses OpenRouter models as `openrouter/<provider>/<model>`,
  // while Weave's eval fixtures use the OpenRouter public API slug
  // (`<provider>/<model>`). Prefix `openrouter/` when the caller supplied a
  // bare provider-qualified slug so the sandbox model selector matches
  // OpenCode's internal registry. Callers who genuinely want a non-OpenRouter
  // provider can pass the fully qualified name (e.g. `opencode/big-pickle` or
  // `anthropic-direct/...`), which we detect via the presence of a known
  // non-OpenRouter provider prefix.
  if (raw.startsWith("openrouter/") || raw.startsWith("opencode/")) {
    return raw;
  }
  return `openrouter/${raw}`;
}

function ensureOpencodeConfig(): ResultAsync<void, EntrypointError> {
  return ResultAsync.fromPromise(
    (async () => {
      const exists = await Bun.file(OPENCODE_CONFIG_PATH).exists();
      if (exists) {
        return;
      }
      const config = {
        $schema: "https://opencode.ai/config.json",
        permission: "allow",
        plugin: [resolveWeavePluginSpec()],
      };
      await Bun.write(OPENCODE_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
    })(),
    (cause): EntrypointError => ({
      type: "ConfigWriteError",
      path: OPENCODE_CONFIG_PATH,
      cause,
    }),
  );
}

function readPrompt(path: string): ResultAsync<string, EntrypointError> {
  return ResultAsync.fromPromise(
    Bun.file(path).text(),
    (cause): EntrypointError => ({ type: "PromptReadError", path, cause }),
  ).andThen((text) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return err({ type: "PromptEmptyError", path } as EntrypointError);
    }
    return ok(trimmed);
  });
}

function writeArtifact(
  path: string,
  content: string | Uint8Array,
): ResultAsync<void, EntrypointError> {
  return ResultAsync.fromPromise(
    Bun.write(path, content).then(() => undefined),
    (cause): EntrypointError => ({ type: "ArtifactWriteError", path, cause }),
  );
}

interface RunResult {
  exitCode: number;
}

// The Weave OpenCode plugin's default log destination is
// `<projectDirectory>/.weave/weave.log` (see
// `packages/adapters/opencode/src/plugin.ts`). In this sandbox,
// `/workspace/.weave` is bind-mounted read-only (see README's "Weave config
// mount" row) so config discovery can find Loom/Shuttle/categories without
// letting the container write back into the host's repo. Writing to that
// path fails with EROFS, which makes the plugin's `Plugin` function throw
// during OpenCode's plugin-load step — OpenCode swallows the failure and
// silently falls back to its baked-in `build` agent with no Weave routing
// at all (no error surfaced to entrypoint, no non-zero exit — the run
// otherwise proceeds and looks "successful" while completely skipping Loom
// delegation). `WEAVE_LOG_FILE` is the documented override for the plugin's
// log destination (see `redirectLogsToFile` in
// `packages/adapters/opencode/src/plugin.ts`); point it at a writable
// location inside the container that isn't part of any read-only mount.
// Respect a caller-supplied `WEAVE_LOG_FILE` (e.g. for local debugging)
// instead of overriding it.
const DEFAULT_SANDBOX_WEAVE_LOG_FILE = "/tmp/weave.log";

function resolveOpencodeEnv(): Record<string, string> {
  if (Bun.env.WEAVE_LOG_FILE) {
    return Bun.env as Record<string, string>;
  }
  return { ...Bun.env, WEAVE_LOG_FILE: DEFAULT_SANDBOX_WEAVE_LOG_FILE } as Record<
    string,
    string
  >;
}

function runOpencode(prompt: string, model: string): ResultAsync<RunResult, EntrypointError> {
  const spawnResult = Result.fromThrowable(
    () =>
      Bun.spawn(
        [
          "opencode",
          "run",
          "--print-logs",
          "--log-level",
          "DEBUG",
          "--model",
          model,
          prompt,
        ],
        {
          cwd: WORKSPACE_DIR,
          env: resolveOpencodeEnv(),
          stdout: "inherit",
          // Inherit stderr so it flows to `podman run`'s stderr on the host,
          // where the trajectory runner reads it directly. Do NOT pipe and
          // write to /artifacts/stderr.log: Windows Podman + WSL2 bind mounts
          // do not flush writes to the host until the container exits, so any
          // timeout kill loses the trajectory. See handoff:
          // .weave/handoffs/harness-trajectory-evals-phase-1-continuation.md
          stderr: "inherit",
        },
      ),
    (cause): EntrypointError => ({ type: "ProcessSpawnError", cause }),
  )();

  if (spawnResult.isErr()) {
    return ResultAsync.fromPromise(
      Promise.reject(spawnResult.error),
      (cause) => cause as EntrypointError,
    );
  }

  const proc = spawnResult.value;

  return ResultAsync.fromPromise(
    (async () => {
      const exitCode = await proc.exited;
      return { exitCode };
    })(),
    (cause): EntrypointError => ({ type: "ProcessSpawnError", cause }),
  );
}

async function main(): Promise<number> {
  const configResult = await ensureOpencodeConfig();
  if (configResult.isErr()) {
    // Config write failure is fatal; surface via exit code. We cannot use
    // stderr for a durable error record because it's inherited to the parent
    // podman process, but the runner will observe the non-zero exit.
    process.stderr.write(
      `entrypoint: failed to write opencode config at ${OPENCODE_CONFIG_PATH}: ${JSON.stringify(
        configResult.error,
      )}\n`,
    );
    await writeArtifact(EXIT_CODE_PATH, "1");
    return 1;
  }

  const promptResult = await readPrompt(PROMPT_PATH);
  if (promptResult.isErr()) {
    process.stderr.write(
      `entrypoint: failed to read prompt at ${PROMPT_PATH}: ${JSON.stringify(
        promptResult.error,
      )}\n`,
    );
    await writeArtifact(EXIT_CODE_PATH, "1");
    return 1;
  }

  const runResult = await runOpencode(promptResult.value, resolveModel());
  if (runResult.isErr()) {
    process.stderr.write(
      `entrypoint: failed to run opencode: ${JSON.stringify(runResult.error)}\n`,
    );
    await writeArtifact(EXIT_CODE_PATH, "1");
    return 1;
  }

  const { exitCode } = runResult.value;

  const exitCodeWrite = await writeArtifact(EXIT_CODE_PATH, `${exitCode}`);

  if (exitCodeWrite.isErr()) {
    // Artifact write failed; surface this via the process exit code even
    // though the opencode run itself may have succeeded. The runner treats
    // a missing/short-circuited artifact write as a sandbox failure.
    return 1;
  }

  return exitCode;
}

const exitCode = await main();
process.exit(exitCode);
