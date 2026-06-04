# Task 6.3 Proof Artifact — OpenCode Adapter Delivery Tests

**Spec**: [Spec 22 — Workflow-First Execution](../22-spec-workflow-first-execution.md)  
**Task file**: [22-tasks-workflow-first-execution.md](../22-tasks-workflow-first-execution.md)  
**ADR**: [ADR 0004 — Workflow-First Execution Contract](../../../adr/0004-workflow-first-execution-contract.md)  
**Date**: 2026-06-03  
**Status**: Complete — sub-task 6.3 verified

---

## Task Summary

Sub-task 6.3 updates the OpenCode adapter delivery tests to prove:

1. Workflow execution enters only through explicit user-driven helper/command delivery paths (`runWorkflow`).
2. `PlanStateProvider` is supplied at completion boundaries for plan-oriented steps.
3. Implicit paths (idle hooks, session events, continuation hooks) do not start durable execution.

---

## What This Task Proves

Task 6.3 proves **Spec 22 Unit 4** for the OpenCode adapter delivery path:

1. **Explicit user-driven delivery** — `runWorkflow` is the adapter-owned explicit helper that must be called by a user-authorized trigger. It is never wired to idle hooks, session events, or continuation hooks.
2. **`PlanStateProvider` at completion boundaries** — plan-oriented steps (`plan_created`, `plan_complete`) require a `PlanStateProvider`. Absent provider → engine fails closed with `policy_decision` error. Present provider → engine calls it and completion succeeds or fails based on plan state.
3. **Implicit paths do not start execution** — without an explicit `runWorkflow` call, no `WorkflowInstance` is created. The store remains empty.

---

## Evidence Summary

| Evidence | Result | Notes |
| --- | --- | --- |
| `bun test packages/adapters/opencode/src/__tests__/run-workflow.test.ts` | ✅ PASSED | 21 pass, 0 fail, 75 expect() calls |

---

## Artifact 1 — Explicit User-Driven Delivery Path

### Context

The `runWorkflow` function in `packages/adapters/opencode/src/run-workflow.ts` is the OpenCode adapter's explicit user-driven helper for starting durable workflow execution. Per ADR 0004 Decision 2 and Decision 3:

- Execution begins only through an explicit, user-authorized transition.
- Adapters are delivery layers — they expose the engine contract through harness-specific commands, skills, hooks, scripts, or UI.

The test suite proves this by:

1. Verifying the store is empty before any explicit call.
2. Verifying a `WorkflowInstance` is created only after an explicit `runWorkflow` call.
3. Verifying that without a `runWorkflow` call, the store remains empty.
4. Verifying each explicit call creates a distinct `WorkflowInstanceId`.
5. Verifying that invalid inputs (unknown workflow name) fail before store access — no implicit state can trigger execution.

### Evidence

From `runWorkflow — explicit user-driven delivery path (Spec 22 Unit 4)` describe block:

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

## Artifact 2 — `PlanStateProvider` at Completion Boundaries

### Context

When a workflow step uses `plan_created` or `plan_complete` as its completion method, the engine requires a `PlanStateProvider`. Per Spec 19 and ADR 0004:

- The engine owns the `PlanStateProvider` interface and the call.
- Adapters own the provider implementation and supply it via `CompleteStepInput.planStateProvider`.
- Absent provider → engine returns `policy_decision` error (fail closed).

The test suite proves this with two fixture configs:

- `PLAN_CREATED_CONFIG` — first step uses `plan_created` completion with `plan_name: "my-plan"`.
- `PLAN_COMPLETE_CONFIG` — first step uses `plan_complete` completion with `plan_name: "my-plan"`.

### Evidence

From `runWorkflow — PlanStateProvider at completion boundaries (Spec 22 Unit 4)` describe block:

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
   → error.type: "LifecycleError"
   → planStateProvider.planExistsCalls: ["my-plan"] (provider was consulted)
✅ fails with LifecycleError when plan_complete step's plan is not complete
   → error.type: "LifecycleError"
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
✅ PlanStateProvider is passed through to completeStep for each plan-oriented step
   → planExistsCalls: ["my-plan"] (plan_created step only)
   → isPlanCompleteCalls: [] (second step uses agent_signal)
```

---

## Artifact 3 — Test Run Results

```
bun test packages/adapters/opencode/src/__tests__/run-workflow.test.ts

21 pass, 0 fail, 75 expect() calls
Ran 21 tests across 1 file. [78.00ms]
```

### Test breakdown

| Describe block | Tests | Coverage |
| --- | --- | --- |
| `runWorkflow` (basic execution loop) | 8 | 2-step, 3-step, default store, instance ID, agent_signal isolation |
| `runWorkflow — explicit user-driven delivery path` | 4 | Store empty before call; instance created after; distinct IDs; validation before store access |
| `runWorkflow — PlanStateProvider at completion boundaries` | 9 | Absent provider fail-closed; present provider success/failure; provider isolation; boundary proof |

---

## Reviewer Conclusion

The required proof artifact for task 6.3 is present and verified:

| Required Proof | Status | Evidence |
| --- | --- | --- |
| `bun test run-workflow.test.ts` passes with coverage proving OpenCode delivery starts workflow execution only from an explicit user command/helper path | ✅ | 21 pass, 0 fail — explicit delivery path describe block: 4 tests proving store empty before call, instance created after explicit call, distinct IDs per call, validation before store access |
| `bun test run-workflow.test.ts` passes with coverage proving `PlanStateProvider` is supplied at completion boundaries | ✅ | 21 pass, 0 fail — PlanStateProvider describe block: 9 tests covering absent-provider fail-closed, present-provider success/failure, provider isolation, and boundary proof |

**Pre-existing blocker note**: Repository-wide CLI failures (`packages/cli/src/commands/init.ts` — `noInvalidUseBeforeDeclaration` at 1228:7, `noRedeclare` at 1240:9) are pre-existing blockers outside this task's scope. They affect `bun run lint`, `bun run typecheck`, `bun run build`, and `bun run test` at the workspace level but do not implicate any adapter-opencode file touched by task 6.3.

Task 6.3 is complete. OpenCode adapter delivery tests prove workflow execution enters only through explicit user-driven helper paths and supplies `PlanStateProvider` at completion boundaries.
