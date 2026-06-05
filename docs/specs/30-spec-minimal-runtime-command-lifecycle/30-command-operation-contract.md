# Command-Operation Contract

**Spec**: [30 — Minimal Runtime Command Lifecycle](./30-spec-minimal-runtime-command-lifecycle.md)
**Related**: [Adapter Boundary](../../adapter-boundary.md) · [Spec 13 — Minimal Execution Lifecycle Surface](../13-spec-minimal-execution-lifecycle-surface/13-spec-minimal-execution-lifecycle-surface.md) · [Spec 19 — Plan State Provider](../19-spec-plan-state-provider/19-spec-plan-state-provider.md) · [Spec 22 — Workflow-First Execution](../22-spec-workflow-first-execution/22-spec-workflow-first-execution.md) · [Spec 29 — Default Usage Is Not Workflow-Driven](../29-spec-default-usage-not-workflow-driven/29-spec-default-usage-not-workflow-driven.md)

---

## Purpose

This document maps each of the six runtime command operations to:

- the lifecycle method(s) it calls,
- the adapter context it requires,
- the typed result it returns, and
- the degradation path when the operation cannot complete normally.

It is a companion to the spec and is intended to be read alongside the source modules in
[`packages/engine/src/runtime-command-operations/`](../../../../packages/engine/src/runtime-command-operations/).

---

## Scope and Out-of-Scope

**In scope for Issue #17:**

- `start-plan` — start execution of an existing named plan file.
- `run-named-workflow` — explicitly run a named workflow (separate from plan execution).
- `inspect-status` — read-only inspection of active execution state.
- `abort-execution` — cancel or pause an active execution.
- `advance-step` — advance or complete a blocked step.
- `runtime-health` — report adapter/runtime readiness and command-entrypoint support.

**Out of scope for Issue #17:**

- `/start-work` — this command name is **not implemented or required** by this issue. The
  preferred explicit delivery path is `/weave:start`. The constant `WEAVE_START_LEGACY_COMMAND`
  exists in `start-plan-execution.ts` as a backwards-compatibility alias only; it is not wired
  to any hook or session event.
- Idle continuation, compaction recovery, context-window monitoring, and broad legacy governance
  hooks — these belong to a separate lifecycle surface and are not part of this command layer.
- Hidden or implicit execution start — no session hook, idle hook, or `session.created` event
  may call any command operation. All six operations require explicit user invocation.

---

## Boundary Rules

The engine owns lifecycle semantics. Adapters own delivery.

| Engine owns | Adapters own |
|---|---|
| Validation logic (field presence, plan existence, terminal-state checks) | Argument parsing from slash commands, plugin tools, or scripts |
| Lifecycle method calls (`startExecution`, `dispatchStep`, `completeStep`, `handleUserInterrupt`, `inspectExecution`) | Concrete command labels (`/weave:start`, `/weave:run`, etc.) |
| Typed result data (`ExecutionStartedData`, `ExecutionStatusData`, etc.) | Rendering result data as user-facing messages |
| Effect emission (`DispatchAgentEffect`, `LifecycleEffect`) | Effect projection (`adapter.spawnSubagent`, harness-specific callbacks) |
| Error discrimination (`CommandOperationError` variants) | Error message formatting for the harness UI |

See [`docs/adapter-boundary.md`](../../adapter-boundary.md) for the full boundary rules.

---

## Ordinary Plan Execution vs. Named Workflow Execution

These two operations are **explicitly separate** and must never be conflated.

| | `start-plan` | `run-named-workflow` |
|---|---|---|
| Entry point | `/weave:start` (OpenCode) | `/weave:run` (OpenCode) |
| Requires plan file | Yes — validated via `PlanStateProvider` | No |
| Requires workflow name | Yes — must exist in workflow registry | Yes — must exist in workflow registry |
| Plan existence check | `planStateProvider.planExists(planName)` before any store access | Not performed (no plan file involved) |
| Typical use | Execute an existing plan artifact | Run a named workflow directly |
| Implicit invocation | Never — must be user-authorized | Never — must be user-authorized |

