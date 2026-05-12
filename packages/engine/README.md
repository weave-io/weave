# @weave/engine

Harness-agnostic composition APIs and adapter-boundary helpers for Weave.

`@weave/engine` consumes validated `WeaveConfig` intent and explicit harness context supplied by adapters. It resolves/composes normalized agent descriptors, model intent, skill references, prompts, and policy decisions without knowing the concrete harness runtime.

## Overview

- **Descriptor generation** — derives normalized agent descriptors such as `shuttle-{category}` from config intent
- **Model resolution helper** — `resolveAdapterModelIntent()` resolves model preferences using adapter-supplied harness context
- **Skill resolution API** — planned by [Spec 05](../../docs/specs/05-spec-skill-loader/05-spec-skill-loader.md); adapters provide available skills, engine matches/filter them
- **Prompt composition APIs** — future APIs that combine prompt files, prompt appendices, delegation metadata, and resolved skills
- **Policy/lifecycle surfaces** — future abstract lifecycle APIs; adapters map harness events into those surfaces
- **`WeaveRunner`** — current transitional orchestration entry point that passes normalized intent through a `HarnessAdapter`

## Boundary Rule

The engine may orchestrate and call adapters through abstract interfaces, but it must not make harness-specific assumptions.

```ts
// ✅ Correct: adapter supplies harness context; engine resolves intent.
const resolved = resolveAdapterModelIntent({
  agentName: "loom",
  agentMode: agent.mode,
  agentModels: agent.models,
  uiSelectedModel: adapterContext.uiSelectedModel,
  availableModels: adapterContext.availableModels,
  systemDefault: adapterContext.systemDefault,
});
```

```ts
// ❌ Wrong: engine reaches into harness-owned state directly.
const selectedModel = await opencodeClient.model.selected();
const skills = await scanOpenCodeSkillDirectories(projectRoot);
```

See [../../docs/adapter-boundary.md](../../docs/adapter-boundary.md) for the full ownership matrix.

## Usage

```ts
import { loadConfig } from "@weave/config";
import { WeaveRunner } from "@weave/engine";
import { OpenCodeAdapter } from "@weave/adapter-opencode";

const configResult = await loadConfig(process.cwd());

await configResult.match(
  async (config) => {
    const adapter = new OpenCodeAdapter();
    const runner = new WeaveRunner(config, adapter);
    await runner.run();
  },
  async (errors) => {
    // Surface config loading errors to the harness/CLI boundary.
  },
);
```

## Transitional Adapter Interface

`HarnessAdapter` currently contains early placeholder methods such as `loadSkill()` and `registerHook()`. Treat those methods as transitional, not architectural precedent:

- `loadSkill()` will be replaced by an adapter-provided skill context flow (`getAvailableSkills()` or equivalent) and engine-side skill resolution.
- `registerHook()` will be replaced or reframed around adapter-owned lifecycle event mapping into engine policy surfaces.
- Agent materialization methods such as `spawnSubagent()` are acceptable only when they receive normalized, harness-agnostic intent and the adapter owns concrete harness translation.

When adding new engine APIs, prefer pure helpers that accept explicit harness context and return normalized results.
