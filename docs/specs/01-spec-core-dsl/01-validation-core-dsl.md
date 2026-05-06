# 01-validation-core-dsl

## 1) Executive Summary

| Item                          | Result                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Overall**                   | ✅ PASS — no gates tripped                                                                                          |
| **Implementation Ready**      | **Yes** — all 30 functional requirements verified, 85/85 tests pass, workspace typechecks clean, no blocking issues |
| **Requirements Verified**     | 30/30 (100%)                                                                                                        |
| **Proof Artifacts Working**   | 6/6 (100%)                                                                                                          |
| **Files Changed vs Expected** | 14 core source files changed; all map to Relevant Files in task list. 1 naming discrepancy (MEDIUM).                |
| **Lint**                      | Zero warnings/errors (biome)                                                                                        |
| **Typecheck**                 | Zero errors across 3 workspace packages                                                                             |

**Gates:**

- GATE A (blockers): ✅ No CRITICAL or HIGH issues
- GATE B (coverage): ✅ No Unknown entries in coverage matrix
- GATE C (proof artifacts): ✅ All 6 artifact files exist and CLI commands reproduce
- GATE D1 (scope): ✅ No unmapped out-of-scope core file changes
- GATE E (standards): ✅ Repository standards followed
- GATE F (security): ✅ No real credentials in any proof artifact

---

## 2) Coverage Matrix

### Functional Requirements

