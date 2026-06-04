# Coordinated Five-Spec Remediation Program

## TL;DR
> **Summary**: Execute specs 24-28 as one remediation program: stabilize CLI typecheck first, settle DSL/adapter seams before lifecycle decomposition, run CLI cleanup in parallel where safe, then complete documentation information architecture repair after code contracts are final.
> **Estimated Effort**: XL

## Context
### Original Request
Create exactly one coordinated `/start-work` plan that synthesizes these approved remediation specs:

- `docs/specs/24-spec-execution-lifecycle-decomposition/24-spec-execution-lifecycle-decomposition.md`
- `docs/specs/25-spec-cli-init-and-migration-decomposition/25-spec-cli-init-and-migration-decomposition.md`
- `docs/specs/26-spec-opencode-adapter-boundary-cleanup/26-spec-opencode-adapter-boundary-cleanup.md`
- `docs/specs/27-spec-dsl-model-and-schema-cleanup/27-spec-dsl-model-and-schema-cleanup.md`
- `docs/specs/28-spec-documentation-information-architecture-repair/28-spec-documentation-information-architecture-repair.md`

### Key Findings
- Spec 24 targets `packages/engine/src/execution-lifecycle.ts`, currently a large lifecycle monolith with validation, metadata sanitization, step dispatch, completion, artifact approval, reconciliation, and inspection logic in one file.
- Spec 25 targets `packages/cli/src/commands/init.ts`, currently combining init orchestration, migration orchestration, legacy JSONC conversion, write safety, and rendering in one oversized command file.
- Spec 26 targets two seams: `OpenCodeAdapter.spawnSubagent()` currently throws through a `Promise<void>` interface and call sites wrap thrown failures, while `packages/cli/src/commands/runtime.ts` duplicates the engine runtime sanitizer denylist.
- Spec 27 targets `extend_before_plan` model drift and repeated prompt-path refinements in `packages/core/src/schema.ts`; parser, validator, schema, and end-to-end tests must move together.
- Spec 28 targets documentation navigation: missing `docs/README.md`, missing `docs/specs/README.md`, dead spec links such as missing Specs 02/03/04/05/06, no durable DSL reference under `docs/`, and unclear handling for proof/audit/checklist artifacts.
- Dependency order matters: Spec 27 should land before lifecycle reconciliation cleanup, and Spec 26 should land before engine lifecycle tests are reorganized around the adapter seam.

### Scope
- Coordinate behavior-preserving structural remediation for specs 24-28.
- Allow only contract corrections explicitly required by the approved specs, especially `extend_before_plan` coherence and typed adapter spawn results.
- Prefer small, reviewable commits by workstream, with validation gates after each major seam change.

### Parallelizable Workstreams
| Workstream | Primary Spec | Primary Paths | Can Run In Parallel With | Must Wait For |
| --- | --- | --- | --- | --- |
| A — DSL/schema cleanup | 27 | `packages/core/src/**` | CLI decomposition after baseline, docs skeleton | Decision gate |
| B — Adapter boundary/redaction | 26 | `packages/engine/src/adapter.ts`, `packages/adapters/opencode/src/**`, `packages/cli/src/commands/runtime.ts` | DSL cleanup, CLI decomposition | Decision gate |
| C — CLI init/migration cleanup | 25 | `packages/cli/src/commands/init.ts`, `packages/cli/src/migration/**` | DSL cleanup, adapter cleanup | CLI compile baseline |
| D — Lifecycle decomposition | 24 | `packages/engine/src/execution-lifecycle.ts`, `packages/engine/src/execution-lifecycle/**` | Docs finalization only after stable milestones | DSL cleanup and adapter boundary cleanup |
| E — Documentation IA repair | 28 | `docs/**`, `AGENTS.md` | Skeleton can start early; final content waits | Final code contracts for DSL/adapter/lifecycle |