Both operations delegate to `runWorkflowLifecycle` after their respective validation steps.
The distinction is that `start-plan` adds a plan-existence gate before the workflow runner is
called. A user who wants to run a workflow without a plan file uses `run-named-workflow`.

---

## Operation Reference

### 1. `start-plan`

**Source**: [`packages/engine/src/runtime-command-operations/start-plan.ts`](../../../../packages/engine/src/runtime-command-operations/start-plan.ts)

**What it does**: Validates a named plan file exists, then drives the named workflow through the
execution lifecycle. Returns a typed `ExecutionStartedData` result that adapters use to render
success messages and apply dispatch effects.

**Lifecycle methods called** (in order):

1. `planStateProvider.planExists(planName)` — plan existence gate (before any store access).
2. `startExecution` — acquires a lease and creates the `WorkflowInstance`.
3. `dispatchStep` — resolves the first step and emits a `DispatchAgentEffect`.
4. `projectEffect` (adapter-supplied) — applies each `DispatchAgentEffect` (e.g. `spawnSubagent`).
5. `completeStep` — records step completion and auto-advances to the next step or emits `complete-execution`.
6. Steps 4–5 repeat until `complete-execution` or `pause-execution` is emitted.

**Required adapter context**:

| Field | Type | Notes |
|---|---|---|
| `planName` | `string` | Non-empty; validated by `PlanStateProvider` |
| `workflowName` | `string` | Must exist in `workflows` registry |
| `goal` | `string` | Human-readable goal for the instance |
| `slug` | `string` | URL-safe slug for the instance |
| `ownerId` | `string` | Identifies the caller (e.g. `"weave:start"`) |
| `store` | `RuntimeStore` | Persists the `WorkflowInstance` and lease |
| `planStateProvider` | `PlanStateProvider` | Required — absence returns `command_validation` |
| `workflows` | `Record<string, unknown>` | Workflow registry from config |
| `projectEffect` | `(effect) => ResultAsync<void, WorkflowRunnerError>` | Adapter-owned; calls `spawnSubagent` |

**Typed result**: `ok(ExecutionStartedData)` — carries `workflowInstanceId`, `leaseId`,
`workflowName`, `goal`, `slug`, and `effects` (all `LifecycleEffect` values emitted during the run).

**Degradation paths**:

| Condition | Error returned |
|---|---|
| `planStateProvider` absent | `command_validation` (field: `planStateProvider`) |
| `planName` empty | `command_validation` (field: `planName`) |
| `planName` contains unsafe characters | `command_validation` (field: `planName`) — from `InvalidPlanName` |
| `PlanStateProvider` I/O failure | `command_validation` (field: `planStateProvider`) — from `ProviderUnavailable` |
| Plan file does not exist | `command_not_found` (entity: `plan`) |
| `workflowName` not in registry | `command_not_found` (entity: `workflow`) |
| Step limit exceeded | `command_validation` (field: `maxSteps`) |
| Lifecycle method failure | `command_lifecycle` (wraps `LifecycleError`) |
| `projectEffect` failure | `command_lifecycle` (wraps `policy_decision` cause) |

**OpenCode projection**: `RuntimeCommandProjection.handleStartPlan` → `/weave:start`.
See [`packages/adapters/opencode/src/runtime-command-projection.ts`](../../../../packages/adapters/opencode/src/runtime-command-projection.ts).

---

### 2. `run-named-workflow`

**Source**: [`packages/engine/src/runtime-command-operations/run-named-workflow.ts`](../../../../packages/engine/src/runtime-command-operations/run-named-workflow.ts)

**What it does**: Validates the workflow name, then drives the named workflow through the
execution lifecycle. No plan file is required or checked. Returns a typed `ExecutionStartedData`
result.

**Lifecycle methods called** (in order):

