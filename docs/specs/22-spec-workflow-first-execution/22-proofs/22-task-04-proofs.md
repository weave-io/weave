# Task 4.0 Proof Artifact — Reconciliation Semantics and Handler Routing

**Spec**: [Spec 22 — Workflow-First Execution](../22-spec-workflow-first-execution.md)  
**Task file**: [22-tasks-workflow-first-execution.md](../22-tasks-workflow-first-execution.md)  
**ADR**: [ADR 0004 — Workflow-First Execution Contract](../../../adr/0004-workflow-first-execution-contract.md)  
**Date**: 2026-06-03  
**Status**: Complete — all sub-tasks 4.1–4.5 verified

---

## Task Summary

Parent task 4.0 adds reconciliation semantics and handler routing to the Weave engine. The goal is to enforce a closed reason set, validate authorized sources per reason, route to the nearest explicitly declared upstream handler step, fail closed when no handler exists, re-run gate steps after corrective routing, exclude `before-plan` steps from reconciliation at runtime, and protect completed `Plan Markdown` tasks from in-place revision.

Sub-tasks completed:

| Sub-task | Title | Status |
| --- | --- | --- |
| 4.1 | DSL and validated-config support for `reconciliation_handlers` | ✅ Complete |
| 4.2 | Runtime enforcement: authorized sources, nearest-upstream routing, fail-closed pause | ✅ Complete |
| 4.3 | Gate re-run behavior and `before-plan` exclusion | ✅ Complete |
| 4.4 | Immutable completed-plan protections via `planStateProvider` | ✅ Complete |
| 4.5 | Extended test coverage across execution-lifecycle and runtime-contract | ✅ Complete |

---

## What This Task Proves

Task 4.0 proves **Spec 22 Unit 3**: reconciliation semantics are engine-owned, reason-gated, source-authorized, and topology-aware. Specifically:

1. **Closed reason set** — `ReconciliationReason` is a Zod enum with exactly four values: `execution-mismatch`, `user-revision-request`, `review-rejection`, `security-rejection`. No other values are accepted at the schema or runtime layer.
2. **Authorized-source checks** — each reason has exactly one authorized source. The engine rejects any mismatch with a typed `policy_decision` error before any store operations.
3. **Nearest-upstream handler routing** — the engine walks workflow steps backwards from the triggering step and routes to the first step with a matching `reconciliation_handlers` entry.
4. **Fail-closed behavior** — when no handler is found (or no context is provided), the engine updates the instance to `paused` and emits a `pause-execution` effect.
5. **Gate re-run behavior** — `review-rejection` and `security-rejection` reconciliations set `gateReRunStepName` in the output so adapters can re-dispatch the gate step after corrective work completes.
6. **Before-plan exclusion** — `before-plan` steps are excluded from reconciliation handler resolution at runtime via `computeBeforePlanExclusionSet`, providing defense-in-depth independent of the schema layer.
7. **Immutable completed-plan protections** — when `planStateProvider` is supplied and the triggering step uses `plan_complete` or `plan_created`, the engine checks whether the plan is already complete. If complete, `reconcileExecution` returns a `policy_decision` error with rule `completed_plan_immutability`.

---

## Evidence Summary

| Evidence | Result | Notes |
| --- | --- | --- |
| `bun test execution-lifecycle.test.ts runtime-contract.test.ts` | ✅ PASSED | 457 pass, 0 fail, 1521 expect() calls |
| `bun test schema.test.ts validate.test.ts parse_config.test.ts` | ✅ PASSED | 239 pass, 0 fail, 614 expect() calls |
| `bun run typecheck` | ❌ FAILED | 3 pre-existing CLI errors in `packages/cli/src/commands/init.ts` (unrelated) |
| `bun run build` | ⚠️ PARTIAL | `@weaveio/weave-core`, `@weaveio/weave-engine`, `@weaveio/weave-config` built successfully. Failed in `@weaveio/weave-cli` on same pre-existing `init.ts` issue |

**Pre-existing blocker note**: All failures are caused by a pre-existing parse/redeclaration error in `packages/cli/src/commands/init.ts` (`noInvalidUseBeforeDeclaration` at 1228:7, `noRedeclare` at 1240:9). This file is outside the scope of task 4.0. Engine, core, config, and adapter-opencode packages are clean.

---

