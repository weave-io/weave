# Runtime Store

The Runtime Store is the engine-owned durable state boundary for workflow execution. It makes executions resumable and inspectable without making adapters own Weave product state.

**Related:** [Execution Lifecycle](execution-lifecycle.md) · [Permissions](permissions.md) · [ADR 0002](../adr/0002-runtime-persistence-store.md) · [Adapter Boundary](../architecture/adapter-boundary.md)

---

## Ownership

The engine owns runtime records and their transition rules. Adapters may submit normalized observations and lifecycle inputs, but they never receive a database handle or mutate runtime tables directly.

This is a narrow exception to the normal no-I/O engine rule: the engine may use Bun file and database APIs for Weave-owned state under `.weave/runtime/`. It may not inspect harness-owned storage.

## Default store

The default store is `.weave/runtime/weave.db`, backed by SQLite through an internal Kysely dialect over `bun:sqlite`.

- Initialization and code-owned migrations run lazily on the first repository operation.
- Unsupported future schema versions fail closed; Weave never attempts a downgrade.
- Runtime directories and files use restrictive permissions where the platform supports them.
- Database publication uses no-follow path handling, a bounded lock, a synced temporary image, and atomic rename.
- `createInMemoryRuntimeStore()` provides the same contract for isolated tests.

Never open or mutate `weave.db` from an adapter. Use the repositories or read-only CLI inspection commands.

## Repository surface

`RuntimeStore` composes focused repositories and a transaction boundary:

| Repository | Owns |
| --- | --- |
| Workflow instances | Workflow identity, current status, step state, and artifact references |
| Execution leases | The right for one owner to drive an execution |
| Session snapshots | Sanitized Weave-visible harness observations |
| Runtime journal | Diagnostic observations; never authoritative execution state |
| Usage | Idempotent detailed observations and durable aggregate rollups |

Permission persistence is associated with a concrete store internally. Adapters use `PermissionService`; they do not receive a public permission-repository mutation surface.

Public interfaces live in [`packages/engine/src/runtime/store.ts`](../../packages/engine/src/runtime/store.ts), with domain records in [`runtime/types.ts`](../../packages/engine/src/runtime/types.ts).

## Workflow state

A workflow instance has one of these statuses:

- `created`
- `running`
- `paused`
- `blocked`
- `completed`
- `failed`
- `cancelled`

The store keeps artifact references, revisions, integrity metadata, approval state, and consumed-revision records. It does not store artifact contents.

## Execution leases

An active lease identifies who may drive a workflow instance. The current implementation permits one active project execution.

- Acquisition and expiry checks are atomic.
- An unexpired foreign lease produces a typed conflict.
- Resume may replace an expired lease.
- Releasing a lease does not delete a session snapshot that observed it; the snapshot's lease reference becomes absent.

Settled child work and completed executions must release any capacity or lease they hold.

## Journal and snapshots

The Runtime Journal is observational. It cannot reconstruct or replace workflow state.

Journal entries use a fixed envelope, bounded JSON data, and an engine-provided `RuntimeJournalWriter`. Journal writes are best-effort by default; `settings.runtime.journal.strict` makes a correlated journal failure roll back the enclosing unit of work.

Session snapshots contain normalized Weave-visible fields only. They are not raw harness dumps or transcripts.

## Privacy and integrity

Runtime persistence must never contain:

- raw prompts, completions, transcripts, or tool results
- API keys, credentials, cookies, authorization headers, or tokens
- raw provider payloads or harness-private session state
- artifact contents

The journal may store salted SHA-256 fingerprints. Each project has its own random salt, so fingerprints are not comparable across stores.

All journal and snapshot inputs pass through the sanitizers in [`packages/engine/src/runtime/sanitizer.ts`](../../packages/engine/src/runtime/sanitizer.ts).

## Retention and usage

Retention is bounded by age and count. One serialized task prunes old journal and detailed usage rows at activation and safe write/time thresholds. Detailed usage pruning never subtracts durable rollups.

Usage observations are idempotent by stable ID:

- replaying the same normalized observation is a no-op;
- reusing an ID with different values is an invariant failure;
- insert and rollup update are atomic;
- missing counters stay absent rather than becoming zero.

See [`retention.ts`](../../packages/engine/src/runtime/retention.ts), [`usage.ts`](../../packages/engine/src/runtime/usage.ts), and [`log-sink.ts`](../../packages/engine/src/runtime/log-sink.ts).

## Failure contract

Every fallible store operation returns `ResultAsync<…, RuntimeStoreError>`. Absence is either `null` from a `find*` method or a typed `NotFound` result from a required lookup. Persistence failures are never swallowed for authoritative workflow, lease, or snapshot writes.

Tests for the in-memory and SQLite implementations assert the same behavioral contract. Start with [`packages/engine/src/__tests__/`](../../packages/engine/src/__tests__) and [`packages/engine/src/runtime/sqlite/store.ts`](../../packages/engine/src/runtime/sqlite/store.ts) when changing it.
