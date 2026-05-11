# Model Resolution and Model Intent

Weave does not resolve models by querying harness UI state. Weave records **model intent** in normalized config, and adapters translate that intent into concrete harness-specific model fields.

**Related:** [Product Vision](product-vision.md) · [Config Loading](config-loading.md) · [Spec 04 — Agent Model Resolution](specs/04-spec-agent-model-resolution/04-spec-agent-model-resolution.md) · [Core DSL Spec](specs/01-spec-core-dsl/01-spec-core-dsl.md)

---

## What `.weave` Declares

Agents and categories declare ordered model preferences:

```weave
agent loom {
  mode primary
  models ["claude-sonnet-4-5", "gpt-4o"]
}

category frontend {
  patterns ["src/components/**", "**/*.tsx"]
  models ["gpt-5", "claude-sonnet-4-5"]
}
```

`models [...]` means: "these are the models this agent or category prefers, in order." It is not a scalar resolved model field, and it is not a command for core Weave to inspect harness state.

---

## Agent Modes

`mode` is adapter-facing metadata:

| Mode       | Weave meaning                                                       | Adapter interpretation                                                                              |
| ---------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `primary`  | This agent can be the main/user-facing agent for a harness session. | Adapter may map it to the harness-selected/default model when that harness supports such a concept. |
| `subagent` | This agent is intended for delegated/specialist work.               | Adapter should prefer explicit Weave model preferences before harness defaults.                     |
| `all`      | This agent can participate in both primary and delegated contexts.  | Adapter chooses the harness-specific mapping for each context and documents any differences.        |

Core Weave does not know whether a user has selected a model in a UI, whether the harness exposes that model, or whether the harness supports model inheritance at all.

---

## Adapter Responsibility

Adapters own concrete model resolution because they own the harness integration. An adapter may consider:

1. Adapter/harness-specific per-agent overrides.
2. A UI-selected model, if the harness exposes one and the agent mode makes that appropriate.
3. Category model preferences for generated category shuttles.
4. Agent `models [...]` preferences.
5. Harness/system defaults.
6. A documented adapter fallback.

This priority order mirrors the useful policy from legacy OpenCode-Weave, but it is applied at the adapter boundary with explicit harness context. Core Weave must not call `getSelectedModel()`, `getAvailableModels()`, or equivalent UI/runtime APIs.

---

## Category Shuttles

Categories affect the prompt/delegation graph, so Weave may generate category shuttle descriptors such as `shuttle-frontend` from `.weave` category blocks.

Those descriptors carry category model preferences as intent. The adapter decides how those preferences map to a concrete model field for its harness.

---

## Category Shuttles and Adapter Translation

Each generated `shuttle-{categoryName}` descriptor carries `models` from the matching `category.models` declaration as ordered model preferences. This is still intent only: the descriptor does not contain a concrete harness model, and the engine does not query harness UI state.

When an adapter translates a generated category shuttle, it should pass those category preferences to `resolveAdapterModelIntent()` as `categoryModels`. If the adapter also has access to the base `shuttle` agent preferences, it can pass those as `agentModels` so the helper tries category preferences before inherited/base agent preferences, after any adapter override and after any applicable UI-selected model.

Because generated category shuttles always have `mode: "subagent"`, `resolveAdapterModelIntent()` skips `uiSelectedModel` for them and resolves directly from explicit category or agent model preferences before falling back to adapter defaults.

```ts
import { resolveAdapterModelIntent } from "@weave/engine";

const resolved = resolveAdapterModelIntent({
  agentName: "shuttle-frontend",
  agentMode: categoryShuttle.mode, // always "subagent" for generated shuttles
  categoryModels: categoryShuttle.models,
  agentModels: baseShuttle.models,
  overrideModel: adapterOverrides["shuttle-frontend"],
  uiSelectedModel: harnessSelectedModel,
  systemDefault: harnessDefaultModel,
  availableModels: harnessAvailableModels,
});
```

Adapters are not required to use this helper if their harness has a stronger native model-selection mechanism, but they should preserve the same boundary: Weave provides ordered model intent, and the adapter owns concrete model translation.

---

## Why This Boundary Exists

Weave is intended to be reusable across OpenCode, Pi, Claude Code, Codex, and future harnesses. Some harnesses have a visible selected model; some may not. Some expose available model lists; some may rely on config-time validation or provider errors.

Keeping model UI state in adapters preserves the product architecture:

```txt
Weave = normalized prompt/config/delegation API
Adapter = harness-specific editor/plugin/runtime builder
```

This is the same relationship as an API layer like Neovim and the user/plugin configuration that turns that API into a concrete editor experience.
