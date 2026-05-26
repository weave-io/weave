# Spec 15 Task 03 Proofs — Typed Failures and Descriptor Compatibility

## Scope

Task 03 verifies that `materializeAgents(input)` preserves typed failure behavior and remains composition-compatible with direct `composeAgentDescriptor(...)` calls.

## Proofs

- Explicit `agent shuttle-frontend` plus `category frontend` produces a `CategoryShuttleConflict` entry in `plan.errors[]` without throwing; explicit agents still appear in `plan.agents[]`.
- A descriptor composition failure produces a `DescriptorCompositionFailure` entry in `plan.errors[]`; other agents still appear in `plan.agents[]`.
- `DescriptorCompositionFailure.agentName` matches the affected agent.
- Materialized descriptor fields match direct `composeAgentDescriptor(...)` output for `name`, `models`, `mode`, `composedPrompt`, and `effectiveToolPolicy`.

## Verification

Focused test command:

```bash
bun test packages/engine/src/__tests__/materialization.test.ts
```

Full output:

```text
bun test v1.3.13 (bf2e2cec)

 19 pass
 0 fail
 54 expect() calls
Ran 19 tests across 1 file. [60.00ms]
```
