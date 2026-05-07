# Task 01 Proofs — Parser Enhancement: Named Block Value Pattern

## Task Summary

`#parseValue()` in `packages/core/src/parser.ts` was enhanced to handle the `identifier { block }` pattern. When the parser sees an identifier immediately followed by `{`, it parses the block and prepends a synthetic `__name` property (holding the identifier as an `IdentifierValue`) to the resulting `BlockValue`. This is a general-purpose enhancement required for `completion plan_created { plan_name "..." }` syntax.

## What This Task Proves

- The parser correctly recognises `completion plan_created { plan_name "..." }` and produces a `BlockValue` with `__name: "plan_created"` as the first property.
- A bare `completion user_confirm` (no block following the identifier) still produces an `IdentifierValue` — the enhancement is backward-compatible.
- The pattern works for any property key, not just `completion` (general purpose).
- All 18 parser tests pass (15 original + 3 new).
- `bun run typecheck` passes with zero errors.

## Evidence Summary

Three new tests were added to `packages/core/src/__tests__/parser.test.ts` under `describe("Parser — named block value")`. All pass. No regressions.

## Artifact: Parser test run

**What it proves:** All parser tests — including the three new named block value tests — pass.
**Why it matters:** Confirms the enhancement works correctly and did not regress existing behaviour.
**Command:**

```bash
bun test packages/core/src/__tests__/parser.test.ts
```

**Result summary:** 18 pass, 0 fail.

```
(pass) Parser — named block value > completion plan_created { plan_name '...' } produces a BlockValue with __name [0.13ms]
(pass) Parser — named block value > completion user_confirm (no block) still produces an IdentifierValue [0.05ms]
(pass) Parser — named block value > named block value pattern works for non-completion properties too (general purpose) [0.08ms]

 18 pass
 0 fail
 76 expect() calls
Ran 18 tests across 1 file.
```

## Artifact: Type check

**What it proves:** The parser change introduces no TypeScript type errors.
**Command:**

```bash
bun run typecheck
```

**Result summary:** Zero errors across all packages.

```
@weave/core typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
```

## Reviewer Conclusion

The named block value parser enhancement is complete, backward-compatible, and type-safe. The three new tests cover all required cases. No existing tests were broken.
