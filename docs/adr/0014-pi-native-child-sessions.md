# ADR 0014 — Pi Native Child Sessions

**Status:** Accepted

**Supersedes:** [ADR 0013](0013-pi-private-child-sessions.md) for child-history storage, layout, migration, quotas, and pruning. ADR 0013 remains in force for adapter ownership of child discovery, transport, rendering, steering, recovery scope, and the engine privacy boundary.

**Related:** [Spec 33 — Pi Adapter](../specs/33-spec-pi-adapter/33-spec-pi-adapter.md) · [Pi Adapter](../adapters/pi.md) · [Adapter Boundary](../architecture/adapter-boundary.md) · Issue #21

## Context

ADR 0013 placed persistent child history in an adapter-owned JSONL store at `child-history/<parent-session-id>/`, with a V1 index, per-child checkpoints, quotas, trimming, and orphan pruning. That store duplicated data Pi already persists in its own session format, and it forced the adapter to reimplement transcript storage, compaction, and corruption handling that the host already provides.

Pi now exposes persistent v3 sessions that the adapter can create, restore, append to, and read through the host API, including a custom session directory, a `parentSession` link, and entry/tree reads. A child can therefore be a real Pi session rather than a private transcript file. This removes a whole storage stack from the adapter and makes child transcripts render with native fidelity.

Two constraints shape the design. First, child sessions must not pollute Pi's default session tree or appear in `/resume`; a user resuming work must see their own sessions, not delegation internals. Second, the engine must keep owning nothing about Pi sessions, so every new concept here stays inside the Pi adapter.

## Decision

Pi remains the session identity and format authority. The adapter calls Pi 0.84.1's `SessionManager.create`, validates the generated path and v3 header, exclusively persists that exact header because Pi defers its first write, then calls `SessionManager.open` and revalidates the session ID, parent, working directory, path, and persistence. This bridge does not fabricate a v3 or fork header.

The RPC child receives both `--session <validated-file>` and `--session-dir <validated-directory>`. The adapter removes inherited `PI_CODING_AGENT_SESSION_DIR`; the explicit CLI directory cannot be redirected by Pi settings or environment state. Ordinary delegated children and direct workflow children use this same persistent lifecycle. Pi assistant `stopReason` and `errorMessage` are authoritative terminal state; stderr and process exit are secondary.

1. **Native child sessions.** Each delegated child runs in a persistent native Pi v3 session. Child sessions live under `$XDG_DATA_HOME/weave/adapters/pi/sessions/`, defaulting to `~/.local/share/weave/adapters/pi/sessions/`. The adapter-owned JSONL child-history store, its V1 index, its checkpoints, its quotas, and its trimming are removed.

2. **Isolation.** The child session directory is separate from Pi's default session tree. Child sessions are never offered by Pi's `/resume` and are not intended for manual native Pi CLI access. They are reachable only through Weave's own surfaces.

3. **Parent link.** Every child session records the originating parent session through Pi's `parentSession` link. The link is set at creation and is immutable for the life of the session.

4. **Parent refs are observations.** The parent session carries bounded custom entries that reference its children. These refs are observation-only metadata: identity, lifecycle status, and enough detail to find and label a child. They are validated and origin-immutable, and they are never recovery authority. A ref may not be used to reconstruct or re-authorize a child on its own.

5. **Authority chain.** Parent session entries and child session files are the authority. Anything else is derivative and must be reconstructible from them.

6. **Metadata-only cache.** Discovery uses a SQLite cache that stores metadata only — no transcripts and no parent content. The cache is fully rebuildable from the authoritative sources. Cache loss, corruption, or schema drift degrades discovery speed and must not block delegation, inspection, or execution; the adapter rebuilds instead of failing.

7. **Explicit cleanup and tombstones.** Child sessions are removed only by an explicit user or operator cleanup action. Cleanup appends a tombstone entry so the parent record stays truthful about a child that no longer has a session file. There is no automatic pruning, no age-based expiry, and no quota-driven deletion.

8. **No migration.** There is no migration from the JSONL V1 child-history store. Existing JSONL history becomes unreadable by Weave, and Weave does not read, convert, quarantine, or delete it. Users who want the old data must handle it outside Weave.

9. **Persistent parent required.** A parent running without a persistent session (for example `--no-session`) cannot hold child refs and cannot own native child sessions. Delegation in that case fails closed with `PersistentParentSessionRequired` rather than silently creating unattached children.

10. **Fork/clone ref-origin rejection.** When a parent session is forked, cloned, or otherwise copied, the copied child refs no longer match their recorded origin. The adapter rejects those refs instead of adopting children it does not own. Rejected refs are reported, not silently dropped in a way that implies ownership.

11. **Boundary unchanged.** All of the above is Pi adapter state. The engine does not scan, parse, own, or recover Pi child sessions, and the normative details — paths, permissions, entry shapes, cache schema, failure codes, commands — stay in Spec 33. The adapter requires canonical immediate-child equality, private `0700` directories, regular `0600` leaves, and no caller-supplied path. Health, status, CLI, lifecycle, logs, Runtime Store data, and model output never receive a session path.

12. **Readiness.** Native-session readiness is not a public descriptor capability. Before delegation or deletion, the adapter proves the real Pi create/open API, private root, and process surface. Failure enters health-only mode with one path-free reason: `pi-session-api-unavailable`, `pi-session-root-unavailable`, `pi-session-root-unsafe`, or `pi-process-unavailable`. Read routes remain read-only.

## Consequences

- The adapter deletes a substantial storage stack and inherits Pi's session durability, format evolution, and entry semantics instead of maintaining its own.
- Child transcripts gain native fidelity because they are native sessions, read through the host API rather than a bespoke transcript format.
- Isolation keeps Pi's `/resume` list meaningful, at the cost of children being unreachable through plain Pi CLI workflows.
- Because refs are observation-only and the cache is derivative, a damaged cache or a mismatched ref degrades visibility but never corrupts execution or authorizes a wrong child.
- No automatic pruning means child sessions accumulate until a user cleans them up. Disk growth is a documented user-managed concern, and cleanup surfaces must be discoverable.
- The no-migration decision is a one-way break: anyone upgrading loses Weave-side access to prior child history. This is accepted because the old store was inspection data, not durable workflow state, and because Weave leaves the files in place.
- `PersistentParentSessionRequired` makes some previously attempted delegations fail early. That is preferred over creating children with no owner and no path back to them.
- Fork/clone rejection means duplicated sessions start with no visible children rather than with borrowed ones.
- Other harness adapters are unaffected; native child sessions are a Pi adapter decision, not a core or engine contract.
