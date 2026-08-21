# CLI

`weave` creates and validates configuration, composes Claude Code files, and
inspects local Weave state. It does not launch OpenCode, Claude Code, or Pi.
Launch a harness with its own command after configuring it.

This reference follows the output of `weave --help` and documents the
implemented subcommands that the help output routes to as well.

**Related:** [Configuration](configuration.md) · [Prompts](prompts.md) ·
[Runtime Store](runtime.md) · [Adapter Boundary](../architecture/adapter-boundary.md) ·
[Agent Evals](../guides/evals.md) · [Claude Code](../adapters/claude-code.md)

## Usage

```text
weave <command> [options]
```

Run `weave --help` to print the installed version's banner, command list,
options, and examples. `weave --version` prints only the version.

## Commands from `weave --help`

| Command | Purpose |
| --- | --- |
| `weave init` | Create Weave configuration and install supported harness integrations. |
| `weave prompt inspect <agent>` | Render one composed agent prompt. |
| `weave prompt list` | List available agent names. |
| `weave prompt self-modify` | Print the self-modification guide. |
| `weave validate` | Validate `.weave` configuration files. |
| `weave runtime status` | Show Runtime Store status. |
| `weave runtime journal` | Show recent journal entries. |
| `weave adapter pi …` | Run bounded Pi child and doctor commands. |
| `weave eval run` | Run configured text-only evals. |

