# 29-implementation-proof.md

**Spec**: [29 — Default Usage Is Not Workflow-Driven](../29-spec-default-usage-not-workflow-driven.md)  
**Related**: [ADR 0006](../../../adr/0006-end-to-end-orchestration-flow.md) · [ADR 0004](../../../adr/0004-workflow-first-execution-contract.md) · [Spec 22](../../22-spec-workflow-first-execution/22-spec-workflow-first-execution.md) · [Workflow Schema](../../../workflow-schema.md) · [Product Vision](../../../product-vision.md)  
**Date**: 2026-06-04

---

## Summary

This document records the implementation evidence for Spec 29. All four demoable units are satisfied. The repository now has one consistent default mental model: ordinary Weave usage is Loom-led; workflows are explicit, user-invoked constructs.

---

## Unit 1 — Default orchestration model is Loom-led

### Evidence: Loom prompt (`packages/config/prompts/loom.md`)

Lines 27–50 of the Loom prompt carry the authoritative runtime statement:

```
# Default Orchestration

Ordinary Weave usage is Loom-led. Do not implicitly start a workflow — workflows are explicit, user-invoked constructs.

## Large or multi-step work

For work that spans multiple files, components, or steps, the path is:

1. **Delegate to Pattern** — Pattern creates an inspectable plan artifact in the plans directory.
2. **Stop and tell the user** — once the plan exists, do not proceed further. Tell the user the plan is ready
   and instruct them to run the adapter's explicit start command (e.g. `/weave:start` if the adapter exposes
   a command surface) to begin execution. Do not start execution yourself.

The user must explicitly authorize execution. Ordinary conversation, idle events, and continuation hooks
must never implicitly start durable execution.

## Explicit workflows (opt-in only)

Named workflows such as `plan-and-execute` are available when the user explicitly asks for one.
Do not select or invoke a workflow unless the user requests it by name.
```

### Validation command

```bash
grep -n "Default Orchestration\|Loom-led\|workflows are explicit\|Do not implicitly start" \
  packages/config/prompts/loom.md
```

**Output**:
```
27:# Default Orchestration
29:Ordinary Weave usage is Loom-led. Do not implicitly start a workflow — workflows are explicit, user-invoked constructs.
```

---

## Unit 2 — Plan creation and execution are separate user-visible stages

### Evidence: `startPlanExecution` (`packages/adapters/opencode/src/start-plan-execution.ts`)

The adapter-owned `/weave:start` delivery helper enforces the separation:

1. **Guard**: validates the plan exists via `PlanStateProvider.planExists()` before touching the store.
2. **Fail fast**: returns `PlanNotFound` if the plan is absent — no `WorkflowInstance` is created.
3. **Explicit workflow**: calls `runWorkflow` with `tapestry-execution` (execution-only workflow) only after the plan is confirmed.

Key constants (lines 48–72):

```typescript
export const WEAVE_START_COMMAND = "/weave:start" as const;
export const WEAVE_START_LEGACY_COMMAND = "/start-work" as const;
export const DEFAULT_EXECUTION_WORKFLOW = "tapestry-execution" as const;
```

### Evidence: `tapestry-execution` builtin workflow (`packages/config/src/builtins.ts`, lines 324–358)

`tapestry-execution` was updated to be execution-only — its description, first step, and completion method were revised so it requires an existing plan artifact. It has no planning step and no `role planning` annotation. Its first step (`execute`) uses `plan_complete` completion, which requires an existing plan:

```weave
workflow tapestry-execution {
  description "Execute an existing named plan end-to-end, then review"
  version 1

  step execute {
    name "Execute the existing plan"
    type autonomous
    agent shuttle
    prompt "Execute the existing plan named {{instance.slug}} for: {{instance.goal}}"
    completion plan_complete {
      plan_name "{{instance.slug}}"
    }
  }
  ...
}
```

> **Note**: The `execute` step has no `inputs` declaration. It is the first step in the workflow, so no prior step can populate an artifact. The prompt uses `{{instance.slug}}` (set at workflow start via `startPlanExecution`) rather than `{{artifacts.plan_path}}`. This is intentional: `tapestry-execution` is invoked when a plan already exists and its name is known; the slug carries that identity.

### Evidence: `start-plan-execution.test.ts` assertions

Test file `packages/adapters/opencode/src/__tests__/start-plan-execution.test.ts` proves:

- `WEAVE_START_COMMAND` is `/weave:start` (preferred)
- `DEFAULT_EXECUTION_WORKFLOW` is `tapestry-execution`
- When plan is missing → `PlanNotFound` error, store untouched
- When provider is unavailable → `ProviderUnavailable` error, store untouched
- When plan exists → `runWorkflow` called with `tapestry-execution`

### Validation command

```bash
bun test packages/adapters/opencode/src/__tests__/start-plan-execution.test.ts \
  packages/adapters/opencode/src/__tests__/run-workflow.test.ts \
  packages/adapters/opencode/src/__tests__/plugin.test.ts
```

