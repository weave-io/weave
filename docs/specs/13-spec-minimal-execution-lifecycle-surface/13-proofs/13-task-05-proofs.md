# Task 05 Proofs - Adapter integration and transitional runner reframe

## Task Summary

This task proves that the adapter boundary is correctly documented, `registerHook()` is explicitly superseded, and a mock adapter can drive the full lifecycle flow end-to-end without a real harness. Integration tests confirm `init()` is called exactly once and no lifecycle functions are called during `WeaveRunner.run()` initialization.

## What This Task Proves

- `adapter.ts` `registerHook()` JSDoc explicitly names all 7 lifecycle functions as the superseding surface.
- `runner.ts` TODO comment references the execution lifecycle surface by name.
- `packages/engine/README.md` has a new "Execution Lifecycle Surface" section distinguishing adapter-owned event mapping from engine-owned lifecycle decisions.
- A mock adapter can drive `observeSession → startExecution → dispatchStep → completeStep` end-to-end using `createInMemoryRuntimeStore()` with no harness process.
- `init()` is called exactly once during `WeaveRunner.run()` and no lifecycle functions are called during init.
- 10 new integration tests pass alongside 837 pre-existing tests (847 total).

## Evidence Summary

- Typecheck exits 0 — all changes compile correctly.
- 847/847 tests pass — 10 new integration tests in `execution-lifecycle-integration.test.ts`.
- End-to-end lifecycle flow verified without any real harness.

## Artifact: Typecheck pass

**Command:**
```bash
bun run --filter '@weave/engine' typecheck
```

**Result summary:** Exit code 0.

```
@weave/engine typecheck: Exited with code 0
```

## Artifact: Test suite pass

**What it proves:** 10 new integration tests cover end-to-end lifecycle flow and init boundary.

**Command:**
```bash
bun run --filter '@weave/engine' test
```

**Result summary:** 847 pass, 0 fail across 19 files.

```
 847 pass
 0 fail
 Ran 847 tests across 19 files. [630.00ms]
```

## Artifact: Integration test coverage

| Test group | Tests | Key behaviors covered |
|---|---|---|
| `lifecycle integration — mock adapter drives end-to-end flow` | 4 | `observeSession→startExecution→dispatchStep→completeStep` without harness, `DispatchAgentEffect` wraps `RunAgentEffect`, no harness-specific names in effects |
| `WeaveRunner.run() — init boundary and lifecycle isolation` | 6 | `init()` called exactly once, no lifecycle functions called during `WeaveRunner.run()`, `registerHook()` never called, `loadSkill()` never called, call ordering |

## Artifact: Documentation updates

**What it proves:** The adapter/engine boundary is clearly documented for future adapter authors.

| File | Change |
|---|---|
| `packages/engine/src/adapter.ts` | `registerHook()` JSDoc updated: explicitly superseded by execution lifecycle surface, all 7 functions named |
| `packages/engine/src/runner.ts` | TODO comment updated to reference execution lifecycle surface |
| `packages/engine/README.md` | New "Execution Lifecycle Surface" section with ownership table and code example |

## Reviewer Conclusion

The adapter integration boundary is correctly documented and tested. A mock adapter can drive the full lifecycle flow end-to-end without a real harness. `registerHook()` is explicitly superseded. 847/847 tests pass.
