# Task 04 Proofs — End-to-End Pipeline Tests with Full Workflow DSL

## Task Summary

Five new end-to-end tests were added to `packages/core/src/__tests__/parse_config.test.ts`. They exercise the full `parseConfig()` pipeline — lex → parse → validate — with the `secure-feature` and `quick-fix` workflow examples from `AGENTS.md`, plus negative tests for invalid step type and malformed completion, plus a mixed-content test (agents + categories + workflow in the same source).

## What This Task Proves

- The `secure-feature` workflow (4 steps, all completion forms, inputs/outputs, on_reject) produces a fully typed `WeaveConfig.workflows["secure-feature"]` with correct field values.
- The `quick-fix` workflow (2 steps) round-trips correctly including `agent_signal` and `review_verdict` completions.
- An invalid `type` value returns `err` with a `ValidationError`.
- A malformed completion block (`completion { plan_name "x" }` without a method identifier) returns `err` with a `ValidationError` because the discriminated union cannot match.
- Workflows coexist correctly with agents and categories in the same source file.
- All 16 `parse_config` tests pass (11 original + 5 new).

## Evidence Summary

5 new tests in `describe("parseConfig — workflows")`. All pass. The `secure-feature` test is the most comprehensive, asserting all four steps, their types, agents, prompts, completion methods, inputs, outputs, and on_reject.

## Artifact: parse_config E2E test run

**What it proves:** The complete `parseConfig()` pipeline handles real-world workflow DSL from AGENTS.md.
**Command:**
```bash
bun test packages/core/src/__tests__/parse_config.test.ts
```
**Result summary:** 16 pass, 0 fail.
```
(pass) parseConfig — workflows > secure-feature workflow (4 steps) parses end-to-end with correct typed shape [0.29ms]
(pass) parseConfig — workflows > quick-fix workflow (2 steps) parses end-to-end correctly [0.14ms]
(pass) parseConfig — workflows > invalid step type returns err with ValidationError [0.13ms]
(pass) parseConfig — workflows > malformed completion block (no method identifier) returns err with ValidationError [0.15ms]
(pass) parseConfig — workflows > workflow mixed with agents and categories parses correctly [0.21ms]

 16 pass
 0 fail
 83 expect() calls
Ran 16 tests across 1 file.
```

## Artifact: Full package test run

**What it proves:** No regressions across the entire `@weave/core` package (all 6 test files).
**Command:**
```bash
bun test packages/core/
```
**Result summary:** 122 pass, 0 fail (80 original + 42 new).
```
 122 pass
 0 fail
 358 expect() calls
Ran 122 tests across 6 files.
```

## Reviewer Conclusion

The full `parseConfig()` pipeline correctly handles all workflow DSL examples from the spec and AGENTS.md. Both happy-path and negative-path E2E tests pass. No regressions.