**Output**:
```
bun test v1.3.13 (bf2e2cec)
 84 pass
 0 fail
 224 expect() calls
Ran 84 tests across 3 files. [125.00ms]
```

---

## Unit 3 — Default pre-plan behavior belongs to Loom, not workflow extension

### Evidence: Loom prompt carries pre-plan guidance

The `# Default Orchestration` section in `packages/config/prompts/loom.md` (lines 27–50) places all pre-plan routing logic in Loom's own prompt:

- Small/self-contained work → handle directly or delegate to Shuttle
- Large/multi-step work → delegate to Pattern, then stop and tell the user

No `before-plan` extension point is required for ordinary usage. The `before-plan` slot in `plan-and-execute` is user-configured and opt-in.

### Evidence: builtin config has no `default_workflow` selector

Test `(g11)` in `packages/config/src/__tests__/builtins.test.ts` (line 162):

```typescript
it("(g11) builtin config has no default_workflow selector — settings has no default_workflow field", () => {
  const config = getBuiltinConfig()._unsafeUnwrap();
  expect(
    (config.settings as Record<string, unknown>)["default_workflow"],
  ).toBeUndefined();
});
```

### Evidence: `plan-and-execute` remains available as explicit named workflow

Test `(g12)` in `packages/config/src/__tests__/builtins.test.ts` (line 170):

```typescript
it("(g12) plan-and-execute remains available as an explicit named workflow", () => {
  const config = getBuiltinConfig()._unsafeUnwrap();
  expect(config.workflows["plan-and-execute"]).toBeDefined();
  const wf = config.workflows["plan-and-execute"];
  const planStep = wf?.steps.find((s) => s.role === "planning");
  expect(planStep).toBeDefined();
  expect(planStep?.completion.method).toBe("plan_created");
});
```

### Validation command

```bash
bun test packages/config/src/__tests__/builtins.test.ts \
  packages/config/src/__tests__/builtin-compose-smoke.test.ts
```

**Output**:
```
bun test v1.3.13 (bf2e2cec)
 72 pass
 0 fail
 341 expect() calls
Ran 72 tests across 2 files. [96.00ms]
```

---

## Unit 4 — Existing architecture docs and specs reconciled to one model

### Evidence: ADR 0006 supersession notes

`docs/adr/0006-end-to-end-orchestration-flow.md` carries two targeted supersession blocks:

**Line 136** — "Where Issue #52 Fits" section:
```
> **⚠ Superseded interpretation** — The guidance below (adding `default_workflow`, selecting
> `plan-and-execute` as a hidden default, updating Loom's prompt to name a workflow) was the
> original reading of issue #52. [Spec 29 — Default Usage Is Not Workflow-Driven] supersedes
> that interpretation. Ordinary Weave usage is Loom-led; workflows are explicit, user-invoked
> constructs.
```

**Lines 181–185** — "What issue #52 would add" section:
```
> **⚠ Superseded** — See [Spec 29]. The items below reflect the original interpretation;
> they are preserved as historical context.

- ~~A `default_workflow` DSL field or equivalent engine/adapter convention.~~
  (Spec 29: ordinary usage is Loom-led; no hidden default workflow is selected.)
- ~~Optionally, a default `extend before-plan` configuration in builtins.~~
  (Spec 29: pre-plan behavior belongs to Loom config/prompt composition, not workflow extension machinery.)
- ~~A Loom prompt or routing update that names the canonical workflow for large work.~~
  (Spec 29: Loom's prompt may describe delegation intent, but it shall not implicitly select a workflow.)
```

### Evidence: Spec 22 partial supersession note

`docs/specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md`, Unit 2 (line 44):
```
> **⚠ Partial supersession** — The phrase "effective default workflow" in this unit originally
> implied that ordinary Weave usage is driven by an implicit builtin workflow. [Spec 29] supersedes
> that implication: ordinary usage is Loom-led, and workflows are explicit, user-invoked constructs.
```

### Evidence: `docs/workflow-schema.md` scope note

Lines 13–16:
```
> **Scope note**: Workflows are **explicit, user-invoked** constructs. They are not the default
> path for ordinary Weave usage. Ordinary usage is Loom-led: Loom handles conversational triage,
> delegates bounded tasks to Shuttle, and asks Pattern to create a plan when needed. A workflow
> begins only when a user explicitly invokes one (e.g. via `/weave:start` or an equivalent
> adapter command). See [Spec 29] for the authoritative statement of the default model.
```

### Evidence: `docs/dsl-reference.md` usage model note

Line 180:
```
> **Usage model**: Workflows are **explicit, user-invoked** constructs. They are not the default
> path for ordinary Weave usage. Ordinary usage is Loom-led: Loom handles conversational triage,
> delegates bounded tasks to Shuttle, and asks Pattern to create a plan when needed. A workflow
> begins only when a user explicitly invokes one (e.g. via `/weave:start` or an equivalent
> adapter command). See [Spec 29 — Default Usage Is Not Workflow-Driven].
```

### Evidence: `docs/README.md` navigation note

