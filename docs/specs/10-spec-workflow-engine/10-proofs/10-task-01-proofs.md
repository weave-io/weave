# Task 01 Proofs - Workflow start validation and execution context

## Task Summary

This task proves that `startExecution` validates workflow names against declared `WeaveConfig.workflows` before creating instances, initializes instances with correct fields (workflowName, goal, slug, currentStepName), acquires execution leases, and enforces the single-active-execution invariant.

## What This Task Proves

- `startExecution` rejects unknown workflow names with a typed `LifecycleError` before any store I/O.
- Valid workflow names create `WorkflowInstance` with correct `workflowName`, `goal`, `slug`, `currentStepName` (first step), and acquire an `ExecutionLease`.
- A second `startExecution` while a lease is active returns a `lease_conflict` error.
- New `WorkflowExecutionContext` type is exported from `@weaveio/weave-engine`.

## Evidence Summary

- 145 tests pass in `execution-lifecycle.test.ts` (10 new tests in `startExecution: WorkflowExecutionContext` suite).
- `bun run typecheck` exits 0 across all 5 packages.

## Artifact: Unit test suite — workflow start validation

**What it proves:** All acceptance criteria for task 1.0 are covered by automated tests.

**Why it matters:** Tests are the primary proof that the implementation behaves correctly under all specified conditions.

**Command:**

```bash
bun test packages/engine/src/__tests__/execution-lifecycle.test.ts
```

**Result summary:** 145 tests pass, 0 fail. New suite `startExecution: WorkflowExecutionContext` covers: unknown workflow rejection (not_found error), empty workflowName (validation error), valid workflow instance creation with correct fields, first-step currentStepName initialization, lease acquisition, and active-lease conflict (lease_conflict error).

```
 145 pass
 0 fail
 446 expect() calls
Ran 145 tests across 1 file. [65.00ms]
```

## Artifact: Typecheck — workspace-wide compilation

**What it proves:** New `WorkflowExecutionContext` type and updated `startExecution` signature compile across all packages.

**Why it matters:** Confirms the public API is type-safe and no downstream packages are broken.

**Command:**

```bash
bun run typecheck
```

**Result summary:** All 5 packages exit 0.

```
@weaveio/weave-core typecheck: Exited with code 0
@weaveio/weave-engine typecheck: Exited with code 0
@weaveio/weave-adapter-opencode typecheck: Exited with code 0
@weaveio/weave-config typecheck: Exited with code 0
@weaveio/weave-cli typecheck: Exited with code 0
```

## Artifact: New types exported from @weaveio/weave-engine

**What it proves:** `WorkflowExecutionContext` is accessible to adapters and downstream consumers.

**Why it matters:** Adapters need to construct and pass this context to `startExecution`.

**Files changed:**
- `packages/engine/src/execution-lifecycle.ts` — added `WorkflowExecutionContext` interface and `resolveInstanceFields()` helper; updated `StartExecutionInput` with optional `context?: WorkflowExecutionContext`
- `packages/engine/src/index.ts` — added `WorkflowExecutionContext` to barrel exports

## Reviewer Conclusion

Task 1.0 is complete: `startExecution` now validates workflow names against declared config, initializes instances with correct fields, and enforces the single-active-execution invariant. All 145 tests pass and the workspace typechecks cleanly.