### Recommended Execution Order to Minimize Merge Conflicts
1. Baseline and decision gate.
2. Restore CLI typecheck baseline before broader changes.
3. Start docs IA skeleton and artifact policy without rewriting code-contract prose yet.
4. Run DSL/schema cleanup and adapter boundary cleanup in parallel.
5. Run CLI init/migration decomposition in parallel after the CLI baseline is green.
6. Run execution lifecycle decomposition after DSL and adapter seams are stable.
7. Finalize docs references, DSL reference, lifecycle/adapter notes, link repair, and full validation.

## Objectives
### Core Objective
Deliver one coordinated remediation program that reduces structural complexity, restores type/test confidence, aligns the DSL model with supported grammar, enforces canonical adapter/redaction boundaries, and repairs documentation navigation without creating avoidable cross-workstream conflicts.

### Deliverables
- [ ] Spec 24 lifecycle decomposition with focused modules, preserved public exports, collapsed duplicated orchestration, and split lifecycle tests.
- [ ] Spec 25 CLI init/migration decomposition with green CLI typecheck, separated conversion/migration/init modules, and migration safety parity.
- [ ] Spec 26 adapter boundary cleanup with typed OpenCode spawn result composition and canonical engine-owned sensitive-key redaction.
- [ ] Spec 27 DSL model/schema cleanup with one coherent `extend before-plan` contract and shared prompt schema refinements.
- [ ] Spec 28 documentation IA repair with docs/spec indexes, canonical DSL reference, artifact policy, corrected conventions, and repaired durable dead links.
- [ ] One final validation pass covering targeted tests, package typechecks, root typecheck, root tests, build, docs link review, and review notes.

### Definition of Done
- [ ] `bun run typecheck` passes from the repository root.
- [ ] `bun test` passes from the repository root.
- [ ] `bun run build` passes from the repository root.
- [ ] Targeted core, engine, CLI, adapter, and runtime tests pass at the workstream gates listed below.
- [ ] Documentation entry points and canonical DSL reference are reachable from `docs/README.md`, `docs/specs/README.md`, and `AGENTS.md`.
- [ ] No replacement lifecycle implementation file exceeds 1,000 lines without a written justification in the relevant docs or review notes.
- [ ] Runtime redaction behavior remains at least as strict as before; sensitive fields are not exposed in CLI runtime journal output.
- [ ] Parser, schema, validator, and parse-config tests all agree on the final `extend before-plan` model.

### Guardrails (Must NOT)
- Do not add new workflow execution features beyond contract corrections required by the five specs.
- Do not remove supported legacy CLI migration input formats unless a separate deprecation decision is recorded.
- Do not weaken prompt path safety, artifact integrity checks, approval checks, authorization checks, lease handling, or runtime redaction.
- Do not replace direct, readable code with opaque generic wrappers just to reduce line count.
- Do not move workflow semantics into adapters or storage modules; lifecycle business rules stay in engine lifecycle modules.
- Do not use Node runtime APIs; keep Bun-native runtime practices and repository `neverthrow` conventions.
- Do not mass-delete historical proof artifacts before the documentation artifact retention policy is written and accepted.

### Open Decisions / Risks to Capture During Execution
- [ ] Decide and record the `extend before-plan` path: recommended default is simplification to the currently expressible default bucket rather than grammar expansion for named workflow targets.
- [ ] Decide lifecycle module grouping: recommended default is a hybrid concern/operation structure under `packages/engine/src/execution-lifecycle/` with `packages/engine/src/execution-lifecycle.ts` kept as the compatibility barrel.
- [ ] Decide CLI migration module ownership: recommended default is command entrypoint in `packages/cli/src/commands/migrate.ts` and reusable support under `packages/cli/src/migration/`.
- [ ] Decide redaction helper export path: recommended default is an engine-owned runtime helper exported through `@weave/engine` for CLI use.
- [ ] Decide docs IA convention: recommended default is no forced per-spec `index.md` migration in this remediation; instead use `docs/specs/README.md` as canonical ordering and keep existing numbered spec filenames.
- [ ] Decide proof artifact retention: recommended default is reclassify existing proof/audit/task/validation files as non-normative historical artifacts first, then move only misplaced durable-doc clutter if necessary.
- [ ] Watch for broad `HarnessAdapter.spawnSubagent()` signature fallout; keep the change minimal and update mocks/tests in the same commit.

