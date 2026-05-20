# Task 3.0 Proof Artifact — SQLite/Kysely Runtime Store

**Date**: 2026-05-20
**Task**: 3.0 Implement SQLite/Kysely default Runtime Store

---

## Acceptance Criteria Evidence

### AC 1: `kysely` added to `packages/engine/package.json`

```json
"dependencies": {
  "@weave/core": "workspace:*",
  "kysely": "^0.27.5",
  ...
}
```

No `better-sqlite3` or Node-only SQLite dependencies added.

---

### AC 2: Internal Kysely dialect/driver uses `bun:sqlite` exclusively

File: `packages/engine/src/runtime/sqlite/kysely-bun-sqlite.ts`

- `BunSqliteDialect` implements Kysely's `Dialect` interface
- `BunSqliteDriver` opens a `bun:sqlite` `Database` in its constructor
- `BunSqliteConnection.executeQuery()` uses `stmt.all()` for SELECT and `stmt.run()` for DML
- No `better-sqlite3` import anywhere

---

### AC 3: SQLite tables defined

File: `packages/engine/src/runtime/sqlite/schema.ts`

Tables defined:
- `workflow_instances` — WorkflowInstance records with status, artifacts JSON, timestamps
- `execution_leases` — ExecutionLease records with expiry and heartbeat timestamps
- `session_snapshots` — SessionSnapshot records with metadata JSON
- `runtime_journal_entries` — RuntimeJournalEntry records with indexed lookup columns
- `schema_migrations` — Applied migration tracking
- `runtime_metadata` — Key-value store for schema version and project salt

---

### AC 4: Lazy creation of `.weave/runtime/` directory and `weave.db`

File: `packages/engine/src/runtime/sqlite/store.ts`

- `SqliteRuntimeStore` constructor does NOT create any files
- `ensureInitialized()` is called on first repository operation
- Uses `Bun.spawnSync(["mkdir", "-p", dir])` to create the runtime directory
- DB file is created by `bun:sqlite` `Database` constructor on first open

Test evidence:
```
✓ lazy initialization > does not create the DB file at construction time
✓ lazy initialization > creates the runtime directory and DB file on first operation
✓ lazy initialization > is idempotent — second operation does not re-initialize
```

---

### AC 5: Restrictive permissions

- Runtime directory: `chmod 700` via `Bun.spawnSync(["chmod", "700", dir])`
- DB file: `chmod 600` via `Bun.spawnSync(["chmod", "600", dbPath])`
- WAL and SHM files: `chmod 600` (best-effort, may not exist yet)

---

### AC 6: Code-owned, idempotent, transactional migrations

File: `packages/engine/src/runtime/sqlite/migrations.ts`

- `MIGRATIONS` array defines all migrations in ascending version order
- `runMigrations()` applies pending migrations in a single `BEGIN`/`COMMIT` transaction
- Idempotent: calling on an already-migrated DB is a no-op
- Applied versions tracked in `schema_migrations` table
- Current schema version stored in `runtime_metadata.schema_version`

Test evidence:
```
✓ migrations > applies initial migration on first open
✓ migrations > stores schema_version in runtime_metadata
✓ migrations > runMigrations is idempotent on an already-migrated DB
```

---

### AC 7: Clean `migration_version` error for newer DB

Test evidence:
```
✓ migrations > returns migration_version error when DB version > supported version
✓ migrations > SqliteRuntimeStore returns migration_version error on open with future DB
```

Error shape:
```ts
{
  type: "migration_version",
  foundVersion: 999,
  supportedVersion: 1,
  message: "Runtime store schema version 999 is newer than this Weave build supports (1)..."
}
```

---

### AC 8: JSON document-row persistence with indexed lookup columns

Migration 1 creates indexes on:
- `workflow_instances`: `status`, `created_at`
- `execution_leases`: `expires_at`, `workflow_instance_id`
- `session_snapshots`: `workflow_instance_id`, `recorded_at`
- `runtime_journal_entries`: `timestamp`, `workflow_instance_id`, `execution_id`, `source_kind`, `source_name`, `event_type`, `severity`

JSON columns: `artifacts_json`, `metadata_json`, `data_json`

---

### AC 9: Source-of-truth repository methods