1. `startExecution` — acquires a lease and creates the `WorkflowInstance`.
2. `dispatchStep` — resolves the first step and emits a `DispatchAgentEffect`.
3. `projectEffect` (adapter-supplied) — applies each `DispatchAgentEffect`.
4. `completeStep` — records step completion and auto-advances or emits `complete-execution`.
5. Steps 3–4 repeat until `complete-execution` or `pause-execution` is emitted.

**Required adapter context**:

| Field | Type | Notes |
|---|---|---|
| `workflowName` | `string` | Non-empty; must exist in `workflows` registry |
| `goal` | `string` | Human-readable goal for the instance |
| `slug` | `string` | URL-safe slug for the instance |
| `ownerId` | `string` | Identifies the caller |
| `store` | `RuntimeStore` | Persists the `WorkflowInstance` and lease |
| `workflows` | `Record<string, unknown>` | Workflow registry from config |
| `projectEffect` | `(effect) => ResultAsync<void, WorkflowRunnerError>` | Adapter-owned |
| `planStateProvider` | `PlanStateProvider` (optional) | Required only for `plan_created`/`plan_complete` steps |

**Typed result**: `ok(ExecutionStartedData)` — same shape as `start-plan`.

**Degradation paths**:

| Condition | Error returned |
|---|---|
| `workflowName` empty | `command_validation` (field: `workflowName`) |
| `workflowName` not in registry | `command_not_found` (entity: `workflow`) |
| Step limit exceeded | `command_validation` (field: `maxSteps`) |
| Lifecycle method failure | `command_lifecycle` (wraps `LifecycleError`) |
| `projectEffect` failure | `command_lifecycle` (wraps `policy_decision` cause) |
| `plan_created`/`plan_complete` step without provider | `command_lifecycle` — engine fails closed |

**OpenCode projection**: `RuntimeCommandProjection.handleRunWorkflow` → `/weave:run`.

---

### 3. `inspect-status`

**Source**: [`packages/engine/src/runtime-command-operations/status.ts`](../../../../packages/engine/src/runtime-command-operations/status.ts)

**What it does**: Reads the current state of a workflow instance from the runtime store.
This is a **read-only** operation — it never creates instances, acquires leases, updates
status, or emits lifecycle effects. Safe to call from any adapter context without risk of
implicit execution start.

**Lifecycle methods called**:

1. `inspectExecution` — reads the `WorkflowInstance` and resolves active lease status from the store.

**Required adapter context**:

| Field | Type | Notes |
|---|---|---|
| `workflowInstanceId` | `WorkflowInstanceId` | Non-empty; must exist in the store |
| `store` | `RuntimeStore` | Read-only access to the instance |

**Typed result**: `ok(ExecutionStatusData)` — carries `workflowInstanceId`, `status`,
`currentStepName`, `workflowName`, `goal`, `slug`, `createdAt`, `updatedAt`, `completedAt`,
`errorMessage`, `hasActiveLease`, and `raw` (full `InspectExecutionOutput` for adapters
that need additional fields).

**Degradation paths**:

| Condition | Error returned |
|---|---|
| `workflowInstanceId` empty | `command_validation` (field: `workflowInstanceId`) |
| Instance not found in store | `command_not_found` (entity: `execution`) |
| Store read failure | `command_lifecycle` (wraps `LifecycleError`) |

**OpenCode projection**: `RuntimeCommandProjection.handleInspectStatus` → `/weave:status`.

---

### 4. `abort-execution`

**Source**: [`packages/engine/src/runtime-command-operations/control.ts`](../../../../packages/engine/src/runtime-command-operations/control.ts)

**What it does**: Cancels or pauses an active workflow execution. The engine resolves the
active lease through the runtime store and validates that the provided `leaseId` matches
before calling `handleUserInterrupt`. Affects only the **resolved intended active execution** —
returns typed errors when the target is missing, already terminal, or the lease does not match.

**Lifecycle methods called** (in order):

1. `store.instances.findById(workflowInstanceId)` — terminal-state guard (before calling lifecycle).
2. `handleUserInterrupt` — emits `cancel-execution` or `pause-execution` effect.

