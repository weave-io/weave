# Task 05 Proof Artifact — Document Workflow Engine Behavior and Pass Quality Gates

**Task**: 5/5 — Document workflow engine behavior and pass quality gates  
**Date**: 2026-05-21  
**Status**: ✅ Complete

---

## Summary of Documentation Changes

Three documentation files were updated to describe the workflow engine's behavior. No existing content was removed — only additive sections were appended or inserted.

### 1. `docs/adapter-boundary.md` — Workflow Engine section added

A new `## Workflow Engine` section was appended at the end of the file (after the Execution Lifecycle Surface section). It contains:

- A 7-row ownership matrix covering: workflow topology, artifact resolution, completion method evaluation, gate decisions, abstract lifecycle effects (engine-owned); harness event detection/mapping and effect materialization (adapter-owned).
- Detailed prose for each engine responsibility: topology (step ordering), artifact resolution (all-or-nothing validation), completion method semantics (all 5 methods), gate decisions (`on_reject` policy: pause/fail/retry), and abstract effects.
- Adapter responsibilities: providing `WorkflowExecutionContext`, applying `LifecycleEffect` values.
- Anti-patterns with ❌/✅ code examples.

**Key added section excerpt:**

```markdown
## Workflow Engine

> **Spec:** [Spec 10 — Workflow Engine](specs/10-spec-workflow-engine/10-spec-workflow-engine.md)

### Ownership Matrix — Workflow Engine

| Concern | Owner | Why |
| --- | --- | --- |
| Workflow topology (step order, step count, final-step detection) | Engine | Derived from `WorkflowConfig.steps` — a Weave-owned data structure |
| Artifact resolution (validating declared `inputs`/`outputs`, persisting artifacts) | Engine | Artifact state is Weave runtime state stored in the Runtime Store |
| Completion method evaluation (`agent_signal`, `user_confirm`, `review_verdict`, `plan_created`, `plan_complete`) | Engine | Completion semantics are defined by the Weave DSL schema |
| Gate decisions (approve/reject, `on_reject` policy: `pause`/`fail`/`retry`) | Engine | Policy evaluation is harness-neutral; the engine reads `on_reject` from `WorkflowStep` |
| Abstract lifecycle effects (`dispatch-agent`, `pause-execution`, `complete-execution`) | Engine | Effects are pure data records; the engine emits them, adapters apply them |
| Harness event detection and mapping into lifecycle inputs | Adapter | Event names, payloads, and callback registration are harness-specific |
| Materializing lifecycle effects in the concrete harness | Adapter | Spawning agents, pausing sessions, updating UI state are harness-specific |
```

---

### 2. `docs/workflow-schema.md` — Execution Semantics section added

A new `## Execution Semantics` section was inserted before the `## Complete Example` section. It contains:

- **Step Ordering** — how `startExecution` sets `currentStepName` to `steps[0].name`; how `completeStep` advances by index; no branching.
- **Input/Output Artifact Passing** — `outputs` validation (all-or-nothing, persisted via `addArtifact()`); `inputs` validation (must be present before dispatch); template variable rendering.
- **Completion Method Evaluation** — table of all 5 methods with signal requirements and engine behaviour; method mismatch returns `validation` error.
- **`on_reject` Handling** — table of `pause`/`fail`/`retry` with exact engine actions; default to `pause` when absent.
- **Prompt Template Rendering** — Mustache variables available; `promptMetadata` carries only `byteLength`.
- **Security Invariants** — `StepCompletionSignal` structural exclusions; `promptMetadata` byte-length-only; `SafeMetadata` denylist.

**Key added section excerpt:**

```markdown
## Execution Semantics

### Completion Method Evaluation

| Method | Signal requirements | Engine behaviour |
| --- | --- | --- |
| `agent_signal` | `outcome: "success"` | Treat as success; auto-advance to next step |
| `user_confirm` | `outcome: "success"` | Treat as success; auto-advance to next step |
| `review_verdict` | `outcome: "success"`, `approved: boolean` | `approved: true` → advance; `approved: false` → apply `on_reject` policy |
| `plan_created` | `outcome: "success"` | Check `.weave/plans/<plan_name>.md` exists |
| `plan_complete` | `outcome: "success"` | Check plan file has no `- [ ]` checkboxes remaining |

### `on_reject` Handling

| `on_reject` value | Engine action |
| --- | --- |
| `pause` | Transitions instance to `paused` status, releases the execution lease, emits `pause-execution` effect. |
| `fail` | Transitions instance to `failed` status (terminal), releases the execution lease, emits `complete-execution` effect. |
| `retry` | Re-dispatches the same step with a fresh `correlationId`. The instance status remains `running`. |
```

