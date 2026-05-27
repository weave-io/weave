# Weave

> Harness-agnostic prompt and agent-configuration API

Weave is a TypeScript-first framework for describing multi-agent systems that can be materialized inside different coding-agent harnesses (OpenCode, Pi, Claude Code, Hermes, Codex, and more). A declarative `.weave` DSL describes agents, prompts, delegation intent, categories, model preferences, skill references, and policies. Adapters translate that normalized Weave intent into harness-specific plugins, configs, commands, tools, and runtime behavior.

Think of Weave like Neovim's API layer: Weave provides primitives, normalized configuration, and pure composition APIs; adapters supply harness-owned context (available skills, models, lifecycle events) and materialize the result inside a concrete harness.

For a high-level flow diagram of configuration → engine → adapter → harness, see [System Architecture](./docs/system-architecture.md).

## Packages

| Package                                                         | Description                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [`@weave/core`](./packages/core)                                | DSL lexer, parser, AST, Zod schemas, and validated config types                            |
| [`@weave/config`](./packages/config)                            | Builtin DSL defaults, config discovery, merge semantics, and prompt path resolution        |
| [`@weave/engine`](./packages/engine)                            | Pure composition APIs for descriptors, model intent, skill resolution, prompts, and policy |
| [`@weave/cli`](./packages/cli)                                  | `weave` executable for config scaffolding, validation, and harness installation            |
| [`@weave/adapter-opencode`](./packages/adapters/opencode)       | OpenCode plugin adapter                                                                    |
| [`@weave/adapter-claude-code`](./packages/adapters/claude-code) | Claude Code adapter                                                                        |
| [`@weave/adapter-pi`](./packages/adapters/pi)                   | Pi adapter                                                                                 |

## OpenCode Adapter Status

`@weave/adapter-opencode` is implemented as a **real first-slice OpenCode plugin adapter**. It can load Weave config, materialize builtin and custom agents, map Weave tool policy into OpenCode permissions, reconcile owned agents safely, and expose Weave-managed agents through the plugin bootstrap path.

Today, the adapter is strongest at **agent/config materialization** and intentionally does **not** yet provide full parity with the legacy `opencode-weave` project.

### Implemented now

- OpenCode plugin entrypoint via `@weave/adapter-opencode/plugin`
- builtin + custom agent materialization
- category-generated shuttle agents through normal config materialization
- model resolution and fail-fast validation for explicit subagent model intent
- tool-policy mapping into OpenCode permissions
- ownership-safe `list → reconcile → create/update` flow for Weave-managed agents
- harness-injected skill forwarding
- `config` hook visibility for `opencode debug config`
- deferred SDK reconciliation on first `session.created`

### Not yet at legacy parity

The following legacy OpenCode-specific capabilities are still separate work:

- full in-harness command lifecycle (`/start-work`, `/run-workflow`, status/pause/abort flows)
- broader workflow runtime/lifecycle integration
- skill MCP mounting/management
- richer OpenCode runtime effects such as agent/session restoration flows
- health, metrics, and token-reporting surfaces comparable to the legacy project

For the normative status and current non-goals, see:

- [Adapter Readiness Status](./docs/adapter-readiness-status.md)
- [Spec 20 — OpenCode Adapter Materialization](./docs/specs/20-spec-opencode-adapter-materialization/20-spec-opencode-adapter-materialization.md)
- [@weave/adapter-opencode README](./packages/adapters/opencode/README.md)

### Legacy parity snapshot

| Feature area | Legacy `opencode-weave` | Current Weave core | Current OpenCode adapter |
| --- | --- | --- | --- |
| Builtin agents | Yes | Yes | Yes |
| Custom agents | Yes | Yes | Yes |
| Prompt composition | Yes | Yes | Yes |
| Category-generated shuttle agents | Yes | Yes | Yes via normal materialization |
| Model resolution | Yes | Yes | Partial/strong |
| Tool policy mapping | Yes | Yes | Yes |
| OpenCode plugin entrypoint | Yes | N/A | Yes |
| Agent reconcile create/update | Yes | N/A | Yes |
| Ownership/collision protection | Yes | N/A | Yes |
| Skill forwarding/discovery | Yes | Yes | Partial |
| Skill MCP mounting | Yes | N/A | No |
| `/start-work` / `/run-workflow` | Yes | Workflow concepts exist | No |
| Workflow runtime lifecycle | Yes | Partial | No |
| Pause/resume/abort/status | Yes | Partial | No |
| Session restore / agent switch effects | Yes | N/A | No |
| Health / metrics / token reports | Yes | Partial | No |
| Full legacy OpenCode parity | Yes | Not the target itself | No |

In practice, the current OpenCode adapter covers the **materialization foundation** well, while the main parity gaps are still the **runtime command lifecycle**, **workflow execution UX**, **skill MCP integration**, and **health/metrics/token-reporting surfaces**.

