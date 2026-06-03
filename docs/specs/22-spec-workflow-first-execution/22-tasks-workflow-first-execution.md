## Relevant Files

| File | Why It Is Relevant |
| --- | --- |
| `packages/core/src/schema.ts` | Defines the `.weave` DSL schema that must add workflow execution, extension-point, artifact, and prompt-append fields. |
| `packages/core/src/validate.ts` | Translates parsed workflow DSL into validated config and enforces planning-step and extension-point invariants. |
| `packages/core/src/__tests__/schema.test.ts` | Schema acceptance/rejection coverage for new workflow-first DSL fields. |
| `packages/core/src/__tests__/validate.test.ts` | Validation coverage for planning-step roles, handler declarations, artifact inputs, and prompt-append rules. |
| `packages/core/src/__tests__/parse_config.test.ts` | End-to-end config parsing coverage for the new DSL surface. |
| `packages/config/src/builtins.ts` | Houses builtin workflows and default plan-oriented workflow definitions. |
| `packages/config/src/merge.ts` | Preserves config-merge ownership of `extends` / `insert_before` / `insert_after` while leaving `before-plan` as an engine-visible contract post-merge. |
| `packages/config/src/__tests__/merge.test.ts` | Verifies merge behavior stays stable while selected workflows publish `before-plan`. |
| `packages/engine/src/execution-lifecycle.ts` | Main runtime surface for explicit start/resume/pause/dispatch/reconciliation behavior and artifact consumption checks. |
| `packages/engine/src/runtime/types.ts` | Runtime record types for workflow artifacts, revisions, approvals, and provenance. |
| `packages/engine/src/runtime/store.ts` | Runtime store interfaces for persisting artifact approval and provenance metadata. |
| `packages/engine/src/runtime/sqlite/schema.ts` | SQLite persistence schema changes for artifact identity, revision, approval, and integrity-verification metadata. |
| `packages/engine/src/capability-contract.ts` | Existing readiness vocabulary and capability IDs for canonical execution command support. |
| `packages/engine/src/template-renderer.ts` | Prompt append composition and bounded template rendering behavior. |
| `packages/engine/src/__tests__/execution-lifecycle.test.ts` | Primary runtime behavior tests for execution boundary, provenance, reconciliation, and fail-closed checks. |
| `packages/engine/src/__tests__/runtime-memory.test.ts` | In-memory runtime persistence coverage for artifact identity/revision/approval behavior. |
| `packages/engine/src/__tests__/runtime-sqlite.test.ts` | SQLite-backed runtime persistence coverage for artifact identity/revision/integrity behavior. |
| `packages/engine/src/__tests__/capability-contract.test.ts` | Capability ID/readiness coverage for execution-command support. |
| `packages/engine/src/__tests__/capability-readiness.test.ts` | Readiness-profile behavior for command and non-command delivery paths. |
| `packages/engine/src/__tests__/template-renderer.test.ts` | Prompt append precedence, trust boundaries, and bounded-template rendering coverage. |
| `packages/adapters/opencode/src/run-workflow.ts` | OpenCode adapter delivery path for explicit workflow start/resume behavior. |
| `packages/adapters/opencode/src/__tests__/run-workflow.test.ts` | Confirms OpenCode starts workflow execution only from explicit user-driven delivery paths. |
| `docs/workflow-schema.md` | Human-facing DSL documentation for planning steps, extension points, artifact inputs, and prompt appends. |
| `docs/adapter-boundary.md` | Must stay aligned with engine-owned semantics and sanctioned integrity-verification metadata. |
| `docs/adapter-readiness-status.md` | Documents readiness outcomes for command and non-command harness delivery. |
| `CONTEXT.md` | Canonical glossary for workflow-first execution, artifact, and readiness vocabulary. |
| `docs/adr/0004-workflow-first-execution-contract.md` | Companion ADR proof artifact for the workflow-first execution model. |
| `docs/specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md` | Source specification for requirement traceability. |
| `docs/specs/22-spec-workflow-first-execution/22-tasks-workflow-first-execution.md` | Task file being updated with sub-tasks and relevant files. |
| `docs/specs/22-spec-workflow-first-execution/22-audit-workflow-first-execution.md` | Planning audit report for SDD2 gatekeeping. |

