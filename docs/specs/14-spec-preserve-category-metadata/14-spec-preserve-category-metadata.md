# 14-spec-preserve-category-metadata.md

## Introduction/Overview

Weave currently generates category shuttle agents such as `shuttle-frontend`, but adapter-facing output does not clearly preserve the category metadata that produced those shuttles. This makes it harder for adapters and composed prompts to route work faithfully by category name, description, and file patterns.

The primary goal of this feature is to preserve category metadata from `.weave` configuration through category shuttle generation, prompt composition, emitted effects, and adapter-facing `AgentDescriptor` values for issue [#71](https://github.com/weave-io/weave/issues/71).

## Goals

- Expose category metadata on generated category shuttle descriptors in a harness-neutral shape.
- Ensure `composeAgentDescriptor()` receives category context for generated category shuttles so prompt templates can render `agent.isCategory` and `category.*` fields correctly.
- Preserve category file patterns through materialization so adapters can use them for routing or generated harness configuration.
- Add isolated engine tests proving category name, description, patterns, category-derived identity, and prompt context survive the generation and composition flow.
- Update documentation so adapter authors understand how to consume category metadata without violating the engine/adapter boundary.

## User Stories

- **As an adapter author**, I want generated category shuttle descriptors to include their source category metadata so that I can generate harness-specific routing/configuration faithfully.
- **As a Weave user**, I want `category frontend` to produce a `shuttle-frontend` that still knows it came from the `frontend` category so that delegation behaves as declared in my `.weave` config.
- **As a prompt author**, I want category shuttle prompt templates to access `agent.isCategory` and `category.*` fields so that generated prompts can describe the specialist's category context accurately.
- **As an engine maintainer**, I want category metadata preservation to remain harness-neutral and testable so that adapters receive normalized data without the engine learning harness-specific routing rules.

## Demoable Units of Work

### Unit 1: Category metadata vocabulary and descriptor shape

**Purpose:** Establish the normalized adapter-facing metadata shape for category-derived agents.

**Functional Requirements:**
- The system shall define a category metadata shape for generated category shuttles that includes source category name, category description when present, category file patterns, and whether the descriptor is category-derived.
- The system shall expose that metadata on `AgentDescriptor` or an intentionally equivalent adapter-facing descriptor passed to `HarnessAdapter.spawnSubagent()`.
- The system shall preserve category file patterns exactly as parsed from the validated `CategoryConfig` without expanding globs or applying harness-specific matching rules in the engine.
- The system shall clone category file pattern arrays before exposing them through adapter-facing metadata so adapters cannot mutate the source config array by reference.
- The system shall keep the descriptor shape free of harness-specific routing fields, concrete harness tool names, and adapter-private state.

**Proof Artifacts:**
- Test: descriptor composition test demonstrates a generated `shuttle-frontend` descriptor contains category name `frontend`, category description when configured, patterns such as `src/components/**`, and a category-derived flag.
- Typecheck: `bun run typecheck` demonstrates the public descriptor type compiles for engine and adapter consumers.
- Code review artifact: `AgentDescriptor` or equivalent adapter-facing type contains normalized category metadata only, not harness-specific routing implementation details.

### Unit 2: Category shuttle generation carries source category context

**Purpose:** Preserve the connection between each generated shuttle and its source `category` block before prompt composition or adapter materialization occurs.

**Functional Requirements:**
- The system shall update category shuttle generation so each generated `shuttle-{category}` can be associated with its source `CategoryConfig`.
- The system shall preserve existing generation behavior for base shuttle inheritance, category model overrides, temperature overrides, `prompt_append` composition, tool policy merging, disabled generated shuttles, and collision errors.
- The system shall not require users to duplicate category metadata inside an explicit `agent shuttle-{category}` declaration.
- The system shall continue to return a typed `neverthrow` result for category shuttle generation conflicts.

**Proof Artifacts:**
- Test: `generateCategoryShuttles` or its replacement proves generated shuttles retain source category identity and do not regress existing inheritance/override behavior.
- Test: disabled category shuttles and base-shuttle-disabled behavior continue to omit generated descriptors and do not emit stale category metadata.
- Test: explicit `agent shuttle-{category}` collision still returns `CategoryShuttleConflictError` with the conflicting shuttle and category names.

### Unit 3: Prompt composition receives category context

**Purpose:** Make generated category shuttle prompts accurately reflect their category context during Mustache rendering.

**Functional Requirements:**
- The system shall call `composeAgentDescriptor()` with category context when composing generated category shuttles.
- The system shall set `agent.isCategory` to `true` for generated category shuttles and `false` for regular agents, including the base `shuttle` agent.
- The system shall populate `category.name` and `category.description` for generated category shuttles when the source category provides those values.
- The system shall avoid exposing raw category config beyond the approved safe template fields unless an additional field is intentionally added to the template context and documented.

**Proof Artifacts:**
- Test: prompt template using `{{agent.isCategory}}`, `{{category.name}}`, and `{{category.description}}` renders correct values for a generated category shuttle.
- Test: regular agents either omit `category` context or render category sections as absent according to existing template-renderer semantics.
- Test: composed prompt for a generated category shuttle includes category-specific `prompt_append` behavior and does not lose base prompt behavior.

### Unit 4: Runner effects and adapter materialization expose metadata

**Purpose:** Prove adapters and effect observers receive category metadata at the final materialization boundary.

**Functional Requirements:**
- The system shall pass category metadata to the descriptor received by `HarnessAdapter.spawnSubagent()` for generated category shuttles.
- The system shall ensure `RunAgentEffect.agentDescriptor` includes the same category metadata observed by the adapter.
- The system shall not emit category metadata for regular agents unless explicitly modeled as an absent or `false` category-derived value.
- The system shall update docs explaining how adapters should consume category name and patterns for routing/config generation while keeping concrete routing behavior adapter-owned.

**Proof Artifacts:**
- Test: `MockAdapter` spawn call for `shuttle-frontend` receives a descriptor with category metadata and file patterns.
- Test: `onEffect` receives a `RunAgentEffect` whose `agentDescriptor` preserves the same category metadata as the adapter descriptor.
- Documentation: `docs/adapter-boundary.md`, `docs/product-vision.md`, or a focused category metadata doc explains the descriptor contract and adapter ownership responsibilities.

## Non-Goals (Out of Scope)

1. **Harness-specific routing implementation**: This spec does not implement OpenCode, Pi, Claude Code, Codex, or other harness routing rules. Adapters decide how to use normalized category metadata.
2. **Glob expansion or file matching**: The engine shall preserve category `patterns` as declared, but it shall not scan project files or expand those patterns for adapters.
3. **New DSL syntax**: This spec does not add, remove, or rename `.weave` keywords, blocks, or fields.
4. **Explicit category-shuttle override semantics**: This spec does not permit explicit `agent shuttle-{category}` declarations to override generated category shuttles; existing collision behavior remains.
5. **Full Loom/Tapestry routing implementation**: This feature unblocks faithful routing metadata, but it does not implement the full routing path tracked by related issues.

## Design Considerations

No graphical UI or visual design changes are required.

Any user-visible or proof-artifact output should use stable, readable labels such as `shuttle-frontend`, `category.name: frontend`, and `category.patterns: ["src/components/**"]` so reviewers can confirm metadata preservation without reading raw internal objects.

## Repository Standards

- Follow the engine/adapter boundary in [`docs/adapter-boundary.md`](../../adapter-boundary.md): the engine owns normalized category shuttle descriptor generation, while adapters own concrete harness routing/config generation.
- Follow [`docs/product-vision.md`](../../product-vision.md): Weave describes agent topology, categories, delegation metadata, and normalized descriptors; adapters translate that intent into harness behavior.
- Use Bun exclusively for runtime, package scripts, typechecking, and tests.
- Use `neverthrow` result types for fallible generation/composition paths and keep expected errors typed.
- `WeaveRunner.run()` shall return a `ResultAsync` for expected category shuttle conflicts instead of converting those conflicts into thrown exceptions.
- Add isolated engine tests using mocks such as `MockAdapter`; do not launch a real harness or scan harness-owned resource directories.
- Keep prompt template context bounded to safe, documented fields in `template-context.ts`.
- Update documentation for this adapter-facing contract change before implementation is considered complete.
- Reference issue [#71](https://github.com/weave-io/weave/issues/71) in the Pull Request.

## Technical Considerations

- Existing category shuttle generation lives in `packages/engine/src/descriptors.ts` as `generateCategoryShuttles(config)`, currently returning generated `AgentConfig` records keyed by `shuttle-{category}`.
- Existing descriptor composition lives in `packages/engine/src/compose.ts`; `composeAgentDescriptor()` already accepts an optional `category?: CategoryInput`, but `WeaveRunner` currently calls it without category context.
- Existing template context support in `packages/engine/src/template-context.ts` already models `agent.isCategory`, optional `category.name`, and optional `category.description`; this spec requires wiring generated shuttles into that context correctly.
- Existing `AgentDescriptor` does not currently expose category patterns. Implementation will likely add a normalized optional metadata field such as `category?: { name; description?; patterns; isCategoryDerived }` or an equivalent public shape.
- Existing `RunAgentEffect` carries the composed `agentDescriptor`, so preserving metadata on the descriptor should make it available to effect observers without duplicating fields.
- Existing tests in `packages/engine/src/__tests__/descriptors.test.ts` and `packages/engine/src/__tests__/runner.test.ts` cover generation and runner materialization; they should be extended rather than bypassed.
- Latest-standards research summary: no external technology-specific standards research was needed because this feature defines an internal Weave engine descriptor contract over already-selected repository technologies. The material standards are repository-local: harness-neutral engine output, adapter-owned harness behavior, Bun-only runtime, `neverthrow` error modeling, bounded prompt template context, and mock-based testing.
- No tension with current external guidance was identified. The main design tension is internal: category metadata should be rich enough for adapters to route work, but not so rich that the engine starts owning harness-specific routing or file matching.

## Security Considerations

- Category patterns may reveal project path structure; they are already user-authored configuration, but proof artifacts should avoid adding unrelated absolute paths or private filesystem details.
- Descriptor and effect payloads must not include API keys, tokens, credentials, cookies, `.env` values, raw skill contents, or adapter-private metadata.
- Prompt template context should expose only safe projected category fields. Raw category config should not be made available wholesale to templates.
- The engine must not scan files matching category patterns because that could leak file paths or contents and would violate adapter/resource ownership boundaries.
- No authentication, authorization, token, crypto, or credential handling changes are expected.

## Success Metrics

1. **Descriptor completeness**: generated category shuttle descriptors expose category name, optional description, patterns, and category-derived identity.
2. **Prompt correctness**: generated category shuttle prompts render `agent.isCategory` and `category.*` fields correctly in tests.
3. **Adapter visibility**: `MockAdapter.spawnSubagent()` and `RunAgentEffect.agentDescriptor` both receive category metadata for generated category shuttles.
4. **Regression safety**: existing category shuttle inheritance, overrides, disabling, and collision behavior remain covered by tests.
5. **Boundary compliance**: documentation and code review show the engine preserves normalized metadata without implementing harness-specific routing or glob expansion.

## Open Questions

1. What exact field name should the public descriptor use for category metadata: `category`, `categoryMetadata`, or another name? The implementation should choose the clearest adapter-facing name and document it.
2. Should `CategoryInput` be expanded to include `patterns`, or should a separate descriptor metadata type be introduced to keep prompt context and adapter-facing metadata intentionally distinct?
