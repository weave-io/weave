# Task 03 Proofs — Parser + AST: Token Stream to Typed AST

## Task Summary

Task 3.0 implements `ast.ts` (all AST node type definitions) and `parser.ts` (the `Parser` class and standalone `parse()` function). The parser consumes the `Token[]` produced by the lexer and builds an `AstNode[]` that the validator walks. It is a recursive-descent parser with error accumulation and recovery — it does not stop at the first bad construct.

A critical bug fix is included in this task: the outer `Parser.parse()` loop had an infinite loop condition when a stray `}` token remained after error recovery. The fix adds a safety advance when `#parseTopLevel()` makes no cursor progress and the stream is not at EOF.

## What This Task Proves

- `ast.ts` defines all six `AstValue` kinds (`StringValue`, `NumberValue`, `BooleanValue`, `IdentifierValue`, `ArrayValue`, `BlockValue`), `Property`, `StepBlock`, and the five `AstNode` variants (`AgentBlock`, `CategoryBlock`, `WorkflowBlock`, `DisableDirective`, `SettingAssignment`).
- The `Parser` correctly builds `AgentBlock` nodes with nested `tool_policy` blocks and `triggers` arrays.
- `CategoryBlock`, `DisableDirective`, `SettingAssignment`, and `WorkflowBlock` (with `StepBlock` children) are all parsed correctly.
- Multiple top-level blocks in one source produce a complete `AstNode[]`.
- `UnclosedBlock` and `MissingBlockName` errors are reported with correct positions.
- Error recovery allows a valid second block to be parsed after a first-block error.
- The standalone `parse()` function delegates to `new Parser(tokens).parse()`.
- All 15 parser tests pass; workspace typechecks clean.

## Evidence Summary

Two artifacts: parser test suite output (15/15 pass) and workspace typecheck confirmation.

---

## Artifact: Parser Test Suite — 15/15 Pass

**What it proves:** All block types, nested structures, error cases, and error recovery scenarios specified in task 3.4 are covered and passing.
**Why it matters:** The parser is the structural backbone of the pipeline. Incorrect AST construction would corrupt the config objects produced by the validator.

**Command:**
```bash
bun test packages/core/src/__tests__/parser.test.ts
```

**Result summary:** 15 tests pass across agent blocks (minimal and with nested structures), category blocks, all three disable targets, top-level settings (bare identifier, boolean, nested block), workflow blocks with steps, multi-block sources, and two error variants with recovery.

```
bun test v1.3.13 (bf2e2cec)

packages/core/src/__tests__/parser.test.ts:
(pass) Parser — agent block > parses a minimal agent block [0.43ms]
(pass) Parser — agent block > parses agent with nested tool_policy block [0.23ms]
(pass) Parser — agent block > parses agent with triggers array of block objects [0.12ms]
(pass) Parser — category block > parses a category with patterns array [0.05ms]
(pass) Parser — disable directive > parses disable agents [0.12ms]
(pass) Parser — disable directive > parses disable hooks
(pass) Parser — disable directive > parses disable skills
(pass) Parser — setting assignment > parses a top-level bare-identifier setting [0.07ms]
(pass) Parser — setting assignment > parses a top-level boolean setting
(pass) Parser — setting assignment > parses a nested setting block (continuation.recovery.compaction) [0.05ms]
(pass) Parser — workflow block > parses a workflow with steps [0.30ms]
(pass) Parser — multiple top-level blocks > parses multiple blocks in one source [0.11ms]
(pass) Parser — errors > reports UnclosedBlock for missing closing brace [0.15ms]
(pass) Parser — errors > reports MissingBlockName for agent without name [0.04ms]
(pass) Parser — errors > error recovery: second block parses correctly after first block error [0.05ms]

 15 pass
 0 fail
 64 expect() calls
Ran 15 tests across 1 file. [18.00ms]
```

---

## Artifact: Workspace Typecheck — Zero Errors

**What it proves:** The `AstNode` discriminated union and all value types compile without errors and integrate cleanly with `validate.ts` and the engine packages.
**Why it matters:** The `AstNode[]` type is the contract between the parser and validator; any shape mismatch would surface here before reaching runtime.

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

Task 3.0 is complete. `ast.ts` defines the full discriminated-union AST. `parser.ts` correctly implements the recursive-descent parser for all `.weave` block types with error accumulation and recovery. The infinite-loop bug in the outer `parse()` loop is fixed. All 15 parser tests pass and the workspace typechecks cleanly.