### Notes

- Unit tests should stay alongside the code they verify in each package’s existing `__tests__/` directory.
- Use the repository’s established Bun commands: `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test`, and `bun run validate-config`.
- Follow the repository’s Bun-only, neverthrow-first, docs-in-the-same-change-set workflow.
- Keep adapter delivery work behind the existing engine/adapter boundary; do not move harness-specific commands, hooks, or UI logic into engine modules.

## Tasks

### [x] 1.0 Formalize the workflow-first execution boundary

#### 1.0 Proof Artifact(s)

- Document: `docs/adr/0004-workflow-first-execution-contract.md` records why explicit workflow execution replaces legacy `/start-work` -> Tapestry as core semantics and links Spec 22 Unit 1.
- Test: `bun test packages/engine/src/__tests__/execution-lifecycle.test.ts` passes with coverage proving Spec 22 Unit 1 ordinary Loom chat, idle hooks, continuation hooks, and session observations do not implicitly call `startExecution`.
- Test: `bun test packages/engine/src/__tests__/runtime-contract.test.ts` passes with coverage proving Spec 22 Unit 1 `WorkflowInstance` and `ExecutionLease` are created or advanced only through explicit user-authorized execution transitions.
- Document: `docs/adapter-boundary.md` explains that adapters expose the Spec 22 Unit 1 engine contract through harness-specific commands, skills, hooks, scripts, or UI without moving semantics into the adapter.

#### 1.0 Tasks

- [x] 1.1 Author the companion ADR describing the workflow-first execution contract and link it from the surrounding docs referenced by Spec 22 Unit 1.
- [x] 1.2 Add or update engine-facing types and validation surfaces so execution start/resume/pause/inspect/advance semantics are modeled as explicit workflow operations rather than chat-side behavior.
- [x] 1.3 Add runtime checks that require explicit user-authorized execution transitions and reject agent-, hook-, or event-initiated self-start behavior.
- [x] 1.4 Extend engine tests to prove ordinary conversation, idle continuation, and session observation paths do not implicitly enter durable execution.

### [x] 2.0 Add the canonical planning workflow and `before-plan` extension contract

#### 2.0 Proof Artifact(s)

- DSL example: `docs/workflow-schema.md` shows thin publication syntax such as `extension_points { before-plan }`, distinct composition syntax such as `extend before-plan [ ... ]`, exactly one canonical planning step, and multiple named pre-plan artifacts feeding planning for Spec 22 Unit 2.
- Test: `bun test packages/core/src/__tests__/schema.test.ts packages/core/src/__tests__/validate.test.ts packages/core/src/__tests__/parse_config.test.ts` passes with cases accepting valid plan-oriented workflows and rejecting missing or duplicated planning steps and invalid `before-plan` publication for Spec 22 Unit 2.
- Test: `bun test packages/config/src/__tests__/merge.test.ts` passes with coverage proving generic `extends` / `insert_before` / `insert_after` remains a config-merge concern while selected workflows can publish an engine-visible `before-plan` extension surface after merge for Spec 22 Unit 2.
- CLI: `bun run validate-config` passes against updated builtin `.weave` workflow defaults and demonstrates the builtins remain DSL-first for Spec 22 Unit 2.

#### 2.0 Tasks

- [x] 2.1 Define the DSL fields for one canonical planning step, thin workflow-level `before-plan` publication (`extension_points { before-plan }`), separate composition syntax (`extend before-plan [ ... ]`), and the closed v1 `before-plan` contract in schema and validation layers.
- [x] 2.2 Update builtin workflow definitions so the effective default workflow is plan-oriented and publishes the selected `before-plan` extension surface without replacing planning itself.
- [x] 2.3 Preserve the existing config-merge ownership of `extends`, `insert_before`, and `insert_after`, and document how `before-plan` becomes an engine-visible contract only after merge resolution.
- [x] 2.4 Add schema, validate, parse-config, merge, and builtin tests covering valid planning workflows, invalid planning-step counts, invalid `before-plan` publication, and non-reconciling `before-plan` behavior in v1.
- [x] 2.5 Update workflow-schema and related docs with a concrete DSL example showing reviewed pre-plan artifacts feeding the canonical planning step.

