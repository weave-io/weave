# Task 6.0 Proof Artifact — Adapter Readiness and Delivery Alignment

**Spec**: [Spec 22 — Workflow-First Execution](../22-spec-workflow-first-execution.md)  
**Task file**: [22-tasks-workflow-first-execution.md](../22-tasks-workflow-first-execution.md)  
**ADR**: [ADR 0004 — Workflow-First Execution Contract](../../../adr/0004-workflow-first-execution-contract.md)  
**Date**: 2026-06-03  
**Status**: Complete — parent task 6.0 verified

---

## Task Summary

Parent task 6.0 aligns adapter readiness and delivery with canonical execution commands (Spec 22 Unit 4). It was delivered across four sub-tasks:

| Sub-task | Title | Status |
| --- | --- | --- |
| 6.1 | Document `command-entrypoints` as canonical execution-entry capability | ✅ Complete |
| 6.2 | Update engine readiness/profile logic and tests for command and non-command harnesses | ✅ Complete |
| 6.3 | Update OpenCode adapter delivery tests and documentation | ✅ Complete |
| 6.4 | Update adapter-boundary and adapter-readiness docs | ✅ Complete |

---

## What This Task Proves

Task 6.0 proves **Spec 22 Unit 4** across five dimensions:

1. **`command-entrypoints` is the canonical execution-entry capability** — it is the sole capability that gates whether a harness can initiate durable workflow execution. `workflow-step-dispatch` is supporting execution context only.
2. **Non-command harnesses declare `emulated` delivery** — a harness without literal commands can still satisfy the Core Readiness Profile by providing an equivalent explicit delivery path (skill, script, or UI).
3. **OpenCode explicit user-driven workflow entry** — `runWorkflow` is the adapter-owned explicit helper; execution enters only through deliberate user invocation, never from idle hooks or session events.
4. **`PlanStateProvider` at completion boundaries** — plan-oriented steps (`plan_created`, `plan_complete`) require a `PlanStateProvider`; absent provider → engine fails closed with `policy_decision` error.
5. **Adapter-owned delivery projections** — commands, hooks, skills, scripts, and UI affordances are all adapter-owned projections of the same engine-owned execution contract; the engine owns semantics, adapters own delivery.

---

## Proof Artifact 1 — `command-entrypoints` as Canonical Execution-Entry Capability

### Source

`packages/engine/src/capability-contract.ts` — `CapabilityId` type and JSDoc comment block (§ 1.1).

### Evidence

The `capability-contract.ts` module documents the execution-entry model in the `CapabilityId` JSDoc:

```
## Execution-entry capability model (Spec 22 Unit 4)

`command-entrypoints` is the **canonical execution-entry capability**. It
models how an adapter exposes the explicit user-authorized trigger that
crosses the durable execution boundary (see ADR 0004). Adapters declare:

- `native`      — the harness exposes literal commands (e.g. `/run-workflow`)
- `emulated`    — the harness lacks native commands but provides an
                  equivalent explicit delivery path (skill, script, UI
                  button, or helper) that the user must invoke deliberately.
- `degraded`    — an explicit start path exists but is incomplete or
                  inconsistent (e.g. only some workflows are reachable).
- `unsupported` — no reliable explicit start path exists in this harness.

`workflow-step-dispatch` is **supporting execution context** — it models
the engine's ability to resolve and dispatch individual workflow steps once
execution has already started. It is NOT a second execution-entry
capability.
```

`command-entrypoints` appears in `REQUIRED_CAPABILITIES` (12 required capabilities). `workflow-step-dispatch` also appears in `REQUIRED_CAPABILITIES` but models step dispatch within a running execution — not execution entry.

---

## Proof Artifact 2 — Non-Command `emulated` Delivery Path

### Source

`packages/engine/src/__tests__/capability-readiness.test.ts` — § 9 (Spec 22 Unit 4 describe block).

### Evidence

```
bun test packages/engine/src/__tests__/capability-readiness.test.ts
  packages/engine/src/__tests__/capability-contract.test.ts

57 pass, 0 fail, 213 expect() calls
Ran 57 tests across 2 files. [57.00ms]
```

The § 9 describe block (`Spec 22 Unit 4: command-entrypoints is the canonical execution-entry capability`) contains five tests:

| Test | Assertion | Result |
| --- | --- | --- |
| Command harness with native command support passes the profile | `command-entrypoints: native` → `result.ready: true`, `pass.readiness: "native"` | ✅ |
| Non-command harness with emulated delivery passes the profile | `command-entrypoints: emulated` → `result.ready: true`, `pass.readiness: "emulated"` | ✅ |
| Harness with unsupported command-entrypoints fails even if workflow-step-dispatch is native | `command-entrypoints: unsupported` + `workflow-step-dispatch: native` → `result.ready: false`, failure on `command-entrypoints` | ✅ |
| workflow-step-dispatch readiness is independent of command-entrypoints readiness | Both `native` simultaneously → both pass independently | ✅ |
| Degraded command-entrypoints fails the profile | `command-entrypoints: degraded` → `result.ready: false`, `failure.readiness: "degraded"` | ✅ |

The non-command `emulated` test is the Spec 22 Unit 4 non-OpenCode proof path — it demonstrates that a harness without literal commands (e.g. skill/script/UI delivery) can declare `command-entrypoints: emulated` and still satisfy the Core Readiness Profile.

---

## Proof Artifact 3 — OpenCode Explicit User-Driven Workflow Entry

### Source

`packages/adapters/opencode/src/__tests__/run-workflow.test.ts`

### Evidence

```
bun test packages/adapters/opencode/src/__tests__/run-workflow.test.ts

21 pass, 0 fail, 75 expect() calls
Ran 21 tests across 1 file. [58.00ms]
```

| Describe block | Tests | Coverage |
| --- | --- | --- |
| `runWorkflow` (basic execution loop) | 8 | 2-step, 3-step, default store, instance ID, agent_signal isolation |
| `runWorkflow — explicit user-driven delivery path` | 4 | Store empty before call; instance created after; distinct IDs; validation before store access |
| `runWorkflow — PlanStateProvider at completion boundaries` | 9 | Absent provider fail-closed; present provider success/failure; provider isolation; boundary proof |

Key assertions from the explicit delivery path describe block:

```
✅ starts execution only when explicitly called — not from idle hooks or session events
   → store empty before call; WorkflowInstance created after explicit runWorkflow call
✅ does not start execution when runWorkflow is not called
   → store remains empty without explicit invocation
✅ each explicit runWorkflow call creates a distinct WorkflowInstance
   → result1.workflowInstanceId !== result2.workflowInstanceId
✅ runWorkflow is the sole execution entry point — not a hook or event handler
   → WorkflowNotFound error before store access; store remains empty
```

---

## Proof Artifact 4 — `PlanStateProvider` Completion-Boundary Behavior

### Source

`packages/adapters/opencode/src/__tests__/run-workflow.test.ts` — `PlanStateProvider at completion boundaries` describe block.

### Evidence

**Absent provider → fail closed:**
```
✅ fails with LifecycleError when plan_created step has no PlanStateProvider
   → error.type: "LifecycleError", cause.type: "policy_decision"
✅ fails with LifecycleError when plan_complete step has no PlanStateProvider
   → error.type: "LifecycleError", cause.type: "policy_decision"
```

**Present provider → completion succeeds when plan state matches:**
```
✅ succeeds when plan_created step has PlanStateProvider that reports plan exists
   → result.isOk(): true, status: "completed"
   → planStateProvider.planExistsCalls: ["my-plan"]
✅ succeeds when plan_complete step has PlanStateProvider that reports plan is complete
   → result.isOk(): true, status: "completed"
   → planStateProvider.isPlanCompleteCalls: ["my-plan"]
```

**Present provider → completion fails when plan state does not match:**
```
✅ fails with LifecycleError when plan_created step's plan does not exist
   → planStateProvider.planExistsCalls: ["my-plan"] (provider was consulted)
✅ fails with LifecycleError when plan_complete step's plan is not complete
   → planStateProvider.isPlanCompleteCalls: ["my-plan"] (provider was consulted)
```

**Provider errors propagated:**
```
✅ propagates PlanStateProvider errors as LifecycleError
   → FailingPlanStateProvider → error.type: "LifecycleError"
```

**Provider isolation for non-plan steps:**
```
✅ PlanStateProvider is not called for agent_signal steps even when supplied
   → planExistsCalls: [], isPlanCompleteCalls: []
```

---

## Proof Artifact 5 — Adapter-Owned Delivery Projections

### Source

`docs/adapter-boundary.md` — Execution Lifecycle Surface section.  
`docs/adapter-readiness-status.md` — Execution-Command Readiness (Spec 22 Unit 4) section.

