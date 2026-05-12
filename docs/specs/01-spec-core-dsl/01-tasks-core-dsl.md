# 01-tasks-core-dsl

> **Architecture note:** This completed task list predates the explicit [Adapter Boundary](../../adapter-boundary.md) guide. References to local engine `HookConfig`/`SkillConfig` types were transitional cleanup from legacy core types, not a decision that the engine owns concrete hook registration or harness skill discovery/loading. Current boundary guidance lives in [`../../adapter-boundary.md`](../../adapter-boundary.md).

## Relevant Files

| File                                               | Why It Is Relevant                                                                                                                        |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/package.json`                       | Add `zod` and `neverthrow` dependencies                                                                                                   |
| `packages/core/src/errors.ts`                      | **New.** Discriminated union error types: `LexError`, `ParseError`, `ValidationError`, `ConfigError`                                      |
| `packages/core/src/tokens.ts`                      | **New.** Token type enum and `Token` interface with source positions                                                                      |
| `packages/core/src/lexer.ts`                       | **New.** `Lexer` class — tokenizes `.weave` source into `Token[]`                                                                         |
| `packages/core/src/ast.ts`                         | **New.** AST node types: `AgentBlock`, `CategoryBlock`, `DisableDirective`, `SettingAssignment`, `WorkflowBlock`, `Property`, `AstValue`  |
| `packages/core/src/parser.ts`                      | **New.** `Parser` class — recursive-descent parser, tokens → AST                                                                          |
| `packages/core/src/schema.ts`                      | **New.** Zod schemas: `AgentConfigSchema`, `CategoryConfigSchema`, `WeaveConfigSchema`, `ToolPermissionSchema`, `DelegationTriggerSchema` |
| `packages/core/src/validate.ts`                    | **New.** `validate(ast): Result<WeaveConfig, ValidationError[]>` — AST → plain objects → Zod                                              |
| `packages/core/src/parse-config.ts`                | **New.** `parseConfig(source): Result<WeaveConfig, ConfigError[]>` — end-to-end pipeline                                                  |
| `packages/core/src/index.ts`                       | Rewrite barrel exports — remove legacy, export new public API                                                                             |
| `packages/core/src/agent.ts`                       | **Delete.** Replaced by Zod-inferred `AgentConfig` from `schema.ts`                                                                       |
| `packages/core/src/config.ts`                      | **Delete.** Replaced by Zod-inferred `WeaveConfig` from `schema.ts`                                                                       |
| `packages/core/src/dsl.ts`                         | **Delete.** `defineConfig()` no longer exists                                                                                             |
| `packages/core/src/hook.ts`                        | **Delete.** `HookConfig` interface is removed from core; any remaining engine type is transitional until lifecycle policy specs land      |
| `packages/core/src/skill.ts`                       | **Delete.** `SkillConfig` interface is removed from core; skills remain name references until adapter-provided skill resolution lands     |
| `packages/engine/src/adapter.ts`                   | Update imports — use new Zod-inferred types from `@weave/core`                                                                            |
| `packages/engine/src/runner.ts`                    | Update imports and destructuring — use new `WeaveConfig` shape                                                                            |
| `packages/engine/src/index.ts`                     | Verify re-exports still compile after type changes                                                                                        |
| `packages/core/src/__tests__/errors.test.ts`       | **New.** Tests for error type constructors and type guards                                                                                |
| `packages/core/src/__tests__/lexer.test.ts`        | **New.** Lexer unit tests                                                                                                                 |
| `packages/core/src/__tests__/parser.test.ts`       | **New.** Parser unit tests                                                                                                                |
| `packages/core/src/__tests__/validate.test.ts`     | **New.** Schema validation unit tests                                                                                                     |
| `packages/core/src/__tests__/parse-config.test.ts` | **New.** End-to-end pipeline integration tests                                                                                            |

### Notes

- Tests are co-located in `packages/core/src/__tests__/` per repository convention.
- All fallible functions return `Result<T, E>` or `ResultAsync<T, E>` from `neverthrow`.
- All exported TypeScript types are derived from Zod schemas via `z.infer<>`.
- Use `bun test` as the test runner. Use `bun run typecheck` for type checking.
- Follow AGENTS.md coding rules: early returns, classes for organisation, no nested ternaries, no `console.*`.

## Tasks

### [x] 1.0 Project Setup — Dependencies and Error Types

#### 1.0 Proof Artifact(s)

- CLI: `bun install` completes without errors in `packages/core/`, confirming `zod` and `neverthrow` are installed
- CLI: `bun run typecheck` passes with zero errors, confirming error type discriminated unions compile correctly
- Test: `packages/core/src/__tests__/errors.test.ts` passes via `bun test packages/core/src/__tests__/errors.test.ts`

#### 1.0 Tasks

- [x] 1.1 Add `zod` and `neverthrow` to `packages/core/package.json` `dependencies` using `bun install neverthrow zod`. Run `bun install` from workspace root.
- [x] 1.2 Create `packages/core/src/errors.ts` with discriminated union error types:
  - `LexError`: variants `UnterminatedString`, `InvalidNumber`, `UnexpectedCharacter` — each with `line: number`, `column: number`
  - `ParseError`: variants `UnexpectedToken` (with `found`, `expected`), `MissingBlockName` (with `blockType`), `UnclosedBlock` — each with `line`, `column`
  - `ValidationError`: `{ type: "ValidationError"; path: string; message: string; line?: number; column?: number }`
  - `ConfigError`: union type `LexError | ParseError | ValidationError`
  - Helper function `formatError(error: ConfigError): string` returning a human-readable `"line:column: message"` string
- [x] 1.3 Create `packages/core/src/__tests__/errors.test.ts` testing:
  - Each error variant can be constructed and its `type` discriminant narrows correctly
  - `formatError()` produces readable output for each error variant
  - Type guards work (e.g. checking `error.type === "UnterminatedString"` narrows to `LexError`)

---

### [x] 2.0 Lexer — Tokenize `.weave` Source Files

#### 2.0 Proof Artifact(s)

- Test: `packages/core/src/__tests__/lexer.test.ts` passes via `bun test packages/core/src/__tests__/lexer.test.ts` — covers valid tokenization, string types, numbers, comments, error collection
- CLI: `bun run typecheck` passes with zero errors

#### 2.0 Tasks

- [x] 2.1 Create `packages/core/src/tokens.ts` with:
  - `TokenType` enum: `Identifier`, `String`, `Number`, `LBrace`, `RBrace`, `LBracket`, `RBracket`, `Comma`, `Newline`, `EOF`
  - `Token` interface: `{ type: TokenType; value: string; line: number; column: number }`
  - `SourcePos` interface: `{ line: number; column: number }`
- [x] 2.2 Create `packages/core/src/lexer.ts` with a `Lexer` class:
  - Constructor takes `source: string`, initialises `pos`, `line`, `col` tracking
  - Private methods: `advance()`, `peek()`, `skipWhitespace()` (spaces/tabs only, not newlines), `readString()`, `readTripleQuotedString()` (with common indentation stripping), `readNumber()`, `readIdentifier()`
  - `readTripleQuotedString()` shall strip the common leading whitespace from all non-empty lines (like Kotlin `trimIndent()`)
  - Public method `tokenize(): Result<Token[], LexError[]>` — scans entire source, collects all errors, returns them together
  - `#` comments: skip from `#` to end of line (do not emit token)
  - Newline handling: emit `Newline` tokens, collapse consecutive newlines into one
  - Trailing commas in arrays: naturally handled since `,` is a token and parser will accept optional trailing comma