## Artifact 1 — Closed Reason Set (`schema.ts` + `execution-lifecycle.ts`)

### Context

Task 4.1 added `ReconciliationReasonSchema` to `packages/core/src/schema.ts` as a Zod enum with exactly four values. Task 4.2 added `RECONCILIATION_REASONS` and `RECONCILIATION_AUTHORIZATION_SOURCES` constants to `packages/engine/src/execution-lifecycle.ts`.

**Schema layer** (`packages/core/src/schema.ts`, lines 219–228):
```ts
export const ReconciliationReasonSchema = z.enum([
  "execution-mismatch",
  "user-revision-request",
  "review-rejection",
  "security-rejection",
]);
```

**Runtime layer** (`packages/engine/src/execution-lifecycle.ts`, lines 3877–3882):
```ts
export const RECONCILIATION_REASONS = [
  "execution-mismatch",
  "user-revision-request",
  "review-rejection",
  "security-rejection",
] as const satisfies readonly ReconciliationReason[];
```

### Evidence

```
bun test packages/core/src/__tests__/schema.test.ts
# ReconciliationReasonSchema — all four values accepted; invalid values rejected
239 pass, 0 fail
```

Schema tests cover: all four valid values accepted, invalid values rejected, `ReconciliationHandlerListSchema` deduplication (`DuplicateReconciliationReason`), and minimum-length enforcement.

---

## Artifact 2 — Authorized-Source Checks (`validateReconciliationSource`)

### Context

Task 4.2 added `validateReconciliationSource` to `packages/engine/src/execution-lifecycle.ts`. The function enforces a closed authorization map:

| Reason | Authorized source |
| --- | --- |
| `execution-mismatch` | `"runtime"` |
| `user-revision-request` | `"user"` |
| `review-rejection` | `"review-gate"` |
| `security-rejection` | `"security-gate"` |

Any mismatch returns a typed `policy_decision` error with `rule: "reconciliationSource"` before any store operations.

### Evidence

From `execution-lifecycle.test.ts` — `validateReconciliationSource` describe block:

```
✅ accepts 'user' for 'user-revision-request'
✅ accepts 'runtime' for 'execution-mismatch'
✅ accepts 'review-gate' for 'review-rejection'
✅ accepts 'security-gate' for 'security-rejection'
✅ rejects 'user' for 'execution-mismatch' (must be 'runtime')
✅ rejects 'user' for 'review-rejection' (must be 'review-gate')
✅ rejects 'user' for 'security-rejection' (must be 'security-gate')
✅ rejects 'runtime' for 'user-revision-request' (must be 'user')
✅ rejects 'review-gate' for 'security-rejection' (must be 'security-gate')
✅ rejects 'security-gate' for 'review-rejection' (must be 'review-gate')
```

From `reconcileExecution (Runtime Store)` describe block:

```
✅ rejects unauthorized source for 'user-revision-request' (must be 'user')
✅ rejects unauthorized source for 'execution-mismatch' (must be 'runtime')
✅ rejects unauthorized source for 'review-rejection' (must be 'review-gate')
✅ rejects unauthorized source for 'security-rejection' (must be 'security-gate')
```

---

## Artifact 3 — Nearest-Upstream Handler Routing (`resolveReconciliationHandler`)

### Context

Task 4.2 added `resolveReconciliationHandler` (internal) and the full `reconcileExecution` implementation. The algorithm:

1. Find the index of `triggeringStepName` in the workflow step list.
2. Walk backwards from that index (exclusive) toward the start.
3. Skip any step in the `beforePlanExclusions` set (v1 rule).
4. Return the first step whose `reconciliation_handlers` list contains a matching `reason`.
5. If no handler is found, return `undefined` (fail-closed path).

### Evidence

From `reconcileExecution (Runtime Store)` describe block:

```
✅ routes to nearest upstream handler for 'user-revision-request' from 'security-review'
   → handlerStepName: "implement" (closer than "plan")
✅ routes to 'plan' for 'user-revision-request' from 'implement' (skips implement itself)
   → handlerStepName: "plan"
✅ routes to 'plan' for 'execution-mismatch' from 'security-review'
   → handlerStepName: "plan" (only plan has execution-mismatch handler)
✅ fails closed for 'execution-mismatch' from 'plan' (no upstream steps)
   → handlerFound: false, effects[0].kind: "pause-execution"
✅ uses instance.currentStepName when triggeringStepName is omitted
   → routes to "implement" from currentStepName "security-review"
```