The help output abbreviates the adapter's child commands with `…`; see
[`weave adapter`](#weave-adapter) below for their full syntax.

## Options from `weave --help`

| Option | Meaning |
| --- | --- |
| `--help`, `-h` | Show the help message. |
| `--version` | Show the CLI version. `-V` is also accepted. |
| `--scope global\|local` | Select the scope for `init` and `prompt self-modify`. |
| `--install-dir <dir>` | Choose the `init` configuration directory. |
| `--path <file>` | Validate an explicit `.weave` file. |
| `--project` | Validate `./.weave/config.weave`. |
| `--global` | Validate `~/.weave/config.weave`. |
| `--json` | Emit machine-readable output where the selected command supports it. |
| `--yes`, `-y` | Accept safe non-interactive defaults. |
| `--agent <name>` | Filter evals to one agent. |
| `--model <id>` | Filter evals to one model. |
| `--case <id>` | Filter evals to one eval case. |
| `--dry-run` | Preview an eval without making a model call. |
| `--raw-artifacts` | Write raw eval artifacts to disk for local debugging. |

The parser also accepts command-specific options documented in the sections
below: `--harness`, `--all-harnesses`, `--force`, `--namespace`,
`--limit`, `--adapter`, `--project-root`, `--out-dir`, `--init`,
`--bootstrap-dir`, `--diagnostic`, `--content`, `--content-cursor`,
`--cursor`, and `--parent-session`.

## `weave init`

Create configuration and configure detected harnesses:

```bash
weave init
weave init --scope local --yes
weave init --scope global --yes
weave init --scope local --install-dir .weave --yes
weave init --scope local --harness opencode --yes
weave init --scope local --all-harnesses --yes
```

`--scope` selects `local` (`./.weave/`) or `global` (`~/.weave/`).
`--install-dir` changes the scaffold location for ordinary init.
`--harness` selects one detected harness, and `--all-harnesses` selects all
detected harnesses. The current installer writes OpenCode integration files;
Claude Code uses [`weave compose`](#weave-compose), and Pi uses its Pi package
installer. `--yes` skips safe confirmation prompts.

A project-local write requires project trust. Non-interactive mode keeps the
same trust and collision checks as interactive mode.

## `weave init migrate`

Convert supported legacy OpenCode JSONC configuration into the canonical
`.weave` DSL:

```bash
weave init migrate
weave init migrate --scope global
weave init migrate --scope local --yes
weave init migrate --scope local --yes --force
```

The migration command reads the scope-specific legacy file, writes the
canonical `config.weave`, validates the result, and keeps the legacy source.
`--force` permits an existing destination and creates a backup. In migrate
mode, `--install-dir` is ignored; the canonical destination is always used.

### Prompt file translation

Migration converts supported prompt bodies into prompt files when that avoids
lossy inline output. Unknown or unsupported legacy fields produce warnings
instead of guessed DSL. Review the generated files and run `weave validate`
before using them.

## `weave validate`

Validate the effective configuration or one explicit scope/file:

```bash
weave validate
weave validate --project
weave validate --global
weave validate --path .weave/config.weave --json
```

Exit code `0` means the input is valid. Exit code `1` reports a read, parse,
merge, or schema failure. Validation does not materialize an adapter or modify
configuration.

## Prompt commands

```bash
weave prompt inspect <agent>
weave prompt inspect <agent> --json
weave prompt list
weave prompt list --json
weave prompt self-modify
weave prompt self-modify --scope global
weave prompt self-modify --scope local
```

`prompt inspect` renders the composed prompt and bounded metadata for one
agent. `prompt list` prints normalized names. JSON output is supported by
`inspect` and `list`; `prompt self-modify` prints text and accepts only the
scope selector.

## `weave prompt self-modify`

The self-modification command prints a read-only guide for changing the
selected global or local config. It does not edit files and does not start a
harness. After applying the guide's changes, validate the selected config.

## `weave runtime`

Runtime commands inspect `.weave/runtime/weave.db` in the current project.
They do not create the store, start a workflow, or change runtime state:

```bash
weave runtime status
weave runtime journal
weave runtime journal --limit 50
weave runtime preferences
weave runtime preferences --namespace adapter-pi --limit 20
```

`runtime status` reports schema, lease, and workflow-instance state.
`runtime journal` reads bounded sanitized journal entries. `runtime
preferences` lists stored adapter preferences. `--limit` requires a positive
integer; journal defaults to 50 and preferences defaults to 100. Preference
listing is read-only and never creates or migrates the database.

When the database is absent, inspection prints a no-store message and exits
successfully. Runtime output does not include prompts, transcripts,
credentials, cookies, authorization headers, tokens, or provider payloads.

## `weave adapter`

`weave adapter <name> <command>` dispatches an adapter-owned inspection
command. `pi` is the only registered adapter. The workspace is the current
working directory.

```bash
weave adapter pi children list [--json] [--diagnostic]
weave adapter pi children show <id> [--json] [--content] [--content-cursor <c>] [--cursor <c>] [--parent-session <id>] [--diagnostic]
weave adapter pi children result <id> [--json] [--cursor <c>] [--parent-session <id>]
weave adapter pi children delete <id> [--yes] [--json] [--parent-session <id>]
weave adapter pi doctor [--json] [--diagnostic]
```

- `children list` returns a bounded list, including tombstoned rows.
- `children show` returns metadata and native entry descriptors. `--content`
  adds a bounded sanitized projection; use `--content-cursor` to continue a
  large entry and `--cursor` to page entries.
- `children result` returns byte-exact durable result pages as base64 with
  identity and digest metadata. It returns no content when verification fails.
- `children delete` appends a tombstone. Without `--yes`, it asks for
  confirmation; `--parent-session` selects the immutable origin parent when
  an id is ambiguous.
- `doctor` runs bounded child-storage checks.

`--json` suppresses decorative output. `--diagnostic` adds bounded diagnostic
fields but does not expose an absolute native session path. These commands are
local adapter inspection and maintenance only; they do not start, resume, or
execute workflow work. `children delete` intentionally writes a tombstone.

See the [Pi adapter reference](../adapters/pi.md#child-session-commands).

## `weave eval run`

Run configured text-only evals:

```bash
weave eval run
weave eval run --agent <name> --model <id> --case <id>
weave eval run --dry-run
weave eval run --raw-artifacts
```

The filters select an agent, model, and case. `--dry-run` validates selection
without a model call. Live execution needs the configured model-service key.
`--raw-artifacts` is an explicit local-only debug option and is not a release
artifact.

## `weave compose`

Compose currently supports Claude Code even though the short top-level help
lists the core command map:

```bash
weave compose --adapter claude-code
weave compose --adapter claude-code --init
weave compose --adapter claude-code --project-root ./project
weave compose --adapter claude-code --out-dir .weave/plugins/claude-code
weave compose --adapter claude-code --init --bootstrap-dir ./weave-bootstrap-plugin
```

The command loads merged configuration, materializes agent files under
`.weave/plugins/claude-code/`, and reports per-agent failures. `--init` also
writes the optional bootstrap plugin. `--out-dir` changes only the generated
Claude Code directory; `--bootstrap-dir` changes only the bootstrap directory.

## `weave run`

`weave run` intentionally refuses to launch a harness. It prints commands for
`opencode`, `claude`, and `pi`, then exits non-zero. Use each harness's own
command and its adapter-native Weave surface instead.

## Errors and tests

The CLI converts expected failures into typed errors and sets a non-zero exit
code at the executable boundary. Tests inject terminal, filesystem, config,
runtime-store, installer, and model ports; ordinary tests do not launch a
harness, call a model, or publish an artifact.
