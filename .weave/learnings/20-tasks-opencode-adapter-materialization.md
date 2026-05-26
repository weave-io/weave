# Learnings: 20-tasks-opencode-adapter-materialization

## Task 1: Establish the injected OpenCode client path and adapter-owned SDK facade
- **Discrepancy**: The Spec 20 task/spec/audit files existed only as untracked files in the main checkout, so a fresh git worktree created from `main` did not contain the plan materials required to execute the task.
- **Resolution**: Copied the `docs/specs/20-spec-opencode-adapter-materialization/` directory into the dedicated worktree before implementation and continued execution there.
- **Suggestion**: Commit or otherwise persist spec/task/audit inputs before starting implementation in a new worktree so the execution workspace contains the authoritative plan files.

## Task 2: Replace in-memory translation with real SDK-backed materialization
- **Reconciliation module placement**: The `list → reconcile → create/update` flow was placed in a dedicated `reconcile-agent.ts` module rather than inline in `spawnSubagent()`. This keeps `index.ts` as a thin orchestrator and makes the reconciliation logic independently testable.
- **Ownership marker approach**: Using a human-readable `[weave-managed]` tag embedded in the agent `description` field is a lightweight, harness-visible ownership signal that requires no separate metadata store. It is idempotent and survives round-trips through the OpenCode config.
- **`translatedAgents` retention**: The map was retained (not removed) because it provides test-visible state that is cheaper to assert than mocking the full SDK call chain. Its JSDoc was updated to clarify it is a secondary artifact, not the source of truth.
- **Translation-only mode**: When no client is injected, `spawnSubagent()` logs a warning and returns after populating `translatedAgents`. This preserves backward compatibility for callers that construct the adapter without a client (e.g. config-write-only scenarios).
- **Error propagation**: Reconciliation errors (including `CollisionError`) are surfaced as thrown `Error` instances from `spawnSubagent()` rather than returned as `Result` values. This matches the `HarnessAdapter` interface contract (`Promise<void>`) and lets callers use standard `try/catch` or `await` error handling.
