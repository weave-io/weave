# Task 02 Proofs — Workflow and Step Zod Schemas

## Task Summary

Six new Zod schemas were added to `packages/core/src/schema.ts`: `WorkflowStepTypeSchema`, `CompletionMethodSchema` (discriminated union on `method`), `ArtifactRefSchema`, `OnRejectSchema`, `WorkflowStepSchema` (with `.refine()` enforcing gate-only `on_reject`), and `WorkflowConfigSchema`. The `WeaveConfigSchema.workflows` field was upgraded from `z.unknown()` to `z.record(z.string(), WorkflowConfigSchema).default({})`. All six inferred types are exported.

## What This Task Proves

- All five `CompletionMethod` variants are accepted when valid and rejected when invalid.
- `WorkflowStepSchema` rejects `on_reject` on non-gate steps.
- `WorkflowConfigSchema` rejects empty `steps`, missing `version`, non-integer `version`, and zero `version`.
- All 27 new schema tests pass.
- `bun run typecheck` passes with zero errors.

## Evidence Summary

27 tests in `packages/core/src/__tests__/schema.test.ts` cover every schema and constraint. All pass.

## Artifact: Schema test run

**What it proves:** Every new schema correctly validates and rejects inputs according to spec.
**Why it matters:** Confirms all five completion method variants, on_reject gate constraint, and WorkflowConfig shape are enforced by Zod.
**Command:**

```bash
bun test packages/core/src/__tests__/schema.test.ts
```

**Result summary:** 27 pass, 0 fail.

```
(pass) WorkflowStepTypeSchema > accepts valid step types
(pass) WorkflowStepTypeSchema > rejects invalid step type
(pass) CompletionMethodSchema > accepts agent_signal (no extra fields)
(pass) CompletionMethodSchema > accepts user_confirm (no extra fields)
(pass) CompletionMethodSchema > accepts plan_created with plan_name
(pass) CompletionMethodSchema > rejects plan_created without plan_name
(pass) CompletionMethodSchema > accepts plan_complete with plan_name
(pass) CompletionMethodSchema > rejects plan_complete without plan_name
(pass) CompletionMethodSchema > accepts review_verdict (no extra fields)
(pass) CompletionMethodSchema > rejects unknown completion method
(pass) CompletionMethodSchema > rejects missing method field
(pass) OnRejectSchema > accepts pause, fail, retry
(pass) OnRejectSchema > rejects invalid value
(pass) WorkflowStepSchema > accepts a valid step with required fields only
(pass) WorkflowStepSchema > accepts a gate step with on_reject
(pass) WorkflowStepSchema > rejects on_reject on a non-gate step
(pass) WorkflowStepSchema > rejects missing required field: agent
(pass) WorkflowStepSchema > rejects missing required field: prompt
(pass) WorkflowStepSchema > rejects missing required field: completion
(pass) WorkflowStepSchema > rejects invalid type value
(pass) WorkflowStepSchema > accepts step with inputs and outputs arrays
(pass) WorkflowStepSchema > accepts optional display_name
(pass) WorkflowConfigSchema > accepts a valid workflow config
(pass) WorkflowConfigSchema > rejects empty steps array
(pass) WorkflowConfigSchema > rejects missing version
(pass) WorkflowConfigSchema > rejects non-integer version
(pass) WorkflowConfigSchema > rejects zero version (must be positive)

 27 pass
 0 fail
 37 expect() calls
Ran 27 tests across 1 file.
```

## Artifact: Type check

**What it proves:** Schema changes introduce no TypeScript errors.
**Command:**

```bash
bun run typecheck
```

**Result summary:** Zero errors.

```
@weave/core typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
```

## Reviewer Conclusion

All workflow schemas are correctly defined. Every constraint from the spec (discriminated union, gate-only on_reject, positive-integer version, non-empty steps) is enforced by Zod and verified by tests.
