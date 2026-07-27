# Model Resolution and Model Intent

Weave does not resolve models by querying harness UI state. Weave records **model intent** in normalized config, and adapters translate that intent into concrete harness-specific model fields.

**Related:** [Product Vision](../architecture/product-vision.md) · [Adapter Boundary](../architecture/adapter-boundary.md) · [Config Loading](configuration.md) · [DSL Reference](dsl.md)

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

## Thinking-level suffixes

A model preference may carry a thinking directive on that one fallback entry:

```weave
models ["openai-codex/gpt-5.6-sol#high", "claude-haiku-3-5#low", "claude-haiku-3-5"]
```

The closed vocabulary is `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. The suffix is parsed from the last unescaped `#`; `\#` escapes a literal hash in a model identifier. An unescaped `#` must be followed by one of those levels, so an unknown suffix such as `#hgih` is a hard schema-validation error rather than a model-not-found fallback. The same grammar applies to agent, category, and `review_models` entries. See [DSL — Model Thinking Level Suffixes](dsl.md#model-thinking-level-suffixes) for the grammar.

The raw descriptor contract does not change. `AgentDescriptor.models` remains `string[]`, and each element retains the raw model intent entry, including an embedded suffix. Core validates the string but does not replace it with a `{ model, thinkingLevel }` object. Resolution splits the entry only when a model is selected, so existing adapters that consume string arrays remain source-compatible.

### Parse before availability matching

`resolveAdapterModelIntent()` parses every candidate before it is compared with adapter-supplied availability:

1. Apply the existing priority cascade: override, UI-selected (except for `subagent`), category preference, agent preference, system default, then constant fallback.
2. Split the selected entry at its last unescaped `#` and unescape literal `\#` characters. The winning result contains the base model only and, when present, `thinkingLevel`.
3. For ordered category and agent lists, compare the parsed **base model** with `availableModels`. A suffixed entry therefore matches a registry containing only `provider/model`, not `provider/model#high`.
4. Preserve the winning entry's thinking level independently for every applicable source branch. Entries without a suffix return no `thinkingLevel`.

The helper remains pure: adapters provide `availableModels`, UI selection, and defaults. If a caller bypasses schema validation and supplies malformed raw intent, the defensive helper treats that raw value as the model with no thinking level; config loading remains the hard-validation boundary.

### Review-model resolution and naming

`review_models` uses the same parse-before-match path when a generated reviewer variant is resolved. Its variant name is derived from the base model, while the generated variant keeps the full raw entry in `models: [reviewModel]`. Thus `openai/gpt-5#high` and `openai/gpt-5#low` intentionally collide on the same stable variant name and return the existing review-variant conflict error rather than creating two indistinguishable identities. See [`packages/engine/src/review-variants.ts`](../../packages/engine/src/review-variants.ts) for variant construction.

### Union-merge caveat

Model arrays retain the existing config-layer union-merge semantics: higher-priority entries come first, then lower-priority entries not already present, with equality based on the complete raw string. A suffixed entry and its bare form are therefore distinct entries (`"gpt-4o#high"` and `"gpt-4o"` do not deduplicate). To change a model's thinking level at the project layer, redeclare the intended full entry; the merge does not replace an entry by base model.

### Adapter readiness

Weave resolves and exposes thinking intent, but adapters own applying it to their harness. Readiness is declared through the `model-thinking-activation` capability:

| Adapter | Readiness | Implemented behavior |
| --- | --- | --- |
| Pi | `emulated` | Resolves the base model through Pi's exact cascade, then calls `pi.setThinkingLevel()` through an injected result-based port. A failed thinking-level call leaves model activation successful and reports `thinkingApplied: false`. |
| OpenCode | `degraded` | Strips the suffix before provider-prefix normalization and availability checks, and returns the winning level, but the SDK's per-request reasoning-effort forwarding surface is not confirmed. The level is not guaranteed to reach OpenCode. |
| Claude Code | `unsupported` | Strips the suffix before the static model-list check so base-model resolution still works, but the current adapter has no host-controlled per-invocation thinking setting and intentionally ignores the level. |

Adapters may lower these declared readiness values through runtime capability evaluation, but the engine does not apply harness-specific thinking settings. See [Adapter Boundary](../architecture/adapter-boundary.md#model-thinking-activation) for ownership rules.

### Authenticated child propagation

Pi's ordinary delegation and direct-step transports carry a selected `thinkingLevel` as an optional core-owned bootstrap field when a suffixed intent is resolved. It remains separate from the authenticated compact model identity (`provider`, `id`, and optional `name`), so host-specific model fields do not cross the transport boundary. The child validates the field with the shared vocabulary and applies it through `pi.setThinkingLevel()` only after successful model activation. Missing levels do not call the host; throwing or rejecting host calls remain isolated from model/bootstrap success.

### Legacy migration

The legacy JSONC converter still maps only its existing `model` and `fallback_models` fields into raw `models [...]` entries. Legacy JSONC has no equivalent `thinking` or `reasoning_effort` field, so the converter is deliberately deferred: it emits no `#<level>` suffix and does not guess one. A future legacy-format field can be mapped only after a real source field and conversion semantics exist. See [CLI — `weave init migrate`](cli.md#weave-init-migrate).

### OpenCode provider aliases

Provider IDs may differ between harnesses. Pi identifies models from an OpenAI Codex subscription with the `openai-codex` provider, while OpenCode identifies the same provider as `openai`.

The OpenCode adapter accepts either spelling in agent and category model preferences. Before checking availability or returning a model to OpenCode, it translates only the exact `openai-codex/` prefix:

```text
openai-codex/gpt-5.3-codex → openai/gpt-5.3-codex
```

It leaves `openai/...` and all unrelated provider IDs unchanged. This translation belongs to the OpenCode adapter; core Weave continues to treat model intent as opaque strings.

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

This is the same relationship as an API Neovim and the user/plugin configuration that turns that API into a concrete editor experience.
