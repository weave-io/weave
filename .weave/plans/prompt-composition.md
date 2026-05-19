# Prompt Composition — Engine Implementation

**Issue:** #6

## TL;DR
> **Summary**: Create `AgentDescriptor` type and `composeAgentDescriptor()` in `@weave/engine` to compose prompt text, delegation targets, and prompt_append into a normalized descriptor. Update `HarnessAdapter.spawnSubagent` to accept `AgentDescriptor` instead of raw `AgentConfig`, and wire composition into `WeaveRunner.run()`.
> **Estimated Effort**: Medium

## Context
### Original Request
Issue #6 calls for engine-owned prompt composition — pure engine logic with no adapter dependency. The engine must load prompt sources (inline or file), build delegation sections, append `prompt_append`, and produce a normalized `AgentDescriptor` that adapters consume.

### Key Findings
- **Current state on `main`**: `WeaveRunner.run()` passes raw `AgentConfig` directly to `adapter.spawnSubagent()` with zero composition. No `AgentDescriptor` type exists. No `compose.ts` exists. However, `runner.ts` already evaluates `evaluateEffectiveToolPolicy()` per agent and emits `RunAgentEffect` via an `onEffect` callback before spawning.
- **Existing engine modules to integrate with**:
  - `tool-policy.ts` — defines `EffectiveToolPolicy` (all 5 capabilities resolved) and `evaluateEffectiveToolPolicy()`. Already called in `runner.ts`.
  - `run-agent-effects.ts` — defines `RunAgentEffect` discriminated union emitted via `WeaveRunnerOptions.onEffect`. Already wired in `runner.ts`.
  - `capability-contract.ts` — defines adapter capability declarations and readiness. **Not a dependency for composition** — composition is adapter-agnostic. Noted here for awareness only.
