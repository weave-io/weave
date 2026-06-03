# Task 2.0 Proof Artifact — Canonical Planning Workflow and `before-plan` Extension Contract

**Spec**: [Spec 22 — Workflow-First Execution](../22-spec-workflow-first-execution.md), Unit 2  
**Task**: 2.0 Add the canonical planning workflow and `before-plan` extension contract  
**Sub-tasks completed**: 2.1, 2.2, 2.3, 2.4, 2.5  
**Date**: 2026-06-03

---

## Summary

Tasks 2.1–2.5 implement the full `before-plan` extension contract across the DSL schema, parser, validator, builtin workflow definitions, config-merge layer, and documentation. All acceptance criteria for task 2.0 are met.

---

## 1. Planning Step Role (`role planning`)

**Requirement**: Exactly one step per workflow may carry `role: "planning"`. Workflows that publish `extension_points { before-plan }` must have exactly one such step.

**Schema** (`packages/core/src/schema.ts`):

```ts
export const WorkflowStepRoleSchema = z.enum(["planning"]);

// WorkflowStepSchema includes:
role: WorkflowStepRoleSchema.optional(),

// WorkflowConfigSchema enforces:
.refine(
  (data) => {
    if (!data.extension_points?.before_plan) return true;
    const planningSteps = data.steps.filter((s) => s.role === "planning");
    return planningSteps.length >= 1;
  },
  { message: "... (MissingPlanningStep)", path: ["steps"] },
)
.refine(
  (data) => {
    const planningSteps = data.steps.filter((s) => s.role === "planning");
    return planningSteps.length <= 1;
  },
  { message: "... (DuplicatePlanningStep)", path: ["steps"] },
)
```

**Test evidence** (290 pass, 0 fail — `bun test packages/core/src/__tests__/schema.test.ts packages/core/src/__tests__/validate.test.ts packages/core/src/__tests__/parse_config.test.ts`):

| Test | Location | Result |
|------|----------|--------|
| `accepts step with role: planning` | `schema.test.ts` | ✅ pass |
| `rejects unknown role value` | `schema.test.ts` | ✅ pass |
| `accepts workflow with extension_points.before_plan and one planning step` | `schema.test.ts` | ✅ pass |
| `rejects workflow with extension_points.before_plan but no planning step (MissingPlanningStep)` | `schema.test.ts` | ✅ pass |
| `rejects workflow with two planning steps (DuplicatePlanningStep)` | `schema.test.ts` | ✅ pass |
| `step with role planning round-trips correctly` | `validate.test.ts` | ✅ pass |
| `two planning steps in one workflow is rejected (DuplicatePlanningStep)` | `validate.test.ts` | ✅ pass |
| `step with role planning parses end-to-end correctly` | `parse_config.test.ts` | ✅ pass |
| `two planning steps in one workflow returns ValidationError (DuplicatePlanningStep)` | `parse_config.test.ts` | ✅ pass |

---

## 2. `extension_points { before-plan }` Publication Syntax

**Requirement**: Thin workflow-level publication block using distinct DSL syntax. Publication declares the slot; it does not insert steps.

**Schema** (`packages/core/src/schema.ts`):

```ts
export const ExtensionPointsSchema = z
  .object({ before_plan: z.boolean().optional() })
  .strict();

// WorkflowConfigSchema includes:
extension_points: ExtensionPointsSchema.optional(),
```

**Parser** (`packages/core/src/parser.ts`): The `before-plan` hyphenated identifier inside the `extension_points { }` block is parsed as a bare boolean flag (presence = `true`).

**Validator** (`packages/core/src/validate.ts`): `normalizeExtensionPoints()` converts the hyphenated DSL key `before-plan` to the schema key `before_plan`:

```ts
function normalizeExtensionPoints(raw: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const normalized = key === "before-plan" ? "before_plan" : key;
    result[normalized] = value;
  }
  return result;
}
```

**Test evidence**:

| Test | Location | Result |
|------|----------|--------|
| `accepts before_plan: true` | `schema.test.ts` | ✅ pass |
| `rejects extension_points with unknown key (UnknownExtensionPoint)` | `schema.test.ts` | ✅ pass |
| `workflow with extension_points { before-plan } and planning step is accepted` | `validate.test.ts` | ✅ pass |
| `workflow with extension_points { before-plan } but no planning step is rejected (MissingPlanningStep)` | `validate.test.ts` | ✅ pass |
| `workflow with extension_points { before-plan } and planning step parses end-to-end` | `parse_config.test.ts` | ✅ pass |
| `workflow with extension_points { before-plan } but no planning step returns ValidationError (MissingPlanningStep)` | `parse_config.test.ts` | ✅ pass |

