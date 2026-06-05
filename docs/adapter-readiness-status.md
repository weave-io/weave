# Adapter Readiness Status

This document summarises the current adapter-readiness state of the Weave engine
API — what user capabilities are available, which specs deliver them, and what
every adapter must implement to be considered ready.

**Related:** [Adapter Boundary](adapter-boundary.md) · [Adapter Bootstrap Guide](adapter-bootstrap.md) · [Harness Agent Surface Patterns](harness-agent-surface-patterns.md) · [ADR 0003 — OpenCode Adapter Materialization Shape](adr/0003-opencode-adapter-materialization-shape.md) · [ADR 0004 — Workflow-First Execution Contract](adr/0004-workflow-first-execution-contract.md) · [Spec 15 — Adapter-Facing Materialization API](specs/15-spec-adapter-facing-materialization-api/15-spec-adapter-facing-materialization-api.md) · [Spec 17 — Workflow Extension DSL](specs/17-spec-workflow-extension/17-spec-workflow-extension.md) · [Spec 18 — Delegation Exclusion](specs/18-spec-delegation-exclusion/18-spec-delegation-exclusion.md) · [Spec 19 — Plan State Provider](specs/19-spec-plan-state-provider/19-spec-plan-state-provider.md) · [Spec 20 — OpenCode Adapter Materialization](specs/20-spec-opencode-adapter-materialization/20-spec-opencode-adapter-materialization.md) · [Spec 22 — Workflow-First Execution](specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md)

---

## User Capabilities

All five user-facing capabilities are ✅ **Ready** — the engine API is stable
and adapters can implement them today.

| #   | Capability                                                                                               | Status   | Delivered by                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Modify builtin agents** — override Loom, Tapestry, Shuttle, etc. via `.weave/config.weave`             | ✅ Ready | [Spec 15](specs/15-spec-adapter-facing-materialization-api/15-spec-adapter-facing-materialization-api.md) · `materializeAgents`                           |
| 2   | **Create custom agents** — declare new agents with prompts, models, tool policy, and skills              | ✅ Ready | [Spec 15](specs/15-spec-adapter-facing-materialization-api/15-spec-adapter-facing-materialization-api.md) · `materializeAgents`                           |
| 3   | **Create categories** — declare domain-routing categories that generate `shuttle-{name}` agents          | ✅ Ready | [Spec 15](specs/15-spec-adapter-facing-materialization-api/15-spec-adapter-facing-materialization-api.md) · `generateCategoryShuttles`                    |
| 4   | **Modify workflow routing** — extend builtin workflows, insert/replace steps, exclude delegation targets | ✅ Ready | [Spec 17](specs/17-spec-workflow-extension/17-spec-workflow-extension.md) · [Spec 18](specs/18-spec-delegation-exclusion/18-spec-delegation-exclusion.md) |
| 5   | **Track plan state** — use `plan_created`/`plan_complete` completion methods in workflow steps           | ✅ Ready | [Spec 19](specs/19-spec-plan-state-provider/19-spec-plan-state-provider.md) · `PlanStateProvider`                                                         |

---

## What Adapters Must Implement

Every adapter must implement the three methods on the `HarnessAdapter` interface
(exported from `@weave/engine`):

```ts
interface HarnessAdapter {
  /** One-time initialisation before any agent is materialised. */
  init(): Promise<void>;

  /** Discover and return all skills available in this harness instance. */
  loadAvailableSkills(): Promise<SkillInfo[]>;

  /** Materialise a single agent from the engine-composed descriptor. */
  spawnSubagent(descriptor: AgentDescriptor): Promise<void>;
}
```

### `init()`

Called exactly once by the bootstrap entry point before any other adapter
method. Use it for one-time harness setup: loading config, connecting to
runtime APIs, or verifying the harness environment.

### `loadAvailableSkills()`

Called once during the bootstrap sequence, after `init()` and before agent
materialisation. Return a flat list of `SkillInfo` descriptors representing
every skill available in the harness. The engine matches each agent's declared
`skills [...]` entries against `SkillInfo.name` values. Return an empty array
when the harness does not support skills.

### `spawnSubagent(descriptor)`

Called once per non-disabled agent (including generated `shuttle-{category}`
agents). The `AgentDescriptor` carries the engine-composed prompt, ordered
model intent, effective tool policy, delegation targets, and category metadata.
The adapter owns all concrete harness translation: model selection, tool-name
mapping, plugin/config generation, and feature-gap emulation.

