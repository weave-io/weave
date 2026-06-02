# Task 1.0 Proof Artifact — Formalize the Workflow-First Execution Boundary

**Spec**: [Spec 22 — Workflow-First Execution](../22-spec-workflow-first-execution.md)  
**Task file**: [22-tasks-workflow-first-execution.md](../22-tasks-workflow-first-execution.md)  
**ADR**: [ADR 0004 — Workflow-First Execution Contract](../../../adr/0004-workflow-first-execution-contract.md)  
**Date**: 2026-06-02  
**Status**: Complete — all sub-tasks 1.1–1.4 verified

---

## Task Summary

Parent task 1.0 formalizes the workflow-first execution boundary in the Weave engine. The goal is to make durable execution an explicit, engine-owned, user-authorized contract — replacing the legacy OpenCode-specific `/start-work` → Tapestry flow that could silently resume execution on `session.idle` events.

Sub-tasks completed:

| Sub-task | Title | Status |
| --- | --- | --- |
| 1.1 | Author companion ADR and link from surrounding docs | ✅ Complete |
| 1.2 | Add explicit execution operations and `inspectExecution` | ✅ Complete |
| 1.3 | Enforce `ExecutionAuthorizationSource` fail-closed checks | ✅ Complete |
| 1.4 | Extend engine tests for implicit-execution prohibition | ✅ Complete |

---

## What This Task Proves

Task 1.0 proves **Spec 22 Unit 1**: the execution boundary is explicit, engine-owned, and harness-agnostic. Specifically:

1. **ADR 0004 exists and is linked** — the companion ADR records why explicit workflow execution replaces legacy `/start-work` → Tapestry semantics and is cross-linked from `docs/adapter-boundary.md`, `CONTEXT.md`, and Spec 22.
2. **Execution operations are modeled explicitly** — `ExecutionOperationKind` (`start`, `resume`, `pause`, `inspect`, `advance`) and `ExecutionAuthorizationSource` (`user`, `agent`, `hook`, `event`) are typed discriminated unions in `packages/engine/src/execution-lifecycle.ts`. `observeSession` and `beforeTool` are explicitly NOT execution operations.
3. **Fail-closed authorization is enforced** — `startExecution` and `resumeExecution` reject any `authorizationSource` other than `"user"` with a typed `policy_decision` error. Agents, hooks, and events cannot self-start durable execution.
4. **Tests prove the boundary** — `execution-lifecycle.test.ts` and `runtime-contract.test.ts` together prove that ordinary conversation, idle hooks, continuation hooks, and `observeSession` calls cannot create `WorkflowInstance` records or acquire `ExecutionLease` records.

---

## Evidence Summary

| Evidence | Result | Notes |
| --- | --- | --- |
| `bun run lint` | ❌ FAILED | 2 pre-existing errors in `packages/cli/src/commands/init.ts` (unrelated); 105 fixable warnings. Engine files clean. |
| `bun run validate-config` | ✅ PASSED | `agents: 2, categories: 5, workflows: 0, disabled: 0, log_level: INFO` |
| `bun run typecheck` | ❌ FAILED | 3 pre-existing CLI errors in `packages/cli/src/commands/init.ts` (duplicate `validationResult`, missing `migratedContent`). Engine files not implicated. |
| `bun run build` | ⚠️ PARTIAL | `@weave/core`, `@weave/engine`, `@weave/config` built successfully. Failed in `@weave/cli` on the same pre-existing `init.ts` issue. |
| Task-specific tests | ✅ PASSED | `344 pass, 0 fail, 1119 expect() calls` |
| Broader package tests | ✅ PASSED | `@weave/core` (224), `@weave/engine` (1062), `@weave/config` (358), `@weave/adapter-opencode` (202). Hung in `@weave/cli` on pre-existing parse error. |

**Pre-existing blocker note**: All failures and hangs are caused by a pre-existing parse/redeclaration error in `packages/cli/src/commands/init.ts` (`noInvalidUseBeforeDeclaration` at 1228:7, `noRedeclare` at 1240:9). This file is outside the scope of task 1.0. Engine, core, config, and adapter-opencode packages are clean.

**Workspace root note**: The correct project root for this worktree is `docs/spec-workflow-execution-dsl`. Running targeted Bun test commands from this root produces clean results. Running from a sibling directory may pull in unrelated files.

---

## Artifact 1 — ADR 0004 (Companion ADR)

**File**: [`docs/adr/0004-workflow-first-execution-contract.md`](../../../adr/0004-workflow-first-execution-contract.md)

### Context

ADR 0004 records the architectural decision to replace the legacy `/start-work` → Tapestry flow with an engine-owned, harness-agnostic execution contract. It documents:

- The three structural problems with the legacy model (OpenCode-specific, implicit start, semantics in adapter)
- The five decisions that define the new model (engine-owned contract, explicit user-authorized transition, adapters as delivery layers, legacy flow superseded, state grounded in Runtime Store)
- The consequences: what changes, what is now possible, what is now forbidden, what is deferred
- An ownership matrix covering all execution-contract concerns

ADR 0004 is cross-linked from:
- `docs/adapter-boundary.md` — Execution Lifecycle Surface section
- `CONTEXT.md` — Execution Contract and Workflow-First Execution glossary entries
- `docs/specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md` — normative spec

### Evidence

ADR 0004 exists at `docs/adr/0004-workflow-first-execution-contract.md` with status `Accepted` and date `2026-06-02`. Key sections verified:

- **Decision 2** (lines 48–60): "Durable execution begins only through an explicit, user-authorized transition. The engine enforces this through `startExecution`... The following paths are explicitly forbidden from implicitly starting durable execution: Ordinary Loom conversation, Session idle events or idle hooks, Continuation hooks or compaction recovery, Lifecycle observations (`observeSession`), Agent-initiated self-start."
- **Decision 4** (lines 76–82): "The `/start-work` → Tapestry flow is a legacy OpenCode-specific delivery path. It is not the architectural center of execution in the harness-agnostic successor."
- **Ownership Matrix** (lines 134–144): Engine owns execution contract definition, `WorkflowInstance`/`ExecutionLease` lifecycle, and explicit execution boundary enforcement. Adapters own harness-specific trigger delivery and capability declaration.

---

## Artifact 2 — `execution-lifecycle.ts` (Engine Types and Enforcement)

**File**: [`packages/engine/src/execution-lifecycle.ts`](../../../../packages/engine/src/execution-lifecycle.ts)

### Context

This file is the primary runtime surface for the execution contract. Sub-tasks 1.2 and 1.3 added:

- **`ExecutionOperationKind`** (lines 1016–1030): Discriminated union `"start" | "resume" | "pause" | "inspect" | "advance"` with `EXECUTION_OPERATION_KINDS` constant. Explicitly documents that `observeSession` and `beforeTool` are NOT execution operations.
- **`ExecutionAuthorizationSource`** (lines 1073–1081): Discriminated union `"user" | "agent" | "hook" | "event"` with `EXECUTION_AUTHORIZATION_SOURCES` constant.
- **`validateAuthorizationSource`** (lines 1100–1113): Returns `ok(undefined)` only for `"user"`; returns a typed `policy_decision` error for `"agent"`, `"hook"`, or `"event"`, naming the forbidden source and referencing ADR 0004.
- **`inspectExecution`**: Read-only lifecycle method returning a point-in-time snapshot of `WorkflowInstance` state without creating instances, acquiring leases, or emitting effects.
- **`observeSession` boundary comment** (lines 1210–1222): Explicit invariant documentation stating `observeSession` NEVER creates a `WorkflowInstance`, acquires an `ExecutionLease`, transitions instance status, or emits `LifecycleEffect` values.

### Evidence

File header (lines 1–54) documents all 8 lifecycle methods and explicitly distinguishes execution operations from observation operations. `startExecution` and `resumeExecution` both carry JSDoc `@authorizationSource` requirements referencing ADR 0004.

---

## Artifact 3 — `execution-lifecycle.test.ts` (Boundary Tests)

**File**: [`packages/engine/src/__tests__/execution-lifecycle.test.ts`](../../../../packages/engine/src/__tests__/execution-lifecycle.test.ts)

### Context

Sub-task 1.4 extended this test file to prove that ordinary conversation, idle hooks, continuation hooks, and `observeSession` calls cannot implicitly start durable execution. The test file covers:

- `ExecutionOperationKind` discriminated union — all 5 kinds accepted, `observeSession`/`beforeTool` excluded
- `ExecutionAuthorizationSource` — `"user"` accepted; `"agent"`, `"hook"`, `"event"` rejected with `policy_decision` errors
- `validateAuthorizationSource` — fail-closed behavior for all non-user sources
- `observeSession` boundary — calling `observeSession` does not create `WorkflowInstance` or `ExecutionLease` records
- `inspectExecution` — read-only; does not modify state
- Agent-initiated self-start paths — all rejected

### Evidence

```
bun test packages/engine/src/__tests__/execution-lifecycle.test.ts \
         packages/engine/src/__tests__/runtime-contract.test.ts

344 pass, 0 fail, 1119 expect() calls
```

Command run from project root `docs/spec-workflow-execution-dsl`. All 344 assertions pass with zero failures.

---

