# Issue #21 Task 12 Proof Artifact — SQLite Runtime Store lease release vs. SessionSnapshot retention

- Spec: [`12-spec-runtime-persistence.md`](../specs/12-spec-runtime-persistence/12-spec-runtime-persistence.md) (Unit 2, Unit 3)
- Related: [`33-spec-pi-adapter.md`](../specs/33-spec-pi-adapter/33-spec-pi-adapter.md) (`LifecycleProjectionFailed` in the `PiAdapterFailureCode` closed set — unchanged; this fix removes a false trigger of that generic mapping, it does not change the mapping itself)
- Issue: weave-io/weave#21, Task 12
- Note: a prior, unrelated Task 12 pass ("Complete the acceptance manifest") already has proofs at
  [`33-proofs/33-task-12-proofs.md`](../specs/33-spec-pi-adapter/33-proofs/33-task-12-proofs.md).
  Task numbering in issue #21 has been reused across passes; this artifact covers a distinct,
  later fix and is filed under `docs/artifacts/` per
  [Documentation Policy](../documentation-policy.md) to avoid overwriting that unrelated history.

## Summary

Final6 `/weave:run smoke-flow` reached a genuinely `completed` `WorkflowInstance`, but Pi
surfaced `LifecycleProjectionFailed` and the `ExecutionLease` was never released.

**Root cause:** `session_snapshots.lease_id` was `NOT NULL` with an implicit
`ON DELETE NO ACTION` foreign key to `execution_leases(id)`. Engine's `completeStep`
correctly committed the terminal `WorkflowInstance` update to `completed` and then called
`store.leases.release(...)`. With foreign key enforcement on (`PRAGMA foreign_keys=ON`, set at
connection-open time), deleting the lease row while a `SessionSnapshot` recorded during
execution still referenced it violated the foreign key, and `bun:sqlite` raised
`FOREIGN KEY constraint failed`. That generic SQLite error had no `lease_conflict` or
`policy_decision` discriminant, so
`packages/adapters/pi/src/workflow-controller.ts`'s `mapCompletionError` fell through to the
generic `LifecycleProjectionFailed` failure — even though the instance's `completed` status had
already committed. The lease itself was left behind, un-released, holding the execution lock
open indefinitely.

**Fix:** `session_snapshots.lease_id` is now nullable, and its foreign key uses
`ON DELETE SET NULL` instead of the implicit `NO ACTION`. Releasing a lease severs the
`leaseId` link on any `SessionSnapshot` that observed it; the snapshot row and the rest of its
historical observation survive. Since SQLite cannot alter a column's nullability or a foreign
key's `ON DELETE` action in place, this required a genuine table-recreate migration
(`v5`, `session_snapshots_lease_set_null`): create a replacement table with the corrected
column/constraint, copy every row, drop the old table, rename the replacement, and recreate both
original indexes — with `PRAGMA foreign_keys` disabled for the whole pending-migration
transaction (only when a pending migration requires it) and verified clean via
`PRAGMA foreign_key_check` before commit, restored immediately after the transaction settles
either way (success or rollback).

## Root-cause chain (exact call path)

1. `packages/engine/src/execution-lifecycle/completion.ts` `completeStep()` — final-step
   auto-advance branch: updates the `WorkflowInstance` to `completed` (commits), then calls
   `store.leases.release(activeLease.id, activeLease.ownerId)`.
2. `packages/engine/src/runtime/sqlite/store.ts` `SqliteExecutionLeaseRepository.release()` —
   issues `DELETE FROM execution_leases WHERE id = ?`. Pre-fix: `bun:sqlite` raises
   `FOREIGN KEY constraint failed` because a `session_snapshots` row references the lease and
   the FK has no `ON DELETE` action.
3. That thrown error is caught by `ResultAsync.fromPromise`'s error mapper and returned as a
   generic `queryError("Failed to release ExecutionLease", cause)` — a `RuntimeStoreError` with
   `type: "query"`, not a domain-specific discriminant.
