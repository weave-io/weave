# Weave

> Harness-agnostic prompt and agent-configuration API

Weave is a TypeScript-first framework for describing multi-agent systems that can be materialized inside different coding-agent harnesses (OpenCode, Claude Code, Pi, Codex, and more). A declarative `.weave` DSL describes agents, prompts, delegation intent, categories, model preferences, skills, and policies. Adapters translate that normalized Weave intent into harness-specific plugins, configs, commands, tools, and runtime behavior.

Think of Weave like Neovim's API layer: Weave provides the primitives and normalized configuration; adapters and users compose those primitives into a concrete harness experience.

## Packages

| Package                                                         | Description                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [`@weave/core`](./packages/core)                                | DSL types, schema definitions, and config parser                                           |
| [`@weave/engine`](./packages/engine)                            | Weave engine: normalized agent lifecycle, descriptor building, hooks, and adapter boundary |
| [`@weave/adapter-opencode`](./packages/adapters/opencode)       | OpenCode plugin adapter                                                                    |
| [`@weave/adapter-claude-code`](./packages/adapters/claude-code) | Claude Code adapter                                                                        |
| [`@weave/adapter-pi`](./packages/adapters/pi)                   | Pi adapter                                                                                 |

## Workspace Structure

```
weave/
├── packages/
│   ├── core/                  # DSL types, schema, config parser
│   ├── engine/                # Orchestration engine
│   └── adapters/
│       ├── opencode/          # OpenCode plugin adapter
│       ├── claude-code/       # Claude Code adapter
│       └── pi/                # Pi adapter
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
