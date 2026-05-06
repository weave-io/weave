# Task 05 Proofs — End-to-End Pipeline and Public API

## Task Summary

Task 5.0 wires the three pipeline stages into a single entry point and establishes the public API barrel. `parse-config.ts` exports `parseConfig(source)` which chains `tokenize → parse → validate` with early exit on each failure stage. `index.ts` is rewritten to export the full public surface: `parseConfig`, individual pipeline stages, all Zod schemas, all inferred types, all error types, all AST types, and the token types.

## What This Task Proves

- `parseConfig()` chains all three stages correctly: lex errors short-circuit before parse, parse errors short-circuit before validate.
- A minimal valid source round-trips to a correct `WeaveConfig`.
- A full source (multiple agents, categories, disable directives, log_level) round-trips with all fields populated.
- The AGENTS.md loom agent example — the canonical reference config — parses and validates correctly.
- An empty source produces valid defaults (`{}`, `{}`, `{ agents: [], hooks: [], skills: [] }`).
- Lex errors (`UnterminatedString`, `UnexpectedCharacter`), parse errors (`UnclosedBlock`, `MissingBlockName`), and validation errors (`prompt`+`prompt_file`, out-of-range temperature) all surface with the correct `ConfigError` discriminant.
- Lex errors carry correct source line numbers.
- The rewritten `index.ts` exports the complete public API — all 85 workspace tests pass after the barrel update.

## Evidence Summary

Three artifacts: end-to-end test suite (11/11 pass), full workspace test suite (85/85 pass), and workspace typecheck.

---

## Artifact: End-to-End Pipeline Tests — 11/11 Pass

**What it proves:** `parseConfig()` correctly chains all three stages and short-circuits on the first failure, covering all error variants and successful round-trips.
**Why it matters:** This is the primary consumer-facing function. If any stage's errors don't propagate correctly, callers would receive wrong results without any indication of failure.

**Command:**
```bash
bun test packages/core/src/__tests__/parse_config.test.ts
```

**Result summary:** 11 tests pass across four valid-source round-trips (minimal, full, AGENTS.md example, empty), two lex error cases, two parse error cases, two validation error cases, and source-position verification.

```
bun test v1.3.13 (bf2e2cec)

packages/core/src/__tests__/parse_config.test.ts:
(pass) parseConfig — valid sources > minimal valid source: single agent with inline prompt [3.30ms]
(pass) parseConfig — valid sources > full valid source: agents, categories, disable, log_level [1.74ms]
(pass) parseConfig — valid sources > AGENTS.md example: loom agent with tool_policy and triggers [0.16ms]
(pass) parseConfig — valid sources > empty source → ok with defaults [0.04ms]
(pass) parseConfig — lex errors > unterminated string → err with UnterminatedString [0.06ms]
(pass) parseConfig — lex errors > unexpected character → err with UnexpectedCharacter [0.02ms]
(pass) parseConfig — parse errors > unclosed block → err with UnclosedBlock [0.03ms]
(pass) parseConfig — parse errors > missing block name → err with MissingBlockName [0.03ms]
(pass) parseConfig — validation errors > both prompt and prompt_file → err with ValidationError [0.45ms]
(pass) parseConfig — validation errors > temperature out of range → err with ValidationError including source info [0.30ms]
(pass) parseConfig — source positions in errors > errors include line numbers where possible [0.03ms]

 11 pass
 0 fail
 39 expect() calls
Ran 11 tests across 1 file. [37.00ms]
```

---

## Artifact: Full Workspace Test Suite — 85/85 Pass

**What it proves:** The rewritten `index.ts` barrel does not break any existing consumers; all tests across all packages pass together after the public API change.
**Why it matters:** Barrel rewrites are a common regression source. This confirms the updated exports are backward-compatible with everything that imports from `@weave/core`.

**Command:**
```bash
bun test --recursive
```

**Result summary:** 85 tests pass across 6 files (21 errors, 18 lexer, 15 parser, 15 validate, 11 parse_config, 5 env) in 42ms. No hangs — the `bun test --recursive` hang from earlier (caused by misplaced Bun cache directory) is fully resolved.

```
 85 pass
 0 fail
 253 expect() calls
Ran 85 tests across 6 files. [42.00ms]
```

---

## Artifact: Workspace Typecheck — Zero Errors

**What it proves:** The new barrel exports are type-correct and no consumer is broken by the removal of the old `defineConfig` / legacy type exports.
**Why it matters:** The barrel is the only import path for downstream packages; a broken export here would be a compile-time failure for every consumer.

**Command:**
```bash
bun run typecheck
```

**Result summary:** All three workspace packages typecheck with exit code 0.

```
$ tsc --noEmit -p tsconfig.json && bun run --filter '*' typecheck
@weave/core typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
```

---

## Reviewer Conclusion

Task 5.0 is complete. `parse-config.ts` correctly implements the three-stage pipeline with proper short-circuit error propagation. `index.ts` exports the full public API as specified. All 11 pipeline tests pass, all 85 workspace tests pass, and the workspace typechecks cleanly.