## TODOs

- [x] 1. Establish Baseline, Decisions, and Workstream Guardrails
  **What**: Start with a clean baseline and record the decisions above before code movement. Capture the chosen defaults in a short ADR/review note so downstream docs and code changes do not diverge.
  **Files**: `docs/adr/0005-five-spec-remediation-decisions.md`, `docs/specs/24-spec-execution-lifecycle-decomposition/24-spec-execution-lifecycle-decomposition.md`, `docs/specs/25-spec-cli-init-and-migration-decomposition/25-spec-cli-init-and-migration-decomposition.md`, `docs/specs/26-spec-opencode-adapter-boundary-cleanup/26-spec-opencode-adapter-boundary-cleanup.md`, `docs/specs/27-spec-dsl-model-and-schema-cleanup/27-spec-dsl-model-and-schema-cleanup.md`, `docs/specs/28-spec-documentation-information-architecture-repair/28-spec-documentation-information-architecture-repair.md`
  **Milestones**:
  - [ ] Record current `bun run typecheck` and `bun test` baseline results before changes.
  - [ ] Record accepted defaults for the six open decisions in `docs/adr/0005-five-spec-remediation-decisions.md`.
  - [ ] Confirm code movement workstreams use separate commits/PR sections by spec to keep review and revert paths small.
  **Acceptance**: Reviewers can read the ADR and know which branch of each ambiguous spec is being implemented before source changes begin.

- [x] 2. Restore CLI Typecheck Baseline Before Structural Work
  **What**: Fix the immediate duplicated/invalid validation block in `init.ts` without broad refactoring, so subsequent decomposition starts from a compiling CLI baseline.
  **Files**: `packages/cli/src/commands/init.ts`, `packages/cli/src/commands/__tests__/migrate.test.ts`, `packages/cli/src/commands/__tests__/migrate-conversion.test.ts`
  **Milestones**:
  - [ ] Remove or correct duplicated migration validation code directly, without casts or ignored diagnostics.
  - [ ] Preserve existing migration validation behavior through focused tests.
  - [ ] Run the CLI package typecheck before starting module extraction.
  **Acceptance**: `bun run --filter '@weave/cli' typecheck` passes, and migration tests covering validation-before-write still pass.

- [x] 3. Create Documentation IA Skeleton and Artifact Policy Checkpoint
  **What**: Start Spec 28 with low-conflict navigation scaffolding and policy language, but defer final DSL/lifecycle/adapter prose until the code contracts settle.
  **Files**: `docs/README.md`, `docs/specs/README.md`, `docs/documentation-policy.md`, `docs/artifacts/README.md`, `AGENTS.md`, `docs/adapter-boundary.md`, `docs/product-vision.md`, `docs/cli.md`, `docs/config-loading.md`, `docs/model-resolution.md`, `docs/workflow-schema.md`
  **Milestones**:
  - [ ] Add `docs/README.md` as the top-level documentation entry point.
  - [ ] Add `docs/specs/README.md` listing current specs in canonical order, including specs 24-28.
  - [ ] Add documentation artifact policy that classifies specs/guides/ADRs as durable and proof/audit/task/validation files as non-normative historical or validation artifacts.
  - [ ] Repair durable dead links known from the review: missing Specs 02, 03, 04, 05, and 06 references should point to current guides/specs or be removed.
  - [ ] Update `AGENTS.md` docs-structure guidance so it no longer mandates missing per-spec `index.md` files unless that convention is deliberately restored.
  **Acceptance**: A reader can navigate from `docs/README.md` to guides, ADRs, specs, and artifact policy without hitting the known durable dead links.

