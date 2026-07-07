# Claude Code Adapter

> **Status**: Planning note — no Claude Code adapter package exists yet.
> **Purpose**: Define what is required to create `@weaveio/weave-adapter-claude-code` using the legacy OpenCode feature set as a comparison baseline.

**Related:** [Product Vision](product-vision.md) · [Adapter Boundary](adapter-boundary.md) · [Legacy Architecture](legacy-architecture.md) · [Model Resolution](model-resolution.md) · [Tool Policy Evaluation](tool-policy-evaluation.md) · [Harness Agent Surface Patterns](harness-agent-surface-patterns.md) · [Spec 07 — Adapter Capability Contract](specs/07-spec-adapter-capability-contract/07-spec-adapter-capability-contract.md) · [Spec 09 — Adapter-Provided Skill Resolution](specs/09-spec-adapter-provided-skill-resolution/09-spec-adapter-provided-skill-resolution.md)

---

## Summary

A Claude Code adapter is feasible with Weave's current engine surfaces, but the first version should be treated as a **materialization adapter**, not a full legacy-OpenCode-equivalent runtime adapter.

Weave can already normalize or resolve:

- agents and generated category shuttles
- prompt declarations and prompt-file references
- ordered model preferences
- abstract `tool_policy` declarations
- adapter capability declarations
- adapter-provided skills

The Claude Code adapter would translate those normalized descriptors into Claude Code's filesystem conventions:

- `.claude/agents/*.md` for subagents
- `.claude/commands/*.md` and `~/.claude/commands/*.md` for command-like skills
- `~/.claude/settings.json` and project `.claude/settings.json` where safe for settings-level integration

The main gap versus the legacy OpenCode baseline is runtime lifecycle control. Legacy OpenCode-Weave was a plugin inside OpenCode's lifecycle and could observe session events, route commands, inject prompts, pause execution, track analytics, and coordinate workflows. Claude Code's public file-based integration surface is strong for agents and commands, but it is not sufficient for this runtime class of features.

The legacy runtime features listed as initially unsupported below **must be supported through a Claude Code lifecycle/plugin API**. Weave should not claim support for workflow persistence, workflow step dispatch, idle continuation, compaction recovery, context-window monitoring, analytics, eval execution, or multiple active workflows unless the Claude Code adapter has a real lifecycle/plugin integration point that can observe and control the relevant runtime events.

---

## Current Baseline

| Area | Current state |
| --- | --- |
| `HarnessAdapter` interface | Exists in `packages/engine/src/adapter.ts` |
| Bootstrap path | `loadConfig()` → `materializeAgents()` → adapter loop (`docs/adapter-bootstrap.md`) |
| Model intent helper | Exists in `packages/engine/src/model-resolution.ts` |
| Tool-policy helper | Exists in `packages/engine/src/tool-policy.ts` |
| Capability contract | Exists in `packages/engine/src/capability-contract.ts` |
| Skill resolution | Exists in `packages/engine/src/skill-resolution.ts` |
| Claude Code detection | CLI detection probes Claude config/binary |
| Claude Code installer | Currently unsupported/stubbed |
| OpenCode adapter package | Skeleton only; not a complete implementation baseline |
| Claude Code adapter package | Does not exist yet |

Because the current OpenCode adapter package is only a skeleton, the useful baseline is `docs/legacy-architecture.md`, not runnable adapter code.

---

## Package to Add

```txt
packages/adapters/claude-code/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
└── src/
    ├── index.ts
    ├── adapter.ts
    ├── capability-contract.ts
    ├── agent-translation.ts
    ├── tool-classification.ts
    ├── skill-discovery.ts
    ├── model-resolution.ts
    └── __tests__/
        ├── adapter.test.ts
        ├── capability-contract.test.ts
        ├── agent-translation.test.ts
        ├── tool-classification.test.ts
        └── skill-discovery.test.ts
```

The package should be named `@weaveio/weave-adapter-claude-code` and depend on `@weaveio/weave-core`, `@weaveio/weave-engine`, and `neverthrow`.

---

## Adapter Responsibilities

### `adapter.ts`

`ClaudeCodeAdapter` should implement `HarnessAdapter`.

`init()` should:

- perform read-only Safe Adapter Init checks
- detect Claude Code settings files and binary availability
- build a Claude Code `AdapterCapabilityContract`
- pass declarations and probes to `buildAdapterHealthReport()`
- log readiness using the shared engine logger

`loadAvailableSkills()` should:

- discover Claude Code-visible skills, commands, and prompt assets when they can
  be represented as `SkillInfo`