**Required adapter context**:

| Field | Type | Notes |
|---|---|---|
| `workflowInstanceId` | `WorkflowInstanceId` | Non-empty; must exist and be non-terminal |
| `leaseId` | `ExecutionLeaseId` | Non-empty; must match the active lease |
| `signal` | `"cancel" \| "pause"` | `"cancel"` terminates; `"pause"` suspends |
| `store` | `RuntimeStore` | Read/write access to the instance and lease |

**Typed result**: `ok(ExecutionAbortedData)` — carries `workflowInstanceId`, `signal`, and
`effects` (the `LifecycleEffect` values emitted by `handleUserInterrupt`).

**Degradation paths**:

| Condition | Error returned |
|---|---|
| `workflowInstanceId` empty | `command_validation` (field: `workflowInstanceId`) |
| `leaseId` empty | `command_validation` (field: `leaseId`) |
| `signal` absent | `command_validation` (field: `signal`) |
| Instance not found in store | `command_not_found` (entity: `execution`) |
| Instance already terminal (`completed`, `failed`, `cancelled`) | `command_not_found` (entity: `execution`) |
| Lease mismatch | `command_not_found` (entity: `lease`) |
| Lifecycle method failure | `command_lifecycle` (wraps `LifecycleError`) |

**OpenCode projection**: `RuntimeCommandProjection.handleAbortExecution` → `/weave:abort`.

> **Degraded affordance**: the native TUI abort button is not yet wired to this handler.
> Users can invoke it via plugin tool or script. See `DEGRADED_AFFORDANCES` in
> [`runtime-command-projection.ts`](../../../../packages/adapters/opencode/src/runtime-command-projection.ts).

---

### 5. `advance-step`

**Source**: [`packages/engine/src/runtime-command-operations/control.ts`](../../../../packages/engine/src/runtime-command-operations/control.ts)

**What it does**: Advances or completes a blocked workflow step when no automatic completion
signal is available. Requires the caller to supply the workflow instance, lease, step name,
and completion signal explicitly — no implicit state is assumed.

**Lifecycle methods called**:

1. `completeStep` — records step completion with the provided signal and emits the next
   `dispatch-agent` effect (or `complete-execution` for the final step).

**Required adapter context**:

| Field | Type | Notes |
|---|---|---|
| `workflowInstanceId` | `WorkflowInstanceId` | Non-empty |
| `leaseId` | `ExecutionLeaseId` | Non-empty; must match the active lease |
| `stepName` | `string` | Non-empty; name of the blocked step |
| `completionSignal` | `StepCompletionSignal` | Must include `outcome` |
| `store` | `RuntimeStore` | Read/write access to the instance |
| `planStateProvider` | `PlanStateProvider` (optional) | Required for `plan_created`/`plan_complete` steps |
| `context` | `{ workflowName, goal, slug, workflows }` (optional) | Required for `plan_created`/`plan_complete` routing |

**Typed result**: `ok(StepAdvancedData)` — carries `workflowInstanceId`, `stepName`,
`completionSignal`, and `effects` (the `LifecycleEffect` values emitted by `completeStep`).

**Degradation paths**:

| Condition | Error returned |
|---|---|
| `workflowInstanceId` empty | `command_validation` (field: `workflowInstanceId`) |
| `leaseId` empty | `command_validation` (field: `leaseId`) |
| `stepName` empty | `command_validation` (field: `stepName`) |
| `completionSignal` absent | `command_validation` (field: `completionSignal`) |
| `completionSignal.outcome` absent | `command_validation` (field: `completionSignal.outcome`) |
| Instance or step not found | `command_not_found` (entity: `execution`) |
| Lease mismatch | `command_not_found` (entity: `lease`) |
| `plan_created`/`plan_complete` without provider | `command_lifecycle` — engine fails closed |
| Lifecycle method failure | `command_lifecycle` (wraps `LifecycleError`) |

**OpenCode projection**: `RuntimeCommandProjection.handleAdvanceStep` → `/weave:advance`.

