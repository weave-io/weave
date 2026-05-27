# 20-spec-opencode-adapter-materialization.md

## Introduction/Overview

This feature turns `@weave/adapter-opencode` from a partial reference package into a real first-slice adapter that can materialize Weave agents into OpenCode. The goal is to complete the adapter-owned materialization path using an injected OpenCode client in plugin/runtime context, while preserving the existing engine/adapter boundary and deferring broader workflow-lifecycle parity.

## Goals

- Deliver a real SDK-backed materialization path for Weave agents in `@weave/adapter-opencode`.
- Keep `descriptor.name` as the canonical identity for Weave-managed OpenCode agents.
- Resolve and validate models and skills using the current engine contracts instead of silent fallback behavior.
- Protect manually managed OpenCode agents from accidental overwrite by requiring explicit Weave ownership before update.
- Ship the slice with test coverage, documentation, and an ADR that explain the adapter shape and its constraints.

## User Stories

- **As a Weave adapter developer**, I want `spawnSubagent()` to materialize real OpenCode agents so that the adapter package is no longer only an in-memory translation stub.
- **As a Weave maintainer**, I want the OpenCode adapter to follow the documented engine/adapter boundary so that adapter work does not leak harness-specific behavior back into `@weave/engine`.
- **As a user configuring Weave agents**, I want my declared models, prompts, tool policy, and skills to be validated against the OpenCode runtime so that adapter output matches authored intent.
- **As an OpenCode user with existing agents**, I want Weave materialization to avoid clobbering non-Weave agents so that adopting Weave does not destroy manual harness configuration.

## Demoable Units of Work

### Unit 1: SDK-backed agent materialization

**Purpose:** Replace the current in-memory-only adapter path with a real materialization flow in OpenCode plugin/runtime context.

**Functional Requirements:**
- The system shall allow `OpenCodeAdapter` to receive an injected OpenCode SDK client or equivalent adapter-owned client facade from its caller.
- The system shall use the existing adapter bootstrap flow (`init()`, `loadAvailableSkills()`, `spawnSubagent(descriptor)`) without requiring engine API changes.
- The system shall translate each engine-provided `AgentDescriptor` into an OpenCode agent definition using `descriptor.composedPrompt`, `descriptor.mode`, `descriptor.description`, `descriptor.temperature`, and adapter-mapped tool permissions.
- The system shall materialize each non-disabled Weave agent into OpenCode through an SDK-backed runtime path instead of only storing translated agents in memory.
- The system shall treat OpenCode plugin/runtime context as the first supported execution environment for this slice.

**Proof Artifacts:**
- Test: adapter materialization test with a mocked injected client demonstrates that `spawnSubagent(descriptor)` performs a real upsert call path instead of only mutating local memory.
- Test: translation unit test demonstrates that `AgentDescriptor` fields become the expected OpenCode agent payload.
- Manual smoke artifact: plugin/runtime demo notes or captured output demonstrates that a Weave-configured agent appears in OpenCode after materialization.

### Unit 2: Safe reconciliation and ownership enforcement

**Purpose:** Ensure Weave can create and update its own OpenCode agents without overwriting manual harness agents.

**Functional Requirements:**
- The system shall use the **Canonical Agent Name** as the durable identity for a Weave-managed OpenCode agent.
- The system shall treat display-oriented fields such as display name and description as presentation metadata rather than identity.
- The system shall support upsert-only reconciliation in the first slice.
- The system shall require explicit Weave ownership before overwriting an existing OpenCode agent with the same canonical name.
- The system shall raise a collision error when an existing agent name matches but Weave ownership cannot be proven.
- The system shall not automatically delete, prune, or take over stale or foreign OpenCode agents in this slice.

**Proof Artifacts:**
- Test: reconciliation test demonstrates create behavior for a missing Weave-managed agent.
- Test: reconciliation test demonstrates update behavior for an existing Weave-managed agent.
- Test: collision test demonstrates that a foreign agent with the same canonical name fails safely instead of being overwritten.

### Unit 3: Model and skill validation

**Purpose:** Bring the OpenCode adapter in line with current engine contracts for model resolution and skill resolution.

**Functional Requirements:**
- The system shall call `resolveAdapterModelIntent()` with adapter-provided OpenCode model context instead of selecting `descriptor.models[0]` unconditionally.
- The system shall validate model intent against OpenCode-available models before materializing an agent.
- The system shall fail materialization when explicit subagent model intent cannot be satisfied.
- The system shall implement real `loadAvailableSkills()` discovery for the OpenCode-visible skills needed by current Weave agents.
- The system shall preserve the current engine behavior where unresolved declared skills are hard errors rather than silently skipped.
- The system shall keep model lookup, available-model discovery, and skill discovery adapter-owned.

**Proof Artifacts:**
- Test: model resolution unit test demonstrates selected/default/available-model inputs produce the expected resolved model intent.
- Test: failed model validation case demonstrates the adapter rejects an unsupported explicit subagent model.
- Test: skill discovery and resolution test demonstrates that declared skills resolve successfully when present and fail with the expected error shape when missing.

### Unit 4: Documentation and acceptance bar

**Purpose:** Leave the adapter slice understandable, reviewable, and safe for future extension.

**Functional Requirements:**
- The system shall document the final adapter shape in the spec, adapter docs, and a new ADR covering the SDK-first and plugin/runtime-first decisions.
- The system shall update repository documentation that describes `@weave/adapter-opencode` so it no longer implies the package is only a placeholder after this slice lands.
- The system shall preserve the explicit first-slice non-goals: no workflow/lifecycle parity expansion, no file/config-first path, no delete/prune reconciliation, no engine-boundary drift unless blocked, and no soft-skip for missing declared skills.
- The system shall meet a three-layer acceptance bar: pure unit tests, adapter tests with a mocked injected client, and a documented manual smoke path in plugin/runtime context.