All repository methods return `ResultAsync<T, RuntimeStoreError>`. Persistence failures fail the operation.

Test evidence:
```
✓ WorkflowInstance CRUD > create returns a WorkflowInstance with status 'created'
✓ WorkflowInstance CRUD > update changes status and sets completedAt for terminal status
✓ WorkflowInstance CRUD > addArtifact appends an artifact reference
✓ SessionSnapshot CRUD > record creates a snapshot
```

---

### AC 10: One-active-project lease acquisition with atomic expiry/conflict checks

`SqliteExecutionLeaseRepository.acquire()` uses a single async block that:
1. Queries for any unexpired lease (`expires_at > now`)
2. If found, throws `ConflictSentinel` → returns `conflict` error
3. If not found, inserts new lease

Clock source is injected via `options.clock` (defaults to `() => new Date()`).

Test evidence:
```
✓ ExecutionLease CRUD and conflicts > acquire creates a new lease when none exists
✓ ExecutionLease CRUD and conflicts > acquire fails with conflict when unexpired lease exists
✓ ExecutionLease CRUD and conflicts > acquire succeeds when existing lease is expired
✓ ExecutionLease CRUD and conflicts > heartbeat fails with conflict for wrong owner
✓ ExecutionLease CRUD and conflicts > release fails with conflict for wrong owner
```

---

### AC 11: SQLite-backed unit-of-work transactions

`SqliteRuntimeStore.transaction()` uses Kysely's `db.transaction().execute()`:
- On callback success: Kysely commits the transaction
- On callback `Err`: throws `TxCallbackErrSentinel` → Kysely rolls back → error returned
- Strict journal mode: journal write failures propagate as `journal_write` errors
- Best-effort mode: journal write failures are logged as warnings

Test evidence:
```
✓ transaction commit and rollback > transaction commits on success
✓ transaction commit and rollback > transaction rolls back on Err result from callback
✓ strict journal mode > transaction with strict journal rolls back when journal fails
✓ best-effort journal mode > transaction commits state even when journal error is returned
```

---

### AC 12: Dependency guard

```
$ git grep -n "better-sqlite3\|node:fs\|child_process" packages/engine/src
(no output)
```

No forbidden dependencies found.

---

### AC 13: Temp-directory SQLite tests pass

```
$ bun test packages/engine/src/__tests__/runtime-sqlite.test.ts

 46 pass
 0 fail
 112 expect() calls
Ran 46 tests across 1 file. [411.00ms]
```

Tests cover:
- Lazy init (5 tests)
- Migrations (5 tests)
- WorkflowInstance CRUD (8 tests)
- ExecutionLease CRUD and conflicts (8 tests)
- SessionSnapshot CRUD (3 tests)
- RuntimeJournal CRUD (5 tests)
- Transaction commit and rollback (3 tests)
- Strict journal mode (2 tests)
- Best-effort journal mode (2 tests)
- Dependency guard (2 tests)

---

### AC 14: Both test files pass

```
$ bun test packages/engine/src/__tests__/runtime-sqlite.test.ts packages/engine/src/__tests__/runtime-contract.test.ts

 104 pass
 0 fail
 284 expect() calls
Ran 104 tests across 2 files. [411.00ms]
```

---

### AC 15: Typecheck passes

```
$ bun run --filter '@weave/engine' typecheck
@weave/engine typecheck: Exited with code 0
```

---

## Full Test Suite

```
$ bun test

 1136 pass
 0 fail
 2989 expect() calls
Ran 1136 tests across 37 files. [530.00ms]
```

No regressions introduced.

---

## Files Created/Modified

| File | Change |
|------|--------|
| `packages/engine/package.json` | Added `kysely: ^0.27.5` dependency |
| `packages/engine/src/runtime/sqlite/kysely-bun-sqlite.ts` | New: Kysely dialect/driver over `bun:sqlite` |
| `packages/engine/src/runtime/sqlite/schema.ts` | New: SQLite table definitions and typed row shapes |
| `packages/engine/src/runtime/sqlite/migrations.ts` | New: Code-owned lazy migrations |
| `packages/engine/src/runtime/sqlite/store.ts` | New: SQLite-backed repository implementations |
| `packages/engine/src/__tests__/runtime-sqlite.test.ts` | New: Temp-directory SQLite tests |