- [x] 2.3 Export a standalone `tokenize(source: string): Result<Token[], LexError[]>` function that creates a `Lexer` and calls its `tokenize()` method.
- [x] 2.4 Create `packages/core/src/__tests__/lexer.test.ts` testing:
  - Tokenize a simple agent block: `agent loom { temperature 0.1 }` → correct token sequence
  - Double-quoted strings: `"hello world"` → `String` token with correct value
  - Triple-quoted strings: `"""multi\nline"""` → `String` token with indentation stripped
  - Numbers: `0.1`, `42`, `0` → `Number` tokens
  - Booleans/identifiers: `true`, `false`, `allow`, `deny`, `ask`, `primary` → `Identifier` tokens
  - Comments: `# this is a comment` → no token emitted, next line tokenized correctly
  - Arrays: `["a", "b"]` → `LBracket`, `String`, `Comma`, `String`, `RBracket`
  - Nested braces: `{ tool_policy { read allow } }` → correct brace nesting in token stream
  - Newline collapsing: multiple blank lines → single `Newline` token
  - Error: unterminated string `"hello` → `err` result with `UnterminatedString` error at correct line/column
  - Error: unexpected character `@` → `err` result with `UnexpectedCharacter`
  - Error collection: source with multiple errors → all errors reported, not just first

---

### [x] 3.0 Parser + AST — Token Stream to Typed AST

#### 3.0 Proof Artifact(s)

