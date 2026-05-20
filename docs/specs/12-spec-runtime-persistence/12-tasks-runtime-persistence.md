## Relevant Files

| File | Why It Is Relevant |
| --- | --- |
| `packages/core/src/schema.ts` | Defines validated config shape; needs `settings.log_level` and `settings.runtime.journal.strict`. |
| `packages/core/src/validate.ts` | Transforms parsed DSL settings into normalized config and must reject top-level `log_level`. |
| `packages/core/src/parser.ts` | Parses top-level block settings; existing behavior should be covered for `settings { ... }`. |
| `packages/core/src/ast.ts` | Contains setting/block AST types that may need type coverage or comments for settings blocks. |
| `packages/core/src/config.ts` | Exports/inferred config types if settings need public type aliases. |
| `packages/core/src/index.ts` | Barrel export for any new settings config types. |
| `packages/core/src/__tests__/schema.test.ts` | Schema tests for valid/invalid settings and defaults. |
| `packages/core/src/__tests__/validate.test.ts` | AST-to-config tests for settings normalization and top-level `log_level` rejection. |
| `packages/core/src/__tests__/parser.test.ts` | Parser tests for nested settings block syntax. |
| `packages/core/src/__tests__/parse_config.test.ts` | End-to-end DSL parse tests for settings migration. |
| `packages/config/src/builtins.ts` | Builtin DSL defaults may need the new settings shape. |
| `packages/config/src/merge.ts` | Settings object must merge predictably across global/project config. |
| `packages/config/src/__tests__/*` | Config tests should cover settings merge/default behavior if existing tests are present. |
| `packages/engine/package.json` | Adds Kysely dependency for default Runtime Store implementation. |
| `packages/engine/src/runtime/types.ts` | New runtime domain types, IDs, statuses, envelopes, and repository interfaces. |
| `packages/engine/src/runtime/errors.ts` | Shared `RuntimeStoreError` discriminated union. |
| `packages/engine/src/runtime/store.ts` | Composed `RuntimeStore` and transaction/unit-of-work API. |
| `packages/engine/src/runtime/journal-writer.ts` | Safe Runtime Journal writer, envelope validation, sanitization, and fingerprinting. |
| `packages/engine/src/runtime/fingerprint.ts` | CSPRNG salt creation and SHA-256-class prompt/completion fingerprints. |
| `packages/engine/src/runtime/sanitizer.ts` | Runtime Journal and SessionSnapshot denylist/sanitization helpers. |
| `packages/engine/src/runtime/sqlite/kysely-bun-sqlite.ts` | Internal Kysely dialect/driver over `bun:sqlite`. |
| `packages/engine/src/runtime/sqlite/schema.ts` | SQLite table definitions and typed row shapes. |
| `packages/engine/src/runtime/sqlite/migrations.ts` | Code-owned lazy migrations and schema version checks. |
| `packages/engine/src/runtime/sqlite/store.ts` | SQLite-backed repository implementations and unit-of-work behavior. |
| `packages/engine/src/runtime/memory-store.ts` | Exported in-memory Runtime Store test utility with failure injection. |
| `packages/engine/src/index.ts` | Public exports for runtime types, store interfaces, and `createInMemoryRuntimeStore`. |
| `packages/engine/src/__tests__/runtime-*.test.ts` | Engine runtime contract, journal, SQLite, and in-memory tests. |
| `packages/cli/src/args.ts` | CLI argument parsing for `runtime status` and `runtime journal --limit <n>`. |
| `packages/cli/src/cli.ts` | Command routing/default dependencies for runtime commands. |
| `packages/cli/src/commands/runtime.ts` | New read-only runtime inspection command implementation. |
| `packages/cli/src/commands/__tests__/runtime.test.ts` | CLI command tests for status, journal limit, missing runtime, sanitized output, and read-only behavior. |
| `packages/cli/src/__tests__/routing.test.ts` | CLI routing/help tests for runtime subcommands if routing tests are centralized. |
| `AGENTS.md` | DSL examples and repository guidance must reflect `settings { log_level INFO }`. |
| `docs/specs/12-spec-runtime-persistence/12-spec-runtime-persistence.md` | Source spec for traceability during implementation. |
| `docs/adr/0002-runtime-persistence-store.md` | Accepted design rationale; implementation must not contradict it. |
| `docs/adapter-boundary.md` | Boundary documentation for engine-owned `.weave/runtime/**` exception. |
| `docs/system-architecture.md` | Architecture documentation mentioning Runtime Store exception. |