## Artifact 4 — `runtime-contract.test.ts` (Runtime Store Contract Tests)

**File**: [`packages/engine/src/__tests__/runtime-contract.test.ts`](../../../../packages/engine/src/__tests__/runtime-contract.test.ts)

### Context

This test file proves that `WorkflowInstance` and `ExecutionLease` records are created or advanced only through explicit user-authorized execution transitions. It uses in-memory stub implementations of `WorkflowInstanceRepository`, `ExecutionLeaseRepository`, `SessionSnapshotRepository`, and `RuntimeJournalRepository` — no real harness, no real SQLite, no real file I/O.

Key coverage:
- `WorkflowInstance` type shape and status transitions (`created`, `running`, `paused`, `completed`, `failed`, `blocked`)
- `ExecutionLease` type shape and lease acquisition
- `ExecutionAuthorizationSource` — `validateAuthorizationSource` rejects all non-user sources
- `EXECUTION_AUTHORIZATION_SOURCES` constant completeness
- Runtime Store error discriminants (`conflict`, `not_found`, `validation`, `persistence`, `initialization`, `migration_version`, `serialization`, `journal_write`)

### Evidence

Included in the combined test run above: `344 pass, 0 fail, 1119 expect() calls`.

---

## Artifact 5 — `docs/adapter-boundary.md` (Execution Lifecycle Surface)

**File**: [`docs/adapter-boundary.md`](../../../adapter-boundary.md)

### Context

Sub-task 1.1 added the Execution Lifecycle Surface section to `docs/adapter-boundary.md`. This section explains that adapters expose the Spec 22 Unit 1 engine contract through harness-specific commands, skills, hooks, scripts, or UI without moving semantics into the adapter.

The file's Related links header includes `[Spec 22 — Workflow-First Execution]` and `[ADR 0004 — Workflow-First Execution Contract]`, cross-linking the boundary doc to the normative spec and ADR.

### Evidence

`docs/adapter-boundary.md` line 8 (Related links) includes both Spec 22 and ADR 0004 references. The Execution Lifecycle Surface section documents the adapter's role as a delivery layer that maps harness-specific triggers into `StartExecutionInput` and calls the engine lifecycle method — the engine validates, creates the `WorkflowInstance`, acquires the `ExecutionLease`, and returns typed effects.

---

## Artifact 6 — `CONTEXT.md` (Glossary Updates)

**File**: [`CONTEXT.md`](../../../../CONTEXT.md)

### Context

Sub-task 1.1 updated `CONTEXT.md` with workflow-first execution glossary entries. Key entries verified:

- **Execution Contract** (line 162): "The Execution Contract is engine-owned and harness-agnostic. `startExecution` is the sole authorized entry point for durable execution — ordinary Loom conversation, session idle events, continuation hooks, and lifecycle observations (`observeSession`) are explicitly forbidden from implicitly starting durable execution."
- **Execution boundary** (line 432): Full boundary invariant with ADR 0004 reference.
- **ExecutionOperationKind** (line 52): Documents the 5 explicit operation kinds and explicitly excludes `observeSession` and `beforeTool`.
- **inspectExecution** (line 56): Documents read-only behavior.

---

## Reviewer Conclusion

All four proof artifacts required by the task file's `1.0 Proof Artifact(s)` section are present and verified:

| Required Proof | Status | Evidence |
| --- | --- | --- |
| ADR 0004 records why explicit workflow execution replaces legacy `/start-work` → Tapestry | ✅ | `docs/adr/0004-workflow-first-execution-contract.md` — Accepted, dated 2026-06-02, cross-linked |
| `bun test execution-lifecycle.test.ts` passes proving Spec 22 Unit 1 boundary | ✅ | 344 pass, 0 fail, 1119 expect() calls |
| `bun test runtime-contract.test.ts` passes proving `WorkflowInstance`/`ExecutionLease` only via explicit transitions | ✅ | Included in same 344-pass run |
| `docs/adapter-boundary.md` explains adapters expose the contract without owning semantics | ✅ | Execution Lifecycle Surface section present; Spec 22 and ADR 0004 cross-linked |

**Repository-wide CLI failures** (`packages/cli/src/commands/init.ts` — `noInvalidUseBeforeDeclaration` at 1228:7, `noRedeclare` at 1240:9) are pre-existing blockers outside this task's scope. They affect `bun run lint`, `bun run typecheck`, `bun run build`, and `bun run test` at the workspace level but do not implicate any engine, core, config, or adapter-opencode file touched by task 1.0.

Task 1.0 is complete. All sub-tasks 1.1–1.4 are verified. The workflow-first execution boundary is formalized, documented, enforced, and tested.
