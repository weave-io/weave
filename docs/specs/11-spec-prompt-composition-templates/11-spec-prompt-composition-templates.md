# 11-spec-prompt-composition-templates.md

## Introduction/Overview

Weave will render agent prompt sources as Mustache Prompt Templates during engine-owned prompt composition. This lets built-in and user-authored prompt Markdown place generated data, especially delegation guidance, without exposing raw internal config or pushing composition rules into adapters.

The primary goal is to turn the ADR-defined prompt-template decision into a testable implementation contract for `@weave/engine`, while preserving existing static prompt behavior and adapter-boundary guarantees.

## Goals

- Render agent `prompt`, `prompt_file`, and `prompt_append` values as Mustache templates during `composeAgentDescriptor()`.
- Expose a bounded, documented Template Context with agent identity, optional category identity, effective tool policy, and generated delegation data.
- Generate delegation guidance as `delegation.targets` data for prompt templates to iterate over via `{{#delegation.targets}}` loops.
- Fail prompt composition with typed, source-aware `PromptTemplateError` errors for unsafe paths, unknown paths, unsupported Mustache features, malformed templates, function values, and unresolved tags.
- Update built-in prompts and tests so rendered composed prompts contain no unresolved template tags and no repository- or harness-specific leakage.

## User Stories

- **As a Weave user customizing an agent prompt**, I want to place generated delegation guidance where it fits my prompt so that I can keep routing instructions coherent without hand-copying target lists.
- **As a Weave maintainer**, I want prompt composition to render a small Mustache subset in the engine so that adapters receive final composed prompts and do not duplicate prompt logic.
- **As a prompt author**, I want strict errors for typos and unsafe template paths so that broken prompt templates fail early instead of silently producing misleading prompts.
- **As a future adapter implementer**, I want the Template Context to be bounded and stable so that prompt customization does not depend on raw `WeaveConfig` or adapter internals.
- **As a reviewer**, I want built-in prompt rendering covered by behavior tests so that dynamic prompt defaults remain safe, harness-agnostic, and regression-resistant.

## Demoable Units of Work

### Unit 1: Mustache Renderer Wrapper

**Purpose:** Establish a safe, engine-owned rendering utility that uses the canonical `mustache` package while enforcing Weave's prompt-template rules.

**Functional Requirements:**

- The system shall add the canonical `mustache` package to `@weave/engine`, plus package-provided types or `@types/mustache` if needed.
- The system shall provide an internal renderer module, `packages/engine/src/template-renderer.ts`, that parses templates, extracts real Mustache references, and renders parsed templates using `neverthrow` result types.
- The system shall support escaped variables, unescaped triple-brace variables, dotted names, comments, sections, inverted sections, list iteration, and `{{.}}`.
- The system shall reject partials, delimiter changes, lambdas, helpers, function values, filesystem access, environment access, prototype traversal, and other executable or unsafe behavior.
- The system shall support backslash-literal tag openings such as `\{{agent.name}}`, restoring them as literal text after rendering and excluding them from reference detection.
- The system shall report typed template errors with source locations when available.

**Proof Artifacts:**

- Test: `bun test packages/engine/src/__tests__/template-renderer.test.ts` demonstrates supported Mustache rendering, reference extraction, escaped literals, and unsupported-feature failures.
- Test: renderer tests for unknown, unsafe, and function-valued paths demonstrate strict path enforcement.
- CLI: `bun run --filter '@weave/engine' test` demonstrates the renderer integrates with the engine package test suite.

### Unit 2: Template Context and Delegation Diagram

**Purpose:** Provide the bounded public data projection that prompt templates can safely reference, including generated delegation guidance.

**Functional Requirements:**

- The system shall add `packages/engine/src/template-context.ts` containing the `AgentPromptTemplateContext` type, allowed-path metadata, and context builder helpers.
- The Template Context shall include `agent.name`, optional `agent.description`, `agent.mode`, `agent.skills`, and `agent.isCategory`.
- The Template Context shall include `category.name` and optional `category.description` only for generated category shuttle agents.
- The Template Context shall include only effective tool policy values under `toolPolicy.effective.read`, `write`, `execute`, `delegate`, and `network`.
- The Template Context shall include `delegation.targets` as an array of eligible delegation targets; each target exposes `name`, optional `description`, deduplicated `domains`, and `triggers` details.
- ~~The system shall generate `delegation-mermaid` as a Mermaid `flowchart TD` current-agent star using stable synthetic node IDs, escaped labels, and deduplicated trigger-domain edge labels.~~ **[SUPERSEDED — see Amendment below]**
- ~~The system shall generate `delegation-section` as canonical Markdown containing a `## Delegation` heading, the Mermaid diagram, and compact bullets with target descriptions and trigger details.~~ **[SUPERSEDED — see Amendment below]**

**Proof Artifacts:**

- Test: `bun test packages/engine/src/__tests__/template-context.test.ts` demonstrates context shape, category omission, allowed optional paths, and no raw config exposure.
- Test: delegation context tests demonstrate `delegation.targets` array shape, domain deduplication, trigger details, and empty array when no targets exist.
- Typecheck: `bun run --filter '@weave/engine' typecheck` demonstrates exported context/error types compile without exposing renderer internals.