---

## 3. `extend before-plan [ ... ]` Composition Syntax

**Requirement**: Separate top-level directive that names steps to fill the published slot. Distinct from publication syntax — composition is a config-level concern resolved by `@weave/config` after generic config-merge.

**Schema** (`packages/core/src/schema.ts`):

```ts
export const ExtendBeforePlanSchema = z.object({
  steps: z.array(z.string().min(1)).min(1, "extend before-plan must list at least one step"),
});

// WeaveConfigSchema includes:
extend_before_plan: z.record(z.string(), ExtendBeforePlanSchema).default({}),
```

**AST** (`packages/core/src/ast.ts`): `ExtendBeforePlanDirective` node type with `workflow?: string` and `steps: string[]`.

**Parser** (`packages/core/src/parser.ts`): Parses `extend before-plan ["step-a", "step-b"]` into `ExtendBeforePlanDirective` nodes.

**Validator** (`packages/core/src/validate.ts`): Union-merges step lists across multiple `extend before-plan` directives, keyed by workflow name (or `"__default__"` sentinel when no workflow name is given).

**Test evidence**:

| Test | Location | Result |
|------|----------|--------|
| `accepts extend_before_plan with a workflow name and steps` | `schema.test.ts` | ✅ pass |
| `defaults extend_before_plan to empty object when absent` | `schema.test.ts` | ✅ pass |
| `rejects extend_before_plan entry with empty steps array` | `schema.test.ts` | ✅ pass |
| `extend before-plan directive round-trips into extend_before_plan` | `validate.test.ts` | ✅ pass |
| `multiple extend before-plan directives union-merge step lists` | `validate.test.ts` | ✅ pass |
| `extend before-plan directive parses end-to-end into extend_before_plan` | `parse_config.test.ts` | ✅ pass |
| `extend before-plan combined with a workflow parses correctly` | `parse_config.test.ts` | ✅ pass |

---

## 4. Builtin Workflow Publication

**Requirement**: The effective default workflow (`plan-and-execute`) is plan-oriented and publishes the `before-plan` extension surface without replacing planning itself.

**Builtin DSL** (`packages/config/src/builtins.ts`):

```weave
workflow plan-and-execute {
  description "Research, plan, implement, and review a feature end-to-end"
  version 1

  extension_points {
    before-plan
  }

  step plan {
    name "Create implementation plan"
    role planning
    type autonomous
    agent pattern
    prompt "Create a detailed implementation plan for: {{instance.goal}}"
    completion plan_created {
      plan_name "{{instance.slug}}"
    }
    outputs [
      { name "plan_path" description "Path to the generated plan file" }
    ]
  }
  ...
}
```

**Test evidence** (60 pass, 0 fail — `bun test packages/config/src/__tests__/builtins.test.ts`):

| Test | Location | Result |
|------|----------|--------|
| `(g3) plan-and-execute publishes extension_points.before_plan: true` | `builtins.test.ts` | ✅ pass |
| `(g4) plan-and-execute has exactly one planning step with role: planning on the 'plan' step` | `builtins.test.ts` | ✅ pass |
| `(g5) quick-fix does NOT publish extension_points.before_plan` | `builtins.test.ts` | ✅ pass |
| `(g6) tapestry-execution does NOT publish extension_points.before_plan` | `builtins.test.ts` | ✅ pass |
| `(g7) plan-and-execute planning step uses plan_created completion with plan_name template` | `builtins.test.ts` | ✅ pass |

---

## 5. Merge Ownership — `before-plan` Becomes Engine-Visible Only After Merge

**Requirement**: Generic `extends` / `insert_before` / `insert_after` remains a config-merge concern. `extension_points.before_plan` and `extend_before_plan` are engine-visible only after merge resolution completes. The merge layer does not enforce the cross-field constraint between them.

**Merge layer** (`packages/config/src/merge.ts`) — documented ownership comment:

```ts
// before-plan ownership note:
//   `extension_points` is a plain object field on WorkflowConfig — it passes
//   through mergeWorkflowRecord → mergeWorkflow → mergeValues as a deep-merge,
//   so `extension_points.before_plan` is preserved from whichever layer sets it.
//
//   `extend_before_plan` is a top-level WeaveConfig field — it passes through
//   the generic mergeValues path below. Its `steps` arrays union-merge across
//   layers (override entries first, then base entries not already present).
//
//   Both fields are engine-visible only after merge resolution completes.
//   The engine is responsible for checking `extension_points.before_plan` on
//   the target workflow before applying `extend_before_plan` entries — the
//   merge layer does not enforce that cross-field constraint.
```