| Req                                       | Description                                                                                                                  | Status      | Evidence                                                                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit 1 — Lexer**                        |                                                                                                                              |             |                                                                                                                                                           |
| FR-1.1                                    | `tokenize(source): Result<Token[], LexError[]>` exported                                                                     | ✅ Verified | `packages/core/src/lexer.ts` exports `tokenize()`; re-exported from `index.ts`; 18 lexer tests pass                                                       |
| FR-1.2                                    | `Token` has `type`, `value`, `line`, `column`                                                                                | ✅ Verified | `tokens.ts` `Token` interface; lexer test "records correct line and column" passes                                                                        |
| FR-1.3                                    | All token types recognised (Identifier, String, Number, braces, brackets, Comma, Newline, EOF; Comment discarded)            | ✅ Verified | `TokenType` enum in `tokens.ts`; 14 passing tokenization tests including comment-skip                                                                     |
| FR-1.4                                    | `LexError` discriminated union: `UnterminatedString`, `InvalidNumber`, `UnexpectedCharacter`                                 | ✅ Verified | `errors.ts`; 21 errors tests pass; error variants narrow correctly                                                                                        |
| FR-1.5                                    | Whitespace skipped; `Newline` emitted; consecutive newlines collapsed                                                        | ✅ Verified | Lexer test "collapses multiple blank lines into a single Newline token" passes                                                                            |
| FR-1.6                                    | `#` comments discarded                                                                                                       | ✅ Verified | Lexer test "skips line comments and tokenizes the next line" passes                                                                                       |
| FR-1.7                                    | All errors collected, not stopped at first                                                                                   | ✅ Verified | Lexer test "collects multiple errors — does not stop at first" passes                                                                                     |
| FR-1.8                                    | `neverthrow` `Result` return types throughout                                                                                | ✅ Verified | `lexer.ts`, `errors.ts`, `parse-config.ts`, `validate.ts`, `parser.ts` all import from `neverthrow`                                                       |
| **Unit 2 — Parser + AST**                 |                                                                                                                              |             |                                                                                                                                                           |
| FR-2.1                                    | `AstNode` union: `AgentBlock`, `CategoryBlock`, `DisableDirective`, `SettingAssignment`, `WorkflowBlock`                     | ✅ Verified | `ast.ts`; all 5 node types present; parser tests cover each                                                                                               |
| FR-2.2                                    | `Property`: `{ key, value, pos }`                                                                                            | ✅ Verified | `ast.ts`; parser tests verify property extraction in agent/category blocks                                                                                |
| FR-2.3                                    | `AstValue` union: `StringValue`, `NumberValue`, `BooleanValue`, `IdentifierValue`, `ArrayValue`, `BlockValue`                | ✅ Verified | `ast.ts`; parser tests verify all 6 kinds including nested `BlockValue` (tool_policy)                                                                     |
| FR-2.4                                    | `SourcePos`: `{ line, column }`                                                                                              | ✅ Verified | `tokens.ts` defines, `ast.ts` re-exports; all nodes carry `pos`                                                                                           |
| FR-2.5                                    | `parse(tokens): Result<AstNode[], ParseError[]>` exported                                                                    | ✅ Verified | `parser.ts` exports `parse()`; re-exported from `index.ts`; 15 parser tests pass                                                                          |
| FR-2.6                                    | `ParseError` union: `UnexpectedToken`, `MissingBlockName`, `UnclosedBlock`                                                   | ✅ Verified | `errors.ts`; 21 error tests pass; parser error tests confirm each variant                                                                                 |
| FR-2.7                                    | Nested block handling (`tool_policy` inside `agent`, `step` inside `workflow`)                                               | ✅ Verified | Parser tests "parses agent with nested tool_policy block" and "parses a workflow with steps" pass                                                         |
| FR-2.8                                    | Mixed-type array values (strings, block objects, identifiers)                                                                | ✅ Verified | Parser test "parses agent with triggers array of block objects" passes                                                                                    |
| FR-2.9                                    | Error recovery: continue parsing after error                                                                                 | ✅ Verified | Parser test "error recovery: second block parses correctly after first block error" passes                                                                |
| **Unit 3 — Schema Validation + Pipeline** |                                                                                                                              |             |                                                                                                                                                           |
| FR-3.1                                    | `ToolPermissionSchema`, `DelegationTriggerSchema`, `AgentConfigSchema`, `CategoryConfigSchema`, `WeaveConfigSchema` exported | ✅ Verified | `schema.ts`; all schemas re-exported from `index.ts`                                                                                                      |
| FR-3.2                                    | `AgentConfigSchema` validates all fields; temperature 0–2; mode enum                                                         | ✅ Verified | Validate tests: valid agent with all fields, temperature above 2.0 → err, invalid mode → err                                                              |
| FR-3.3                                    | `CategoryConfigSchema` with `patterns` min-1                                                                                 | ✅ Verified | Validate test "empty patterns array on category → err" passes                                                                                             |
| FR-3.4                                    | `WeaveConfigSchema` with `agents`, `categories`, `disabled`, `log_level`, `workflows`; all with defaults                     | ✅ Verified | Validate test "empty AST → ok with defaults" passes; full round-trip test passes                                                                          |
| FR-3.5                                    | All types via `z.infer<>`: `AgentConfig`, `CategoryConfig`, `WeaveConfig`, `ToolPermission`, `DelegationTrigger`             | ✅ Verified | `schema.ts` lines: `export type AgentConfig = z.infer<typeof AgentConfigSchema>` etc.; typecheck passes                                                   |
| FR-3.6                                    | `validate(ast): Result<WeaveConfig, ValidationError[]>` exported                                                             | ✅ Verified | `validate.ts`; re-exported from `index.ts`; 15 validate tests pass                                                                                        |
| FR-3.7                                    | `ValidationError`: `{ type, path, message, line?, column? }`                                                                 | ✅ Verified | `errors.ts`; validate tests check `e.path.includes(...)` on error results                                                                                 |
| FR-3.8                                    | `prompt`/`prompt_file` mutual exclusivity via Zod `.refine()`                                                                | ✅ Verified | Validate test "both prompt and prompt_file set → err" and parse_config test match pass                                                                    |
| FR-3.9                                    | `prompt_file` path safety — reject `..` and absolute paths                                                                   | ✅ Verified | Validate tests "prompt_file with '..' → err" and "prompt_file with absolute path → err" pass                                                              |
| FR-3.10                                   | `parseConfig(source): Result<WeaveConfig, ConfigError[]>` exported; chains all 3 stages                                      | ✅ Verified | `parse-config.ts`; 11 end-to-end tests pass including all 3 error types                                                                                   |
| FR-3.11                                   | `ConfigError = LexError \| ParseError \| ValidationError`                                                                    | ✅ Verified | `errors.ts`; parse_config tests verify each error type surfaces through `parseConfig()`                                                                   |
| FR-3.12                                   | Legacy types removed: `defineConfig`, `AgentConfig` (hand-written), `WeaveConfig`, `HookConfig`, `SkillConfig`, `dsl.ts`     | ✅ Verified | Files deleted: `agent.ts`, `config.ts`, `dsl.ts`, `hook.ts`, `skill.ts`; `grep defineConfig` returns zero results                                         |
| FR-3.13                                   | Barrel `index.ts` exports all required symbols                                                                               | ✅ Verified | `index.ts` exports: `parseConfig`, `tokenize`, `parse`, `validate`, all schemas, all inferred types, all error types, all AST types, `Token`, `TokenType` |
| FR-3.14                                   | Engine consumers updated (`WeaveRunner`, `HarnessAdapter`) to use new Zod-inferred types                                     | ✅ Verified | `adapter.ts` imports only `AgentConfig` from `@weave/core`; `runner.ts` uses `disabled.agents.includes()`; typecheck passes                               |

