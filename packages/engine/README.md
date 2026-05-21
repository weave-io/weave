# @weave/engine

Harness-agnostic composition APIs and adapter-boundary helpers for Weave.

`@weave/engine` consumes validated `WeaveConfig` intent and explicit harness context supplied by adapters. It resolves/composes normalized agent descriptors, model intent, skill references, prompts, and policy decisions without knowing the concrete harness runtime.

## Overview

- **Descriptor generation** — derives normalized agent descriptors such as `shuttle-{category}` from config intent
- **Model resolution helper** — `resolveAdapterModelIntent()` resolves model preferences using adapter-supplied harness context
- **Skill resolution API** — implemented by [Spec 09](../../docs/specs/09-spec-adapter-provided-skill-resolution/09-spec-adapter-provided-skill-resolution.md); adapters provide available skills via `loadAvailableSkills()`, engine matches/filters them via `resolveSkillsForAgent()` and `resolveSkillsForConfig()`
- **Prompt composition APIs** — future APIs that combine prompt files, prompt appendices, delegation metadata, and resolved skills
- **Execution Lifecycle Surface** — abstract lifecycle API (`execution-lifecycle.ts`); adapters map harness events into 7 typed lifecycle methods (`observeSession`, `startExecution`, `resumeExecution`, `handleUserInterrupt`, `dispatchStep`, `completeStep`, `beforeTool`); supersedes `registerHook()`
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

## Execution Lifecycle Surface

The engine owns the lifecycle decision logic. Adapters own harness event detection and mapping.

```
Harness event (adapter-owned)          Engine lifecycle function (engine-owned)
─────────────────────────────          ────────────────────────────────────────
Session started in harness         →   observeSession(input, store)
User triggers workflow execution   →   startExecution(input, store)
Paused execution resumes           →   resumeExecution(input, store)
User presses Ctrl+C / stop         →   handleUserInterrupt(input, store)
Adapter ready to run next step     →   dispatchStep(input, store)
Step agent finishes                →   completeStep(input, store)
Tool call about to execute         →   beforeTool(input)
```

**Adapter-owned**: detecting harness events, mapping them to lifecycle inputs, providing `RuntimeStore`, acting on returned `LifecycleEffect` values (e.g. spawning agents, pausing sessions).

**Engine-owned**: policy decisions, state transitions, effect generation, `RuntimeStore` writes.

All lifecycle functions return `ResultAsync<Output, LifecycleError>` — no exceptions, no concrete hook registration, no harness-specific callbacks.

```ts
// ✅ Adapter maps a harness event into an engine lifecycle call.
// The adapter owns event detection; the engine owns the policy decision.
async function onHarnessStepComplete(stepName: string) {
  const result = await completeStep(
    { workflowInstanceId, leaseId, stepName, completionSignal: { outcome: "success" } },
    store,
  );
  result.match(
    ({ effects }) => applyEffects(effects),
    (err) => log.error({ err }, "completeStep failed"),
  );
}

// ❌ Wrong: engine registering a concrete harness callback.
adapter.registerHook({ name: "on-step-complete", event: "step:done", enabled: true });
```

### `registerHook()` — superseded

`HarnessAdapter.registerHook()` is **superseded** by the execution lifecycle surface. Adapters should map concrete harness events into the 7 typed engine lifecycle functions listed above instead of registering hooks through this method. `registerHook()` will be removed once all adapters have migrated.

## Transitional Adapter Interface

`HarnessAdapter` currently contains early placeholder methods. Treat those as transitional, not architectural precedent:

- **`loadAvailableSkills(): Promise<SkillInfo[]>`** — the current adapter surface for skill context (Spec 09). Adapters return a flat list of `SkillInfo` descriptors; the engine resolves references against it. This replaces the deprecated `loadSkill()` method.
- **`loadSkill()`** — deprecated. Superseded by `loadAvailableSkills()`. Will be removed in a future spec.
- **`registerHook()`** — **superseded** by the execution lifecycle surface. See above.
- Agent materialization methods such as `spawnSubagent()` are acceptable only when they receive normalized, harness-agnostic intent and the adapter owns concrete harness translation.

When adding new engine APIs, prefer pure helpers that accept explicit harness context and return normalized results.