---

## Artifact 4 — Fail-Closed Behavior

### Context

Task 4.2 enforces fail-closed behavior in two paths:

1. **No context provided**: when `input.context` is `undefined`, the engine immediately updates the instance to `paused` and emits `pause-execution` without searching for a handler.
2. **No handler found**: when `resolveReconciliationHandler` returns `undefined`, the engine updates the instance to `paused` and emits `pause-execution`.

In both cases, `handlerFound: false` and `handlerStepName` is absent from the output.

### Evidence

```
✅ fails closed with pause-execution when no context is provided
   → handlerFound: false, instance.status: "paused"
✅ fails closed with pause-execution when no upstream handler exists for the reason
   → handlerFound: false, instance.status: "paused"
✅ fails closed for 'execution-mismatch' from 'plan' (no upstream steps)
   → handlerFound: false, effects[0].kind: "pause-execution"
```

From `runtime-contract.test.ts`:
```
✅ reconciliation fail-closed effect is pause-execution (not complete-execution)
✅ WorkflowInstance status 'paused' is the fail-closed state for reconciliation without a handler
```

---

## Artifact 5 — Gate Re-Run Behavior (`gateReRunStepName`)

### Context

Task 4.3 added `gateReRunStepName` to `ReconcileExecutionOutput`. When `reason` is `"review-rejection"` or `"security-rejection"`, the output carries `gateReRunStepName` set to the triggering step name. This field is set even when the engine fails closed (no handler found), so adapters can surface the gate context to the user.

Non-gate reasons (`execution-mismatch`, `user-revision-request`) do not set `gateReRunStepName`.

### Evidence

From `reconcileExecution — gate re-run (Spec 22 Unit 3)` describe block:

```
✅ review-rejection: gateReRunStepName is set to the triggering step name
   → gateReRunStepName: "review-gate"
✅ security-rejection: gateReRunStepName is set to the triggering step name
   → gateReRunStepName: "security-gate"
✅ user-revision-request: gateReRunStepName is NOT set (not gate-originated)
   → gateReRunStepName: undefined
✅ execution-mismatch: gateReRunStepName is NOT set (not gate-originated)
   → gateReRunStepName: undefined
✅ review-rejection fail-closed: gateReRunStepName is still set even when no handler found
   → handlerFound: false, gateReRunStepName: "review-gate"
✅ review-rejection: gateReRunStepName uses instance.currentStepName when triggeringStepName is omitted
   → gateReRunStepName: "review-gate"
```

From `runtime-contract.test.ts`:
```
✅ ReconcileExecutionOutput carries gateReRunStepName for gate-originated reasons
✅ gateReRunStepName is absent for non-gate-originated reasons
✅ gate re-run reasons are exactly review-rejection and security-rejection
```

---

## Artifact 6 — Before-Plan Exclusion (`computeBeforePlanExclusionSet`)

### Context

Task 4.3 added `computeBeforePlanExclusionSet` (internal) to `packages/engine/src/execution-lifecycle.ts`. A step is excluded when:

1. The workflow publishes `extension_points.before_plan === true`.
2. The step appears before the step with `role === "planning"` in the step list.

This is a runtime defense-in-depth guarantee that complements the schema-layer constraint (no `reconciliation_handlers` on before-plan steps). The runtime check ensures the v1 rule holds even after config merge or composition bypasses schema validation.

### Evidence

From `reconcileExecution — before-plan exclusion (Spec 22 Unit 3)` describe block:

```
✅ before-plan step is skipped during handler resolution even if it declares reconciliation_handlers
   → routes to "implement", not "spec-review" (before-plan step excluded)
✅ before-plan step is skipped: routes to planning step when implement has no handler
   → routes to "plan" (planning step), skipping "spec-review" (before-plan)
✅ before-plan exclusion: fails closed when only before-plan steps have handlers
   → handlerFound: false, effects[0].kind: "pause-execution"
✅ workflow without extension_points.before_plan: no steps are excluded
   → routes to "early-step" (not excluded — no before-plan extension point)
```

From `runtime-contract.test.ts`:
```
✅ before-plan steps do not participate in reconciliation — v1 rule is documented
✅ before-plan exclusion is a runtime defense-in-depth guarantee
```

