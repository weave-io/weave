# 02-validation-workflow-schema

**Validation Completed:** 2026-05-07  
**Validation Performed By:** Claude Sonnet 4.5 (claude-code)  
**Spec:** `docs/specs/02-spec-workflow-schema/02-spec-workflow-schema.md`  
**Task List:** `docs/specs/02-spec-workflow-schema/02-tasks-workflow-schema.md`  
**Implementation Commit:** `194ed2e` — `feat(core): implement workflow schema validation`

---

## 1. Executive Summary

| Item                        | Result                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Overall**                 | ✅ **PASS** — all gates clear                                                                            |
| **Implementation Ready**    | **Yes** — all functional requirements verified with passing tests, clean typecheck, and pre-commit hooks |
| **Requirements Verified**   | 18 / 18 (100%)                                                                                           |
| **Proof Artifacts Working** | 6 / 6 (100%)                                                                                             |
| **Files Changed**           | 19 (excl. `.codesight/`) — all mapped to spec requirements                                               |

No gates were tripped. Two low-severity informational notes are documented below (spec field table vs. task-list discrepancies that were resolved in the audited task list).

---

## 2. Coverage Matrix

### Functional Requirements

#### Unit 1: Workflow and Step Zod Schemas

| Requirement                                                                                            | Status      | Evidence                                                                                                                   |
| ------------------------------------------------------------------------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| Export `WorkflowStepTypeSchema` as `z.enum(["autonomous","interactive","gate"])`                       | ✅ Verified | `schema.ts:96`; `schema.test.ts` — "accepts valid step types / rejects invalid step type" pass                             |
| Export `CompletionMethodSchema` as `z.discriminatedUnion("method",[...])` with 5 variants              | ✅ Verified | `schema.ts:116–122`; 9 CompletionMethodSchema tests all pass                                                               |
| Export `ArtifactRefSchema` as `z.object({name, description})`                                          | ✅ Verified | `schema.ts:129–132`; used and validated in `WorkflowStepSchema` step tests                                                 |
| Export `OnRejectSchema` as `z.enum(["pause","fail","retry"])`                                          | ✅ Verified | `schema.ts:139`; "accepts pause, fail, retry / rejects invalid value" pass                                                 |
| Export `WorkflowStepSchema` with all required fields (`name`, `type`, `agent`, `prompt`, `completion`) | ✅ Verified | `schema.ts:153–167`; 8 WorkflowStepSchema tests pass                                                                       |
| Export `WorkflowConfigSchema` with `version` (int>0) and `steps` (min 1)                               | ✅ Verified | `schema.ts:179–184`; 5 WorkflowConfigSchema tests pass                                                                     |
| `.refine()`: `on_reject` valid only on `type:"gate"` steps                                             | ✅ Verified | `schema.ts:165–167`; "rejects on_reject on non-gate step" passes; error message `"on_reject is only valid for gate steps"` |
| Export all 6 inferred types via `z.infer<>`                                                            | ✅ Verified | `schema.ts:211–221`: `WorkflowStepType`, `CompletionMethod`, `ArtifactRef`, `OnReject`, `WorkflowStep`, `WorkflowConfig`   |
| All schemas and types exported from `@weave/core` barrel                                               | ✅ Verified | `index.ts:54–79`: all 6 types + 6 schemas present                                                                          |

#### Unit 2: Validation Pipeline Integration