> **Degraded affordance**: the native TUI step-advance UI is not yet wired to this handler.
> Users can invoke it via plugin tool or script. See `DEGRADED_AFFORDANCES` in
> [`runtime-command-projection.ts`](../../../../packages/adapters/opencode/src/runtime-command-projection.ts).

---

### 6. `runtime-health`

**Source**: [`packages/engine/src/runtime-command-operations/health.ts`](../../../../packages/engine/src/runtime-command-operations/health.ts)

**What it does**: Reports adapter/runtime readiness, command-entrypoint support, and
degraded/unsupported operation details. This is a **pure** operation — it performs no
harness I/O, scans no directories, registers no hooks, and mutates no state. Adapters
build the `AdapterHealthReport` via `buildAdapterHealthReport` before calling this function.

**Lifecycle methods called**: None. This operation is pure — it derives its result entirely
from the adapter-supplied `RuntimeHealthInput`.

**Required adapter context**:

| Field | Type | Notes |
|---|---|---|
| `healthReport` | `AdapterHealthReport` | Built by the adapter via `buildAdapterHealthReport` |
| `degradedOperations` | `readonly string[]` (optional) | Adapter-supplied list; derived from profile warnings if absent |
| `unsupportedOperations` | `readonly string[]` (optional) | Adapter-supplied list; derived from profile failures if absent |

**Typed result**: `ok(RuntimeHealthData)` — this operation **never fails**. The result carries:

- `healthReport` — the full `AdapterHealthReport` from the capability contract.
- `commandEntrypointsSupported` — `true` when the `command-entrypoints` capability is `native`
  or `emulated`; `false` when `degraded`, `unsupported`, or absent.
- `degradedOperations` — human-readable strings for degraded capabilities.
- `unsupportedOperations` — human-readable strings for unsupported capabilities.

**Derivation rules**:

| Field | Source when adapter list is empty |
|---|---|
| `commandEntrypointsSupported` | Derived from `command-entrypoints` capability readiness in the health report |
| `degradedOperations` | Derived from `profileResult.warnings` in the health report |
| `unsupportedOperations` | Derived from `profileResult.failures` in the health report |

**Degradation paths**: None — `runtimeHealth` always returns `ok`. Degraded or unsupported
state is reported _inside_ the `RuntimeHealthData` result, not as an error. The OpenCode
projection (`handleRuntimeHealth`) maps a non-ready or partially-degraded result to a
`ProjectionDegraded` outcome for user-facing display.

**OpenCode projection**: `RuntimeCommandProjection.handleRuntimeHealth` → `/weave:health`.

---

## Shared Workflow Runner

Both `start-plan` and `run-named-workflow` delegate to `runWorkflowLifecycle` after their
respective validation steps. The runner is defined in
[`packages/engine/src/runtime-command-operations/workflow-runner.ts`](../../../../packages/engine/src/runtime-command-operations/workflow-runner.ts).

**Lifecycle sequence inside `runWorkflowLifecycle`**:

```
startExecution
  └─ dispatchStep (first step)
       └─ projectEffect (adapter applies DispatchAgentEffect)
            └─ completeStep
                 ├─ complete-execution → done
                 ├─ pause-execution → paused
                 └─ dispatch-agent (next step) → projectEffect → completeStep (recurse)
```

The runner enforces a `maxSteps` safety cap (default: 100). Exceeding the cap returns
`max_steps_exceeded`, which the calling command operation maps to `command_validation`.

**`WorkflowRunnerError` → `CommandOperationError` mapping**:

| `WorkflowRunnerError.type` | `CommandOperationError.type` |
|---|---|
| `workflow_not_found` | `command_not_found` (entity: `workflow`) |
| `max_steps_exceeded` | `command_validation` (field: `maxSteps`) |
| `lifecycle_error` | `command_lifecycle` (wraps `LifecycleError`) |
| `projection_error` | `command_lifecycle` (wraps `policy_decision` cause) |

---

## OpenCode Projection Layer