---

### 3. `packages/engine/README.md` — Workflow Engine Behavior subsection added

A new `### Workflow Engine Behavior` subsection was inserted inside the `## Execution Lifecycle Surface` section, before the `### registerHook() — superseded` subsection. It contains:

- 4-point numbered list of engine behaviors: topology validation, step dispatch, step completion/auto-advance, completion method evaluation with gate rejection policy.
- `WorkflowExecutionContext` interface definition with field-level comments.
- Prose on adapter responsibility for providing context and applying effects.
- Security invariants: `promptMetadata` byte-length-only, `StepCompletionSignal` structural exclusions.
- Cross-links to `docs/adapter-boundary.md#workflow-engine` and `docs/workflow-schema.md#execution-semantics`.

**Key added section excerpt:**

```markdown
### Workflow Engine Behavior

**Required adapter-provided context** — `WorkflowExecutionContext`:

```ts
interface WorkflowExecutionContext {
  workflowName: string;           // logical workflow name (must exist in workflows map)
  goal: string;                   // human-readable goal for this execution instance
  slug: string;                   // URL-safe slug for this execution instance
  workflows: Record<string, WorkflowConfig>; // narrow slice of WeaveConfig.workflows
}
```
```

---

## Quality Gate Results

### `bun run lint` — ✅ EXIT 0

```
Checked 108 files in 32ms. No fixes applied.
Found 37 warnings.
Found 19 infos.
EXIT:0
```

Warnings are pre-existing `noNonNullAssertion` style warnings in test files — not introduced by this task. No errors.

---

### `bun run typecheck` — ✅ EXIT 0

```
$ tsc --noEmit -p tsconfig.json && bun run --filter '*' typecheck
@weave/core typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
@weave/config typecheck: Exited with code 0
@weave/cli typecheck: Exited with code 0
TYPECHECK_EXIT:0
```

All 5 packages typecheck clean.

---

### `bun test` — ✅ EXIT 0 (1527 pass, 0 fail)

```
bun test v1.3.13 (bf2e2cec)

 1527 pass
 0 fail
 4189 expect() calls
Ran 1527 tests across 42 files. [924.00ms]
TEST_EXIT:0
```

---

### `bun run build` — ✅ EXIT 0

```
@weave/cli build:   index.js  1.35 MB  (entry point)
@weave/cli build:   main.js   1.35 MB  (entry point)
@weave/cli build: Exited with code 0
@weave/adapter-opencode build: Bundled 1 module in 2ms
@weave/adapter-opencode build:   index.js  83 bytes  (entry point)
@weave/adapter-opencode build: Exited with code 0
BUILD_EXIT:0
```

---

## Security Confirmation

- **No raw prompts** appear in any proof artifact, runtime journal, or emitted effect. `promptMetadata` in `RunAgentEffect` carries only `byteLength`.
- **No credentials, tokens, or API keys** appear in any documentation, proof artifact, or code change.
- **No `.env` values** are referenced or exposed.
- **No harness-private paths** (OpenCode/Pi/Claude Code internal directories) appear in engine documentation.
- `StepCompletionSignal` and `SafeMetadata` structural exclusions are documented accurately per the implementation in `execution-lifecycle.ts`.
- The `LIFECYCLE_DENIED_METADATA_KEYS` denylist (covering `token`, `apiKey`, `password`, `prompt`, `completion`, `transcript`, etc.) is referenced in the security invariants sections.

---

## Files Changed

| File | Change |
| --- | --- |
| `docs/adapter-boundary.md` | Added `## Workflow Engine` section (62 lines) at end of file |
| `docs/workflow-schema.md` | Added `## Execution Semantics` section (66 lines) before `## Complete Example` |
| `packages/engine/README.md` | Added `### Workflow Engine Behavior` subsection (26 lines) inside `## Execution Lifecycle Surface` |
| `docs/specs/10-spec-workflow-engine/10-proofs/10-task-05-proofs.md` | Created this proof artifact |