## Other Adapter Status

### Claude Code adapter

`@weave/adapter-claude-code` currently exists as a package placeholder in the workspace. The harness-agnostic engine/config surfaces it depends on are present, but this adapter does not yet have an equivalent status story to the OpenCode first slice.

- current role: placeholder package / future adapter target
- intended scope: materialize Weave agents into Claude Code using the same engine-owned descriptors and policy surfaces
- current status: not yet documented as a real materialized adapter slice

### Pi adapter

`@weave/adapter-pi` currently exists as a package placeholder in the workspace. Like Claude Code, it sits behind the current engine/config work and does not yet have a comparable materialization/readiness story documented in the repo README.

- current role: placeholder package / future adapter target
- intended scope: materialize Weave agents into Pi using the same adapter boundary and engine-owned descriptors
- current status: not yet documented as a real materialized adapter slice

## Workspace Structure

```
weave/
├── packages/
│   ├── core/                  # DSL lexer, parser, AST, schemas
│   ├── config/                # Builtins, config discovery, merge, prompt path resolution
│   ├── engine/                # Harness-agnostic composition APIs and adapter boundary
│   └── adapters/
│       ├── opencode/          # OpenCode plugin adapter
│       ├── pi/                # Pi adapter
│       └── claude-code/       # Claude Code adapter
├── package.json               # Root workspace manifest
├── tsconfig.json              # Root TypeScript config (composite)
└── bunfig.toml                # Bun configuration
```

## Installation

Weave requires [Bun](https://bun.sh) ≥ 1.1. Node.js is not supported.

```bash
# 1. Clone the repository
git clone https://github.com/weave-io/weave.git
cd weave

# 2. Install all workspace dependencies
bun install

# 3. Build all packages (core → config → engine → adapters → cli)
bun run build
```

The build emits compiled output into each package's `dist/` folder:

| Package | Dist entry |
| --- | --- |
| `@weave/adapter-opencode` | `packages/adapters/opencode/dist/index.js` |
| `@weave/cli` | `packages/cli/dist/main.js` |

## Getting Started (development)

```bash
# Run type checking across all packages
bun run typecheck

# Run all tests
bun test

# Validate the project's own .weave config through the CLI
bun run validate-config

# Clean all dist/ folders
bun run clean
```

## CLI

The `@weave/cli` package exposes the `weave` executable. After building, link it into your `PATH` for local development:

```bash
bun run build
bun link ./packages/cli
weave --help
weave --version
```

Once published, the same command surface is available through package runners:

```bash
bunx @weave/cli --help
npx @weave/cli --help
```

### `weave init` — scaffold a `.weave` config

```bash
# Interactive setup (prompts for scope, harness, and modules)
weave init

# Non-interactive local setup
weave init --scope local --yes

# Non-interactive global setup
weave init --scope global --yes
```

### `weave init migrate` — migrate a legacy OpenCode config

If you have an existing `weave-opencode.jsonc` config from the legacy `opencode-weave` project, migrate it to the current `.weave` DSL:

```bash
# Explicit migrate mode — prompts for confirmation, then continues into harness setup
weave init migrate --scope local
weave init migrate --scope global

# Non-interactive — migrates and exits without prompts
weave init migrate --scope local --yes
weave init migrate --scope global --yes
```

Legacy source paths (read-only, never modified):

| Scope | Legacy source |
| --- | --- |
| `local` | `.opencode/weave-opencode.jsonc` |
| `global` | `~/.config/opencode/weave-opencode.jsonc` |

Migration writes only to the canonical destinations `~/.weave/config.weave` (global) and `.weave/config.weave` (local). The `--install-dir` flag is ignored in migrate mode.

### `weave validate` — validate a `.weave` config

```bash
# Validate the project config (auto-discovers .weave/config.weave)
weave validate --project

# Validate a specific file
weave validate --path .weave/config.weave

# Machine-readable JSON output
weave validate --path .weave/config.weave --json
```

See [docs/cli.md](./docs/cli.md) for the full command contract, init safety rules, migration behavior, validation output, and installer boundaries.

## Using with OpenCode

After building, point your OpenCode config at the local adapter dist file to use your development build as the active plugin.

**`~/.config/opencode/opencode.jsonc`**:

```jsonc
{
  "plugin": [
    // Use the local development build of the Weave OpenCode adapter
    "file:///absolute/path/to/weave/packages/adapters/opencode/dist/index.js"
  ]
}
```

Replace `/absolute/path/to/weave` with the actual path where you cloned the repo (e.g. `/Users/you/projects/weave`).

To switch back to the published package, replace the `file://` entry with `@opencode_weave/weave` (or whichever published package name applies).

> **Tip**: run `bun run build` after any source change to update the dist files before restarting OpenCode.

## Scope

All packages are published under the `@weave` scope.

## License

MIT