See [Adapter Bootstrap Guide](adapter-bootstrap.md) for the canonical
`loadConfig → materializeAgents → adapter loop` pattern with a runnable
`MockAdapter` example.

---

## OpenCode Adapter — First-Slice Materialization

`@weave/adapter-opencode` is a real first-slice materialization path as of
[Spec 20](specs/20-spec-opencode-adapter-materialization/20-spec-opencode-adapter-materialization.md).
It is an **OpenCode plugin**: users install it by adding the package to the
`plugin` array in their `opencode.json` config. OpenCode loads the plugin at
startup and calls the plugin entry point with a runtime context that includes
a pre-constructed SDK client.

### What is implemented (first slice)

| Capability                                         | Status | Notes                                                                                                                        |
| -------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Injected `OpenCodeClientFacade`                    | ✅     | No global SDK state; testable with mocks                                                                                     |
| `list → reconcile → create/update` flow            | ✅     | `reconcile-agent.ts`                                                                                                         |
| `[weave-managed]` ownership tag                    | ✅     | Embedded in agent `description`; prevents silent overwrite                                                                   |
| Collision protection                               | ✅     | `CollisionError` returned for same-named foreign agents                                                                      |
| Model resolution with fail-fast                    | ✅     | `model-resolution.ts`; subagent explicit model intent fails fast                                                             |
| Harness-injection-based skill forwarding           | ✅     | `loadAvailableSkills()` returns injected list; no filesystem scanning                                                        |
| Translation-only mode (no client)                  | ✅     | Falls back gracefully when no client is injected                                                                             |
| `BunFilesystemPlanStateProvider`                   | ✅     | Constructed in `init()`; available for `completeStep` calls                                                                  |
| `config` hook — `opencode debug config` visibility | ✅     | `WeavePlugin` returns `Hooks.config` that injects agents into `cfg.agent` at startup                                         |
| `event` hook — deferred SDK reconciliation         | ✅     | SDK-backed `spawnSubagent()` deferred to first `session.created` event; `opencode debug config` never blocks on SDK/DB calls |

### Explicit non-goals (first slice)

The following are **out of scope** for the first slice and will be addressed in
future specs:

- **Prune/delete reconciliation** — Weave-managed agents that are no longer in
  config are not removed. Removal requires UX design (confirmation, dry-run).
- **Workflow-lifecycle expansion** — `run-workflow.ts` is a thin helper; full
  workflow lifecycle integration is a separate spec.
- **Engine API drift** — No new engine contracts were introduced. The adapter
  boundary rules in [Adapter Boundary](adapter-boundary.md) are unchanged.
- **Harness-owned skill file loading** — The adapter forwards the harness-provided
  `SkillInfo[]` list but does not load skill file content. Content loading is
  harness-owned and out of scope.

### Installation and runtime story

```jsonc
// opencode.json
{
  "plugin": ["@weave/adapter-opencode/plugin"],
}
```

> **Important**: Use the `@weave/adapter-opencode/plugin` subpath export, not the bare package name.
> The bare `@weave/adapter-opencode` entry (`dist/index.js`) exports non-function values (constants,
> type re-exports) that cause OpenCode's `getLegacyPlugins` loader to throw
> `TypeError: Plugin export is not a function`. The `./plugin` subpath (`dist/plugin.js`) exports
> only the plugin function and is the correct entry point for OpenCode.

After adding the plugin entry, restart OpenCode. The `./plugin` bundle's default-exported
`WeavePlugin` function is called by OpenCode at startup. It loads
`.weave/config.weave`, translates all declared agents, and returns a `Hooks`
object **immediately** — without blocking on any SDK or DB calls.

The returned `Hooks` object contains two hooks:

- **`config` hook** — injects the translated agent configs into `cfg.agent` so
  that `opencode debug config` shows all Weave-managed agents. This is pure
  computation (no SDK calls) and runs synchronously at startup.
- **`event` hook** — defers SDK-backed reconciliation (`adapter.init()` +
  `spawnSubagent()`) to the first `session.created` event. This ensures
  `opencode debug config` never hangs waiting for the OpenCode runtime store.
  Reconciliation runs exactly once per plugin activation.

