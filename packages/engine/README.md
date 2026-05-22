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

## Category Metadata Descriptor Contract

Generated category shuttles expose source category context on the adapter-facing `AgentDescriptor.category?: CategoryMetadata` field.

`CategoryMetadata` contains the source category `name`, optional `description`, declared `patterns: string[]`, and `isCategory: true`. The `patterns` array is the list of glob strings authored in `.weave` config; the engine does not expand those globs into files.

Adapters may consume `descriptor.category.patterns` to generate harness-specific routing rules, plugin configuration, or delegation metadata. The adapter owns the concrete interpretation for its harness. The engine must not expand globs, scan files, inspect harness-owned resources, or make concrete routing decisions.

## Execution Lifecycle Surface

> **Issue:** [#44 — Minimal Execution Lifecycle Surface](https://github.com/josevalim/weave/issues/44) · **Spec:** [Spec 13](../../docs/specs/13-spec-minimal-execution-lifecycle-surface/13-spec-minimal-execution-lifecycle-surface.md) · **Boundary:** [docs/adapter-boundary.md — Execution Lifecycle Surface](../../docs/adapter-boundary.md#execution-lifecycle-surface)

The engine owns the lifecycle decision logic. Adapters own harness event detection and mapping.

```text
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

### Workflow Engine Behavior

The execution lifecycle surface implements the **workflow engine** — the engine-owned subsystem that drives multi-step workflow execution. The engine consumes `WorkflowConfig` (from `@weave/core`) and `WorkflowExecutionContext` (adapter-provided) to:

1. **Validate workflow topology** — `startExecution` validates `context.workflowName` against `context.workflows`, sets `currentStepName` to the first step, and acquires an execution lease.
2. **Dispatch steps** — `dispatchStep` resolves the step from `WorkflowConfig.steps`, uses `step.agent` as the agent name, renders `step.prompt` via `renderTemplate()`, validates declared `step.inputs` artifacts, and emits a `RunAgentEffect` with `completionMethod`, `stepType`, `correlationId`, and `promptMetadata` (byte length only — no raw prompt).
3. **Complete steps and auto-advance** — `completeStep` validates output artifacts against `step.outputs` (all-or-nothing), persists them via `store.instances.addArtifact()`, then either dispatches the next step or transitions to `completed` + releases the lease for the final step.
4. **Evaluate completion methods** — all 5 methods are supported: `agent_signal`, `user_confirm`, `review_verdict`, `plan_created`, `plan_complete`. Gate rejection (`review_verdict` with `approved: false`) applies the step's `on_reject` policy: `pause` → paused + pause-execution effect; `fail` → failed + complete-execution effect; `retry` → re-dispatch same step with fresh `correlationId`.

**Required adapter-provided context** — `WorkflowExecutionContext`:

```ts
interface WorkflowExecutionContext {
  workflowName: string;           // logical workflow name (must exist in workflows map)
  goal: string;                   // human-readable goal for this execution instance
  slug: string;                   // URL-safe slug for this execution instance
  workflows: Record<string, WorkflowConfig>; // narrow slice of WeaveConfig.workflows
}
```

Adapters pass `WorkflowExecutionContext` to `startExecution`, `dispatchStep`, and `completeStep`. The engine validates `workflowName` against the `workflows` map and reads step definitions from `WorkflowConfig.steps`. The engine never reads `WeaveConfig` directly — adapters supply the narrow slice it needs.

**Security invariants**: `promptMetadata` in `RunAgentEffect` carries only `byteLength` — no raw prompt text appears in emitted effects or the Runtime Store. `StepCompletionSignal` structurally excludes raw prompts, completions, transcripts, credentials, and tokens.

See [`docs/adapter-boundary.md — Workflow Engine`](../../docs/adapter-boundary.md#workflow-engine) for the full ownership matrix and [`docs/workflow-schema.md — Execution Semantics`](../../docs/workflow-schema.md#execution-semantics) for step-by-step runtime behavior.

### `registerHook()` — superseded

`HarnessAdapter.registerHook()` is **superseded** by the execution lifecycle surface. Adapters should map concrete harness events into the 7 typed engine lifecycle functions listed above instead of registering hooks through this method. `registerHook()` will be removed once all adapters have migrated.

## Transitional Adapter Interface

`HarnessAdapter` currently contains early placeholder methods. Treat those as transitional, not architectural precedent:

- **`loadAvailableSkills(): Promise<SkillInfo[]>`** — the current adapter surface for skill context (Spec 09). Adapters return a flat list of `SkillInfo` descriptors; the engine resolves references against it. This replaces the deprecated `loadSkill()` method.
- **`loadSkill()`** — deprecated. Superseded by `loadAvailableSkills()`. Will be removed in a future spec.
- **`registerHook()`** — **superseded** by the execution lifecycle surface. See above.
- Agent materialization methods such as `spawnSubagent()` are acceptable only when they receive normalized, harness-agnostic intent and the adapter owns concrete harness translation.

When adding new engine APIs, prefer pure helpers that accept explicit harness context and return normalized results.
