# Spec 15 Task 02 Proofs — Deterministic Descriptor Materialization

## Scope

Task 02 extends and verifies `materializeAgents(input)` as the adapter-facing API for deterministic agent descriptor materialization.

## Proofs

- `materializeAgents` calls `generateCategoryShuttles(config)` instead of duplicating category shuttle generation.
- Declared `config.agents` retain config order and are emitted before generated `shuttle-{category}` agents.
- Generated category shuttles use category declaration order, producing stable order across repeated calls.
- `config.disabled.agents` excludes declared agents, suppresses all generated shuttles when `shuttle` is disabled, and suppresses a specific generated shuttle when `shuttle-{name}` is disabled.
- Every included agent is returned with an `AgentDescriptor`, proving `composeAgentDescriptor(...)` ran for each materialized entry.
- `materializeAgents` accepts only `{ config }`, can run without a `HarnessAdapter`, and does not call `spawnSubagent()`.

## Verification

Focused test command:

```bash
bun test packages/engine/src/__tests__/materialization.test.ts
```

Covered scenarios:

- builtin-named declared agents
- custom declared agents
- category shuttles
- disabled declared agents
- disabled base shuttle
- disabled specific generated shuttle
- no-adapter-dispatch behavior
- deterministic ordering
