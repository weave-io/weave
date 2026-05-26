# Task 3 Proof Artifact — Safe Reconciliation with Canonical Identity and Ownership Checks

**Spec**: 20-spec-opencode-adapter-materialization  
**Task**: 3.0 Implement safe reconciliation using canonical agent identity and ownership checks  
**Date**: 2026-05-26  
**Status**: ✅ All acceptance criteria met

---

## Summary

Task 3 hardens the reconciliation module introduced in Task 2 by adding a
dedicated, focused test suite that proves canonical-identity semantics,
ownership-check behavior, and the upsert-only first-slice constraint. The
`reconcile-agent.ts` implementation was already complete from Task 2; this
task adds the required `reconcile-agent.test.ts` coverage and verifies all
acceptance criteria explicitly.

---

## Acceptance Criteria Evidence

### ✅ `reconcile-agent.ts` encapsulates upsert-only reconciliation rules

**Evidence**: `packages/adapters/opencode/src/reconcile-agent.ts` — the module
encapsulates the full `list → classify → tag → create/update` flow with no
delete, prune, or forced-takeover operations. The module header documents the
first-slice constraints explicitly:

> "Upsert-only: no automatic delete, prune, or forced takeover."
> "Collision errors are returned as typed `Result` values — callers decide how to surface them."

The `MockOpenCodeClient` used in tests has no `deleteAgent` method — any
attempt to call a delete operation would fail at compile time.

### ✅ Matching/durable identity uses `descriptor.name` only; display metadata is not identity

**Evidence**: `classifyExistingAgent(agentName, existingAgents)` in
`reconcile-agent.ts` — the function uses `Array.prototype.find` with
`a.name === agentName` as the sole predicate. No other field (`displayName`,
`description`, `model`, etc.) participates in the identity check.

Test coverage in `reconcile-agent.test.ts`:

| Test | Assertion |
|---|---|
| `"matches by name only — different description does not affect identity"` | Same name + different description → still `"update"` |
| `"displayName field does not affect identity classification"` | Different `displayName` → still `"update"` |
| `"description content (other than ownership tag) does not affect identity"` | Any description text → identity is name only |
| `"name match is case-sensitive (exact match required)"` | `"My-Agent"` ≠ `"my-agent"` → `"create"` |

### ✅ Updates require explicit Weave ownership; same-named foreign agents return collision errors

**Evidence**: `classifyExistingAgent` checks `description.includes(WEAVE_OWNERSHIP_TAG)` after a name match. If the tag is absent, the decision is `"collision"`. `reconcileAgent` returns `err({ type: "CollisionError", ... })` without calling `createAgent()` or `updateAgent()`.

Test coverage:

| Test | Assertion |
|---|---|
| `"returns CollisionError when a foreign agent with the same name exists"` | `result.error.type === "CollisionError"` |
| `"CollisionError includes the agent name"` | `result.error.agentName === "foreign-agent"` |
| `"CollisionError message is human-readable"` | Message contains agent name |
| `"does NOT call createAgent() on collision"` | `createAgentCalls.length === 0` |
| `"does NOT call updateAgent() on collision"` | `updateAgentCalls.length === 0` |
| `"returns CollisionError for agent with no description"` | No description → no tag → collision |

### ✅ First-slice behavior is upsert-only — no automatic delete/prune/forced takeover

**Evidence**: `reconcileAgent` only ever calls `client.createAgent()` or
`client.updateAgent()`. There is no code path that calls any delete or prune
operation. The `MockOpenCodeClient` interface has no delete method, enforcing
this at the type level.

Test coverage:

| Test | Assertion |
|---|---|
| `"never deletes agents not in the current descriptor set"` | Only `agent-a` updated; `agent-b`, `agent-c` untouched |
| `"does not prune stale Weave-managed agents"` | `new-agent` created; `stale-agent` untouched |
| `"does not delete or prune foreign agents (upsert-only constraint)"` | Collision → no create/update; foreign agent left in place |

### ✅ `bun test packages/adapters/opencode/src/__tests__/reconcile-agent.test.ts` passes

**Command**:
```
bun test packages/adapters/opencode/src/__tests__/reconcile-agent.test.ts
```

**Output**:
```
bun test v1.3.13 (bf2e2cec)
 42 pass
 0 fail
 73 expect() calls
Ran 42 tests across 1 file. [9.00ms]
```

**Test suites and coverage**:

| Suite | Tests | What it proves |
|---|---|---|
| `WEAVE_OWNERSHIP_TAG` | 2 | Constant is a non-empty, human-readable string |
| `classifyExistingAgent — canonical identity` | 7 | Name-only identity; case-sensitive; no-description → collision |
| `classifyExistingAgent — display metadata is not identity` | 2 | `displayName` and description content are not identity |
| `tagWithOwnership` | 6 | Appends tag; idempotent; no mutation; undefined description handled |
| `reconcileAgent — create path` | 6 | Creates when absent; uses canonical name; tags config; ok/err propagation |
| `reconcileAgent — update path` | 7 | Updates when Weave-managed; uses canonical name; preserves tag; no double-tag; ok/err propagation |
| `reconcileAgent — collision path` | 7 | CollisionError returned; no create/update; no delete/prune |
| `reconcileAgent — listAgents failure` | 2 | ListAgentsError propagated; no create/update called |
| `reconcileAgent — first-slice upsert-only constraint` | 2 | Other agents untouched; stale agents not pruned |

---

## Full Adapter Test Suite

**Command**:
```
bun test packages/adapters/opencode/src/__tests__/
```

**Output**:
```
bun test v1.3.13 (bf2e2cec)
 80 pass
 0 fail
 170 expect() calls
Ran 80 tests across 3 files. [67.00ms]
```

---

## Quality Gates

| Gate | Command | Result |
|---|---|---|
| Reconcile-agent tests | `bun test packages/adapters/opencode/src/__tests__/reconcile-agent.test.ts` | ✅ 42 pass, 0 fail |
| Full adapter tests | `bun test packages/adapters/opencode/src/__tests__/` | ✅ 80 pass, 0 fail |
| Typecheck | `bun run typecheck` | ✅ All packages exit 0 |

---

## Files Changed

| File | Change |
|---|---|
| `packages/adapters/opencode/src/__tests__/reconcile-agent.test.ts` | **New** — 42 tests covering create, update, collision, listAgents failure, and upsert-only constraint |
| `docs/specs/20-spec-opencode-adapter-materialization/20-proofs/20-task-03-proofs.md` | **New** — this proof artifact |
| `docs/specs/20-spec-opencode-adapter-materialization/20-tasks-opencode-adapter-materialization.md` | Updated — Task 3 subtasks marked `[x]`, parent marked `[x]` |

The `reconcile-agent.ts` implementation was already complete from Task 2 and
required no changes for Task 3.
