# Task 03 Proofs - Complete successful steps, persist artifacts, and auto-advance

## Task Summary

This task proves that `completeStep` on a successful outcome: validates output artifacts against declared `step.outputs`, persists them via `store.instances.addArtifact()`, auto-advances to the next step (updating `currentStepName` and emitting a `dispatch-agent` effect), and for the final step transitions the instance to `completed`, releases the active lease, and emits `complete-execution`. An integration test proves artifacts produced by one step are available to a later step's rendered prompt.

## What This Task Proves

- Successful non-final step: persists declared output artifacts and emits `dispatch-agent` for the next step.
- Undeclared/malformed output artifacts return a typed `validation` error with no partial writes (all-or-nothing).
- Successful final step: transitions to `completed`, emits `complete-execution`, releases the active lease.
- Integration: 2-step workflow where step 1 outputs `plan_path` and step 2's prompt `{{artifacts.plan_path}}` renders with the persisted value.

## Evidence Summary

- 13 new unit tests in `execution-lifecycle.test.ts` covering all acceptance criteria.
- 1 new integration test in `execution-lifecycle-integration.test.ts` proving end-to-end artifact passing.
- Full test suite: 1509 pass, 0 fail.
- `bun run typecheck` passes across all 5 packages.

## Artifact: Unit test results

**What it proves:** All new `completeStep` auto-advance tests pass alongside existing tests.

**Why it matters:** Confirms the configured completion path works correctly for non-final steps, final steps, and error cases.

**Command:**
```bash
bun test packages/engine/src/__tests__/execution-lifecycle.test.ts
```

**Result summary:** 177 pass, 0 fail. New `describe("completeStep: configured workflow step auto-advance")` suite with 13 tests all pass.

```
✓ completeStep: configured workflow step auto-advance > non-final step emits dispatch-agent for next step
✓ completeStep: configured workflow step auto-advance > non-final step persists declared output artifacts
✓ completeStep: configured workflow step auto-advance > non-final step updates currentStepName to next step
✓ completeStep: configured workflow step auto-advance > non-final step keeps running status
✓ completeStep: configured workflow step auto-advance > undeclared output artifact returns validation error
✓ completeStep: configured workflow step auto-advance > undeclared artifact causes no partial writes
✓ completeStep: configured workflow step auto-advance > step with no declared outputs accepts any artifacts
✓ completeStep: configured workflow step auto-advance > final step emits complete-execution
✓ completeStep: configured workflow step auto-advance > final step transitions to completed status
✓ completeStep: configured workflow step auto-advance > final step releases active lease
✓ completeStep: configured workflow step auto-advance > single-step workflow completes immediately
✓ completeStep: configured workflow step auto-advance > legacy path: paused emits pause-execution
✓ completeStep: configured workflow step auto-advance > auto-advance prompt metadata reflects persisted artifact

177 pass, 0 fail
```

## Artifact: Integration test results

**What it proves:** End-to-end multi-step workflow where step 1 outputs an artifact consumed by step 2's rendered prompt.

**Why it matters:** Confirms the full artifact-passing pipeline works: persist → auto-advance → render in next step's prompt.

**Command:**
```bash
bun test packages/engine/src/__tests__/execution-lifecycle-integration.test.ts
```

**Result summary:** 11 pass, 0 fail. New integration test drives the full flow: `startExecution` → `dispatchStep(plan)` → `completeStep(plan, artifacts)` → `dispatchStep(implement)` → `completeStep(implement)`.

```
✓ multi-step workflow: artifact produced by step 1 available in step 2 prompt > full 2-step workflow with artifact passing

11 pass, 0 fail
```

## Artifact: Full test suite

**What it proves:** No regressions introduced across the workspace.

**Command:**
```bash
bun test
```

**Result summary:** 1509 pass, 0 fail across 42 files.

```
1509 pass
0 fail
4037 expect() calls
Ran 1509 tests across 42 files.
```

## Artifact: Typecheck results

**What it proves:** `CompleteStepInput.context` and `complete-execution` effect type compile across the workspace.

**Command:**
```bash
bun run typecheck
```

**Result summary:** All 5 packages pass with exit 0.

```
@weave/core: exit 0
@weave/engine: exit 0
@weave/adapter-opencode: exit 0
@weave/config: exit 0
@weave/cli: exit 0
```

## Reviewer Conclusion

Task 3 is complete. `completeStep` now validates output artifacts against declared `step.outputs` (all-or-nothing), persists them, auto-advances to the next step with a `dispatch-agent` effect, and for the final step transitions to `completed`, releases the lease, and emits `complete-execution`. The integration test confirms the full artifact-passing pipeline works end-to-end.