> **Why deferred?** `opencode debug config` calls the plugin function and
> exercises only the `config` hook. The previous design called `adapter.init()`
> and `spawnSubagent()` eagerly before returning `Hooks`, which blocked
> `debug config` because the runtime SDK path (`client.app.agents()` / DB) is
> not available in that context. The `event` hook fires only during real
> OpenCode sessions, never during `debug config`.

**No user-authored wrapper script is required.** The `./plugin` bundle is the
plugin entry point. The `WeavePlugin` function, a `server` alias (for
`PluginModule` compatibility), and a `createWeavePlugin(options?)` factory are
all exported from `@weave/adapter-opencode/plugin`.

See [ADR 0003 — OpenCode Adapter Materialization Shape](adr/0003-opencode-adapter-materialization-shape.md)
for the full design rationale and [Spec 20](specs/20-spec-opencode-adapter-materialization/20-spec-opencode-adapter-materialization.md)
for the normative spec.

---

## SDK Version Pin

The OpenCode adapter (`@weave/adapter-opencode`) pins `@opencode-ai/sdk` at
`~1.15.9` (currently resolved to `1.15.10`).

> **Review on SDK major bumps.** The `~` range allows patch updates but not
> minor or major bumps. When `@opencode-ai/sdk` releases a new major version,
> review the changelog for breaking changes to the plugin API, session model,
> tool registration, or agent lifecycle before updating the pin. The adapter
> boundary rules in [Adapter Boundary](adapter-boundary.md) must still hold
> after any SDK update.

---

## Spec Cross-Reference

| Spec                                                                                                      | Title                              | Adapter impact                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [Spec 15](specs/15-spec-adapter-facing-materialization-api/15-spec-adapter-facing-materialization-api.md) | Adapter-Facing Materialization API | `materializeAgents` is the stable entry point; adapters call it instead of the removed `WeaveRunner`                                            |
| [Spec 17](specs/17-spec-workflow-extension/17-spec-workflow-extension.md)                                 | Workflow Extension DSL             | `extends`, `insert_before`, `insert_after` resolved by `@weave/config` before the engine sees `WorkflowConfig`; no adapter changes needed       |
| [Spec 18](specs/18-spec-delegation-exclusion/18-spec-delegation-exclusion.md)                             | Delegation Exclusion               | `routing.delegation_exclude` filtered inside `buildDelegationTargets()`; adapters receive pre-filtered `delegationTargets` on `AgentDescriptor` |
| [Spec 19](specs/19-spec-plan-state-provider/19-spec-plan-state-provider.md)                               | Plan State Provider                | Adapters supply a `PlanStateProvider` to `completeStep`; use `BunFilesystemPlanStateProvider` from `@weave/config` for production               |
| [Spec 22](specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md)                     | Workflow-First Execution           | Commands, hooks, skills, scripts, and UI are adapter-owned projections of the engine-owned execution contract; adapters declare delivery via `command-entrypoints` readiness |

---

## Execution-Command Readiness (Spec 22 Unit 4)

**Commands, hooks, skills, scripts, and UI affordances are all adapter-owned projections of the same engine-owned execution contract.** The engine defines what execution means — `startExecution` is the sole authorized entry point, and the engine owns all state transitions, lease management, and effect emission. Adapters own the concrete delivery mechanism that exposes the explicit user-authorized trigger in their harness. No delivery form is privileged over another; what matters is that the trigger is explicit and user-authorized.

Adapters declare `command-entrypoints` readiness to model how they expose the
explicit user-authorized trigger that crosses the durable execution boundary.
This is the **canonical execution-entry capability** — it is the only capability
that gates whether a harness can initiate durable workflow execution.

### `command-entrypoints` readiness values

| Readiness | Meaning | Example |
| --- | --- | --- |
| `native` | The harness exposes literal commands that the user invokes directly | OpenCode slash commands |
| `emulated` | No native commands, but an equivalent explicit delivery path exists (skill, script, UI button, or helper) that the user must invoke deliberately | A skill that calls `startExecution` when triggered |
| `degraded` | An explicit start path exists but is incomplete or inconsistent (e.g. only some workflows are reachable) | Partial command surface |
| `unsupported` | No reliable explicit start path exists in this harness | Harness has no user-facing execution trigger |

`emulated` satisfies the Core Readiness Profile — a harness without literal
commands can still be fully ready by providing an equivalent explicit delivery
path (skill, script, or UI). `degraded` and `unsupported` fail the profile.