4. `packages/engine/src/execution-lifecycle/lease.ts` `mapStoreError()` wraps that into a
   `LifecyclePersistenceError`, preserving only `{ type: "query", message }` — never the raw SQL
   text (Spec 33 §19/§23 sanitization boundary; unaffected by this fix).
5. `packages/adapters/pi/src/workflow-controller.ts` `mapCompletionError()` — for `completeStep`
   failures, only `lease_conflict` and `policy_decision` cause types get a specific mapping
   (`LeaseLost`, `CompletionRejected`); everything else, including this generic persistence
   error, falls through to `makeLifecycleProjectionFailedFailure(...)`. This is the exact origin
   of the reported `LifecycleProjectionFailed`.

## Fix — files changed

| File | Change |
| --- | --- |
| `packages/engine/src/runtime/sqlite/migrations.ts` | `CURRENT_SCHEMA_VERSION` 4 → 5. New `Migration.foreignKeysOff?: boolean` field. New migration v5 (`session_snapshots_lease_set_null`): recreates `session_snapshots` with nullable `lease_id` and `FOREIGN KEY (lease_id) REFERENCES execution_leases (id) ON DELETE SET NULL`, copies rows, drops/renames, recreates both indexes. New `disableForeignKeys`/`enableForeignKeys`/`verifyNoForeignKeyViolations` helpers; `runMigrations` toggles FK enforcement off only around the pending-migration transaction when a pending migration requires it, runs `PRAGMA foreign_key_check` inline for v5, and restores FK enforcement after commit or rollback. |
| `packages/engine/src/runtime/sqlite/schema.ts` | `SessionSnapshotRow.lease_id: string \| null` (was `string`). |
| `packages/engine/src/runtime/sqlite/store.ts` | `rowToSessionSnapshot` maps `lease_id === null` to an omitted `leaseId` field (matches the existing optional-field spread convention). |
| `packages/engine/src/runtime/types.ts` | `SessionSnapshot.leaseId?: ExecutionLeaseId` (was required). `RecordSessionSnapshotInput.leaseId` is unchanged/required — recording always happens against an active lease. |
| `packages/engine/src/runtime/store.ts` | `ExecutionLeaseRepository.release()` JSDoc documents the sever-not-delete retention contract. |
| `packages/engine/src/runtime/memory-store.ts` | `InMemoryExecutionLeaseRepository` takes an `onRelease` callback; `InMemorySessionSnapshotRepository.severLeaseReferences(leaseId)` clears matching `leaseId` fields. Wired together in `InMemoryRuntimeStore`'s constructor for behavioral parity with the SQLite store. |
| `packages/engine/src/__tests__/runtime-sqlite.test.ts` | Two new regression tests (see below); existing hardcoded `CURRENT_SCHEMA_VERSION`/`toBe(4)`/migration-ledger-array assertions bumped to 5 across the `migrations` describe block. |
| `packages/engine/src/__tests__/runtime-permissions.test.ts` | One hardcoded `expect(CURRENT_SCHEMA_VERSION).toBe(4)` bumped to 5. |
| `docs/specs/12-spec-runtime-persistence/12-spec-runtime-persistence.md` | Normative spec updated: `SessionSnapshot.leaseId` retention semantics, migration v5 description, and proof-artifact bullet. |

## Red → green proof

Two new regression tests were added and proven to fail against the pre-fix source (confirmed by
`git stash`-isolating the six source-file changes above while keeping the new tests, then
restoring the fix):

```
$ bun test packages/engine/src/__tests__/runtime-sqlite.test.ts -t \
    "release succeeds and severs|upgrades a genuine version-two database and lets"
...
error: expect(received).toBe(expected)
Expected: true
Received: false
      at .../runtime-sqlite.test.ts:732 ("upgrades a genuine version-two database and lets...")
(fail) migrations > upgrades a genuine version-two database and lets a pre-existing SessionSnapshot's lease be released
error: expect(received).toBe(expected)
Expected: true
Received: false
      at .../runtime-sqlite.test.ts:3006 ("release succeeds and severs...")
(fail) ExecutionLease CRUD and conflicts > release succeeds and severs the leaseId link on SessionSnapshots that observed it

 0 pass
 121 filtered out
 2 fail
```