- Test: `packages/core/src/__tests__/parser.test.ts` passes via `bun test packages/core/src/__tests__/parser.test.ts` — covers all block types, nested structures, error recovery
- CLI: `bun run typecheck` passes with zero errors

#### 3.0 Tasks

- [x] 3.1 Create `packages/core/src/ast.ts` with AST node types:
  - `SourcePos`: `{ line: number; column: number }` (re-export from tokens if shared)
  - `AstValue` discriminated union: `StringValue`, `NumberValue`, `BooleanValue`, `IdentifierValue`, `ArrayValue`, `BlockValue`
    - `StringValue`: `{ kind: "string"; value: string; pos: SourcePos }`
    - `NumberValue`: `{ kind: "number"; value: number; pos: SourcePos }`
    - `BooleanValue`: `{ kind: "boolean"; value: boolean; pos: SourcePos }`
    - `IdentifierValue`: `{ kind: "identifier"; value: string; pos: SourcePos }`
    - `ArrayValue`: `{ kind: "array"; elements: AstValue[]; pos: SourcePos }`
    - `BlockValue`: `{ kind: "block"; properties: Property[]; pos: SourcePos }`
  - `Property`: `{ key: string; value: AstValue; pos: SourcePos }`
  - `StepBlock`: `{ name: string; properties: Property[]; pos: SourcePos }`
  - `AstNode` discriminated union:
    - `AgentBlock`: `{ type: "agent"; name: string; properties: Property[]; pos: SourcePos }`
    - `CategoryBlock`: `{ type: "category"; name: string; properties: Property[]; pos: SourcePos }`
    - `WorkflowBlock`: `{ type: "workflow"; name: string; properties: Property[]; steps: StepBlock[]; pos: SourcePos }`
    - `DisableDirective`: `{ type: "disable"; target: "agents" | "hooks" | "skills"; items: string[]; pos: SourcePos }`
    - `SettingAssignment`: `{ type: "setting"; key: string; value: AstValue; pos: SourcePos }`
- [x] 3.2 Create `packages/core/src/parser.ts` with a `Parser` class:
  - Constructor takes `tokens: Token[]`, initialises cursor position and error accumulator
  - Private methods:
    - `current()`, `advance()`, `expect(type, value?)`, `skipNewlines()` — token navigation
    - `parseTopLevel(): AstNode | null` — dispatches on keyword: `agent` → `parseNamedBlock("agent")`, `category` → `parseNamedBlock("category")`, `workflow` → `parseWorkflowBlock()`, `disable` → `parseDisableDirective()`, identifier → `parseSettingAssignment()`
    - `parseNamedBlock(blockType)` — reads name identifier, expects `{`, reads properties until `}`, returns block node
    - `parseWorkflowBlock()` — reads name, `{`, reads properties and `step` sub-blocks, returns `WorkflowBlock`
    - `parseProperty()` — reads key identifier, then value
    - `parseValue()` — dispatches on token type: `String` → `StringValue`, `Number` → `NumberValue`, `Identifier` (true/false → `BooleanValue`, else → `IdentifierValue`), `LBracket` → `parseArray()`, `LBrace` → `parseBlock()`
    - `parseArray()` — reads `[`, elements separated by commas (trailing comma accepted), reads `]`
    - `parseBlock()` — reads `{`, properties until `}`, returns `BlockValue`
    - `parseDisableDirective()` — reads `disable`, target identifier (`agents`/`hooks`/`skills`), array value
  - Error recovery: on unexpected token, skip to next `Newline` or `RBrace` and continue parsing
  - Public method `parse(): Result<AstNode[], ParseError[]>`
- [x] 3.3 Export a standalone `parse(tokens: Token[]): Result<AstNode[], ParseError[]>` function.
- [x] 3.4 Create `packages/core/src/__tests__/parser.test.ts` testing:
  - Full agent block with nested `tool_policy` block and `triggers` array of objects → correct `AgentBlock` AST
  - Category block with `patterns` array → correct `CategoryBlock` AST
  - Disable directive: `disable agents ["warp", "spindle"]` → correct `DisableDirective`
  - Top-level setting: `log_level INFO` → correct `SettingAssignment`
  - Nested setting block: `continuation { recovery { compaction true } }` → `SettingAssignment` with nested `BlockValue`
  - Workflow block with multiple steps → correct `WorkflowBlock` with `StepBlock` children
  - Multiple blocks in one source → all parsed into `AstNode[]`
  - Error: unclosed block `agent loom {` (no `}`) → `err` with `UnclosedBlock`
  - Error: missing block name `agent { }` → `err` with `MissingBlockName`
  - Error recovery: first block has error, second block parses correctly → both error and valid node returned

