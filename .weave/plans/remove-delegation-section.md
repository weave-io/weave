# Plan: Remove `delegation.section` and `delegation.mermaid` from Template Context

## Goal

Remove `delegation.section` and `delegation.mermaid` from the engine's template
context system. Neither property is used in any builtin prompt — all builtins use
`{{#delegation.targets}}` loops instead. The auto-fallback in `compose.ts` that
appends `delegation.section` when no `delegation.*` reference exists must also be
removed.

## Scope

| File | What changes |
|---|---|
| `packages/engine/src/template-context.ts` | Remove `generateDelegationSection`, `generateMermaidDiagram`, `generateWorkflowMermaidDiagram`, `escapeMermaidLabel`, `mermaidNodeId`, `workflowPrefix`; remove `mermaid?` and `section?` from `DelegationContextEntry`; remove `workflows` from `TemplateContextInput`; remove generation call-sites in `buildTemplateContext`; update file-level JSDoc |
| `packages/engine/src/compose.ts` | Remove `primarySourceReferencesDelegation`, the fallback-append block, and the `workflows` field passed to `buildTemplateContext`; update JSDoc |
| `packages/engine/src/__tests__/template-context.test.ts` | Remove all tests for `delegation.section`, `delegation.mermaid`, Mermaid diagram generation, workflow-aware Mermaid, and the `ALLOWED_TEMPLATE_PATHS` assertions for those two paths |
| `packages/engine/src/__tests__/template-renderer.test.ts` | Remove the integration test that renders `{{{delegation.section}}}` |
| `packages/engine/src/__tests__/compose.test.ts` | Remove/update tests that assert fallback delegation insertion, fallback suppression, and `{{{delegation.section}}}` inline rendering |
| `docs/prompt-composition.md` | Remove all references to `delegation.section` and `delegation.mermaid`; update Template Context shape, Composition Pipeline step 5, Composition Order section, Delegation Diagram section, and Builtin prompt files guidance |
| `docs/adr/0001-prompt-composition-templates.md` | Update Decision and Consequences sections to reflect removal |

---

## Tasks

### Task 1 — Remove Mermaid/section generation from `template-context.ts`

- [x] **What**: Delete the five private helper functions (`escapeMermaidLabel`,
  `mermaidNodeId`, `workflowPrefix`, `generateWorkflowMermaidDiagram`,
  `generateMermaidDiagram`) and `generateDelegationSection`. Remove `mermaid?`
  and `section?` from `DelegationContextEntry`. Remove `workflows?` from
  `TemplateContextInput`. Remove the `if (projectedTargets.length > 0)` block in
  `buildTemplateContext` that calls those generators and assigns
  `delegationEntry.mermaid` / `delegationEntry.section`. Remove
  `"delegation.section"` and `"delegation.mermaid"` from `ALLOWED_TEMPLATE_PATHS`.
  Update the file-level JSDoc comment to remove the two bullet points that mention
  these properties.
- [ ] **Files**: `packages/engine/src/template-context.ts`
- [ ] **Acceptance**:
  - `DelegationContextEntry` has only `targets: DelegationTargetContextEntry[]`
  - `TemplateContextInput` has no `workflows` field
  - `ALLOWED_TEMPLATE_PATHS` does not contain `"delegation.section"` or
    `"delegation.mermaid"`
  - No reference to `generateDelegationSection`, `generateMermaidDiagram`,
    `generateWorkflowMermaidDiagram`, `escapeMermaidLabel`, `mermaidNodeId`, or
    `workflowPrefix` remains in the file
  - `bun run typecheck` passes

---

### Task 2 — Remove fallback-append logic from `compose.ts`

- [x] **What**: Delete `primarySourceReferencesDelegation` (the function that
  calls `extractTemplatePaths` to detect `delegation.*` references). Remove the
  `hasDelegationInPrimary` variable and the `if` block that pushes
  `templateContext.delegation.section` into `sections`. Remove the `workflows`
  field from the `buildTemplateContext(...)` call (since `TemplateContextInput`
  no longer has that field after Task 1). Update the JSDoc comment on
  `composeAgentDescriptor` to remove the mention of fallback delegation insertion.
- [ ] **Files**: `packages/engine/src/compose.ts`
- [ ] **Acceptance**:
  - `primarySourceReferencesDelegation` is gone
  - `sections` is assembled as: `[renderedPrimary, ...optional renderedAppend]`
    with no fallback delegation block
  - `buildTemplateContext` call no longer passes `workflows`
  - `bun run typecheck` passes

> **Parallel-safe**: Tasks 1 and 2 can be done in parallel — they touch different
> files and Task 2's removal of `workflows` from the call-site is independent of
> Task 1's removal of the field from the type (TypeScript will flag the mismatch
> until both are done, so complete both before running typecheck).

