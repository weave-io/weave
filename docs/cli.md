# Weave CLI

The Weave CLI is the user-facing command surface for GitHub issue #26. It creates and validates `.weave` configuration and safely hands Weave intent to supported harness installers. It does **not** start, supervise, or drive third-party harness runtimes.

Related docs:

- [Adapter boundary](./adapter-boundary.md)
- [Product vision](./product-vision.md)
- [Config Loading](./config-loading.md)

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