- [x] 4. Complete Spec 27 DSL Model and Schema Cleanup
  **What**: Align `extend_before_plan` with the actual grammar, remove phantom workflow targeting/fallback behavior, centralize prompt path/refinement invariants, and synchronize tests at every schema layer.
  **Files**: `packages/core/src/ast.ts`, `packages/core/src/parser.ts`, `packages/core/src/schema.ts`, `packages/core/src/prompt-schema-helpers.ts`, `packages/core/src/validate.ts`, `packages/core/src/config.ts`, `packages/core/src/__tests__/schema.test.ts`, `packages/core/src/__tests__/parser.test.ts`, `packages/core/src/__tests__/validate.test.ts`, `packages/core/src/__tests__/parse_config.test.ts`, `docs/dsl-reference.md`, `docs/workflow-schema.md`, `docs/specs/27-spec-dsl-model-and-schema-cleanup/27-spec-dsl-model-and-schema-cleanup.md`
  **Milestones**:
  - [ ] Implement exactly one `extend before-plan` model; recommended default is simplify to `extend_before_plan.steps` and remove unsupported optional workflow targeting from AST/schema/validator comments and tests.
  - [ ] If the decision gate chooses grammar expansion instead, add real parser syntax, validation, parse-config tests, and DSL docs before proceeding.
  - [ ] Extract shared prompt path safety and prompt/prompt-file mutual-exclusivity helpers into `packages/core/src/prompt-schema-helpers.ts`.
  - [ ] Reuse prompt schema helpers across agent, category, workflow step, and workflow config schemas without weakening path traversal protection.
  - [ ] Remove unnecessary discriminated-union casts in validator branches where TypeScript already narrows.
  - [ ] Update `docs/dsl-reference.md` and `docs/workflow-schema.md` to explain the final `extend before-plan` contract.
  **Acceptance**: `bun test packages/core/src/__tests__/schema.test.ts packages/core/src/__tests__/parser.test.ts packages/core/src/__tests__/validate.test.ts packages/core/src/__tests__/parse_config.test.ts` passes, and `bun run --filter '@weave/core' typecheck` passes.

- [x] 5. Complete Spec 26 Adapter Boundary and Redaction Cleanup
  **What**: Convert the OpenCode spawn seam and related harness adapter interface usage to typed result composition, then make CLI runtime journal rendering use the engine's canonical sensitive-key policy.
  **Files**: `packages/engine/src/adapter.ts`, `packages/engine/src/index.ts`, `packages/engine/src/runtime/sanitizer.ts`, `packages/engine/src/__tests__/mock-adapter.ts`, `packages/engine/src/__tests__/materialization-orchestration.test.ts`, `packages/engine/src/__tests__/execution-lifecycle-integration.test.ts`, `packages/adapters/opencode/src/adapter.ts`, `packages/adapters/opencode/src/plugin.ts`, `packages/adapters/opencode/src/run-workflow.ts`, `packages/adapters/opencode/src/__tests__/adapter.test.ts`, `packages/adapters/opencode/src/__tests__/plugin.test.ts`, `packages/adapters/opencode/src/__tests__/run-workflow.test.ts`, `packages/cli/src/commands/runtime.ts`, `packages/cli/src/commands/__tests__/runtime.test.ts`, `docs/adapter-boundary.md`, `docs/adr/0005-five-spec-remediation-decisions.md`
  **Milestones**:
  - [ ] Change `OpenCodeAdapter.spawnSubagent()` to return a typed `ResultAsync<void, OpenCodeAdapterError>` or the minimal equivalent adapter-facing typed result.
  - [ ] Update `HarnessAdapter` and mock adapter surfaces only as much as required for the typed spawn seam.
  - [ ] Remove call-site wrappers in `plugin.ts` and `run-workflow.ts` whose only purpose is converting thrown spawn failures to results.
  - [ ] Preserve OpenCode policy checks, reconcile behavior, translation behavior, collision handling, and error discrimination.
  - [ ] Export an engine-owned denied-key helper from `packages/engine/src/runtime/sanitizer.ts` and import it in `packages/cli/src/commands/runtime.ts`.
  - [ ] Keep runtime tests proving sensitive fields remain absent from journal output.
  **Acceptance**: `bun test packages/adapters/opencode/src/__tests__/adapter.test.ts packages/adapters/opencode/src/__tests__/plugin.test.ts packages/adapters/opencode/src/__tests__/run-workflow.test.ts packages/cli/src/commands/__tests__/runtime.test.ts` passes, and `bun run typecheck` reaches no new adapter/redaction diagnostics.