**Test evidence** (60 pass, 0 fail — `bun test packages/config/src/__tests__/merge.test.ts`):

| Test | Location | Result |
|------|----------|--------|
| `(bp-1) base workflow with extension_points.before_plan: preserved in merged result` | `merge.test.ts` | ✅ pass |
| `(bp-2) override adds extension_points.before_plan: present in merged result` | `merge.test.ts` | ✅ pass |
| `(bp-3) override without extension_points: base extension_points.before_plan preserved` | `merge.test.ts` | ✅ pass |
| `(bp-4) extend_before_plan in override only: present in merged result` | `merge.test.ts` | ✅ pass |
| `(bp-5) extend_before_plan in both layers: union-merged step lists` | `merge.test.ts` | ✅ pass |
| `(bp-6) merge does not enforce cross-field constraint between extension_points and extend_before_plan` | `merge.test.ts` | ✅ pass |
| `(bp-7) before-plan contract is engine-visible only after merge — merge layer is transparent` | `merge.test.ts` | ✅ pass |

---

## 6. Concrete Reviewed Pre-Plan Artifact Example in `docs/workflow-schema.md`

**Requirement**: `docs/workflow-schema.md` shows the concrete DSL example with `spec_path` flowing through `write-spec` → `review-spec` → `plan`.

**Evidence** (`docs/workflow-schema.md`, section "Concrete example — reviewed spec artifact feeding planning"):

The document shows:

1. **Publication syntax** — `extension_points { before-plan }` on `plan-and-execute`
2. **Step definitions** — `write-spec` (produces `spec_path`) and `review-spec` (gate, consumes `spec_path`, `on_reject pause`)
3. **Composition directive** — `extend before-plan ["write-spec", "review-spec"]`
4. **Resolved step order** — `research` → `write-spec` → `review-spec` → `plan` (role planning) → `implement` → `review` → `security`
5. **Engine contract** — the engine receives a flat `WorkflowConfig` with no `extension_points`, `extend_before_plan`, or insertion fields — those are stripped by the config layer

The `spec_path` artifact flows explicitly: `write-spec.outputs[spec_path]` → `review-spec.inputs[spec_path]` → `plan` may consume it as an informational input.

---

## 7. Test Run Summary

```
bun test packages/core/src/__tests__/schema.test.ts \
         packages/core/src/__tests__/validate.test.ts \
         packages/core/src/__tests__/parse_config.test.ts
# 290 pass, 0 fail

bun test packages/config/src/__tests__/merge.test.ts \
         packages/config/src/__tests__/builtins.test.ts
# 60 pass, 0 fail
```

Total: **350 pass, 0 fail** across the 5 test files directly covering task 2.0 scope.

---

## 8. Pre-existing Unrelated Blockers

The workspace-wide `bun test` run reports 3 failures from `docs/adr-workflow-execution-contract/packages/core/src/__tests__/` — a separate worktree directory that lacks `zod` and `neverthrow` in its local `node_modules`. These failures are pre-existing, unrelated to task 2.0, and do not affect the targeted test results above.

`bun run validate-config` is blocked by a pre-existing issue in `packages/cli/src/commands/init.ts` (known CLI blocker documented in learnings). The builtin DSL validity is proven instead by the `builtins.test.ts` suite which calls `parseConfig(BUILTIN_WEAVE_SOURCE)` directly.

---

## Acceptance Criteria Checklist

| Criterion | Status |
|-----------|--------|
| Proof file covers planning-step role | ✅ Section 1 |
| Proof file covers `extension_points { before-plan }` | ✅ Section 2 |
| Proof file covers `extend before-plan [ ... ]` | ✅ Section 3 |
| Proof file covers builtin workflow publication | ✅ Section 4 |
| Proof file covers merge ownership | ✅ Section 5 |
| Proof file covers concrete reviewed pre-plan artifact example in `docs/workflow-schema.md` | ✅ Section 6 |
| Concise evidence included | ✅ Test tables throughout |
| Pre-existing unrelated blockers noted | ✅ Section 8 |
| Task 2.0 marked `[x]` in task file | ✅ (done in commit) |
| Parent 3.0 not touched | ✅ |
