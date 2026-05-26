# Learnings: 20-tasks-opencode-adapter-materialization

## Task 1: Establish the injected OpenCode client path and adapter-owned SDK facade
- **Discrepancy**: The Spec 20 task/spec/audit files existed only as untracked files in the main checkout, so a fresh git worktree created from `main` did not contain the plan materials required to execute the task.
- **Resolution**: Copied the `docs/specs/20-spec-opencode-adapter-materialization/` directory into the dedicated worktree before implementation and continued execution there.
- **Suggestion**: Commit or otherwise persist spec/task/audit inputs before starting implementation in a new worktree so the execution workspace contains the authoritative plan files.

## Task 2: Replace in-memory translation with real SDK-backed materialization
- **Discrepancy**: Task 2's acceptance required the `list existing → reconcile decision → create/update call` flow to be implemented in adapter-owned code, which effectively required introducing `reconcile-agent.ts` before Task 3 formally asked for that module.
- **Resolution**: Implemented the first reconciliation slice in Task 2 so `spawnSubagent()` could use a real SDK-backed materialization path, while leaving Task 3 to harden the canonical-identity and ownership-check behavior with focused tests.
- **Suggestion**: Move the first creation of `reconcile-agent.ts` into Task 2 explicitly, or narrow Task 2 so it does not depend on a module the plan introduces in Task 3.

## Task 2: Replace in-memory translation with real SDK-backed materialization
- **Reconciliation module placement**: The `list → reconcile → create/update` flow was placed in a dedicated `reconcile-agent.ts` module rather than inline in `spawnSubagent()`. This keeps `index.ts` as a thin orchestrator and makes the reconciliation logic independently testable.
- **Ownership marker approach**: Using a human-readable `[weave-managed]` tag embedded in the agent `description` field is a lightweight, harness-visible ownership signal that requires no separate metadata store. It is idempotent and survives round-trips through the OpenCode config.
- **`translatedAgents` retention**: The map was retained (not removed) because it provides test-visible state that is cheaper to assert than mocking the full SDK call chain. Its JSDoc was updated to clarify it is a secondary artifact, not the source of truth.
- **Translation-only mode**: When no client is injected, `spawnSubagent()` logs a warning and returns after populating `translatedAgents`. This preserves backward compatibility for callers that construct the adapter without a client (e.g. config-write-only scenarios).
- **Error propagation**: Reconciliation errors (including `CollisionError`) are surfaced as thrown `Error` instances from `spawnSubagent()` rather than returned as `Result` values. This matches the `HarnessAdapter` interface contract (`Promise<void>`) and lets callers use standard `try/catch` or `await` error handling.

## Task 3: Implement safe reconciliation using canonical agent identity and ownership checks
- **Discrepancy**: `reconcile-agent.ts` was already fully implemented in Task 2 as a prerequisite for the SDK-backed materialization path. Task 3 therefore consisted entirely of adding the focused `reconcile-agent.test.ts` test suite rather than implementing new production code.
- **Resolution**: Wrote 42 tests covering create, update, collision, `listAgents` failure, and upsert-only constraint cases. All acceptance criteria were met through test coverage alone; no production code changes were required.
- **Suggestion**: When a plan introduces a module in a later task but an earlier task depends on it, either move the module introduction earlier in the plan or explicitly note in the later task that implementation may already be complete and only test coverage is needed.
- **Learnings file hygiene**: The learnings file must be staged and committed as part of the task commit. Leaving it modified but uncommitted causes the worktree to appear dirty after the task is marked complete. Always include the learnings file in the final `git add` before committing.