### Unit 3: Compose Pipeline Integration

**Purpose:** Integrate template rendering into agent prompt composition while preserving existing fallback behavior and adapter-boundary ownership.

**Functional Requirements:**

- The system shall update `composeAgentDescriptor()` so the primary prompt source and merged `prompt_append` are rendered as Mustache templates with the same Template Context.
- ~~The system shall insert fallback `delegation-section` after the rendered primary source and before rendered `prompt_append` only when eligible delegation targets exist and the primary source has no real `delegation.*` token.~~ **[SUPERSEDED — see Amendment below]**
- ~~The system shall treat only parsed primary-source variable, section, or inverted-section tokens whose path starts with `delegation` as fallback-suppressing references.~~ **[SUPERSEDED — see Amendment below]**
- ~~The system shall not let `prompt_append` delegation references suppress fallback delegation.~~ **[SUPERSEDED — see Amendment below]**
- The system shall preserve existing static prompt behavior when prompt sources contain no Mustache tags.
- The system shall extend `ComposeError` with one `PromptTemplateError` variant containing `agentName`, `sourceKind`, optional `promptFilePath`, message, and nested reason discriminants.
- The system shall continue returning `ResultAsync<AgentDescriptor, ComposeError>` and shall not use `try/catch` for expected composition failures.

**Proof Artifacts:**

- Test: updated `packages/engine/src/__tests__/compose.test.ts` demonstrates inline prompt rendering, prompt-file rendering, rendered append behavior, `delegation.targets` iteration, and typed template errors.
- Test: composed static prompt tests demonstrate backward compatibility for existing custom prompts without template tags.
- CLI: `bun run --filter '@weave/engine' test` demonstrates the compose pipeline remains isolated from real harnesses.

### Unit 4: Built-in Prompt and Documentation Alignment

**Purpose:** Update built-in prompts and project documentation so the shipped defaults use template fields naturally and rendered prompts remain safe.

**Functional Requirements:**

- The system shall update built-in prompt Markdown only where Template Context fields improve clarity; prompts shall not contain artificial tags just to prove templating.
- ~~The system shall place `{{{delegation-section}}}` in built-in delegating prompts where those prompts should control routing guidance placement.~~ **[SUPERSEDED — see Amendment below]** Built-in delegating prompts use `{{#delegation.targets}}` iteration loops instead.
- The system shall update built-in prompt tests to allow Mustache placeholders in source files while continuing to reject repository-only or harness-specific leakage.
- The system shall add rendered builtin composition tests that fail if unresolved unescaped Mustache tags remain in composed prompts.
- The system shall keep `docs/prompt-composition.md`, ADR 0001, and `CONTEXT.md` aligned with the implemented behavior.

**Proof Artifacts:**

- Test: `bun test packages/config/src/__tests__/builtin-prompts.test.ts` demonstrates source prompt files remain substantive and leakage-free while allowing intentional Mustache placeholders.
- Test: `bun test packages/config/src/__tests__/builtin-compose-smoke.test.ts` demonstrates all built-ins compose successfully, delegating prompts include delegation guidance via `{{#delegation.targets}}` iteration, and no unresolved unescaped tags leak.
- Documentation: `docs/prompt-composition.md` and `docs/adr/0001-prompt-composition-templates.md` demonstrate the implemented contract and rationale.

## Non-Goals (Out of Scope)

1. **Workflow step prompt templating**: Workflow prompt interpolation is conceptually aligned but not implemented in this slice; it should use a workflow-specific Template Context later.
2. **Raw config exposure**: Templates shall not receive raw `WeaveConfig`, `AgentConfig`, all-agent maps, prompt file paths, model lists, temperature, adapter internals, or process/environment data.
3. **Mustache partial support**: This slice shall reject partials and shall not load partial files or accept partial maps.
4. **Custom helpers or executable template behavior**: This slice shall not add helpers, lambdas, functions, JavaScript evaluation, filesystem access, or environment access.
5. **Full delegation graph modeling**: Delegation Diagram generation starts as a current-agent star and shall not model all agent-to-agent routes or workflow graphs.
6. **New DSL opt-in fields**: All agent prompt sources are rendered as templates; no new `.weave` field is added to enable or disable prompt templating.

## Design Considerations

No UI design requirements identified. The user-facing design surface is Markdown prompt output.

Generated delegation guidance should be readable in plain Markdown and useful to LLMs:

- Use `{{#delegation.targets}}` iteration loops in prompt templates to render delegation guidance inline.
- Each target exposes `name`, optional `description`, `domains`, and `triggers` for flexible formatting.
- Use triple braces for Markdown-rich context values when needed (e.g. `{{{agent.description}}}`).

> **Amendment**: `delegation-section` and `delegation-mermaid` were removed after initial implementation. The fallback-append logic was also removed. See the Amendment section below.

## Repository Standards