---

### Task 3 — Update `template-context.test.ts`

- [ ] **What**: Remove or rewrite every test that references `delegation.section`
  or `delegation.mermaid`. Specifically:
  - In `ALLOWED_TEMPLATE_PATHS` describe block: remove the two
    `expect(ALLOWED_TEMPLATE_PATHS.has("delegation.section")).toBe(true)` and
    `expect(ALLOWED_TEMPLATE_PATHS.has("delegation.mermaid")).toBe(true)` lines
    from the `"contains all delegation paths"` test.
  - Remove the entire `"delegation with no targets"` sub-tests for
    `delegation.mermaid` and `delegation.section` (lines ~304–312).
  - Remove the two tests `"delegation.mermaid is present when targets exist"` and
    `"delegation.section is present when targets exist"` (lines ~416–428).
  - Remove the entire `"buildTemplateContext — Mermaid diagram"` describe block
    (~lines 435–548).
  - Remove the entire `"buildTemplateContext — delegation.section Markdown"`
    describe block (~lines 555–640).
  - Remove the entire `"buildTemplateContext — workflow-aware Mermaid diagram"`
    describe block (~lines 742–945).
  - Remove the `makeWorkflow` helper function (~lines 719–740) since it is only
    used by the workflow-aware Mermaid tests.
  - Remove the `WorkflowConfig` import from `@weave/core` if it is no longer used.
- [ ] **Files**: `packages/engine/src/__tests__/template-context.test.ts`
- [ ] **Acceptance**:
  - No test references `delegation.section`, `delegation.mermaid`, or
    `ctx.delegation.mermaid`
  - No test references `makeWorkflow` or `WorkflowConfig`
  - Remaining tests still cover: agent context, category context, toolPolicy
    context, delegation targets projection (name, description, domains,
    deduplication, isCategory), no-raw-config exposure, and Result type
  - `bun test packages/engine/src/__tests__/template-context.test.ts` passes

---

### Task 4 — Update `template-renderer.test.ts`

- [ ] **What**: Remove the integration test `"renders delegation section with
  triple-brace (no HTML escaping)"` (~lines 615–630). This test renders
  `{{{delegation.section}}}` and asserts the output contains `## Delegation`.
  It is the only reference to `delegation.section` in this file.
- [ ] **Files**: `packages/engine/src/__tests__/template-renderer.test.ts`
- [ ] **Acceptance**:
  - No test in the file references `delegation.section` or `delegation.mermaid`
  - All remaining tests pass: `bun test packages/engine/src/__tests__/template-renderer.test.ts`

> **Parallel-safe**: Tasks 3 and 4 are independent of each other and of Tasks 1/2.

---

### Task 5 — Update `compose.test.ts`