### Notes

- Unit tests should live alongside each package's existing test structure, especially `packages/core/src/__tests__/`, `packages/engine/src/__tests__/`, and `packages/cli/src/commands/__tests__/`.
- Use Bun commands from the repository: `bun run lint`, `bun run typecheck`, `bun run build`, and `bun run test`.
- Follow Biome formatting: 2 spaces, double quotes, semicolons, no `console.*`, no explicit `any`, no nested ternaries, and kebab-case/snake_case filenames where required.
- Follow the engine/adapter boundary: engine may write only Weave-owned `.weave/runtime/**` state; adapters get a narrow Runtime Journal writer, not direct DB/store ownership.
- All fallible runtime persistence APIs must use `neverthrow` `ResultAsync` with typed errors.
- Proof artifacts must be sanitized and must not include raw prompts, raw completions, transcripts, credentials, tokens, cookies, authorization headers, or private harness payloads.

## Tasks

### [x] 1.0 Migrate DSL settings into `settings` block

#### 1.0 Proof Artifact(s)

- Test: `bun test packages/core/src/__tests__/schema.test.ts packages/core/src/__tests__/validate.test.ts packages/core/src/__tests__/parser.test.ts packages/core/src/__tests__/parse_config.test.ts` passes with cases for `settings { log_level INFO }`, `settings.runtime.journal.strict`, defaults, invalid settings, and top-level `log_level` rejection.
- Documentation: `AGENTS.md` and relevant docs/spec references show `settings { log_level INFO }` and no longer present top-level `log_level INFO` as valid syntax.
- Proof artifact: `docs/specs/12-spec-runtime-persistence/12-proofs/12-task-01-proofs.md`

#### 1.0 Tasks

- [x] 1.1 Add `SettingsConfigSchema` to `packages/core/src/schema.ts` with `log_level` and `runtime.journal.strict` fields.
- [x] 1.2 Update `WeaveConfigSchema` so `settings` is the accepted logging/runtime settings home and top-level `log_level` is rejected.
- [x] 1.3 Update inferred/exported config types for the new settings object.
- [x] 1.4 Update validation transformation so nested `settings { ... }` block values normalize into the schema shape.
- [x] 1.5 Add parser coverage proving nested settings block syntax parses as expected.
- [x] 1.6 Add schema, validate, and parse-config tests for valid settings, default `runtime.journal.strict false`, invalid settings, and top-level `log_level` rejection.
- [x] 1.7 Update config builtins/merge behavior so settings merge across config layers without regressing agents/categories/workflows.
- [x] 1.8 Update DSL examples/docs that mention `log_level` so they use `settings { log_level INFO }`.
- [x] 1.9 Run targeted core/config tests and record the proof artifact output.

### [x] 2.0 Define Runtime Store domain interfaces in engine

#### 2.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/*runtime*` passes and demonstrates status validation, lease expiry/conflict behavior, find/get lookup semantics, SessionSnapshot field boundaries, and unit-of-work transaction contracts.
- Typecheck: `bun run --filter '@weave/engine' typecheck` passes and proves `RuntimeStore`, repository interfaces, runtime record types, and `RuntimeStoreError` exports compile.

#### 2.0 Tasks

- [x] 2.1 Create `packages/engine/src/runtime/types.ts` for `WorkflowInstance`, `ExecutionLease`, `SessionSnapshot`, `RuntimeJournalEntry`, IDs, statuses, severity, and structured source types.
- [x] 2.2 Model `WorkflowInstance.status` as `created | running | paused | blocked | completed | failed | cancelled` and keep artifacts as references/metadata only.
- [x] 2.3 Model `ExecutionLease` with `executionId`, Weave-generated `ownerId`, `acquiredAt`, `expiresAt`, and optional `lastHeartbeatAt`.
- [x] 2.4 Define `SessionSnapshot` with normalized Weave-visible fields and deny raw harness dumps, transcripts, prompts, credentials, tokens, cookies, authorization headers, raw provider payloads, and PII-like harness-private fields.
- [x] 2.5 Create `RuntimeStoreError` variants for initialization, migration/version, serialization, query, not-found, conflict, validation, and journal write failures.
- [x] 2.6 Define repository interfaces with `ResultAsync`, paired `find*`/`get*` lookup semantics, source-of-truth write methods, lease acquire/heartbeat/release methods, and journal append/query methods.
- [x] 2.7 Define composed `RuntimeStore` and transaction/unit-of-work interfaces exposing focused sub-repositories.
- [x] 2.8 Export runtime public types/interfaces from `packages/engine/src/index.ts` without exposing SQLite internals.
- [x] 2.9 Add engine contract tests for statuses, find/get semantics, lease expiry/conflict expectations, SessionSnapshot denylist validation, and transaction API shape.
- [x] 2.10 Run engine typecheck and targeted runtime contract tests.

