# 12-spec-runtime-persistence.md

## Introduction/Overview

Weave will add a default, engine-owned **Runtime Store** for durable workflow execution state. The Runtime Store makes workflow execution resumable, inspectable, and debuggable across session interruptions without making adapters own Weave product state.

The default implementation stores Runtime Store data in `.weave/runtime/weave.db` using SQLite through Kysely and a small internal `bun:sqlite` dialect/driver. Runtime Store APIs remain repository-based so tests and unusual adapters can inject alternate implementations.

## Goals

- Provide `@weave/engine` Runtime Store interfaces for `WorkflowInstance`, `ExecutionLease`, `SessionSnapshot`, and Runtime Journal records.
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

- The system shall define runtime domain types in `@weave/engine`, not `@weave/core`: `WorkflowInstance`, `ExecutionLease`, `SessionSnapshot`, `RuntimeJournalEntry`, and related IDs/status enums.
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
- `RuntimeStore` shall compose focused sub-repositories and expose a transaction/unit-of-work API.

**Proof Artifacts:**

- Tests: engine unit tests prove status validation, lease ownership/expiry behavior, one-active-project conflict, nullable vs required lookups, and transaction behavior.
- Typecheck: `bun run --filter '@weave/engine' typecheck` proves public runtime types compile and are exported intentionally.

### Unit 3: SQLite/Kysely default Runtime Store

**Purpose:** Provide the default durable Runtime Store implementation under `.weave/runtime/weave.db`.

**Functional Requirements:**

- The system shall add Kysely to the appropriate package dependencies.
- The system shall implement a small internal Kysely dialect/driver over Bun's built-in `bun:sqlite`; it shall not add `better-sqlite3` or Node-only SQLite dependencies.
- The default store shall lazily create `.weave/runtime/` and `.weave/runtime/weave.db` on first repository operation.
- The default store shall run code-owned, versioned, idempotent migrations on first repository operation and track applied migration versions in SQLite.
- Runtime directory and database creation shall use restrictive local permissions where the platform supports them: runtime directory equivalent to `0700`, database/WAL/SHM files equivalent to `0600`.
- Migrations shall run inside a transaction when SQLite supports the involved statements transactionally.
- Opening a Runtime Store with a schema version newer than the running Weave implementation supports shall fail cleanly with a typed migration/version error instead of attempting downgrade or partial writes.
- The schema shall use JSON document rows plus indexed columns, e.g. workflow/status/timestamp/source/event lookup columns with `data_json` for evolving nested record shape.
- The store shall include tables for workflow instances, execution leases, session snapshots, runtime journal entries, schema migrations, and runtime metadata such as the project salt.
- Source-of-truth writes (`WorkflowInstance`, `ExecutionLease`, `SessionSnapshot`) shall fail operations on persistence errors.
- Runtime Journal writes shall be best-effort by default and strict when `settings.runtime.journal.strict` is true.
- In a unit-of-work transaction, best-effort journal failures shall be swallowed with a pino warning while state commits; strict journal failures shall roll back the unit of work.
- The default DB path shall be fixed at `.weave/runtime/weave.db` for issue #50.
- Future configurable DB paths shall validate and normalize paths, reject traversal outside the intended project/runtime scope, and apply the same permission expectations to SQLite sidecar files.

**Proof Artifacts:**

- Tests: SQLite store tests use temp project directories and prove lazy initialization, migrations, CRUD, lease conflict, transaction rollback/commit, best-effort journal behavior, strict journal behavior, and schema version reporting.
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
- Runtime Journal retention/pruning shall be deferred; the schema shall include timestamp indexes for future cleanup.

**Proof Artifacts:**

- Tests: journal writer tests prove envelope validation, source indexing fields, the concrete payload size bound, sanitization of known secret-bearing fields, salted fingerprint stability within one project, fingerprint difference across project salts, rejection of weak hash implementations by construction/review, and rejection/omission of raw content.
- Security review: Warp reviews fingerprinting, sanitization, adapter writer boundaries, and strict/best-effort failure behavior before implementation is accepted.

### Unit 5: In-memory Runtime Store test utility

**Purpose:** Give package and adapter tests a supported store implementation without requiring SQLite.

**Functional Requirements:**

- `@weave/engine` shall export a supported `createInMemoryRuntimeStore()` test utility.
- The in-memory store shall implement the same `RuntimeStore` interfaces and transaction semantics expected by callers.
- The in-memory store shall support optional injected failure modes for persistence, journal, and conflict tests.
- The in-memory store shall not start harnesses, read real harness resources, or write project files.

**Proof Artifacts:**

- Tests: in-memory store contract tests run against the same behavioral expectations as the SQLite store where practical.
- Typecheck: downstream package tests can import the utility from `@weave/engine`.

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
4. **Runtime Journal retention and cleanup**: No automatic pruning or cleanup CLI is included.
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
- Keep runtime state in `@weave/engine`; keep DSL settings schema in `@weave/core`.
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

## Open Questions

No open questions at this time.
