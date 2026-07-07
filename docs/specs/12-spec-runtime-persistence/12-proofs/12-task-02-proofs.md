# Task 2 Proof Artifact — Define Runtime Store Domain Interfaces in Engine

## Summary

Task 2 defines the engine-owned Runtime Store domain interfaces without tying callers to SQLite.
New files introduce branded ID types, domain records (`WorkflowInstance`, `ExecutionLease`,
`SessionSnapshot`, `RuntimeJournalEntry`), a discriminated `RuntimeStoreError` union, focused
repository interfaces, a composed `RuntimeStore`, and a transaction/unit-of-work API.
All public types are exported from `@weaveio/weave-engine` without exposing SQLite internals.

---

## Test Output

```
bun test packages/engine/src/__tests__/runtime-contract.test.ts
```

```
bun test v1.3.13 (bf2e2cec)

 58 pass
 0 fail
 172 expect() calls
Ran 58 tests across 1 file. [66.00ms]
```

### Test coverage added

| Describe block | Tests |
|---|---|
| `WorkflowInstance status` | 3 |
| `JournalSeverity` | 2 |
| `Branded ID types` | 5 |
| `RuntimeStoreError discriminated union` | 10 |
| `find* / get* lookup semantics` | 10 |
| `ExecutionLease acquire / heartbeat / release` | 8 |
| `SessionSnapshot field boundaries` | 3 |
| `RuntimeJournal append / query` | 5 |
| `RuntimeStore transaction API` | 5 |
| `WorkflowInstance CRUD` | 4 |
| **Total** | **55 (+ 3 status iteration)** |

---

## Typecheck Output

```
bun run --filter '@weaveio/weave-engine' typecheck
```

```
@weaveio/weave-engine typecheck: Exited with code 0
```

```
bun run typecheck
```

```
$ tsc --noEmit -p tsconfig.json && bun run --filter '*' typecheck
@weaveio/weave-core typecheck: Exited with code 0
@weaveio/weave-engine typecheck: Exited with code 0
@weaveio/weave-adapter-opencode typecheck: Exited with code 0
@weaveio/weave-config typecheck: Exited with code 0
@weaveio/weave-cli typecheck: Exited with code 0
```

---

## Full Test Suite

```
bun test
```

```
bun test v1.3.13 (bf2e2cec)

 1090 pass
 0 fail
 2877 expect() calls
Ran 1090 tests across 36 files. [162.00ms]
```

---

## Acceptance Criteria Verification

| # | Criterion | Status |
|---|---|---|
| 1 | `WorkflowInstance.status` typed as `"created" \| "running" \| "paused" \| "blocked" \| "completed" \| "failed" \| "cancelled"` | ✅ |
| 2 | `ExecutionLease` has `executionId` (as `id: ExecutionLeaseId`), Weave-generated `ownerId`, `acquiredAt`, `expiresAt`, optional `lastHeartbeatAt` | ✅ |
| 3 | `SessionSnapshot` has normalized Weave-visible fields; raw harness dumps, transcripts, prompts, credentials, tokens, cookies, authorization headers, raw provider payloads, and PII-like harness-private fields excluded by type design | ✅ |
| 4 | `RuntimeStoreError` is a discriminated union with variants: `initialization`, `migration_version`, `serialization`, `query`, `not_found`, `conflict`, `validation`, `journal_write` | ✅ |
| 5 | Repository interfaces use `ResultAsync<T, RuntimeStoreError>` for all fallible operations | ✅ |
| 6 | Paired `find*` (returns `ResultAsync<T \| null, RuntimeStoreError>`) and `get*` (returns `ResultAsync<T, RuntimeStoreError>` — errors with `not_found` if missing) lookup semantics | ✅ |
| 7 | Lease `acquire`/`heartbeat`/`release` methods defined | ✅ |
| 8 | Journal `append`/`query` methods defined | ✅ |
| 9 | Composed `RuntimeStore` exposes focused sub-repositories | ✅ |
| 10 | Transaction/unit-of-work interface defined | ✅ |
| 11 | All runtime public types exported from `packages/engine/src/index.ts` (no SQLite internals) | ✅ |
| 12 | `bun run --filter '@weaveio/weave-engine' typecheck` passes | ✅ Exited with code 0 |
| 13 | Contract tests pass: `bun test packages/engine/src/__tests__/runtime-contract.test.ts` | ✅ 58 pass, 0 fail |

---

## Files Changed

### New files
- `packages/engine/src/runtime/types.ts` — Branded ID types (`WorkflowInstanceId`, `ExecutionLeaseId`, `SessionSnapshotId`, `RuntimeJournalEntryId`, `OwnerId`), ID factory helpers, `WorkflowInstance`, `ExecutionLease`, `SessionSnapshot`, `RuntimeJournalEntry`, `WORKFLOW_INSTANCE_STATUSES`, `JOURNAL_SEVERITIES`, `JournalEntrySource`, `JournalQueryFilter`
- `packages/engine/src/runtime/errors.ts` — `RuntimeStoreError` discriminated union with 8 variants; error factory helpers (`initializationError`, `migrationVersionError`, `serializationError`, `queryError`, `notFoundError`, `conflictError`, `validationError`, `journalWriteError`)
- `packages/engine/src/runtime/store.ts` — `WorkflowInstanceRepository`, `ExecutionLeaseRepository`, `SessionSnapshotRepository`, `RuntimeJournalRepository`, `RuntimeStore`, `RuntimeStoreTransaction`, `TransactionCallback`, and input types
- `packages/engine/src/__tests__/runtime-contract.test.ts` — 58 contract tests using in-memory stubs

### Modified files
- `packages/engine/src/index.ts` — Added exports for all runtime public types, error variants, error factories, repository interfaces, and store interfaces

---

## Design Notes

**Branded ID types**: All entity IDs use TypeScript branded string types (`string & { readonly __brand: "..." }`) for compile-time type safety. Factory helpers (`createWorkflowInstanceId`, etc.) cast raw strings to branded types. At runtime they are plain strings.

**SessionSnapshot denylist**: The `SessionSnapshot` interface is designed by omission — it only declares normalized Weave-visible fields. Raw prompts, completions, transcripts, credentials, tokens, cookies, authorization headers, raw provider payloads, and PII-like fields are excluded by not being declared. Contract tests verify this by checking `"rawPrompt" in snapshot === false` etc.

**ResultAsync usage**: All fallible repository methods return `ResultAsync<T, RuntimeStoreError>` from neverthrow. The in-memory stubs use `okAsync`/`errAsync` for proper `ResultAsync` instances (not `Promise.resolve(ok(...))` casts, which would fail typecheck).

**TransactionCallback**: The `TransactionCallback<T>` type is `(tx: RuntimeStoreTransaction) => ResultAsync<T, RuntimeStoreError>`. Transaction callbacks must return `ResultAsync`, not `Promise<Result>`. This is enforced at compile time.

**No SQLite internals exported**: The `packages/engine/src/runtime/` directory will eventually contain SQLite-specific files (Task 3), but only the interface files (`types.ts`, `errors.ts`, `store.ts`) are exported from `index.ts`. SQLite implementation files will not be re-exported.