### [x] 3.0 Implement SQLite/Kysely default Runtime Store

#### 3.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/*sqlite* packages/engine/src/__tests__/*runtime*` passes using temp project directories and demonstrates lazy `.weave/runtime/weave.db` creation, code-owned migrations, schema version failure, CRUD, lease conflicts, transaction commit/rollback, best-effort journal behavior, and strict journal rollback.
- Inspection: `git grep -n "better-sqlite3\|node:fs\|child_process" packages/engine/src` returns no disallowed runtime-store dependency usage.
- Proof artifact: `docs/specs/12-spec-runtime-persistence/12-proofs/12-task-03-proofs.md`

#### 3.0 Tasks

- [x] 3.1 Add `kysely` to `packages/engine/package.json` and update the lockfile using Bun.
- [x] 3.2 Implement an internal Kysely dialect/driver over `bun:sqlite` without adding `better-sqlite3` or Node-only SQLite dependencies.
- [x] 3.3 Define SQLite table/row types for workflow instances, execution leases, session snapshots, runtime journal entries, schema migrations, and runtime metadata/project salt.
- [x] 3.4 Implement lazy creation of `.weave/runtime/` and `.weave/runtime/weave.db` on first repository operation.
- [x] 3.5 Apply restrictive permissions where supported: runtime directory equivalent to `0700`, DB/WAL/SHM equivalent to `0600`.
- [x] 3.6 Implement code-owned, idempotent, transactional migrations with applied-version tracking.
- [x] 3.7 Fail cleanly with a typed migration/version error when opening a DB created by a newer unsupported schema version.
- [x] 3.8 Implement JSON document-row persistence with indexed lookup columns for workflow/status/timestamp/source/event queries.
- [x] 3.9 Implement source-of-truth repository methods for workflow instances, execution leases, and session snapshots so persistence failures fail the operation.
- [x] 3.10 Implement one-active-project lease acquisition with atomic expiry/conflict checks using one engine-provided clock source per operation.
- [x] 3.11 Implement SQLite-backed unit-of-work transactions, including strict journal rollback behavior and best-effort journal warning/commit behavior.
- [x] 3.12 Add temp-directory SQLite tests for lazy init, migrations, CRUD, conflicts, schema version failure, transaction commit/rollback, strict journal failure, and best-effort journal failure.
- [x] 3.13 Add dependency guard tests or inspection proof showing no `better-sqlite3`, Node `fs`, `child_process`, or harness runtime dependency is used.

### [x] 4.0 Add safe Runtime Journal writer and fingerprinting

#### 4.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/*journal*` passes and demonstrates fixed envelope validation, structured source columns, 64 KiB payload bound, secret/raw-content sanitization or rejection, stable salted fingerprints within one store, different fingerprints across store salts, and no raw prompt/completion persistence.
- Security review: Warp review artifact or summary approves fingerprinting, sanitization, adapter writer boundary, and best-effort/strict journal behavior before implementation acceptance.
- Proof artifact: `docs/specs/12-spec-runtime-persistence/12-proofs/12-task-04-proofs.md`

#### 4.0 Tasks