| Requirement                                                                                         | Status      | Evidence                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Replace `workflows: z.record(z.string(), z.unknown()).optional()` with typed `WorkflowConfigSchema` | ✅ Verified | `schema.ts:197`: `z.record(z.string(), WorkflowConfigSchema).default({})`                                                                                             |
| `validate.ts` maps step block name → `name`, inner `name` prop → `display_name`                     | ✅ Verified | `validate.ts:68–73`; "step block name maps to name; inner name property maps to display_name" passes                                                                  |
| Bare `completion user_confirm` → `{ method: "user_confirm" }`                                       | ✅ Verified | `validate.ts:79–81`; "bare completion identifier round-trips" passes                                                                                                  |
| Block `completion plan_created { ... }` → `{ method: "plan_created", plan_name: "..." }`            | ✅ Verified | `validate.ts:82–86`; "named block completion (plan_created) round-trips" passes                                                                                       |
| `WeaveConfig.workflows` typed as `Record<string, WorkflowConfig>`                                   | ✅ Verified | `bun run typecheck` exits 0; engine + adapter packages compile clean with narrowed type                                                                               |
| Existing tests continue to pass (zero regressions)                                                  | ✅ Verified | 136 total tests pass (80 pre-existing + 42 new core + 14 engine)                                                                                                      |
| Parser enhancement: `identifier { block }` → `BlockValue.__name`                                    | ✅ Verified | `parser.ts:424–445`; 3 named-block-value parser tests pass                                                                                                            |
| Error paths include full workflow location (e.g. `workflows.X.steps.0.type`)                        | ✅ Verified | Live runtime check: `parseConfig()` with invalid step type produces `{"path":"workflows.secure-feature.steps.0.type","message":"Invalid option: expected one of..."}` |

### Repository Standards

| Standard                                    | Status      | Evidence & Notes                                                                                                                                               |
| ------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bun-only runtime**                        | ✅ Verified | No `@types/node`, `ts-node`, or `nodemon` introduced. `bun test` used throughout.                                                                              |
| **`neverthrow` Result types**               | ✅ Verified | `validate.ts` and `parser.ts` both import from `neverthrow`; `validate()` returns `Result<WeaveConfig, ValidationError[]>`. No new throwable paths introduced. |
| **Zod-inferred types**                      | ✅ Verified | All 6 new types via `z.infer<typeof ...Schema>`. No hand-written interface definitions.                                                                        |
| **Barrel exports**                          | ✅ Verified | All 6 schemas + 6 types added to `packages/core/src/index.ts`.                                                                                                 |
| **JSDoc on every exported schema and type** | ✅ Verified | `schema.ts:95,106,128,138,145,173,210–221` — all carry JSDoc comments.                                                                                         |
| **Tests co-located in `__tests__/`**        | ✅ Verified | New `schema.test.ts` in `packages/core/src/__tests__/`. All test additions in existing test files.                                                             |
| **Conventional Commits**                    | ✅ Verified | Commit `194ed2e`: `feat(core): implement workflow schema validation` with body referencing T1–T6 and Spec 02.                                                  |
| **Pre-commit hooks pass**                   | ✅ Verified | Commit log shows biome, typecheck, validate-config, test, and codesight all exiting 0.                                                                         |

### Proof Artifacts

| Task                       | Proof File                       | Status      | Verification                                                                                                                                  |
| -------------------------- | -------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| T1.0 — Parser enhancement  | `02-proofs/02-task-01-proofs.md` | ✅ Verified | File exists (2,531 bytes); task summary leads; `bun test parser.test.ts` → 18 pass; typecheck → 0 errors. Independently re-run: confirmed.    |
| T2.0 — Zod schemas         | `02-proofs/02-task-02-proofs.md` | ✅ Verified | File exists (3,751 bytes); full test output for all 27 schema tests. Independently re-run: 27/27 pass.                                        |
| T3.0 — Validator transform | `02-proofs/02-task-03-proofs.md` | ✅ Verified | File exists (2,462 bytes); 7 new workflow validate tests listed. Independently re-run: 22/22 pass.                                            |
| T4.0 — E2E pipeline tests  | `02-proofs/02-task-04-proofs.md` | ✅ Verified | File exists (2,857 bytes); `secure-feature` and `quick-fix` E2E tests passing; negative tests passing. Independently re-run: 16/16 pass.      |
| T5.0 — Barrel exports      | `02-proofs/02-task-05-proofs.md` | ✅ Verified | File exists (1,884 bytes); typecheck and full test run evidence present.                                                                      |
| T6.0 — Documentation       | `02-proofs/02-task-06-proofs.md` | ✅ Verified | File exists (2,184 bytes); `docs/workflow-schema.md` exists at 286 lines; spec-01 open question updated with link; spec-02 non-goals updated. |

---

## 3. Validation Issues

