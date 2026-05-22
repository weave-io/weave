# 15-spec-adapter-facing-materialization-api.md

## Introduction/Overview

Add a stable `@weave/engine` materialization API that turns a validated Weave config into adapter-facing agent descriptors without invoking a concrete adapter lifecycle. This solves issue [#70](https://github.com/weave-io/weave/issues/70): adapters, especially the OpenCode adapter and future adapter work such as #15, should not need to reverse-engineer `WeaveRunner` or call `HarnessAdapter.spawnSubagent()` just to obtain adapter-ready configuration.

The primary goal is to expose a pure, typed engine composition surface that includes builtin agents, custom agents, and generated category shuttles in deterministic order while preserving the adapter boundary: the engine composes normalized descriptors, and adapters decide how to write files, register resources, or launch harness-specific behavior.

## Goals

- Provide a public engine materialization function that adapters can import from `@weave/engine`.
- Return typed `neverthrow` `Result` or `ResultAsync` errors for expected materialization failures instead of throwing or invoking adapter lifecycle methods.
- Materialize composed agent descriptors for builtin agents, custom agents, and generated category shuttles.
- Preserve existing runner behavior for disabled agents and category shuttle ordering while making that behavior testable without a concrete adapter.
- Document the materialization API in the adapter boundary docs so implementers understand what the engine owns and what adapters own after receiving descriptors.

## User Stories

- **As an adapter author**, I want to call one engine API to obtain composed Weave agent descriptors so that I can translate them into my harness format without duplicating runner logic.
- **As an OpenCode adapter maintainer**, I want materialization to avoid `HarnessAdapter.spawnSubagent()` so that config generation can run independently from live adapter dispatch.
- **As a Weave engine maintainer**, I want expected materialization failures to be typed results so that adapters and tests can handle conflicts, missing prompts, and composition failures predictably.
- **As a future adapter implementer**, I want deterministic descriptor output for builtins, custom agents, and category shuttles so that generated harness files are stable and reviewable.

## Demoable Units of Work

### Unit 1: Public Materialization API Contract

**Purpose:** Define the adapter-facing vocabulary and exported function that adapters will use to request materialized descriptors from the engine.

**Functional Requirements:**
- The system shall export a public materialization function from `packages/engine/src/index.ts` for adapter use.
- The system shall define public input, output, warning, and error types for the materialization API.
- The system shall accept explicit adapter-provided context and shall not read harness-owned directories, query harness UI/runtime state, or require a `HarnessAdapter` instance.
- The system shall return a `Result` or `ResultAsync` value with discriminated union error variants for expected failures.

**Proof Artifacts:**
- Test: engine API import test demonstrates adapters can import the materialization function and its public types from `@weave/engine`.
- Typecheck: `bun run typecheck` demonstrates the exported API and discriminated error types compile.
- Code review artifact: API signature demonstrates no `HarnessAdapter` parameter and no concrete harness names.

### Unit 2: Deterministic Descriptor Materialization

**Purpose:** Produce complete, stable agent descriptor output for declared agents and generated category shuttles without invoking adapter dispatch.

**Functional Requirements:**
- The system shall materialize composed descriptors for builtin agents included in the resolved Weave config.
- The system shall materialize composed descriptors for custom agents declared by the user.
- The system shall generate and materialize category shuttle descriptors using the existing category shuttle naming and merge behavior.
- The system shall include generated category shuttles in deterministic order.
- The system shall exclude disabled agents consistently with current `WeaveRunner` behavior.
- The system shall not invoke `HarnessAdapter.spawnSubagent()` or any adapter lifecycle method during materialization.

**Proof Artifacts:**
- Test: builtin agent materialization demonstrates configured builtin agents produce composed descriptors.
- Test: custom agent materialization demonstrates user-defined agents produce composed descriptors.
- Test: generated category shuttle materialization demonstrates `shuttle-{category}` descriptors are included in stable order.
- Test: disabled-agent materialization demonstrates disabled declared agents and generated shuttles are excluded consistently with runner behavior.
- Test: mock adapter or spy test demonstrates `spawnSubagent()` is not called by the materialization function.

### Unit 3: Typed Failure Handling and Compatibility With Existing Composition

**Purpose:** Reuse existing engine composition behavior while replacing expected materialization throws with typed, inspectable errors.

**Functional Requirements:**
- The system shall reuse existing descriptor composition behavior from `packages/engine/src/compose.ts` instead of duplicating prompt composition logic.
- The system shall reuse existing category shuttle generation behavior from `packages/engine/src/descriptors.ts` instead of creating a parallel implementation.
- The system shall convert expected category shuttle conflicts into typed materialization errors.
- The system shall preserve prompt composition errors as typed materialization failures with enough context for adapter authors to identify the agent that failed.
- The system shall not silently swallow expected materialization failures.

**Proof Artifacts:**
- Test: category shuttle name conflict returns a typed materialization error rather than throwing.
- Test: prompt composition failure identifies the affected agent in the materialization error.
- Test: composition reuse demonstrates descriptor fields match existing `composeAgentDescriptor` behavior for representative agents.
- CLI: `bun test packages/engine/src` output demonstrates materialization tests pass with existing engine tests.

### Unit 4: Runner Integration and Adapter Boundary Documentation

**Purpose:** Keep existing runtime behavior compatible while documenting that adapters can use materialization directly and remain responsible for harness-specific translation.

**Functional Requirements:**
- The system shall keep `WeaveRunner.run()` behavior compatible for current adapter tests and callers.
- The system should use the new materialization API internally from `WeaveRunner` when doing so does not change observable behavior.
- The system shall preserve current `onEffect` and `spawnSubagent()` ordering if runner internals are refactored.
- The adapter boundary documentation shall describe the materialization API, engine-owned descriptor composition, and adapter-owned translation/materialization work after descriptors are returned.
- The documentation shall state that the materialization API does not replace adapter responsibility for harness file writes, concrete tool mapping, available-model discovery, skill file discovery/loading, or runtime launch behavior.

**Proof Artifacts:**
- Test: existing `runner.test.ts` passes, demonstrating compatibility with current runner behavior.
- Test: runner call-order test demonstrates `onEffect` still occurs before `spawnSubagent()` if the runner is refactored.
- Documentation: `docs/adapter-boundary.md` update demonstrates materialization ownership and adapter responsibilities are documented.
- Code review artifact: no new `registerHook()` or deprecated `loadSkill()` dependency is introduced.

## Non-Goals (Out of Scope)

1. **Implementing OpenCode adapter #15**: This spec unblocks cleaner adapter work but does not implement or modify the OpenCode adapter's generated files.
2. **Replacing the full `WeaveRunner` lifecycle**: The new API may be used by `WeaveRunner`, but this spec does not remove runner responsibilities such as adapter initialization and dispatch.
3. **Adding harness-specific translation**: The engine shall not generate OpenCode, Claude Code, Pi, or other harness-specific config files.
4. **Changing the `.weave` DSL**: No new DSL keywords, blocks, or syntax are required for this API.
5. **Redesigning skill or model discovery**: Adapters remain responsible for discovering available skills, available models, selected model state, and harness defaults.

## Design Considerations

No specific UI design requirements identified. This is an engine API and documentation feature.

The developer experience should be clear for adapter authors: function and type names should make it obvious that the API produces adapter-facing descriptors and does not perform harness-specific writes or runtime dispatch.

## Repository Standards

- Follow the engine/adapter boundary in `docs/adapter-boundary.md`: engine APIs accept explicit harness context and return normalized results; adapters own harness resource discovery and concrete materialization.
- Follow the product vision in `docs/product-vision.md`: Weave composes normalized agent descriptors and prompt/delegation intent; adapters translate those descriptors for concrete harnesses.
- Use Bun-only workflows and commands: `bun run typecheck`, `bun test`, and package-local Bun tests where appropriate.
- Use `neverthrow` for fallible functions and expected failure paths. Do not throw for category shuttle conflicts, prompt composition failures, or other expected materialization errors.
- Use discriminated union error types with enough context for tests and adapter callers to branch safely.
- Keep code testable with explicit inputs and in-memory fixtures. Do not start real harnesses, write real harness resources, or depend on live adapter processes in tests.
- Export public engine APIs and types from `packages/engine/src/index.ts`.
- Update documentation for non-trivial architectural changes before considering the task complete.
- Mention issue #70 in any Pull Request created for this work.

## Technical Considerations

- The likely implementation surface is a new engine module near `packages/engine/src/materialization.ts`, plus tests under `packages/engine/src/__tests__/` and exports from `packages/engine/src/index.ts`.
- The API may be named `materializeAgentDescriptors(config, context)` or `materializeHarnessConfig(config, context)`; the final name should emphasize descriptor materialization and avoid implying harness-specific file generation.
- The materialization input should include a resolved `WeaveConfig` and explicit adapter-provided context. For the MVP, context should include only data required by existing descriptor composition. Additional model or skill context may be added only if needed without expanding scope beyond issue #70.
- The materialization output should include an ordered list or record of materialized agent descriptors. If both forms are useful, the ordered list should be the source of deterministic behavior.
- Category shuttle generation should reuse `generateCategoryShuttles(config)` to avoid a second implementation of category behavior.
- Descriptor composition should reuse `composeAgentDescriptor(...)` so prompt templates, delegation context, raw/effective tool policy, and existing descriptor fields remain consistent.
- Disabled agents must be filtered using the same semantics as `WeaveRunner.run()`.
- Expected failures should be represented as discriminated unions. Current TypeScript guidance supports discriminated unions with exhaustive `never` checks for reliable handling when new variants are added.
- Current `neverthrow` guidance supports `Result`/`ResultAsync` return types, `andThen` composition, and `ResultAsync.fromPromise`/`fromThrowable` wrappers for converting fallible or throwing operations into typed results. This matches the repository's error-handling standard.
- Latest-standards research summary:
  - **neverthrow**: Consulted Context7 docs for `/supermacro/neverthrow`, a living documentation source. Relevant guidance: use `ResultAsync.fromPromise` or `ResultAsync.fromThrowable` to wrap async fallible work; compose with `andThen`; return typed errors instead of relying on thrown exceptions for expected failures.
  - **TypeScript**: Consulted Context7 docs for `/microsoft/typescript-website`, a living documentation source. Relevant guidance: discriminated unions plus `never` exhaustiveness checks provide type-safe handling for public error variants; type-only exports/imports are erased at runtime and are appropriate for public API type surfaces.
  - **Repository/external guidance tension**: No material tension identified. Current external guidance supports the repository's existing `neverthrow` and discriminated-union standards.

## Security Considerations

- The materialization API shall not read `.env` files, secrets, credentials, tokens, or harness-owned secret stores.
- The materialization API shall not invoke concrete harness tools or adapter lifecycle methods that could mutate runtime state.
- If materialization output includes composed prompt content, callers must treat that output as generated configuration data and avoid committing proof artifacts that contain secrets or sensitive user content.
- Adapter-owned skill metadata should not be exposed in sanitized debug/effect artifacts unless explicitly required by a future spec; skill discovery and loading remain adapter-owned.
- Because this feature touches adapter boundaries, prompt output, tool policy descriptors, and lifecycle separation, the implementation plan or completed work should receive Warp security review before execution or merge.

## Success Metrics

1. **Public API availability**: Adapter code can import and call the new materialization function from `@weave/engine` without constructing a `HarnessAdapter`.
2. **Acceptance coverage**: Tests cover builtins, custom agents, disabled agents, and generated category shuttles, matching issue #70 acceptance criteria.
3. **No adapter dispatch during materialization**: Tests or code review prove the new function does not call `HarnessAdapter.spawnSubagent()` or other adapter lifecycle methods.
4. **Deterministic output**: Repeated materialization of the same config produces descriptors in the same order.
5. **Boundary documentation complete**: `docs/adapter-boundary.md` clearly explains what the engine materializes and what adapters own afterward.

## Open Questions

1. Should the public output be limited to `AgentDescriptor[]`, or should it introduce a wrapper such as `MaterializationPlan` with warnings, skipped-agent details, and provenance?
2. Should missing declared skills be represented in this materialization API now, or remain outside the MVP because issue #70 only requires composed descriptors?
3. Should `WeaveRunner.run()` be refactored to use the new API in the first implementation, or should runner integration be a follow-up after the public API is tested independently?
4. Should category provenance such as category name, description, or patterns be exposed in the materialization output, or should generated category shuttles remain ordinary descriptors for the MVP?
