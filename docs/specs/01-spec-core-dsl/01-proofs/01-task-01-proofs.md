# Task 01 Proofs — Project Setup: Dependencies and Error Types

## Task Summary

Task 1.0 establishes the foundational infrastructure for the Weave Core DSL pipeline: installing `neverthrow` and `zod` as production dependencies, and defining the discriminated union error types (`LexError`, `ParseError`, `ValidationError`, `ConfigError`) used throughout the entire pipeline. It also adds the `formatError()` helper that converts any `ConfigError` to a human-readable string.

## What This Task Proves

- `neverthrow` and `zod` are available as production dependencies in `@weave/core`.
- All four error union types are correctly shaped and their TypeScript discriminant narrowing works at compile-time.
- `formatError()` produces readable `"line:column: message"` output for every error variant.
- The workspace compiles with zero TypeScript errors after adding the new module.

## Evidence Summary

Three artifacts: dependency install confirmation, test suite output (21/21 pass), and full-workspace typecheck passing with zero errors.

---

## Artifact: Dependency Installation

**What it proves:** `neverthrow` and `zod` are installed as production dependencies in `@weave/core`.
**Why it matters:** All subsequent pipeline modules depend on `neverthrow` for `Result` types and `zod` for schema validation.

**Command:**

```bash
cd packages/core && bun add neverthrow zod
```

**Result summary:** Both packages installed successfully. `neverthrow@8.2.0` and `zod@4.4.3` appear in `packages/core/package.json` under `dependencies`.

```
bun add v1.3.13 (bf2e2cec)
Saved lockfile

$ husky

installed neverthrow@8.2.0
installed zod@4.4.3

[50.00ms] done
```

---

## Artifact: Error Type Tests — 21/21 Pass

**What it proves:** All discriminated union variants compile correctly, their `type` discriminants narrow TypeScript types as expected, and `formatError()` produces correct output for each variant.
**Why it matters:** Every downstream module (`lexer.ts`, `parser.ts`, `validate.ts`) relies on these error types being correctly shaped and narrowable.

**Command:**

```bash
bun test packages/core/src/__tests__/errors.test.ts
```

**Result summary:** All 21 tests pass across LexError, ParseError, ValidationError, ConfigError union narrowing, and `formatError()` output.

```
bun test v1.3.13 (bf2e2cec)

packages/core/src/__tests__/errors.test.ts:
(pass) LexError variants > UnterminatedString — type discriminant narrows correctly
(pass) LexError variants > InvalidNumber — holds value field
(pass) LexError variants > UnexpectedCharacter — holds char field
(pass) ParseError variants > UnexpectedToken — holds found and expected fields
(pass) ParseError variants > MissingBlockName — holds blockType field
(pass) ParseError variants > UnclosedBlock — minimal fields
(pass) ValidationError > holds path and message
(pass) ValidationError > accepts optional line and column
(pass) ConfigError union type guards > narrows UnterminatedString variant from ConfigError
(pass) ConfigError union type guards > narrows InvalidNumber variant from ConfigError
(pass) ConfigError union type guards > narrows UnclosedBlock variant from ConfigError
(pass) ConfigError union type guards > narrows ValidationError variant from ConfigError
(pass) formatError > formats UnterminatedString
(pass) formatError > formats InvalidNumber
(pass) formatError > formats UnexpectedCharacter
(pass) formatError > formats UnexpectedToken
(pass) formatError > formats MissingBlockName
(pass) formatError > formats UnclosedBlock
(pass) formatError > formats ValidationError with path and no location
(pass) formatError > formats ValidationError with location
(pass) formatError > formats ValidationError with empty path

 21 pass
 0 fail
 32 expect() calls
Ran 21 tests across 1 file. [11.00ms]
```

---

## Artifact: Workspace Typecheck — Zero Errors

**What it proves:** The new `errors.ts` module and its types integrate cleanly with the existing workspace without introducing any TypeScript compilation errors.
**Why it matters:** A clean typecheck confirms the error types are correctly exported and compatible with the rest of `@weave/core` and the engine packages.

**Command:**

```bash
bun run typecheck
```

**Result summary:** All three workspace packages (`@weave/core`, `@weave/engine`, `@weave/adapter-opencode`) pass typecheck with exit code 0.

```
$ tsc --noEmit -p tsconfig.json && bun run --filter '*' typecheck
@weave/core typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
```

---

## Reviewer Conclusion

Task 1.0 is complete. The `@weave/core` package now has `neverthrow` and `zod` as production dependencies. The `errors.ts` module correctly defines all four discriminated union error types with proper TypeScript narrowing. All 21 tests pass, the workspace typechecks cleanly, and the foundation is ready for the Lexer (Task 2.0).
