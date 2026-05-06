# 01-spec-core-dsl

## Introduction/Overview

The `@weave/core` package currently ships bare-bones hand-written TypeScript interfaces and a `defineConfig()` identity helper designed for a `weave.config.ts` approach. The project has pivoted to a **custom `.weave` DSL** — a block-structured configuration language with its own file format, syntax, lexer, and parser. This spec builds the complete parsing pipeline: source text → tokens → AST → validated `WeaveConfig`, all within `@weave/core`.

The DSL must be expressive enough that built-in agents (Loom, Tapestry, Shuttle, etc.) are declared using the same `.weave` syntax that end users use for custom agents — no separate code path.

## Goals

- **Custom lexer**: Tokenize `.weave` source files into a typed token stream, tracking line/column positions for error reporting.
- **Custom parser**: Parse the token stream into a typed AST representing agent blocks, category blocks, disable directives, and top-level settings.
- **Schema validation**: Validate the parsed AST against Zod schemas, producing typed `WeaveConfig` output with `z.infer<>` derived types.
- **`neverthrow` error pipeline**: Every stage (lex, parse, validate) returns `Result<T, E>` with explicit domain error types containing source locations.
- **End-to-end `parseConfig`**: Export a single `parseConfig(source: string): Result<WeaveConfig, ConfigError[]>` function that chains all stages.

## User Stories

- **As a framework contributor**, I want to declare a built-in agent (e.g. Loom) in a `.weave` file so that there is no hidden code path for built-in vs custom agents.
- **As an end user**, I want to write a simple `.weave` config with an agent name and prompt file path so that I can get an agent running with minimal syntax.
- **As an end user**, I want to define categories with glob patterns in my `.weave` config so that domain-specific shuttle agents are automatically created.
- **As an adapter author**, I want to receive a validated `WeaveConfig` with `allow`/`deny`/`ask` tool policies so that I can map them to my harness's permission model.
- **As a developer**, I want clear error messages with line and column numbers when my `.weave` file has syntax errors so that I can fix them quickly.

## Demoable Units of Work

### Unit 1: Lexer — Tokenizer and Error Types

**Purpose:** Build the foundation — a tokenizer that converts `.weave` source text into a flat token stream with source positions. Establish the error type conventions used throughout the pipeline.

**Functional Requirements:**

- The system shall export a `tokenize(source: string): Result<Token[], LexError[]>` function that converts a `.weave` source string into an array of tokens.
- Each `Token` shall contain: `type` (token kind), `value` (raw string), `line` (1-based), `column` (1-based).
- The tokenizer shall recognise these token types:
  - `Identifier` — bare words: `agent`, `category`, `workflow`, `step`, `disable`, `true`, `false`, `allow`, `deny`, `ask`, `primary`, `subagent`, `all`, `autonomous`, `interactive`, `gate`, and user-defined names
  - `String` — double-quoted (`"hello"`) and triple-quoted (`"""multi\nline"""`)
  - `Number` — integer and decimal literals (e.g. `0.1`, `42`)
  - `LBrace` / `RBrace` — `{` / `}`
  - `LBracket` / `RBracket` — `[` / `]`
  - `Comma` — `,` (inside arrays)
  - `Comment` — `#` to end of line (discarded, not emitted)
  - `Newline` — significant for statement separation
  - `EOF` — end of input
- The `LexError` type shall be a discriminated union with variants:
  - `{ type: "UnterminatedString"; line: number; column: number }`
  - `{ type: "InvalidNumber"; line: number; column: number; value: string }`
  - `{ type: "UnexpectedCharacter"; line: number; column: number; char: string }`
- The tokenizer shall skip whitespace (spaces, tabs) between tokens but emit `Newline` tokens for line breaks.
- The tokenizer shall handle `#` comments by discarding everything from `#` to end of line.
- All functions shall return `Result` types from `neverthrow`. The tokenizer shall collect all errors and return them together rather than stopping at the first error.

**Proof Artifacts:**

- **Test**: `packages/core/src/__tests__/lexer.test.ts` — tests tokenizing a valid agent block, string escaping, triple-quoted strings, numbers, comments, and error cases (unterminated string, unexpected character). All pass via `bun test`.
- **CLI**: `bun run typecheck` passes with zero errors.

