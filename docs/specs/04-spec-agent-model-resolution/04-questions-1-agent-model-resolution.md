# 04 Questions Round 1 - Agent Model Resolution

> **Superseded architecture note:** This questions file is preserved as a clarification artifact, but the initial framing assumed core Weave or `HarnessAdapter` would query harness UI-selected model state. That is no longer the product direction. Current guidance lives in [`04-spec-agent-model-resolution.md`](04-spec-agent-model-resolution.md), [`../../../model-resolution.md`](../../../model-resolution.md), and [`../../../product-vision.md`](../../../product-vision.md): Weave declares normalized model intent; adapters own UI-selected model lookup, available-model discovery, and concrete harness model translation.

Please answer each question below (select one or more options, or add your own notes). Feel free to add additional context under any question.

## 1. Per-Agent Config Override Semantics

The issue lists resolution priority as `(1) per-agent config override` before `(2) UI-selected model`, but the current `.weave` DSL has only `models [...]` as an ordered fallback chain and no separate scalar `model` field. Builtin agents already have default `models`, so treating every `models` entry as an explicit override would prevent primary/all agents from ever respecting the UI-selected model.

- [x] (A) **No DSL schema change** — Keep `models [...]` as the fallback chain only. The pure resolver accepts an optional `overrideModel` for adapter/runtime callers, but normal `.weave` agent config does not express a separate per-agent override yet.
- [ ] (B) **Add scalar `model` to agent config** — Extend the DSL/schema with `model "..."` as the explicit per-agent override, while `models [...]` remains the fallback chain. This makes priority (1) distinct but requires core parser/schema/validation/test/docs changes.
- [ ] (C) **Add resolver provenance to config loading** — Keep the DSL unchanged, but preserve which `models` entries came from project/global config versus builtins so user-provided models can outrank UI selection while builtin fallback models do not.
- [ ] (D) **Treat `models[0]` as override only for custom agents** — Builtins continue to use UI selection/fallbacks; custom agents with `models` use their first model as an explicit override.
- [ ] (E) Other (describe)

**Recommended answer(s):** (A)

NOTE:

# Weave Model Resolution + Adapter Architecture Notes

## Core Architecture

`.weave` is a harness-agnostic orchestration/configuration DSL.

Its responsibility is to describe:

- agent topology
- model preferences
- orchestration intent
- tools/capabilities
- policies/preferences

Adapters are responsible for translating the normalized Weave config into harness-specific implementations.

```txt
.weave DSL
    ↓
normalized config
    ↓
adapter
    ↓
harness/runtime
(OpenCode, PI, Claude Code, Codex, etc.)
```

END NOTE

**Why these are recommended:**

- (A) keeps this issue focused on model intent and adapter-owned translation without reopening the core DSL decisions from spec 01, where `models [...]` was chosen as the single ordered preference list.
- (B) is clearer long-term if a distinct per-agent override is truly required, but it expands this issue into a schema evolution task with required parser/validator/E2E test updates.
- (C) preserves the priority order exactly but adds provenance complexity to `@weave/config`, which is likely too much for this issue.
- (D) creates different semantics for builtins and custom agents, which would be harder for users and junior implementers to reason about.

## 2. Available Model Discovery

The legacy resolver checks whether category and fallback-chain models are available before selecting them. The current `HarnessAdapter` interface has no method for listing available models, and the issue only explicitly mentions adding a method for the current UI-selected model.

- [ ] (A) **Add only `getSelectedModel()` now** — Resolve UI-selected model through the adapter, but select fallback/category/system models by priority order without querying availability. Available-model filtering can be a follow-up issue.
- [x] (B) **Superseded answer — originally add `getAvailableModels()` in this spec too** — This was answered before the architecture correction. Current direction: do not add core `HarnessAdapter` UI/model-discovery methods; adapters may discover available models internally.
- [ ] (C) **Make available models optional** — Add resolver support for `availableModels?: Set<string>`, but do not require adapters to implement discovery yet. If absent or empty, resolution falls back to first configured candidate/system default.
- [ ] (D) **Delegate all availability checks to adapters** — Engine chooses candidate order, adapter validates or rejects unsupported models during spawn.
- [ ] (E) Other (describe)

**Recommended answer(s):** (C)

**Why these are recommended:**