---

### [x] 4.0 Schema Validation — AST to Validated `WeaveConfig`

#### 4.0 Proof Artifact(s)

- Test: `packages/core/src/__tests__/validate.test.ts` passes via `bun test packages/core/src/__tests__/validate.test.ts` — covers all schema fields, cross-field refinements, error paths
- CLI: `bun run typecheck` passes with zero errors

#### 4.0 Tasks

- [x] 4.1 Create `packages/core/src/schema.ts` with Zod schemas:
  - `ToolPermissionSchema`: `z.enum(["allow", "deny", "ask"])`
  - `DelegationTriggerSchema`: `z.object({ domain: z.string(), trigger: z.string() })`
  - `AgentConfigSchema`: `z.object(...)` with all fields from spec (name, description, display_name, prompt, prompt_file, prompt_append, models, temperature 0–2, mode, tool_policy, skills, triggers). Add `.refine()` for prompt/prompt_file mutual exclusivity. Add `.refine()` for prompt_file path safety (no `..`, no absolute paths).
  - `CategoryConfigSchema`: `z.object(...)` with fields (name, description, patterns min 1, models, temperature, tool_policy, prompt_append)
  - `DisabledConfigSchema`: `z.object({ agents: z.array(z.string()).default([]), hooks: z.array(z.string()).default([]), skills: z.array(z.string()).default([]) })`
  - `WeaveConfigSchema`: `z.object({ agents: z.record(...).default({}), categories: z.record(...).default({}), disabled: DisabledConfigSchema.default({}), log_level: z.enum([...]).optional(), workflows: z.record(z.string(), z.unknown()).optional() })`
  - Export all inferred types: `type AgentConfig = z.infer<typeof AgentConfigSchema>`, etc.
- [x] 4.2 Create `packages/core/src/validate.ts` with:
  - Internal `astToPlainObject(nodes: AstNode[]): Record<string, unknown>` — walks AST, groups agents/categories/disables/settings into a plain object shaped for `WeaveConfigSchema`
  - Helper `propertiesToObject(props: Property[]): Record<string, unknown>` — converts `Property[]` into key-value pairs, recursing into `BlockValue` and `ArrayValue`
  - Public `validate(ast: AstNode[]): Result<WeaveConfig, ValidationError[]>` — calls `astToPlainObject`, then `WeaveConfigSchema.safeParse()`, maps Zod errors to `ValidationError[]` with source positions from AST
  - Zod error mapping: traverse `ZodError.issues`, build `path` string from issue path array, attach `line`/`column` from the originating AST node where possible
- [x] 4.3 Create `packages/core/src/__tests__/validate.test.ts` testing:
  - Valid agent with all fields → `ok(WeaveConfig)` with correct data
  - Valid category with patterns and tool_policy → correct data
  - prompt + prompt_file both set → `err` with clear message mentioning agent name
  - prompt_file with `..` → `err` with path traversal message
  - prompt_file with absolute path `/etc/passwd` → `err`
  - Invalid tool_policy value (e.g. `"maybe"`) → `err`
  - Temperature out of range (e.g. `3.0`) → `err`
  - Invalid mode (e.g. `"background"`) → `err`
  - Empty patterns array on category → `err`
  - Missing required fields → `err` with correct path
  - Multiple agents, one valid and one invalid → `err` includes path like `agents.bad-agent.temperature`

---

### [x] 5.0 End-to-End Pipeline and Public API

#### 5.0 Proof Artifact(s)

- Test: `packages/core/src/__tests__/parse-config.test.ts` passes via `bun test packages/core/src/__tests__/parse-config.test.ts` — covers full roundtrip, error aggregation
- CLI: `bun run typecheck` passes with zero errors across entire workspace
- CLI: `bun test` passes all tests in `packages/core/`

#### 5.0 Tasks

- [x] 5.1 Create `packages/core/src/parse-config.ts` with:
  - `parseConfig(source: string): Result<WeaveConfig, ConfigError[]>` — chains `tokenize(source).andThen(parse).andThen(validate)`, maps all error types into `ConfigError[]`
  - If `tokenize` fails, return lex errors immediately (cannot proceed to parse)
  - If `parse` fails, return parse errors (cannot proceed to validate)
  - If `validate` fails, return validation errors
