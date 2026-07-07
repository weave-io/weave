# 16-spec-stable-adapter-descriptor-contract.md

## Introduction/Overview

Define the stable adapter-facing descriptor contract for Weave agent materialization, addressing issue [#72](https://github.com/weave-io/weave/issues/72). The feature makes it explicit what fields adapters can rely on when translating engine output into concrete harness resources, while preserving the boundary that the engine owns normalized descriptor construction and adapters own harness-specific materialization.

The primary goal is to document and type `AgentDescriptor` as the stable adapter-facing contract that covers identity, prompts, model intent, abstract tool policy, delegation metadata, category metadata as an already-defined field family, disabled-entry behavior, and first-milestone exclusions such as workflow and command materialization.

This spec is intentionally distinct from [Spec 14 — Preserve Category Metadata](../14-spec-preserve-category-metadata/14-spec-preserve-category-metadata.md). Spec 14 owns the mechanics of preserving category provenance from `category` config through generated shuttles and prompt composition. This spec owns the broader adapter-facing descriptor contract and documents how category metadata fits into that contract without redefining category generation or routing behavior. It also complements [Spec 15 — Adapter-Facing Materialization API](../15-spec-adapter-facing-materialization-api/15-spec-adapter-facing-materialization-api.md), which owns the public API that returns materialized descriptors.

## Goals

- Establish `AgentDescriptor` as the exported, stable adapter-facing descriptor type from `@weaveio/weave-engine`.
- Clarify descriptor identity semantics, including stable internal `name`/id and optional `displayName` presentation metadata.
- Define which prompt, model, policy, skill, delegation, and category fields adapters may consume without relying on transitional runner behavior.
- Document what adapters remain responsible for after receiving descriptors, including concrete model resolution, tool-name mapping, file generation, and feature-gap emulation.
- Add representative tests proving the descriptor shape for builtin agents, custom agents, and generated category shuttles.

## User Stories

- **As an adapter author**, I want a stable descriptor type so that I can generate harness-specific agents without reverse-engineering `WeaveRunner` internals.
- **As an OpenCode adapter maintainer**, I want clear `name` versus display-name semantics so that generated OpenCode resources use stable ids while presenting readable labels where supported.
- **As a future adapter implementer**, I want model and tool-policy fields documented as abstract intent so that I know which decisions belong in my adapter.
- **As an engine maintainer**, I want descriptor tests for builtin, custom, and category agents so that future changes do not accidentally break adapter consumers.
- **As a Weave user**, I want disabled agents and category shuttles to be omitted predictably so that generated harness configuration matches my `.weave` intent.

## Demoable Units of Work

### Unit 1: Stable `AgentDescriptor` Type and Identity Semantics

**Purpose:** Establish the exported adapter-facing descriptor vocabulary and clarify how adapters should interpret agent identity fields.

**Functional Requirements:**
- The system shall export and document `AgentDescriptor` from `@weaveio/weave-engine` as the stable adapter-facing descriptor type.
- The descriptor shall include a stable harness-neutral internal identifier field, currently represented by `name`.
- The descriptor shall include an optional `displayName` field for presentation metadata when configured or derived by engine-owned descriptor composition.
- The descriptor contract shall document that `displayName` is not a stable identifier and must not replace `name` for adapter resource identity.
- The descriptor contract shall document that concrete harness label formatting remains adapter-owned when a harness requires labels that differ from Weave's optional `displayName` value.
- The descriptor contract shall avoid harness-specific field names such as OpenCode plugin ids, Claude Code file names, or Pi runtime ids.

**Proof Artifacts:**
- Test: descriptor type import from `@weaveio/weave-engine` demonstrates adapter consumers can import the stable public type.
- Test: representative builtin descriptor demonstrates stable `name`/id semantics and optional `displayName` behavior.
- Documentation: descriptor field table demonstrates internal id versus display-name semantics.
- Typecheck: `bun run typecheck` demonstrates the public descriptor type compiles for engine and adapter packages.

### Unit 2: Prompt, Model, Policy, Skill, and Delegation Fields

**Purpose:** Define the non-category descriptor fields adapters can consume and which responsibilities remain adapter-owned.

**Functional Requirements:**
- The descriptor shall expose `composedPrompt` as the final prompt string adapters receive; raw `prompt`, `prompt_file`, and `prompt_append` shall not be adapter-facing descriptor inputs.
- The descriptor shall expose ordered `models` as model intent only; concrete model availability checks, selected-model lookup, fallback selection, and harness-specific model field formatting shall remain adapter responsibilities.
- The descriptor shall expose abstract `rawToolPolicy` and `effectiveToolPolicy` fields; concrete tool-name mapping and permission enforcement shall remain adapter responsibilities.
- The descriptor shall expose trigger/delegation metadata in a harness-neutral shape sufficient for adapters to materialize routing or subagent affordances where supported.
- The descriptor shall expose requested skill names only; any future safe resolved-skill reference shape shall be handled by a separate spec.

**Proof Artifacts:**
- Test: custom agent descriptor demonstrates composed prompt, ordered models, abstract policy fields, requested skill names, and delegation targets are present in the documented shape.
- Test: prompt source test demonstrates descriptors contain `composedPrompt` and do not expose raw prompt source fields as adapter inputs.
- Documentation: adapter boundary update demonstrates model resolution and concrete tool mapping remain adapter-owned.
- Code review artifact: descriptor type contains no concrete harness tool names, harness model registry state, or adapter-private skill metadata.

### Unit 3: Category Metadata and Disabled-Entry Representation

**Purpose:** Document category metadata as part of the stable descriptor contract while leaving category metadata preservation mechanics to the dedicated category metadata spec.

**Functional Requirements:**
- The descriptor contract shall include category metadata for generated category shuttles, including source category name, optional category description, and declared category file patterns, as provided by the category metadata implementation.
- The descriptor contract shall state that category patterns are preserved exactly as declared in validated config without expanding globs, scanning project files, or applying harness-specific routing rules in the engine.
- The descriptor shall omit category metadata for regular non-category agents, or represent it as an explicitly absent optional field.
- The system shall omit disabled agents and suppressed generated category shuttles from descriptor materialization rather than emitting descriptors marked as disabled.
- The descriptor contract shall document that workflow and command materialization are out of scope for the first adapter milestone and are not included in `AgentDescriptor`.

**Proof Artifacts:**
- Test: generated `shuttle-frontend` descriptor demonstrates category name, optional description, and patterns are present in the documented `AgentDescriptor` shape once category metadata preservation is implemented.
- Test: regular agent descriptor demonstrates category metadata is absent for non-category agents.
- Test: disabled declared agents and disabled/suppressed category shuttles are omitted from descriptor output.
- Documentation: stable descriptor contract states workflows and commands are intentionally out of scope for this descriptor.

### Unit 4: Documentation, Compatibility, and Boundary Alignment

**Purpose:** Make the contract discoverable from existing docs and align it with adjacent specs for materialization and category metadata.

**Functional Requirements:**
- The documentation shall link the stable descriptor contract from `docs/adapter-boundary.md` using the correct `16-spec-stable-adapter-descriptor-contract` path.
- The documentation shall explain that this spec complements the adapter-facing materialization API spec and the category metadata spec rather than replacing either one.
- The system shall preserve existing compatible runner behavior while making the stable descriptor contract testable without launching a real harness.
- The system shall use isolated engine tests and mock adapter fixtures where adapter interaction is needed.
- The documentation shall state that adapters own concrete harness output, including generated files, plugin entries, commands, hooks, concrete model fields, and concrete permission mappings.

**Proof Artifacts:**
- Documentation: `docs/adapter-boundary.md` links to this spec and summarizes the stable descriptor contract.
- Documentation: this spec or related docs cross-link to the adapter-facing materialization API and category metadata specs.
- Test: existing runner tests continue to pass, demonstrating compatibility for current adapter callers.
- CLI: `bun test packages/engine/src` demonstrates descriptor-contract tests pass with existing engine tests.

## Non-Goals (Out of Scope)

1. **Implementing OpenCode adapter generation**: This spec defines what adapters receive; it does not generate OpenCode plugin files, commands, agents, or config entries.
2. **Replacing the materialization API spec**: This spec defines `AgentDescriptor` shape and semantics. [Spec 15 — Adapter-Facing Materialization API](../15-spec-adapter-facing-materialization-api/15-spec-adapter-facing-materialization-api.md) defines how adapters request descriptors from the engine.
3. **Duplicating category metadata preservation**: This spec documents category metadata as part of the stable descriptor contract. [Spec 14 — Preserve Category Metadata](../14-spec-preserve-category-metadata/14-spec-preserve-category-metadata.md) owns the preservation mechanics, prompt-context wiring, and generated-shuttle provenance behavior.
4. **Workflow and command materialization**: Workflow descriptors, command descriptors, hook registration, and runtime lifecycle wiring remain outside the first adapter descriptor contract.
5. **Concrete model or tool resolution**: The engine shall not choose harness-specific model ids, inspect selected model state, or map abstract tool policy to concrete harness tool names in this feature.
6. **Harness resource discovery or mutation**: The engine shall not scan harness-owned directories, read harness runtime state, write harness config files, or launch harness processes.

## Design Considerations

No graphical UI design requirements identified. This is an engine API and documentation feature.

The developer experience should emphasize predictable, readable contract documentation for adapter authors. Descriptor examples should use familiar agent names such as `loom`, `shuttle`, and `shuttle-frontend`, and should label fields in plain language so a junior developer can distinguish engine-owned normalized intent from adapter-owned concrete output.

## Repository Standards

- Follow `docs/adapter-boundary.md`: engine APIs construct normalized descriptors from Weave config and explicit adapter-provided context; adapters own harness resource discovery and concrete materialization.
- Follow `docs/product-vision.md`: Weave describes agent topology, prompts, delegation metadata, categories, ordered model preferences, skill references, and abstract policy intent; adapters translate that intent into harness behavior.
- Use Bun-only workflows and commands: `bun run typecheck`, `bun test`, and package-local Bun tests where appropriate.
- Use `neverthrow` result types for expected fallible composition or materialization paths; do not introduce new expected-failure throws.
- Use discriminated union error types if new descriptor-contract errors or materialization errors are required.
- Keep tests isolated with in-memory fixtures and mock adapters. Do not launch real harnesses, write real harness resources, or depend on live adapter processes.
- Export public engine APIs and public descriptor types from `packages/engine/src/index.ts`.
- Update living documentation for this adapter-facing contract before implementation is considered complete.
- Mention issue #72 in any Pull Request created for this work.

## Technical Considerations

- Existing descriptor composition lives in `packages/engine/src/compose.ts`, where `AgentDescriptor` currently includes `name`, optional `description`, `composedPrompt`, `models`, `mode`, optional `temperature`, `effectiveToolPolicy`, `rawToolPolicy`, `delegationTargets`, and `skills`.
- The stable contract should formalize `AgentDescriptor` rather than creating a parallel adapter descriptor shape.
- `displayName` should be added as optional engine-owned presentation metadata on `AgentDescriptor`. Adapters must still treat `name` as the stable internal id and may apply harness-specific label formatting when needed.
- Category metadata should align with [Spec 14 — Preserve Category Metadata](../14-spec-preserve-category-metadata/14-spec-preserve-category-metadata.md) and should remain normalized: category name, optional description, and declared patterns only. This spec should not duplicate category-generation mechanics, and the engine must not expand globs or perform harness routing.
- [Spec 15 — Adapter-Facing Materialization API](../15-spec-adapter-facing-materialization-api/15-spec-adapter-facing-materialization-api.md) should remain responsible for the function that returns descriptors. This spec should define the stable descriptor fields that API returns.
- Disabled agents and suppressed category shuttles should be omitted from materialization output. Adapters should not need to handle descriptors that are present only to say they are disabled.
- Trigger and delegation metadata should remain harness-neutral. Adapters decide whether that metadata becomes generated commands, subagent references, UI affordances, plugin configuration, or documented unsupported behavior.
- Skill fields remain requested skill names only. They must not expose adapter-owned paths, raw skill contents, secrets, tokens, resolved skill payloads, or harness-specific skill metadata.
- Latest-standards research summary: no external technology-specific research was needed because this feature defines an internal Weave contract using repository-established TypeScript, Bun, `neverthrow`, and adapter-boundary patterns. No new external API, framework behavior, cloud service, security standard, or third-party integration materially affects the spec.
- No tension with current external guidance was identified. The material design tension is internal: the descriptor must be complete enough for adapters to generate useful harness resources without moving concrete harness decisions into the engine.

## Security Considerations

- Descriptor output may include composed prompt text and user-authored configuration. Proof artifacts should not include secrets, private prompt contents, credentials, tokens, cookies, or `.env` values.
- The engine must not read or expose harness-owned secret stores, environment files, selected model state, runtime sessions, or adapter-private metadata while building descriptors.
- Skill-related descriptor fields must avoid leaking skill file paths, raw skill contents, installation locations, tokens, or credentials discovered by adapters.
- Category patterns may reveal project path structure. They should be preserved only because they are user-authored config, and proof artifacts should avoid adding unrelated absolute paths or private filesystem details.
- Abstract `rawToolPolicy` and `effectiveToolPolicy` are intent fields, not enforcement proof. Adapters remain responsible for translating and enforcing concrete harness permissions safely.
- Because this work touches adapter boundaries, prompt materialization, tool policy, and possible metadata exposure, the eventual implementation plan or completed work should receive Warp security review before merge.

## Success Metrics

1. **Stable type availability**: Adapter packages can import `AgentDescriptor` from `@weaveio/weave-engine` as the stable adapter-facing descriptor type without depending on runner internals.
2. **Acceptance coverage**: Tests assert descriptor shape for representative builtin, custom, and generated category agents.
3. **Boundary clarity**: `docs/adapter-boundary.md` links to this spec and clearly distinguishes engine-owned descriptor construction from adapter-owned concrete materialization.
4. **Field semantics complete**: Contract documentation covers id/name/display-name semantics, prompt expectations, model intent, abstract tool policy, delegation metadata, category metadata, and disabled-entry behavior.
5. **No scope creep**: Workflow and command materialization remain explicitly out of scope for the first adapter milestone.

## Open Questions

No open questions at this time.
