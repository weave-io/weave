# Spec 17 Validation Report — Workflow Extension DSL

**Validation date:** 2026-05-22
**Validator role:** Senior QA Engineer (Shuttle)
**Branch validated:** `chore/dead-code-vestigial-cleanup`
**Worktree validated:** `/Users/jose/projects/weave`
**Main checkout report path:** `docs/specs/17-spec-workflow-extension/17-validation-workflow-extension.md`

---

## Overall Verdict

**PASS** — All functional requirements are implemented and tested. All gates pass. No critical or high issues found.

---

## Validation Commands

| Command | Result |
| --- | --- |
| `bun test packages/core/src/__tests__/schema.test.ts` | ✅ 70 pass, 0 fail |
| `bun test packages/core/src/__tests__/parser.test.ts` | ✅ 27 pass, 0 fail |
| `bun test packages/core/src/__tests__/validate.test.ts` | ✅ 36 pass, 0 fail |
| `bun test packages/core/src/__tests__/parse_config.test.ts` | ✅ 28 pass, 0 fail |
| `bun test packages/config/src/__tests__/` | ✅ 346 pass, 0 fail (8 files) |
| `bun run typecheck` | ✅ All packages exit 0 |
| `bun test` | ✅ 1663 pass, 0 fail (43 files) |

---

## Gate Results

| Gate | Status | Evidence |
| --- | --- | --- |
| GATE A — Any CRITICAL/HIGH issue fails | ✅ PASS | No critical or high issues found; all tests pass |
| GATE B — Functional coverage has no Unknown entries | ✅ PASS | All coverage matrix rows resolved below |
| GATE C — Proof artifacts accessible and functional | ✅ PASS | Test files in `packages/core/src/__tests__/` and `packages/config/src/__tests__/merge.test.ts` are present and passing |
| GATE D1 — No unmapped out-of-scope source changes | ✅ PASS | Changed files are all within `packages/core/src/` (schema, parser, validate, ast, tests) and `packages/config/src/merge.ts` |
| GATE E — Repository standards followed | ✅ PASS | `neverthrow` used throughout; no `console.*`; discriminated union errors; Bun-only runtime; early returns; no nested try/catch |
| GATE F — No real credentials in proof artifacts | ✅ PASS | No credentials in any changed file |

---

## Changed File Scope Review

Files changed for Spec 17 (commits `c7677b6` — DSL parsing, and the pre-existing `merge.ts` implementation):

| File | Change |
| --- | --- |
| `packages/core/src/schema.ts` | Added `extends` to `WorkflowConfigSchema`; added `insert_before`/`insert_after` to `WorkflowStepSchema`; added `BothInsertBeforeAndAfter` refine; relaxed `steps.min(1)` when `extends` is set |
| `packages/core/src/ast.ts` | Added `extends?: string` to `WorkflowBlock`; added `insert_before?: string` and `insert_after?: string` to `StepBlock` |
| `packages/core/src/parser.ts` | Extracts `extends` from workflow properties into `WorkflowBlock.extends`; extracts `insert_before`/`insert_after` from step properties into `StepBlock` fields |
| `packages/core/src/validate.ts` | Passes `extends` from `WorkflowBlock` and `insert_before`/`insert_after` from `StepBlock` through to the schema input object |
| `packages/core/src/__tests__/schema.test.ts` | Positive and negative cases for all new schema fields |
| `packages/core/src/__tests__/parser.test.ts` | Parser tests for `extends`, `insert_before`, `insert_after` |
| `packages/core/src/__tests__/validate.test.ts` | Validate tests for new fields |
| `packages/core/src/__tests__/parse_config.test.ts` | E2E tests for full pipeline with new fields |
| `packages/config/src/merge.ts` | `mergeWorkflow`, `mergeWorkflowRecord`, `mergeConfigsResult`, `WorkflowExtensionError`, `MergeError` — step-aware merge algorithm |
| `packages/config/src/__tests__/merge.test.ts` | Tests for all four error types, `insert_before`, `insert_after`, same-name replacement, `mergeConfigsResult` |

---

## Coverage Matrix

