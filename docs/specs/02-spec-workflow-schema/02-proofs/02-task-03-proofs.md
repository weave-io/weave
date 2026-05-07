# Task 03 Proofs — Completion Mapping and Workflow Transform in Validator

## Task Summary

`packages/core/src/validate.ts` was updated with a new `transformStepProperties()` helper that handles the step-level AST → plain object transform. It maps the step block name to `name`, maps the inner `name` property to `display_name`, converts bare identifier completions to `{ method: "..." }`, and converts named block completions (with `__name`) to `{ method: "...", ...params }`. The `case "workflow"` branch in `astToPlainObject()` now delegates to this helper.

## What This Task Proves

- Bare completion identifiers (`user_confirm`, `agent_signal`, `review_verdict`) round-trip correctly through `validate()`.
- Named block completions (`plan_created`, `plan_complete`) produce the correct discriminated union shape.
- `on_reject` is accepted on gate steps and rejected on non-gate steps.
- Missing `agent` field produces a clear error path (`workflows.w.steps.0.agent`).
- `inputs`/`outputs` arrays validate correctly.
- Step block name maps to `name`; inner `name` property maps to `display_name`.
- All 22 validate tests pass (15 original + 7 new).

## Evidence Summary

7 new tests in `describe("validate — workflows")` cover every transform rule. All pass.

## Artifact: Validate test run

**What it proves:** All completion forms, on_reject constraint, name/display_name mapping, and artifact arrays work end-to-end through the validator.
**Command:**

```bash
bun test packages/core/src/__tests__/validate.test.ts
```

**Result summary:** 22 pass, 0 fail.

```
(pass) validate — workflows > bare completion identifier (user_confirm) round-trips correctly
(pass) validate — workflows > named block completion (plan_created) round-trips correctly
(pass) validate — workflows > on_reject pause on a gate step is accepted
(pass) validate — workflows > on_reject on a non-gate step is rejected
(pass) validate — workflows > missing required agent field produces clear error path
(pass) validate — workflows > inputs and outputs arrays validate correctly
(pass) validate — workflows > step block name maps to name; inner name property maps to display_name

 22 pass
 0 fail
 59 expect() calls
Ran 22 tests across 1 file.
```

## Reviewer Conclusion

The validator correctly transforms all DSL completion forms into typed `CompletionMethod` objects and enforces all schema constraints. No regressions in the 15 pre-existing validate tests.