1. **`ExecutionLease CRUD and conflicts > release succeeds and severs the leaseId link on
   SessionSnapshots that observed it`** — fresh v5 schema: acquires a lease, records a
   `SessionSnapshot` referencing it, releases the lease (asserts `isOk()`), then re-fetches the
   snapshot and asserts `leaseId` is now `undefined` while `harnessName`/`stepName`/`metadata`
   are untouched.
2. **`migrations > upgrades a genuine version-two database and lets a pre-existing
   SessionSnapshot's lease be released`** — proves migration safety from real pre-existing data,
   not just a fresh v5 database: builds a genuine v2-shaped database (`createLegacyV2Database`),
   inserts a real `execution_leases` row and a `session_snapshots` row referencing it under the
   *old* schema (`lease_id NOT NULL`, implicit `ON DELETE NO ACTION`), opens the store (triggers
   the v2→v5 migration path in place), asserts the snapshot survives with its original
   `leaseId`, releases the lease, asserts the release succeeds and the snapshot's `leaseId` is
   now `undefined` (and the raw `lease_id` column is `NULL` on reopen), with `readSchemaVersion`
   landing on `5`.

## Test run (green, post-fix)

```
$ bun test packages/engine/src/__tests__/runtime-sqlite.test.ts
 123 pass, 0 fail, 889 expect() calls (2 new tests)

$ bun test packages/engine/src/__tests__/runtime-sqlite.test.ts \
    packages/engine/src/__tests__/runtime-memory.test.ts \
    packages/engine/src/__tests__/runtime-contract.test.ts \
    packages/engine/src/__tests__/execution-lifecycle.test.ts \
    packages/engine/src/__tests__/execution-lifecycle-integration.test.ts
 675 pass, 0 fail, 2710 expect() calls

$ bun test packages/engine/src/__tests__/execution-lifecycle/ \
    packages/engine/src/__tests__/status-control.test.ts \
    packages/engine/src/__tests__/runtime-command-operations.test.ts \
    packages/engine/src/__tests__/start-plan.test.ts \
    packages/engine/src/__tests__/public-api.test.ts
 250 pass, 0 fail, 819 expect() calls

$ bun test packages/adapters/pi/src/__tests__/
 656 pass, 0 fail, 1818 expect() calls

$ bun test packages/engine/src/__tests__/runtime-permissions.test.ts \
    packages/engine/src/__tests__/runtime-sqlite.test.ts
 164 pass, 0 fail, 1675 expect() calls

$ bun test   # full workspace
 6389 pass, 11 skip, 3 fail, 19605 expect() calls
```

The 3 full-workspace failures are pre-existing and unrelated: `scripts/release/__tests__/acceptance-manifest.test.ts`
and `scripts/release/__tests__/generate-acceptance-manifest.test.ts` (both reference the
untracked, unregenerated `docs/specs/33-spec-pi-adapter/acceptance-manifest.json`, out of scope
for this fix and explicitly not touched here). Confirmed pre-existing by running the same two
files with this change's source/test edits stashed — they failed identically beforehand.

```
$ bun run typecheck   # exit 0, all packages
$ bun run build       # exit 0, all packages
```

## Scope discipline

This change touches only the Runtime Store schema/migration/type/test files listed above plus
`docs/specs/12-spec-runtime-persistence/12-spec-runtime-persistence.md` and this artifact. It
does not modify `docs/config-loading.md`, `docs/system-architecture.md`, `.pi/`, the untracked
`docs/specs/33-spec-pi-adapter/acceptance-manifest.json`, or any scratch smoke files under
`/tmp/weave-pi-smoke/`.
