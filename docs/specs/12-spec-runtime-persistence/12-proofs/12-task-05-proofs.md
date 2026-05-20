# Task 5 Proof Artifact — In-Memory Runtime Store Test Utility

## Task Summary

Task 5 implements `createInMemoryRuntimeStore()` in
`packages/engine/src/runtime/memory-store.ts` — a pure in-memory implementation
of the `RuntimeStore` interface for use in unit and integration tests.

**What it proves:**

1. `createInMemoryRuntimeStore()` satisfies the full `RuntimeStore` interface
   using `Map<string, T>` collections — no filesystem, no harness, no adapter
   discovery.
2. All repository semantics match the SQLite store: `find*` returns `null` for
   missing records; `get*` returns a `not_found` error; lease acquisition is
   atomic with conflict detection; transactions snapshot-and-rollback on `Err`.
3. Configurable failure injection (`failOn` / `setFailures`) covers all
   operation paths: `workflowCreate`, `workflowUpdate`, `workflowAddArtifact`,
   `leaseAcquire`, `leaseHeartbeat`, `leaseRelease`, `snapshotRecord`,
   `journalAppend`, `transaction`, `close`.
4. `createInMemoryRuntimeStore` and `InMemoryRuntimeStore` are exported from
   the public `@weave/engine` barrel — downstream tests import from
   `@weave/engine`, not from private engine files.
5. The existing 58-test contract suite (`runtime-contract.test.ts`) continues
   to pass unchanged.

---

## Evidence: Test Run

```
bun test packages/engine/src/__tests__/runtime-memory.test.ts \
         packages/engine/src/__tests__/runtime-contract.test.ts

bun test v1.3.13 (bf2e2cec)

 120 pass
 0 fail
 326 expect() calls
Ran 120 tests across 2 files. [55.00ms]
```

- `runtime-memory.test.ts`: 62 tests covering CRUD, lease lifecycle, snapshot
  queries, journal queries, transaction commit/rollback, failure injection,
  custom clock, and no-filesystem guarantee.
- `runtime-contract.test.ts`: 58 tests (unchanged) covering type shapes,
  branded IDs, error discriminants, find/get semantics, lease conflict
  semantics, SessionSnapshot field boundaries, journal append/query, and
  transaction API shape.

---

## Evidence: Typecheck

```
bun run --filter '@weave/engine' typecheck

@weave/engine typecheck: Exited with code 0
```

TypeScript reports zero errors. The `TransactionCallback` constraint
(`ResultAsync`, not `Promise<Result>`) is enforced at compile time.

---

## Evidence: Public Export

The following import statement typechecks without importing private engine
files:

```ts
import {
  createInMemoryRuntimeStore,
  InMemoryRuntimeStore,
  type InMemoryRuntimeStoreOptions,
  type InMemoryRuntimeStoreFailureConfig,
  type RuntimeStore,
} from "@weave/engine";

// Typecheck proof: return type is assignable to RuntimeStore
function proof(): RuntimeStore {
  return createInMemoryRuntimeStore();
}
```

This pattern is exercised in `runtime-memory.test.ts` lines 37–40.

---

## Evidence: Full Suite Pass

```
bun test

bun test v1.3.13 (bf2e2cec)

 1269 pass
 0 fail
 3342 expect() calls
Ran 1269 tests across 39 files. [583.00ms]
```

No regressions across the full workspace.

---

## Files Changed

| File | Change |
|------|--------|
| `packages/engine/src/runtime/memory-store.ts` | New — in-memory `RuntimeStore` implementation with failure injection |
| `packages/engine/src/index.ts` | Added exports for `createInMemoryRuntimeStore`, `InMemoryRuntimeStore`, `InMemoryRuntimeStoreOptions`, `InMemoryRuntimeStoreFailureConfig` |
| `packages/engine/src/__tests__/runtime-memory.test.ts` | New — 62 contract tests importing from `@weave/engine` public barrel |
| `docs/specs/12-spec-runtime-persistence/12-proofs/12-task-05-proofs.md` | This file |
| `docs/specs/12-spec-runtime-persistence/12-tasks-runtime-persistence.md` | Tasks 5.0–5.7 marked `[x]` |
