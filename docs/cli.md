# Weave CLI

The Weave CLI is the user-facing command surface for GitHub issue #26. It creates and validates `.weave` configuration and safely hands Weave intent to supported harness installers. It does **not** start, supervise, or drive third-party harness runtimes.

Related docs:

- [Adapter boundary](./adapter-boundary.md)
- [Product vision](./product-vision.md)
- [Config Loading](./config-loading.md)
- [Agent Evals](./agent-evals.md)

## Local PATH installation

The CLI package is built with Bun and exposes a `weave` binary from `@weave/cli`.

```bash
bun install
bun run build
bun link ./packages/cli
command -v weave
weave --help
```

The local link expects the package to be built first because the package `bin` entry points at `packages/cli/dist/main.js`.

## Package runners

Once `@weave/cli` is publishable, these package-runner forms should execute the same command surface:

```bash
bunx @weave/cli --help
npx @weave/cli --help
npm exec @weave/cli -- --help
pnpm dlx @weave/cli --help
```

## Theme and accessibility

`weave --help` renders a left-indented `WEAVE` banner generated through the npm `figlet` package with the `Larry 3D` FIGlet font. When terminal color is supported, the CLI applies an in-process lolcat-style rainbow equivalent to `figlet -f "larry3d" WEAVE | lolcat -S 27 --spread 2`, avoiding shelling out to external `figlet` or `lolcat` binaries. Automation and accessibility fallbacks are supported through standard terminal conventions:

```bash
NO_COLOR=1 weave --help
```

When color is disabled or stdout is not a TTY, output remains readable plain text.

## `weave validate`

Use `weave validate` to validate effective, scoped, or explicit Weave config.

```bash
weave validate                 # effective config for the current project
weave validate --project       # ./.weave/config.weave
weave validate --global        # ~/.weave/config.weave
weave validate --path file.weave
weave validate --path file.weave --json
```

Human-readable success output summarizes counts only:

- agents
- categories
- workflows
- disabled entries
- log level

The CLI intentionally avoids printing full private prompt/config content in normal success output. Parse and validation failures use `file:line:column: message` formatting where the DSL pipeline provides location data.

The root `validate-config` script delegates to the CLI:

```bash
bun run validate-config
```

## `weave prompt`

Use `weave prompt` to inspect composed agent prompts or list available agent names from the effective config.

```bash
weave prompt list
weave prompt list --json
weave prompt inspect loom
weave prompt inspect loom --json
```

Subcommands:

- `weave prompt list` prints available agent names, including generated category shuttle agents.
- `weave prompt inspect <agent>` renders the fully composed prompt for the requested agent.
- `--json` emits machine-readable output for either subcommand.

Running `weave prompt` without a subcommand prints inline usage and exits with code `1`.

## `weave prompt self-modify`

`weave prompt self-modify` prints a deterministic, text-only guide that tells an agent exactly which files to read, what rules to follow, and how to verify changes when modifying Weave's own configuration.

```bash
weave prompt self-modify                  # guide for global scope (default)
weave prompt self-modify --scope global   # explicit global scope
weave prompt self-modify --scope local    # guide for project scope
```

### v1 constraints

| Constraint | Detail |
| --- | --- |
| **Text-only output** | The guide is always plain Markdown text. `--json` is rejected with exit code `1`. |
| **Scope-only tailoring** | The only accepted flag is `--scope global\|local`. No other tailoring flags are accepted. |
| **Default scope: global** | When `--scope` is omitted, the guide targets the global scope (`~/.weave/`). |
| **No extra positional args** | Any extra positional arguments after `self-modify` are rejected with exit code `1`. |
| **No config loading** | The command does not load or validate the current Weave config. It prints the guide unconditionally. |

### What the guide covers

The printed guide includes:

- The selected scope label (`global (~/.weave/)` or `local (.weave/)`)
- The canonical config file path and prompts directory path for the scope
- A pre-flight checklist naming `docs/dsl-reference.md` and `docs/config-loading.md` as required reading
- A note that `docs/prompt-composition.md` must be read before any prompt-related change
- A clear statement that **`packages/docs/` is a public mirror, not the canonical source** — the authoritative docs live in `docs/` at the repo root
- Target-aware rules (global vs. local scope differences)
- A step-by-step workflow: identify → read DSL section → edit config → place prompt files → validate → inspect
- Common DSL patterns (override builtin, add agent, add category, disable agent)
- Prompt-specific rules (Mustache context fields, `{{{delegation.section}}}`, mutual exclusivity of `prompt`/`prompt_file`)
- Verification commands (`weave validate`, `weave prompt list`, `weave prompt inspect`)

### Canonical doc authority

The guide explicitly names root `docs/` as the canonical source and `packages/docs/` as a public mirror. Agents following the guide must load `docs/dsl-reference.md` and `docs/config-loading.md` from the repo root — not from `packages/docs/`. The two may diverge; `docs/` always wins.

### Base docs first

The guide enforces a **base docs first** reading order:

1. `docs/dsl-reference.md` — DSL syntax reference
2. `docs/config-loading.md` — merge rules, builtin agents, prompt-file resolution
3. `docs/prompt-composition.md` — only when the change touches prompt text or prompt fields

Agents must not skip to target-specific or pattern-specific sections without first reading the base docs.

### Loom routing note

When Loom receives a self-modification request, it should:

1. Clarify the config object type (agent override, new agent, category, workflow, settings, disable block) before asking about scope.
2. Ask about scope only after the object type is clear.
3. Run `weave prompt self-modify [--scope <scope>]` to obtain the guide.
4. Load `docs/dsl-reference.md` and `docs/config-loading.md` before any edits.
5. Load `docs/prompt-composition.md` before any prompt-related edits.

