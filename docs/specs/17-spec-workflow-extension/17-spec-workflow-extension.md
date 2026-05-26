# 17-spec-workflow-extension.md

## Introduction/Overview

Add a workflow extension surface to the `.weave` DSL that lets users derive new workflows from existing ones — including the four builtin workflows — without copying and re-declaring every step. This solves a common authoring pain point: users who want to add a `spec` step before `plan` in `plan-and-execute`, or insert a compliance gate after `review` in `quick-fix`, currently must copy the entire workflow and maintain it in sync with upstream changes.

The extension surface is a **config-merge concern** owned entirely by `@weave/config`. The engine receives the post-merge `WorkflowConfig` unchanged; no engine or adapter code needs to know whether a workflow was declared inline or derived from a parent.

---

## Goals

- Allow a workflow to declare `extends: "<parent-name>"` to inherit all parent steps.
- Allow individual steps to declare `insert_before: "<anchor>"` or `insert_after: "<anchor>"` to position themselves relative to an existing parent step.
- Define unambiguous merge precedence so the resulting step order is deterministic.
- Define four typed validation errors for invalid extension declarations.
- Preserve the four builtin workflows unchanged; users gain the ability to extend them without modifying them.
- Keep the adapter boundary clean: `@weave/config` resolves extension before the engine sees any `WorkflowConfig`.

---

## User Stories

- **As a user**, I want to insert a `spec` step before `plan` in `plan-and-execute` so that I can add a specification phase without copying the entire workflow.
- **As a user**, I want to replace the `review` step in `quick-fix` with a stricter version so that I can tighten the gate without duplicating the rest of the workflow.
- **As a user**, I want to append a `deploy` step after `security` in `plan-and-execute` so that I can extend the builtin workflow with a deployment phase.
- **As a Weave maintainer**, I want the four builtin workflows to remain unchanged so that existing users are not affected by the new extension surface.
- **As an adapter author**, I want to receive a fully-resolved `WorkflowConfig` from the engine so that I do not need to implement extension logic in my adapter.

---

## DSL Syntax

### `workflow.extends`

A workflow may declare `extends` with the name of another workflow in scope (builtin or user-declared):

```weave
workflow my-plan-and-execute {
  extends "plan-and-execute"
  description "plan-and-execute with a spec step before planning"
  version 1

  step spec {
    name "Write specification"
    type autonomous
    agent pattern
    prompt "Write a specification for: {{instance.goal}}"
    completion agent_signal
    insert_before "plan"
  }
}
```

### `WorkflowStep.insert_before` / `insert_after`

`insert_before` and `insert_after` are optional step-level fields. They are **anchor names** — the name of an existing step in the parent workflow. They are attached to the step being declared, not to a separate insertion block.

```weave
step spec {
  name "Write specification"
  type autonomous
  agent pattern
  prompt "Write a specification for: {{instance.goal}}"
  completion agent_signal
  insert_before "plan"          # anchors this step before the parent's "plan" step
}

step compliance {
  name "Compliance gate"
  type gate
  agent warp
  prompt "Compliance audit for: {{instance.goal}}"
  completion review_verdict
  on_reject pause
  insert_after "review"         # anchors this step after the parent's "review" step
}
```

**Constraints:**

- `insert_before` and `insert_after` are **mutually exclusive** on a single step. Declaring both is a validation error (`BothInsertBeforeAndAfter`).
- `insert_before` and `insert_after` are only meaningful when the workflow declares `extends`. They are silently ignored on workflows without `extends` (no error, no effect).
- The anchor name must match an existing step name in the resolved parent workflow. An unknown anchor is a validation error (`UnknownInsertionAnchor`).
- A step without `insert_before` or `insert_after` in an extending workflow is treated as an **appended** step (added after all parent steps).

---

## Schema Additions

The following fields are added to the Weave config schema:

### `WorkflowConfig`

```ts
interface WorkflowConfig {
  name: string;
  description?: string;
  version?: number;
  extends?: string;           // NEW: name of the parent workflow
  steps: WorkflowStep[];
}
```

### `WorkflowStep`

```ts
interface WorkflowStep {
  name: string;
  // ... existing fields ...
  insert_before?: string;     // NEW: anchor step name — insert this step before the named parent step
  insert_after?: string;      // NEW: anchor step name — insert this step after the named parent step
}
```

Both new fields are optional strings. They are stripped from the resolved `WorkflowConfig` after merge so the engine never sees them.

---

## Merge Semantics

When a workflow declares `extends`, `@weave/config` resolves the final step list using the following precedence:

### Step 1 — Resolve the parent

Look up the parent workflow by name in the merged config (builtins + global + project). If the parent is not found, emit `UnknownExtendsTarget`. If the parent itself declares `extends`, resolve it recursively first (depth-first). If a cycle is detected, emit `ExtendsCycle`.

### Step 2 — Build the base step list

Start with the parent's resolved step list (already a flat, ordered array with no `insert_before`/`insert_after` fields).

### Step 3 — Apply replacements (same-name steps)

For each step in the child workflow that has the **same name** as a parent step and declares **no** `insert_before` / `insert_after`:

- Replace the parent step at its current position with the child step.
- The child step's position in the final list is the parent step's original position.

### Step 4 — Apply insertions (anchor-based steps)

For each step in the child workflow that declares `insert_before` or `insert_after`:

- Validate the anchor name exists in the current (post-replacement) step list. If not, emit `UnknownInsertionAnchor`.
- Insert the child step immediately before or after the anchor step.
- Multiple insertions at the same anchor are applied in child-declaration order.

### Step 5 — Append new steps

For each step in the child workflow that has **no** `insert_before` / `insert_after` and whose name does **not** match any parent step:

- Append the step to the end of the list.

### Step 6 — Strip extension fields

Remove `extends`, `insert_before`, and `insert_after` from the resolved `WorkflowConfig` before passing it to the engine. The engine receives a plain `WorkflowConfig` with a flat `steps` array.

### Precedence summary

```
parent steps (base)
  → replacements applied (same-name child steps, no anchor)
  → insertions applied (child steps with insert_before / insert_after)
  → new steps appended (child steps with no anchor and no parent match)
```

---

## Example: Insert `spec` Before `plan` in `plan-and-execute`

The builtin `plan-and-execute` workflow has these steps (in order):

1. `research`
2. `external-research`
3. `plan`
4. `implement`
5. `review`
6. `security`

A user wants to add a `spec` step between `external-research` and `plan`:

```weave
workflow my-plan-and-execute {
  extends "plan-and-execute"
  description "plan-and-execute with a spec step before planning"
  version 1

  step spec {
    name "Write specification"
    type autonomous
    agent pattern
    prompt "Write a detailed specification for: {{instance.goal}}"
    completion agent_signal
    insert_before "plan"
  }
}
```

Resolved step order after merge:

1. `research`         ← inherited from parent
2. `external-research` ← inherited from parent
3. `spec`             ← inserted before `plan`
4. `plan`             ← inherited from parent
5. `implement`        ← inherited from parent
6. `review`           ← inherited from parent
7. `security`         ← inherited from parent

The engine receives `my-plan-and-execute` as a plain `WorkflowConfig` with 7 steps and no `extends` or `insert_before` fields.

---

## Interaction With Existing Union-Merge

The existing config merge strategy (project overrides global; arrays union-merge) applies to workflow declarations **before** extension resolution. Extension resolution is a second pass that runs after the standard merge.

**When step-aware merge applies:**

Step-aware merge (this spec) replaces the standard union-merge for a workflow when **either** of the following is true:

1. The child workflow declares `extends`.
2. Both the global config and the project config declare a workflow with the same name, and at least one of the child steps declares `insert_before` or `insert_after`.

In all other cases, the existing union-merge behavior is unchanged: project-level workflow declarations override global-level declarations for scalars; steps union-merge by name.

**Builtin workflows are never modified by extension resolution.** They remain the canonical parent definitions. A user extending `plan-and-execute` creates a new workflow named `my-plan-and-execute`; the original `plan-and-execute` is unaffected and remains available.

---

## Validation Errors

All four errors are discriminated union variants of `WorkflowExtensionError`, returned as `err(...)` from the config merge function. They are never thrown.

### `UnknownExtendsTarget`

Emitted when a workflow's `extends` value does not match any known workflow name in the merged config.

```ts
{
  type: "UnknownExtendsTarget";
  workflowName: string;   // the extending workflow
  extendsTarget: string;  // the unknown parent name
}
```

**Example trigger:**

```weave
workflow my-flow {
  extends "nonexistent-workflow"
  # ...
}
```

### `UnknownInsertionAnchor`

Emitted when a step's `insert_before` or `insert_after` value does not match any step name in the resolved parent workflow.

```ts
{
  type: "UnknownInsertionAnchor";
  workflowName: string;   // the extending workflow
  stepName: string;       // the step declaring the bad anchor
  anchor: string;         // the unknown anchor name
  direction: "before" | "after";
}
```

**Example trigger:**

```weave
step spec {
  # ...
  insert_before "nonexistent-step"
}
```

### `BothInsertBeforeAndAfter`

Emitted when a single step declares both `insert_before` and `insert_after`.

```ts
{
  type: "BothInsertBeforeAndAfter";
  workflowName: string;   // the extending workflow
  stepName: string;       // the step with conflicting anchors
  insertBefore: string;   // the insert_before value
  insertAfter: string;    // the insert_after value
}
```

**Example trigger:**

```weave
step spec {
  # ...
  insert_before "plan"
  insert_after "external-research"
}
```

### `ExtendsCycle`

Emitted when extension resolution detects a cycle (workflow A extends B, B extends A; or longer chains).

```ts
{
  type: "ExtendsCycle";
  cycle: string[];   // ordered list of workflow names forming the cycle, e.g. ["a", "b", "a"]
}
```

**Example trigger:**

```weave
workflow a {
  extends "b"
  # ...
}

workflow b {
  extends "a"
  # ...
}
```

---

## Backwards Compatibility

