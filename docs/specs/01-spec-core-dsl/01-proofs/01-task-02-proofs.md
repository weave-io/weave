# Task 02 Proofs — Lexer: Tokenize `.weave` Source Files

## Task Summary

Task 2.0 implements the `Lexer` class and `tokenize()` function that convert raw `.weave` source text into a `Token[]` stream consumed by the parser. It also defines `TokenType`, `Token`, and `SourcePos` in `tokens.ts`. This is the first stage of the three-stage DSL pipeline (lex → parse → validate).

A bug discovered during this task — `bun test --recursive` hanging indefinitely — was traced to two root causes fixed as part of this task:
1. `bunfig.toml` used `dir = "~/.bun/install/cache"` which Bun does not expand; a literal `~/` directory was created inside the project root and populated with zod's own test suite (~150 files), causing `--recursive` to discover and attempt to run them.
2. An infinite loop in `Parser.parse()` (discovered when isolating the hang) where a stray `}` token caused `#parseTopLevel()` to re-enter with no cursor progress. Fixed by adding a safety advance when no progress is made.

## What This Task Proves

- `tokens.ts` defines the full `TokenType` enum, `Token` interface, and `SourcePos` interface.
- The `Lexer` class correctly tokenizes all `.weave` syntax: identifiers, strings (double-quoted and triple-quoted with `trimIndent`), numbers, booleans, comments, arrays, nested blocks, and newlines.
- Consecutive newlines are collapsed to a single `Newline` token.
- `#` comments produce no tokens.
- Errors (`UnterminatedString`, `UnexpectedCharacter`) are collected without stopping at the first — all errors in a source are reported together.
- `tokenize()` standalone function works as a `Result`-returning wrapper.
- All 18 lexer tests pass; workspace typechecks clean.

## Evidence Summary

Two artifacts: lexer test suite output (18/18 pass) and workspace typecheck confirmation.

---

## Artifact: Lexer Test Suite — 18/18 Pass

**What it proves:** Every tokenization case specified in task 2.4 is covered and passing, including valid paths, error paths, and error collection.
**Why it matters:** The lexer is the entry point of the pipeline; any gap here would silently corrupt all downstream parsing and validation.

**Command:**
```bash
bun test packages/core/src/__tests__/lexer.test.ts
```

**Result summary:** 18 tests pass across all specified categories: simple agent blocks, double-quoted strings, triple-quoted strings with indent-stripping, numbers, identifier/boolean tokens, comment skipping, arrays, nested braces, newline collapsing, line/column tracking, trailing commas, EOF emission, and two error modes with multi-error collection.

```
bun test v1.3.13 (bf2e2cec)

packages/core/src/__tests__/lexer.test.ts:
(pass) Lexer — valid tokenization > tokenizes a simple agent block [0.63ms]
(pass) Lexer — valid tokenization > tokenizes double-quoted strings [0.07ms]
(pass) Lexer — valid tokenization > tokenizes triple-quoted strings and strips indentation [0.33ms]
(pass) Lexer — valid tokenization > tokenizes integer numbers
(pass) Lexer — valid tokenization > tokenizes float numbers [0.02ms]
(pass) Lexer — valid tokenization > tokenizes zero [0.02ms]
(pass) Lexer — valid tokenization > tokenizes boolean identifiers as Identifier tokens [0.06ms]
(pass) Lexer — valid tokenization > skips line comments and tokenizes the next line [0.05ms]
(pass) Lexer — valid tokenization > tokenizes an array [0.03ms]
(pass) Lexer — valid tokenization > tokenizes nested braces [0.02ms]
(pass) Lexer — valid tokenization > collapses multiple blank lines into a single Newline token [0.01ms]
(pass) Lexer — valid tokenization > records correct line and column for tokens [0.03ms]
(pass) Lexer — valid tokenization > handles trailing commas in arrays naturally [0.01ms]
(pass) Lexer — valid tokenization > emits EOF as last token
(pass) Lexer — errors > reports UnterminatedString for unclosed double-quoted string [0.05ms]
(pass) Lexer — errors > reports UnexpectedCharacter for @ [0.02ms]
(pass) Lexer — errors > collects multiple errors — does not stop at first [0.04ms]
(pass) Lexer — errors > reports correct line for error on second line

 18 pass
 0 fail
 71 expect() calls
Ran 18 tests across 1 file. [18.00ms]
```

---

## Artifact: Workspace Typecheck — Zero Errors

**What it proves:** `tokens.ts` and `lexer.ts` export types that are compatible with the rest of `@weave/core` and downstream engine packages.
**Why it matters:** The `Token` and `SourcePos` types are re-exported from `ast.ts` and used throughout the parser; a type mismatch here would cascade across the entire pipeline.

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

Task 2.0 is complete. `tokens.ts` and `lexer.ts` are implemented to spec. The `tokenize()` function correctly transforms all valid `.weave` syntax into typed `Token[]` results and collects all lex errors without early exit. The `bunfig.toml` misconfig and parser infinite-loop bug found during testing are both fixed. The workspace is clean and all 18 lexer tests pass.
