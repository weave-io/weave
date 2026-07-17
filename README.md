# Weave

> Harness-agnostic prompt and agent-configuration API

Weave is a TypeScript framework for describing multi-agent systems and materializing them inside different coding-agent harnesses. You declare agents, prompts, delegation intent, categories, model preferences, skills, and tool policy in a `.weave` DSL. Adapters translate that normalized intent into harness-specific plugins, configs, and agent files.

The engine is pure and harness-agnostic. Adapters own everything harness-specific: available models, tool vocabulary, skill discovery, lifecycle hooks, and file/plugin generation.

For the product story and conceptual docs, see the website: <https://tryweave.io>. This README is the developer and contributor reference. For a configuration → engine → adapter → harness flow diagram, see [System Architecture](./docs/system-architecture.md).

## Packages

| Package | Description |
| --- | --- |
| [`@weaveio/weave-core`](./packages/core) | DSL lexer, parser, AST, Zod schemas, and validated config types |
| [`@weaveio/weave-config`](./packages/config) | Builtin DSL defaults, config discovery, merge semantics, and prompt path resolution |
| [`@weaveio/weave-engine`](./packages/engine) | Pure composition APIs for descriptors, model intent, skill resolution, prompts, and policy |
| [`@weaveio/weave-cli`](./packages/cli) | `weave` executable for scaffolding, validation, and adapter materialization |
| [`@weaveio/weave-docs`](./packages/docs) | In-repo Astro + Starlight documentation site |
| [`@weaveio/weave-adapter-opencode`](./packages/adapters/opencode) | OpenCode plugin adapter (runtime) |
| [`@weaveio/weave-adapter-claude-code`](./packages/adapters/claude-code) | Claude Code adapter (file materialization) |

## Requirements

Weave requires [Bun](https://bun.sh) ≥ 1.1. Node.js is not supported for development.

```bash
git clone https://github.com/weave-io/weave.git
cd weave
bun install
bun run build   # core → config → engine → adapters → cli
```

For local development, link the CLI onto your `PATH`:

```bash
bun link ./packages/cli
weave --help
```

If you would rather not link it, run the CLI from source: `bun packages/cli/src/main.ts <command>`.

## CLI

The `@weaveio/weave-cli` package exposes the `weave` executable.

| Command | Purpose |
| --- | --- |
| `weave init` | Scaffold a `.weave/config.weave` (interactive; supports `--scope local\|global`, `--yes`) |
| `weave init migrate` | Migrate a legacy `weave-opencode.jsonc` config to the `.weave` DSL |
| `weave validate` | Validate a `.weave` config (`--project`, `--path <file>`, `--json`) |
| `weave compose --adapter claude-code` | Materialize agents into a Claude Code plugin (see below) |
| `weave prompt inspect <agent>` | Render an agent's fully composed prompt (`--json`, or `list`) |
| `weave eval run` | Run the routing/planning eval suites |

`weave` does not launch harness runtimes. Start each harness with its own command (`opencode`, `claude`, `pi`). See [docs/cli.md](./docs/cli.md) for the full command contract, init safety rules, and migration behavior.

## Using with OpenCode

`@weaveio/weave-adapter-opencode` is an OpenCode plugin. Install it by adding the package to the `plugin` array in your OpenCode config, or point at a local `dist/plugin.js` build for development.

The adapter README is the authoritative install and validation guide, including the exact plugin entry point, isolated-config testing, and logging behavior:

- [`@weaveio/weave-adapter-opencode` README](./packages/adapters/opencode/README.md)

> Use the `dist/plugin.js` bundle (or the published package's `/plugin` entry). The bare package entry (`dist/index.js`) exports non-function values and will fail OpenCode's plugin loader.

## Using with Claude Code

Claude Code support is **file materialization**: `weave compose` reads your `.weave/config.weave` and writes a Claude Code plugin directory. There is no runtime integration and no changes to Weave are required to try it.

From a project that has a `.weave/config.weave`:

```bash
# Generate the plugin, and (with --init) a small bootstrap plugin
# that re-runs compose on session start.
weave compose --adapter claude-code --init
```

This writes:

```
.weave/plugins/claude-code/     # the generated plugin
  .claude-plugin/plugin.json
  agents/*.md                   # one Claude Code subagent per Weave agent
  settings.json                 # sets loom as the default agent
weave-bootstrap-plugin/         # optional: SessionStart hook that re-runs compose
```

Launch Claude Code pointing at the generated plugin (add the bootstrap plugin for auto-regeneration):

```bash
claude --plugin-dir ./weave-bootstrap-plugin --plugin-dir ./.weave/plugins/claude-code
```

Run `/reload-plugins` on the first session if the agents do not appear immediately. Add `.weave/plugins/` to your `.gitignore`.

**What you get:** agent prompts, model selection, tool lists, category shuttles, and delegation via Claude Code's `Task` tool. **What is out of scope:** durable workflows, plan execution, command entrypoints, idle continuation, and analytics. Those require a Claude Code runtime API that does not exist today. See [Claude Code Adapter](./docs/claude-code-adapter.md) for the full scope and rationale.

> The bootstrap plugin's `SessionStart` hook runs `weave compose`, which assumes `weave` is resolvable in the project. If it is not linked, skip the bootstrap plugin and re-run `weave compose --adapter claude-code` manually after config changes.

## Adapter status

| Adapter | Status |
| --- | --- |
| OpenCode | Runtime plugin, first slice. Materializes builtin and custom agents, maps tool policy into OpenCode permissions, reconciles Weave-owned agents safely (`list → reconcile → create/update` with ownership/collision protection), resolves models with fail-fast validation, and exposes agents via the plugin `config` hook. Not yet at full legacy `opencode-weave` parity: the in-harness command lifecycle, broader workflow runtime, skill MCP mounting, and health/metrics surfaces are still separate work. |
| Claude Code | File materialization. Generates a Claude Code plugin via `weave compose` (agents, model aliasing, tool classification, skill discovery, settings). No runtime workflow or lifecycle features. |
| Pi and others | Planned. The engine/adapter boundary supports additional harnesses; no adapter package exists yet. |

For normative status and non-goals, see [Adapter Readiness Status](./docs/adapter-readiness-status.md).

## Development

```bash
bun run typecheck        # type-check all packages
bun test                 # run all tests
bun run validate-config  # validate this repo's own .weave config
bun run docs:dev         # run the in-repo docs site locally
bun run clean            # remove all dist/ folders
```

## Publishing

All packages are published under the `@weaveio` scope.

## License

MIT
