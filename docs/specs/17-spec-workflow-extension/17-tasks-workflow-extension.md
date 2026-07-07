## Relevant Files

| File | Why It Is Relevant |
| --- | --- |
| `packages/core/src/schema.ts` | Add `extends`, `insert_before`, `insert_after` fields to `WorkflowConfig` and `WorkflowStep` Zod schemas. |
| `packages/core/src/ast.ts` | Add AST node fields for `extends`, `insert_before`, `insert_after`. |
| `packages/core/src/parser.ts` | Parse `extends` at workflow level; parse `insert_before` / `insert_after` at step level. |
| `packages/core/src/validate.ts` | Validate and transform new AST fields into `WorkflowConfig` / `WorkflowStep`. |
| `packages/core/src/errors.ts` | Add `WorkflowExtensionError` discriminated union (`UnknownExtendsTarget`, `UnknownInsertionAnchor`, `BothInsertBeforeAndAfter`, `ExtendsCycle`). |
| `packages/core/src/index.ts` | Export new error types and updated config types. |
| `packages/config/src/merge.ts` | Implement extension resolution algorithm: parent lookup, replacement, insertion, appending, field stripping. |
| `packages/config/src/index.ts` | Export extension resolution helpers if needed. |
| `packages/core/src/__tests__/schema.test.ts` | Tests for new schema fields: accept valid values, reject invalid values. |
| `packages/core/src/__tests__/parser.test.ts` | Tests for parsing `extends`, `insert_before`, `insert_after`. |
| `packages/core/src/__tests__/validate.test.ts` | Tests for AST → `WorkflowConfig` transform with new fields. |
| `packages/core/src/__tests__/parse_config.test.ts` | E2E tests for full pipeline with extension declarations. |
| `packages/config/src/__tests__/merge.test.ts` | Tests for extension resolution: replacements, insertions, appends, all four error types. |
| `docs/adapter-boundary.md` | Add link to Spec 17 in the related-specs list. |
| `docs/specs/17-spec-workflow-extension/17-spec-workflow-extension.md` | Source specification. |

### Notes

- Unit tests for schema changes must be added at all four levels: schema, parser, validate, and E2E (`parse_config`). See AGENTS.md schema evolution rules.
- Extension resolution tests live in `packages/config/src/__tests__/merge.test.ts` (or a new `extension.test.ts` alongside it).
- Use `bun test packages/core/src/__tests__/` for core pipeline tests.
- Use `bun test packages/config/src/__tests__/` for config merge/extension tests.
- Use `bun run typecheck` for full workspace type checking.
- The engine and adapter packages require no changes for this spec.

---

## Tasks

### [ ] 1.0 Add DSL schema fields for workflow extension

#### 1.0 Proof Artifact(s)

- Test: `packages/core/src/__tests__/schema.test.ts` accepts `extends` on `WorkflowConfig` and `insert_before` / `insert_after` on `WorkflowStep`.
- Test: `packages/core/src/__tests__/schema.test.ts` rejects `insert_before` and `insert_after` when both are present on the same step (cross-field constraint).
- Typecheck: `bun run typecheck` passes with new optional fields.

#### 1.0 Tasks

- [ ] 1.1 Add `extends?: z.string()` to the `WorkflowConfig` Zod schema in `packages/core/src/schema.ts`.
- [ ] 1.2 Add `insert_before?: z.string()` and `insert_after?: z.string()` to the `WorkflowStep` Zod schema.
- [ ] 1.3 Add a `.refine()` cross-field constraint to `WorkflowStep` that rejects steps declaring both `insert_before` and `insert_after`.
- [ ] 1.4 Update `WorkflowConfig` and `WorkflowStep` TypeScript types in `packages/core/src/config.ts` to include the new optional fields.
- [ ] 1.5 Add schema tests: accept valid `extends`; accept valid `insert_before`; accept valid `insert_after`; reject both present; existing workflow tests still pass.
- [ ] 1.6 Run `bun run typecheck` and save output as proof artifact.

### [ ] 2.0 Parse `extends`, `insert_before`, `insert_after` in the DSL

#### 2.0 Proof Artifact(s)

- Test: `packages/core/src/__tests__/parser.test.ts` parses `extends "plan-and-execute"` at workflow level.
- Test: `packages/core/src/__tests__/parser.test.ts` parses `insert_before "plan"` and `insert_after "review"` at step level.
- Test: `packages/core/src/__tests__/validate.test.ts` transforms parsed AST into `WorkflowConfig` with `extends` and step-level anchor fields.

#### 2.0 Tasks