- [ ] **What**: Remove or rewrite the tests that depend on fallback delegation
  insertion or `{{{delegation.section}}}` inline rendering:
  - `"Delegation_section_is_formatted_as_markdown_with_mermaid_in_composedPrompt"`
    (~line 354): This test asserts `composedPrompt` contains `## Delegation`,
    ` ```mermaid`, `flowchart TD`, node IDs, and bullet lines. After removal of
    the fallback, a delegating agent with a plain prompt will no longer have a
    delegation section in `composedPrompt`. **Remove this test.**
  - `"Fallback_delegation_section_inserted_when_primary_has_no_delegation_tags"`
    (~line 961): Directly tests the fallback behavior. **Remove this test.**
  - `"Fallback_delegation_suppressed_when_primary_references_delegation_tag"`
    (~line 988): Tests that `{{{delegation.section}}}` in the primary prompt
    renders exactly once. After removal, `{{{delegation.section}}}` is an unknown
    path and will cause a `PromptTemplateError`. **Rewrite** this test to assert
    that a prompt containing `{{{delegation.section}}}` returns a
    `PromptTemplateError` with `reason.kind === "UnknownPath"` and
    `reason.path === "delegation.section"`.
  - `"Prompt_append_delegation_reference_does_not_suppress_fallback"` (~line
    1015): Tests fallback insertion when `prompt_append` references delegation.
    After removal, the fallback no longer exists. **Rewrite** this test to assert
    that `prompt_append` referencing `{{#delegation.targets}}` still renders
    correctly (targets list is iterated) and that `composedPrompt` does NOT
    contain `## Delegation`.
  - `"Final_prompt_order_is_rendered_primary_then_fallback_then_rendered_append"`
    (~line 1147): Asserts the three-part order including the fallback delegation
    section. **Rewrite** to assert the two-part order: rendered primary, then
    rendered append (no delegation section in between).
- [ ] **Files**: `packages/engine/src/__tests__/compose.test.ts`
- [ ] **Acceptance**:
  - No test asserts that `composedPrompt` contains `## Delegation` via the
    fallback path
  - The rewritten `{{{delegation.section}}}` test asserts `PromptTemplateError`
    with `UnknownPath`
  - The rewritten `prompt_append` delegation test asserts targets are iterated
    and no `## Delegation` heading appears
  - The rewritten prompt-order test asserts two-part composition
  - `bun test packages/engine/src/__tests__/compose.test.ts` passes

---

### Task 6 — Update `docs/prompt-composition.md`

- [ ] **What**: Update the documentation to reflect the removal. Changes needed:
  - **Builtin prompt files** section (~line 49): Remove the bullet
    `"place generated delegation guidance with {{{delegation.section}}} when the
    prompt should control where routing guidance appears"`.
  - **Composition Pipeline step 5** (~line 135–141): Rewrite step 5 to say that
    the fallback delegation insertion step has been removed. The pipeline now goes
    directly from rendering the primary source to rendering `prompt_append`.
    Renumber subsequent steps if needed.
  - **Template Context** section (~lines 250–260): Remove `section?: string` and
    `mermaid?: string` from the `delegation` object in the TypeScript interface
    block.
  - **Delegation Diagram** section (~lines 279–357): Remove the entire section
    (or reduce it to a note that delegation targets are available via
    `{{#delegation.targets}}` loops only — no pre-rendered `section` or `mermaid`
    strings are generated).
  - **Composition Order** section (~lines 363–384): Remove step 2 (fallback
    `delegation.section`). Update the example that shows
    `{{{delegation.section}}}` placement — either remove it or replace it with a
    `{{#delegation.targets}}` loop example.
  - **Compatibility with Existing Prompts** section (~lines 418–424): Remove the
    paragraph about `delegation.*` references suppressing fallback.
  - **Prompt Templates** section (~lines 210–215): Remove the note that
    `delegation.section` and `delegation.mermaid` should be rendered with triple
    braces.
- [ ] **Files**: `docs/prompt-composition.md`
- [ ] **Acceptance**:
  - No mention of `delegation.section` or `delegation.mermaid` remains in the
    document
  - The Template Context interface block in the doc matches the actual
    `AgentPromptTemplateContext` type after Task 1
  - The Composition Pipeline steps accurately describe the post-removal pipeline

---

### Task 7 — Update `docs/adr/0001-prompt-composition-templates.md`

- [ ] **What**: Update the ADR to record the removal decision as a follow-on
  change. Specifically:
  - **Decision section**: Remove `delegation.section` and `delegation.mermaid`
    from the "Template Context first slice exposes" bullet list.
  - **Decision section**: Remove the two bullets about fallback delegation for
    static prompts and fallback suppression by reference.
  - **Consequences — What changes** (~line 52–53): Remove the bullet about
    `delegation.section` and `delegation.mermaid` being generated and exposed.
    Remove the bullet about builtin prompt files using `{{{delegation.section}}}`.
  - **Consequences — What is now possible** (~line 58): Remove the bullets about
    placing `{{{delegation.section}}}` and suppressing fallback.
  - Add a new **Amendment** section at the bottom of the ADR noting the date,
    the decision to remove `delegation.section` and `delegation.mermaid`, and the
    rationale (no builtin uses them; `{{#delegation.targets}}` loops are
    sufficient and more composable).
- [ ] **Files**: `docs/adr/0001-prompt-composition-templates.md`
- [ ] **Acceptance**:
  - No mention of `delegation.section` or `delegation.mermaid` in the Decision or
    Consequences sections
  - An Amendment section is present with rationale
  - The ADR accurately reflects the current state of the system

> **Parallel-safe**: Tasks 6 and 7 are independent of each other and of all
> source tasks. They can be done in parallel with Tasks 3–5.

---

## Execution Order

```
Tasks 1 + 2  (parallel — source changes, complete both before typecheck)
     ↓
Tasks 3 + 4 + 5  (parallel — test updates, after source is stable)
     ↓
Tasks 6 + 7  (parallel — doc updates, can start any time)
```

Tasks 6 and 7 are fully parallel-safe with all other tasks since they only touch
`docs/`.

## Verification

After all tasks are complete:

```bash
bun run typecheck   # must pass with zero errors
bun test            # must pass with zero failures
```

Grep checks:
```bash
grep -r "delegation\.section\|delegation\.mermaid" packages/engine/src/
# → zero matches expected

grep -r "generateDelegationSection\|generateMermaidDiagram\|generateWorkflowMermaidDiagram" packages/engine/src/
# → zero matches expected

grep -r "delegation\.section\|delegation\.mermaid" docs/
# → zero matches expected
```
