# Task 02 Proofs - Dispatch configured workflow steps as abstract effects

## Task Summary

This task proves that `dispatchStep` resolves workflow steps from `WorkflowConfig.steps`, uses `step.agent` as the agent name, renders `step.prompt` through `renderTemplate()` with a workflow template context, validates declared `step.inputs` artifacts, and emits a `RunAgentEffect` with abstract policy, completion expectation, model, skill, prompt metadata, and correlation data — no concrete harness tool names.

## What This Task Proves

- `dispatchStep` resolves the current `WorkflowConfig.steps` entry using `input.stepName` → `instance.currentStepName` → first declared step.
- The emitted effect uses `step.agent` (not the step name) as the agent name.
- `step.prompt` is rendered through `renderTemplate()` with `instance.goal`, `instance.slug`, and `{{artifacts.plan_path}}` references.
- Missing required `step.inputs` artifacts return a typed `not_found` error before dispatch.
- Emitted effects contain `completionMethod`, `stepType`, `correlationId`, `promptMetadata` — no concrete harness tool names or session mutations.

## Evidence Summary

- 19 new tests added to `execution-lifecycle.test.ts` covering all acceptance criteria.
- Full test suite: 164 pass, 0 fail (145 existing + 19 new).
- `bun run typecheck` passes across all 5 packages.

## Artifact: Test suite results

**What it proves:** All new dispatch tests pass alongside existing tests.

**Why it matters:** Confirms the configured dispatch path works correctly without breaking existing behavior.

**Command:**
```bash
bun test packages/engine/src/__tests__/execution-lifecycle.test.ts
```

**Result summary:** 164 pass, 0 fail. New `describe("dispatchStep: configured workflow step resolution")` suite with 19 tests all pass.

```
bun test v1.3.10
packages/engine/src/__tests__/execution-lifecycle.test.ts:
✓ dispatchStep: configured workflow step resolution > resolves step by input.stepName
✓ dispatchStep: configured workflow step resolution > resolves step by instance.currentStepName when no input.stepName
✓ dispatchStep: configured workflow step resolution > resolves first step when no stepName and no currentStepName
✓ dispatchStep: configured workflow step resolution > returns not_found error for unknown step name
✓ dispatchStep: configured workflow step resolution > uses step.agent as agentName (not step name)
✓ dispatchStep: configured workflow step resolution > renders {{instance.goal}} in step prompt
✓ dispatchStep: configured workflow step resolution > renders {{instance.slug}} in step prompt
✓ dispatchStep: configured workflow step resolution > renders {{artifacts.plan_path}} in step prompt
✓ dispatchStep: configured workflow step resolution > returns not_found error when required input artifact is missing
✓ dispatchStep: configured workflow step resolution > does not dispatch when required input artifact is missing
✓ dispatchStep: configured workflow step resolution > emits completionMethod from step.completion.method
✓ dispatchStep: configured workflow step resolution > emits stepType from step.type
✓ dispatchStep: configured workflow step resolution > emits correlationId as UUID
✓ dispatchStep: configured workflow step resolution > emits promptMetadata with byteLength
✓ dispatchStep: configured workflow step resolution > composedPrompt is empty string (no raw prompt in effect)
✓ dispatchStep: configured workflow step resolution > effect contains no concrete harness tool names
✓ dispatchStep: configured workflow step resolution > effect contains no session mutation fields
✓ dispatchStep: configured workflow step resolution > PromptMetadata type importable from @weaveio/weave-engine
✓ dispatchStep: configured workflow step resolution > legacy path preserved when no context provided

164 pass, 0 fail
```

## Artifact: Typecheck results

**What it proves:** New types (`PromptMetadata`, extended `RunAgentEffect`) compile across the workspace.

**Why it matters:** Confirms the public API changes are type-safe and don't break downstream packages.

**Command:**
```bash
bun run typecheck
```

**Result summary:** All 5 packages pass with exit 0.

```
@weaveio/weave-core: exit 0
@weaveio/weave-engine: exit 0
@weaveio/weave-adapter-opencode: exit 0
@weaveio/weave-config: exit 0
@weaveio/weave-cli: exit 0
```

## Artifact: Effect shape inspection

**What it proves:** Emitted `RunAgentEffect` contains abstract fields only — no concrete harness tool names or session mutations.

**Why it matters:** Confirms the engine/adapter boundary is respected: engine emits abstract effects, adapters apply them.

**Key fields in emitted effect:**
- `agentName`: value of `step.agent` (e.g. `"pattern"`, `"shuttle"`)
- `completionMethod`: value of `step.completion.method` (e.g. `"plan_created"`, `"review_verdict"`)
- `stepType`: value of `step.type` (e.g. `"autonomous"`, `"gate"`)
- `correlationId`: UUID string (e.g. `"550e8400-e29b-41d4-a716-446655440000"`)
- `promptMetadata`: `{ byteLength: number }` — structural metadata only, no raw prompt text
- `composedPrompt`: always `""` — raw rendered prompt never included in effect

**Absent fields (confirmed by tests):**
- No `toolNames`, `sessionId`, `harnessConfig`, or any harness-specific fields

## Reviewer Conclusion

Task 2 is complete. `dispatchStep` now resolves workflow steps from config, uses `step.agent` as the agent name, renders prompts with template context, validates required input artifacts, and emits abstract effects with completion metadata and correlation IDs. The engine/adapter boundary is preserved: no concrete harness tool names or session mutations appear in emitted effects.
