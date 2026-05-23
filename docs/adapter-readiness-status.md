# Adapter Readiness Status

This document summarises the current adapter-readiness state of the Weave engine
API — what user capabilities are available, which specs deliver them, and what
every adapter must implement to be considered ready.

**Related:** [Adapter Boundary](adapter-boundary.md) · [Adapter Bootstrap Guide](adapter-bootstrap.md) · [Spec 15 — Adapter-Facing Materialization API](specs/15-spec-adapter-facing-materialization-api/15-spec-adapter-facing-materialization-api.md) · [Spec 17 — Workflow Extension DSL](specs/17-spec-workflow-extension/17-spec-workflow-extension.md) · [Spec 18 — Delegation Exclusion](specs/18-spec-delegation-exclusion/18-spec-delegation-exclusion.md) · [Spec 19 — Plan State Provider](specs/19-spec-plan-state-provider/19-spec-plan-state-provider.md)

---

## User Capabilities

All five user-facing capabilities are ✅ **Ready** — the engine API is stable
and adapters can implement them today.

| # | Capability | Status | Delivered by |
| - | ---------- | ------ | ------------ |
| 1 | **Modify builtin agents** — override Loom, Tapestry, Shuttle, etc. via `.weave/config.weave` | ✅ Ready | [Spec 15](specs/15-spec-adapter-facing-materialization-api/15-spec-adapter-facing-materialization-api.md) · `materializeAgents` |
| 2 | **Create custom agents** — declare new agents with prompts, models, tool policy, and skills | ✅ Ready | [Spec 15](specs/15-spec-adapter-facing-materialization-api/15-spec-adapter-facing-materialization-api.md) · `materializeAgents` |
| 3 | **Create categories** — declare domain-routing categories that generate `shuttle-{name}` agents | ✅ Ready | [Spec 15](specs/15-spec-adapter-facing-materialization-api/15-spec-adapter-facing-materialization-api.md) · `generateCategoryShuttles` |
| 4 | **Modify workflow routing** — extend builtin workflows, insert/replace steps, exclude delegation targets | ✅ Ready | [Spec 17](specs/17-spec-workflow-extension/17-spec-workflow-extension.md) · [Spec 18](specs/18-spec-delegation-exclusion/18-spec-delegation-exclusion.md) |
| 5 | **Track plan state** — use `plan_created`/`plan_complete` completion methods in workflow steps | ✅ Ready | [Spec 19](specs/19-spec-plan-state-provider/19-spec-plan-state-provider.md) · `PlanStateProvider` |

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

| Spec | Title | Adapter impact |
| ---- | ----- | -------------- |
| [Spec 15](specs/15-spec-adapter-facing-materialization-api/15-spec-adapter-facing-materialization-api.md) | Adapter-Facing Materialization API | `materializeAgents` is the stable entry point; adapters call it instead of the removed `WeaveRunner` |
| [Spec 17](specs/17-spec-workflow-extension/17-spec-workflow-extension.md) | Workflow Extension DSL | `extends`, `insert_before`, `insert_after` resolved by `@weave/config` before the engine sees `WorkflowConfig`; no adapter changes needed |
| [Spec 18](specs/18-spec-delegation-exclusion/18-spec-delegation-exclusion.md) | Delegation Exclusion | `routing.delegation_exclude` filtered inside `buildDelegationTargets()`; adapters receive pre-filtered `delegationTargets` on `AgentDescriptor` |
| [Spec 19](specs/19-spec-plan-state-provider/19-spec-plan-state-provider.md) | Plan State Provider | Adapters supply a `PlanStateProvider` to `completeStep`; use `BunFilesystemPlanStateProvider` from `@weave/config` for production |

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
