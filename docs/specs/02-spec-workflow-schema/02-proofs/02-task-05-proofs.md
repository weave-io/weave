# Task 05 Proofs — Barrel Exports and Downstream Type Consumers

## Task Summary

`packages/core/src/index.ts` was updated to export all new workflow types (`WorkflowStepType`, `CompletionMethod`, `ArtifactRef`, `OnReject`, `WorkflowStep`, `WorkflowConfig`) and schemas (`WorkflowStepTypeSchema`, `CompletionMethodSchema`, `ArtifactRefSchema`, `OnRejectSchema`, `WorkflowStepSchema`, `WorkflowConfigSchema`). Downstream packages (`@weave/engine`, `@weave/adapter-opencode`) were verified to compile cleanly — no code in those packages accessed the `workflows` field, so the type narrowing from `unknown` to `WorkflowConfig` caused no breakage.

## What This Task Proves

- All new types and schemas are reachable from `@weave/core`'s public API.
- The `workflows` type narrowing does not break downstream packages.
- `bun run typecheck` passes with zero errors across the entire workspace.
- `bun test packages/core/` continues to pass all 122 tests.

## Artifact: Workspace typecheck

**What it proves:** All packages compile cleanly with the new narrowed `workflows` type.
**Why it matters:** Ensures no downstream consumers silently broke when `z.unknown()` became `WorkflowConfigSchema`.
**Command:**
```bash
bun run typecheck
```
**Result summary:** Zero errors across all three packages.
```
@weave/core typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
```

## Artifact: Full test run

**What it proves:** All tests still pass after barrel export changes.
**Command:**
```bash
bun test packages/core/
```
**Result summary:** 122 pass, 0 fail.
```
 122 pass
 0 fail
 358 expect() calls
Ran 122 tests across 6 files.
```

## Reviewer Conclusion

All new workflow schemas and types are correctly exported from the `@weave/core` barrel. The workspace compiles cleanly. No downstream breakage.