- (C) preserves the legacy resolver's shape and makes tests cover availability when present, without forcing every adapter to implement model listing immediately.
- (A) is the smallest interface change, but it weakens the specified fallback behavior because “first available wins” cannot be demonstrated.
- (B) matches legacy behavior most completely, but it expands the adapter contract beyond what issue 7 explicitly requested.
- (D) hides resolution failures in harness-specific code instead of keeping model resolution testable in `@weave/engine`.

## 3. Category Model Application

The current `CategoryConfigSchema` uses `models [...]`, and AGENTS.md says categories automatically spawn `shuttle-{name}` agents that inherit from the base `shuttle` agent. The issue says to use the category model if the agent belongs to a category.

- [x] (A) **Apply category models only to generated `shuttle-{category}` agents** — A category-specific shuttle belongs to exactly one category and uses that category's ordered `models` list before the base shuttle fallback chain.
- [ ] (B) **Apply category models to any agent selected for category work** — Any agent can be resolved with category context when a caller supplies a category name.
- [ ] (C) **Do not generate category agents in this spec** — Implement the resolver's category-model input only; category-agent spawning remains a separate future spec.
- [ ] (D) **Use only the first category model** — Treat `category.models[0]` as the category model and ignore additional category fallback entries.
- [ ] (E) Other (describe)

**Recommended answer(s):** (A), with (C) acceptable if category-agent spawning is intentionally deferred

**Why these are recommended:**

- (A) aligns with the project guide: categories map to generated `shuttle-{name}` agents, so category membership is unambiguous and demoable.
- (C) keeps this issue limited to pure resolution logic if category-agent generation is not ready, but it leaves part of the user-visible priority chain unintegrated.
- (B) is more flexible but introduces a runtime routing concept that is not currently represented in `WeaveRunner`.
- (D) wastes the existing `models [...]` array semantics for categories.

## 4. How Resolved Models Should Reach Adapters

`WeaveRunner` currently calls `adapter.spawnSubagent(name, agentConfig)`, and `AgentConfig` has `models?: string[]` rather than a single resolved `model` field. The spec needs a clear contract for passing the final resolved model to adapter implementations.

- [x] (A) **Superseded answer — originally add `resolvedModel` to the spawn call** — This was answered before the architecture correction. Current direction: Weave passes normalized config/model intent; adapters translate to concrete harness model fields.
- [ ] (B) **Add an engine-local `ResolvedAgentConfig` type** — Keep `spawnSubagent(name, config)`, but pass a config object augmented with `resolved_model` or `model`.
- [ ] (C) **Rewrite `config.models` before spawning** — Clone the agent config and set `models` to `[resolvedModel, ...remainingModels]` before calling the adapter.
- [ ] (D) **Adapters call `resolveAgentModel()` themselves** — Engine exposes helper utilities, but each adapter resolves during spawn.
- [ ] (E) Other (describe)

**Recommended answer(s):** (A)

**Why these are recommended:**

- (A) keeps core `AgentConfig` unchanged, makes the final model explicit, and avoids overloading `models` with a resolved value.
- (B) can work, but adding non-DSL fields to a config-shaped object risks confusion between validated config and engine runtime state.
- (C) is backward-compatible at the method signature level, but it hides whether `models[0]` is user config or engine output.
- (D) duplicates engine policy across adapters and weakens harness-agnostic behavior.

## 5. System Default Source and Failure Behavior

The issue lists `(5) system default`, but the current config schema has no system-default model field. Adapter calls for UI model discovery may also fail or return no value.

- [ ] (A) **Adapter provides system default too** — Add `getDefaultModel()` or return both selected/default model from the new UI model method.
- [ ] (B) **Engine constant fallback** — Define a documented engine constant such as `DEFAULT_MODEL = "claude-sonnet-4-5"` for final fallback.
- [x] (C) **Config-provided setting later; engine constant now** — Use an engine constant for this spec and leave a future DSL setting for configurable defaults.
- [ ] (D) **No hardcoded fallback** — If no model can be resolved, return a typed resolution error and skip spawning that agent.
- [ ] (E) Other (describe)

**Recommended answer(s):** (C)

**Why these are recommended:**

- (C) makes this issue implementable with current schemas while clearly documenting that user-configurable system defaults are future work.
- (A) may be cleaner for harnesses that already know a default, but it adds another adapter responsibility beyond the issue's explicit UI-selected-model method.
- (B) is simple but risks making the hardcoded default feel permanent.
- (D) is strict, but it does not match the issue's explicit system-default fallback priority.