The OpenCode adapter's projection layer is defined in
[`packages/adapters/opencode/src/runtime-command-projection.ts`](../../../../packages/adapters/opencode/src/runtime-command-projection.ts).

**Command label mapping** (adapter-owned — core packages must never reference these):

| Engine operation | OpenCode label |
|---|---|
| `startPlan` | `/weave:start` |
| `runNamedWorkflow` | `/weave:run` |
| `inspectStatus` | `/weave:status` |
| `abortExecution` | `/weave:abort` |
| `advanceStep` | `/weave:advance` |
| `runtimeHealth` | `/weave:health` |

Each projection handler:

1. Parses adapter-owned arguments.
2. Delegates to the matching engine operation.
3. Returns a `ProjectionResult<T>` — `success`, `failure`, or `degraded`.

No lifecycle state-transition logic is duplicated in the projection layer.

**`/start-work` is out of scope.** The constant `WEAVE_START_LEGACY_COMMAND = "/start-work"`
exists in `start-plan-execution.ts` as a backwards-compatibility alias only. It is not wired
to any session hook, idle hook, or `session.created` event. The preferred explicit delivery
path is `/weave:start`.

---

## Completion Signal Coverage

The `advance-step` operation and the workflow runner's `completeStep` calls both accept a
`StepCompletionSignal`. The signal's `method` field determines how the engine evaluates
completion:

| Completion method | Provider required | Notes |
|---|---|---|
| `agent_signal` | No | Default; engine accepts the signal as-is |
| `user_confirm` | No | Engine records user confirmation |
| `review_verdict` | No | Engine records approve/reject verdict |
| `plan_created` | Yes (`PlanStateProvider`) | Engine checks that the plan file was created |
| `plan_complete` | Yes (`PlanStateProvider`) | Engine checks that the plan file is marked complete |

When `plan_created` or `plan_complete` is used without a `PlanStateProvider`, the engine
returns a `policy_decision` lifecycle error rather than silently passing. This is the
**fail-closed** behavior defined in [Spec 19](../19-spec-plan-state-provider/19-spec-plan-state-provider.md).

---

## Error Type Reference

All six operations share the `CommandOperationError` discriminated union defined in
[`packages/engine/src/runtime-command-operations/types.ts`](../../../../packages/engine/src/runtime-command-operations/types.ts):

| Variant | `type` field | When used |
|---|---|---|
| `CommandValidationError` | `command_validation` | Required field missing, malformed, or structurally invalid |
| `CommandNotFoundError` | `command_not_found` | Plan, workflow, execution, or lease not found |
| `CommandUnsupportedError` | `command_unsupported` | Operation not supported in the current adapter/harness context |
| `CommandDegradedError` | `command_degraded` | Operation partially succeeded or ran with reduced capability |
| `CommandLifecycleError` | `command_lifecycle` | A lifecycle method returned a typed `LifecycleError` |

`CommandUnsupportedError` and `CommandDegradedError` are available for adapters that need to
signal partial or unsupported behavior explicitly. The six engine operations in this spec do
not emit them directly — they are reserved for adapter-layer projection results and future
operations that may have harness-specific capability gaps.

---

## Security Notes

- All six operations require explicit user invocation. No session hook, idle hook, or
  `session.created` event may call any command operation.
- `abort-execution` and `advance-step` validate the `leaseId` before mutating state,
  preventing accidental or malicious interference with a different active execution.
- `runtime-health` never includes credentials, API keys, local paths beyond
  workspace-relative references, or harness config contents in its result. Adapters are
  responsible for sanitizing `runtimeStatus` and `details` fields in the health report
  before passing it to the engine.
- Tool-policy enforcement occurs after the adapter maps concrete OpenCode tools to abstract
  capabilities, preventing policy bypass through harness-specific tool names. See
  [Spec 13](../13-spec-minimal-execution-lifecycle-surface/13-spec-minimal-execution-lifecycle-surface.md)
  for the `beforeTool` lifecycle method that enforces abstract tool policy.
