# Task 2 Proof Artifact — SDK-Backed Materialization

**Spec**: 20-spec-opencode-adapter-materialization  
**Task**: 2.0 Replace in-memory translation with real SDK-backed materialization  
**Date**: 2026-05-26  
**Status**: ✅ All acceptance criteria met

---

## Summary

Task 2 replaces the in-memory-only `translatedAgents.set(...)` path in
`spawnSubagent()` with a real SDK-backed `list → reconcile → create/update`
flow. The reconciliation logic lives in the new `reconcile-agent.ts` module.
`translatedAgents` is retained as a secondary read-only snapshot for test
inspection and transitional compatibility.

---

## Acceptance Criteria Evidence

### ✅ `spawnSubagent(descriptor)` uses the SDK-backed path

**Evidence**: `packages/adapters/opencode/src/index.ts` — `spawnSubagent()` now:
1. Translates the descriptor via `translateAgent()`.
2. Stores the translated config in `translatedAgents` (secondary artifact).
3. When a client is injected, calls `reconcileAgent(name, config, client)` which
   performs the full `list → reconcile → create/update` SDK flow.
4. Throws on reconciliation failure (including collision errors).

The comment `// SDK-backed materialization is task 2; task 1 only stores in memory`
that appeared in the task-1 test has been removed — the real path is now active.

### ✅ `list existing → reconcile decision → create/update call` flow implemented and documented

**Evidence**: `packages/adapters/opencode/src/reconcile-agent.ts` — new module
implementing the full reconciliation flow:

```
1. client.listAgents()          → fetch current OpenCode agent list
2. classifyExistingAgent()      → "create" | "update" | "collision"
3. tagWithOwnership()           → embed WEAVE_OWNERSHIP_TAG in description
4. client.createAgent() or      → write to OpenCode via SDK
   client.updateAgent()
5. err(CollisionError)          → returned when foreign agent blocks write
```

The module is fully documented with JSDoc and inline comments explaining the
ownership marker, reconciliation decisions, and first-slice constraints.

### ✅ `translatedAgents` narrowed — SDK path is primary

**Evidence**: `packages/adapters/opencode/src/index.ts` — the `translatedAgents`
map is retained with updated JSDoc:

> "The primary materialization path is the SDK-backed `reconcileAgent()` call
> inside `spawnSubagent()`. This map is a secondary artifact, not the source
> of truth for what is actually registered in OpenCode."

The map is populated regardless of SDK path success (after translation), making
it useful for test inspection without being the authoritative state.

### ✅ Tests pass with create/update materialization coverage

**Command**:
```
bun test packages/adapters/opencode/src/__tests__/adapter.test.ts
```

**Output**:
```
bun test v1.3.13 (bf2e2cec)
 30 pass
 0 fail
 63 expect() calls
Ran 30 tests across 1 file. [50ms]
EXIT: 0
```

**New test coverage added** (Task 2 specific):

| Test suite | Tests |
|---|---|
| `spawnSubagent() translation-only mode` | 3 tests — no client, no SDK calls |
| `spawnSubagent() SDK create path` | 5 tests — `createAgent()` called, config passed, tag applied, error thrown |
| `spawnSubagent() SDK update path` | 4 tests — `updateAgent()` called, config passed, tag preserved, error thrown |
| `spawnSubagent() collision path` | 2 tests — throws CollisionError, no create/update called |
| `spawnSubagent() listAgents failure` | 1 test — throws on list error |

### ✅ Sanitized manual smoke checklist exists

**Path**: `docs/specs/20-spec-opencode-adapter-materialization/20-smoke-checklist-task-02.md`

The checklist covers:
- Setup: minimal `.weave/config.weave` with a `smoke-test-agent`
- Verification: agent appears in OpenCode with `[weave-managed]` tag
- Idempotency: second run updates without error
- Collision protection: foreign agent triggers CollisionError

---

## Diff Summary

### `packages/adapters/opencode/src/index.ts`

- `spawnSubagent()` now calls `reconcileAgent()` after translation when a client is injected.
- Translation-only mode (no client) logs a warning and returns early — no SDK calls.
- `translatedAgents` JSDoc updated to clarify it is a secondary artifact.
- Exports added: `WEAVE_OWNERSHIP_TAG`, `classifyExistingAgent`, `reconcileAgent`, `tagWithOwnership`, `ReconcileAgentError`, `ReconcileDecision`.

### `packages/adapters/opencode/src/reconcile-agent.ts` (new)

- `WEAVE_OWNERSHIP_TAG` — ownership marker constant (`"[weave-managed]"`).
- `ReconcileAgentError` — discriminated union: `ListAgentsError | CreateAgentError | UpdateAgentError | CollisionError`.
- `ReconcileDecision` — `"create" | "update" | "collision"`.
- `classifyExistingAgent(name, existingAgents)` — pure function, no SDK calls.
- `tagWithOwnership(config)` — idempotent ownership tag injection.
- `reconcileAgent(name, config, client)` — primary `ResultAsync` entry point.

### `packages/adapters/opencode/src/__tests__/adapter.test.ts`

- Removed the task-1 test asserting no SDK calls during `spawnSubagent()`.
- Added `MockOpenCodeClient.setCreateAgentResult()` and `setUpdateAgentResult()` helpers.
- Added `makeWeaveManagedAgent()` and `makeForeignAgent()` fixture helpers.
- Added 15 new tests covering create, update, collision, listAgents failure, and translation-only paths.

---

## Quality Gates

| Gate | Result |
|---|---|
| `bun test packages/adapters/opencode/src/__tests__/adapter.test.ts` | ✅ 30 pass, 0 fail |
| `bun run typecheck` | ✅ All packages exit 0 |
| `bun test` (full suite) | ✅ 1706 pass, 0 fail |

---

## Smoke Checklist

See: [`20-smoke-checklist-task-02.md`](../20-smoke-checklist-task-02.md)

The checklist is sanitized for use with only `@weaveio/weave-adapter-opencode` enabled
(no legacy `weave` plugin). It covers the create, update, and collision paths
against a live OpenCode instance.
