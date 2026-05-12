# Weave

> Harness-agnostic prompt and agent-configuration API

Weave is a TypeScript-first framework for describing multi-agent systems that can be materialized inside different coding-agent harnesses (OpenCode, Pi, Claude Code, Hermes, Codex, and more). A declarative `.weave` DSL describes agents, prompts, delegation intent, categories, model preferences, skill references, and policies. Adapters translate that normalized Weave intent into harness-specific plugins, configs, commands, tools, and runtime behavior.

Think of Weave like Neovim's API layer: Weave provides primitives, normalized configuration, and pure composition APIs; adapters supply harness-owned context (available skills, models, lifecycle events) and materialize the result inside a concrete harness.

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

## Getting Started

```bash
# Install all dependencies
bun install

# Build all packages
bun run build

# Run type checking
bun run typecheck

# Run all tests
bun run test

# Build and link the local weave executable
bun run build
bun link ./packages/cli
weave --help

# Validate project config through the CLI
bun run validate-config

# Clean all dist/ folders
bun run clean
```

## CLI

The `@weave/cli` package exposes the `weave` executable. During local development, build and link the package before using `weave` from `PATH`:

```bash
bun run build
bun link ./packages/cli
command -v weave
weave --help
weave --version
```

Once publishable, the same command surface is available through package runners:

```bash
bunx @weave/cli --help
npx @weave/cli --help
npm exec @weave/cli -- --help
pnpm dlx @weave/cli --help
```

Common commands:

```bash
weave init --scope local --yes
weave init --scope global --install-dir ~/.weave --yes
weave validate --project
weave validate --path .weave/config.weave --json
NO_COLOR=1 weave --help
```

See [docs/cli.md](./docs/cli.md) for the full command contract, init safety rules, validation behavior, and installer boundaries.

## Scope

All packages are published under the `@weave` scope.

## License

MIT
