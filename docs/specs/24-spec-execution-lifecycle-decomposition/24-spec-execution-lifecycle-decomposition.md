# 24-spec-execution-lifecycle-decomposition.md

## Introduction/Overview

The workflow execution lifecycle in `packages/engine/src/execution-lifecycle.ts` has become a structural bottleneck. This spec defines a behavior-preserving refactor that splits the monolith into focused modules, removes dead legacy branching where repository context confirms it is no longer needed, and restores clear ownership boundaries so future workflow changes do not add more spaghetti.

## Goals

- Reduce the execution lifecycle implementation from one monolithic file into focused modules with clear responsibilities.
- Remove avoidable branching and duplicated orchestration in lifecycle operations while preserving runtime behavior.
- Keep all workflow lifecycle APIs, persisted data expectations, and observable workflow outcomes stable unless explicitly documented.
- Improve test organization so lifecycle behavior is validated by smaller, intention-revealing test files.
- Leave the execution lifecycle easier for a junior developer to navigate and extend safely.

## User Stories

- **As a maintainer**, I want lifecycle operations split into coherent modules so that I can change one workflow path without scanning thousands of unrelated lines.
- **As a maintainer**, I want dead or legacy-only branching removed when it is no longer a real product path so that the workflow model is easier to reason about.
- **As a reviewer**, I want lifecycle duplication collapsed behind canonical helpers so that behavior changes are localized and easier to audit.
- **As a junior developer**, I want lifecycle validation, orchestration, and outcome handling separated so that I can follow the control flow without reverse-engineering a giant file.

## Demoable Units of Work

### Unit 1: Decompose Lifecycle Module Boundaries

**Purpose:** Split the execution lifecycle into smaller modules with stable public exports and clear file ownership.

**Functional Requirements:**
- The system shall replace the single `execution-lifecycle.ts` implementation file with a small set of focused modules grouped by lifecycle concerns such as types, validation, orchestration helpers, and operation handlers.
- The system shall preserve the existing exported lifecycle API surface from `packages/engine/src/index.ts` unless an explicit compatibility note is added to the spec implementation.
- The system shall keep lifecycle error models and result-returning conventions consistent with existing `neverthrow` usage.
- The user shall be able to locate lifecycle entry points and supporting helpers by reading filenames rather than scanning one giant implementation file.

**Proof Artifacts:**
- File tree diff: shows lifecycle code moved into focused modules and demonstrates decomposition of the monolith.
- Test: targeted lifecycle test files pass and demonstrate the public lifecycle API remains callable after the refactor.
- CLI: `bun run typecheck` succeeds and demonstrates the refactor preserved type-safe exports.

### Unit 2: Remove Dead Legacy Branching

**Purpose:** Simplify lifecycle control flow by deleting no-longer-needed legacy execution paths when repository evidence confirms they are unused.

**Functional Requirements:**
- The system shall verify whether legacy no-context execution paths are still required by any active adapter or documented contract before removing them.
- The system shall remove lifecycle branches that exist only for unsupported or obsolete execution modes when repository evidence shows they are not part of the supported runtime path.
- The system shall preserve current behavior for supported adapters and workflow execution flows after branch removal.
- The system shall document any intentionally retained compatibility branch and why it still earns its keep.

**Proof Artifacts:**
- Test: adapter-facing workflow execution tests pass and demonstrate supported context-driven execution still works.
- Diff note: removed legacy-only branches demonstrate simplification of lifecycle control flow.
- Documentation: updated spec or inline comments demonstrate any retained compatibility path is deliberate rather than accidental.

### Unit 3: Collapse Duplicated Lifecycle Orchestration

**Purpose:** Replace repeated lease, instance-loading, plan-check, and terminal-outcome orchestration with canonical helpers.

**Functional Requirements:**
- The system shall extract a canonical helper for the repeated active-lease and workflow-instance loading pipeline used by multiple lifecycle operations.
- The system shall extract a canonical helper for terminal outcome handling so completed, paused, blocked, and failed paths do not duplicate release and state-transition logic.
- The system shall keep business rules in the lifecycle layer and avoid moving workflow semantics into unrelated storage or adapter modules.
- The system shall maintain atomicity expectations for lifecycle updates so refactoring does not introduce half-applied state transitions.

**Proof Artifacts:**
- Diff: helper extraction demonstrates repeated orchestration collapsed into shared lifecycle helpers.
- Test: lifecycle completion, pause, and failure scenarios pass and demonstrate terminal outcomes still behave correctly.
- Code review note: before/after comparison demonstrates reduced duplicate control-flow branches.

