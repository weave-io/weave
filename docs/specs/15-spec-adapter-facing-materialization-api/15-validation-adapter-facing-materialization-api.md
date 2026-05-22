# Spec 15 Validation Report — Adapter-Facing Materialization API

**Validation date:** 2026-05-22  
**Validator role:** Senior QA Engineer  
**Branch validated:** `feat/spec-15-materialization-api`  
**Worktree validated:** `/Users/jose/projects/weave.worktrees/feat-spec-15-materialization-api`  
**Main checkout report path:** `docs/specs/15-spec-adapter-facing-materialization-api/15-validation-adapter-facing-materialization-api.md`

## Overall Verdict

**PASS**

The implementation conforms to Spec 15 and the task list. All validation gates pass. No CRITICAL or HIGH issues were found.

## Validation Commands

| Command | Result |
| --- | --- |
| `git -C /Users/jose/projects/weave.worktrees/feat-spec-15-materialization-api diff --name-only f55169c..HEAD` | Passed; changed-file list reviewed. |
| `bun test packages/engine/src/__tests__/materialization.test.ts` | Passed: `21 pass / 0 fail`, 58 expectations. |
| `bun run --filter '@weave/engine' typecheck` | Passed: `@weave/engine typecheck: Exited with code 0`. |
| `bun test packages/engine/src/__tests__/runner.test.ts` | Passed: `51 pass / 0 fail`, 140 expectations. |
| Proof artifact read/scan | Passed; all four proof files exist and contain relevant evidence. |
| Proof artifact credential scan | Passed; no credential patterns found. |

## Gate Results

| Gate | Status | Evidence |
| --- | --- | --- |
| GATE A — Any CRITICAL/HIGH issue fails | PASS | No CRITICAL or HIGH issues identified. |
| GATE B — Functional coverage has no Unknown entries | PASS | All functional requirements mapped to code, tests, docs, or explicit compatibility decision. |
| GATE C — Proof artifacts accessible and functional | PASS | `15-task-01-proofs.md` through `15-task-04-proofs.md` exist and include command/test evidence; validation commands passed. |
| GATE D1 — No unmapped out-of-scope source changes | PASS | Changed source/doc/proof files all map to Spec 15. `.codesight/` changes are generated supporting index files as expected. |
| GATE E — Repository standards followed | PASS | Bun tests/typecheck pass; no materialization `HarnessAdapter`; neverthrow `ResultAsync`; discriminated errors; no `console.*`; no harness I/O. |
| GATE F — No real credentials in proof artifacts | PASS | Secret scan found no matches in `15-proofs/`. |

## Changed File Scope Review

`git diff --name-only f55169c..HEAD` returned:

- `.codesight/CODESIGHT.md`
- `.codesight/coverage.md`
- `.codesight/libs.md`
- `docs/adapter-boundary.md`
- `docs/specs/15-spec-adapter-facing-materialization-api/15-proofs/15-task-01-proofs.md`
- `docs/specs/15-spec-adapter-facing-materialization-api/15-proofs/15-task-02-proofs.md`
- `docs/specs/15-spec-adapter-facing-materialization-api/15-proofs/15-task-03-proofs.md`
- `docs/specs/15-spec-adapter-facing-materialization-api/15-proofs/15-task-04-proofs.md`
- `packages/engine/src/__tests__/materialization.test.ts`
- `packages/engine/src/index.ts`
- `packages/engine/src/materialization.ts`
- `packages/engine/src/runner.ts`

All changed files are in scope for Spec 15 or generated/supporting index artifacts with direct linkage to the implementation.

## Coverage Matrix

