# @weave/engine

Harness-agnostic composition APIs and adapter-boundary helpers for Weave.

`@weave/engine` consumes validated `WeaveConfig` intent and explicit harness context supplied by adapters. It resolves/composes normalized agent descriptors, model intent, skill references, prompts, and policy decisions without knowing the concrete harness runtime.

## Overview

- **Descriptor generation** — derives normalized agent descriptors such as `shuttle-{category}` from config intent
- **Model resolution helper** — `resolveAdapterModelIntent()` resolves model preferences using adapter-supplied harness context
- **Skill resolution API** — implemented by [Spec 09](../../docs/specs/09-spec-adapter-provided-skill-resolution/09-spec-adapter-provided-skill-resolution.md); adapters provide available skills via `loadAvailableSkills()`, engine matches/filters them via `resolveSkillsForAgent()` and `resolveSkillsForConfig()`
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

## Skill Resolution API

Implemented in [Spec 09](../../docs/specs/09-spec-adapter-provided-skill-resolution/09-spec-adapter-provided-skill-resolution.md). The engine exposes two pure helpers:

- **`resolveSkillsForAgent(input)`** — resolves one agent's declared `skills [...]` against adapter-provided available skills. Returns `Result<ResolvedSkill[], SkillResolutionError[]>`.
- **`resolveSkillsForConfig(input)`** — batch resolution across all declared agents and generated `shuttle-{category}` descriptors. Accumulates errors across all agents.

**Adapter-provided context flow:**

```ts
// Adapter discovers skills from harness-specific directories.
const availableSkills = await adapter.loadAvailableSkills();

// Engine resolves references — pure, no harness I/O.
const result = resolveSkillsForConfig({ config, availableSkills });
```

`WeaveRunner` calls `loadAvailableSkills()` before agent materialization and attaches `resolvedSkills` to each `RunAgentEffect`. Adapters receive resolved skill references; they own the concrete mounting/loading of skill content.

**Invariants:**

- The engine never scans skill directories. `loadAvailableSkills()` is adapter-owned.
- `RunAgentEffect.resolvedSkills` carries only engine-resolved references — no paths, content, tokens, or harness-specific metadata.
- Disabled skills (via `config.disabled.skills`) are filtered before missing-skill validation.

## Transitional Adapter Interface

`HarnessAdapter` currently contains early placeholder methods. Treat those as transitional, not architectural precedent:

- **`loadAvailableSkills(): Promise<SkillInfo[]>`** — the current adapter surface for skill context (Spec 09). Adapters return a flat list of `SkillInfo` descriptors; the engine resolves references against it. This replaces the deprecated `loadSkill()` method.
- **`loadSkill()`** — deprecated. Superseded by `loadAvailableSkills()`. Will be removed in a future spec.
- **`registerHook()`** — will be replaced or reframed around adapter-owned lifecycle event mapping into engine policy surfaces.
- Agent materialization methods such as `spawnSubagent()` are acceptable only when they receive normalized, harness-agnostic intent and the adapter owns concrete harness translation.

When adding new engine APIs, prefer pure helpers that accept explicit harness context and return normalized results.
