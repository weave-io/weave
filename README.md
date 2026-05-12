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

# Clean all dist/ folders
bun run clean
```

## Scope

All packages are published under the `@weave` scope.

## License

MIT