- Use Bun for runtime, package management, tests, and builds; do not introduce Node runtime APIs such as `fs` or `child_process`.
- Use `neverthrow` result types for fallible rendering and composition paths.
- Keep prompt composition in `@weave/engine`; adapters consume final `AgentDescriptor` values and do not render templates.
- Keep prompt-file path resolution in `@weave/config` and prompt text composition in `@weave/engine`.
- Follow existing package test patterns with `bun:test` and isolated tests; do not start real harnesses in unit or integration tests.
- Update docs for non-trivial behavior changes, especially prompt composition, adapter boundary implications, and glossary terms.
- Avoid leaking Weave-repo implementation details or harness-specific tool names into built-in prompt defaults.

## Technical Considerations

- Current repository context: `packages/engine/src/compose.ts` owns `AgentDescriptor`, delegation target filtering, prompt source loading, and final composed prompt assembly.
- Current repository context: `packages/config/src/builtins.ts` defines built-in agents, while prompt Markdown lives under `packages/config/prompts/` and is resolved before composition.
- Current repository context: existing tests include `packages/engine/src/__tests__/compose.test.ts`, `packages/config/src/__tests__/builtin-prompts.test.ts`, and `packages/config/src/__tests__/builtin-compose-smoke.test.ts`.
- Add `mustache` as an `@weave/engine` dependency because rendering is engine-owned.
- Export Template Context and template error types from `@weave/engine`, but keep the low-level renderer internal for the first slice.
- Renderer validation should use explicit allowed-path metadata beside the Template Context type/builder so typos fail and allowed optional paths can be falsey.
- The wrapper should parse once, inspect token metadata for real references and unsupported tags, then render with the bounded Template Context.
- `prompt_append` errors report line/column in the merged append text; fragment provenance between base and category append sources is deferred.
- Current Mustache guidance reviewed via Context7 for `/mustache/mustache` describes Mustache as logic-free templates with variables, escaped-by-default interpolation, triple braces for unescaped output, sections, inverted sections, comments, partials, delimiter changes, and template/token inspection. This spec intentionally accepts the logic-light subset needed by Weave while rejecting partials, delimiter changes, and lambdas to keep the public prompt API small and safe.

## Security Considerations

- Template Context must be pure data only; functions and callable values are rejected to prevent Mustache lambda behavior.
- Renderer path validation must reject prototype traversal and unsafe paths such as `__proto__`, `constructor`, and similar object internals.
- Templates must not access filesystem, environment variables, process data, credentials, tokens, secrets, adapter internals, or raw config objects.
- Rendered output must be checked for unresolved unescaped Mustache tags so broken templates do not silently leak placeholders into prompts.
- Built-in prompt tests must continue rejecting repo-only or harness-specific leakage tokens.
- Because this feature touches input validation and template rendering, implementation should receive a Warp security review before completion.

## Success Metrics

1. **Template rendering coverage**: renderer, context, compose, and builtin prompt tests cover supported tags, rejected features, strict paths, fallback delegation, and unresolved-tag checks.
2. **Backward compatibility**: existing static prompts compose to equivalent text except for intentional Mermaid-based delegation formatting changes in delegating prompts.
3. **Adapter boundary preservation**: adapters receive final composed prompts with no unresolved unescaped Mustache tags and no new adapter-side rendering responsibility.
4. **Documentation alignment**: ADR 0001, `docs/prompt-composition.md`, and `CONTEXT.md` match the implemented behavior.

## Amendment: Removal of `delegation-section`, `delegation-mermaid`, and Fallback-Append Logic

**Date:** Post-implementation (after 2026-05-19)

**Summary:** The following requirements were implemented and subsequently removed:

- `delegation-section` — pre-rendered Markdown block containing `## Delegation`, a Mermaid diagram, and compact bullets
- `delegation-mermaid` — pre-rendered Mermaid `flowchart TD` diagram string
- Fallback-append logic — automatic insertion of `delegation-section` when the primary prompt source did not reference `delegation.*`
- Fallback suppression detection — checking primary source tokens for `delegation.*` references

**Reason:** The pre-rendered string approach was superseded. Prompt authors now use `{{#delegation.targets}}` iteration loops directly in their prompt Markdown, giving them full control over formatting without relying on engine-generated Markdown strings.

**Current supported pattern:**

```md
{{#delegation.targets}}
- **{{name}}**: {{description}}
{{/delegation.targets}}
```

**What remains:**

- `delegation.targets` — array of eligible delegation targets (always present, may be empty)
- Each target: `name`, optional `description`, `domains` (deduplicated string array), `triggers` (array of `{ domain, trigger }`)
- `{{#delegation.targets}}` / `{{/delegation.targets}}` — standard Mustache section iteration

**Affected requirements:** Unit 2 (FR-2) requirements for `delegation-section`/`delegation-mermaid` generation, Unit 3 (FR-3) fallback-insertion and suppression requirements, and Unit 4 (FR-4) `{{{delegation-section}}}` placement in builtin prompts are all superseded by this amendment.

## Open Questions

No open questions at this time.