- [x] 6. Complete Spec 25 CLI Init/Migration Decomposition
  **What**: Split CLI init, migration orchestration, legacy JSONC conversion, warnings, migration planning, and write safety into intention-revealing modules while preserving user-facing behavior.
  **Files**: `packages/cli/src/commands/init.ts`, `packages/cli/src/commands/migrate.ts`, `packages/cli/src/cli.ts`, `packages/cli/src/migration/types.ts`, `packages/cli/src/migration/legacy-jsonc-converter.ts`, `packages/cli/src/migration/conversion-warnings.ts`, `packages/cli/src/migration/migration-plan.ts`, `packages/cli/src/migration/migration-write.ts`, `packages/cli/src/commands/__tests__/init.test.ts`, `packages/cli/src/commands/__tests__/migrate.test.ts`, `packages/cli/src/commands/__tests__/migrate-conversion.test.ts`, `docs/cli.md`, `docs/specs/25-spec-cli-init-and-migration-decomposition/25-spec-cli-init-and-migration-decomposition.md`
  **Milestones**:
  - [ ] Move `weave init migrate` orchestration into `packages/cli/src/commands/migrate.ts` while keeping `weave init` routing behavior stable.
  - [ ] Move JSONC stripping and legacy-to-DSL conversion into `packages/cli/src/migration/legacy-jsonc-converter.ts`.
  - [ ] Move conversion warning rendering/building into `packages/cli/src/migration/conversion-warnings.ts`.
  - [ ] Move migration source/destination planning and canonical scope paths into `packages/cli/src/migration/migration-plan.ts`.
  - [ ] Move read-check-write-validate-render orchestration into `packages/cli/src/migration/migration-write.ts`.
  - [ ] Keep `init.ts` focused on init planning, prompts, scaffold generation, harness installation, and summary rendering.
  - [ ] Preserve destination existence checks, validation-before-write, backup behavior, unsupported-field warnings, generated DSL shape, and help text.
  **Acceptance**: `bun test packages/cli/src/commands/__tests__/init.test.ts packages/cli/src/commands/__tests__/migrate.test.ts packages/cli/src/commands/__tests__/migrate-conversion.test.ts` passes, `bun run --filter '@weave/cli' typecheck` passes, and `packages/cli/src/commands/init.ts` is below 1,000 lines.