### [x] 3.0 Implement artifact identity, revisions, approval, and consumption provenance

#### 3.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/runtime-memory.test.ts packages/engine/src/__tests__/runtime-sqlite.test.ts` passes with coverage for logical artifact identity, monotonic revisions, revision-bound approval, and approval invalidation on new revision for Spec 22 Unit 3.
- Test: `bun test packages/engine/src/__tests__/execution-lifecycle.test.ts` passes with coverage proving producers cannot self-approve their own artifacts, steps declare normative and informational inputs, and consumed artifact identity + revision are recorded on each step attempt for Spec 22 Unit 3.
- Test fixture: `packages/engine/src/__tests__/fixtures/artifact-provenance.json` contains sanitized example runtime records for Spec 22 Unit 3 with integrity fingerprints only, demonstrating no raw artifact contents, prompts, tokens, or private paths are stored.
- Failure proof: `bun test packages/engine/src/__tests__/execution-lifecycle.test.ts` demonstrates artifact consumption fails closed when current content does not match the approved revision or integrity fingerprint, and retry reuses the same consumed revisions by default for Spec 22 Unit 3.

#### 3.0 Tasks

- [x] 3.1 Add runtime data types and persistence fields for artifact identity, monotonic revisions, approval state, and integrity-verification metadata without storing raw artifact contents.
- [x] 3.2 Define or update the engine/runtime interfaces that let planning and execution steps declare normative and informational artifact inputs explicitly.
- [x] 3.3 Implement approval invalidation, self-approval prohibition, consumed-revision recording, and default retry reuse of the same consumed artifact revisions.
- [x] 3.4 Implement consumption-time integrity verification that compares current artifact contents to the bound immutable revision or fingerprint and fails closed on mismatch.
- [x] 3.5 Add in-memory and SQLite runtime tests, plus sanitized provenance fixtures, covering approval invalidation, integrity verification, and provenance recording.
- [x] 3.6 Update boundary and glossary docs so integrity-verification metadata has a sanctioned home consistent with the new runtime model.

### [x] 4.0 Add reconciliation semantics and handler routing

#### 4.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/execution-lifecycle.test.ts` passes with coverage for the Spec 22 Unit 3 closed reconciliation reason set: `execution-mismatch`, `user-revision-request`, `review-rejection`, and `security-rejection`.
- Test: `bun test packages/engine/src/__tests__/execution-lifecycle.test.ts` proves Spec 22 Unit 3 reconciliation reasons are accepted only from authorized sources, route to the nearest explicitly declared upstream handler step, and pause or block when no handler exists.
- Test: `bun test packages/engine/src/__tests__/execution-lifecycle.test.ts` proves Spec 22 Unit 3 review and security gates re-run after reconciliation resolves a review- or security-originated rejection, while `before-plan` steps do not participate in v1 reconciliation semantics.
- Test: `bun test packages/engine/src/__tests__/runtime-contract.test.ts` passes with coverage proving Spec 22 Unit 3 reconciliation cannot revise completed `Plan Markdown` tasks; corrective work is represented as follow-up tasks.

#### 4.0 Tasks

- [x] 4.1 Add DSL and validated-config support for step-local reconciliation handler declarations using the closed built-in reason set from Spec 22 Unit 3.
- [x] 4.2 Implement runtime enforcement for authorized reconciliation sources, nearest-upstream handler resolution, and fail-closed pause/block behavior when no handler exists.
- [x] 4.3 Implement gate re-run behavior for review- and security-originated reconciliation outcomes and preserve the v1 rule that `before-plan` steps do not participate in reconciliation.
- [x] 4.4 Add runtime protections that keep completed `Plan Markdown` tasks immutable and model corrections as follow-up work rather than in-place rewrites.
- [x] 4.5 Extend execution-lifecycle and runtime-contract tests to cover the reason set, authorized-source checks, handler routing, gate re-runs, and immutable completed tasks.

