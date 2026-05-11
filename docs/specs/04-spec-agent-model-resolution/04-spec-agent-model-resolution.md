# 04-spec-agent-model-resolution.md

## Introduction/Overview

Weave should not query or depend on a harness user's currently selected UI model. Weave is a harness-agnostic prompt and agent-configuration builder: it reads `.weave` DSL, produces normalized agent intent, and gives adapters enough information to translate that intent into a harness-specific plugin or configuration.

This feature ports the useful parts of legacy `resolveAgentModel()` by moving model-selection policy to the adapter boundary. Weave preserves declarative model intent (`mode`, ordered `models`, category model preferences, and generated category shuttles), while adapters resolve concrete harness model fields using their own UI and runtime context.

## Goals

- Preserve Weave's role as a harness-agnostic configuration and prompt-building API, not a live harness UI integration layer.
- Keep `.weave` `models [...]` as an ordered model preference/fallback list for agents and categories.
- Make agent `mode` meaningful as adapter-facing metadata: `primary` and `all` may inherit harness-selected/default behavior; `subagent` should prefer explicit Weave model preferences.
- Generate category-specific shuttle agent descriptors so Loom/Tapestry prompts can delegate to concrete category agents.
- Provide a pure adapter-facing model-resolution helper or documented translation contract that adapters can use with explicit harness context.
- Avoid adding engine-to-adapter methods for current UI-selected model discovery.

## User Stories

- **As a framework user**, I want to declare model preferences in `.weave` so that adapters can translate them into the harness-specific model configuration without me learning each harness's internal format.
- **As an adapter author**, I want Weave to give me normalized agent descriptors with `mode`, `models`, category metadata, and prompts so that I can decide how those map to my harness's UI-selected model and model registry.
- **As a framework contributor**, I want model intent handled at the adapter boundary so that Weave remains portable across OpenCode, Pi, Claude Code, Codex, and future harnesses.
- **As a Loom/Tapestry prompt consumer**, I want category shuttle agents to exist as named descriptors so that delegation instructions can reference real agents such as `shuttle-frontend`.
- **As a maintainer**, I want the legacy OpenCode-specific behavior documented as adapter translation behavior rather than core Weave runtime behavior.

## Demoable Units of Work

### Unit 1: Model Intent Contract

**Purpose:** Define the normalized model intent that Weave produces for adapters without resolving harness UI state.

**Functional Requirements:**

- The system shall document that `AgentConfig.models` is an ordered model preference list, not a scalar concrete model field.
- The system shall document that `CategoryConfig.models` is an ordered model preference list for category-specific agents.
- The system shall document that `AgentConfig.mode` communicates adapter-facing behavior:
  - `primary`: adapter may use the harness-selected/default model when the harness supports that concept.
  - `subagent`: adapter should prefer the agent's explicit `models` preference list before harness defaults.
  - `all`: adapter may expose the agent in both primary and subagent contexts and choose the harness-specific mapping that best fits that harness.
- The system shall not add a scalar `model` DSL keyword in this spec.
- The system shall not treat builtin `models` entries as per-agent overrides that outrank harness UI behavior.
- The system shall not require Weave core or engine code to query current UI model state from adapters.

**Proof Artifacts:**

- Documentation: a new or updated `docs/model-resolution.md` explains model intent, adapter responsibilities, and why Weave does not query UI-selected model state.
- Test or typecheck: existing core schema tests continue to prove `models` arrays and `mode` enum values are accepted without adding a new scalar `model` field.

### Unit 2: Adapter-Facing Resolution Helper

**Purpose:** Port the legacy resolution priority as a pure helper or contract that adapters can call with explicit harness context.

**Functional Requirements:**

- The system shall provide a pure function, for example `resolveAdapterModelIntent()`, in an adapter-facing location agreed during implementation.
- The helper shall accept all harness-dependent inputs as explicit arguments supplied by the adapter, including:
  - current UI-selected model, when the harness exposes one
  - available model IDs, when the harness exposes a model registry
  - harness/system default model
  - optional per-agent adapter override