- [ ] 2.1 Add `extends` keyword handling to the lexer / parser for workflow blocks in `packages/core/src/parser.ts`.
- [ ] 2.2 Add `insert_before` and `insert_after` keyword handling to the parser for step blocks.
- [ ] 2.3 Add corresponding AST node fields in `packages/core/src/ast.ts`.
- [ ] 2.4 Update `packages/core/src/validate.ts` to map new AST fields to `WorkflowConfig.extends` and `WorkflowStep.insert_before` / `WorkflowStep.insert_after`.
- [ ] 2.5 Add parser tests for `extends` at workflow level.
- [ ] 2.6 Add parser tests for `insert_before` and `insert_after` at step level.
- [ ] 2.7 Add validate tests for AST → config transform with new fields.
- [ ] 2.8 Add E2E tests in `packages/core/src/__tests__/parse_config.test.ts` for a workflow with `extends` and anchor steps.

### [ ] 3.0 Define `WorkflowExtensionError` discriminated union

#### 3.0 Proof Artifact(s)

- Code review artifact: `packages/core/src/errors.ts` exports `WorkflowExtensionError` with all four variants.
- Typecheck: `bun run typecheck` passes with new error types exported from `packages/core/src/index.ts`.

#### 3.0 Tasks

- [ ] 3.1 Add `WorkflowExtensionError` discriminated union to `packages/core/src/errors.ts` with variants: `UnknownExtendsTarget`, `UnknownInsertionAnchor`, `BothInsertBeforeAndAfter`, `ExtendsCycle`.
- [ ] 3.2 Include all context fields specified in the spec for each variant (see Validation Errors section).
- [ ] 3.3 Export `WorkflowExtensionError` and all variant types from `packages/core/src/index.ts`.
- [ ] 3.4 Run `bun run typecheck` and save output as proof artifact.

### [ ] 4.0 Implement extension resolution in `@weaveio/weave-config`

#### 4.0 Proof Artifact(s)

- Test: `packages/config/src/__tests__/merge.test.ts` (or `extension.test.ts`) covers: replacement, `insert_before`, `insert_after`, append, `UnknownExtendsTarget`, `UnknownInsertionAnchor`, `BothInsertBeforeAndAfter`, `ExtendsCycle`.
- Test: builtin workflow `plan-and-execute` is unchanged after extension resolution when no child extends it.
- Test: the example from the spec (insert `spec` before `plan` in `plan-and-execute`) produces the correct 7-step order.
- CLI: `bun test packages/config/src/__tests__/` passes.

#### 4.0 Tasks

- [ ] 4.1 Implement `resolveWorkflowExtensions(workflows: WorkflowConfig[]): Result<WorkflowConfig[], WorkflowExtensionError[]>` in `packages/config/src/merge.ts` (or a new `extension.ts`).
- [ ] 4.2 Implement parent lookup: find parent by name in the resolved workflow list; emit `UnknownExtendsTarget` if not found.
- [ ] 4.3 Implement cycle detection: track the resolution chain; emit `ExtendsCycle` if a workflow appears twice.
- [ ] 4.4 Implement replacement: child steps with the same name as a parent step and no anchor replace the parent step in place.
- [ ] 4.5 Implement insertion: child steps with `insert_before` / `insert_after` are inserted at the anchor position; emit `UnknownInsertionAnchor` if anchor not found.
- [ ] 4.6 Implement append: child steps with no anchor and no parent-name match are appended after all parent steps.
- [ ] 4.7 Strip `extends`, `insert_before`, and `insert_after` from the resolved `WorkflowConfig` before returning.
- [ ] 4.8 Call `resolveWorkflowExtensions` from the config merge pipeline so the engine always receives resolved configs.
- [ ] 4.9 Add tests for all merge cases and all four error types.
- [ ] 4.10 Add a test proving builtin workflows are unchanged when no child extends them.
- [ ] 4.11 Add a test for the spec example: `spec` inserted before `plan` in `plan-and-execute` produces the 7-step order.
- [ ] 4.12 Run `bun test packages/config/src/__tests__/` and save output as proof artifact.

### [ ] 5.0 Documentation and adapter boundary update

#### 5.0 Proof Artifact(s)

- Documentation: `docs/adapter-boundary.md` includes a link to Spec 17 in the related-specs list.
- Documentation: `docs/specs/17-spec-workflow-extension/17-spec-workflow-extension.md` is complete and cross-linked.

#### 5.0 Tasks

- [ ] 5.1 Add a link to Spec 17 in the `Related:` line of `docs/adapter-boundary.md`.
- [ ] 5.2 Verify `docs/specs/17-spec-workflow-extension/17-spec-workflow-extension.md` cross-links to `docs/adapter-boundary.md`.
- [ ] 5.3 Run `bun run typecheck` and `bun test` to confirm no regressions.