- return a flat adapter-owned skill list for engine-side resolution
- return `[]` when the adapter intentionally ships without skill support in an
  initial slice

`spawnSubagent(descriptor)` should:

- resolve the best model using `resolveAdapterModelIntent()` and Claude Code's adapter-provided model context
- evaluate concrete Claude tool decisions using `resolveToolDecisions()`
- translate the engine-composed `AgentDescriptor` into Claude Code agent markdown
- write `.claude/agents/<descriptor.name>.md`

Earlier placeholder methods such as `registerHook()` and `loadSkill()` are not part of the current `HarnessAdapter` interface. If Claude Code eventually exposes a safe lifecycle API, the adapter should map those events into the engine lifecycle surface rather than reviving deprecated engine-owned methods.

### `agent-translation.ts`

Translate a Weave agent into Claude Code's markdown agent format.

Example output:

```md
---
name: loom
description: Loom primary coordinator
model: claude-sonnet-4-5
tools:
  - Read
  - Write
  - Edit
  - Bash
---

<resolved prompt content>
```

The translator should map:

- `description`
- `models` after adapter model resolution
- `temperature` only if Claude Code has a supported equivalent
- `tool_policy` after concrete tool classification
- `composedPrompt`

Generated category shuttles should be materialized exactly like normal agents because the engine already expands category descriptors.

### `tool-classification.ts`

Claude Code tool names are concrete harness vocabulary. The adapter should classify them into Weave's abstract capabilities before calling the engine's tool-policy helper.

Initial mapping:

| Claude Code tool | Weave capability |
| --- | --- |
| `Read` | `read` |
| `Write` | `write` |
| `Edit` | `write` |
| `MultiEdit` | `write` |
| `Bash` | `execute` |
| `Task` | `delegate` |
| `WebFetch` | `network` |
| `WebSearch` | `network` |

### `skill-discovery.ts`

Claude Code command files can act as the closest adapter-owned analogue to Weave skills.

Discover:

```txt
~/.claude/commands/*.md
.claude/commands/*.md
```

Then pass discovered skill descriptors into Weave's skill-resolution helpers. The engine should match declared `skills [...]` against adapter-provided `SkillInfo[]`; it must not scan Claude Code directories directly.

### `model-resolution.ts`

If Claude Code does not expose a stable model registry API, the adapter should provide a conservative static model list and optionally read a user-selected/default model from settings when available. That context is then passed to `resolveAdapterModelIntent()`.

---

## Capability Readiness

The first Claude Code adapter should declare partial support explicitly. Unsupported does not mean impossible forever; it means the capability is not available through Claude Code's file-based agent/command surface. For the legacy runtime capabilities, support must come from Claude Code's lifecycle/plugin API rather than from generated files alone.

| Capability | Initial status | Reason |
| --- | --- | --- |
| Config materialization | `native` or `emulated` | Settings and project files can be read/written safely by an installer/materializer. |
| Agent materialization | `native` | Claude Code supports file-backed agents in `.claude/agents/*.md`. |
| Primary agent selection | `native` or `emulated` | Can be represented through model/default settings or generated command/agent conventions, depending on Claude Code's exact supported fields. |
| Delegated specialist execution | `emulated` | Subagents can be generated, but Weave cannot fully control Claude Code's runtime delegation scheduler. |
| Prompt composition | `native` | Agent markdown bodies are prompt material. |
| Tool-policy mapping | `emulated` | Abstract policy can be translated to Claude Code tool names, but semantics may be coarser than Weave's internal policy model. |
| Plan-file compatibility | `emulated` | `.weave/plans/*.md` remains ordinary project files readable by Claude Code agents. |
| Command entrypoints | `emulated` | `.claude/commands/*.md` can represent command-like entrypoints. |
| Static artifact generation | `emulated` | The adapter can write generated files. |
| Event logging | `native` or `degraded` | Claude Code may expose logs, but not necessarily all events Weave needs for legacy analytics/workflows. |
| Workflow persistence | `unsupported` | See below. |
| Workflow step dispatch | `unsupported` | See below. |
| Idle continuation | `unsupported` | See below. |
| Compaction recovery | `unsupported` | See below. |
| Context-window monitor | `unsupported` | See below. |
| Analytics dashboard | `unsupported` | See below. |
| Eval integration | `unsupported` | See below. |
| Multiple active workflows | `unsupported` | See below. |

---

## Why Some Legacy Features Are Initially Unsupported

### Workflow persistence

Legacy OpenCode-Weave persisted and resumed workflow state inside its own plugin/domain layer. It could track active plan/workflow state, execution leases, step status, pause/resume signals, and command routing.

