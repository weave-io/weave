# Task 04 Proofs - Evaluate completion methods and gate rejection policies

## Task Summary

This task proves that `completeStep` validates completion signals against the step's declared `completion.method`, implements all five completion methods (`agent_signal`, `user_confirm`, `review_verdict`, `plan_created`, `plan_complete`), and applies `on_reject` policies (`pause`, `fail`, `retry`) for rejected gate steps.

## What This Task Proves

- `agent_signal`, `user_confirm`, and `review_verdict` signals are accepted only when they match the step's declared `completion.method` — mismatches return typed `validation` errors before any state changes.
- `plan_created` renders `plan_name` and checks `.weave/plans/<name>.md` exists — returns `not_found` if missing.
- `plan_complete` renders `plan_name`, reads the file, and rejects with `validation` error if any `- [ ]` incomplete checkboxes remain.
- Approved `review_verdict` gate steps advance normally (same as success).
- Rejected gate steps: `on_reject: "pause"` → paused + `pause-execution`; `on_reject: "fail"` → failed + lease released; `on_reject: "retry"` → re-dispatch same step with fresh correlationId.

## Evidence Summary

- 18 new unit tests in `execution-lifecycle.test.ts` covering all acceptance criteria.
- Full test suite: 1527 pass, 0 fail.
- `bun run typecheck` passes across all 5 packages.

## Artifact: Unit test results

**What it proves:** All new completion method and gate rejection tests pass alongside existing tests.

**Why it matters:** Confirms the completion validation and gate rejection logic works correctly for all five methods and all three `on_reject` policies.

**Command:**
```bash
bun test packages/engine/src/__tests__/execution-lifecycle.test.ts
```

**Result summary:** 195 pass, 0 fail. New `describe("completeStep: completion method validation and gate logic")` suite with 18 tests all pass.

```
✓ completeStep: completion method validation > method mismatch returns validation error
✓ completeStep: completion method validation > no method skips validation (legacy path)
✓ completeStep: completion method validation > agent_signal accepted when matching
✓ completeStep: completion method validation > user_confirm accepted when matching
✓ completeStep: completion method validation > review_verdict approved advances to next step
✓ completeStep: completion method validation > review_verdict rejected + on_reject pause → paused status
✓ completeStep: completion method validation > review_verdict rejected + on_reject pause → pause-execution effect
✓ completeStep: completion method validation > review_verdict rejected + on_reject fail → failed status
✓ completeStep: completion method validation > review_verdict rejected + on_reject fail → lease released
✓ completeStep: completion method validation > review_verdict rejected + on_reject fail → complete-execution effect
✓ completeStep: completion method validation > review_verdict rejected + on_reject fail → errorMessage set
✓ completeStep: completion method validation > review_verdict rejected + on_reject retry → dispatch-agent for same step
✓ completeStep: completion method validation > review_verdict rejected + on_reject retry → fresh UUID correlationId
✓ completeStep: completion method validation > review_verdict rejected + on_reject retry → instance stays running
✓ completeStep: completion method validation > review_verdict rejected + on_reject retry → unique correlationIds per retry
✓ completeStep: completion method validation > plan_created returns not_found when file missing
✓ completeStep: completion method validation > plan_created succeeds when file exists
✓ completeStep: completion method validation > plan_complete returns validation error when incomplete checkboxes
✓ completeStep: completion method validation > plan_complete succeeds when all checkboxes checked

195 pass, 0 fail
```

## Artifact: Full test suite

**What it proves:** No regressions introduced across the workspace.

**Command:**
```bash
bun test
```

**Result summary:** 1527 pass, 0 fail across 42 files.

```
1527 pass
0 fail
Ran 1527 tests across 42 files.
```

## Artifact: Typecheck results

**What it proves:** Extended `StepCompletionSignal` with `method` and `approved` fields compiles across the workspace.

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

## Artifact: StepCompletionSignal extension

**What it proves:** The signal type now carries method-specific data without accepting ambiguous success values.

**Why it matters:** Typed signals prevent callers from passing mismatched completion data.

**New fields added to `StepCompletionSignal`:**
- `method?: "agent_signal" | "user_confirm" | "review_verdict" | "plan_created" | "plan_complete"` — when present, validated against step's declared completion method
- `approved?: boolean` — for `review_verdict` signals: `true` = advance normally, `false` = apply `on_reject` policy

**Validation behavior:**
- Method present + matches step config → proceeds
- Method present + mismatches step config → `validation` error with `field: "completion.method"` before any state changes
- Method absent → legacy path, no validation (backward compatible)

## Reviewer Conclusion

Task 4 is complete. All five completion methods are implemented and validated. Gate rejection policies (`pause`, `fail`, `retry`) work correctly with the expected status transitions, lease management, and lifecycle effects. The implementation is backward compatible — existing callers without `method` in their signal continue to work via the legacy path.