**Existing workflows without `extends` continue to work unchanged.** The `extends` field is optional. When a workflow does not declare `extends`, the merge engine falls back to the pre-existing union-merge behaviour: override steps union-merge with base steps by `JSON.stringify` equality, and scalar fields follow last-defined-wins semantics. No config changes are required for existing users.

The step-aware merge algorithm (replacement → insertion → append) is only activated when the override workflow explicitly declares `extends`. This means:

- A project config that declares a workflow with the same name as a builtin but **without** `extends` continues to union-merge steps as before.
- A project config that declares a workflow with the same name as a builtin **with** `extends` opts into step-aware merge for that workflow only.
- Workflows that exist only in one layer (no name collision) are passed through unchanged.

**No breaking change.** The `extends`, `insert_before`, and `insert_after` fields are additive. Existing `.weave` config files that do not use these fields are unaffected.

---

## Migration Story for Builtin Workflows

The four builtin workflows (`plan-and-execute`, `quick-fix`, `tapestry-execution`) remain **unchanged**. No migration is required for existing users.

Users who previously copied a builtin workflow and modified it can migrate to the extension surface:

1. Declare a new workflow with a distinct name and `extends "<builtin-name>"`.
2. Declare only the steps that differ: use same-name steps to replace, `insert_before`/`insert_after` to insert, and plain steps to append.
3. Remove the copied workflow from their config.

The builtin workflows are always available as extension targets regardless of whether the user has declared them in their own config.

---

## Adapter Boundary Clause

Workflow extension is a **config-merge concern** owned entirely by `@weave/config`. The resolution algorithm (parent lookup, replacement, insertion, appending, field stripping) runs inside the config merge pipeline before any engine or adapter code is invoked.

**`@weave/engine` receives the post-merge `WorkflowConfig` unchanged.** The engine does not know whether a workflow was declared inline or derived from a parent. No engine API, no adapter API, and no harness-specific code participates in extension resolution.

**Ownership matrix:**

| Concern | Owner | Why |
| --- | --- | --- |
| `extends` field parsing | Core (`@weave/core`) | DSL parsing is core-owned |
| `insert_before` / `insert_after` field parsing | Core (`@weave/core`) | DSL parsing is core-owned |
| Extension resolution algorithm | Config (`@weave/config`) | Config merge is config-owned |
| Cycle detection | Config (`@weave/config`) | Part of extension resolution |
| Validation error types | Core (`@weave/core`) | Shared error vocabulary |
| Post-merge `WorkflowConfig` consumption | Engine (`@weave/engine`) | Engine receives resolved config |
| Workflow materialization in harness | Adapter | Harness-specific translation |

See [Spec 17 — Tasks](17-tasks-workflow-extension.md) for the implementation task list and [Spec 17 — Validation](17-validation-workflow-extension.md) for the validation report template.

---

## Non-Goals (Out of Scope)

1. **Conditional step inclusion**: No `if`/`when` guards on steps. Extension is purely structural.
2. **Step reordering without anchors**: Users cannot reorder inherited steps without replacing them.
3. **Multi-parent inheritance**: A workflow may extend exactly one parent. Multiple `extends` declarations are a parse error.
4. **Extending categories or agents**: `extends` is only valid on `workflow` blocks.
5. **Runtime extension**: Extension is resolved at config-load time, not at workflow execution time.
6. **Changing builtin workflow step names**: Builtin step names are stable and must not be renamed without a migration spec.

---

## Design Considerations

The `insert_before` / `insert_after` fields are attached to the **step being declared**, not to a separate insertion block. This keeps the DSL flat and readable: each step is self-contained and its position relative to the parent is declared alongside its other properties.

The merge precedence (replacements → insertions → appends) is chosen to be deterministic and unsurprising: replacing a step never changes its position, inserting a step anchors it to a named neighbor, and appending a step always goes last.

---

## Repository Standards

- Follow the engine/adapter boundary in `docs/adapter-boundary.md`: extension resolution is config-owned; the engine receives resolved config.
- Use Bun-only workflows and commands: `bun run typecheck`, `bun test`.
- Use `neverthrow` for fallible functions. Extension resolution returns `Result<WorkflowConfig[], WorkflowExtensionError[]>`.
- Use discriminated union error types with enough context for callers to branch safely.
- Keep code testable with explicit inputs and in-memory fixtures.
- Export public types from the relevant package barrels.
- Update documentation for non-trivial architectural changes before considering the task complete.

---

## Security Considerations

- Extension resolution operates on config data only. It does not read files, spawn processes, or access harness state.
- Cycle detection prevents unbounded recursion during resolution.
- The `extends` target is validated against the known workflow name set; arbitrary string injection has no effect beyond a validation error.

---

## Open Questions

1. Should `insert_before` / `insert_after` on a step that also matches a parent step name be treated as a replacement-with-relocation, or as a validation error? Current spec treats it as a validation error (a step cannot both replace and relocate).
2. Should the resolved step list be exposed as a debug artifact in the config loader output, or remain internal to the merge pipeline?
3. Should `extends` be allowed to reference a workflow declared later in the same file (forward reference), or only workflows already resolved at parse time?