---

### Repository Standards

| Standard                                                                  | Status      | Evidence                                                                                                                                                                       |
| ------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Bun only** — runtime, test runner, bundler                              | ✅ Verified | `bun test`, `bun run typecheck`, `bun build` in scripts; no `ts-node`, `jest`, `@types/node`                                                                                   |
| **`neverthrow`** — all fallible functions return `Result<T, E>`           | ✅ Verified | `lexer.ts`, `parser.ts`, `validate.ts`, `parse-config.ts` all use `ok()`, `err()`, `Result` from neverthrow                                                                    |
| **Zod** — schemas are source of truth; all exported types via `z.infer<>` | ✅ Verified | 7 exported types all derived via `z.infer<>`; no hand-written config interfaces remain                                                                                         |
| **Classes for organisation** (`Lexer`, `Parser`)                          | ✅ Verified | `export class Lexer` in `lexer.ts`; `export class Parser` in `parser.ts`                                                                                                       |
| **Early returns** — guard at top, happy path unindented                   | ✅ Verified | `parseConfig.ts`, `validate.ts`, all error handlers: guard first, return early                                                                                                 |
| **No `console.*`**                                                        | ✅ Verified | `grep console. packages/core/src/ --include="*.ts" --exclude-dir=__tests__` → zero results                                                                                     |
| **Barrel exports** — all public API from `index.ts`                       | ✅ Verified | `index.ts` is the sole export point; all symbols confirmed present                                                                                                             |
| **JSDoc on exported symbols**                                             | ⚠️ Partial  | File-level JSDoc present on all modules. Individual `export const` schemas in `schema.ts` and type aliases in `ast.ts` / `tokens.ts` lack per-symbol doc blocks. See Issue #1. |
| **Tests** — `bun test`, co-located in `__tests__/`                        | ✅ Verified | All 5 test files in `packages/core/src/__tests__/`; all run with `bun test`                                                                                                    |

---

### Proof Artifacts

| Task                            | Proof File             | Status      | Verification                                                                                                      |
| ------------------------------- | ---------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------- |
| T1 — Dependencies + Error Types | `01-task-01-proofs.md` | ✅ Verified | File exists; `bun test errors.test.ts` → 21/21 pass (re-run confirmed)                                            |
| T2 — Lexer                      | `01-task-02-proofs.md` | ✅ Verified | File exists; `bun test lexer.test.ts` → 18/18 pass (re-run confirmed)                                             |
| T3 — Parser + AST               | `01-task-03-proofs.md` | ✅ Verified | File exists; `bun test parser.test.ts` → 15/15 pass (re-run confirmed)                                            |
| T4 — Schema Validation          | `01-task-04-proofs.md` | ✅ Verified | File exists; `bun test validate.test.ts` → 15/15 pass (re-run confirmed)                                          |
| T5 — End-to-End Pipeline        | `01-task-05-proofs.md` | ✅ Verified | File exists; `bun test parse_config.test.ts` → 11/11 pass; `bun test --recursive` → 85/85 pass (re-run confirmed) |
| T6 — Cleanup                    | `01-task-06-proofs.md` | ✅ Verified | File exists; legacy files deleted; grep for `defineConfig` → zero results; typecheck clean (re-run confirmed)     |

---

## 3) Validation Issues