Line 40 (ADR 0006 entry):
```
**Note:** the "add default_workflow" guidance in the "Where Issue #52 Fits" section is superseded
by [Spec 29] — ordinary usage is Loom-led, not workflow-driven.
```

### Evidence: `docs/product-vision.md` reference

Line 35:
```
- workflow intent (for explicitly invoked workflows — see [Spec 29]; ordinary usage is Loom-led,
  not workflow-driven)
```

### Validation command

```bash
grep -rn "Spec 29\|supersed\|Loom-led\|not workflow-driven" \
  docs/adr/0006-end-to-end-orchestration-flow.md \
  docs/specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md \
  docs/workflow-schema.md \
  docs/product-vision.md \
  docs/README.md \
  docs/dsl-reference.md
```

---

## Full Validation Pass

### Config validation

```bash
bun run validate-config
```

**Output**:
```
$ bun packages/cli/src/main.ts validate --project
Weave config is valid.
agents: 2
categories: 5
workflows: 0
disabled: 0
log_level: INFO
```

### Typecheck

```bash
bun run typecheck
```

**Output**:
```
@weaveio/weave-core typecheck: Exited with code 0
@weaveio/weave-engine typecheck: Exited with code 0
@weaveio/weave-config typecheck: Exited with code 0
@weaveio/weave-adapter-opencode typecheck: Exited with code 0
@weaveio/weave-cli typecheck: Exited with code 0
```

### Build

```bash
bun run build
```

**Output** (final lines):
```
@weaveio/weave-adapter-opencode build: Bundled 435 modules in 15ms
@weaveio/weave-adapter-opencode build:   index.js  0.89 MB  (entry point)
@weaveio/weave-adapter-opencode build: Bundled 431 modules in 15ms
@weaveio/weave-adapter-opencode build:   plugin.js  0.84 MB  (entry point)
@weaveio/weave-adapter-opencode build: Exited with code 0
```

### All tests

```bash
bun test
```

**Output**:
```
bun test v1.3.13 (bf2e2cec)
 2676 pass
 0 fail
 7428 expect() calls
Ran 2676 tests across 64 files. [26.03s]
```

---

## No-default-workflow grep check

Confirms `default_workflow` appears only in:
- Test assertion `(g11)` (asserting its absence)
- ADR 0006 supersession notes (historical context, struck-through)
- Spec 29 itself (as the concept being rejected)
- `docs/specs/README.md` (description of Spec 29)

```bash
grep -rn "default_workflow" packages/ docs/ \
  | grep -v "node_modules\|dist\|\.git"
```

No live DSL field, no schema field, no engine API, no adapter convention uses `default_workflow`.

---

## Durable Docs Updated

Docs changed as part of Spec 29 implementation:

| Document | Change |
|---|---|
| `docs/adr/0006-end-to-end-orchestration-flow.md` | Two targeted supersession blocks; Spec 29 added to References |
| `docs/specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md` | Partial supersession note on Unit 2 |
| `docs/workflow-schema.md` | Scope note: workflows are explicit, user-invoked; Spec 29 linked |
| `docs/dsl-reference.md` | Usage model note in Workflows section; Spec 29 linked |
| `docs/product-vision.md` | Workflow intent note references Spec 29 |
| `docs/README.md` | ADR 0006 navigation entry carries supersession note |
| `docs/specs/README.md` | Spec 29 row added to index |
| `packages/config/prompts/loom.md` | `# Default Orchestration` section with Loom-led model and explicit start boundary |
| `packages/config/src/builtins.ts` | `tapestry-execution` workflow updated to be execution-only (no planning step; `plan_complete` completion; `inputs` requiring existing plan) |
| `packages/adapters/opencode/src/start-plan-execution.ts` | `/weave:start` delivery helper added with plan-existence guard |
| `packages/adapters/opencode/src/run-workflow.ts` | Module-level JSDoc updated: reframes as explicit named-workflow execution; cross-references `startPlanExecution` as the `/weave:start` path |

Supporting docs that align with the Spec 29 model (not changed in Spec 29 commits; already consistent):

| Document | Relevant content |
|---|---|
| `docs/adapter-bootstrap.md` | Scope note on `runWorkflow`: explicit named-workflow helper, not the general execution entry point; `/weave:start` is the preferred general entry command |
| `docs/adapter-readiness-status.md` | `/weave:start` as preferred general entry; `/run-workflow` as explicit named-workflow helper; `command-entrypoints` readiness vocabulary |
| `docs/adapter-boundary.md` | `/weave:start` preferred spelling for command-capable adapters; `run-workflow.ts` described as explicit named-workflow helper |
| `docs/adr/0004-workflow-first-execution-contract.md` | Explicit execution boundary contract; ordinary Loom conversation and idle events forbidden from implicitly starting durable execution |

---

## Historical Context

Spec 22 proofs (`docs/specs/22-spec-workflow-first-execution/22-proofs/`) document the workflow-first execution plumbing built in PR #82. Those artifacts remain valid for named workflow execution semantics. This proof does not rewrite them — it links them as the foundation that Spec 29 builds on top of.
