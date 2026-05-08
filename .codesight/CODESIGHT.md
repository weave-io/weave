# @weave — AI Context Map

> **Stack:** raw-http | none | unknown | typescript
> **Monorepo:** @weave/core, @weave/engine, @weave/config, @weave/adapter-opencode

> 0 routes | 0 models | 0 components | 13 lib files | 2 env vars | 0 middleware | 0% test coverage
> **Token savings:** this file is ~1,600 tokens. Without it, AI exploration would cost ~12,700 tokens. **Saves ~11,100 tokens per conversation.**
> **Last scanned:** 2026-05-08 17:22 — re-run after significant changes

---

# Libraries

- `packages/config/src/builtins.ts`
  - function getBuiltinConfig: () => Result<WeaveConfig, ConfigError[]>
  - const BUILTIN_AGENT_NAMES: readonly string[]
  - const BUILTIN_WEAVE_SOURCE
- `packages/config/src/discovery.ts`
  - function discoverAndParse: (projectRoot?, fileReader) => ResultAsync<DiscoveredConfig[], ConfigLoadError[]>
  - interface FileReader
  - type DiscoveredConfig
  - const bunFileReader: FileReader
- `packages/config/src/loader.ts` — function loadConfig: (projectRoot?, fileReader) => ResultAsync<import("@weave/core").WeaveConfig, ConfigLoadError[]>
- `packages/config/src/merge.ts` — function mergeConfigs: (...configs) => WeaveConfig
- `packages/config/src/resolve.ts` — function resolvePromptPaths: (config, scope) => WeaveConfig
- `packages/core/src/errors.ts`
  - function formatError: (error) => string
  - type LexError
  - type ParseError
  - type ValidationError
  - type ConfigError
- `packages/core/src/lexer.ts` — function tokenize: (source) => Result<Token[], LexError[]>, class Lexer
- `packages/core/src/parse-config.ts` — function parseConfig: (source) => Result<WeaveConfig, ConfigError[]>
- `packages/core/src/parser.ts` — function parse: (tokens) => Result<AstNode[], ParseError[]>, class Parser
- `packages/core/src/validate.ts` — function validate: (ast) => Result<WeaveConfig, ValidationError[]>
- `packages/engine/src/env.ts`
  - function parseEnv: (raw) => Env
  - type Env
  - const envSchema
  - const env: Env
- `packages/engine/src/runner.ts` — class WeaveRunner
- `scripts/validate-config.ts` — function printSummary: (config, configPath) => void

---

# Config

## Environment Variables

- `HOME` **required** — packages/config/src/__tests__/discovery.test.ts
- `LOG_LEVEL` **required** — packages/config/src/logger.ts

## Config Files

- `tsconfig.json`

---

# Dependency Graph

## Most Imported Files (change these carefully)

- `packages/core/src/tokens.ts` — imported by **8** files
- `packages/core/src/errors.ts` — imported by **6** files
- `packages/config/src/discovery.ts` — imported by **5** files
- `packages/config/src/types.ts` — imported by **5** files
- `packages/core/src/lexer.ts` — imported by **5** files
- `packages/core/src/parser.ts` — imported by **4** files
- `packages/engine/src/env.ts` — imported by **4** files
- `packages/config/src/builtins.ts` — imported by **3** files
- `packages/config/src/merge.ts` — imported by **3** files
- `packages/config/src/resolve.ts` — imported by **3** files
- `packages/config/src/errors.ts` — imported by **3** files
- `packages/core/src/validate.ts` — imported by **3** files
- `packages/engine/src/adapter.ts` — imported by **3** files
- `packages/config/src/loader.ts` — imported by **2** files
- `packages/config/src/logger.ts` — imported by **2** files
- `packages/core/src/parse-config.ts` — imported by **2** files
- `packages/core/src/schema.ts` — imported by **2** files
- `packages/engine/src/runner.ts` — imported by **2** files
- `packages/engine/src/logger.ts` — imported by **2** files
- `packages/engine/src/__tests__/mock-adapter.ts` — imported by **1** files

## Import Map (who imports what)

- `packages/core/src/tokens.ts` ← `packages/core/src/__tests__/lexer.test.ts`, `packages/core/src/ast.ts`, `packages/core/src/ast.ts`, `packages/core/src/index.ts`, `packages/core/src/index.ts` +3 more
- `packages/core/src/errors.ts` ← `packages/core/src/__tests__/errors.test.ts`, `packages/core/src/index.ts`, `packages/core/src/lexer.ts`, `packages/core/src/parse-config.ts`, `packages/core/src/parser.ts` +1 more
- `packages/config/src/discovery.ts` ← `packages/config/src/__tests__/discovery.test.ts`, `packages/config/src/__tests__/discovery.test.ts`, `packages/config/src/__tests__/load_config.test.ts`, `packages/config/src/index.ts`, `packages/config/src/index.ts`
- `packages/config/src/types.ts` ← `packages/config/src/__tests__/resolve.test.ts`, `packages/config/src/discovery.ts`, `packages/config/src/index.ts`, `packages/config/src/loader.ts`, `packages/config/src/resolve.ts`
- `packages/core/src/lexer.ts` ← `packages/core/src/__tests__/lexer.test.ts`, `packages/core/src/__tests__/parser.test.ts`, `packages/core/src/__tests__/validate.test.ts`, `packages/core/src/index.ts`, `packages/core/src/parse-config.ts`
- `packages/core/src/parser.ts` ← `packages/core/src/__tests__/parser.test.ts`, `packages/core/src/__tests__/validate.test.ts`, `packages/core/src/index.ts`, `packages/core/src/parse-config.ts`
- `packages/engine/src/env.ts` ← `packages/engine/src/__tests__/env.test.ts`, `packages/engine/src/index.ts`, `packages/engine/src/index.ts`, `packages/engine/src/logger.ts`
- `packages/config/src/builtins.ts` ← `packages/config/src/__tests__/load_config.test.ts`, `packages/config/src/index.ts`, `packages/config/src/loader.ts`
- `packages/config/src/merge.ts` ← `packages/config/src/__tests__/merge.test.ts`, `packages/config/src/index.ts`, `packages/config/src/loader.ts`
- `packages/config/src/resolve.ts` ← `packages/config/src/__tests__/resolve.test.ts`, `packages/config/src/index.ts`, `packages/config/src/loader.ts`

---

# Test Coverage

> **0%** of routes and models are covered by tests
> 15 test files found

---

_Generated by [codesight](https://github.com/Houseofmvps/codesight) — see your codebase clearly_