# Model Resolution and Model Intent

Weave does not resolve models by querying harness UI state. Weave records **model intent** in normalized config, and adapters translate that intent into concrete harness-specific model fields.

**Related:** [Product Vision](product-vision.md) · [Adapter Boundary](adapter-boundary.md) · [Config Loading](config-loading.md) · [DSL Reference](dsl-reference.md)

---

## What `.weave` Declares

Agents and categories declare ordered model preferences:

```weave
agent loom {
  mode primary
  models ["claude-sonnet-4-5", "gpt-4o"]
}

category frontend {
  triggers ["Use for frontend components"]
  models ["gpt-5", "claude-sonnet-4-5"]
}
```

`models [...]` means: "these are the models this agent or category prefers, in order." It is not a scalar resolved model field, and it is not a command for core Weave to inspect harness state.

---

## Builtin Default Models

The builtin agents in [`builtins.ts`](../packages/config/src/builtins.ts) default to the models GitHub Copilot offers. Each list names one Anthropic and one OpenAI model, in order of preference:

| Agent | `models` |
| --- | --- |
| loom, tapestry, pattern | `["claude-opus-5.5", "claude-opus-5-5", "gpt-6-sol"]` |
| weft, warp | `["gpt-6-sol", "claude-opus-5.5", "claude-opus-5-5"]` |
| shuttle | `["claude-sonnet-5.5", "claude-sonnet-5-5", "gpt-6-sol"]` |
| spindle | `["gpt-6-luna", "claude-haiku-4.5", "claude-haiku-4-5"]` |
| thread | `["claude-haiku-4.5", "claude-haiku-4-5", "gpt-6-luna"]` |

The [eval record](artifacts/eval-default-models-2026-09-25.md) gives the scores behind these picks, including the 29 Sep 2026 Copilot update. Haiku for Thread is unmeasured, because no suite scores Thread's own work yet.

**Why each Claude model is listed twice.** Catalogs spell Claude versions two ways. GitHub Copilot writes `claude-opus-5.5`, and Anthropic (and models.dev's `anthropic` provider) writes `claude-opus-5-5`. With only the Anthropic spelling, a Copilot-only OpenCode 2 host matched none of the Claude entries, so Loom, Tapestry, Pattern, Weft and Warp silently ran on `gpt-6-sol` and Thread on `gpt-6-luna`. The Copilot spelling comes first, so a host with both Copilot and Anthropic connected picks Copilot. OpenAI IDs are spelled the same everywhere.

**Why there is no `github-copilot/` prefix.** A qualified entry would be unambiguous on OpenCode 2, but OpenCode V1 writes the first qualified entry without checking that the provider is connected (its config hook runs before the provider list exists), so every V1 user without Copilot would fail every run with `ProviderModelNotFoundError`. The cost of bare IDs: on an OpenCode 2 host with both Copilot and OpenAI connected, `gpt-6-sol` and `gpt-6-luna` match twice, are ambiguous and are skipped, so Weft, Warp and Spindle take their Claude fallback. A user who wants a specific provider writes it in their own config, for example `models ["github-copilot/gpt-6-sol"]`.

A project or global `models` list merges ahead of these, so a user's own preference always comes first (see [Config Loading](config-loading.md)).

What each harness does with the defaults:

| Harness | Behaviour |
| --- | --- |
| OpenCode 2 | Uses the first entry with exactly one live catalog match. A Copilot host gets the Copilot spelling, an Anthropic-only host the Anthropic spelling, and an OpenAI-only host the OpenAI entry. If nothing matches, the agent registers without a model and the host chooses. |
| OpenCode (V1) | Uses only `provider/model` entries, so the bare defaults leave the agent on the user's selected or default model. |
| Claude Code | Uses the first entry in its allowlist and writes the alias: `opus`, `sonnet` or `haiku`. Only the Anthropic spelling is in the allowlist, and the OpenAI entries are skipped, so Weft and Warp run on `opus` and Spindle on `haiku`. |
| Copilot CLI | Writes no model, so the CLI's own model is used. |

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

### OpenCode 2 live-catalog rules

The native OpenCode 2 adapter resolves each declared entry against the model
catalog supplied by its Location-scoped host. It accepts `provider/model`,
`provider/model#variant`, and a bare `model` only when exactly one live provider
entry matches.

The adapter checks entries in declaration order and uses the first viable one.
An entry-level `#variant` takes priority over the descriptor-level `variant`.
An entry-level `#variant` must exist in the live model entry, or the entry is
not viable. The descriptor-level `variant` applies to whichever entry is
selected: when that model does not offer it, the agent keeps the model, runs
without a variant, and health reports a bounded `variant_unavailable` issue. If
a descriptor declares no models, the adapter leaves native model selection
unchanged. If it declares models but none are viable, the agent is registered
without a model and health reports a bounded `model_unavailable` issue. This
release does not add automatic runtime fallback after registration.

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
import { resolveAdapterModelIntent } from "@weaveio/weave-engine";

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
