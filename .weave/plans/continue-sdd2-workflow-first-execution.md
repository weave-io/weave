# Continue SDD2 Workflow-First Execution Planning

## TL;DR
> **Summary**: Produce the SDD2 Phase 3/4 planning artifacts for Spec 22 by updating the existing task list with relevant files, notes, and junior-friendly sub-tasks, then creating the planning audit report. Scope is limited to the Spec 22 tasks file and audit file in the requested worktree.
> **Estimated Effort**: Medium

## Context
### Original Request
Continue SDD2 for `docs/specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md` in `/Users/jose/.local/share/opencode/worktree/7c0262423ae11610293f86be6510f119611f7a93/docs/spec-workflow-execution-dsl` by completing SDD2 Phase 3 and Phase 4: add the `## Relevant Files` table and Notes section, expand the six existing parent tasks into concrete sub-tasks, map every functional requirement to a planned test/proof artifact, create `22-audit-workflow-first-execution.md`, run the required planning audit gates, and stop without remediation or code implementation.

### Key Findings
- Target worktree was verified as a non-bare Git worktree on branch `docs/spec-workflow-execution-dsl`; canonical top level resolves under `/Users/jose/dotfiles/.local/share/opencode/worktree/.../docs/spec-workflow-execution-dsl`.
- SDD assessor reports Spec 22 as Phase 2 / `S2_PARENTS_DONE`: spec and parent task file exist, audit file is missing, and sub-tasks are still `TBD`.
- Spec 22 contains 4 demoable units and 36 functional requirements: execution boundary, plan-oriented default workflow with `before-plan`, artifact revision/approval/provenance plus reconciliation, and prompt/adapter-readiness alignment.
- Existing task file contains 6 parent tasks with concrete proof artifacts but no `## Relevant Files`, no Notes section, and all `#### N.0 Tasks` blocks set to `TBD`.
- Repository standards evidence read from `AGENTS.md`, `README.md`, `package.json`, `.github/workflows/ci.yml`, `docs/product-vision.md`, `docs/adapter-boundary.md`, `packages/core/README.md`, `packages/engine/README.md`, and `packages/adapters/opencode/README.md`.
- Standards to reflect in tasks/audit: Bun-only commands, `neverthrow` for fallible logic, no `console.*`, schema changes require schema/validate/parse-config test coverage, engine owns harness-agnostic semantics, adapters own concrete harness delivery, docs must be updated for non-trivial changes, and CI gates are lint/typecheck/build/test.
- `CONTRIBUTING.md` and `.github/pull_request_template.md` were searched and not found.
- The spec has three open questions about `before-plan` DSL syntax, workflow/step prompt append fields, and canonical execution command capability naming. The task expansion should either encode explicit planning assumptions or let the audit fail the Open question resolution gate with exact remediation targets.

## Objectives
### Core Objective
Create a complete, auditable SDD2 implementation blueprint for Spec 22 without making implementation-code changes.

### Deliverables
- [ ] Updated `docs/specs/22-spec-workflow-first-execution/22-tasks-workflow-first-execution.md` with `## Relevant Files`, Notes, and concrete sub-tasks for every parent task.
- [ ] Created `docs/specs/22-spec-workflow-first-execution/22-audit-workflow-first-execution.md` using the required audit format and evaluating all REQUIRED and FLAG gates.
- [ ] Functional-requirement coverage proof showing every Spec 22 functional requirement maps to at least one sub-task and one planned test/proof artifact.

### Definition of Done
- [ ] `grep -R "TBD" docs/specs/22-spec-workflow-first-execution/22-tasks-workflow-first-execution.md` returns no matches.
- [ ] `docs/specs/22-spec-workflow-first-execution/22-audit-workflow-first-execution.md` exists and includes Executive Summary, gate overview/gateboard, standards evidence, and exception-only findings when needed.
- [ ] The audit records PASS/FAIL for REQUIRED gates and PASS/FLAG for FLAG gates: requirement-to-test traceability, proof artifact verifiability, repository standards consistency, open question resolution, regression-risk blind spots, and non-goal leakage.
- [ ] `git -C /Users/jose/.local/share/opencode/worktree/7c0262423ae11610293f86be6510f119611f7a93/docs/spec-workflow-execution-dsl status --short` shows changes only to the Spec 22 tasks file and audit file.

### Guardrails (Must NOT)
- Do not edit source files, tests, package files, existing docs outside the Spec 22 task/audit artifacts, or `.weave` runtime/config files during SDD2 execution.
- Do not perform remediation edits if any REQUIRED audit gate fails; record compact exception-only findings and concrete remediation targets instead.
- Do not invent repository standards from the spec/task files alone; use the verified standards evidence sources.
- Do not expand beyond Spec 22 non-goals: no full adapter implementation, no legacy `/start-work` preservation mandate, no arbitrary extension rule language, no raw-skill runtime nodes, no silent latest-artifact rebinding, and no `before-plan` reconciliation handlers.

