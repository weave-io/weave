# Task 02 Proofs - Session observation and execution start/resume

## Task Summary

This task proves that `observeSession`, `startExecution`, and `resumeExecution` are implemented as `ResultAsync`-returning functions that use the Runtime Store for all persistence. All three functions operate without a real harness, using `createInMemoryRuntimeStore()` in tests.

## What This Task Proves

- `observeSession` stores a sanitized `SessionSnapshot` and returns the snapshot ID; secret-like metadata keys are rejected by the sanitizer.
- `startExecution` creates or updates a `WorkflowInstance` to `running` status and acquires an `ExecutionLease` using one clock source.
- `resumeExecution` rebinds to an available or expired execution and returns a typed `LifecycleLeaseConflictError` for unexpired foreign leases.
- All three functions return `ResultAsync<T, LifecycleError>` — errors are never thrown.
- 23 new tests pass alongside 778 pre-existing tests (801 total).

## Evidence Summary

- Typecheck exits 0 — implementations compile correctly.
- 801/801 tests pass — 23 new lifecycle runtime tests included.
- Tests use `createInMemoryRuntimeStore()` — no real harness, no filesystem.

## Artifact: Typecheck pass

**What it proves:** All three lifecycle function implementations compile with correct types.

**Why it matters:** Confirms `ResultAsync` return types, `RuntimeStore` parameter types, and error mapping are all type-safe.

**Command:**
```bash
bun run --filter '@weaveio/weave-engine' typecheck
```

**Result summary:** Exit code 0.

```
@weaveio/weave-engine typecheck: Exited with code 0
```

## Artifact: Test suite pass

**What it proves:** 23 new runtime tests cover all acceptance criteria for session observation, execution start, and execution resume.

**Why it matters:** Confirms behavior is correct at runtime, not just at compile time.

**Command:**
```bash
bun run --filter '@weaveio/weave-engine' test
```

**Result summary:** 801 pass, 0 fail across 18 files.

```
 801 pass
 0 fail
 Ran 801 tests across 18 files. [615.00ms]
```

## Artifact: Test coverage breakdown

**What it proves:** Each acceptance criterion has a corresponding test.

**Why it matters:** Provides a reviewer-readable map from requirements to evidence.

| Test group | Tests | Key behaviors covered |
|---|---|---|
| `observeSession (Runtime Store)` | 7 | Stores snapshot, rejects `password`/`token` keys, validation errors, empty metadata, persistence failure |
| `startExecution (Runtime Store)` | 8 | Creates instance + lease, returns leaseId, clock source verification, updates existing instance, validation errors, persistence failure |
| `resumeExecution (Runtime Store)` | 8 | Rebinds with no active lease, rebinds with expired lease, `lease_conflict` for unexpired foreign lease, `not_found` for missing instance, validation errors |

## Artifact: Functions implemented

**What it proves:** The implementation scope matches the task requirements.

| Function | Return type | Error mapping |
|---|---|---|
| `observeSession(input, store)` | `ResultAsync<ObserveSessionOutput, LifecycleError>` | `RuntimeStoreError` → `LifecyclePersistenceError` |
| `startExecution(input, store)` | `ResultAsync<StartExecutionOutput, LifecycleError>` | `conflict` → `LifecycleLeaseConflictError`; others → `LifecyclePersistenceError` |
| `resumeExecution(input, store)` | `ResultAsync<ResumeExecutionOutput, LifecycleError>` | `conflict` → `LifecycleLeaseConflictError`; `not_found` → `LifecycleNotFoundError` |

## Reviewer Conclusion

All three lifecycle functions are implemented, typed, and tested. The Runtime Store is the sole persistence mechanism. No real harness is started. Lease conflict detection returns typed errors, not exceptions. 801/801 tests pass.