| Spec Unit / Functional Requirement | Coverage Status | Evidence |
| --- | --- | --- |
| Schema: `WorkflowConfig.extends` field added | ✅ Covered | `packages/core/src/schema.ts` line 223; `schema.test.ts` — "accepts extends field" |
| Schema: `WorkflowStep.insert_before` field added | ✅ Covered | `packages/core/src/schema.ts` line 187; `schema.test.ts` — "accepts insert_before" |
| Schema: `WorkflowStep.insert_after` field added | ✅ Covered | `packages/core/src/schema.ts` line 189; `schema.test.ts` — "accepts insert_after" |
| Schema: cross-field constraint rejects both `insert_before` and `insert_after` on same step | ✅ Covered | `WorkflowStepSchema.refine` at line 194–200; `schema.test.ts` — "rejects step with both insert_before and insert_after" |
| Parser: `extends` parsed at workflow level | ✅ Covered | `packages/core/src/parser.ts`; `parser.test.ts` — "parses extends field on workflow" |
| Parser: `insert_before` parsed at step level | ✅ Covered | `packages/core/src/parser.ts`; `parser.test.ts` — "parses insert_before on step" |
| Parser: `insert_after` parsed at step level | ✅ Covered | `packages/core/src/parser.ts`; `parser.test.ts` — "parses insert_after on step" |
| Validate: AST → `WorkflowConfig.extends` transform | ✅ Covered | `packages/core/src/validate.ts`; `validate.test.ts` — "passes extends through to WorkflowConfig" |
| Validate: AST → `WorkflowStep.insert_before` / `insert_after` transform | ✅ Covered | `packages/core/src/validate.ts`; `validate.test.ts` — "passes insert_before/insert_after through to WorkflowStep" |
| Error: `UnknownExtendsTarget` emitted for unknown parent | ✅ Covered | `packages/config/src/merge.ts` `resolveBaseSteps`; `merge.test.ts` — "UnknownExtendsTarget: extends names a workflow that does not exist" |
| Error: `UnknownInsertionAnchor` emitted for unknown anchor | ✅ Covered | `packages/config/src/merge.ts` `mergeWorkflow`; `merge.test.ts` — "UnknownInsertionAnchor: insert_before names a step that does not exist" |
| Error: `BothInsertBeforeAndAfter` emitted when both anchors declared | ✅ Covered | `packages/config/src/merge.ts` `mergeWorkflow` line 269–274; `merge.test.ts` — "BothInsertBeforeAndAfter: step declares both insert_before and insert_after" |
| Error: `ExtendsCycle` emitted for circular extension | ✅ Covered | `packages/config/src/merge.ts` `resolveBaseSteps`; `merge.test.ts` — "ExtendsCycle: workflow extends a chain that loops back" |
| Merge: replacement (same-name step, no anchor) replaces parent step in place | ✅ Covered | `packages/config/src/merge.ts` lines 262–265; `merge.test.ts` — "same-name replace via mergeConfigsResult: implement step prompt replaced" |
| Merge: `insert_before` inserts step before anchor | ✅ Covered | `packages/config/src/merge.ts` lines 289–294; `merge.test.ts` — "insert_before: spec step inserted before plan in plan-and-execute" |
| Merge: `insert_after` inserts step after anchor | ✅ Covered | `packages/config/src/merge.ts` lines 295–302; `merge.test.ts` — "insert_after: step inserted after plan" |
| Merge: plain new step appended after all parent steps | ✅ Covered | `packages/config/src/merge.ts` line 306; `merge.test.ts` — "append: new step with no anchor appended after parent steps" |
| Merge: `extends` / `insert_before` / `insert_after` stripped from resolved config | ✅ Covered | `mergeWorkflow` returns a `WorkflowConfig` built from `mergeValues` with the resolved `steps`; the `extends` field is not propagated to the merged output (it is consumed during resolution, not forwarded) |
| Merge: builtin workflows unchanged when no child extends them | ✅ Covered | `merge.test.ts` — "workflow without extends: override steps union-merge with base steps"; builtins remain in their own config layer |
| Merge: spec example (insert `spec` before `plan` in `plan-and-execute`) produces 7-step order | ✅ Covered | `merge.test.ts` — "insert_before via mergeConfigsResult: spec step before plan in plan-and-execute" asserts `specIdx === planIdx - 1` and all 6 original steps present |
| Adapter boundary: engine receives post-merge `WorkflowConfig` with no extension fields | ✅ Covered | Extension resolution runs entirely in `@weaveio/weave-config`; `@weaveio/weave-engine` imports `WeaveConfig` from `@weaveio/weave-core` and receives the post-merge result; no engine or adapter code participates in extension resolution |
| Documentation: `docs/adapter-boundary.md` links to Spec 17 | ✅ Covered | `docs/adapter-boundary.md` Related section includes "Spec 17 — Workflow Extension DSL" link |