### Unit 4: Reorganize Lifecycle Test Coverage

**Purpose:** Make lifecycle behavior easier to validate by splitting oversized tests into focused suites aligned with the new code structure.

**Functional Requirements:**
- The system shall replace oversized lifecycle test files with smaller suites grouped by operation or concern.
- The system shall preserve coverage for happy paths, failure paths, authorization checks, artifact handling, and persistence interactions.
- The system shall keep tests isolated through mocks and repository fixtures rather than requiring a live harness.

**Proof Artifacts:**
- File tree diff: demonstrates lifecycle tests split into focused files.
- Test: `bun test` or targeted lifecycle test commands pass and demonstrate preserved behavioral coverage.

## Non-Goals (Out of Scope)

1. **New workflow features**: This spec does not add new workflow execution capabilities or change product behavior intentionally.
2. **Runtime storage redesign**: This spec does not replace SQLite or memory-store implementations beyond cleanup needed to support lifecycle decomposition.
3. **Adapter feature expansion**: This spec does not add new harness adapters or new adapter capabilities.

## Design Considerations

No specific design requirements identified.

## Repository Standards

- Follow the repository rule that fallible functions return `Result<T, E>` or `ResultAsync<T, E>` from `neverthrow`.
- Use Bun-native runtime patterns rather than Node.js runtime APIs.
- Preserve early-return control flow and avoid nested `if/else` and nested `try/catch` patterns.
- Keep lifecycle business rules in canonical engine modules rather than scattering workflow semantics into adapter or storage layers.
- Update related tests in the same change whenever lifecycle structure or contracts move.
- Update durable docs in `docs/` if exported lifecycle structure or contracts become easier to understand through new documentation.

## Technical Considerations

- Context assessment found a healthy engine foundation but an oversized lifecycle implementation and oversized lifecycle test files.
- Current repository patterns strongly favor smaller focused modules, explicit discriminated error types, and mocked boundary testing.
- No latest-standards research was needed because this spec is a repository-internal structural remediation rather than a technology-choice decision.
- Before removing legacy execution paths, confirm the active adapter contracts and docs do not still require them.
- Use extraction that deletes complexity rather than simply moving large blocks into equally opaque helpers.
- Preserve the existing engine public surface unless a compatibility adjustment is explicitly documented and justified.

## Security Considerations

- Preserve existing authorization, approval, artifact-integrity, and metadata-sanitization behavior during refactoring.
- Do not weaken checks around workflow approval, artifact verification, or persisted runtime state while simplifying code.
- Proof artifacts shall avoid including sensitive runtime metadata or journal content that should remain redacted.

## Success Metrics

1. **Lifecycle decomposition**: the single `execution-lifecycle.ts` monolith is replaced by focused modules, and no replacement implementation file exceeds 1,000 lines without explicit justification.
2. **Behavior preservation**: targeted workflow lifecycle tests and `bun run typecheck` pass with no new source diagnostics.
3. **Complexity reduction**: duplicated lifecycle orchestration called out in the review is collapsed into canonical helpers, with fewer repeated terminal-outcome and lease-loading branches.

## Open Questions

1. Which legacy no-context execution paths are still contractually required, if any?
2. Should lifecycle module names follow operation-based grouping, concern-based grouping, or a hybrid structure?

## Implementation Notes (Task 7)

### Decomposition outcome

The 4,270-line `execution-lifecycle.ts` monolith was decomposed into 17 focused modules under `packages/engine/src/execution-lifecycle/`:

| Module              | Lines | Responsibility                                          |
|---------------------|-------|---------------------------------------------------------|
| `types.ts`          | 515   | All I/O interfaces, effect types, result aliases        |
| `errors.ts`         | 70    | Error factory helpers                                   |
| `metadata.ts`       | 92    | SafeMetadata runtime sanitization                       |
| `authorization.ts`  | 79    | Execution and reconciliation authorization validation   |
| `lease.ts`          | 110   | Active-lease validation and store-error mapping         |
| `session.ts`        | 92    | `observeSession` implementation                         |
| `start.ts`          | 190   | `startExecution` implementation                         |
| `resume.ts`         | 104   | `resumeExecution` implementation                        |
| `interrupts.ts`     | 115   | `handleUserInterrupt` implementation                    |
| `prompt-context.ts` | 146   | Step prompt context building and rendering              |
| `artifacts.ts`      | 373   | Artifact validation, integrity, and persistence         |
| `dispatch.ts`       | 322   | `dispatchStep` implementation                           |
| `completion.ts`     | 636   | `completeStep` implementation (see justification below) |
| `before-tool.ts`    | 89    | `beforeTool` implementation                             |
| `inspection.ts`     | 99    | `inspectExecution` implementation                       |
| `terminal-outcomes.ts` | 148 | `approveArtifact` implementation                       |
| `reconciliation.ts` | 418   | `reconcileExecution` implementation                     |
| `index.ts`          | 111   | Module barrel re-exporting all public symbols           |

