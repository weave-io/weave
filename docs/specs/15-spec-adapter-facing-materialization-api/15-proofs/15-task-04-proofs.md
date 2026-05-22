# Spec 15 Task 04 Proofs — Runner Compatibility and Adapter Ownership

## Scope

Task 04 evaluates whether `WeaveRunner.run()` can safely call `materializeAgents(input)` while preserving existing observable runner behavior, documents the adapter boundary for the materialization API, and captures runner test output.

## Runner Refactor Decision

Decision: **not safe to refactor in this task**.

Reason: the current runner and `materializeAgents(input)` intentionally differ in failure behavior:

- `WeaveRunner.run()` throws `Error(conflict.message)` on category shuttle conflicts after logging the conflict.
- `materializeAgents(input)` returns `err({ type: "CategoryShuttleConflict", ... })` instead of throwing.
- `WeaveRunner.run()` logs descriptor composition failures, skips the failed agent, and continues materializing later agents.
- `materializeAgents(input)` returns `err({ type: "DescriptorCompositionFailure", ... })` and stops on the first descriptor composition failure.

The runner was left on its manual composition loop, with a compatibility comment explaining that a future refactor must either add partial-failure materialization support or explicitly convert typed materialization results back into the runner's throw/skip-and-continue behavior.

## Acceptance Checks

- `onEffect` ordering is preserved because the runner loop remains unchanged: `onEffect` fires immediately before `adapter.spawnSubagent(descriptor)`.
- No new use of deprecated `registerHook()` or `loadSkill()` was introduced.
- `docs/adapter-boundary.md` now documents `materializeAgents` data flow and adapter-owned translation/materialization responsibilities.

## Deprecated Surface Grep

Command:

```bash
grep -r "registerHook\|loadSkill" packages/engine/src/materialization.ts packages/engine/src/runner.ts
```

Output:

```text
packages/engine/src/runner.ts:    // These supersede registerHook(). Full workflow engine integration is deferred
```

## Runner Test Output

Command:

```bash
bun test packages/engine/src/__tests__/runner.test.ts
```

Output:

```text
bun test v1.3.13 (bf2e2cec)

 51 pass
 0 fail
 140 expect() calls
Ran 51 tests across 1 file. [57.00ms]
```