## TODOs

- [ ] 1. Confirm SDD2 artifact scope in the requested worktree
  **What**: Re-read the Spec 22 spec and parent task file, confirm the audit file is absent, and snapshot the current parent task count before editing.
  **Files**: `docs/specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md`, `docs/specs/22-spec-workflow-first-execution/22-tasks-workflow-first-execution.md`
  **Acceptance**: Work starts from the specified worktree, exactly 6 existing parent tasks are preserved, and no unrelated files are touched.

- [ ] 2. Add the required Relevant Files table and Notes section
  **What**: Insert `## Relevant Files` before `## Tasks` with comprehensive-but-focused entries for likely implementation and proof files, followed by Notes that capture Bun-only commands, colocated tests, schema-test obligations, mock-provider/adapter testing, and adapter-boundary rules.
  **Files**: `docs/specs/22-spec-workflow-first-execution/22-tasks-workflow-first-execution.md`
  **Acceptance**: Table includes the task/audit artifacts, docs/ADR targets, core schema/validate/parse tests, config merge/builtins files, engine lifecycle/runtime/prompt/capability files, OpenCode delivery files, and no irrelevant package areas.

- [ ] 3. Expand parent task 1.0: workflow-first execution boundary
  **What**: Replace `1.0` `TBD` with junior-friendly sub-tasks covering the ADR, adapter-boundary execution-contract docs, explicit user-authorized transition modeling, guards preventing chat/hooks/session observations from starting execution, `WorkflowInstance`/`ExecutionLease` transition tests, and regression tests for existing lifecycle entry points.
  **Files**: `docs/specs/22-spec-workflow-first-execution/22-tasks-workflow-first-execution.md`
  **Acceptance**: Spec 22 Unit 1 functional requirements all map to task 1.0 sub-tasks and proof artifacts in `execution-lifecycle.test.ts`, `runtime-contract.test.ts`, `docs/adr/0004-workflow-first-execution-contract.md`, and `docs/adapter-boundary.md#execution-contract`.

- [ ] 4. Expand parent task 2.0: canonical planning workflow and `before-plan`
  **What**: Replace `2.0` `TBD` with sub-tasks covering exact DSL syntax selection, one canonical planning step validation, `before-plan` publication validation, pre-plan artifact production/consumption, pause/retry/revision behavior, config-merge interaction with `extends`/`insert_before`/`insert_after`, builtin workflow updates, docs examples, and validation CLI proof.
  **Files**: `docs/specs/22-spec-workflow-first-execution/22-tasks-workflow-first-execution.md`
  **Acceptance**: Spec 22 Unit 2 functional requirements all map to sub-tasks and proof artifacts in core schema/validate/parse_config tests, config merge tests, `docs/workflow-schema.md#before-plan-extension`, and `bun run validate-config`.

- [ ] 5. Expand parent task 3.0: artifact identity, revisions, approval, and consumption provenance
  **What**: Replace `3.0` `TBD` with sub-tasks covering runtime type changes, logical artifact identity, monotonic revisions, integrity fingerprints only, revision-bound approval, approval invalidation, self-approval prevention, normative vs informational inputs, consumed-revision recording, fail-closed content verification, retry pinning, explicit rebinding, runtime store updates, migrations, fixtures, and tests.
  **Files**: `docs/specs/22-spec-workflow-first-execution/22-tasks-workflow-first-execution.md`
  **Acceptance**: Artifact-related Spec 22 Unit 3 requirements map to sub-tasks and proof artifacts in `runtime-memory.test.ts`, `runtime-sqlite.test.ts`, `execution-lifecycle.test.ts`, and sanitized `packages/engine/src/__tests__/fixtures/artifact-provenance.json`.

- [ ] 6. Expand parent task 4.0: reconciliation semantics and handler routing
  **What**: Replace `4.0` `TBD` with sub-tasks covering the closed reconciliation reason set, authorized reason sources, explicit upstream handler declaration, nearest-handler routing, pause/block behavior with no handler, review/security gate reruns after corresponding rejections, exclusion of `before-plan` from v1 reconciliation, and immutable completed `Plan Markdown` tasks with follow-up corrective work.
  **Files**: `docs/specs/22-spec-workflow-first-execution/22-tasks-workflow-first-execution.md`
  **Acceptance**: Reconciliation-related Spec 22 Unit 3 requirements map to sub-tasks and proof artifacts in `execution-lifecycle.test.ts` and `runtime-contract.test.ts`, with non-goal leakage explicitly avoided.

