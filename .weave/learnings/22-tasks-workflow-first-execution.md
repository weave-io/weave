# Learnings: 22 Tasks Workflow First Execution

## Task 1: Formalize the workflow-first execution boundary
- **Discrepancy**: Repository-wide quality-gate commands (`bun run lint`, `bun run typecheck`, `bun run build`, `bun run test`) are currently blocked by pre-existing unrelated errors in `packages/cli/src/commands/init.ts`, even though Spec 22 Unit 1 work is in docs/engine/core/config surfaces.
- **Resolution**: Verified task-relevant engine/docs behavior with targeted tests and documented the CLI blocker explicitly in the task 1.0 proof artifact instead of treating the task work itself as failed.
- **Suggestion**: Future plans should call out known workspace-wide CLI blockers up front so parent-task proof collection can distinguish task-local regressions from unrelated baseline failures.

## Task 1: Workspace-root test nuance
- **Discrepancy**: Running the targeted Bun test command from the wrong repo root can pull in sibling workspace files under `docs/adr-workflow-execution-contract/`, producing misleading failures unrelated to this plan.
- **Resolution**: Ran the targeted engine tests from the actual project root (`docs/spec-workflow-execution-dsl`) and recorded that root-sensitive nuance in the proof artifact.
- **Suggestion**: Future plans should state the exact project root/worktree path to use for verification commands when sibling draft workspaces are present.

## Task 2: Workflow-schema doc delegation failure
- **Discrepancy**: Task 2.5 expected a concrete `docs/workflow-schema.md` update, but Shuttle twice returned a planning-only response describing intended edits instead of changing the file.
- **Resolution**: Marked task 2.5 blocked in the plan, recorded the failure here, and continued to the next executable parent task instead of stalling parent 2.0.
- **Suggestion**: Future plans should call out that documentation-only tasks still require exact file edits plus post-edit verification, especially when delegating to subagents that may otherwise stop after analysis.

## Task 3: Artifact persistence shape
- **Discrepancy**: The relevant-files table suggested a likely SQLite schema-file change (`packages/engine/src/runtime/sqlite/schema.ts`), but the existing `artifacts_json` column already had enough flexibility to carry artifact identity, revision, approval, and integrity metadata.
- **Resolution**: Implemented the new persistence shape in runtime domain types plus in-memory/SQLite store serialization logic without changing the SQLite table schema or adding a migration.
- **Suggestion**: Future plans should distinguish between persistence-model changes that require table-schema migrations and changes that can safely ride inside existing serialized JSON blobs.

## Task 3: Delegation timeout handling
- **Discrepancy**: Two delegation attempts for task 3.3 aborted before Shuttle executed, likely due long-running command startup or task execution instability rather than a verified code failure.
- **Resolution**: Marked task 3.3 blocked for now, moved to the next executable subtask, and will instruct future delegations to wrap long-running verification commands with `gtimeout` so hangs fail fast.
- **Suggestion**: Future plans should explicitly require bounded command execution (for example `gtimeout`) for expensive verification steps so subagents do not stall the orchestration loop.

## Task 3: Integrity verification ownership
- **Discrepancy**: The plan phrased integrity verification as comparing current artifact contents at consumption time, but the engine/adapter boundary means the engine cannot assume direct filesystem reads for every harness.
- **Resolution**: Implemented engine-side fail-closed comparison against adapter-supplied current digests (`artifactDigests`) and stored integrity fingerprints, keeping file-reading responsibility out of the engine.
- **Suggestion**: Future plans should state explicitly when current-content verification is expected to arrive via adapter-supplied digests rather than direct engine-owned file access.

## Task 4: Before-plan reconciliation boundary
- **Discrepancy**: During verification of task 4.2, the new runtime comments in `packages/engine/src/execution-lifecycle.ts` described `before-plan` reconciliation exclusion as schema-enforced, but task 4.1 and the existing core tests establish that this exclusion cannot be proven at schema time after merge/composition.
- **Resolution**: Carried that discrepancy forward into task 4.3 context so the implementation can enforce the v1 `before-plan` exclusion at runtime/gate behavior rather than relying on schema comments alone.
- **Suggestion**: Future plans should distinguish schema-time validation from post-merge runtime enforcement whenever extension-point placement affects semantic eligibility.