| Spec Unit / Functional Requirement | Coverage Status | Evidence |
| --- | --- | --- |
| Unit 1: Export public materialization function from `packages/engine/src/index.ts` | Covered | `index.ts` exports `materializeAgents`; import/export test imports from `../index.js`. |
| Unit 1: Define public input, output, warning, and error types | Covered | `MaterializationInput`, `MaterializedAgent`, `MaterializationPlan`, `MaterializationError` defined/exported. No warnings currently needed by MVP output. |
| Unit 1: Accept explicit adapter-provided context; no harness directories/UI/runtime state; no `HarnessAdapter` | Covered | `materializeAgents(input: { config })`; `materialization.ts` has no `HarnessAdapter`, filesystem, harness names, or adapter lifecycle calls. |
| Unit 1: Return `Result`/`ResultAsync` with discriminated union errors | Covered | `ResultAsync<MaterializationPlan, MaterializationError>`; variants `CategoryShuttleConflict` and `DescriptorCompositionFailure`. |
| Unit 2: Materialize builtin agents in resolved config | Covered | Test: “produces descriptors for builtin-named declared agents”. |
| Unit 2: Materialize custom agents | Covered | Tests for single and multiple declared custom agents. |
| Unit 2: Generate/materialize category shuttle descriptors using existing naming/merge behavior | Covered | Uses `generateCategoryShuttles(input.config)`; category shuttle tests pass. |
| Unit 2: Generated shuttles deterministic order | Covered | Tests assert generated shuttle order and repeated calls produce identical order. |
| Unit 2: Exclude disabled agents consistently with runner behavior | Covered | Tests cover disabled declared agent, disabled base `shuttle`, and disabled specific `shuttle-{name}`. |
| Unit 2: Do not invoke `spawnSubagent()` or adapter lifecycle methods | Covered | API has no adapter parameter; test confirms materialization runs without constructing `HarnessAdapter`; code review confirms no lifecycle call. |
| Unit 3: Reuse `composeAgentDescriptor` rather than duplicating prompt composition | Covered | `materialization.ts` imports/calls `composeAgentDescriptor`; descriptor compatibility test compares direct composition output. |
| Unit 3: Reuse `generateCategoryShuttles` rather than parallel category implementation | Covered | `materialization.ts` imports/calls `generateCategoryShuttles`. |
| Unit 3: Convert category shuttle conflicts into typed materialization errors | Covered | `generateCategoryShuttles` error maps to `CategoryShuttleConflict`; tests assert returned `err`, not throw. |
| Unit 3: Preserve prompt composition errors with affected agent context | Covered | `DescriptorCompositionFailure` includes `agentName` and `cause`; tests assert affected agent. |
| Unit 3: Do not silently swallow expected materialization failures | Covered | Materialization returns `err` on category conflict and first descriptor composition failure. |
| Unit 4: Keep `WeaveRunner.run()` behavior compatible | Covered | Runner test passes: `51 pass / 0 fail`; runner loop intentionally unchanged. |
| Unit 4: Use materialization internally if safe | Covered by explicit decision | Proof and `runner.ts` comment explain not safe due throw-vs-err and continue-vs-stop behavioral differences. Spec says “should”, not “shall”. |
| Unit 4: Preserve `onEffect` and `spawnSubagent()` ordering if refactored | Covered | No refactor performed; existing runner test suite passed. Manual review confirms `onEffect` remains immediately before `spawnSubagent`. |
| Unit 4: Document materialization API and ownership in adapter boundary docs | Covered | `docs/adapter-boundary.md` includes “Agent Materialization API” section with data contract, engine responsibilities, adapter responsibilities. |
| Unit 4: State API does not replace adapter responsibilities for file writes/tool mapping/model discovery/skill discovery/runtime launch | Covered | `docs/adapter-boundary.md` states adapters own translation, spawning/emulation, abstract field mapping, side effects; engine must not write harness config, spawn agents, discover resources, or register callbacks. |

## Proof Artifact Review

| Artifact | Status | Notes |
| --- | --- | --- |
| `15-task-01-proofs.md` | PASS | Contains import/export and typecheck proof. Historical test-count snippet is narrower than current full file result, but current validation command passed. |
| `15-task-02-proofs.md` | PASS | Covers deterministic descriptor materialization, disabled behavior, no adapter dispatch. |
| `15-task-03-proofs.md` | PASS | Covers typed failures and descriptor compatibility. Historical count says 19 tests; current validation shows 21 tests due later additions. Not a functional issue. |
| `15-task-04-proofs.md` | PASS | Documents runner refactor decision, runner compatibility test output, no new deprecated surface dependency. |

## Repository Standards Review

- **Bun-only:** Validation used Bun commands. New materialization code does not use Node runtime APIs, filesystem, process spawning, or harness I/O.
- **neverthrow:** `materializeAgents` returns `ResultAsync<MaterializationPlan, MaterializationError>` and maps expected errors via `errAsync`/`mapErr`.
- **Discriminated errors:** `MaterializationError` is a discriminated union with `type` variants.
- **Early returns / no nested ternaries / no nested try-catch:** `materialization.ts` uses early error return. No nested try/catch. Ternaries for category derivation are shallow enough and typecheck cleanly.
- **Logging:** New materialization module has no logging and no `console.*`. Existing runner uses pino `logger`.
- **Engine/adapter boundary:** `materialization.ts` has no `HarnessAdapter` parameter and no adapter lifecycle calls. It does not scan harness-owned directories or invoke UI/runtime state.
- **Tests:** Tests use `bun:test`; no real harness process or adapter is constructed.

## Issues Found

No blocking issues found.

Informational observations:

1. Some proof snippets record earlier focused test counts (`19 pass`) while the current focused materialization suite reports `21 pass`. This is acceptable because the proof artifacts remain accessible and current validation commands pass.
2. The runner was not refactored to call `materializeAgents`; this matches the documented compatibility decision and the spec’s conditional “should” wording.

## Final Assessment

Spec 15 is validated as complete. The implementation provides a public, typed, adapter-facing materialization API; preserves deterministic descriptor output; handles expected failures through typed `neverthrow` results; avoids adapter lifecycle coupling; keeps runner behavior compatible; and documents the adapter boundary responsibilities.

**Final verdict: PASS**