### Unit 2: Parser and AST — Token Stream to Typed Tree

**Purpose:** Parse the token stream into a typed AST. Define AST node types for all supported blocks (agent, category, disable, settings) and nested structures (tool_policy, triggers).

**Functional Requirements:**

- The system shall export AST node types as a discriminated union `AstNode`:
  - `AgentBlock` — `{ type: "agent"; name: string; properties: Property[]; pos: SourcePos }`
  - `CategoryBlock` — `{ type: "category"; name: string; properties: Property[]; pos: SourcePos }`
  - `DisableDirective` — `{ type: "disable"; target: "agents" | "hooks" | "skills"; items: string[]; pos: SourcePos }`
  - `SettingAssignment` — `{ type: "setting"; key: string; value: AstValue; pos: SourcePos }` — for top-level `log_level`, `continuation`, `analytics`
  - `WorkflowBlock` — `{ type: "workflow"; name: string; properties: Property[]; steps: StepBlock[]; pos: SourcePos }` (parsed structurally but not validated in this spec)
- `Property` shall represent a key-value pair: `{ key: string; value: AstValue; pos: SourcePos }`
- `AstValue` shall be a discriminated union: `StringValue | NumberValue | BooleanValue | IdentifierValue | ArrayValue | BlockValue`
  - `BlockValue` represents nested `{ ... }` blocks (e.g. `tool_policy { ... }`, `completion plan_created { ... }`)
  - `ArrayValue` represents `[...]` with typed elements
- `SourcePos` shall contain `{ line: number; column: number }`.
- The system shall export a `parse(tokens: Token[]): Result<AstNode[], ParseError[]>` function.
- The `ParseError` type shall be a discriminated union with variants:
  - `{ type: "UnexpectedToken"; line: number; column: number; found: string; expected: string }`
  - `{ type: "MissingBlockName"; line: number; column: number; blockType: string }`
  - `{ type: "UnclosedBlock"; line: number; column: number }`
- The parser shall handle nested blocks (e.g. `tool_policy { ... }` inside `agent { ... }`, `step { ... }` inside `workflow { ... }`).
- The parser shall handle array values with mixed element types: strings, objects `{ key value ... }`, identifiers.
- The parser shall recover from errors where possible and continue parsing subsequent blocks.

**Proof Artifacts:**

- **Test**: `packages/core/src/__tests__/parser.test.ts` — tests parsing a full agent block (with nested tool_policy and triggers array), a category block, a disable directive, a top-level setting, error recovery across multiple blocks. All pass via `bun test`.
- **CLI**: `bun run typecheck` passes with zero errors.

### Unit 3: Schema Validation and End-to-End Pipeline

**Purpose:** Validate the parsed AST into a typed `WeaveConfig` using Zod schemas. Wire the full pipeline: `source → tokenize → parse → validate → WeaveConfig`. Export the public API.

**Functional Requirements:**

- The system shall export Zod schemas:
  - `ToolPermissionSchema` — `z.enum(["allow", "deny", "ask"])`
  - `DelegationTriggerSchema` — `z.object({ domain: z.string(), trigger: z.string() })`
  - `AgentConfigSchema` — validates agent properties:
    - `name` (string, required) — set from the block name
    - `description` (string, optional)
    - `display_name` (string, optional)
    - `prompt` (string, optional) — inline prompt text
    - `prompt_file` (string, optional) — path to `.md` file; mutually exclusive with `prompt` (Zod refinement)
    - `prompt_append` (string, optional)
    - `models` (string array, optional) — ordered preference list
    - `temperature` (number, optional, 0–2)
    - `mode` (`z.enum(["primary", "subagent", "all"])`, optional, default `"primary"`)
    - `tool_policy` (record of string → `ToolPermissionSchema`, optional)
    - `skills` (string array, optional)
    - `triggers` (array of `DelegationTriggerSchema`, optional)
  - `CategoryConfigSchema` — validates category properties:
    - `name` (string, required) — set from the block name
    - `description` (string, optional)
    - `patterns` (string array, required, min 1)
    - `models` (string array, optional)
    - `temperature` (number, optional, 0–2)
    - `tool_policy` (record of string → `ToolPermissionSchema`, optional)
    - `prompt_append` (string, optional)
  - `WeaveConfigSchema` — top-level config:
    - `agents` (record of string → `AgentConfigSchema`, default `{}`)
    - `categories` (record of string → `CategoryConfigSchema`, default `{}`)
    - `disabled` (`{ agents: string[], hooks: string[], skills: string[] }`, default all empty)
    - `log_level` (`z.enum(["DEBUG", "INFO", "WARN", "ERROR"])`, optional)
    - `workflows` (record of string → unknown, optional) — structurally parsed but not deeply validated in this spec