See [Config Loading — Config Discovery](./config-loading.md#config-discovery) for the canonical path definitions used by the guide.

## `weave init`

`weave init` creates a starter Weave config directory containing `config.weave` and `prompts/`.

```bash
weave init --scope local --yes
weave init --scope global --yes
weave init --scope local --install-dir ./custom-weave --yes
```

Scope defaults:

| Scope    | Default directory      | Purpose                                                |
| -------- | ---------------------- | ------------------------------------------------------ |
| `global` | `~/.weave`             | Shared user-level defaults across projects             |
| `local`  | `<projectRoot>/.weave` | Project-level configuration for the current repository |

Safety behavior:

- Existing `config.weave` is skipped by default.
- `--force` writes `config.weave.bak` before overwriting.
- `--yes` / `-y` accepts safe defaults without prompts.
- Non-TTY invocations do not hang; use decisive flags such as `--scope` and `--yes` in scripts.
- Prompt cancellation exits cleanly with code `0`.

## `weave init migrate`

`weave init migrate` converts a legacy OpenCode JSONC config (`weave-opencode.jsonc`) into the current `.weave` DSL. Migration is also offered automatically during ordinary `weave init` when a legacy source file is detected for the chosen scope.

### Entry paths

**Explicit migrate mode** — direct invocation, interactive or scripted:

```bash
weave init migrate --scope local
weave init migrate --scope global
weave init migrate --scope local --yes
weave init migrate --scope global --yes
```

**Ordinary init discovery** — migration is offered after scope selection when the legacy source exists:

```bash
weave init --scope local   # offers migration if .opencode/weave-opencode.jsonc exists
weave init --scope global  # offers migration if ~/.config/opencode/weave-opencode.jsonc exists
weave init --yes           # auto-migrates non-interactively when legacy source is found
```

### Scope-aware legacy source paths

| Scope    | Legacy source path                                |
| -------- | ------------------------------------------------- |
| `local`  | `<projectRoot>/.opencode/weave-opencode.jsonc`    |
| `global` | `~/.config/opencode/weave-opencode.jsonc`         |

### Canonical migration destinations

Migration **always** writes to the canonical Weave config paths. These are the same paths used by `discoverAndParse()` in `@weave/config`:

| Scope    | Destination                         |
| -------- | ----------------------------------- |
| `local`  | `<projectRoot>/.weave/config.weave` |
| `global` | `~/.weave/config.weave`             |

See [Config Loading — Config Discovery](./config-loading.md#config-discovery) for the canonical path definitions.

### `--install-dir` behavior in migrate mode

`--install-dir` is **ignored** in migrate mode. Migration always writes to the canonical scope destination (`~/.weave/config.weave` or `<projectRoot>/.weave/config.weave`) regardless of any `--install-dir` value. This is intentional: `--install-dir` is a starter-config scaffolding option for `weave init` that allows non-standard install locations; migration must stay aligned with the canonical paths that `@weave/config` discovers at runtime. Allowing `--install-dir` to redirect migration output would produce a config file that the config loader would never find.

### Preflight summary

Before any file is written, migration shows a preflight summary:

```text
Migration preflight

  Source:         /project/.opencode/weave-opencode.jsonc
  Destination:    /project/.weave/config.weave
  Scope:          local
  Overwrite:      no (destination does not exist)
  Skipped fields: none
```

When the destination already exists:

```text
Migration preflight

  Source:         /project/.opencode/weave-opencode.jsonc
  Destination:    /project/.weave/config.weave
  Scope:          local
  Overwrite:      yes — backup will be created at /project/.weave/config.weave.bak
  Skipped fields: 2 field(s) will be skipped with warnings
```

### Safety behavior

- **Validation before write**: generated `.weave` DSL is validated through the normal `parseConfig()` pipeline before any file is mutated. If validation fails, migration aborts with no destination or backup written.
- **Overwrite backup**: when the destination already exists, exactly one backup is written at `<destination>.bak` before the destination is overwritten. No double-backup or extra files are created.
- **Source preservation**: the legacy JSONC source file is never renamed or deleted after successful migration. Users retain a manual rollback path.
- **Provenance comment**: generated `config.weave` begins with a comment block naming the legacy source, scope, and generator:

  ```weave
  # Migrated from legacy OpenCode JSONC config
  # Source: /project/.opencode/weave-opencode.jsonc
  # Scope: local
  # Generated by: weave init migrate
  ```

- **JSONC comment stripping**: arbitrary comments from the legacy JSONC source are not preserved in the generated DSL. Only structured field values are converted.

### `--yes` scripting behavior

`--yes` enables fully non-interactive migration:

```bash
# Local migration — no prompts, overwrites with backup if destination exists
weave init migrate --scope local --yes

# Global migration — no prompts
weave init migrate --scope global --yes
```

Without `--yes` in a non-TTY environment, migration exits with code `1` and a message directing the user to add `--yes`.

### Warning semantics

Migration uses best-effort partial conversion: supported fields are written even when some legacy fields are skipped. When fields are skipped, a warning summary is printed after the success message:

```text
⚠  Migration warnings — the following legacy fields were skipped:

  • workflows: legacy workflow definitions are not supported in migration v1; define workflows using the current DSL workflow syntax
  • continuation: legacy continuation settings are not supported in migration v1; use the current DSL continuation block if needed
  • custom_agents.loom: "loom" collides with a builtin agent name; skipped to avoid silently overriding the builtin
  • agents.shuttle.tools.call_weave_agent: "call_weave_agent" is a harness-specific tool name that cannot be mapped to an abstract tool_policy capability; skipped
```

**Exit code**: migration exits with code `0` even when warnings are emitted, as long as the destination file was written successfully.

### Supported field conversions

| Legacy field         | Current DSL output                        |
| -------------------- | ----------------------------------------- |
| `disabled_agents`    | `disable agents [...]`                    |
| `disabled_hooks`     | `disable hooks [...]`                     |
| `disabled_skills`    | `disable skills [...]`                    |
| `log_level`          | `settings { log_level <VALUE> }`          |
| `agents.<name>`      | `agent <name> { ... }` (builtin override) |
| `custom_agents.<name>` | `agent <name> { ... }` (new agent)      |
| `categories.<name>`  | `category <name> { ... }`                 |
| `model` + `fallback_models` | `models [primary, ...fallbacks]`   |
| `tools`              | `tool_policy { ... }` (known tools only)  |
| `prompt_file`        | `prompt_file "..."` (bare filenames only) |

**Explicitly skipped in migration v1** (warn + skip): `workflows`, `continuation`, `analytics`, `background`.

### Agent namespace rules

- `agents` entries are treated as **overrides of existing builtin agent names** (`loom`, `tapestry`, `shuttle`, `pattern`, `thread`, `spindle`, `weft`, `warp`). Non-builtin names under `agents` are warned and skipped — they do not silently become new agents.
- `custom_agents` entries become new `agent <name>` blocks when the name does not collide with a builtin. Collisions are warned and skipped.
- `categories` become `category <name>` blocks. The current DSL generates `shuttle-<category>` semantics automatically — no standalone `agent shuttle-<category>` entries are emitted.

### Prompt file translation

`prompt_file` values are preserved only when the path is a bare filename with no directory separators (e.g. `"loom.md"`). Paths with directory components (e.g. `"subdir/loom.md"`, `"/abs/path.md"`, `"../prompts/loom.md"`) cannot be safely translated to the current `.weave/prompts/` convention and are warned and skipped.

See [Config Loading — Prompt File Resolution](./config-loading.md#prompt-file-resolution) for how `prompt_file` values are resolved at runtime.

### Post-migration flow

After a successful migration write, `weave init migrate` continues into the normal harness selection and configuration flow. This matches the behavior of ordinary `weave init` — migration is not a terminal command.

## Harness detection and installation

Detection is side-effect free. It may probe config paths, check readability, inspect PATH binaries, and read optional version strings through injected probes, but it must not create directories, write files, edit config, or launch harness runtimes.

Supported detection IDs:

- `opencode`
- `claude-code`
- `pi`

Installer support is intentionally separate from detection support. OpenCode has a first installer boundary; Claude Code and Pi currently report unsupported installer messages until adapter-specific installers exist.

```bash
weave init --harness opencode --yes
weave init --harness pi --yes        # explicit unsupported/undetected failure until supported
weave init --all-harnesses --yes     # install supported detected harnesses, skip unsupported ones
```

Harness writes only happen after explicit non-interactive flags or interactive confirmation.

## No runtime execution

Weave configures harnesses; harnesses run themselves. `weave run`, if encountered for transition compatibility, exits with a message directing users to `weave init` and harness-specific launch commands.

## `weave eval run`

`weave eval run` executes agent evaluation suites against the built-in model matrix. It is the primary eval entry point for CI and local verification.

Completed eval runs exit with code `0` even when one or more cases miss their pass threshold. Threshold misses are captured in `run-summary.json` and per-suite score files. The command exits non-zero for hard orchestration failures such as invalid input, missing secrets, model matrix/load failures, bundle write/publish failures, or suite-level partial failures that prevent complete results.

```bash
weave eval run                                        # run all suites against default models (3)
weave eval run --agent loom                           # restrict to loom-routing suite
weave eval run --agent tapestry                       # restrict to tapestry-execution suite
weave eval run --model anthropic/claude-sonnet-4.5    # restrict to one model (exact match)
weave eval run --case loom-route-backend-api          # restrict to one case ID (exact match)
weave eval run --dry-run                              # print what would run, no execution
weave eval run --raw-artifacts                        # emit raw prompt text locally (NEVER in CI)
```

Filters can also be supplied via environment variables — useful in CI workflow dispatch:

```bash
WEAVE_EVAL_AGENT=loom weave eval run
WEAVE_EVAL_MODEL=anthropic/claude-sonnet-4.5 weave eval run
WEAVE_EVAL_CASE=loom-route-backend-api weave eval run
```

CLI flags and env vars are merged. Conflicting values for the same filter key (CLI vs env) cause a hard `DuplicateConflictingInput` error. Same-value duplicates are silently collapsed. Empty env filter values are treated as unset, which lets CI workflow dispatch pass blank optional inputs when you want no filter. Empty CLI flag values are still rejected.

### Required environment variable

```bash
export OPENROUTER_API_KEY=<your-key>
```

`OPENROUTER_API_KEY` must be set before running `weave eval run`. The runner validates it at startup and aborts immediately if absent or empty. The key value is **never logged, printed, or serialized** anywhere in the eval pipeline — it is passed directly to the OpenRouter HTTP client and treated as a secret.

### Filter semantics

All three filters use **strict exact-match**:

- `--agent` must match either the suite name (`loom-routing`, `tapestry-execution`) or the short agent name (`loom`, `tapestry`). No other values are accepted.
- `--model` must exactly match a model `id` in `evals/model-matrix.json`. No substring matching. An unmatched value causes `EmptyModelSet` and lists allowed IDs.
- `--case` must exactly match the `id` field in a case fixture file. No glob or prefix matching.

No filter means all values in that dimension are included. A no-filter run executes all three default models against all cases in both suites. For env-backed filters, unset and empty values both mean no filter.

### `--dry-run`

Dry-run prints filters and confirms no execution will occur. No model calls are made, no artifacts are written, and exit code is always `0`. Use this to verify a filter combination before running live.

```bash
weave eval run --agent loom --model anthropic/claude-sonnet-4.5 --dry-run
```

### `--raw-artifacts` — local-only, never CI

> **Security warning**: `--raw-artifacts` is rejected in CI environments (`CI=true`). Passing it in a CI workflow step is a hard validation error. Raw artifacts contain composed prompt text and full transcripts and must never be committed or published.

When enabled locally, raw artifacts are written to `eval-bundles/<sha7>-<date>/raw/`. Filename components are sanitized before write, and the resolved path must stay under `raw/`. Add this directory to `.gitignore`. Raw files must never be committed to any repository.

### Prompt provenance

Every eval run produces a **prompt provenance manifest** — a publishable JSON record that captures the state of agent prompts without storing raw prompt text. Manifests are hash-first and summary-first:

| Field | Description |
|---|---|
| `hash` | SHA-256 hex digest of the composed prompt (UTF-8 encoded) |
| `summary` | Sanitized human-readable description of prompt provenance |
| `byteLength` | Byte length of the composed prompt (UTF-8) |
| `charLength` | Character length of the composed prompt |
| `sources` | Source descriptors: `builtin`, `file`, `inline`, or `generated` per layer |
| `gitSha` | Git commit SHA at capture time |
| `capturedAt` | ISO 8601 timestamp |

The hash is deterministic: the same composed prompt always yields the same hash. Hash changes in CI signal prompt drift without exposing prompt content.

### Eval source layout

```text
packages/cli/src/evals/
├── types.ts                    Zod schemas and inferred types for fixtures and provenance
├── case-loader.ts              Loads eval case and rubric fixtures
├── model-matrix.ts             Loads and validates the model matrix
├── input-validation.ts         Parses and validates CLI flags for eval run
├── prompt-snapshots.ts         Composes agent prompts and produces PromptSnapshot records
├── provenance.ts               Derives PromptProvenanceRecord and PromptProvenanceManifest
├── sanitizer.ts                Central allowlist sanitizer (source of truth for publishable fields)
├── artifact-bundle.ts          ArtifactBundleWriter — deterministic bundle write
├── raw-artifacts.ts            RawArtifactsWriter — local-only raw artifact write
├── results-repo.ts             ResultsRepoPublisher interface and policy enforcement
├── runner.ts                   EvalOrchestrator — top-level orchestration
├── loom-routing-runner.ts      LoomRoutingRunner
├── tapestry-execution-runner.ts  TapestryExecutionRunner
├── openrouter-client.ts        OpenRouter model inference client
├── langchain-agent-evals.ts    LangChain AgentEvals scorer (rubric judge)
└── env.ts                      readEvalEnv — OPENROUTER_API_KEY validation
```

Eval fixture layout:

```text
evals/
├── model-matrix.json           Canonical model matrix (default 3: see file for current models)
├── cases/
│   ├── loom-routing/           Loom routing eval cases
│   └── tapestry-execution/     Tapestry execution eval cases
└── rubrics/
    ├── loom-routing/           Scoring rubrics for loom-routing cases
    └── tapestry-execution/     Scoring rubrics for tapestry-execution cases
```

### Artifact bundle layout

Bundles are written to `eval-bundles/<gitSha7>-<YYYY-MM-DD>/`:

```text
eval-bundles/
└── abc1234-2026-06-10/
    ├── bundle-index.json           Top-level bundle manifest
    ├── run-summary.json            Aggregate pass/fail counts
    ├── score-loom-routing.json     Sanitized score records (no rationale text)
    ├── score-tapestry-execution.json
    ├── prompt-hashes.json          Prompt hash records (no raw text)
    └── provenance-manifest.json    Full sanitized provenance manifest
```

The directory name is deterministic: the same git SHA and date always produce the same path.

### CI artifact model

The eval CI workflow is **manual-only** (`workflow_dispatch`). It does not run on push, PR, or schedule.

In CI, the workflow:

1. Runs `weave eval run` with no filters (all suites, all default models).
2. Writes sanitized `eval-bundles/` artifacts locally within the workflow runner.
3. **Publishes** the sanitized bundle to `weave-io/weave-agent-evals` via the GitHub REST Contents API (`GitHubContentsPublisher`). Files land under `runs/<sha7>-<YYYY-MM-DD>/` in the target repo.
4. Uploads the bundle directory as a GitHub Actions artifact named `eval-bundles-<run-id>` with **30-day retention** (backup for local inspection). The run ID is included in metadata only when `GITHUB_RUN_ID` is digits-only.

The workflow sets `WEAVE_EVAL_PUBLISH_MODE=publish` in the eval run step env block, which activates `GitHubContentsPublisher`. The `raw/` subdirectory is never included in the published bundle — it is filtered by `GitHubContentsPublisher` before any upload. See [Agent Evals — CI Artifact Model](./agent-evals.md#ci-artifact-model) for the full CI specification, environment variable table, and security invariants.

### Publish token (`EVAL_RESULTS_REPO_TOKEN`)

`EVAL_RESULTS_REPO_TOKEN` gates external bundle publication. It must be configured as an encrypted GitHub Actions repository secret. In the CI workflow, it is passed to the eval run step **only** — it is never available in the upload-artifact step or any other step.

- Token must have write access scoped to `weave-io/weave-agent-evals` only.
- `ArtifactBundleWriter` enforces its presence before any external push.
- `GitHubContentsPublisher` passes the token exclusively as an `Authorization: Bearer <token>` HTTP header — never in URLs, shell arguments, log output, or artifact content.
- `enforcePublishPolicy()` re-runs the full sanitizer on the bundle before any file is pushed.

### Security warnings summary

> **Never do any of the following**:
>
> - Commit or log `OPENROUTER_API_KEY` values.
> - Commit or log `EVAL_RESULTS_REPO_TOKEN` values.
> - Use `--raw-artifacts` in any CI workflow step.
> - Commit files from `eval-bundles/raw/` or any file containing `composedPrompt` or `rawContent`.
> - Pass raw artifacts to `ArtifactBundleWriter` — all publishable output must go through `sanitizer.ts`.

See [Agent Evals](./agent-evals.md) for the full architecture, security checklist, and guide to adding new eval cases.

## CLI command module structure

The CLI source is organized into focused modules:

```text
packages/cli/src/
├── commands/
│   ├── init.ts        # weave init — planning, prompts, scaffold, harness install, summary
│   ├── migrate.ts     # weave init migrate — orchestration flow
│   ├── prompt.ts      # weave prompt
│   ├── validate.ts    # weave validate
│   └── runtime.ts     # weave runtime
└── migration/
    ├── types.ts                  # Shared migration types (MigrationPlan, ConversionWarning, etc.)
    ├── legacy-jsonc-converter.ts # JSONC-to-DSL conversion logic
    ├── conversion-warnings.ts    # Warning summary rendering
    ├── migration-plan.ts         # Path resolution and plan construction
    └── migration-write.ts        # Validated write orchestration
```

`init.ts` owns init flow only. `migrate.ts` owns the `weave init migrate` orchestration. All legacy JSONC conversion logic lives in `migration/`.

## Proof artifact security

Proof artifacts and terminal captures are committed to the repository. Before committing them:

- Replace API keys, tokens, passwords, and secrets with `[REDACTED]`.
- Use fixture home/project directories instead of real user paths.
- Avoid committing private prompts or real harness config content.
- Keep command output concise and reviewer-oriented.