- [ ] 7. Expand parent task 5.0: safe workflow and step prompt appends
  **What**: Replace `5.0` `TBD` with sub-tasks covering workflow-level append fields, step-level append fields, ordered multiple appends in final merged order, step-local conflict precedence, same-scope last-append-wins plus conflict reporting, bounded template context, no untrusted artifact/chat interpolation as trusted instructions, docs, and fixtures.
  **Files**: `docs/specs/22-spec-workflow-first-execution/22-tasks-workflow-first-execution.md`
  **Acceptance**: Spec 22 Unit 4 prompt requirements map to sub-tasks and proof artifacts in core schema/validate/parse_config tests, `compose.test.ts`, `template-renderer.test.ts`, and `docs/prompt-composition.md#workflow-step-prompt-appends`.

- [ ] 8. Expand parent task 6.0: adapter readiness and canonical execution delivery
  **What**: Replace `6.0` `TBD` with sub-tasks covering capability identifier naming, readiness mapping within Spec 07 vocabulary, command and non-command harness delivery mechanisms, OpenCode explicit user command/helper start path, `PlanStateProvider` completion-boundary wiring, readiness docs, and adapter-boundary docs.
  **Files**: `docs/specs/22-spec-workflow-first-execution/22-tasks-workflow-first-execution.md`
  **Acceptance**: Spec 22 Unit 4 adapter-readiness requirement maps to sub-tasks and proof artifacts in `capability-contract.test.ts`, `capability-readiness.test.ts`, `packages/adapters/opencode/src/__tests__/run-workflow.test.ts`, `docs/adapter-readiness-status.md`, and `docs/adapter-boundary.md#canonical-execution-command`.

- [ ] 9. Add explicit coverage and open-question handling before audit
  **What**: Cross-check all 36 functional requirements against the sub-tasks and proof artifacts; record explicit planning assumptions for the three Spec 22 open questions or leave them as named audit failures with precise fix targets.
  **Files**: `docs/specs/22-spec-workflow-first-execution/22-tasks-workflow-first-execution.md`, `docs/specs/22-spec-workflow-first-execution/22-audit-workflow-first-execution.md`
  **Acceptance**: No functional requirement is unmapped; open questions are either resolved by documented planning assumptions in task sections/Notes or fail the audit's Open question resolution gate with exact remediation targets.

- [ ] 10. Create the SDD2 planning audit report
  **What**: Write `22-audit-workflow-first-execution.md` using the required audit format, including Executive Summary, gate overview/gateboard, standards evidence table, and compact exception-only findings when gates fail.
  **Files**: `docs/specs/22-spec-workflow-first-execution/22-audit-workflow-first-execution.md`
  **Acceptance**: Audit evaluates all REQUIRED gates and FLAG gates exactly once, reports an overall PASS only if all REQUIRED gates pass, caps main REQUIRED failures at 3 and FLAG findings at 2, and includes concrete remediation targets for every failure.

- [ ] 11. Run the chain-of-verification check
  **What**: Fact-check the final audit against the spec, updated tasks file, and standards evidence; verify no unsupported findings, vague proof artifacts, or missing standards sources remain.
  **Files**: `docs/specs/22-spec-workflow-first-execution/22-tasks-workflow-first-execution.md`, `docs/specs/22-spec-workflow-first-execution/22-audit-workflow-first-execution.md`
  **Acceptance**: Audit evidence is internally consistent, standards table records found/not-found sources, and any REQUIRED failure is exception-only with an exact section to edit.

- [ ] 12. Stop after planning artifacts only
  **What**: Report paths written, parent task count, total sub-task count, audit overall status, REQUIRED failures, FLAG findings, and notable standards conflicts/open questions.
  **Acceptance**: `git status --short` in the target worktree shows only `22-tasks-workflow-first-execution.md` and `22-audit-workflow-first-execution.md` changed for the SDD2 execution.

## Verification
- [ ] `grep -R "TBD" docs/specs/22-spec-workflow-first-execution/22-tasks-workflow-first-execution.md` returns no matches.
- [ ] `grep -c '^### \[ \] [0-9]\.0' docs/specs/22-spec-workflow-first-execution/22-tasks-workflow-first-execution.md` returns `6`.
- [ ] Every `#### N.0 Tasks` section contains concrete `- [ ] N.x` sub-tasks.
- [ ] `docs/specs/22-spec-workflow-first-execution/22-audit-workflow-first-execution.md` exists and records overall PASS/FAIL plus REQUIRED/FLAG gate outcomes.
- [ ] `git -C /Users/jose/.local/share/opencode/worktree/7c0262423ae11610293f86be6510f119611f7a93/docs/spec-workflow-execution-dsl status --short` shows no source-code implementation changes.