- [x] 7. Complete Spec 24 Execution Lifecycle Decomposition
  **What**: Decompose `execution-lifecycle.ts` into focused lifecycle modules after Spec 27 and Spec 26 settle shared contracts. Preserve root exports through a compatibility barrel and collapse duplicated lease/instance/terminal-outcome orchestration into canonical helpers.
  **Files**: `packages/engine/src/execution-lifecycle.ts`, `packages/engine/src/execution-lifecycle/types.ts`, `packages/engine/src/execution-lifecycle/errors.ts`, `packages/engine/src/execution-lifecycle/metadata.ts`, `packages/engine/src/execution-lifecycle/authorization.ts`, `packages/engine/src/execution-lifecycle/lease.ts`, `packages/engine/src/execution-lifecycle/session.ts`, `packages/engine/src/execution-lifecycle/start.ts`, `packages/engine/src/execution-lifecycle/dispatch.ts`, `packages/engine/src/execution-lifecycle/prompt-context.ts`, `packages/engine/src/execution-lifecycle/completion.ts`, `packages/engine/src/execution-lifecycle/artifacts.ts`, `packages/engine/src/execution-lifecycle/terminal-outcomes.ts`, `packages/engine/src/execution-lifecycle/resume.ts`, `packages/engine/src/execution-lifecycle/interrupts.ts`, `packages/engine/src/execution-lifecycle/before-tool.ts`, `packages/engine/src/execution-lifecycle/inspection.ts`, `packages/engine/src/execution-lifecycle/reconciliation.ts`, `packages/engine/src/index.ts`, `packages/engine/src/__tests__/execution-lifecycle.test.ts`, `packages/engine/src/__tests__/execution-lifecycle-integration.test.ts`, `packages/engine/src/__tests__/artifact-approval-lifecycle.test.ts`, `packages/engine/src/__tests__/execution-lifecycle/fixtures.ts`, `packages/engine/src/__tests__/execution-lifecycle/authorization.test.ts`, `packages/engine/src/__tests__/execution-lifecycle/session-start-resume.test.ts`, `packages/engine/src/__tests__/execution-lifecycle/dispatch.test.ts`, `packages/engine/src/__tests__/execution-lifecycle/completion-terminal.test.ts`, `packages/engine/src/__tests__/execution-lifecycle/artifact-approval.test.ts`, `packages/engine/src/__tests__/execution-lifecycle/reconciliation.test.ts`, `packages/engine/src/__tests__/execution-lifecycle/before-tool-inspect.test.ts`, `docs/adapter-boundary.md`, `docs/workflow-schema.md`, `docs/specs/24-spec-execution-lifecycle-decomposition/24-spec-execution-lifecycle-decomposition.md`
  **Milestones**:
  - [ ] Keep `packages/engine/src/execution-lifecycle.ts` as the stable public export surface while moving implementation to focused modules.
  - [ ] Move lifecycle types/effects/inputs/results to `types.ts` and errors/factories to `errors.ts`.
  - [ ] Move metadata sanitization to `metadata.ts` unless Spec 26 fully centralizes it under runtime sanitizer; do not duplicate sensitive-key policy.
  - [ ] Move authorization-source validation to `authorization.ts`.
  - [ ] Extract canonical active-lease and workflow-instance loading helpers into `lease.ts`.
  - [ ] Extract terminal release/state-transition handling into `terminal-outcomes.ts`.
  - [ ] Split operation handlers by concern: observe/start/resume/interrupt/dispatch/complete/before-tool/approve/inspect/reconcile.
  - [ ] Verify whether legacy no-context paths are still required; delete unsupported paths or document any retained branch in code/docs.
  - [ ] Reorganize lifecycle tests into focused suites under `packages/engine/src/__tests__/execution-lifecycle/` while preserving integration coverage.
  **Acceptance**: `bun test packages/engine/src/__tests__/execution-lifecycle.test.ts packages/engine/src/__tests__/execution-lifecycle-integration.test.ts packages/engine/src/__tests__/artifact-approval-lifecycle.test.ts packages/engine/src/__tests__/execution-lifecycle` passes, `bun run --filter '@weave/engine' typecheck` passes, and no lifecycle implementation module exceeds 1,000 lines without documented justification.