- The helper shall accept Weave-supplied intent inputs, including:
  - agent name
  - effective agent mode
  - agent model preference list
  - optional category model preference list
- The helper shall resolve candidate models in this priority order when an adapter chooses to use the helper:
  1. Adapter-supplied per-agent override.
  2. Adapter-supplied UI-selected model for `primary` and applicable `all` mode mappings.
  3. First available category model preference.
  4. First available agent model preference.
  5. Adapter-supplied system default.
  6. Documented fallback constant only if no system default is supplied.
- The helper shall return structured metadata containing the resolved model and source branch so adapter tests can prove which priority won.
- The helper shall not call any adapter method, global harness API, environment API, or UI API directly.

**Proof Artifacts:**

- Test: model-resolution tests demonstrate override precedence, UI-selected model handling when explicitly supplied, subagent behavior, category preference handling, fallback preference handling, system default fallback, and final constant fallback.
- CLI output: the relevant package test command passes, depending on whether the helper is adapter-local or extracted to a shared adapter utility package.

### Unit 3: Adapter Contract Boundary

**Purpose:** Ensure the Weave-to-adapter boundary passes normalized intent and prompts, not live UI queries or engine-resolved concrete model state.

**Functional Requirements:**

- The system shall not add `getSelectedModel()` or `getAvailableModels()` to the core `HarnessAdapter` interface for Weave engine use.
- The system shall preserve adapter ownership of harness interactions, including UI-selected model lookup, model availability lookup, and harness-specific default selection.
- The system shall document that adapters may use the adapter-facing resolution helper internally, but are not required to if the harness has a different native model-selection mechanism.
- The system shall keep Weave-generated agent config immutable from the adapter's perspective: adapters translate the config, they do not mutate the normalized Weave source of truth.
- The system shall update any runner or adapter tests that previously assumed the engine resolves a concrete model before spawning agents.

**Proof Artifacts:**

- Typecheck: `bun run typecheck` passes without adding UI-query methods to `HarnessAdapter`.
- Test: mock adapter tests demonstrate that Weave passes agent config/model intent through the adapter boundary without requiring harness UI state.
- Documentation: adapter guidance explains that the adapter is analogous to a Neovim user/plugin layer: it consumes Weave's API and builds the concrete harness experience.

### Unit 4: Category Shuttle Descriptors

**Purpose:** Ensure category-specific agents exist as Weave-generated descriptors so prompts can refer to them and adapters can translate their model preferences.

**Functional Requirements:**

- The system shall generate one logical category shuttle descriptor named `shuttle-{categoryName}` for each configured category when the base `shuttle` agent exists.
- The generated category shuttle descriptor shall inherit from the base `shuttle` agent config.
- The generated category shuttle descriptor shall carry category-specific model intent from `category.models` without resolving it to a concrete harness model inside Weave.
- The generated category shuttle descriptor shall apply category-supported overrides from current schemas where applicable:
  - `category.temperature` overrides temperature when defined.
  - `category.prompt_append` appends to prompt context when prompt composition supports it.
  - `category.tool_policy` merges over the base shuttle `tool_policy` when defined.
- The generated category shuttle descriptor shall have effective mode `subagent` unless a future spec introduces a different category-agent mode rule.
- The system shall skip a category shuttle when either the base `shuttle` agent is disabled or `disabled.agents` contains the generated `shuttle-{categoryName}` name.
- The system shall leave category glob matching and runtime routing decisions out of scope; this unit only creates descriptors that prompts and adapters can reference.

**Proof Artifacts:**

- Test: category descriptor tests demonstrate that a config with `category frontend { models [...] }` produces a `shuttle-frontend` descriptor with inherited shuttle config and category model preferences.
- Test: disabled-agent tests demonstrate that disabled base shuttle or disabled generated category shuttle names suppress category descriptor creation.
- Documentation: model-resolution docs describe how adapters should treat category model preferences when translating category shuttles.

## Non-Goals (Out of Scope)

