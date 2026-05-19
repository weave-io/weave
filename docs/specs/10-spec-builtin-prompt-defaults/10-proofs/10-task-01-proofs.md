# Task 01 Proofs — Ship real product-level builtin prompt defaults

## Task Summary

This task proves that all eight builtin agent prompt files have been replaced with substantive, product-level Markdown prompts. The prompts encode each agent's behavioral contract, are free of harness-specific tool names and repo-only policy, and are covered by automated tests that guard against placeholder regression and banned-token leakage.

## What This Task Proves

- All 8 `packages/config/prompts/*.md` files contain real Markdown prompts (not placeholder text).
- Loom's prompt encodes both direct-handling guidance (small/simple/local work) and delegation triggers (complex/multi-step/specialist/review/security work).
- Weft and Warp encode gate-style APPROVE / REJECT / BLOCK verdict output shapes.
- 94 automated assertions guard prompt presence, content quality, and banned-token absence.

## Evidence Summary

- `bun test` on the two builtin prompt test files passes 102 tests with 0 failures.
- Prompt file diffs confirm placeholder text is gone and substantive Markdown is present.
- Banned-token checks (`AGENTS.md`, `bun run`, `neverthrow`, `Zod`, `Task`, `TodoWrite`, `todowrite`) pass for all 8 agents.

## Artifact: Test suite results

**What it proves:** Automated tests confirm all 8 prompts are present, non-empty, non-placeholder, and free of banned tokens.

**Why it matters:** Tests are the regression guard — they prevent placeholder content from shipping again and catch any future banned-token leakage.

**Command:**

```bash
bun test packages/config/src/__tests__/builtin-prompts.test.ts packages/config/src/__tests__/builtins.test.ts
```

**Result summary:** 102 tests pass, 0 fail across 2 files. 94 assertions in `builtin-prompts.test.ts` cover existence, non-empty, no-placeholder, Markdown heading presence, 7 banned tokens per agent, gate-verdict checks for Weft/Warp, and direct-handling + delegation checks for Loom.

```
bun test v1.3.13 (bf2e2cec)

 102 pass
 0 fail
 114 expect() calls
Ran 102 tests across 2 files. [63.00ms]
```

## Artifact: Loom prompt — direct-handling and delegation guidance

**What it proves:** Loom's shipped prompt encodes both direct-handling (small/simple/local work) and delegation triggers (complex/multi-step/specialist/review/security work).

**Why it matters:** Spec requirement 1.4 requires Loom to allow direct work while steering specialist/review/security work toward delegation.

**Artifact path:** `packages/config/prompts/loom.md`

**Result summary:** Loom's prompt opens with its orchestrator role, includes a "When to act directly" section for small/self-contained/local tasks, and a "When to delegate" section for complex/multi-step/specialist/review/security-sensitive work.

```markdown
# Loom — Main Orchestrator

You are **Loom**, the main orchestrator in a multi-agent system. Your role is to understand
the user's intent, handle simple work directly, and coordinate specialist agents for everything else.
```

## Artifact: Weft and Warp gate-style verdict shapes

**What it proves:** Weft and Warp encode structured APPROVE / REJECT / BLOCK verdict output as required by spec requirement 1.1.

**Why it matters:** Gate-style verdicts are the contract that Tapestry and Loom rely on to make pass/fail decisions from reviewer output.

**Artifact path:** `packages/config/prompts/weft.md`, `packages/config/prompts/warp.md`

**Result summary:** Weft encodes APPROVE / REQUEST CHANGES / BLOCK verdicts. Warp encodes APPROVE / ADVISORY / BLOCK verdicts with an explicit fast-exit rule for non-security-relevant changes.

```markdown
# Weft — Code Reviewer
...
## Verdict Format
Return one of:
- **APPROVE** — changes are correct, complete, and meet standards.
- **REQUEST CHANGES** — changes have fixable issues; list each with file and line.
- **BLOCK** — changes have a fundamental problem that requires redesign.
```

```markdown
# Warp — Security Auditor
...
## Verdict Format
Return one of:
- **APPROVE** — no security issues found.
- **ADVISORY** — non-blocking observations worth noting; implementation may proceed.
- **BLOCK** — security issue that must be resolved before merging.
```

## Artifact: Typecheck

**What it proves:** No TypeScript errors were introduced.

**Command:**

```bash
bun run typecheck
```

**Result summary:** All 5 packages exit 0 — clean typecheck.

## Reviewer Conclusion

All 8 builtin prompt files now contain substantive, product-level Markdown prompts. Automated tests (102 passing) guard against placeholder regression and banned-token leakage. Loom, Weft, and Warp meet their specific spec requirements for direct-handling guidance and gate-style verdict output.