- **Spike reference** (`spike:packages/engine/src/compose.ts`): Proven design with `AgentDescriptor`, `DelegationTarget`, `ComposeError`, `composeAgentDescriptor()`. Uses `node:fs/promises` `readFile` for prompt files. Works but has known gaps.
- **Spike gaps to resolve**:
  1. **Delegation duplication** — category shuttles derived from the same base shuttle all appear as separate delegation targets with identical triggers
  2. **Delegation target filtering too broad** — every non-disabled, non-self agent is a target regardless of mode or relevance
  3. **Tool policy integration** — `AgentDescriptor.effectiveToolPolicy` should carry the fully-resolved policy from `evaluateEffectiveToolPolicy()`, not just the raw partial. The raw `tool_policy` is also preserved for adapters that need it.
  4. **Skills extension point** — `composedPrompt` needs a hook for future skill injection (#12) without blocking this issue
  5. **`prompt_file` resolution** — spike reads raw `prompt_file` path; production must use resolved absolute paths from `@weave/config`
  6. **Effect emission integration** — `RunAgentEffect` should carry the composed `AgentDescriptor` so observers can inspect the final prompt and delegation targets
- **`AgentConfig` shape**: Has `prompt`, `prompt_file`, `prompt_append`, `models`, `mode`, `tool_policy`, `triggers`, `skills`, `description`, `temperature`, `name`, `display_name`
- **Adapter boundary**: Engine owns prompt composition and returns normalized descriptors. Adapters own formatting, tool name translation, and harness materialisation.

## Objectives
### Core Objective
Introduce a composition step between config parsing and adapter materialisation that produces fully-composed `AgentDescriptor` values.

### Deliverables
- [x] `AgentDescriptor` and related types in `packages/engine/src/compose.ts`
- [x] `composeAgentDescriptor()` function with `neverthrow` return types
- [x] `HarnessAdapter.spawnSubagent` signature updated to accept `AgentDescriptor`
- [x] `WeaveRunner.run()` composes descriptors before passing to adapter
- [x] MockAdapter and runner tests updated
- [x] Dedicated compose unit tests
- [x] Documentation in `docs/`

### Definition of Done
- [x] `bun test` passes with all new and updated tests
- [x] `bun run typecheck` passes
- [x] `bun run build` succeeds

### Guardrails (Must NOT)
- Must NOT implement adapter logic (OpenCode #15, Pi #21)
- Must NOT implement skill loading/resolution (#12) — only leave a clear extension point
- Must NOT discover harness resources or scan directories from engine code
- Must NOT throw exceptions for expected failures — use `neverthrow`

## TODOs

- [x] 1. **Create `AgentDescriptor` type and composition types**
  **What**: Define `AgentDescriptor`, `DelegationTarget`, and `ComposeError` types in a new `compose.ts` module. `AgentDescriptor` carries: `name`, `description?`, `composedPrompt` (string), `models` (string[]), `mode`, `temperature?`, `effectiveToolPolicy` (type `EffectiveToolPolicy` from `./tool-policy.js` — all 5 capabilities resolved), `rawToolPolicy` (raw `ToolPolicy | undefined` for adapter translation), `delegationTargets`, `skills` (string[] — passthrough for adapter/skill-resolver use). `DelegationTarget` carries: `name`, `description?`, `triggers`. `ComposeError` is a discriminated union: `PromptSourceMissingError`, `PromptFileReadError`.
  **Files**: `packages/engine/src/compose.ts`
  **Acceptance**: Types compile; exported from barrel

- [x] 2. **Implement `composeAgentDescriptor()` function**
  **What**: Pure composition function: `(agentName, agentConfig, config, allAgents) → ResultAsync<AgentDescriptor, ComposeError>`. Steps: (a) load prompt source via inline `prompt` or `Bun.file(prompt_file).text()`, (b) build delegation targets from `allAgents` (see filtering rules below), (c) format delegation as markdown section, (d) append `prompt_append`, (e) call `evaluateEffectiveToolPolicy(agentConfig.tool_policy)` to produce the resolved policy, (f) return `AgentDescriptor` with both `effectiveToolPolicy` and `rawToolPolicy`. **Delegation filtering improvements over spike**: only include targets where the composing agent has `delegate: allow` in tool_policy; exclude agents with `mode: "primary"` from delegation targets (primary agents are user-facing, not delegation targets); exclude category shuttles that share the same base shuttle as the composing agent (reduces duplication — the base shuttle is sufficient as a target). **Skills**: pass through `agentConfig.skills ?? []` on the descriptor without resolution (future #12 will resolve them).
  **Files**: `packages/engine/src/compose.ts`
  **Acceptance**: Function compiles, handles inline prompt, handles prompt_file, handles missing prompt source, handles file read errors, applies delegation filtering, appends prompt_append, produces effective tool policy

- [x] 3. **Update `HarnessAdapter.spawnSubagent` signature**
  **What**: Change `spawnSubagent(name: string, config: AgentConfig)` to `spawnSubagent(descriptor: AgentDescriptor)`. The descriptor already carries `name` so a separate name param is redundant. Update JSDoc. Import `AgentDescriptor` from `./compose.js`.
  **Files**: `packages/engine/src/adapter.ts`
  **Acceptance**: Interface compiles with new signature

- [x] 4. **Update `WeaveRunner.run()` to compose before spawning**
  **What**: After generating category shuttles and merging into `allAgents`, iterate agents and call `composeAgentDescriptor()` for each non-disabled agent. Collect results; if any composition fails, log the error and skip that agent (don't abort the entire run — partial materialisation is better than none). Pass composed `AgentDescriptor` to `adapter.spawnSubagent(descriptor)`. The `allAgents` record (including generated shuttles) is passed to `composeAgentDescriptor` so delegation targets can see the full agent set. **Effect integration**: Remove the existing inline `evaluateEffectiveToolPolicy()` call (it moves into `composeAgentDescriptor`). Update the `onEffect` emission to include the composed descriptor: extend `RunAgentEffect` with an `agentDescriptor` field so observers can inspect the final prompt, delegation targets, and resolved policy. The effect is still emitted immediately before `spawnSubagent`.
  **Files**: `packages/engine/src/runner.ts`, `packages/engine/src/run-agent-effects.ts`
  **Acceptance**: Runner composes descriptors; handles composition errors gracefully; passes descriptors to adapter; effect carries descriptor

- [x] 5. **Update barrel exports**
  **What**: Export `AgentDescriptor`, `DelegationTarget`, `ComposeError`, and `composeAgentDescriptor` from `packages/engine/src/index.ts`. Remove any now-redundant re-exports if tool policy evaluation is fully subsumed by composition (it isn't — `evaluateEffectiveToolPolicy` remains independently useful for callers that don't need full composition).
  **Files**: `packages/engine/src/index.ts`
  **Acceptance**: All new public types and functions accessible via `@weave/engine`

- [x] 6. **Update MockAdapter and its type**
  **What**: Change `MockAdapter.spawnSubagent` to accept `AgentDescriptor` instead of `(name, config)`. Update `MockCall` union: `{ method: "spawnSubagent"; descriptor: AgentDescriptor }`. Update the `callsTo` helper return types accordingly.
  **Files**: `packages/engine/src/__tests__/mock-adapter.ts`
  **Acceptance**: MockAdapter compiles with new signature; existing test patterns adapt cleanly

- [x] 7. **Update runner tests**
  **What**: Update all existing runner tests to work with the new `AgentDescriptor`-based `spawnSubagent`. Tests now assert on `descriptor.name`, `descriptor.models`, `descriptor.composedPrompt`, `descriptor.effectiveToolPolicy` instead of `name` and `config.*`. **Existing `onEffect` tests** (currently ~200 lines covering effect emission with `effectiveToolPolicy` and `rawToolPolicy`) must be updated: effects now also carry `agentDescriptor`. Add new runner-level tests: (a) agent with inline prompt produces expected `composedPrompt`, (b) disabled agents are still excluded, (c) composition error for one agent doesn't prevent others from spawning, (d) effect carries composed descriptor with resolved policy.
  **Files**: `packages/engine/src/__tests__/runner.test.ts`
  **Acceptance**: All existing test scenarios still covered (including effect tests); new composition-through-runner tests pass

- [x] 8. **Create dedicated compose unit tests**
  **What**: New test file for `composeAgentDescriptor()` in isolation. Test cases: (a) inline prompt produces correct `composedPrompt`, (b) `prompt_file` loads file content (mock `readFile` via a temp file or Bun test fixture), (c) missing prompt and prompt_file returns `PromptSourceMissingError`, (d) unreadable prompt_file returns `PromptFileReadError`, (e) `prompt_append` is appended after prompt source, (f) delegation targets only include agents where composing agent has `delegate: allow`, (g) primary-mode agents excluded from delegation targets, (h) delegation section formatted as markdown, (i) agent with no delegation permission has empty delegation targets, (j) `skills` passthrough, (k) `effectiveToolPolicy` resolves all 5 capabilities (defaults to `"ask"` for undeclared), (l) `rawToolPolicy` preserved as-is from config.
  **Files**: `packages/engine/src/__tests__/compose.test.ts`
  **Acceptance**: All test cases pass; covers happy path, error paths, delegation filtering, and tool policy resolution

- [x] 9. **Update documentation**
  **What**: Create `docs/prompt-composition.md` documenting: the `AgentDescriptor` type and its role, the composition pipeline (prompt source → delegation → prompt_append → composedPrompt), delegation filtering rules, the skills extension point for #12, and how adapters consume descriptors. Cross-link from `docs/adapter-boundary.md` (add to Related links). Update `docs/adapter-boundary.md` ownership matrix row for "Prompt composition" if needed.
  **Files**: `docs/prompt-composition.md`, `docs/adapter-boundary.md`
  **Acceptance**: Docs accurately describe the implemented composition pipeline; cross-links work

## Verification
- [x] `bun run typecheck` passes
- [x] `bun run build` succeeds
- [x] `bun test` passes — all existing + new tests
- [x] No adapter code was added or modified (except `HarnessAdapter` interface signature)
- [x] `AgentDescriptor` is exported from `@weave/engine`
- [x] Delegation filtering excludes primary-mode agents and self
- [x] `effectiveToolPolicy` on descriptor has all 5 capabilities resolved
- [x] `RunAgentEffect` carries composed descriptor
- [x] Existing `onEffect` tests updated and passing