- Querying the current UI-selected model from Weave core or engine.
- Adding `getSelectedModel()` or `getAvailableModels()` to `HarnessAdapter` for engine-driven model resolution.
- Adding a scalar `model` keyword to the `.weave` DSL.
- Changing `models [...]` merge semantics or schema validation.
- Making the system default model configurable in `.weave` config.
- Implementing full OpenCode, Pi, Claude Code, or Codex adapter integrations.
- Loading prompt file contents beyond existing prompt path/config handling.
- Implementing category glob matching, runtime routing, or actual agent delegation execution.
- Guaranteeing that every harness can support UI-selected model inheritance; adapters document their own behavior.

## Design Considerations

No specific visual UI design requirements identified. The key experience requirement is conceptual: users should be able to treat Weave like an API for building an agent harness experience, similar to how Neovim exposes APIs that users and plugins compose into an editor.

Model behavior should therefore be described as intent in Weave and realized by adapters. A user reading `.weave` should understand the intended agent topology, prompts, capabilities, and model preferences without needing to know how a specific harness stores or discovers its selected model.

## Repository Standards

Implementation should follow established repository patterns and conventions:

- Use Bun for all scripts, builds, and tests.
- Use `bun:test` for unit tests.
- Use TypeScript types exported from `@weave/core` rather than duplicating schema shapes.
- Keep harness UI concerns inside adapter implementations or adapter-facing helpers.
- Keep tests isolated with mocks; do not start real harness processes.
- Use structured pino logging where runtime logging is needed; do not use `console.*`.
- Preserve the DSL-first architecture: builtins and user config express model preferences through `.weave` declarations.
- If new fallible APIs are introduced, model expected failures explicitly following the repository's `neverthrow` guidance.
- Update living documentation in `docs/` for model intent, adapter responsibilities, and category shuttle descriptor behavior.

## Technical Considerations

- **Architecture boundary:** Weave is comparable to Neovim's API layer. It exposes normalized primitives for building a harness experience; adapters/plugins compose those primitives into concrete harness behavior.
- **Current schema constraint:** `AgentConfig` and `CategoryConfig` expose `models?: string[]`, not scalar `model`. This spec intentionally preserves that decision.
- **Legacy behavior mapping:** Legacy OpenCode behavior that used a UI-selected model should be reinterpreted as OpenCode adapter translation behavior, not engine behavior.
- **Helper placement:** Prefer an adapter-local helper or a future shared adapter utility package. If a temporary shared helper is placed outside an adapter, it must remain adapter-facing and context-explicit. It must not import adapter implementations or query harness state.
- **Availability matching:** When adapters supply `availableModels`, the helper can select the first available category or agent preference. If no availability set is supplied, the adapter may either use first-declared preferences or rely on its harness's native validation.
- **Category shuttles:** Category descriptors are still appropriate in Weave because they affect the prompt/delegation graph. The concrete model field for a category shuttle remains adapter-owned.
- **Default model:** A fallback constant should be documented as a last-resort helper default only. Adapter-supplied system defaults should be preferred.
- **Logging:** Core Weave logging should describe generated descriptors and model intent. Adapter logging may describe concrete resolved harness models.

## Security Considerations

No specific security considerations identified. Model IDs are configuration/runtime metadata, not secrets. Any adapter logs that include UI-selected models or available-model lists should avoid logging prompts, credentials, tokens, or harness authentication details.

## Success Metrics

- Weave documentation clearly states that model UI state belongs to adapters, not core Weave.
- No engine-level `HarnessAdapter.getSelectedModel()` or `getAvailableModels()` method is introduced for live UI querying.
- Model-resolution tests cover the legacy priority order using explicit adapter-supplied context.
- Category shuttle descriptors can be generated and tested without resolving concrete harness models.
- `bun run typecheck` passes after changes.
- `bun test` passes for all affected packages.
- The final design is reusable across OpenCode, Pi, Claude Code, Codex, and future harness adapters.

## Open Questions

No open questions at this time.
