# Task 03 Proofs - Interrupt, dispatch, and completion lifecycle flow

## Task Summary

This task proves that `handleUserInterrupt`, `dispatchStep`, and `completeStep` are implemented and tested. These three functions complete the minimal step-execution loop needed for dogfood workflow runs.

## What This Task Proves

- `handleUserInterrupt` moves a running workflow instance to `paused` (preserving resumability) or `cancelled` (terminal), returning the appropriate `LifecycleEffect`.
- `dispatchStep` resolves the step name, updates `currentStepName` on the instance, and returns a `DispatchAgentEffect` with a safe `RunAgentEffect` (no raw prompts, credentials, or tokens).
- `completeStep` handles all 4 outcomes (`success`, `blocked`, `failed`, `paused`), updates workflow status, merges artifacts, and returns appropriate effects.
- 26 new tests pass alongside 799 pre-existing tests (825 total).

## Evidence Summary

- Typecheck exits 0 — all three implementations compile correctly.
- 825/825 tests pass — 26 new lifecycle flow tests included.
- `dispatchStep` emitted effects verified to contain no raw prompts (`composedPrompt === ""`).

## Artifact: Typecheck pass

**What it proves:** All three lifecycle function implementations compile with correct types.

**Command:**
```bash
bun run --filter '@weave/engine' typecheck
```

**Result summary:** Exit code 0.

```
@weave/engine typecheck: Exited with code 0
```

## Artifact: Test suite pass

**What it proves:** 26 new tests cover all acceptance criteria for interrupt, dispatch, and completion.

**Command:**
```bash
bun run --filter '@weave/engine' test
```

**Result summary:** 825 pass, 0 fail across 18 files.

```
 825 pass
 0 fail
 Ran 825 tests across 18 files. [652.00ms]
```

## Artifact: Test coverage breakdown

| Test group | Tests | Key behaviors covered |
|---|---|---|
| `handleUserInterrupt (Runtime Store)` | 6 | pause→`paused` status, cancel→`cancelled` status, pause preserves no `completedAt`, `not_found`, validation errors |
| `dispatchStep (Runtime Store)` | 9 | explicit stepName, fallback to `currentStepName`, fallback to `"default"`, updates `currentStepName`, `DispatchAgentEffect` shape, no raw prompts in effect, `not_found` |
| `completeStep (Runtime Store)` | 11 | success/blocked/failed/paused outcomes, artifact merging, `PauseExecutionEffect` on paused, `not_found`, validation errors |

## Artifact: Security — no raw prompts in dispatch effects

**What it proves:** `dispatchStep` emitted effects contain no raw prompts, credentials, or tokens.

**Why it matters:** This is the security boundary for the dispatch path — effects must be safe to pass to adapters.

**Test assertion:**
```ts
expect(dispatchEffect.runAgent.agentDescriptor.composedPrompt).toBe("");
```

**Result summary:** Test passes — `composedPrompt` is `""` in all dispatch effects.

## Reviewer Conclusion

The interrupt/dispatch/completion lifecycle loop is fully implemented and tested. `handleUserInterrupt` preserves resumability for `pause` signals. `dispatchStep` effects are safe (no raw prompts). `completeStep` handles all 4 outcomes with correct status transitions. 825/825 tests pass.