- The system shall export all inferred TypeScript types via `z.infer<>`: `AgentConfig`, `CategoryConfig`, `ToolPermission`, `DelegationTrigger`, `WeaveConfig`.
- The system shall export a `validate(ast: AstNode[]): Result<WeaveConfig, ValidationError[]>` function that transforms AST nodes into plain objects and validates them against the Zod schemas.
- `ValidationError` shall contain: `{ type: "ValidationError"; path: string; message: string; line?: number; column?: number }`.
- The system shall enforce `prompt` / `prompt_file` mutual exclusivity via a Zod `.refine()` — if both are provided, validation fails with a clear error including the agent name.
- The system shall enforce `prompt_file` path safety — reject paths containing `..` or absolute paths.
- The system shall export a `parseConfig(source: string): Result<WeaveConfig, ConfigError[]>` function that chains `tokenize → parse → validate` and collects all errors from all stages.
- `ConfigError` shall be a union of `LexError | ParseError | ValidationError`.
- The system shall remove the existing `defineConfig()`, hand-written `AgentConfig`, `WeaveConfig`, `HookConfig`, `SkillConfig` interfaces, and the `dsl.ts` file — these are replaced by the parser and Zod-inferred types.
- The system shall update the barrel export (`index.ts`) to export: `parseConfig`, `tokenize`, `parse`, `validate`, all schemas, all inferred types, all error types, and all AST node types.
- The system shall update `@weave/engine`'s `WeaveRunner`, `HarnessAdapter`, and any other consumers to use the new Zod-inferred types.

**Proof Artifacts:**

- **Test**: `packages/core/src/__tests__/validate.test.ts` — tests validating a complete agent+category config, prompt/prompt_file mutual exclusivity rejection, path traversal rejection, and graceful error messages with paths.
- **Test**: `packages/core/src/__tests__/parse-config.test.ts` — end-to-end tests: valid `.weave` source string → `parseConfig()` → `ok(WeaveConfig)`, and invalid source → `err(ConfigError[])` with mixed lex/parse/validation errors.
- **CLI**: `bun run typecheck` passes with zero errors across the entire workspace.
- **CLI**: `bun test` passes all tests in `packages/core/`.

## Non-Goals (Out of Scope)

- **Config file loading and merging** — Reading `~/.weave/config.weave` and `.weave/config.weave` from disk, merging them, and resolving prompt file paths is an engine responsibility. This spec parses a single source string.
- **Workflow deep validation** — Workflow blocks are structurally parsed (the parser handles `workflow` and `step` blocks) but not validated by Zod schemas in this spec. A future spec will add `WorkflowConfigSchema`.
- **Continuation, analytics, background config schemas** — Top-level settings blocks (`continuation { ... }`, `analytics { ... }`) are parsed as generic `SettingAssignment` AST nodes. Zod schemas for these are future specs.
- **Prompt composition engine** — How the engine resolves `prompt_file`, reads files, appends `prompt_append`, or injects skills is engine logic.
- **Adapter tool name mapping** — How adapters map `allow`/`deny`/`ask` to harness-specific permission formats is an adapter concern.
- **Model resolution logic** — How the engine resolves the `models` fallback chain is engine logic.
- **LSP / editor support** — Language server, syntax highlighting, or IDE extensions for `.weave` files are future work.

## Design Considerations

- **Error recovery**: The lexer and parser should continue after encountering errors to report as many problems as possible in one pass, rather than stopping at the first error.
- **Source positions everywhere**: Every token, AST node, and error carries line/column information for actionable diagnostics.
- **Newline significance**: Newlines separate statements within a block. `key value` pairs are newline-delimited, not semicolon-delimited. This keeps the syntax minimal.

