# `sandboxes/opencode` — OpenCode trajectory-eval sandbox

This is the `sandbox_profile: "opencode-default"` container referenced by the
harness-trajectory eval case schema in
[`docs/specs/33-spec-harness-trajectory-evals`](../../docs/specs/33-spec-harness-trajectory-evals/33-spec-harness-trajectory-evals.md)
and by [ADR 0008](../../docs/adr/0008-harness-trajectory-evals.md). The runner
treats this image as a black box: give it `(workspace, prompt, model
credentials)`, get back `(container stderr, exit-code)`. The runner is
responsible for turning the container's stderr into a normalized
`TrajectoryEvent` stream (Channel A log parsing per ADR 0008); this sandbox
does not know about that format.

## Contract

| Concern | Value |
| --- | --- |
| Prompt input | `/workspace/prompt.txt` (plain UTF-8 text, trimmed before use) |
| Command run inside the container | `opencode run --print-logs --log-level DEBUG --model <model> "<prompt>"` |
| stderr capture | Inherited to the parent `podman run` process on the host. The runner reads the container's stderr directly, in real time, from `podman run`'s stderr stream. The entrypoint does NOT write `/artifacts/stderr.log`: Windows Podman + WSL2 bind mounts do not flush writes to the host until the container exits, which loses the trajectory whenever the runner enforces a timeout. |
| Exit code capture | `/artifacts/exit-code` (bare integer, no trailing newline guarantee) |
| Secrets | `OPENROUTER_API_KEY` passed to the container as an environment variable only; never mounted as a file, never written to disk by the entrypoint. The runner (`BunPodmanClient`) forwards it to `podman run` via Podman's *name-only* `-e OPENROUTER_API_KEY` pass-through — the value itself is set only in the `podman` process's own environment (via `Bun.spawn`'s `env` option), never interpolated into `podman` argv. This means the key never appears in `ps`/`/proc/<pid>/cmdline` output or in any log line that includes the spawned `args`. |
| Model selection | `WEAVE_TRAJECTORY_MODEL` env var (falls back to `openai/gpt-4o-mini` if unset, for manual container invocation without the runner) |
| Workspace mount | `/workspace` (read-write; OpenCode's project directory and where `prompt.txt` lives) |
| Weave plugin | Declared in `/workspace/opencode.jsonc` as `@weaveio/weave-adapter-opencode@<version>`. OpenCode installs and resolves the plugin itself on first run, exactly as a real user config does. The pinned version is baked into the sandbox image via `WEAVE_ADAPTER_OPENCODE_VERSION` in `Containerfile`. |
| Weave config mount | Two narrow, read-only mounts — `/workspace/.weave/config.weave` and (when present) `/workspace/.weave/prompts` — so OpenCode's config discovery finds Loom, Shuttle, categories, etc. The repo's whole `.weave/` directory is deliberately **not** mounted: config discovery (`packages/config/src/discovery.ts`, `packages/config/src/resolve.ts`) only ever reads `config.weave` and `prompt_file` entries under `prompts/`. The rest of `.weave/` — `runtime/` (session snapshots, the journal DB), `weave.log`, `plans/`, `learnings/` — can carry prior session content and must not be exposed inside an untrusted-model-controlled sandbox. |
| Weave plugin log file | `/tmp/weave.log` inside the container (`WEAVE_LOG_FILE`, set by the entrypoint unless already present in the environment). The Weave plugin's default log destination is `<projectDirectory>/.weave/weave.log`, which would land under the read-only `.weave` mount above and fail with `EROFS`, silently disabling the plugin (see `entrypoint.ts` for the full explanation). Do not remove this override without also making the `.weave` mount writable. |
| Artifacts mount | `/artifacts` (read-write; where `exit-code` lands) |
| Auto-update | Disabled (`OPENCODE_DISABLE_AUTOUPDATE=true`) |
| Timeout | Not enforced inside the container. The caller (runner) must enforce a wall-clock timeout externally, e.g. via `podman run --timeout <seconds>` or a `timeout(1)`-style wrapper, and treat a killed container as a sandbox failure. |

Why `/workspace/prompt.txt` rather than an argv-passed prompt: passing
untrusted, possibly-multiline prompt text through container argv risks
shell-quoting and length-limit surprises across `podman`/`docker` versions.
A file mount is simpler to reason about and matches how the workspace itself
is already mounted.

## Building

```powershell
podman build -t weave-sandbox-opencode-default -f sandboxes/opencode/Containerfile sandboxes/opencode
```

## How Weave is wired in

OpenCode has no built-in awareness of Weave. Without extra wiring it falls
back to its baked-in `build` agent and a hardcoded default model, which
breaks any eval case that expects Loom-style routing to Shuttle. Two
elements fix that:

- The entrypoint writes `/workspace/opencode.jsonc` on first run declaring
  `"plugin": ["@weaveio/weave-adapter-opencode@<version>"]`. OpenCode
  installs and resolves the plugin itself, exactly as a real user config
  does (see `~/.config/opencode/opencode.json` for the reference form).
  The pinned version is set via `WEAVE_ADAPTER_OPENCODE_VERSION` in the
  Containerfile and read at runtime by `entrypoint.ts`.
- The repo's `.weave/config.weave` (and `.weave/prompts/`, when present) are
  mounted read-only at `/workspace/.weave/config.weave` and
  `/workspace/.weave/prompts`, so OpenCode's config discovery
  (workspace-local `opencode.jsonc`, then `$OPENCODE_CONFIG_DIR/opencode.jsonc`)
  finds Loom, Shuttle, categories, etc. Only these two paths are mounted —
  not the whole `.weave/` tree — because they are the only inputs config
  discovery reads (see the "Weave config mount" row above).

## Running

This is the exact invocation shape the runner uses. `$workspace` and
`$artifacts` are per-case ephemeral directories created by the runner before
the container starts; `$workspace/prompt.txt` must exist before `podman run`
is invoked. `$repoRoot` is the repository root (absolute path).

**Secret handling**: `OPENROUTER_API_KEY` is passed to `podman run` as a
*name-only* env pass-through (`-e OPENROUTER_API_KEY`, no `=value`). This
tells Podman to forward the variable from its own process environment into
the container — the value is never written into `podman` argv, so it never
appears in a process listing or in any log line that captures the spawned
command's arguments. The runner's `BunPodmanClient` sets the actual value
only in the `podman` process's own environment (`Bun.spawn`'s `env` option).
When invoking `podman run` manually from a shell, the equivalent is still
`-e OPENROUTER_API_KEY` with the variable already exported in your shell —
do **not** write `-e OPENROUTER_API_KEY=$env:OPENROUTER_API_KEY` in scripts,
CI logs, or anywhere argv might be captured or echoed.

```powershell
podman run --rm `
  --timeout 300 `
  -e OPENROUTER_API_KEY `
  -e WEAVE_TRAJECTORY_MODEL=openai/gpt-4o-mini `
  -v ${workspace}:/workspace:Z `
  -v ${artifacts}:/artifacts:Z `
  -v ${repoRoot}/.weave/config.weave:/workspace/.weave/config.weave:ro `
  -v ${repoRoot}/.weave/prompts:/workspace/.weave/prompts:ro `
  weave-sandbox-opencode-default
```

Notes:

- `--timeout 300` is a starting point (5 minutes), not a fixed contract value.
  The runner should set this per-suite based on `max_duration_seconds` from
  the case's `expected_outcome` (see spec 33). If `podman run --timeout` kills
  the container before `/artifacts/exit-code` is written, the runner must
  treat the missing file as a timeout failure, not as an unknown result.
- `:Z` on the volume mounts relabels the bind mount for SELinux hosts. Drop it
  on non-SELinux hosts (e.g. plain Docker Desktop) if it causes mount errors.
- No other environment variables are required. Do not add file-mounted
  secrets; `OPENROUTER_API_KEY` must stay env-only per the sandbox contract,
  and must always use the name-only `-e OPENROUTER_API_KEY` form — never
  `-e OPENROUTER_API_KEY=<value>` — so the value is never captured in argv.
- The `.weave/prompts` mount is conditional on that directory existing in
  `$repoRoot`; omit the `-v ${repoRoot}/.weave/prompts:...` line if the repo
  has no `prompts/` directory yet.
- After the container exits (or is killed by the timeout), the runner has
  already collected the container's stderr in memory (via `podman run`'s
  stderr stream) and parses it directly. `$artifacts/exit-code` is read to
  determine whether the underlying `opencode run` invocation succeeded.