**Command naming is adapter-owned.** The engine does not prescribe a specific
command name. For command-capable adapters, `/weave:start` is the preferred
concrete spelling when feasible — it signals Weave ownership and avoids
collision with harness-native commands. `/start-work` is legacy/compatibility
language for the OpenCode adapter only. `/run-workflow` is an explicit
named-workflow helper (not the general execution entry point) — use it when the
user wants to invoke a specific named workflow by name rather than starting the
default execution path.

### `workflow-step-dispatch` is supporting execution context

`workflow-step-dispatch` models the engine's ability to resolve and dispatch
individual workflow steps **once execution has already started**. It is NOT a
second execution-entry capability and must not be treated as a substitute for
`command-entrypoints` readiness.

A harness that can dispatch steps (`workflow-step-dispatch: native`) but has no
explicit start path (`command-entrypoints: unsupported`) still fails the Core
Readiness Profile. The two capabilities model different concerns:

- `command-entrypoints` — can the user explicitly start durable execution?
- `workflow-step-dispatch` — can the engine dispatch steps within a running execution?

### Adapter declaration example

```ts
// Command harness (native slash commands) — /weave:start is the preferred spelling
{
  id: "command-entrypoints",
  description: "Execution command entrypoints",
  readiness: "native",
  notes: "Exposes /weave:start (general execution entry) and /run-workflow (named-workflow helper)",
}

// Non-command harness (skill/script delivery)
{
  id: "command-entrypoints",
  description: "Execution command entrypoints",
  readiness: "emulated",
  notes: "No native command surface; execution is started via an explicit skill invocation that the user must trigger deliberately",
}
```

See [Spec 22 — Workflow-First Execution](specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md) (Unit 4)
and [ADR 0004 — Workflow-First Execution Contract](adr/0004-workflow-first-execution-contract.md) for the full rationale.

---

## OpenCode Adapter Delivery Evidence (Task 6.3)

`@weave/adapter-opencode` provides the canonical example of an adapter-owned projection of the engine-owned execution contract. The delivery path is `packages/adapters/opencode/src/run-workflow.ts` — an explicit user-driven helper that calls `startExecution` only when invoked deliberately by a user-authorized trigger.

### What the evidence proves

| Proof | Evidence |
| --- | --- |
| Execution enters only through explicit `runWorkflow` calls | Store is empty before any call; `WorkflowInstance` is created only after an explicit `runWorkflow` invocation |
| Idle hooks and session events do not start durable execution | Without an explicit `runWorkflow` call, the store remains empty |
| Each explicit call creates a distinct `WorkflowInstance` | `result1.workflowInstanceId !== result2.workflowInstanceId` |
| `PlanStateProvider` is supplied at plan-oriented completion boundaries | Absent provider → `policy_decision` error (fail closed); present provider → completion succeeds or fails based on plan state |
| Implicit paths are structurally excluded | `runWorkflow` is never wired to idle hooks, session events, or continuation hooks |

### Test run results

```text
bun test packages/adapters/opencode/src/__tests__/run-workflow.test.ts

21 pass, 0 fail, 75 expect() calls
Ran 21 tests across 1 file. [78.00ms]
```

| Describe block | Tests | Coverage |
| --- | --- | --- |
| `runWorkflow` (basic execution loop) | 8 | 2-step, 3-step, default store, instance ID, agent_signal isolation |
| `runWorkflow — explicit user-driven delivery path` | 4 | Store empty before call; instance created after; distinct IDs; validation before store access |
| `runWorkflow — PlanStateProvider at completion boundaries` | 9 | Absent provider fail-closed; present provider success/failure; provider isolation; boundary proof |

See [22-task-06-3-proofs.md](specs/22-spec-workflow-first-execution/22-proofs/22-task-06-3-proofs.md) for the full proof artifact.

---

## Adapter Bootstrap Quick-Start

```text
loadConfig()  →  materializeAgents()  →  adapter loop: spawnSubagent(descriptor)
```

For workflow execution, wire the execution lifecycle surface after agent
materialisation:

```text
startExecution → dispatchStep → completeStep (repeat) → complete-execution
```

See [Adapter Bootstrap Guide](adapter-bootstrap.md) for the full runnable
example including workflow execution, `PlanStateProvider` injection, and the
`runWorkflow` convenience helper for the OpenCode adapter.