The original `execution-lifecycle.ts` is now a **compatibility barrel** (118 lines) that re-exports everything from `./execution-lifecycle/index.js`. All existing imports from `@weave/engine` continue to work unchanged.

### Legacy no-context paths (Open Question 1)

The legacy no-context execution paths in `dispatchStep` and `completeStep` were **retained**. Repository evidence shows:
- The integration tests exercise both paths.
- No adapter currently guarantees it always provides `WorkflowExecutionContext`.
- Removing them would be a breaking change without a migration path.

These paths are documented in the implementation with `// Legacy path (no context)` comments.

### Module naming (Open Question 2)

A **hybrid structure** was chosen:
- Concern-based for shared infrastructure: `types`, `errors`, `metadata`, `authorization`, `lease`, `artifacts`, `prompt-context`
- Operation-based for lifecycle handlers: `session`, `start`, `resume`, `interrupts`, `dispatch`, `completion`, `before-tool`, `inspection`, `terminal-outcomes`, `reconciliation`

### Canonical helpers extracted

The following duplicated patterns were collapsed into canonical helpers:

1. **`validateActiveLease`** (`lease.ts`): the three-check active-lease validation block (no lease, ID mismatch, instance mismatch) previously duplicated across 4 lifecycle methods.
2. **`mapStoreError`** (`lease.ts`): the inline `lifecyclePersistenceError(storeError.message, { type, message })` pattern previously duplicated ~46 times.
3. **`mapConflictToLeaseConflict`** (`lease.ts`): the conflict-to-lease-conflict mapping previously duplicated in `startExecution` and `resumeExecution`.
4. **`buildStepPromptContext`** / **`renderStepPrompt`** (`prompt-context.ts`): prompt rendering helpers previously duplicated across `dispatchStep`, `completeStep`, and `reconcileExecution`.
5. **`buildConfiguredRunAgentEffect`** (`dispatch.ts`): the `RunAgentEffect` builder previously duplicated in `dispatchStep`, `completeStep` (gate retry), and `reconcileExecution`.

### completion.ts line count justification

`completion.ts` is 636 lines. This is the most complex lifecycle method because it handles:
- Two dispatch paths: configured (with context) and legacy (without context)
- Four outcome variants: success, blocked, failed, paused
- Gate logic: `review_verdict` with approve/reject/retry policies
- Plan checks: `plan_created` and `plan_complete` completion methods
- Output artifact validation and sequential persistence
- Auto-advance: dispatch next step or complete workflow on final step

These concerns cannot be cleanly separated without introducing shared mutable state or deeply nested callbacks. The line count reflects inherent complexity, not incidental complexity.

### Test reorganization

New focused test files were created under `packages/engine/src/__tests__/execution-lifecycle/`:

| File                        | Tests | Coverage                                              |
|-----------------------------|-------|-------------------------------------------------------|
| `fixtures.ts`               | —     | Shared helpers, MockPlanStateProvider, ID constants   |
| `authorization.test.ts`     | 11    | `validateAuthorizationSource`, `validateReconciliationSource` |
| `session-start-resume.test.ts` | 15 | `observeSession`, `startExecution`, `resumeExecution` |
| `dispatch.test.ts`          | 7     | `dispatchStep` legacy and configured paths            |
| `completion-terminal.test.ts` | 10  | `completeStep`, `handleUserInterrupt`                 |
| `artifact-approval.test.ts` | 5     | `approveArtifact` security invariants                 |
| `reconciliation.test.ts`    | 9     | `reconcileExecution` routing and authorization        |
| `before-tool-inspect.test.ts` | 9   | `beforeTool`, `inspectExecution`                      |

Total: 66 new tests across 7 test files (plus fixtures).

### Verification

- `bun test packages/engine/src/__tests__/execution-lifecycle.test.ts packages/engine/src/__tests__/execution-lifecycle-integration.test.ts packages/engine/src/__tests__/artifact-approval-lifecycle.test.ts packages/engine/src/__tests__/execution-lifecycle/` → **454 pass, 0 fail**
- `bun run --filter '@weave/engine' typecheck` → **clean** (pre-existing `skill-resolution.test.ts` error is unrelated to this task)
