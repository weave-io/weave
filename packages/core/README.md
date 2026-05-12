# @weave/core

Core DSL lexer, parser, AST, Zod schemas, validation, and `parseConfig()` pipeline for Weave.

`@weave/core` is intentionally harness-agnostic. It understands the `.weave` DSL and produces validated `WeaveConfig` values; it does **not** know about OpenCode, Pi, Claude Code, harness UI state, concrete tool names, skill file locations, or runtime plugin behavior.

## Overview

This package provides the foundational config pipeline used by the rest of Weave:

- **Lexer** — tokenizes `.weave` source
- **Parser** — converts tokens into a DSL AST
- **Validator** — converts AST into validated config through Zod schemas
- **`parseConfig()`** — end-to-end `tokenize → parse → validate` pipeline
- **Zod-inferred types** — `WeaveConfig`, `AgentConfig`, `CategoryConfig`, workflow types, and supporting enums

## Boundary Rules

`@weave/core` owns only DSL structure and validation.

It does **not**:

- discover skills from disk
- load skill content
- query available models or selected UI models
- register harness lifecycle hooks
- spawn agents in a harness
- expose `defineConfig()` or JavaScript object config APIs

Skill and model declarations are **intent**. Adapters provide harness-owned context to `@weave/engine` composition APIs, which resolve that intent for a specific harness.

## Usage

```ts
import { parseConfig } from "@weave/core";

const source = `
agent coder {
  prompt "You are a focused coding agent."
  models ["claude-sonnet-4-5", "gpt-4o"]
  mode subagent
  skills ["tdd"]

  tool_policy {
    read allow
    write allow
    edit allow
    delegate deny
  }
}

disable skills ["experimental-skill"]
`;

const result = parseConfig(source);

result.match(
  (config) => {
    // config.agents.coder.skills is ["tdd"] — a skill reference, not loaded content.
    // Adapters provide available skill content to @weave/engine later.
  },
  (errors) => {
    // Surface parse/validation errors to the caller.
  },
);
```

See [../../docs/adapter-boundary.md](../../docs/adapter-boundary.md) for how parsed config flows into engine composition APIs and adapters.