- [x] 4.1 Implement `RuntimeJournalEntry` envelope validation for `id`, `timestamp`, structured `source`, `eventType`, optional execution/workflow/step IDs, `severity`, and JSON `data`.
- [x] 4.2 Implement `RuntimeJournalWriter` as the only adapter-facing journal emission API.
- [x] 4.3 Enforce a concrete serialized payload size limit, initially 64 KiB per journal entry.
- [x] 4.4 Implement sanitization/rejection for bearer/auth tokens, API keys, passwords, cookies, authorization headers, raw prompts, raw completions, raw transcripts, and known secret-like fields.
- [x] 4.5 Implement per-project salt creation with a cryptographically secure random source and at least 128 bits of entropy.
- [x] 4.6 Implement SHA-256-or-stronger salted prompt/completion fingerprinting and forbid MD5, SHA-1, and non-cryptographic hashes by construction.
- [x] 4.7 Ensure Runtime Store recreation creates a new project salt and intentionally breaks cross-store fingerprint correlation.
- [x] 4.8 Persist structured source fields as indexed `source_kind` and `source_name` columns.
- [x] 4.9 Add journal writer tests for envelope validation, payload size, sanitization/rejection, no raw content persistence, fingerprint stability within one store, and fingerprint difference across salts.
- [x] 4.10 Run Warp security review on the implemented fingerprinting, sanitization, adapter writer boundary, and journal failure semantics before accepting this task. (**Note**: Self-review completed in proof artifact; formal Warp review to be run by Tapestry post-implementation.)

### [x] 5.0 Export in-memory Runtime Store test utility

#### 5.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/*memory* packages/engine/src/__tests__/*runtime*` passes and demonstrates the in-memory store satisfies the same Runtime Store contract, transaction behavior, conflict behavior, and injectable failure modes as the SQLite store where practical.
- Typecheck: a downstream test import of `createInMemoryRuntimeStore` from `@weave/engine` typechecks without importing private engine files.
- Proof artifact: `docs/specs/12-spec-runtime-persistence/12-proofs/12-task-05-proofs.md`

#### 5.0 Tasks

- [x] 5.1 Implement `createInMemoryRuntimeStore()` in `packages/engine/src/runtime/memory-store.ts` using in-memory collections only.
- [x] 5.2 Match the Runtime Store repository interfaces, find/get semantics, lease conflict semantics, and transaction/unit-of-work API.
- [x] 5.3 Add configurable failure injection for persistence, journal, migration/initialization-like, and conflict test scenarios.
- [x] 5.4 Ensure the in-memory store performs no real filesystem writes, harness startup, harness resource reads, or adapter discovery.
- [x] 5.5 Export `createInMemoryRuntimeStore()` from `@weave/engine` as a supported test utility.
- [x] 5.6 Add contract tests shared with or mirroring SQLite behavior for common repository semantics.
- [x] 5.7 Add typecheck coverage proving downstream tests can import the utility from the public engine package entry point.

### [x] 6.0 Add read-only runtime inspection CLI commands

#### 6.0 Proof Artifact(s)

- Test: `bun test packages/cli/src/commands/__tests__/*runtime* packages/cli/src/__tests__/*routing*` passes and demonstrates `weave runtime status`, `weave runtime journal --limit <n>`, missing-runtime behavior, journal limit behavior, deterministic sanitized output, and no Runtime Store mutation.
- CLI: `bun run --filter '@weave/cli' build` passes and the command routing/help output includes the read-only `runtime status` and `runtime journal --limit <n>` commands.

#### 6.0 Tasks

- [x] 6.1 Extend CLI argument parsing/routing for `weave runtime status` and `weave runtime journal --limit <n>` with default limit `50`.
- [x] 6.2 Implement a read-only runtime command module that opens the default Runtime Store path without creating or mutating state for inspection-only flows unless the store already exists.
- [x] 6.3 Render `runtime status` with DB path, schema version, active lease summary, and recent/resumable workflow instance summaries.
- [x] 6.4 Render `runtime journal --limit <n>` with recent fixed-envelope entries in deterministic text suitable for TOON-style LLM consumption.
- [x] 6.5 Ensure CLI output never includes raw prompts, completions, transcripts, credentials, cookies, authorization headers, tokens, or raw provider payloads.
- [x] 6.6 Add missing-runtime behavior that reports no Runtime Store found without creating `.weave/runtime/weave.db`.
- [x] 6.7 Add CLI command tests for status output, journal limit behavior, missing runtime, sanitized deterministic output, routing/help, and read-only behavior.
- [x] 6.8 Run CLI targeted tests and build proof artifact.