- Raw sandbox stderr can be dumped locally for debugging via
  `WEAVE_TRAJECTORY_DUMP_STDERR=<dir>` (see
  `packages/adapters/opencode/src/trajectory/opencode-trajectory-runner.ts`).
  The runner always redacts known secret-shaped substrings (API keys, bearer
  tokens, GitHub tokens, hex blobs) before writing, refuses to write anything
  at all when `CI` or `WEAVE_EVAL_PUBLISH_MODE` is set, and writes with
  `0o600` permissions. This is a local-only diagnostic aid, never enabled by
  default, and redaction is best-effort pattern matching — treat any dump
  directory as sensitive and do not commit or upload its contents.

## Pinning

- Base image: `docker.io/library/node@sha256:...` (see `Containerfile` for the
  exact pinned digest and the command to re-resolve it). Pinned by content
  digest, not a mutable tag, so image contents cannot drift silently.
- `opencode-ai`: pinned to an exact npm version (see `OPENCODE_VERSION` in the
  `Containerfile`). The build verifies the installed CLI reports the pinned
  version and fails loudly otherwise.
- `@weaveio/weave-adapter-opencode`: pinned via `WEAVE_ADAPTER_OPENCODE_VERSION`
  in the `Containerfile`. The value is read at runtime by `entrypoint.ts`
  and written into `opencode.jsonc` as the versioned plugin specifier.
  OpenCode installs and resolves the plugin itself on first run.
- Bumping any pin is a deliberate, reviewed change, not an automatic one.
  There is no formal pinning-policy ADR yet; `docs/adr/0008-harness-trajectory-evals.md`
  (rollout step 3) is the closest tracking document until one exists.

## Files

- `Containerfile` — pinned image definition; see inline comments for the
  rationale behind each pin and each `RUN` step.
- `entrypoint.ts` — the Bun script the container `ENTRYPOINT` shells into.
  Reads the prompt, spawns `opencode` with stderr inherited (so the host's
  `podman run` captures the trajectory log stream), and writes
  `/artifacts/exit-code`. Fallible steps return typed `neverthrow` results
  internally; the script still exits with a plain process exit code at the
  boundary, since that is the only contract a container `ENTRYPOINT` can
  expose.
- `package.json` — pins the `neverthrow` dependency used by `entrypoint.ts`.
  Not published; exists only to give the sandbox image a resolvable
  `node_modules/neverthrow`.
