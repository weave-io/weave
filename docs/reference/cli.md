# CLI

The `weave` CLI validates and inspects configuration, initializes harness integrations, materializes file-based adapters, inspects local runtime state, and runs agent evals. It does not launch or replace a harness runtime.

**Related:** [Configuration](configuration.md) · [Prompts](prompts.md) · [Runtime Store](runtime.md) · [Agent Evals](../guides/evals.md) · [Claude Code](../adapters/claude-code.md)

---

## Command map

| Command | Purpose |
| --- | --- |
| `weave validate` | Parse and validate merged `.weave` configuration |
| `weave init` | Detect and configure supported harnesses |
| `weave init migrate` | Translate supported legacy OpenCode configuration into `.weave` |
| `weave compose --adapter claude-code` | Materialize Claude Code agent files |
| `weave prompt inspect <agent>` | Render one composed prompt and metadata |
| `weave prompt list` | List normalized agent names |
| `weave prompt self-modify` | Print the self-modification guide for a config scope |
| `weave runtime status` | Inspect local Runtime Store schema, lease, and instances |
| `weave runtime journal` | Read recent sanitized journal entries |
| `weave eval run` | Run registered text-only agent evals |

`weave run` exits with guidance to launch OpenCode, Claude Code, or Pi through its own command. Durable workflow execution starts through an adapter-native surface, not the standalone CLI.

The router is [`packages/cli/src/cli.ts`](../../packages/cli/src/cli.ts); argument parsing is [`args.ts`](../../packages/cli/src/args.ts).

## Installation and package runners

The package exposes the `weave` binary through Bun. During workspace development, run source directly:

```bash
bun packages/cli/src/main.ts --help
```

Published CLI use belongs in the [public docs](../../packages/docs/). This reference describes internal behavior and trust boundaries.

## `weave validate`

Validation loads builtin, global, and trusted project config through `@weaveio/weave-config`, then reports lexer, parser, merge, schema, and prompt-path errors with source locations.

The command does not materialize an adapter or modify config. It returns non-zero on invalid input.

```bash
bun run validate-config
```

The repo script runs the same project validation path.

## `weave init`

Initialization detects supported harnesses and applies explicit installer choices. Installers own harness-specific paths and config shapes; the generic command owns selection, confirmation, and reporting.

A project-local write requires project trust. Non-interactive `--yes` mode must preserve the same safety checks as the prompt-driven path.

Installer implementations live under [`packages/cli/src/installers/`](../../packages/cli/src/installers/).

## `weave init migrate`

Migration converts supported legacy OpenCode data into `.weave` declarations and prompt files.

The migration pipeline:

1. discovers legacy sources for the chosen local or global scope;
2. parses known agent, category, workflow, model, prompt, and disable fields;
3. produces a preflight summary;
4. refuses ambiguous or lossy input unless the command defines a safe warning path;
5. writes canonical destinations with backup/overwrite rules;
6. validates the generated config.

Migration never deletes the legacy source. Prompt bodies become prompt files when appropriate; generated filenames pass through path-safe normalization. Unknown fields produce warnings rather than guessed semantics.

The implementation is [`commands/migrate.ts`](../../packages/cli/src/commands/migrate.ts).

## `weave compose`

Compose currently supports the file-based Claude Code adapter:

```bash
weave compose --adapter claude-code
weave compose --adapter claude-code --init
```

It loads merged config, asks the engine for a `MaterializationPlan`, reports per-descriptor failures, and lets `ClaudeCodeAdapter` write concrete agent files. `--init` also writes the optional bootstrap plugin unless it already exists.

Compose does not share an implementation path with runtime OpenCode or Pi activation. See [Claude Code](../adapters/claude-code.md).

## Prompt inspection

```bash
weave prompt inspect <agent>
weave prompt inspect <agent> --json
weave prompt list
weave prompt list --json
weave prompt self-modify --scope global|local
```

Inspection uses the same config loader, descriptor builder, template renderer, delegation filter, and prompt composer as adapters. It must not maintain a second prompt-building path.

JSON mode emits bounded metadata plus composed text. It never includes credentials or harness-private state.

## Runtime inspection

```bash
weave runtime status
weave runtime journal --limit 50
```

Both commands inspect `.weave/runtime/weave.db` without creating it when absent.

- `status` reports schema version, active lease, resumable instances, and recent instances.
- `journal` reads bounded sanitized entries and defensively filters denied keys.

The CLI opens the database read-only when reading schema metadata. It never writes workflow state, advances execution, or exposes raw prompts, completions, transcripts, credentials, cookies, authorization headers, tokens, or provider payloads.

See [Runtime Store](runtime.md) and [`commands/runtime.ts`](../../packages/cli/src/commands/runtime.ts).

## Agent evals

```bash
weave eval run
weave eval run --agent <name> --model <id> --case <id>
weave eval run --dry-run
weave eval run --raw-artifacts
```

The command validates suite/model/case filters before execution. `--dry-run` performs no model call. Live execution requires the configured model-service key. `--raw-artifacts` is explicit local-only opt-in and is not publishable.

The current authoring procedure lives in [Agent Eval Guide](../guides/evals.md). Sanitization and bundle semantics live in [Eval Reporting](eval-reporting.md). Do not record dated score checkpoints in this CLI reference.

## Output and errors

Commands receive injected terminal and theme ports. Core command logic does not write through `console.*`.

Fallible command modules return `Result` / `ResultAsync` with `CliError`. The executable entry point converts the result into `process.exitCode`; it contains no business logic.

Human output uses theme helpers rather than hard-coded ANSI colors. Machine-readable modes return stable JSON and suppress decorative output.

## Tests

CLI command tests inject `TerminalIO`, config text, runtime stores, installers, publishers, filesystem ports, and model clients. They do not modify a real home directory, launch a harness, call a model in normal tests, or publish network artifacts.

Start with:

- [`packages/cli/src/commands/__tests__/`](../../packages/cli/src/commands/__tests__/)
- [`packages/cli/src/evals/__tests__/`](../../packages/cli/src/evals/__tests__/)
- [`packages/cli/src/installers/__tests__/`](../../packages/cli/src/installers/__tests__/)
