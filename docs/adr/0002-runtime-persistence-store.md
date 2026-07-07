# ADR 0002: Runtime Persistence Store

**Status**: Accepted  
**Date**: 2026-05-20  
**Related**: [Runtime Persistence Spec](../specs/12-spec-runtime-persistence/12-spec-runtime-persistence.md) · [Adapter Boundary](../adapter-boundary.md) · [Context Glossary](../../CONTEXT.md) · [Issue #50](https://github.com/weave-io/weave/issues/50)

---

## Context

Weave needs durable runtime state so workflow execution can be resumed, inspected, and debugged across agent, harness, or process interruptions. The original direction for issue #50 proposed Weave-owned filesystem persistence under `.weave/runtime/**`, JSONL runtime events, repository interfaces, and best-effort event logging.

During design review, that plan changed in several important ways:

1. JSONL is easy to append and inspect, but it weakens queryability and makes state+journal atomicity awkward once the Runtime Store includes leases and workflow records.
2. Direct Bun SQLite access is dependency-light, but the project prefers a type-safe query layer with repositories hiding storage details.
3. Runtime persistence is Weave product state, not harness state, so the engine needs a narrow, documented exception to the usual “engine does not own filesystem side effects” boundary.
4. Prompt and completion content can contain secrets or private project data, so runtime diagnostics must not become a transcript archive.
5. Introducing runtime persistence settings exposed the need for a single `settings` block rather than more top-level scalar settings.

---

## Decision

Weave will provide a default SQLite-backed **Runtime Store** under `.weave/runtime/weave.db`, owned by `@weaveio/weave-engine` and accessed through repository interfaces.

Key constraints:

- **Engine-owned runtime space.** `.weave/runtime/**` is Weave-owned product state. The engine may perform Bun filesystem/database I/O only inside this runtime space. Harness-owned resources remain adapter-owned.
- **One SQLite database.** The default store uses one project-local SQLite database at `.weave/runtime/weave.db` for `WorkflowInstance`, `ExecutionLease`, `SessionSnapshot`, Runtime Journal, schema metadata, and runtime store metadata such as the project salt.
- **Kysely with an internal Bun SQLite dialect.** The default implementation uses Kysely as the type-safe query builder, plus a small Weave-owned `bun:sqlite` dialect/driver. We will not add `better-sqlite3`, Drizzle, Prisma, or a migration CLI for runtime persistence.
- **Repository pattern.** Engine callers depend on a composed `RuntimeStore` interface with focused sub-repositories and a unit-of-work transaction API. Adapters may inject alternative stores through interfaces, but must not mutate runtime state directly.
- **Code-owned migrations.** Runtime DB migrations are versioned engine code and run lazily on first repository operation. Users do not run a setup or migration command for `.weave/runtime/weave.db`.
- **Document-row schema.** Complex records are stored as JSON documents with selected indexed columns for lookup, conflict detection, and inspection.
- **Execution leases.** A valid `ExecutionLease` is the active execution pointer. Issue #50 enforces one active lease per project while keeping the schema tied to execution IDs so future multiple-active execution support can relax that constraint.
- **Runtime Journal is observational.** The journal is not event sourcing and is not the source of truth. Current state comes from repositories.
- **Split failure semantics.** Source-of-truth writes fail operations. Runtime Journal writes are best-effort by default, but strict journal mode can make journal failures fail/rollback the unit of work.
- **No raw prompt or completion content.** The Runtime Journal stores salted SHA-256-class content fingerprints only, never full prompt/completion text. The per-project salt is generated with a cryptographically secure random source and is intentionally local to one Runtime Store.
- **Breaking settings migration.** Runtime settings live under a new `settings` block. `log_level` moves from top-level `log_level INFO` to `settings { log_level INFO }`; top-level `log_level` is no longer valid after this migration.

---

## Consequences

### What changes

- `@weaveio/weave-engine` gains runtime persistence domain types, repository interfaces, a SQLite/Kysely default store, an in-memory store for tests, and a narrow adapter-facing Runtime Journal writer.
- `@weaveio/weave-core` gains the `settings` DSL/config shape needed for `settings.log_level` and `settings.runtime.journal.strict`.
- The CLI gains minimal read-only Runtime Store inspection commands: `weave runtime status` and `weave runtime journal --limit <n>`.
- `.weave/runtime/` remains ignored by Git and is created lazily on first runtime write/open.

### What is now possible

- `/start-work` and future lifecycle services can resume from durable `WorkflowInstance` records instead of relying on chat context.
- Concurrent sessions can safely detect an existing active execution via `ExecutionLease` conflicts.
- State changes and journal observations can commit together when strict journal mode requires it.
- Tests and adapters can use `RuntimeStore` interfaces without depending on the default SQLite implementation.

### Trade-offs accepted

- SQLite makes runtime state less inspectable than JSONL without a CLI, so issue #50 includes minimal read-only inspection commands.
- Kysely does not ship an official Bun SQLite dialect in the documented happy path, so Weave must own and test a small internal dialect/driver over `bun:sqlite`.
- A breaking `settings` migration increases schema/test scope, but avoids entrenching more top-level settings.
- Salted fingerprints allow local prompt/completion correlation but intentionally prevent storing or reconstructing content. If the Runtime Store is deleted and recreated, a new salt is generated and old fingerprints no longer correlate with new fingerprints.

### What is deferred

- Full lifecycle orchestration (`startExecution`, `resumeExecution`, `dispatchStep`, `completeStep`) remains in issue #44/follow-up work.
- Multiple concurrent active executions remain out of scope for issue #50.
- Runtime Journal retention/pruning, export, cleanup, and rich filtering are deferred.
- Configurable runtime DB paths are deferred; issue #50 uses `.weave/runtime/weave.db`.
