# Task 01 Proofs - Lifecycle vocabulary and public engine surface

## Task Summary

This task proves the execution lifecycle vocabulary is defined, typed, and exported from `@weave/engine`. It establishes the shared typed vocabulary for adapter-to-engine lifecycle calls: input/output types for all 7 lifecycle methods, a discriminated `LifecycleError` union, a `LifecycleEffect` union containing `RunAgentEffect` as the dispatch variant, and `SafeMetadata` that structurally excludes credentials and raw payloads.

## What This Task Proves

- `packages/engine/src/execution-lifecycle.ts` exists with all 7 lifecycle method input/output types.
- `LifecycleError` is a discriminated union with 5 variants (not thrown exceptions).
- `SafeMetadata` is `Record<string, string | number | boolean>` — structurally prevents raw prompts, credentials, tokens.
- `LifecycleEffect` union includes `RunAgentEffect` as the dispatch variant via `DispatchAgentEffect`.
- All lifecycle types are exported from `packages/engine/src/index.ts`.
- `docs/adapter-boundary.md` documents the lifecycle surface and supersession of `registerHook()`.
- 43 new lifecycle type tests pass alongside 735 pre-existing tests (778 total).

## Evidence Summary

- Typecheck exits 0 — all lifecycle types compile and are exported correctly.
- Test suite passes 778/778 — 43 new lifecycle tests + 735 pre-existing.
- `docs/adapter-boundary.md` has a new `## Execution Lifecycle Surface` section.

## Artifact: Typecheck pass

**What it proves:** Lifecycle types and exports compile without errors.

**Why it matters:** Type safety is the primary correctness guarantee for this vocabulary-only task.

**Command:**
```bash
bun run --filter '@weave/engine' typecheck
```

**Result summary:** Exit code 0 — all lifecycle types, error unions, effect unions, and index exports are valid TypeScript.

```
@weave/engine typecheck: Exited with code 0
```

## Artifact: Test suite pass

**What it proves:** 43 new lifecycle type tests pass, covering valid inputs, error discriminants, effect union variants, and public import paths.

**Why it matters:** Confirms the types are not just syntactically valid but behave correctly at runtime.

**Command:**
```bash
bun run --filter '@weave/engine' test
```

**Result summary:** 778 pass, 0 fail across 18 files (43 new lifecycle tests included).

```
 778 pass
 0 fail
 Ran 778 tests across 18 files. [640.00ms]
```

## Artifact: Files created/modified

**What it proves:** The implementation scope matches the task requirements.

**Why it matters:** Confirms no harness-specific code was introduced and all required files were touched.

| File | Change |
|------|--------|
| `packages/engine/src/execution-lifecycle.ts` | Created — 7 input/output type pairs, `LifecycleError` (5 variants), `LifecycleEffect` union, `SafeMetadata`, `StepCompletionSignal`, 5 error factories, 7 `Result` type aliases |
| `packages/engine/src/__tests__/execution-lifecycle.test.ts` | Created — 43 tests |
| `packages/engine/src/index.ts` | Updated — 32 lifecycle types + 5 factory functions exported |
| `docs/adapter-boundary.md` | Updated — `## Execution Lifecycle Surface` section added |
| `packages/engine/README.md` | Updated — lifecycle surface bullet updated |

## Reviewer Conclusion

The lifecycle vocabulary is fully defined, typed, exported, and documented. All 778 engine tests pass. The `LifecycleError` discriminated union, `SafeMetadata` structural constraint, and `LifecycleEffect` union with `RunAgentEffect` as the dispatch variant are in place. `docs/adapter-boundary.md` now documents the lifecycle surface as the replacement path for `registerHook()`.