**Proof Artifacts:**
- Document: ADR file demonstrates the rationale for SDK-first materialization, plugin/runtime-first integration, and ownership-safe reconciliation.
- Document: updated adapter docs demonstrate the current OpenCode adapter behavior and first-slice limits.
- Test summary or checklist: documented acceptance notes demonstrate all three validation layers were completed.

## Non-Goals (Out of Scope)

1. **Workflow/lifecycle parity**: This slice does not expand `runWorkflow()` or implement full OpenCode lifecycle event wiring beyond the existing materialization-focused scope.
2. **File/config-first registration**: This slice does not introduce a parallel file-writing or config-only materialization path as the primary adapter behavior.
3. **Automatic prune or takeover**: This slice does not auto-delete stale agents, auto-takeover foreign agents, or broaden reconciliation beyond safe upsert behavior.
4. **Engine API changes**: This slice does not change `HarnessAdapter`, `AgentDescriptor`, skill resolution, or model-resolution contracts unless a genuine blocker is discovered and separately approved.
5. **Soft-skip skill behavior**: This slice does not weaken current hard-error behavior for unresolved declared skills.

## Design Considerations

No specific visual design requirements identified. The user-facing design concern is naming clarity: OpenCode-facing labels may change, but the adapter must preserve the **Canonical Agent Name** as stable identity and treat display-oriented text as presentation only.

## Repository Standards

- Follow the engine/adapter ownership rules in `docs/adapter-boundary.md`; harness-specific discovery and runtime integration stay adapter-owned.
- Use Bun-only runtime and tooling; do not introduce Node runtime APIs such as `fs` or `child_process`.
- Use `neverthrow` result types for fallible internal logic wherever repository rules allow; convert only at required boundaries.
- Inject dependencies through constructors or explicit options; do not hide SDK client state in globals.
- Follow early-return style and avoid nested ternaries and nested `try/catch` blocks.
- Add isolated tests with mocks for adapter behavior; do not require a live OpenCode runtime for automated tests.
- Update documentation in the same change set as behavior changes, including adapter docs and the ADR requested by the user.
- Use the existing workspace commands and package structure under `packages/adapters/opencode`.

## Technical Considerations

- The current adapter boundary is already sufficient for this slice: `HarnessAdapter.init()`, `loadAvailableSkills()`, and `spawnSubagent(descriptor)` are the intended integration points.
- `AgentDescriptor` is the stable adapter input; the adapter must consume `descriptor.composedPrompt`, ordered `descriptor.models`, abstract tool policy, and optional presentation metadata without re-reading raw Weave prompt/config sources.
- OpenCode-specific model discovery, selected-model lookup, skill discovery, and concrete permission mapping remain adapter-owned.
- Current official OpenCode plugin guidance describes plugins as async functions that receive runtime context including `client`, `project`, `directory`, and `worktree`; this supports the chosen plugin/runtime-first and injected-client approach.
- Current official OpenCode SDK guidance shows provider/model discovery through SDK resources such as `client.app.providers()`, supporting the chosen resolve-and-validate model strategy.
- Current OpenCode guidance also indicates config is validated strictly and config-time changes are not hot-reloaded; if implementation touches config-adjacent surfaces for smoke testing or integration notes, documentation must treat restart requirements and schema validation as operational constraints rather than assume live reload.
- Context7 research did not provide a definitive current public example for agent CRUD/reconciliation APIs in `@opencode-ai/sdk` ~1.15.x. Implementation should therefore keep the SDK interaction behind a narrow adapter-owned client facade so exact OpenCode method names can evolve without changing engine-facing contracts.
- The repository already treats `@weave/adapter-opencode` as a partial reference package. This spec keeps the work adapter-local and avoids engine-boundary drift unless a true blocker appears.

## Security Considerations

- The adapter shall not log, commit, or snapshot OpenCode API keys, provider secrets, session tokens, or other runtime credentials.
- Manual smoke artifacts shall avoid including sensitive local paths, credentials, or private prompts when they can be redacted.
- Collision handling shall fail safe when ownership is unclear so the adapter does not overwrite manually managed OpenCode agents.
- Skill discovery shall only surface metadata needed for engine resolution and shall not leak unnecessary skill contents or private filesystem details into engine-owned records.
- Any plugin/runtime integration notes shall make clear that config changes may require restart and should not encourage ad hoc editing of secret-bearing config into committed repository files.

## Success Metrics

1. **Real materialization path**: `@weave/adapter-opencode` can create or update Weave-managed agents through an SDK-backed path in plugin/runtime context with no engine API changes.
2. **Safe validation behavior**: unsupported explicit models, unresolved declared skills, and foreign-agent collisions fail with intentional, test-covered errors instead of silent fallback or overwrite.
3. **Acceptance completeness**: the slice passes the agreed three-layer bar of unit tests, mocked-client adapter tests, and documented manual smoke validation.

## Open Questions

1. **Approved assumption — SDK surface isolation**: the implementation shall hide the exact OpenCode agent list/create/update calls behind `packages/adapters/opencode/src/opencode-client.ts`, so SDK or plugin-runtime method-name uncertainty remains adapter-local and does not change engine-facing contracts.
2. **Approved assumption — fail-closed ownership proof**: the implementation shall update an existing same-named agent only when Weave ownership can be proven through a supported adapter-visible marker; otherwise reconciliation shall fail closed with a collision error instead of overwriting the agent.

Manual smoke validation shall use the OpenCode CLI/runtime with no extra plugins enabled except `@weave/adapter-opencode`, because the user's normal configuration still contains the legacy weave integration.
