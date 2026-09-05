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
| Secrets | `OPENROUTER_API_KEY` passed as an environment variable only; never mounted as a file, never written to disk by the entrypoint |
| Model selection | `WEAVE_TRAJECTORY_MODEL` env var (falls back to `openai/gpt-4o-mini` if unset, for manual container invocation without the runner) |
| Workspace mount | `/workspace` (read-write; OpenCode's project directory and where `prompt.txt` lives) |
| Weave plugin | Declared in `/workspace/opencode.jsonc` as `@weaveio/weave-adapter-opencode@<version>`. OpenCode installs and resolves the plugin itself on first run, exactly as a real user config does. The pinned version is baked into the sandbox image via `WEAVE_ADAPTER_OPENCODE_VERSION` in `Containerfile`. |
| Weave config mount | `/workspace/.weave` (read-only; the repo's `.weave/` directory, so OpenCode's config discovery finds Loom, Shuttle, categories, etc.) |
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
- The repo's `.weave/` directory is mounted read-only at `/workspace/.weave`,
  so OpenCode's config discovery (workspace-local `opencode.jsonc`, then
  `$OPENCODE_CONFIG_DIR/opencode.jsonc`) finds Loom, Shuttle, categories, etc.

## Running

This is the exact invocation shape the runner uses. `$workspace` and
`$artifacts` are per-case ephemeral directories created by the runner before
the container starts; `$workspace/prompt.txt` must exist before `podman run`
is invoked. `$repoRoot` is the repository root (absolute path).

```powershell
podman run --rm `
  --timeout 300 `
  -e OPENROUTER_API_KEY=$env:OPENROUTER_API_KEY `
  -e WEAVE_TRAJECTORY_MODEL=openai/gpt-4o-mini `
  -v ${workspace}:/workspace:Z `
  -v ${artifacts}:/artifacts:Z `
  -v ${repoRoot}/.weave:/workspace/.weave:ro `
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
  secrets; `OPENROUTER_API_KEY` must stay env-only per the sandbox contract.
- After the container exits (or is killed by the timeout), the runner has
  already collected the container's stderr in memory (via `podman run`'s
  stderr stream) and parses it directly. `$artifacts/exit-code` is read to
  determine whether the underlying `opencode run` invocation succeeded.

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