| Severity | Issue                                                                                                                                                                                                                                                                                                                                                       | Impact                                                                                            | Recommendation                                                                                                                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LOW      | **Spec/task-list discrepancy: `on_reject` default.** The spec field table says `on_reject` has `default "pause"` for gate steps, but task 2.5 (audited) specifies `OnRejectSchema.optional()` with no Zod `.default("pause")`. Implementation follows the task list, not the field description.                                                             | No functional impact — gate step `on_reject` values round-trip correctly; users must be explicit. | Accepted design choice per audited task list. If a runtime default of `"pause"` is desired, add `OnRejectSchema.default("pause")` to a future schema revision. Document in `docs/workflow-schema.md`. |
| LOW      | **Spec/task-list discrepancy: `WorkflowConfig.name` described as required.** The spec field table says `name (string, required) — set from the block name`, but task 2.6 specifies `name: z.string().optional()`. In practice the workflow name is stored as the `workflows` record key, not inside the config object — so the field is always `undefined`. | No functional impact — the workflow is identified by its record key.                              | Accepted design. Consider adding a note to `docs/workflow-schema.md` clarifying that `WorkflowConfig.name` is the record key, not an object field, to prevent future confusion.                       |

> **Note:** Both issues were present in the task list prior to the audit phase and were not flagged as blockers. They are documentation-level discrepancies, not implementation defects.

---

## 4. Evidence Appendix

### Git Commit Analysis

```
commit 194ed2e
feat(core): implement workflow schema validation

Files changed (19, excluding .codesight/):
  docs/specs/01-spec-core-dsl/01-spec-core-dsl.md         ← T6.2: open question resolved
  docs/specs/02-spec-workflow-schema/02-audit-…            ← audit (planning artifact)
  docs/specs/02-spec-workflow-schema/02-proofs/            ← 6 proof files (T1–T6)
  docs/specs/02-spec-workflow-schema/02-spec-…             ← spec (planning artifact)
  docs/specs/02-spec-workflow-schema/02-tasks-…            ← task list (all [x])
  docs/workflow-schema.md                                  ← T6.1: new doc
  packages/core/src/__tests__/parse_config.test.ts         ← T4: 5 new E2E tests
  packages/core/src/__tests__/parser.test.ts               ← T1: 3 new parser tests
  packages/core/src/__tests__/schema.test.ts               ← T2: 27 new schema tests (new file)
  packages/core/src/__tests__/validate.test.ts             ← T3: 7 new validate tests
  packages/core/src/index.ts                               ← T5: 12 new exports
  packages/core/src/parser.ts                              ← T1: named block value pattern
  packages/core/src/schema.ts                              ← T2: 6 new schemas + 8 types
  packages/core/src/validate.ts                            ← T3: transformStepProperties()
```

All 19 changed files map directly to spec tasks. No unmapped out-of-scope source code changes.

### Test Results (independently re-executed)

```
bun test packages/core/

 122 pass
 0 fail
 358 expect() calls
Ran 122 tests across 6 files.

bun run typecheck

@weave/core typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
```

### Error Path Quality Check (live execution)

```bash
bun -e "
const { parseConfig } = await import('./packages/core/src/parse-config.ts');
parseConfig(\`workflow secure-feature {
  version 1
  step plan { name \"P\" type background agent x prompt \"y\" completion agent_signal }
}\`).match(null, e => console.log(JSON.stringify(e, null, 2)));
"

[
  {
    "type": "ValidationError",
    "path": "workflows.secure-feature.steps.0.type",
    "message": "Invalid option: expected one of \"autonomous\"|\"interactive\"|\"gate\""
  }
]
```

Path format `workflows.<name>.steps.<index>.<field>` matches spec success metric.

### Security Check

```bash
grep -riE "(sk-|ghp_|eyJ|AKIA|xox[bp]|Bearer [a-z0-9]{20})" docs/specs/02-spec-workflow-schema/
# (no output — clean)
```

### Task List Completion

```bash
grep -E "^\s*-\s+\[" docs/specs/02-spec-workflow-schema/02-tasks-workflow-schema.md | grep -v "\[x\]"
# (no output — all tasks marked [x])
```

---

**Validation result: PASS. Implementation is ready for final code review and merge.**
