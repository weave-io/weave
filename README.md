# Weave

> Harness-agnostic multi-agent orchestration framework

Weave is a TypeScript-first framework for defining, configuring, and orchestrating multiple AI agents across different coding agent harnesses (OpenCode, Claude Code, Pi, and more). It provides a declarative DSL for describing agent configurations, skills, and hooks, and a runtime engine that drives orchestration regardless of the underlying harness.

## Packages

| Package                                                         | Description                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [`@weave/core`](./packages/core)                                | DSL types, schema definitions, and config parser                         |
| [`@weave/engine`](./packages/engine)                            | Weave engine: orchestration, hooks, skills, and background agent manager |
| [`@weave/adapter-opencode`](./packages/adapters/opencode)       | OpenCode plugin adapter                                                  |
| [`@weave/adapter-claude-code`](./packages/adapters/claude-code) | Claude Code adapter                                                      |
| [`@weave/adapter-pi`](./packages/adapters/pi)                   | Pi adapter                                                               |

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
