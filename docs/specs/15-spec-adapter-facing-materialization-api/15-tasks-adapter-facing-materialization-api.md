## Relevant Files

| File | Why It Is Relevant |
| --- | --- |
| `packages/engine/src/materialization.ts` | New engine module for the public adapter-facing materialization API, result types, ordered descriptor output, and typed errors. |
| `packages/engine/src/index.ts` | Public export surface for the materialization function and related types. |
| `packages/engine/src/runner.ts` | Transitional runner that may consume the new API while preserving current adapter lifecycle behavior. |
| `packages/engine/src/compose.ts` | Existing descriptor composition helper that materialization must reuse rather than duplicate. |
| `packages/engine/src/descriptors.ts` | Existing category shuttle generator and conflict error source that materialization must reuse. |
| `packages/engine/src/run-agent-effects.ts` | Existing effect shape and security invariants relevant if runner integration maps materialized descriptors to effects. |
| `packages/engine/src/__tests__/materialization.test.ts` | New focused tests for public API exports, deterministic descriptors, disabled agents, no adapter dispatch, and typed errors. |
| `packages/engine/src/__tests__/runner.test.ts` | Existing compatibility tests for `WeaveRunner.run()` behavior and call ordering. |
| `packages/engine/src/__tests__/mock-adapter.ts` | Existing mock adapter used to verify runner behavior without a real harness. |
| `docs/adapter-boundary.md` | Required documentation target for materialization ownership and adapter responsibilities after descriptors are returned. |
| `docs/specs/15-spec-adapter-facing-materialization-api/15-spec-adapter-facing-materialization-api.md` | Source specification that defines goals, functional requirements, non-goals, and proof artifacts. |
| `docs/specs/15-spec-adapter-facing-materialization-api/15-audit-adapter-facing-materialization-api.md` | Planning audit report for SDD gate status and evidence. |

### Notes

- Unit tests should be placed alongside existing engine tests under `packages/engine/src/__tests__/`.
- Use `bun test packages/engine/src/__tests__/materialization.test.ts` for focused materialization validation.
- Use `bun test packages/engine/src/__tests__/runner.test.ts` when runner internals are changed.
- Use `bun run --filter '@weave/engine' typecheck` to verify package-level public API typing.
- Follow the engine/adapter boundary: the materialization API accepts explicit context and returns normalized results; it must not scan harness-owned resources or invoke adapter lifecycle methods.
- Planning assumptions for open questions: start with an ordered materialization result that can include descriptors plus minimal provenance/warnings if useful; do not include skill resolution or category provenance beyond what is needed for issue #70; refactor `WeaveRunner` to consume the API only if compatibility remains straightforward.

## Tasks

### [x] 1.0 Define the public materialization API contract

#### 1.0 Proof Artifact(s)

- Test: `packages/engine/src/__tests__/materialization.test.ts` import/export test passes and demonstrates adapters can import the materialization function and public types from `@weave/engine`.
- Typecheck: `bun run --filter '@weave/engine' typecheck` passes and demonstrates the public API, input/output types, and discriminated error types compile.
- Code review artifact: `packages/engine/src/materialization.ts` API signature demonstrates no `HarnessAdapter` parameter and no concrete harness-specific type names.

#### 1.0 Tasks

- [ ] 1.1 Create `packages/engine/src/materialization.ts` for the adapter-facing materialization API.
- [ ] 1.2 Define `MaterializationInput` with a resolved `WeaveConfig` and only explicit adapter-provided context required for descriptor composition.
- [ ] 1.3 Define `MaterializedAgent` and/or `MaterializationPlan` output types that preserve deterministic agent ordering.
- [ ] 1.4 Define discriminated `MaterializationError` variants for category shuttle conflicts and descriptor composition failures.
- [ ] 1.5 Implement the public function signature as `ResultAsync<MaterializationPlan, never>` from `neverthrow`; per-agent failures accumulate into `MaterializationPlan.errors[]` rather than causing top-level rejection.
- [ ] 1.6 Export the public materialization function and public types from `packages/engine/src/index.ts`.
- [ ] 1.7 Add an import/export test that imports the function and types from the package barrel.
- [ ] 1.8 Run `bun run --filter '@weave/engine' typecheck` and save the command output as the typecheck proof artifact.

### [x] 2.0 Materialize deterministic descriptors for declared and generated agents

#### 2.0 Proof Artifact(s)

- Test: `packages/engine/src/__tests__/materialization.test.ts` builtin-agent case passes and demonstrates configured builtin agents produce composed descriptors.
- Test: `packages/engine/src/__tests__/materialization.test.ts` custom-agent case passes and demonstrates user-defined agents produce composed descriptors.
- Test: `packages/engine/src/__tests__/materialization.test.ts` generated-category-shuttle case passes and demonstrates `shuttle-{category}` descriptors are included in deterministic order.
- Test: `packages/engine/src/__tests__/materialization.test.ts` disabled-agent cases pass and demonstrate disabled declared agents and generated shuttles are excluded consistently with current runner behavior.
- Test: `packages/engine/src/__tests__/materialization.test.ts` no-adapter-dispatch case passes and demonstrates materialization does not call `HarnessAdapter.spawnSubagent()` or require adapter lifecycle methods.

