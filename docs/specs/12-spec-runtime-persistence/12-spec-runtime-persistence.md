# 12-spec-runtime-persistence.md

> **Normative extension:** [Spec 33 §19](../33-spec-pi-adapter/33-spec-pi-adapter.md#19-diagnostics-retention-and-usage) adds journal/usage retention, pruning, idempotent observations, and durable rollups. Statements below that deferred retention applied only to the original issue #50 slice.

## Introduction/Overview

Weave will add a default, engine-owned **Runtime Store** for durable workflow execution state. The Runtime Store makes workflow execution resumable, inspectable, and debuggable across session interruptions without making adapters own Weave product state.

The default implementation stores Runtime Store data in `.weave/runtime/weave.db` using SQLite through Kysely and a small internal `bun:sqlite` dialect/driver. Runtime Store APIs remain repository-based so tests and unusual adapters can inject alternate implementations.

## Goals

- Provide `@weaveio/weave-engine` Runtime Store interfaces for `WorkflowInstance`, `ExecutionLease`, `SessionSnapshot`, and Runtime Journal records.
- Provide a default SQLite/Kysely Runtime Store at `.weave/runtime/weave.db` with lazy initialization and code-owned migrations.
- Expose a composed `RuntimeStore` dependency with focused sub-repositories and a transaction/unit-of-work API.
- Enforce one active project execution through `ExecutionLease` while keeping the model future-compatible with multiple active executions.
- Store Runtime Journal observations in SQLite as an observational journal, not event-sourced state.
- Store salted prompt/completion fingerprints only; never persist raw prompt or completion text.
- Add a breaking DSL settings migration with `settings { log_level INFO runtime { journal { strict false } } }`.
- Add minimal read-only CLI inspection: `weave runtime status` and `weave runtime journal --limit <n>`.

## User Stories

- **As a Weave user**, I want interrupted workflow execution to be resumable so I do not lose progress when an agent session dies.
- **As a user running multiple sessions**, I want Weave to prevent two sessions from actively driving the same workflow at once.
- **As a maintainer**, I want a typed Runtime Store boundary so lifecycle code does not hand-roll file/database writes.
- **As an adapter author**, I want a narrow Runtime Journal writer so I can emit observations without owning Weave runtime state.
- **As a reviewer**, I want runtime diagnostics to avoid storing raw prompts, completions, transcripts, or harness-private state.

## Demoable Units of Work

### Unit 1: Settings DSL migration

**Purpose:** Establish the new settings block required by runtime persistence and migrate logging settings into it.

**Functional Requirements:**

- The system shall add a top-level `settings` block to the `.weave` DSL/config model.
- The system shall accept `settings { log_level INFO }` and reject the old top-level `log_level INFO` shape after migration.
- The system shall accept `settings { runtime { journal { strict false } } }` with `strict` defaulting to `false`.
- The normalized config shall expose one settings object containing logging and runtime journal settings.
- Schema changes shall update parser, validate, and full parse-config tests in the same commit.

**Proof Artifacts:**

- Tests: `packages/core/src/__tests__/schema.test.ts`, `validate.test.ts`, `parser.test.ts`, and `parse_config.test.ts` cover valid settings, invalid settings, defaults, and top-level `log_level` rejection.
- Documentation: DSL docs/specs show the new settings block and remove examples that use top-level `log_level`.

### Unit 2: Runtime Store domain and repository interfaces

**Purpose:** Define the engine-owned persistence contract without tying callers to SQLite.

**Functional Requirements:**

- The system shall define runtime domain types in `@weaveio/weave-engine`, not `@weaveio/weave-core`: `WorkflowInstance`, `ExecutionLease`, `SessionSnapshot`, `RuntimeJournalEntry`, and related IDs/status enums.
- `WorkflowInstance.status` shall be one of `created`, `running`, `paused`, `blocked`, `completed`, `failed`, or `cancelled`.
- `WorkflowInstance` shall store artifact references/metadata only, not artifact contents.
- `ExecutionLease` shall include `executionId`, Weave-generated `ownerId`, `acquiredAt`, `expiresAt`, and optionally `lastHeartbeatAt`.
- A valid `ExecutionLease` shall identify the actively driven `WorkflowInstance`; no separate active execution pointer shall exist.
- The issue #50 implementation shall enforce one active lease per project.
- Lease expiry checks shall be atomic with lease acquisition where practical and shall use one engine-provided clock source per operation; issue #50 assumes local project execution and does not claim distributed clock safety.
- An expired lease may be replaced during resume/recovery; an unexpired lease shall produce a typed `Conflict` error.
- `SessionSnapshot` shall store normalized Weave-visible harness session observations only, not raw harness dumps, transcripts, prompts, or harness-private state.
- `SessionSnapshot` data shall explicitly exclude tokens, credentials, cookies, authorization headers, raw model/provider payloads, user secrets, and other harness-private or personally sensitive fields.
- Repository methods shall return `ResultAsync<..., RuntimeStoreError>` with a shared discriminated error union.
- Repositories shall provide optional `find*(): ResultAsync<T | null, E>` methods and required `get*(): ResultAsync<T, E>` methods where absence maps to `NotFound`.
- `RuntimeStore` shall compose focused workflow, lease, snapshot, and journal sub-repositories and expose a transaction/unit-of-work API. It shall not expose durable permission repositories or permission mutation methods.
- The engine shall associate each concrete Runtime Store with its private permission repository through an internal `WeakMap`; only engine permission-session code may retrieve that association through a typed `Result`.
- `createPermissionService(store)` shall activate sessions from project, controller session ID, sealed registry generation, stable effective-policy map, and schema version. Repository, clock, ID source, grant records, and envelopes are engine-owned and are not adapter inputs. Adapter-facing overview: [Permissions guide](../../permissions.md). Normative authorization contract: [Spec 34](../34-spec-harness-neutral-permissions/34-spec-harness-neutral-permissions.md).

**Proof Artifacts:**

- Tests: engine unit tests prove status validation, lease ownership/expiry behavior, one-active-project conflict, nullable vs required lookups, and transaction behavior.
- Typecheck: `bun run --filter '@weaveio/weave-engine' typecheck` proves public runtime types compile and are exported intentionally.

### Unit 3: SQLite/Kysely default Runtime Store

**Purpose:** Provide the default durable Runtime Store implementation under `.weave/runtime/weave.db`.

**Functional Requirements:**

- The system shall add Kysely to the appropriate package dependencies.
- The system shall implement a small internal Kysely dialect/driver over Bun's built-in `bun:sqlite`; it shall not add `better-sqlite3` or Node-only SQLite dependencies.
- The default store shall lazily create `.weave/runtime/` and `.weave/runtime/weave.db` on first repository operation.
- The default store shall run code-owned, versioned, idempotent migrations on first repository operation and track applied migration versions in SQLite.
- Runtime directory and database creation shall use restrictive local permissions where the platform supports them: runtime directory equivalent to `0700`, database/WAL/SHM files equivalent to `0600`.
- Migrations shall run inside a transaction when SQLite supports the involved statements transactionally; a failed migration shall not advance `runtime_metadata.schema_version` or leave a tracking row behind.
- Migration definitions shall have unique, strictly increasing versions. Pending migrations shall run in deterministic version order, and `schema_migrations` shall contain exactly one validated row for each applied version.
- Before trusting `runtime_metadata` or `schema_migrations` contents, `runMigrations` shall verify each bootstrap table's exact canonical physical schema (column names, declared types, NOT NULL, defaults, primary key, and required uniqueness) **and** an exact `sqlite_schema` / `sqlite_master` inventory for that relation: exactly one table row, **zero triggers** (AFTER or BEFORE, including triggers that reset `permission_wall_clock_high_water`, rewrite ledger rows, or `RAISE(ABORT, …)`), **zero views**, and only the expected PK/index semantics — `runtime_metadata` requires exactly the SQLite PK autoindex on `key` (`origin = pk`, unique, non-partial; autoindex name accepted only as `sqlite_autoindex_runtime_metadata_<n>` without pinning a specific suffix); `schema_migrations` uses INTEGER PRIMARY KEY (rowid alias) and therefore **zero** indexes. Any extra unique, partial, expression, or otherwise unexpected index fails closed. A fresh empty database may create both bootstrap tables; a malformed or partial pre-existing bootstrap relation shall fail initialization generically and remain unmodified. Valid historical v1/v2 bootstrap shapes created by Weave migrations shall pass. Hostile bootstrap triggers or extra indexes on fresh-precreated, v2-upgrade, and v3-reopen paths must fail on every open before metadata/ledger contents are trusted so high-water cannot reset or resurrect under those triggers.
- Applied-ledger validation shall compare both the exact canonical migration `version` and `name` for every stored row against the code-owned migration list for the stored schema version. Renamed, missing, or extra ledger rows shall fail initialization generically without mutating the database.
- `runtime_metadata.schema_version` shall be canonical nonnegative base-10 integer text and shall reject malformed or unsafe integer values without echoing the raw value in the public diagnostic.
- Opening a Runtime Store with a schema version newer than the running Weave implementation supports shall fail cleanly with a typed migration/version error instead of attempting downgrade or partial writes.
- The schema shall use JSON document rows plus indexed columns, e.g. workflow/status/timestamp/source/event lookup columns with `data_json` for evolving nested record shape.
- The store shall include tables for workflow instances, execution leases, session snapshots, runtime journal entries, schema migrations, and runtime metadata such as the project salt.
- Source-of-truth writes (`WorkflowInstance`, `ExecutionLease`, `SessionSnapshot`) shall fail operations on persistence errors.
- Runtime Journal writes shall be best-effort by default and strict when `settings.runtime.journal.strict` is true.
- In a unit-of-work transaction, best-effort journal failures shall be swallowed with a pino warning while state commits; strict journal failures shall roll back the unit of work.
- The default DB path shall be fixed at `.weave/runtime/weave.db` for issue #50.
- Future configurable DB paths shall validate and normalize paths, reject traversal outside the intended project/runtime scope, and apply the same permission expectations to SQLite sidecar files.
- Durable permission grants use the migration-v3 `permission_grants` allowlist only; raw calls, constraints, prompts, secrets, and token data are not persisted. In-memory and SQLite repositories share project isolation, grant-identity and ID conflict rules, deterministic grant-ID ordering, boundary expiry semantics, injected-clock timestamps, and atomic non-empty `saveMany` behavior. Empty batches return typed `invalid_output`.
- Migration v3 shall create `permission_grants` with exact allowlisted columns, primary key on `grant_id`, unique full identity envelope, and lookup index `idx_permission_grants_project_state_expiry`. SQL CHECK constraints shall require `state IN ('active', 'revoked')`, `expires_at IS NULL OR expires_at > created_at`, active rows to keep `revoked_at` NULL, and revoked rows to keep non-NULL `revoked_at >= created_at`.
- Live `permission_grants` verification shall enforce an **exact** `sqlite_schema` / `sqlite_master` inventory for that relation: exactly one table row, **zero triggers** (AFTER or BEFORE, including triggers that skip fixed probe IDs, mutate/delete grants, exfiltrate to other tables, or `RAISE(ABORT, …)` on writes), and **exactly three indexes** matched by PRAGMA `index_list` / `index_info` semantics — (1) the SQLite PK autoindex on `grant_id` (`origin = pk`, unique, non-partial; autoindex name accepted only as `sqlite_autoindex_permission_grants_<n>` without pinning a specific suffix), (2) the full-envelope UNIQUE autoindex (`origin = u`, unique, non-partial, envelope column order), and (3) the named non-unique lookup index `idx_permission_grants_project_state_expiry` (`origin = c`, non-partial, columns `(project_identity, state, expires_at)` in that order). Any extra unique, partial, expression, or otherwise unexpected index fails closed because the schema is code-owned and exact. Verification does **not** claim trigger-body parsing, collation audits, or cross-version autoindex suffix stability beyond the checks above.
- When upgrading a version-2 database, a pre-existing `permission_grants` table or index may be adopted only when columns, nullability/defaults, the exact trigger/index allowlist, and required checks are behaviorally present. A compatible table left by the previously buggy duplicate-v2 path may be adopted and recorded as v3. Incompatible pre-existing relations must fail the migration transaction without recording v3 or bumping schema metadata. After apply/adopt, migration 3 shall verify the live schema before commit so `CREATE TABLE IF NOT EXISTS` cannot paper over a malformed or hostile relation created ahead of the migration.
- For every `runMigrations` invocation whose effective stored schema version is >= 3 — including no-pending reopen of an already-migrated database — the engine shall re-run that exact inventory verification plus randomized behavioral CHECK/UNIQUE probes (savepoint-scoped cleanup) before returning Ok. If the table was dropped, a required index altered/removed, a trigger attached, or an extra index added after initialization, open/migration shall fail closed and shall not silently recreate, repair, or claim a healthy store.
- The in-memory and SQLite implementations keep permission repositories in private fields and register them in the engine-internal store association. Adapters use `PermissionService` and cannot access a `store.permissions` mutation surface. Both stores construct the private repository **after** assigning the injected Date clock and pass a `() => clock().getTime()` adapter so revoke timestamps share the store clock.
- Durable permission repositories maintain an engine-internal nondecreasing **wall-clock high-water** mark. Every successful `saveMany` / `match` / `list` path, and every `revoke` of a **known in-project grant** (including already-revoked idempotent revokes), observes a validated wall timestamp and uses `max(previousHighWater, suppliedNow)`. Match compares grant `expiresAt` to that effective high-water so a grant observed expired cannot rematch after wall rollback. **Ordering on revoke:** validate input → resolve grant → on unknown/wrong-project return `unknown_grant` **without** observing high-water (callers must not poison the mark via random grant IDs) → observe/update high-water → then take the already-revoked idempotent early return or perform the revoke. Observing only after the early return is forbidden: an idempotent second revoke at a later wall time must still raise the mark so a later grant with an intermediate expiry cannot resurrect under rollback. SQLite persists the mark in `runtime_metadata` under the code-owned key `permission_wall_clock_high_water` (key rows are allowed; no raw input or secret-bearing payload). In-memory retains an equivalent private field. Reopen loads the persisted high-water. Concurrent operations serialize/transactionally update the mark without lost maxima (max-preserving UPSERT; never last-writer/lower-timestamp wins). High-water is never exposed on the public repository or adapter surface.
- SQLite grant reads hydrate every row through the strict durable-grant validator. Corrupt or unsupported rows fail closed as `repository_failure`; malformed state must never be cast into a grant or summary. Existing conflicts are checked only for candidate IDs and identity envelopes before the database primary-key and unique constraints remain the race authority.
- SQLite `saveMany` and wall high-water updates use `BEGIN IMMEDIATE` with shared bounded `SQLITE_BUSY` retry/re-preflight (yield then short backoff; robust retry budget, currently 32 attempts). Final primary-key or unique-constraint conflicts map to typed `invalid_output` (matching memory/sequential conflict behavior); busy exhaustion and unrelated driver failures map to `repository_failure`. Classification uses SQLite error codes only — raw driver messages are never string-matched into public errors. Multi-store concurrent high-water observations with timestamps in arbitrary order MUST all succeed under normal contention and persist the global max; losing the max to a lower concurrent write is a defect.
- Each `SqlitePermissionApprovalRepository` instance owns a recovery-safe serialized mutation queue for `saveMany`, `revoke`, `list`, and `match` so one Kysely/`bun:sqlite` connection never overlaps `BEGIN IMMEDIATE` transactions and same-instance high-water updates cannot lose maxima. The queue advances after every Ok, Err, throw, or rejection and always returns `ResultAsync` (never a rejected promise). Distinct repository/store instances that share a database file still rely on `BEGIN IMMEDIATE` plus the shared bounded busy retry/re-preflight (the per-instance queue cannot coordinate other connections). Same-repository concurrent duplicate grant IDs or full identity envelopes yield exactly one `Ok` and the rest typed `invalid_output`; concurrent distinct valid batches all succeed with no lost writes; concurrent revoke remains idempotent and retains the first revoke timestamp while still advancing high-water on every known-grant revoke attempt.
- Permission repository clocks must not run in default parameter positions. Clock invocation and Date→epoch conversion are wrapped in `Result.fromThrowable` / `ResultAsync` boundaries; throwing or invalid clocks map to `repository_failure`, and the lazy SQLite wrapper adds a final rejection-safe boundary so returned `ResultAsync` values never reject. A failed clock or injected mutation failure must not poison the repository queue: later calls with a healthy clock or valid write succeed. High-water advances are part of the same rejection-safe, serialized path.
- `LazyPermissionApprovalRepository` may share one in-flight `ensureInitialized()` attempt across concurrent callers, but must cache **only** a successful `SqlitePermissionApprovalRepository` so the per-instance mutation queue remains shared. On typed failure, sync throw, or rejection, the in-flight slot is cleared (identity-checked so an older failure cannot drop a newer attempt) and the next permission operation retries store initialization. Closed stores stay failed and must not reopen. Path/init recovery without reconstructing the store is required: after a first permission list/authorization `repository_failure` caused by an invalid/unwritable DB parent path, repairing the path and succeeding on an ordinary store repository must allow the next permission operation on the same lazy wrapper to succeed. Lazy repositories (including a concurrently resolving permission repo) must never cache or use a repository after `close()`; later operations return typed failure and no DB handle/file activity resumes.
- `SqliteRuntimeStore.close()` is atomic with in-flight lazy initialization: it sets `closed` first, awaits/shares any in-flight `initializingPromise` settlement, and destroys the final published DB exactly once while clearing all state. `_doInitialize` must not publish `db`, `initialized`, project salt, or success after `closed` becomes true; if closed during init it destroys any opened Kysely/raw resources and returns a typed initialization/closed failure to waiting repository calls. `close` is idempotent and concurrent-safe (shared settlement). Recoverable failed init (store **not** closed) must still clear the in-flight slot so a later retry can succeed.

**Proof Artifacts:**

- Tests: SQLite store tests use temp project directories and prove lazy initialization, migrations, CRUD, lease conflict, transaction rollback/commit, best-effort journal behavior, strict journal behavior, schema version reporting, and permission-grant persistence.
- Tests: Migration fixtures cover wrong ledger names, missing/extra ledger rows, missing/extra `permission_grants` columns, weak state/check constraints, missing unique envelope or lookup index, compatible pre-existing table adoption, v2-adoption and v3-reopen rejection of AFTER/BEFORE triggers and extra unique/partial/expression indexes with version/ledger unchanged on failure, failed migration leaving version 2 with no v3 ledger row, strict schema-version parsing, future-version rejection, malformed bootstrap `runtime_metadata`/`schema_migrations` physical schemas (nullable columns, missing PK, wrong types, partial pair) with no mutation on failure, fresh-precreated / v2-upgrade / v3-reopen rejection of hostile BEFORE/AFTER triggers and extra indexes on `runtime_metadata` and `schema_migrations` (including high-water reset and ledger-tamper triggers) with version/ledger/high-water unchanged on failure, healthy no-pending v3 reopen, and post-init drop/alter of `permission_grants` table or lookup index failing reopen without silent repair.
- Tests: Runtime permission tests run the in-memory and SQLite repositories against the same contract, including empty batches, conflict non-overwrite, project isolation, deterministic ordering and timestamps, strict hydration, atomic batches, direct corrupt-row fixtures, SQL-boundary rejection of revoked rows with null `revoked_at`, injected-clock revoke timestamps through the `createPermissionService` store association, throwing-clock `repository_failure` recovery without queue poison, concurrent multi-store duplicate `saveMany` yielding one `Ok` and the rest `invalid_output`, same-repository concurrent duplicate IDs/envelopes (one `Ok`, rest `invalid_output`), same-repository concurrent distinct valid batches with no lost writes, injected mutation-failure then valid write queue recovery, concurrent revoke idempotence retaining the first timestamp, idempotent revoke advancing wall high-water before early return (memory + SQLite reopen under lower clock; unknown/wrong-project revoke does not poison high-water), concurrent multi-store high-water observations across preinitialized stores with mixed timestamps (including the max) via match/list/revoke over repeated rounds persisting the global max so expired grants never rematch after reopen, store-open failure before repository use when hostile `permission_grants` triggers or extra indexes are attached post-init (version/ledger unchanged; existing grants untouched), store-open failure before high-water can reset/resurrect when hostile `runtime_metadata` / `schema_migrations` triggers are attached post-init (high-water/version/ledger unchanged), and lazy permission repository init recovery: invalid/unwritable DB parent path yields `repository_failure` on first list/authorization with non-rejecting `ResultAsync`, concurrent initial callers share one attempt, path repair plus ordinary store repository success lets the same store/session retry permission operations successfully without reconstruction, closed-store permission calls remain `repository_failure`, and close/init races (deterministic publish-gate seam; 30-round stress; concurrent closes; normal close after init) settle typed without publishing a usable handle after close.
- Tests: no Node `fs`, `child_process`, `better-sqlite3`, or harness runtime dependency is used.

### Unit 4: Runtime Journal and safe adapter writer

**Purpose:** Record bounded runtime observations without making the journal a source of truth or a prompt transcript.

**Functional Requirements:**

- The Runtime Journal shall be observational and shall not be required to reconstruct `WorkflowInstance` state.
- Every journal entry shall use a fixed envelope with at least `id`, `timestamp`, `source`, `eventType`, optional `executionId`, optional `workflowInstanceId`, optional `stepId`, `severity`, and sanitized JSON `data`.
- `source` shall be structured as `{ kind: "engine" | "adapter"; name: string }`, persisted with indexed `source_kind` and `source_name` columns.
- Journal `data` shall be JSON-serializable, size-bounded, and sanitized before persistence.
- Prompt and completion contents shall never be stored. The journal may store salted fingerprints using a per-project random salt stored in Runtime Store metadata.
- The per-project fingerprint salt shall be generated with a cryptographically secure random source with at least 128 bits of entropy.
- Prompt/completion fingerprints shall use SHA-256 or a stronger hash construction over the project salt and content; MD5, SHA-1, and non-cryptographic hashes are forbidden.
- Recreating the Runtime Store shall create a new project salt; loss of cross-store fingerprint correlation is intentional.
- Adapters shall emit journal observations only through an engine-provided narrow `RuntimeJournalWriter`; adapters shall not receive direct SQLite access or full Runtime Store mutation rights.
- `RuntimeJournalWriter` shall be the enforcement point for adapter journal validation: it validates envelope fields, enforces payload size limits, sanitizes or rejects sensitive fields, and applies fingerprinting before persistence.
- Runtime Journal payloads shall have a concrete maximum serialized size in implementation; the initial recommended maximum is 64 KiB per entry unless a later spec changes it.
- Runtime Journal sanitization shall strip or reject bearer/auth tokens, API keys, passwords, cookies, authorization headers, raw prompts, raw completions, raw transcripts, and known secret-like fields before persistence.
- The original issue #50 implementation deferred Runtime Journal retention/pruning; Spec 33 now requires the bounded retention extension defined below.

**Proof Artifacts:**

- Tests: journal writer tests prove envelope validation, source indexing fields, the concrete payload size bound, sanitization of known secret-bearing fields, salted fingerprint stability within one project, fingerprint difference across project salts, rejection of weak hash implementations by construction/review, and rejection/omission of raw content.
- Security review: Warp reviews fingerprinting, sanitization, adapter writer boundaries, and strict/best-effort failure behavior before implementation is accepted.

### Unit 5: In-memory Runtime Store test utility

**Purpose:** Give package and adapter tests a supported store implementation without requiring SQLite.

**Functional Requirements:**

- `@weaveio/weave-engine` shall export a supported `createInMemoryRuntimeStore()` test utility.
- The in-memory store shall implement the same `RuntimeStore` interfaces and transaction semantics expected by callers.
- The in-memory store shall support optional injected failure modes for persistence, journal, and conflict tests.
- The in-memory store shall not start harnesses, read real harness resources, or write project files.

**Proof Artifacts:**

- Tests: in-memory store contract tests run against the same behavioral expectations as the SQLite store where practical.
- Typecheck: downstream package tests can import the utility from `@weaveio/weave-engine`.

### Unit 6: Minimal CLI runtime inspection

**Purpose:** Make SQLite runtime state inspectable without requiring users to open the database directly.

**Functional Requirements:**

- The CLI shall add read-only `weave runtime status`.
- `status` shall report Runtime Store path, schema version, active lease summary, and recent/resumable workflow instances.
- The CLI shall add read-only `weave runtime journal --limit <n>` with a safe default such as `50`.
- `journal` shall render recent fixed-envelope entries in deterministic text suitable for TOON-style LLM consumption.
- Issue #50 shall not add journal filters, export, cleanup, retention commands, or write-oriented runtime commands.

**Proof Artifacts:**

- Tests: CLI tests use temp runtime stores and prove status output, journal limit behavior, missing-runtime behavior, and no mutation of Runtime Store state.

## Non-Goals (Out of Scope)

1. **Full lifecycle orchestration**: `startExecution`, `resumeExecution`, `dispatchStep`, `completeStep`, and policy/tool lifecycle handling remain issue #44/follow-up work.
2. **Multiple concurrent active executions**: Issue #50 enforces one active project lease.
3. **Runtime DB path configuration**: `.weave/runtime/weave.db` is fixed for this slice.
4. **User-driven retention CLI**: Spec 33 adds automatic bounded pruning, but an export/cleanup command remains out of scope.
5. **Raw prompt/completion/session storage**: The Runtime Store is not a transcript archive.
6. **Event sourcing**: The Runtime Journal is not replayable state.
7. **SQLite alternatives**: JSONL, Drizzle, Prisma, direct-only SQL, and external migration CLIs are not part of the accepted design.

## Design Considerations

No graphical UI or visual design changes are required. User-facing design is limited to deterministic CLI output for `weave runtime status` and `weave runtime journal --limit <n>`.

CLI output should be readable by humans and stable enough for TOON-style LLM consumption. It must not expose raw prompts, raw completions, transcripts, credentials, cookies, authorization headers, tokens, or raw provider payloads.

## Repository Standards

- Use Bun exclusively for runtime/package/test execution.
- Use `bun:sqlite` through the internal Kysely dialect; do not use Node `fs`, `child_process`, or Node-only SQLite packages.
- Use `neverthrow` result types for all fallible repository and runtime persistence APIs.
- Keep runtime state in `@weaveio/weave-engine`; keep DSL settings schema in `@weaveio/weave-core`.
- Keep adapters behind narrow interfaces; adapters may emit journal observations but do not own Runtime Store mutation.
- Use pino for warnings such as best-effort journal write failures; do not use `console.*`.

## Technical Considerations

- The Runtime Store is a documented, narrow exception to the adapter boundary: the engine may perform Bun filesystem/database I/O only for Weave-owned state under `.weave/runtime/**`.
- The default database path is fixed at `.weave/runtime/weave.db` for issue #50, and `.weave/runtime/` is already ignored by this repository's `.gitignore`.
- Current Bun documentation confirms `bun:sqlite` provides the built-in SQLite API needed for a Bun-only implementation.
- Current Kysely documentation supports SQLite but does not document a first-party Bun SQLite happy path; Weave shall therefore own a small internal Kysely dialect/driver over `bun:sqlite`.
- Runtime DB migrations are code-owned engine migrations that run lazily on first repository operation; users do not run a migration CLI for `.weave/runtime/weave.db`.
- Runtime records use JSON document rows plus selected indexed columns so the nested runtime shape can evolve without fully normalizing every field in the first implementation.
- The composed `RuntimeStore` exposes focused sub-repositories and a unit-of-work transaction API so state changes and strict journal writes can commit or roll back together.
- The `settings` DSL migration is intentionally breaking: top-level `log_level INFO` is rejected after this migration, and logging config moves to `settings { log_level INFO }`.

## Security Considerations

- Runtime Store data is local project state under `.weave/runtime/`, which is already ignored by Git in this repo, but implementations must not rely on Git ignore rules for secrecy.
- Prompt/completion content must not be persisted; store salted SHA-256-class fingerprints only.
- The per-project salt is not a secret key, but it must be CSPRNG-generated with at least 128 bits of entropy and prevents cross-project/global hash matching.
- Journal payloads must be size-bounded and sanitized before persistence; the RuntimeJournalWriter is the enforcement point for adapter-provided data.
- Session snapshots must not store raw harness-private state, transcripts, credentials, cookies, authorization headers, tokens, or raw provider payloads.
- Adapter journal writer APIs must prevent adapters from bypassing sanitization or mutating authoritative state.
- Runtime Store files and SQLite sidecars should be created with restrictive local permissions where supported.
- Runtime migrations must avoid partial schema updates and must fail cleanly on unsupported future schema versions.
- Because the design touches prompt fingerprints, input validation, local persistence, and adapter event boundaries, implementation requires Warp security review.

## Success Metrics

1. **Resumability foundation**: Runtime Store APIs can persist/retrieve workflow records and leases without relying on chat context.
2. **Single-driver safety**: concurrent acquisition of the active project lease returns a typed conflict.
3. **Inspection**: users can run `weave runtime status` and `weave runtime journal --limit <n>` against a SQLite store.
4. **Privacy**: tests prove raw prompt/completion content is not stored in journal entries.
5. **Layered coverage**: core settings, engine stores, CLI commands, migration behavior, and failure modes are covered by tests.

## Retention and usage extension

[Spec 33](../33-spec-pi-adapter/33-spec-pi-adapter.md) and [ADR 0011](../../adr/0011-effective-adapter-readiness-and-runtime-observability.md) extend the Runtime Store with portable bounded retention and usage contracts.

### Retention

The settings contract adds journal age/count bounds, usage-detail age/count bounds, and rotating-log size/count bounds. Values are finite positive integers in the ranges defined by Spec 33 §19.3.

Pruning runs after activation and after either 256 relevant writes or 15 minutes. One serialized single-flight task removes entries by age first, then oldest entries above count. Failure degrades and retries only at the next safe boundary. `journal.strict=true` affects only its correlated transaction.

### Usage observations and rollups

The Runtime Store records one detailed observation for each settled assistant message. An observation has a stable ID, timestamp, source, optional workflow/step/agent/model dimensions, optional non-negative token counters, and optional non-negative finite cost. Missing counters stay absent.

Insertion and rollup update are atomic. Replaying the same ID with identical normalized values is a no-op. Reusing an ID with different values is an invariant breach. Rollups group by available dimensions and sum each known field independently. Pruning detailed observations never subtracts durable rollups.

Adapters submit normalized observations through an engine-owned repository. They do not write rollup tables directly. Raw message text, provider payloads, prompts, completions, and tool results are forbidden.

The portable implementation lives in [`packages/engine/src/runtime/usage.ts`](../../../packages/engine/src/runtime/usage.ts) and the Runtime Store repositories. Memory and SQLite stores apply observation insertion and rollup updates in one transaction. [`RuntimeRetentionService`](../../../packages/engine/src/runtime/retention.ts) serializes age-first/count-second pruning at activation and safe write/time boundaries. [`RotatingRuntimeLogSink`](../../../packages/engine/src/runtime/log-sink.ts) provides the bounded engine-scoped NDJSON sink through Bun-only, no-follow filesystem operations.

## Open Questions

No open questions at this time.