### [x] 5.0 Compose workflow-level and step-level prompt appends safely

#### 5.0 Proof Artifact(s)

- DSL example: `docs/prompt-composition.md` documents `prompt_append` / `prompt_append_file` at workflow and step scope, ordered multiple append syntax, workflow-scope append order, step-local precedence, and same-scope last-append-wins behavior for Spec 22 Unit 4.
- Test: `bun test packages/core/src/__tests__/schema.test.ts packages/core/src/__tests__/validate.test.ts packages/core/src/__tests__/parse_config.test.ts` passes with cases for workflow-level and step-level prompt appends in the final DSL syntax for Spec 22 Unit 4.
- Test: `bun test packages/engine/src/__tests__/compose.test.ts packages/engine/src/__tests__/template-renderer.test.ts` passes with fixtures proving append order, step-local conflict precedence, same-scope conflict reporting, and bounded template context rendering for Spec 22 Unit 4.
- Security proof: `bun test packages/engine/src/__tests__/template-renderer.test.ts` demonstrates Spec 22 Unit 4 append instructions never interpolate untrusted artifact contents or incidental chat text as trusted instructions.

#### 5.0 Tasks

- [x] 5.1 Define `prompt_append` and `prompt_append_file` at workflow and step scope, including ordered multiple append support in final merged configuration order and mutual-exclusion enforcement per scope.
- [x] 5.2 Extend prompt-composition and workflow validation logic so workflow-scope and step-scope appends compose correctly, with step-local precedence across scopes and last-append-wins within a scope.
- [x] 5.3 Add inspection or conflict-surfacing behavior so same-scope append collisions are visible in tooling rather than silently accepted as healthy.
- [x] 5.4 Enforce the trust boundary that prompt appends are config-authored text rendered against bounded template context and never ingest untrusted artifact contents or incidental chat text as instructions.
- [x] 5.5 Update prompt-composition docs and test suites with concrete fixtures covering append ordering, precedence, conflict surfacing, and trusted rendering behavior.

### [x] 6.0 Align adapter readiness and delivery with canonical execution commands

#### 6.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/capability-contract.test.ts packages/engine/src/__tests__/capability-readiness.test.ts` passes with coverage proving Spec 22 Unit 4 canonical execution-command support is modeled through `command-entrypoints` readiness across command and non-command harness delivery mechanisms.
- Test fixture: `packages/engine/src/__tests__/capability-readiness.test.ts` includes a non-command harness example that declares explicit execution-contract delivery as `emulated`, demonstrating the audit’s non-OpenCode proof path for Spec 22 Unit 4.
- Test: `bun test packages/adapters/opencode/src/__tests__/run-workflow.test.ts` passes with coverage proving OpenCode delivery starts Spec 22 Unit 4 workflow execution only from an explicit user command/helper path and supplies `PlanStateProvider` at completion boundaries.
- Document: `docs/adapter-readiness-status.md` explains how adapters declare `native`, `emulated`, `degraded`, or `unsupported` `command-entrypoints` readiness for Spec 22 Unit 4 execution-contract delivery without assuming every harness exposes literal commands.
- Document: `docs/adapter-boundary.md` links Spec 22 Unit 4 command delivery back to the engine-owned execution contract and confirms adapters own concrete command, hook, skill, script, or UI wiring.

#### 6.0 Tasks

- [x] 6.1 Document that canonical execution-command support is modeled through Spec 07 `command-entrypoints`, with `workflow-step-dispatch` treated as supporting execution context rather than a separate start-path capability.
- [x] 6.2 Update engine readiness/profile logic and tests so command and non-command harnesses can declare `command-entrypoints` support for execution-contract delivery as `native`, `emulated`, `degraded`, or `unsupported` without inventing a parallel model.
- [x] 6.3 Update OpenCode adapter delivery tests and documentation to prove workflow execution enters only through explicit user-driven helpers/commands and still respects plan-state completion boundaries.
- [x] 6.4 Update adapter-boundary and adapter-readiness docs so command, hook, skill, script, and UI delivery remain adapter-owned projections of the same engine-owned execution contract.