#### 2.0 Tasks

- [ ] 2.1 Use `generateCategoryShuttles(config)` inside materialization instead of duplicating category shuttle generation logic.
- [ ] 2.2 Combine declared agents and generated category shuttles into one ordered agent list.
- [ ] 2.3 Preserve declared agent order from `config.agents` before generated category shuttle entries.
- [ ] 2.4 Sort or otherwise stabilize generated category shuttle ordering so repeated materialization produces the same order.
- [ ] 2.5 Skip agents listed in `config.disabled.agents`, matching current `WeaveRunner` behavior.
- [ ] 2.6 Call `composeAgentDescriptor(...)` for every included agent to produce composed descriptors.
- [ ] 2.7 Add tests for builtin agents, custom agents, category shuttles, disabled declared agents, disabled base shuttle behavior, and disabled specific generated shuttles.
- [ ] 2.8 Add a no-adapter-dispatch test that proves materialization can run without constructing a `HarnessAdapter` and never calls `spawnSubagent()`.

### [x] 3.0 Preserve typed failure behavior and composition compatibility

#### 3.0 Proof Artifact(s)

- Test: `packages/engine/src/__tests__/materialization.test.ts` category-shuttle-conflict case passes and demonstrates conflicts return a typed materialization error instead of throwing.
- Test: `packages/engine/src/__tests__/materialization.test.ts` prompt-composition-failure case passes and demonstrates the error identifies the affected agent.
- Test: `packages/engine/src/__tests__/materialization.test.ts` descriptor-compatibility case passes and demonstrates materialized descriptor fields match `composeAgentDescriptor(...)` behavior for representative agents.
- CLI: `bun test packages/engine/src/__tests__/materialization.test.ts` output demonstrates materialization tests pass in isolation.

#### 3.0 Tasks

- [ ] 3.1 Map `CategoryShuttleConflictError` from `generateCategoryShuttles(...)` into a `MaterializationError` variant without throwing.
- [ ] 3.2 Map `ComposeError` from `composeAgentDescriptor(...)` into a `MaterializationError` variant that includes the affected `agentName`.
- [ ] 3.3 Accumulate all descriptor composition failures into `plan.errors[]` rather than stopping on the first failure; encode this partial-by-default behavior in the output type and tests.
- [ ] 3.4 Add a category conflict test using an explicit `shuttle-frontend` agent plus a `frontend` category.
- [ ] 3.5 Add a prompt composition failure test using an agent with neither `prompt` nor `prompt_file`.
- [ ] 3.6 Add compatibility assertions that compare representative materialized descriptor fields with a direct `composeAgentDescriptor(...)` result.
- [ ] 3.7 Run `bun test packages/engine/src/__tests__/materialization.test.ts` and save the command output as the focused test proof artifact.

### [x] 4.0 Maintain runner compatibility and document adapter ownership

#### 4.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/runner.test.ts` passes and demonstrates existing `WeaveRunner.run()` behavior remains compatible.
- Test: `packages/engine/src/__tests__/runner.test.ts` call-order coverage passes and demonstrates `onEffect` still occurs before `spawnSubagent()` if runner internals are refactored.
- Documentation: `docs/adapter-boundary.md` diff documents the materialization API, engine-owned descriptor composition, and adapter-owned translation/materialization responsibilities after descriptors are returned.
- Code review artifact: repository diff demonstrates no new dependency on deprecated `registerHook()` or `loadSkill()` is introduced.

#### 4.0 Tasks

- [ ] 4.1 Evaluate whether `WeaveRunner.run()` can call the new materialization API without changing observable behavior.
- [ ] 4.2 If safe, refactor runner descriptor composition to use the materialization API while preserving adapter initialization, skill loading, `onEffect`, and `spawnSubagent()` ordering.
- [ ] 4.3 If not safe, leave runner behavior unchanged and document the follow-up reason in code comments or the task proof notes.
- [ ] 4.4 Preserve existing runner behavior for composition failures unless the spec explicitly requires a compatibility-safe change.
- [ ] 4.5 Add or update runner tests only as needed to prove `onEffect` still occurs before `spawnSubagent()` after any refactor.
- [ ] 4.6 Update `docs/adapter-boundary.md` with a section describing the materialization API data flow and adapter-owned responsibilities after descriptors are returned.
- [ ] 4.7 Verify the diff introduces no new usage of deprecated `registerHook()` or `loadSkill()`.
- [ ] 4.8 Run `bun test packages/engine/src/__tests__/runner.test.ts` and save the command output as the runner compatibility proof artifact.
