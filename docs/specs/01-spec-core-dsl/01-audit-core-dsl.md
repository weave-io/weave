# 01-audit-core-dsl

## Executive Summary

- Overall Status: **PASS**
- Required Gate Failures: 0
- Flagged Risks: 2

## Gateboard

| Gate                             | Status | Detail                                                                                                     | Exact fix target |
| -------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------- | ---------------- |
| Requirement-to-test traceability | PASS   | All 30 functional requirements map to at least one task + test                                             | —                |
| Proof artifact verifiability     | PASS   | All artifacts are CLI commands or test file references with exact paths                                    | —                |
| Repository standards consistency | PASS   | AGENTS.md and README.md reviewed; neverthrow, Bun, Zod, classes patterns enforced in tasks                 | —                |
| Open question resolution         | PASS   | 3 open questions: trailing commas + trimIndent addressed in tasks; workflow validation explicitly deferred | —                |
| Regression-risk blind spots      | FLAG   | See finding below                                                                                          | —                |
| Non-goal leakage                 | FLAG   | See finding below                                                                                          | —                |

## Standards Evidence Table

| Source File           | Read | Standards Extracted                                                                                                                                                  | Conflicts |
| --------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `AGENTS.md`           | yes  | 1. Custom `.weave` DSL with lexer/parser/AST in `@weave/core` 2. `neverthrow` for all fallible functions 3. Bun-only, classes for org, early returns, no `console.*` | none      |
| `README.md`           | yes  | 1. `bun test --recursive` for tests 2. `tsc --noEmit` for typecheck 3. Workspace packages under `@weave` scope                                                       | none      |
| `package.json` (root) | yes  | 1. Scripts: `build`, `test`, `typecheck`, `clean` 2. `bun-types` for types                                                                                           | none      |

## Findings

### FLAG Findings

1. **Regression-risk: no edge-case stress tests**
   - Risk: Tests cover documented happy paths and explicit error cases but not boundary conditions like empty blocks `agent loom {}`, Unicode in identifiers, extremely long strings, or deeply nested blocks. These could cause panics in the lexer/parser.
   - Suggested remediation: Add 3–4 edge-case tests per test file during implementation (empty block, Unicode identifier, nested block depth ≥ 3). Low priority — can be added after core tests pass.

2. **Non-goal leakage: workflow structural parsing**
   - Risk: Task 3.2 implements `parseWorkflowBlock()` with `step` sub-blocks. The spec explicitly states "Workflow blocks are structurally parsed but not validated by Zod schemas in this spec." This is within bounds but is the closest thing to scope creep — the parser is doing real work for workflows without corresponding validation.
   - Suggested remediation: No action needed. Structural parsing is explicitly allowed by the spec. Validation is cleanly deferred. The parser would need to handle unknown block types anyway; treating `workflow` as a known keyword is better than failing on it.

## User-Approved Remediation Plan

- No REQUIRED failures. No remediation needed.

## Re-Audit Delta

- First run. No delta.