## Repository Standards

- **Bun only** — runtime, test runner, bundler. No Node.js APIs.
- **`neverthrow`** — all fallible functions return `Result<T, E>` or `ResultAsync<T, E>`. Domain error types are discriminated unions.
- **Zod** — schemas are the source of truth for validated config types. All exported types derived via `z.infer<>`.
- **Classes for organisation** — the `Lexer` and `Parser` should be classes encapsulating state (position, tokens, errors).
- **Early returns** — guard at top, happy path unindented.
- **No `console.*`** — core is a pure parsing library with no logging.
- **Barrel exports** — all public API re-exported from `packages/core/src/index.ts`.
- **JSDoc** — on every exported symbol.
- **Tests** — `bun test`, co-located in `packages/core/src/__tests__/`.

## Technical Considerations

- **Lexer design**: A hand-written lexer (not a generator) using a `Lexer` class that advances through the source string character by character. This is standard for small DSLs and avoids external parser-generator dependencies. The lexer tracks `pos`, `line`, `col` state.
- **Parser design**: A recursive-descent parser using a `Parser` class. Simple enough for a block-structured grammar with no operator precedence. Methods: `parseBlock()`, `parseProperty()`, `parseValue()`, `parseArray()`.
- **AST-to-config transform**: A `validate.ts` module walks the AST, collects agent/category/disable/setting nodes into a plain object, then runs it through `WeaveConfigSchema.safeParse()`. Zod errors are mapped to `ValidationError` with the original source positions from the AST.
- **Dependencies**: Add `zod` and `neverthrow` to `@weave/core`'s `dependencies`. These are the only two external deps.
- **Backward compatibility**: The existing hand-written interfaces (`AgentConfig`, `WeaveConfig`, etc.) and `defineConfig()` are removed. The engine's `WeaveRunner` and `HarnessAdapter` are updated to use the new Zod-inferred types. Since the codebase is pre-release with no external consumers, this is a clean replacement.
- **Temperature range**: The legacy system allows 0–2 (not 0–1). The new schema matches this.
- **Token design**: Newlines are significant tokens for statement separation. The parser uses newlines to delimit property assignments within blocks, allowing the syntax to be semicolon-free and comma-free for top-level statements.

## Security Considerations

- **Prompt file path traversal**: The Zod schema for `prompt_file` rejects paths containing `..` segments or absolute paths (starting with `/` or drive letters). This is defense-in-depth; the engine will also sandbox path resolution.
- **No code execution**: The `.weave` DSL is purely declarative — no `import`, no function calls, no template evaluation. The parser does not execute any code from the config file.
- **No secrets in config**: The DSL types do not include secret/credential fields. JSDoc on `WeaveConfigSchema` documents that API keys belong in environment variables.

## Success Metrics

- **End-to-end parsing**: A valid `.weave` source string containing agents and categories successfully round-trips through `parseConfig()` to a typed `WeaveConfig`.
- **Error quality**: Every error (lex, parse, validation) includes a human-readable message and source position (line:column).
- **Zero type drift**: All exported TypeScript types derive from Zod schemas via `z.infer<>`.
- **Test coverage**: Unit tests for lexer, parser, validator, and end-to-end pipeline, covering happy paths and error cases.
- **Type-check clean**: `bun run typecheck` passes with zero errors across the entire workspace.
- **No hand-written interfaces**: All prior hand-written interfaces (`AgentConfig`, `WeaveConfig`, etc.) are replaced by Zod-inferred types.

## Open Questions

- **Workflow validation depth**: Workflow blocks are structurally parsed but not Zod-validated in this spec. Should the parser enforce structural constraints on steps (e.g. required `agent`, `prompt`, `completion` fields) even before Zod validation, or leave that entirely to a future spec?
- **Multi-line string indentation**: Should triple-quoted strings (`"""..."""`) strip common leading indentation (like Kotlin's `trimIndent()`) or preserve whitespace exactly? Recommendation: strip common indentation — prompts will be heavily indented inside agent blocks and shouldn't carry that indentation into the actual prompt text.
- **Array trailing commas**: Should the parser accept trailing commas in arrays (`["a", "b",]`)? Recommendation: yes, for authoring convenience — it's trivial to support and reduces diff noise.