- [x] 5.2 Update `packages/core/src/index.ts` barrel exports:
  - Export `parseConfig` from `./parse-config.js`
  - Export `tokenize` from `./lexer.js`
  - Export `parse` from `./parser.js`
  - Export `validate` from `./validate.js`
  - Export all schemas from `./schema.js`: `AgentConfigSchema`, `CategoryConfigSchema`, `WeaveConfigSchema`, `ToolPermissionSchema`, `DelegationTriggerSchema`
  - Export all inferred types from `./schema.js`: `AgentConfig`, `CategoryConfig`, `WeaveConfig`, `ToolPermission`, `DelegationTrigger`
  - Export all error types from `./errors.js`: `LexError`, `ParseError`, `ValidationError`, `ConfigError`, `formatError`
  - Export all AST types from `./ast.js`: `AstNode`, `AstValue`, `Property`, `StepBlock`, `SourcePos`
  - Export `Token`, `TokenType` from `./tokens.js`
- [x] 5.3 Create `packages/core/src/__tests__/parse-config.test.ts` testing:
  - Minimal valid source: single agent with prompt → `ok(WeaveConfig)` with correct agent entry
  - Full valid source: multiple agents, categories, disable directives, log_level setting → `ok(WeaveConfig)` with all data populated
  - Source matching AGENTS.md examples (loom agent with tool_policy, triggers; backend/frontend categories) → `ok(WeaveConfig)` roundtrip
  - Lex error (unterminated string) → `err(ConfigError[])` where errors have `type: "UnterminatedString"`
  - Parse error (unclosed block) → `err` with parse errors
  - Validation error (both prompt and prompt_file) → `err` with validation errors
  - Mixed valid and invalid source → errors include source positions
  - Empty source → `ok(WeaveConfig)` with default empty agents/categories/disabled

---

### [x] 6.0 Cleanup — Remove Legacy Types, Update Engine Consumers

#### 6.0 Proof Artifact(s)

- CLI: `bun run typecheck` passes with zero errors across the full workspace
- CLI: `bun test` passes across the full workspace
- CLI: `grep -r "defineConfig\|from.*dsl" packages/ --include="*.ts"` returns zero results

#### 6.0 Tasks

- [x] 6.1 Delete legacy files from `packages/core/src/`:
  - `agent.ts` — replaced by `AgentConfig` from `schema.ts`
  - `config.ts` — replaced by `WeaveConfig` from `schema.ts`
  - `dsl.ts` — `defineConfig()` no longer exists
  - `hook.ts` — `HookConfig` no longer needed in core (hooks are not part of the `.weave` DSL in this spec; lifecycle handling remains an engine/adapter boundary concern)
  - `skill.ts` — `SkillConfig` no longer needed in core (skills are referenced by name in agent config; harness skill discovery/loading is adapter-owned)
- [x] 6.2 Update `packages/engine/src/adapter.ts`:
  - Change `import type { AgentConfig, HookConfig, SkillConfig } from "@weave/core"` to import only `AgentConfig` from `@weave/core`
  - For any temporary `HookConfig` and `SkillConfig` placeholders, define local interface types in the engine package (or a new `packages/engine/src/types.ts`) since these types are no longer exported from core. Treat them as transitional until dedicated lifecycle and skill-resolution specs replace them.
  - Update `spawnSubagent` parameter type to use the new Zod-inferred `AgentConfig`
- [x] 6.3 Update `packages/engine/src/runner.ts`:
  - Update `import type { AgentConfig, WeaveConfig } from "@weave/core"` to use new types
  - The new `WeaveConfig` shape has `agents`, `categories`, `disabled` (object with `agents`/`hooks`/`skills` arrays), `log_level`, `workflows` — no `hooks` or `skills` arrays at the top level. Update the `run()` method destructuring and logic accordingly.
  - The runner's hook/skill loading logic will need to be adapted — for now, the runner can skip hook/skill iteration since those config surfaces are deferred to future specs. Add `// TODO: restore hook/skill loading when config surfaces are specced` comments.
  - Update `disabled` check: old shape was `disabled?: string[]`, new shape is `disabled: { agents: string[], hooks: string[], skills: string[] }`. Update the disabled-check logic for agents to use `disabled.agents.includes(name)`.
  - Update model field access: old `agentConfig.model` → new `agentConfig.models?.[0]` for logging.
- [x] 6.4 Verify the full workspace compiles and all tests pass:
  - Run `bun run typecheck` from workspace root
  - Run `bun test` from workspace root
  - Grep for any remaining references to deleted files/exports: `grep -r "defineConfig\|from.*dsl\|from.*hook\|from.*skill\|from.*config\.js\|from.*agent\.js" packages/ --include="*.ts"` — should return zero results (excluding test files and the new schema/validate/parse-config files)