### Evidence

`docs/adapter-boundary.md` (Execution Lifecycle Surface section) states:

> **Adapter delivery of the execution contract** (Spec 22 Unit 4): Commands, hooks, skills, scripts, and UI affordances are all **adapter-owned projections of the same engine-owned execution contract**. The engine defines what execution means — `startExecution` is the sole authorized entry point, and the engine owns all state transitions, lease management, and effect emission. Adapters own the concrete delivery mechanism that exposes the explicit user-authorized trigger in their harness.

`docs/adapter-readiness-status.md` (Execution-Command Readiness section) states:

> **Commands, hooks, skills, scripts, and UI affordances are all adapter-owned projections of the same engine-owned execution contract.** The engine defines what execution means — `startExecution` is the sole authorized entry point, and the engine owns all state transitions, lease management, and effect emission. Adapters own the concrete delivery mechanism that exposes the explicit user-authorized trigger in their harness. No delivery form is privileged over another; what matters is that the trigger is explicit and user-authorized.

The `adapter-readiness-status.md` also includes the full `command-entrypoints` readiness table and adapter declaration examples for both command (native) and non-command (emulated) harnesses.

---

## Consolidated Test Run Results

| Test file | Pass | Fail | Expect calls |
| --- | --- | --- | --- |
| `packages/engine/src/__tests__/capability-readiness.test.ts` | 30 | 0 | ~111 |
| `packages/engine/src/__tests__/capability-contract.test.ts` | 27 | 0 | ~102 |
| `packages/adapters/opencode/src/__tests__/run-workflow.test.ts` | 21 | 0 | 75 |
| **Total** | **78** | **0** | **~288** |

---

## Pre-Existing Blockers (Unrelated to Task 6.0)

The following blockers are pre-existing and outside task 6.0's scope:

| Blocker | Location | Impact |
| --- | --- | --- |
| `noInvalidUseBeforeDeclaration` at 1228:7 | `packages/cli/src/commands/init.ts` | Fails `bun run lint`, `bun run typecheck`, `bun run build`, workspace-wide `bun test` |
| `noRedeclare` at 1240:9 | `packages/cli/src/commands/init.ts` | Same as above |
| `docs/adr-workflow-execution-contract/` stale worktree | Stale directory in repo root | Causes 2 unresolved-package errors when running `bun test` without a path filter; does not affect focused test runs |

These blockers do not implicate any file touched by task 6.0. Focused test runs (`bun test <path>`) from the project root (`docs/spec-workflow-execution-dsl/`) pass cleanly.

---

## Reviewer Conclusion

All five required proof dimensions for task 6.0 are present and verified:

| Required Proof | Status | Evidence |
| --- | --- | --- |
| `bun test capability-contract.test.ts capability-readiness.test.ts` passes with coverage proving `command-entrypoints` is the canonical execution-entry capability | ✅ | 57 pass, 0 fail — § 9 describe block: 5 tests proving native/emulated pass, unsupported/degraded fail, `workflow-step-dispatch` is independent supporting context |
| Non-command harness example declares `command-entrypoints: emulated` and passes the Core Readiness Profile | ✅ | `capability-readiness.test.ts` § 9 test 2: `emulated` → `result.ready: true` |
| `bun test run-workflow.test.ts` passes with coverage proving OpenCode delivery starts workflow execution only from explicit user command/helper path | ✅ | 21 pass, 0 fail — explicit delivery path describe block: 4 tests |
| `bun test run-workflow.test.ts` passes with coverage proving `PlanStateProvider` is supplied at completion boundaries | ✅ | 21 pass, 0 fail — PlanStateProvider describe block: 9 tests |
| `docs/adapter-readiness-status.md` explains `native`/`emulated`/`degraded`/`unsupported` readiness for execution-contract delivery | ✅ | Execution-Command Readiness section with full readiness table and declaration examples |
| `docs/adapter-boundary.md` links Spec 22 Unit 4 command delivery back to engine-owned execution contract | ✅ | Execution Lifecycle Surface section: adapter delivery paragraph and `command-entrypoints` readiness values |

Task 6.0 is complete. All sub-tasks (6.1, 6.2, 6.3, 6.4) are verified. Parent task 6.0 is marked `[x]`.

See also: [22-task-06-3-proofs.md](22-task-06-3-proofs.md) for the detailed sub-task 6.3 proof artifact.