---

## Artifact 7 — Immutable Completed-Plan Protections (`checkCompletedPlanImmutability`)

### Context

Task 4.4 added `checkCompletedPlanImmutability` (internal) and the `planStateProvider` field to `ReconcileExecutionInput`. The check applies only when:

1. `planStateProvider` is provided.
2. The triggering step's completion method is `"plan_complete"` or `"plan_created"`.
3. `planStateProvider.isPlanComplete(planName)` returns `true`.

When all three conditions hold, `reconcileExecution` returns a `policy_decision` error with `rule: "completed_plan_immutability"` before any store writes. Corrective work must be expressed as follow-up tasks (new `- [ ]` checkboxes), not in-place revisions.

### Evidence

From `reconcileExecution — immutable completed plan tasks (Spec 22 Unit 3)` describe block:

```
✅ rejects reconciliation with policy_decision when triggering step's plan is complete
   → error.type: "policy_decision", error.rule: "completed_plan_immutability"
   → error.message contains "build-feature", "immutable", "follow-up tasks"
✅ allows reconciliation when triggering step's plan is NOT complete
   → result.isOk(): true (reconciliation proceeds)
✅ skips immutability check when planStateProvider is absent
   → result.isOk(): true (check skipped)
✅ skips immutability check when triggering step uses agent_signal (not plan-oriented)
   → result.isOk(): true (implement is not plan-oriented)
✅ skips immutability check when triggeringStepName is omitted and current step is not plan-oriented
   → result.isOk(): true (implement is not plan-oriented)
```

From `runtime-contract.test.ts`:
```
✅ ReconcileExecutionInput accepts an optional planStateProvider field
✅ immutability check applies only to plan-oriented completion methods
✅ immutability error is a policy_decision with rule 'completed_plan_immutability'
✅ corrective work model: completed tasks are immutable, follow-up tasks are the correction path
✅ immutability check does not modify instance state on rejection
```

---

## Artifact 8 — Test Run Results

### Combined test run

```
bun test packages/engine/src/__tests__/execution-lifecycle.test.ts \
         packages/engine/src/__tests__/runtime-contract.test.ts

457 pass, 0 fail, 1521 expect() calls
Ran 457 tests across 2 files. [134.00ms]
```

### Core schema/validate/parse tests

```
bun test packages/core/src/__tests__/schema.test.ts \
         packages/core/src/__tests__/validate.test.ts \
         packages/core/src/__tests__/parse_config.test.ts

239 pass, 0 fail, 614 expect() calls
Ran 239 tests across 3 files. [38.00ms]
```

---

## Reviewer Conclusion

All four proof artifacts required by the task file's `4.0 Proof Artifact(s)` section are present and verified:

| Required Proof | Status | Evidence |
| --- | --- | --- |
| `bun test execution-lifecycle.test.ts` passes with coverage for the closed reconciliation reason set | ✅ | 457 pass, 0 fail — `RECONCILIATION_REASONS` constant, `ReconciliationReasonSchema`, all four values accepted |
| `bun test execution-lifecycle.test.ts` proves reconciliation reasons accepted only from authorized sources, route to nearest upstream handler, pause when no handler | ✅ | `validateReconciliationSource` tests, `reconcileExecution (Runtime Store)` tests — all routing and fail-closed cases verified |
| `bun test execution-lifecycle.test.ts` proves review/security gates re-run after reconciliation, `before-plan` steps excluded | ✅ | `reconcileExecution — gate re-run` and `reconcileExecution — before-plan exclusion` describe blocks |
| `bun test runtime-contract.test.ts` passes with coverage proving reconciliation cannot revise completed Plan Markdown tasks | ✅ | `Reconciliation contract — immutable completed plan tasks` describe block; structural and behavioral proofs |

**Repository-wide CLI failures** (`packages/cli/src/commands/init.ts` — `noInvalidUseBeforeDeclaration` at 1228:7, `noRedeclare` at 1240:9) are pre-existing blockers outside this task's scope. They affect `bun run lint`, `bun run typecheck`, `bun run build`, and `bun run test` at the workspace level but do not implicate any engine, core, config, or adapter-opencode file touched by task 4.0.

Task 4.0 is complete. All sub-tasks 4.1–4.5 are verified. Reconciliation semantics are formalized, enforced, and tested.