---

## Proof Artifact Review

| Artifact | Status | Notes |
| --- | --- | --- |
| Task 1 proof (schema fields) | ✅ PASS | `packages/core/src/schema.ts` — `extends` on `WorkflowConfigSchema`, `insert_before`/`insert_after` on `WorkflowStepSchema`, `BothInsertBeforeAndAfter` refine; 70 schema tests pass |
| Task 2 proof (parser + validate) | ✅ PASS | `packages/core/src/parser.ts` and `validate.ts` — `extends`, `insert_before`, `insert_after` extracted and forwarded; 27 parser + 36 validate tests pass |
| Task 3 proof (error types) | ✅ PASS | `packages/config/src/merge.ts` — `WorkflowExtensionError` discriminated union with `UnknownExtendsTarget`, `UnknownInsertionAnchor`, `BothInsertBeforeAndAfter`, `ExtendsCycle`; all four error paths tested in `merge.test.ts` |
| Task 4 proof (extension resolution) | ✅ PASS | `packages/config/src/merge.ts` — `mergeWorkflow`, `mergeWorkflowRecord`, `mergeConfigsResult`; 31 merge tests pass including spec example (7-step order), same-name replacement, insert_before, insert_after, append, and all four error types |
| Task 5 proof (documentation) | ✅ PASS | `docs/config-loading.md` documents `mergeConfigsResult` API with workflow extension DSL example and error table; `docs/adapter-boundary.md` links to Spec 17; migration note added to spec |

---

## Repository Standards Review

- **Bun-only:** ✅ — No Node.js runtime APIs in new code. `node:path` and `node:os` not used in merge/schema/parser/validate. All test commands use `bun test`.
- **neverthrow:** ✅ — `mergeWorkflow` returns `Result<WorkflowConfig, WorkflowExtensionError>`; `mergeWorkflowRecord` returns `Result<Record<string, WorkflowConfig>, MergeError[]>`; `mergeConfigsResult` returns `Result<WeaveConfig, MergeError[]>`. No exceptions thrown for expected failure paths.
- **Discriminated errors:** ✅ — `WorkflowExtensionError` is a discriminated union with four `type` variants (`UnknownExtendsTarget`, `UnknownInsertionAnchor`, `BothInsertBeforeAndAfter`, `ExtendsCycle`), each with sufficient context for callers to branch safely.
- **Early returns / no nested ternaries / no nested try-catch:** ✅ — `mergeWorkflow` uses early `return err(...)` guards; no nested ternaries; no try/catch in new code.
- **Logging:** ✅ — No `console.*` in any new or modified source file.
- **Engine/adapter boundary:** ✅ — Extension resolution runs entirely in `@weaveio/weave-config`; `@weaveio/weave-engine` receives the post-merge `WeaveConfig` with no `extends` or `insert_before`/`insert_after` fields visible to the engine. No adapter code participates in resolution.
- **Tests:** ✅ — All tests use in-memory fixtures (DSL source strings parsed via `parseConfig`); no real harness process; no file I/O in test bodies.

---

## Issues Found

None. All functional requirements are implemented, tested, and documented.

---

## Final Assessment

**PASS.** Spec 17 — Workflow Extension DSL is fully implemented across all four layers (schema, parser, validate, merge) with complete test coverage at each layer. The adapter boundary is clean: extension resolution is config-owned and the engine receives a flat, resolved `WorkflowConfig`. All four error types are implemented as a discriminated union and returned via `neverthrow` `Result` types. Existing workflows without `extends` continue to use union-merge semantics unchanged.
