# Adapter Bootstrap Guide

This guide shows the canonical pattern for bootstrapping a Weave adapter — from
config loading through agent materialization and workflow execution. Use it as
the authoritative reference when writing a new adapter or migrating an existing
one.

**Related:** [Adapter Boundary](adapter-boundary.md) · [Product Vision](product-vision.md) · [Execution Lifecycle Surface](adapter-boundary.md#execution-lifecycle-surface) · [Agent Materialization API](adapter-boundary.md#agent-materialization-api) · [Spec 15 — Adapter-Facing Materialization API](specs/15-spec-adapter-facing-materialization-api/) · [Spec 13 — Minimal Execution Lifecycle Surface](specs/13-spec-minimal-execution-lifecycle-surface/13-spec-minimal-execution-lifecycle-surface.md)

---

> **`WeaveRunner` has been removed.**
>
> The transitional `WeaveRunner` class (previously exported from `@weave/engine`)
> is no longer the recommended bootstrap path. Adapters should call
> `loadConfig` → `materializeAgents` directly and wire the execution lifecycle
> surface themselves. The snippets below show the correct pattern.

---

## Agent Materialization Path

The minimal adapter bootstrap has three steps:

```text
loadConfig()  →  materializeAgents()  →  adapter loop: spawnSubagent(descriptor)
```

### Full runnable example

```ts
import { loadConfig } from "@weave/config";
import {
  logger,
  materializeAgents,
  type AgentDescriptor,
  type MaterializationError,
  type MaterializedAgent,
} from "@weave/engine";

const log = logger.child({ module: "my-adapter" });

// ---------------------------------------------------------------------------
// Minimal mock adapter — replace with your real harness implementation
// ---------------------------------------------------------------------------

class MockAdapter {
  readonly spawned: AgentDescriptor[] = [];

  async spawnSubagent(descriptor: AgentDescriptor): Promise<void> {
    this.spawned.push(descriptor);
    log.info({ agent: descriptor.name, model: descriptor.models[0] }, "Spawned agent");
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function bootstrap(projectRoot: string): Promise<void> {
  const adapter = new MockAdapter();

  // 1. Load the fully-merged WeaveConfig (builtins + global + project layers).
  const configResult = await loadConfig(projectRoot);

  if (configResult.isErr()) {
    for (const err of configResult.error) {
      log.error({ err }, "Config load failed");
    }
    process.exitCode = 1;
    return;
  }

  const config = configResult.value;

  // 2. Compose all adapter-facing agent descriptors.
  //
  //    materializeAgents() returns ResultAsync<MaterializationPlan, never> —
  //    the outer Result never rejects. Per-agent failures are accumulated in
  //    plan.errors[] (partial-by-default shape). Always inspect plan.errors
  //    after a successful call.
  const plan = await materializeAgents({ config });

  // plan is always ok() — unwrap unconditionally.
  const { agents, errors } = plan.value;

  // 3. Surface per-agent failures before proceeding.
  if (errors.length > 0) {
    for (const err of errors) {
      if (err.type === "CategoryShuttleConflict") {
        log.warn(
          { shuttle: err.conflict.shuttleName, category: err.conflict.categoryName },
          "Category shuttle conflict — agent skipped",
        );
      } else {
        // err.type === "DescriptorCompositionFailure"
        log.warn(
          { agent: err.agentName, cause: err.cause },
          "Descriptor composition failed — agent skipped",
        );
      }
    }
  }

  // 4. Translate each descriptor into harness-specific configuration.
  //
  //    Adapters own everything after this point: concrete model selection,
  //    tool-name mapping, plugin/config file generation, and feature-gap
  //    emulation. The engine has already composed prompts, resolved delegation
  //    metadata, and evaluated effective tool policy.
  for (const { agentName, descriptor } of agents) {
    log.info({ agent: agentName }, "Materializing agent");
    await adapter.spawnSubagent(descriptor);
  }

  log.info({ count: agents.length, errors: errors.length }, "Bootstrap complete");
}

bootstrap(process.cwd()).catch((err) => {
  logger.error({ err }, "Unhandled bootstrap error");
  process.exitCode = 1;
});
```

### Key points

- `loadConfig` is from `@weave/config`. It merges builtins, global
  (`~/.weave/config.weave`), and project (`.weave/config.weave`) layers and
  returns `ResultAsync<WeaveConfig, ConfigLoadError[]>`.
- `materializeAgents` is from `@weave/engine`. It accepts only
  `{ config: WeaveConfig }` — no `HarnessAdapter` required.
- `MaterializationPlan` has two fields:
  - `agents: MaterializedAgent[]` — ordered, disabled-filtered descriptors ready
    for adapter translation.
  - `errors: readonly MaterializationError[]` — per-agent failures accumulated
    during composition. The `ResultAsync` itself never rejects; always read
    `plan.errors` to detect partial failures.
- Disabled agents are filtered before descriptors are returned — they do not
  appear in `plan.agents` as disabled entries.

---

## Workflow Execution Path

For adapters that support workflow execution, wire the execution lifecycle
surface after agent materialization. The lifecycle surface is the engine-owned
abstract API that adapters call after mapping concrete harness events into
normalized inputs.

```ts
import { loadConfig } from "@weave/config";
import {
  completeStep,
  createInMemoryRuntimeStore,
  dispatchStep,
  logger,
  materializeAgents,
  startExecution,
  type LifecycleEffect,
  type RuntimeStore,
  type WorkflowExecutionContext,
} from "@weave/engine";

const log = logger.child({ module: "my-adapter-workflow" });

// ---------------------------------------------------------------------------
// Apply lifecycle effects returned by the engine
// ---------------------------------------------------------------------------

async function applyEffects(
  effects: LifecycleEffect[],
  adapter: MockAdapter,
): Promise<void> {
  for (const effect of effects) {
    if (effect.kind === "dispatch-agent") {
      // The engine resolved the step's agent and composed its prompt.
      // Spawn the agent in the harness.
      log.info(
        { agent: effect.runAgent.agentName },
        "Dispatching workflow step agent",
      );
      await adapter.spawnSubagent(effect.runAgent.agentDescriptor);
    } else if (effect.kind === "pause-execution") {
      log.info(
        { workflowInstanceId: effect.workflowInstanceId },
        "Pausing workflow execution",
      );
      // Persist pause state in harness-specific storage if needed.
    } else if (effect.kind === "complete-execution") {
      log.info(
        { workflowInstanceId: effect.workflowInstanceId },
        "Workflow execution complete",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Workflow bootstrap
// ---------------------------------------------------------------------------

async function bootstrapWorkflow(projectRoot: string): Promise<void> {
  const adapter = new MockAdapter();

  // 1. Load config and materialize agents (same as agent-only path).
  const configResult = await loadConfig(projectRoot);
  if (configResult.isErr()) {
    log.error({ errors: configResult.error }, "Config load failed");
    process.exitCode = 1;
    return;
  }
  const config = configResult.value;

  const plan = await materializeAgents({ config });
  const { agents, errors } = plan.value;

  if (errors.length > 0) {
    log.warn({ count: errors.length }, "Materialization had partial failures");
  }

  for (const { agentName, descriptor } of agents) {
    log.info({ agent: agentName }, "Materializing agent");
    await adapter.spawnSubagent(descriptor);
  }

  // 2. Create a RuntimeStore.
  //
  //    For production use, prefer SqliteRuntimeStore from @weave/engine.
  //    For tests or ephemeral runs, InMemoryRuntimeStore is sufficient.
  //
  //    NOTE: BunFilesystemPlanStateProvider (from @weave/config) will provide
  //    filesystem-backed plan state for plan_created / plan_complete completion
  //    methods. See Spec 19 (task 18) for the full PlanStateProvider interface
  //    and BunFilesystemPlanStateProvider implementation.
  const store: RuntimeStore = createInMemoryRuntimeStore();

  // 3. Start a workflow execution.
  //
  //    The adapter maps a harness trigger (user command, CI event, etc.) into
  //    a StartExecutionInput. The engine acquires a lease and transitions the
  //    instance to `running`.
  const workflowName = "secure-feature";
  const workflow = config.workflows[workflowName];
  if (!workflow) {
    log.error({ workflowName }, "Workflow not found in config");
    return;
  }

  const executionContext: WorkflowExecutionContext = {
    workflowName,
    goal: "Add OAuth2 login support",
    slug: "add-oauth2-login",
    workflows: config.workflows,
  };

  const startResult = await startExecution(
    {
      workflowName,
      goal: executionContext.goal,
      slug: executionContext.slug,
    },
    store,
  );

  if (startResult.isErr()) {
    log.error({ err: startResult.error }, "startExecution failed");
    return;
  }

  const { workflowInstanceId, leaseId, effects: startEffects } = startResult.value;
  log.info({ workflowInstanceId }, "Workflow execution started");
  await applyEffects(startEffects, adapter);

  // 4. Dispatch the first step.
  //
  //    The adapter calls dispatchStep after the harness is ready to run the
  //    next step. The engine resolves the step's agent and returns a
  //    DispatchAgentEffect wrapped in a LifecycleEffect.
  const dispatchResult = await dispatchStep(
    { workflowInstanceId, leaseId, context: executionContext },
    store,
  );

  if (dispatchResult.isErr()) {
    log.error({ err: dispatchResult.error }, "dispatchStep failed");
    return;
  }

  await applyEffects(dispatchResult.value.effects, adapter);

  // 5. Complete a step.
  //
  //    When the harness signals that a step has finished, the adapter maps the
  //    harness event into a CompleteStepInput and calls completeStep. The engine
  //    records completion, advances the workflow, and returns the next effects.
  //
  //    The planStateProvider parameter (injected here as undefined for brevity)
  //    will be a BunFilesystemPlanStateProvider from @weave/config in production
  //    use — required for plan_created / plan_complete completion methods.
  //    See Spec 19 for the full interface.
  const completeResult = await completeStep(
    {
      workflowInstanceId,
      leaseId,
      stepName: workflow.steps[0]!.name,
      completionSignal: { method: "agent_signal" },
    },
    store,
    undefined, // planStateProvider — inject BunFilesystemPlanStateProvider here
  );

  if (completeResult.isErr()) {
    log.error({ err: completeResult.error }, "completeStep failed");
    return;
  }

  await applyEffects(completeResult.value.effects, adapter);
}
```

### Lifecycle method summary

| Method | Adapter calls this when… | Returns |
| --- | --- | --- |
| `startExecution` | A new workflow execution begins | `StartExecutionOutput` with `workflowInstanceId`, `leaseId`, `effects` |
| `resumeExecution` | A paused or blocked execution resumes | `ResumeExecutionOutput` with new `leaseId`, `effects` |
| `handleUserInterrupt` | The user explicitly cancels or pauses | `HandleUserInterruptOutput` with `effects` |
| `dispatchStep` | The next workflow step should be dispatched | `DispatchStepOutput` with `effects` containing a `dispatch-agent` entry |
| `completeStep` | A workflow step has finished | `CompleteStepOutput` with `effects` (next dispatch, pause, or complete) |
| `beforeTool` | A tool call is about to execute | `BeforeToolOutput` with `decision`: `allow` / `deny` / `ask` |
| `observeSession` | A harness session observation is available | `ObserveSessionOutput` |

All methods return `ResultAsync<Output, LifecycleError>` — errors are never
thrown. See [Adapter Boundary — Execution Lifecycle Surface](adapter-boundary.md#execution-lifecycle-surface)
for the full `LifecycleError` discriminated union and `LifecycleEffect` type.

### `planStateProvider` and `BunFilesystemPlanStateProvider`

`completeStep` accepts an optional third argument: a `PlanStateProvider`
(interface from `@weave/engine`). This provider is required when a workflow step
uses `plan_created` or `plan_complete` completion methods — it reads and writes
plan files under `.weave/plans/`.

`BunFilesystemPlanStateProvider` (from `@weave/config`) is the production
implementation backed by Bun's filesystem APIs. It will be available once
[Spec 19](specs/) is implemented (task 18). Until then, pass `undefined` for
steps that do not use plan-based completion methods.

---

## OpenCode Adapter: `runWorkflow` Helper

The OpenCode adapter (`@weave/adapter-opencode`) provides a `runWorkflow`
convenience function that wraps the full execution lifecycle loop described
above. It is the recommended entry point for running a workflow end-to-end
in the OpenCode harness.

```ts
import { runWorkflow } from "@weave/adapter-opencode";
import { OpenCodeAdapter } from "@weave/adapter-opencode";
import { createInMemoryRuntimeStore } from "@weave/engine";
import { loadConfig } from "@weave/config";

const adapter = new OpenCodeAdapter({ projectRoot: process.cwd() });
await adapter.init();

const configResult = await loadConfig(process.cwd());
if (configResult.isErr()) { /* handle */ }
const config = configResult.value;

const store = createInMemoryRuntimeStore(); // or SqliteRuntimeStore for production

const result = await runWorkflow({
  config,
  workflowName: "plan-and-execute",
  goal: "Add OAuth2 login support",
  slug: "add-oauth2-login",
  adapter,
  store,
  planStateProvider: adapter.planStateProvider, // for plan_created / plan_complete steps
});

result.match(
  ({ status, stepsDispatched, appliedEffects }) => {
    log.info({ status, stepsDispatched }, "Workflow finished");
  },
  (err) => {
    log.error({ err }, "Workflow failed");
  },
);
```

### `runWorkflow` execution flow

1. Validates the workflow name exists in `config.workflows`.
2. Calls `startExecution` to acquire a lease and create the `WorkflowInstance`.
3. Calls `dispatchStep` to resolve the first step and emit a `DispatchAgentEffect`.
4. Applies the `DispatchAgentEffect` by calling `adapter.spawnSubagent`.
5. Calls `completeStep` — the engine auto-advances and emits the next
   `dispatch-agent` effect (or `complete-execution` for the final step).
6. Applies the auto-advance `dispatch-agent` effect and repeats from step 5
   until `complete-execution` or `pause-execution` is emitted.

**Auto-advance semantics**: `completeStep` with `context` and `outcome: "success"`
emits a `dispatch-agent` effect for the next step. `runWorkflow` applies this
effect directly — it does NOT call `dispatchStep` again, which would
double-dispatch the same step.

### `RunWorkflowInput` fields

| Field | Type | Description |
| --- | --- | --- |
| `config` | `WeaveConfig` | Full config containing workflow definitions |
| `workflowName` | `string` | Name of the workflow to execute |
| `goal` | `string` | Human-readable goal for this execution instance |
| `slug` | `string` | URL-safe slug derived from the goal |
| `adapter` | `OpenCodeAdapter` | Adapter instance — `spawnSubagent` is called for each effect |
| `store` | `RuntimeStore?` | Runtime Store (defaults to `InMemoryRuntimeStore`) |
| `planStateProvider` | `PlanStateProvider?` | Required for `plan_created`/`plan_complete` steps |
| `ownerId` | `string?` | Lease owner ID (defaults to `"run-workflow"`) |
| `maxSteps` | `number?` | Safety cap on dispatched steps (defaults to `100`) |

### `RunWorkflowError` variants

| Type | Description |
| --- | --- |
| `WorkflowNotFound` | `workflowName` does not exist in `config.workflows` |
| `LifecycleError` | A lifecycle method returned an error (wraps `LifecycleError`) |
| `MaxStepsExceeded` | The `maxSteps` safety cap was reached |

---

## Public Exports Reference

All types and functions used in this guide are public exports:

| Symbol | Package | Description |
| --- | --- | --- |
| `loadConfig` | `@weave/config` | Load and merge all config layers |
| `materializeAgents` | `@weave/engine` | Compose all adapter-facing agent descriptors |
| `MaterializationPlan` | `@weave/engine` | `{ agents, errors }` — partial-by-default plan shape |
| `MaterializedAgent` | `@weave/engine` | `{ agentName, descriptor }` pair |
| `MaterializationError` | `@weave/engine` | `CategoryShuttleConflict` or `DescriptorCompositionFailure` |
| `AgentDescriptor` | `@weave/engine` | Stable adapter-facing descriptor (prompt, models, policy, …) |
| `startExecution` | `@weave/engine` | Begin a workflow execution |
| `resumeExecution` | `@weave/engine` | Resume a paused execution |
| `handleUserInterrupt` | `@weave/engine` | Handle a user-initiated interrupt |
| `dispatchStep` | `@weave/engine` | Dispatch the next workflow step |
| `completeStep` | `@weave/engine` | Record step completion and advance the workflow |
| `beforeTool` | `@weave/engine` | Evaluate abstract tool policy before a tool executes |
| `observeSession` | `@weave/engine` | Record a normalized session observation |
| `LifecycleEffect` | `@weave/engine` | `dispatch-agent` / `pause-execution` / `complete-execution` |
| `LifecycleError` | `@weave/engine` | Discriminated union: `validation`, `not_found`, `lease_conflict`, `persistence`, `policy_decision` |
| `createInMemoryRuntimeStore` | `@weave/engine` | In-memory `RuntimeStore` for tests and ephemeral runs |
| `SqliteRuntimeStore` | `@weave/engine` | Production SQLite-backed `RuntimeStore` |
| `logger` | `@weave/engine` | Shared pino logger instance |
| `runWorkflow` | `@weave/adapter-opencode` | End-to-end workflow execution loop for the OpenCode adapter |
| `RunWorkflowInput` | `@weave/adapter-opencode` | Input type for `runWorkflow` |
| `RunWorkflowResult` | `@weave/adapter-opencode` | Output type for `runWorkflow` |
| `RunWorkflowError` | `@weave/adapter-opencode` | Error union for `runWorkflow` |

---

## What Adapters Own After Bootstrap

Once `materializeAgents` returns `plan.agents`, the adapter owns:

- **Concrete model selection** — check harness model availability, apply
  selected-model state, format the model field for the harness.
- **Tool-name mapping** — translate abstract capabilities (`read`, `write`,
  `execute`, `delegate`, `network`) from `descriptor.effectiveToolPolicy` into
  concrete harness tool names and permission settings.
- **Plugin/config generation** — write harness-specific config files, register
  plugins, or update runtime state.
- **Feature-gap emulation** — implement sub-agent behavior, routing, or other
  capabilities the harness lacks natively.
- **Lifecycle event mapping** — detect harness-specific events (session idle,
  user interrupt, tool invocation) and map them into the 7 lifecycle methods.
- **Effect application** — spawn agents, pause sessions, update UI state in
  response to `LifecycleEffect` values returned by the engine.

The engine never writes harness config files, spawns harness agents, or
registers concrete harness callbacks. See [Adapter Boundary](adapter-boundary.md)
for the full ownership matrix and anti-patterns.
