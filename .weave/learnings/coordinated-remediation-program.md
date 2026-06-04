# Learnings: Coordinated Five-Spec Remediation Program

## Task 1: Establish Baseline, Decisions, and Workstream Guardrails
- **Discrepancy**: The task `**Files**` list named all five spec files, but the accepted baseline/decision work only needed a new ADR; none of the spec files required edits to satisfy the task acceptance.
- **Resolution**: Recorded the baseline commands and all open-decision resolutions in `docs/adr/0005-five-spec-remediation-decisions.md` and treated the spec files as reference inputs.
- **Suggestion**: Narrow the task file list to the ADR plus any spec files that truly need wording updates, so downstream verification expects the right change surface.

- **Discrepancy**: The plan's baseline milestone called for recording `bun test`, but the CLI migrate/init command tests hang in the current baseline, so a full green root test run was not available before remediation.
- **Resolution**: Recorded scoped passing test baselines and documented the pre-existing hang in the ADR so later tasks can distinguish baseline debt from regressions.
- **Suggestion**: State explicitly when baseline capture may rely on scoped test evidence because the current suite has known pre-existing hangs.

- **Discrepancy**: The ADR created in Task 1 recorded extra implementation-location decisions that go beyond the plan and conflict with later task file lists (for example `packages/cli/src/migrate/` vs `packages/cli/src/migration/`, and keeping prompt helpers in `schema.ts` vs Task 4's explicit `prompt-schema-helpers.ts`).
- **Resolution**: Treat the plan's per-task `**Files**` and milestone text as authoritative for implementation work, and treat those extra ADR details as non-binding unless a later task explicitly realigns the ADR.
- **Suggestion**: Keep the initial decision ADR limited to the plan's actual open decisions, or explicitly mark any extra implementation-location notes as provisional so they do not conflict with downstream task execution.

## Task 3: Create Documentation IA Skeleton and Artifact Policy Checkpoint
- **Discrepancy**: The initial navigation scaffold introduced a new durable dead link because `docs/README.md` and `docs/specs/README.md` pointed to `docs/dsl-reference.md` before that guide existed.
- **Resolution**: Added `docs/dsl-reference.md` during the same task so the new durable entry points only link to real destinations.
- **Suggestion**: When a task asks for navigation scaffolding plus a future canonical guide, either create a minimal placeholder guide immediately or keep the link out until the guide exists.

- **Discrepancy**: `docs/specs/README.md` also surfaced two unplanned durable-link problems: Spec 21b has an empty directory and Spec 23 has no formal spec file.
- **Resolution**: Kept both rows for numbering history but converted them to explanatory plain text instead of broken links.
- **Suggestion**: Future docs-index tasks should explicitly call out empty or artifact-only spec directories so verification can treat them as numbering notes rather than link targets.

## Task 6: Complete Spec 25 CLI Init/Migration Decomposition
- **Discrepancy**: Post-edit AFT diagnostics kept reporting a contradictory `init.ts:87` callback-type error even though the source signature in `migrate.ts` matches the callback shape and both `bun run --filter '@weave/cli' typecheck` and `npx tsc --noEmit -p packages/cli/tsconfig.json` passed cleanly.
- **Resolution**: Verified the actual source signatures directly and treated the package compiler runs as the source of truth for task acceptance, while still recording the inconsistent AFT/LSP signal here for future investigation.
- **Suggestion**: When a plan step depends on compiler-clean verification in this repo, prefer an explicit package `tsc --noEmit` run alongside AFT diagnostics so stale editor signals do not masquerade as real regressions.

## Task 7: Complete Spec 24 Execution Lifecycle Decomposition
- **Discrepancy**: The task's file list did not mention `packages/engine/src/__tests__/skill-resolution.test.ts` or `packages/adapters/opencode/src/__tests__/run-workflow.test.ts`, but `bun run --filter '@weave/engine' typecheck` still depends on those fixtures matching the Task 4 `extend_before_plan` contract.
- **Resolution**: Updated the engine and adapter test fixtures from `extend_before_plan: {}` to `extend_before_plan: { steps: [] }` so engine package typecheck could pass after the lifecycle split.
- **Suggestion**: When a task's acceptance includes package-level typecheck, include any known cross-package test fixtures affected by earlier schema-contract tasks in the `**Files**` list or call them out explicitly as expected collateral updates.

## Task 8: Finalize Documentation IA and Cross-Link All Remediation Outcomes
- **Discrepancy**: The first docs-finalization pass still left broken relative links in `AGENTS.md` and the Spec 28 doc itself, even though the task reported a clean manual link review.
- **Resolution**: Ran a scripted link check, converted the misleading AGENTS path example into plain inline code, and fixed the Spec 28 relative paths so the durable-doc set reached 0 dead links.
- **Suggestion**: For docs tasks with link-based acceptance, require a reproducible scripted link check in the task instructions rather than relying on a manual pass alone.

- **Discrepancy**: A collateral config test fixture (`packages/config/src/__tests__/merge.test.ts`) also needed Task 4 `extend_before_plan` updates for repository-wide typecheck cleanliness, but that file was not listed in the docs task.
- **Resolution**: The docs pass updated durable links first, and the collateral fixture fix was treated as necessary cleanup for later repository-wide validation.
- **Suggestion**: When a late docs/finalization task is expected to run root gates, call out any known remaining cross-package schema-fixture alignments so they do not appear as surprise scope expansion.