- [x] 8. Finalize Documentation IA and Cross-Link All Remediation Outcomes
  **What**: Complete Spec 28 after code contracts are final. Ensure docs point to canonical DSL, lifecycle, adapter, CLI, and artifact policy references instead of duplicating or linking to deleted spec files.
  **Files**: `docs/README.md`, `docs/specs/README.md`, `docs/dsl-reference.md`, `docs/documentation-policy.md`, `docs/artifacts/README.md`, `AGENTS.md`, `docs/adapter-boundary.md`, `docs/product-vision.md`, `docs/cli.md`, `docs/config-loading.md`, `docs/model-resolution.md`, `docs/workflow-schema.md`, `docs/prompt-composition.md`, `docs/specs/24-spec-execution-lifecycle-decomposition/24-spec-execution-lifecycle-decomposition.md`, `docs/specs/25-spec-cli-init-and-migration-decomposition/25-spec-cli-init-and-migration-decomposition.md`, `docs/specs/26-spec-opencode-adapter-boundary-cleanup/26-spec-opencode-adapter-boundary-cleanup.md`, `docs/specs/27-spec-dsl-model-and-schema-cleanup/27-spec-dsl-model-and-schema-cleanup.md`, `docs/specs/28-spec-documentation-information-architecture-repair/28-spec-documentation-information-architecture-repair.md`
  **Milestones**:
  - [ ] Finalize `docs/dsl-reference.md` as the durable `.weave` DSL source of truth and link it from `AGENTS.md`.
  - [ ] Ensure docs describe the final `extend before-plan` model chosen in Spec 27.
  - [ ] Ensure adapter docs describe the typed spawn seam and engine-owned redaction helper without implying adapters own sanitizer policy.
  - [ ] Ensure CLI docs describe the migration command structure and safety behavior at user-facing level only.
  - [ ] Ensure lifecycle docs explain the public execution surface and module ownership without leaking internal implementation noise.
  - [ ] Ensure `docs/specs/README.md` distinguishes current normative specs from historical proof/audit/task/validation artifacts.
  - [ ] Repair or explicitly retire durable dead links to missing Specs 02, 03, 04, 05, and 06.
  **Acceptance**: Manual link review over durable docs finds no known dead links, and a contributor can reach DSL, CLI, adapter boundary, workflow lifecycle, and spec index docs from `docs/README.md`.

- [x] 9. Run Program-Level Validation Gate and Prepare Review Notes
  **What**: Run final gates after all workstreams land, then capture review notes that map changed files back to specs 24-28.
  **Milestones**:
  - [ ] Run `bun run typecheck` from the repository root.
  - [ ] Run `bun test` from the repository root.
  - [ ] Run `bun run build` from the repository root.
  - [ ] Run targeted core/schema tests listed in Task 4.
  - [ ] Run targeted adapter/runtime tests listed in Task 5.
  - [ ] Run targeted CLI tests listed in Task 6.
  - [ ] Run targeted lifecycle tests listed in Task 7.
  - [ ] Run `bun run lint` if the code movement touches formatting-sensitive areas.
  - [ ] Verify `packages/engine/src/execution-lifecycle.ts` is a compatibility barrel or small facade, not a new monolith.
  - [ ] Verify `packages/cli/src/commands/init.ts` is below 1,000 lines.
  - [ ] Verify no local sensitive-key denylist remains in `packages/cli/src/commands/runtime.ts`.
  - [ ] Verify documentation checkpoints from Task 8 are complete.
  **Acceptance**: Full validation is green or every remaining failure is documented with owner, reason, and next action before review.

## Verification
- [ ] All tests pass: `bun test`.
- [ ] Typecheck passes: `bun run typecheck`.
- [ ] Build passes: `bun run build`.
- [ ] CLI focused checks pass: `bun run --filter '@weave/cli' typecheck` and targeted init/migrate/runtime tests.
- [ ] Core focused checks pass: `bun run --filter '@weave/core' typecheck` and schema/parser/validate/parse-config tests.
- [ ] Engine focused checks pass: `bun run --filter '@weave/engine' typecheck` and lifecycle/materialization tests.
- [ ] OpenCode adapter focused checks pass: targeted adapter/plugin/run-workflow tests.
- [ ] Docs checkpoints pass: `docs/README.md`, `docs/specs/README.md`, `docs/dsl-reference.md`, `docs/documentation-policy.md`, and `AGENTS.md` agree on docs conventions.
- [ ] Link review passes for durable docs; historical proof artifacts are either linked correctly or covered by the non-normative artifact policy.
- [ ] Review notes include spec-by-spec milestone evidence for Specs 24, 25, 26, 27, and 28.
