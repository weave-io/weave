# CLI

The `weave` CLI validates and inspects configuration, initializes harness integrations, materializes file-based adapters, inspects local runtime state, dispatches adapter-owned inspection commands, and runs agent evals. It does not launch or replace a harness runtime.

**Related:** [Configuration](configuration.md) · [Prompts](prompts.md) · [Runtime Store](runtime.md) · [Adapter Boundary](../architecture/adapter-boundary.md) · [Agent Evals](../guides/evals.md) · [Claude Code](../adapters/claude-code.md)

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
| `weave runtime preferences` | List stored adapter preferences |
| `weave adapter pi children list` | List locally recorded Pi child sessions for a workspace |
| `weave adapter pi children show <id>` | Read one child's bounded metadata and native entry index |
| `weave adapter pi children result <id>` | Read one child's byte-exact durable result in bounded pages |
| `weave adapter pi children delete <id>` | Append a tombstone for one child session |
| `weave adapter pi doctor` | Run bounded Pi child-storage diagnostics |
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
weave runtime preferences
weave runtime preferences --namespace adapter-pi --limit 20
```

All three commands inspect `.weave/runtime/weave.db` without creating it when absent. When the file does not exist they print `No runtime store found at <path>` and exit `0`.

- `status` reports schema version, active lease, resumable instances, and recent instances.
- `journal` reads bounded sanitized entries and defensively filters denied keys.
- `preferences` lists stored [adapter preference](runtime.md#adapter-preferences) rows as `namespace  key  updated_at  <value preview>`.

`preferences` defaults to every namespace, ordered by namespace then key. `--namespace <ns>` restricts the listing to one namespace, ordered by key. Both orders come from the repository and are byte-deterministic, so the same store prints the same rows in the same order. `--limit <n>` requires a positive integer, defaults to 100, and clamps to 100; a malformed value is an argument error with a non-zero exit.

Each value preview is bounded. Control characters, including newlines and tabs, collapse to single spaces so one record occupies exactly one line, and the preview truncates at 120 UTF-8 bytes with a `…` marker that never splits a character. A value stored under a denied key name prints `<redacted>`; preferences must not hold secrets, so that is a defensive backstop rather than a supported use. An empty result prints `No preferences stored.`, or names the requested namespace when `--namespace` was passed.

The CLI opens the database read-only when reading schema metadata. Preference listing is read-only too: it opens an existing store, reads, and closes it, and never creates, migrates, or writes anything. No runtime command writes workflow state, advances execution, or exposes raw prompts, completions, transcripts, credentials, cookies, authorization headers, tokens, or provider payloads.

See [Runtime Store](runtime.md) and [`commands/runtime.ts`](../../packages/cli/src/commands/runtime.ts).

## `weave adapter`

`weave adapter <name> <command>` is a generic front end over the engine's opaque adapter-command dispatch. The CLI parses argv into an envelope, calls `dispatchAdapterCommand()`, and prints the adapter-owned result. Production Pi command ports load through the thin `@weaveio/weave-adapter-pi/cli` registration boundary and are bundled into the CLI at build time the same way Claude Code materialization is; engine and core stay Pi-free. `pi` is the only registered adapter today; any other name exits `1` with `Unsupported adapter: <name>`.

```bash
weave adapter pi children list [--json] [--diagnostic]
weave adapter pi children show <id> [--json] [--content] [--diagnostic] [--cursor <c>] [--parent-session <id>]
weave adapter pi children result <id> [--json] [--cursor <c>] [--parent-session <id>]
weave adapter pi children delete <id> [--yes] [--json] [--parent-session <id>]
weave adapter pi doctor [--json] [--diagnostic]
```

The workspace defaults to the current working directory.

- `children list` returns the newest 50 children for the workspace, including tombstoned rows, each with child id, thread id, bounded title, status, timestamps, origin parent session, and the `tombstoned` and `stale` flags.
- `children show` returns the child plus the newest 100 native entry descriptors (`index`, `id`, `type`) and a `nextCursor` when more remain. Pass `--content` to include a **sanitized display projection** of the entry text. A projection is never authoritative: control sequences and path-like tokens are rewritten, and each entry carries `contentKind: "sanitized-projection"` so it cannot be mistaken for stored bytes. Use `children result` for exact result data. Each projection page is limited to 64 KiB of UTF-8 and reports `contentComplete` plus an exact `contentByteLength` when measurable. When one entry is larger, pass its `contentCursor` back with `--content-cursor <c>` until `contentComplete` is true. Pass `--cursor <c>` to page backward through older entries. Content retrieval never copies transcripts into Runtime Store and never exposes native session paths or refs unless `--diagnostic` is also set.
- `children result` returns the child's **byte-exact** durable result. Nothing on this route is sanitized, rewritten, or truncated mid-result: `exact` is always `true`, and `content` is the child's own UTF-8 bytes carried as base64 under `contentEncoding: "base64"`, with `contentByteOffset`, `contentByteLength`, and a per-page `contentDigest` describing the decoded window. Base64 is used because it is byte-preserving and costs a fixed `4 * ceil(n / 3)` characters, whereas raw JSON escaping has no bounded expansion: one page of control bytes would cost six characters per byte and overrun the command result envelope. A result is returned only after the stored group verifies against its commit record — matching chunk count, order, byte total, SHA-256 digest, and the immutable identity the commit was bound to (child, native session, origin parent, and storage leaf) — so an interrupted, corrupt, or misdirected group reports `status: "incomplete"` with a typed `reason` and no content at all. Reachability is not authority: a request that names a different child or native session than the stored result is refused rather than served. Cursors are bound to that identity and to the exact commit, so a cursor from another child or a changed result is rejected rather than resumed. Each page returns at most 128 KiB of decoded bytes, plus a `nextCursor` while bytes remain; decoding each page and concatenating in order reproduces the result exactly. Verification and retrieval page the native session, so a result far larger than one whole-session read may be proven and retrieved without allocating it.
- `children delete` appends a tombstone; it never rewrites or truncates stored session data. It resolves the child's immutable origin parent from list metadata and never invents a synthetic parent such as `current`. When the same child id exists under two parents, pass `--parent-session <id>`; a forged or mismatched parent scope is rejected. Without `--yes` it prompts `Delete child <id> and append a tombstone?`, defaulting to no. Declining prints `Delete cancelled.` and exits `0`. A non-interactive terminal without `--yes` exits with `Interactive mode is unavailable. Re-run with --yes to delete without a prompt.`
- `doctor` runs the seven bounded storage checks and reports `ok`, `degraded`, `unavailable`, or `not_implemented`.

`--json` prints stable JSON and suppresses decorative output. `--diagnostic` relaxes path stripping for other output, but no command ever reports a child's absolute session path: `children show --diagnostic` adds only the bounded root-relative `sessionRef`. Without `--diagnostic`, every absolute path is replaced with `[path omitted]`. Both flags are local-only inspection; neither starts, resumes, or mutates work.

See [Pi Adapter](../adapters/pi.md#child-session-commands), [Pi child troubleshooting](../guides/pi-child-troubleshooting.md), and [`commands/adapter.ts`](../../packages/cli/src/commands/adapter.ts).

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