Claude Code agent and command files do not provide a documented workflow-state store or transaction model. Weave can still write `.weave/plans/*.md`, but that is **plan-file compatibility**, not runtime workflow persistence. Full support requires a Claude Code lifecycle/plugin API that lets the adapter persist and restore workflow state in response to command/session lifecycle events.

### Workflow step dispatch

Legacy OpenCode-Weave could dispatch workflow steps because it sat inside the host lifecycle and could inject prompts, route commands, switch agents, and pause execution.

Claude Code file-backed agents do not give the adapter a documented control point for saying: "now execute workflow step 3 with this agent, capture the result, then gate step 4." A command file can instruct the model, but it cannot enforce a durable step dispatcher by itself.

To support this, Weave needs a Claude Code lifecycle/plugin API with prompt injection, event callbacks, agent/command routing, and step-result observation. A generated command file can describe intended behavior, but it cannot be the workflow dispatcher.

### Idle continuation

Legacy OpenCode-Weave relied on session-idle lifecycle hooks to continue work when an agent became idle.

Claude Code's file-based agent/command integration does not expose a stable `session idle` callback to adapters. Without that event, the adapter cannot know when to resume queued work or run continuation policy.

Support requires a Claude Code lifecycle/plugin idle event or equivalent runtime callback.

### Compaction recovery

Legacy OpenCode-Weave could react to compaction or recovery lifecycle points and inject recovery context.

Claude Code does not expose adapter-level compaction lifecycle callbacks through agent markdown or command files. The adapter can include recovery instructions in prompts, but it cannot reliably detect compaction and run recovery logic at the right moment.

That makes prompt-level guidance possible, but runtime compaction recovery requires Claude Code lifecycle/plugin callbacks for compaction and recovery events.

### Context-window monitor

Legacy OpenCode-Weave could estimate or observe session context usage as part of its runtime policy layer.

Claude Code's agent files do not expose current context-window usage, remaining tokens, or per-turn token accounting to the adapter. Without that telemetry, Weave cannot implement a trustworthy monitor.

Support requires lifecycle/plugin telemetry for context usage or token accounting. A degraded implementation might rely on rough prompt-size estimates, but that would not be equivalent to runtime context monitoring.

### Analytics dashboard

Legacy OpenCode-Weave had direct runtime effects for analytics tracking, including session/token/cost metrics.

Claude Code may have logs, but a generated-agent adapter does not automatically receive normalized events, token usage, cost data, agent switches, workflow-step outcomes, or command execution records. Without those inputs, Weave cannot produce the same analytics dashboard.

Support requires Claude Code lifecycle/plugin telemetry or a documented event/log API with the required fields.

### Eval integration

Legacy eval integration depends on controlled execution: known prompts, selected agents, captured outputs, status, and metrics.

A file materialization adapter can generate agents for Claude Code, but it cannot run Claude Code eval cases, capture structured results, and enforce repeatable model/tool settings through the normal agent-file surface.

Eval support requires a Claude Code lifecycle/plugin or non-interactive execution API that lets Weave control prompts, selected agents, tools, outputs, status, and metrics.

### Multiple active workflows

Legacy OpenCode-Weave could model active work ownership and workflow state because it owned a workflow service and execution coordinator inside the plugin.

Claude Code's standard UX is session-oriented. Agent and command files do not provide a namespaced runtime scheduler for multiple concurrent Weave workflows with independent state, leases, and pause/resume behavior.

Support requires a Claude Code lifecycle/plugin API that lets the adapter observe sessions, associate runtime work with workflow IDs, enforce leases, and pause/resume independent workflows.

---

## Implementation Order

1. Add the `@weaveio/weave-adapter-claude-code` package skeleton.
2. Implement pure `AgentConfig` → Claude agent markdown translation.
3. Implement Claude Code concrete tool classification.
4. Implement static/adapter-provided model context and model resolution.
5. Implement the adapter capability contract and Safe Adapter Init checks.
6. Implement mocked filesystem/process abstractions for adapter tests.
7. Add a CLI installer that can safely merge/scaffold Claude Code settings and directories.
8. Wire Claude Code command discovery into adapter-provided skill resolution.
9. Add package README and, if implementation proceeds, a formal spec under `docs/specs/`.

---

## Architectural Guidance

Do not move Claude Code resource discovery into `@weaveio/weave-engine`. The adapter owns Claude Code paths, settings files, command files, tool names, model availability, and runtime limitations.

Do not claim legacy OpenCode runtime parity unless there is a concrete Claude Code lifecycle/plugin API that can provide equivalent runtime observation and control.

The first useful milestone is reliable, testable materialization of `.weave` declarations into Claude Code agents and commands.