| #   | Severity | Issue                                                                                                                                                                                                                                                                                                                    | Impact                                                                                                                                                                       | Recommendation                                                                                                                                                                             |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | MEDIUM   | **JSDoc gaps on individual exported symbols.** `schema.ts` exports 7 schemas and 7 type aliases with no per-symbol JSDoc (only a file-level comment). `ast.ts` and `tokens.ts` individual type aliases also lack per-symbol doc blocks. Spec states: "JSDoc on every exported symbol."                                   | Tooling (IDE hover, `tsdoc` generators) won't show schema-level documentation.                                                                                               | Add one-line JSDoc (`/** ... */`) to each `export const Schema` and `export type Alias` in `schema.ts`, `ast.ts`, `tokens.ts`. Low effort, high documentation value.                       |
| 2   | MEDIUM   | **`log_level` enum extends beyond spec.** Spec states `z.enum(["DEBUG", "INFO", "WARN", "ERROR"])`. Implementation uses `z.enum(["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"])` — adding `TRACE` and `FATAL` to match pino's level set.                                                                           | Config with `log_level TRACE` or `FATAL` passes validation but spec doesn't account for these values. Future consumers expecting the spec's 4-value enum would be surprised. | If pino alignment is intentional (likely correct), update the spec to reflect the full 6-value enum. If spec is authoritative, remove `TRACE`/`FATAL` from the schema.                     |
| 3   | MEDIUM   | **Test file naming discrepancy.** Spec (`01-spec-core-dsl.md`) and task list (`01-tasks-core-dsl.md`) reference the test file as `parse-config.test.ts` (hyphen). Implementation created `parse_config.test.ts` (underscore). The task list Relevant Files table and sub-task 5.3 both still say `parse-config.test.ts`. | Traceability gap: automated doc tooling or future agents scanning the task list for the file won't find it.                                                                  | Rename `parse_config.test.ts` → `parse-config.test.ts` to match the spec/task list, OR update task list and spec to say `parse_config.test.ts`. Either is acceptable; consistency matters. |
| 4   | INFO     | **`errors.ts` modified in T6 commit.** Commit `504988f` shows `errors.ts` with 120 insertions/120 deletions, which looked potentially concerning. Verified: this was purely a whitespace-only reformatting (tabs → spaces by biome auto-fix). Content is identical to T1 implementation.                                 | No functional impact.                                                                                                                                                        | No action needed.                                                                                                                                                                          |

---

## 4) Evidence Appendix

### Commits Analyzed

| Commit    | Message                                                       | Tasks                 | Key Files                                                                    |
| --------- | ------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------- |
| `c632ab5` | feat: add error types and install neverthrow/zod              | T1                    | `errors.ts`, `errors.test.ts`, `packages/core/package.json`                  |
| `2024fc4` | feat(core): implement lexer                                   | T2 (+ parser bug fix) | `tokens.ts`, `lexer.ts`, `parser.ts`, `lexer.test.ts`                        |
| `9b2a8a3` | feat(core): implement parser and AST                          | T3                    | `ast.ts`, `parser.test.ts`                                                   |
| `4b43fe7` | feat(core): implement Zod schema validation                   | T4                    | `schema.ts`, `validate.ts`, `validate.test.ts`, `parse_config.test.ts`       |
| `8e98a11` | feat(core): end-to-end pipeline and public API barrel         | T5                    | `parse-config.ts`, `index.ts`, `lexer.ts` (biome fixes)                      |
| `504988f` | feat(core): cleanup — remove legacy types                     | T6                    | Deleted 5 legacy files, `adapter.ts`, `runner.ts`, `errors.ts` (format only) |
| `14a502d` | chore: update codesight, biome, package manifests, husky hook | —                     | Auto-generated files; no production code                                     |

### All Tests Re-run (independent verification)

```
bun test --recursive

 85 pass
 0 fail
 253 expect() calls
Ran 85 tests across 6 files. [53.00ms]
```

Breakdown:

- `errors.test.ts`: 21/21
- `lexer.test.ts`: 18/18
- `parser.test.ts`: 15/15
- `validate.test.ts`: 15/15
- `parse_config.test.ts`: 11/11
- `env.test.ts` (engine): 5/5

### Workspace Typecheck (independent verification)

```
bun run typecheck

@weave/core typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
```

### Biome Lint (independent verification)

```
bunx biome lint packages/

Checked 21 files in 39ms. No fixes applied.
```

Zero warnings, zero errors.

### Legacy File Deletion Confirmed

```
DELETED: packages/core/src/agent.ts
DELETED: packages/core/src/config.ts
DELETED: packages/core/src/dsl.ts
DELETED: packages/core/src/hook.ts
DELETED: packages/core/src/skill.ts
```

### `defineConfig` Reference Check

```
grep -r "defineConfig" packages/ --include="*.ts"
(no output — exit code 1)
```

Zero references to deleted DSL helper.

### Engine Consumer Imports Verified

```
packages/engine/src/adapter.ts: import type { AgentConfig } from "@weave/core";
packages/engine/src/runner.ts:  import type { AgentConfig, WeaveConfig } from "@weave/core";
```

Only Zod-inferred types imported. No legacy `HookConfig`/`SkillConfig` from core.

---

**Validation Completed:** 2026-05-06  
**Validation Performed By:** Claude Sonnet 4.5 (claude-code)
