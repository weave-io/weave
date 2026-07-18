# ADR 0006: End-to-End Orchestration Flow

**Status**: Accepted  
**Date**: 2026-06-04  
**Related**: [ADR 0004 — Workflow-First Execution Contract](0004-workflow-first-execution-contract.md) · [Spec 22 — Workflow-First Execution](../specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md) · [Workflow Schema](../workflow-schema.md) · [Adapter Boundary](../adapter-boundary.md) · [Legacy Architecture](../legacy-architecture.md) · [Product Vision](../product-vision.md)

---

## Context

Weave's orchestration flow — from a user's goal to a completed, reviewed implementation — spans several agents, a planning step, optional pre-plan discovery, and post-implementation gates. This flow has evolved across two distinct models:

1. **Legacy (OpenCode-specific)**: `/start-work` → Tapestry hook chain, with implicit continuation on `session.idle`.
2. **Harness-agnostic (current)**: Explicit `startExecution` lifecycle call → engine-owned workflow contract → adapter-delivered effects.

The two models share agent names (Loom, Tapestry, Weft, Warp) but differ fundamentally in where execution semantics live and how execution begins. This ADR documents the full end-to-end flow in one place, distinguishes the two models, and clarifies where issue [#52 — `[config] Add builtin default-plan workflow`](https://github.com/weave-io/weave/issues/52) fits relative to the plumbing built in PR #82.

---

## The Full Orchestration Flow (Current Model)

### Overview

```
User goal
    │
    ▼
Loom (primary agent — conversational triage)
    │
    ├─── Small / self-contained work ──────────────────────────────────────────►  Loom handles directly
    │                                                                              or delegates to Shuttle
    │
    └─── Large / multi-step work ──────────────────────────────────────────────►  Workflow execution path
             │
             ▼
         [Optional] before-plan steps
         (discovery, spec writing, spec review — user-configured)
             │
             ▼
         Pattern (planning step — role: planning)
         Creates .weave/plans/<slug>.md
             │
             ▼
         [User-authorized trigger: /weave start, /weave:start, or adapter equivalent]
         startExecution() — engine acquires ExecutionLease
             │
             ▼
         Tapestry (plan execution agent)
         Drives Shuttle workers task-by-task
             │
             ▼
         Weft (code review gate — review_verdict)
             │
             ▼
         Warp (security audit gate — review_verdict)
             │
             ▼
         Workflow complete / paused / failed
```

### Step-by-step

#### 1. Loom: conversational triage

Loom is the `primary` agent — the user-facing orchestrator. It handles all incoming work and decides whether to:

- **Handle directly** — for small, self-contained tasks (questions, quick edits, single-file changes).
- **Delegate to Shuttle** — for bounded coding tasks that don't need a plan.
- **Route to the workflow execution path** — for large, multi-step work that benefits from a plan.

Loom does not start durable execution on its own. Ordinary Loom conversation, idle events, and continuation hooks are explicitly forbidden from implicitly calling `startExecution`. See [ADR 0004](0004-workflow-first-execution-contract.md) for the enforcement rationale.

#### 2. Optional before-plan steps

For large work, the user may have configured `extend before-plan [...]` in their project `.weave/config.weave`. These steps run before the canonical planning step and produce reviewed artifacts (e.g. a specification document) that feed into planning.

Before-plan steps are user-configured, not builtin. The builtin `plan-and-execute` workflow publishes the `extension_points { before-plan }` slot; users fill it with their own steps. In v1, before-plan steps do not participate in reconciliation semantics.

See [Workflow Schema — before-plan Extension Surface](../workflow-schema.md#before-plan-extension-surface) for the full DSL contract.

#### 3. Pattern: planning step

Pattern is the `planning` agent. It reads the goal (and any before-plan artifacts) and writes a structured plan file to `.weave/plans/<slug>.md`. The planning step uses `completion plan_created { plan_name "{{instance.slug}}" }` — the engine verifies the plan file exists before advancing.

The planning step carries `role planning` in the DSL. At most one step per workflow may carry this role.

#### 4. User-authorized execution trigger

After planning (or after plan review, if the user has configured a `user_confirm` step), the user explicitly starts durable execution. The adapter exposes this as a harness-appropriate trigger:

| Harness | Delivery form |
| --- | --- |
| OpenCode | `/run-workflow` command or `runWorkflow()` helper (`packages/adapters/opencode/src/run-workflow.ts`) |
| Claude Code | Native plugin slash command (`/weave:start`) |
| Pi | Equivalent explicit user action |
| Any harness | `command-entrypoints` readiness: `native`, `emulated`, `degraded`, or `unsupported` |

The adapter calls `startExecution(input, store)`. The engine creates a `WorkflowInstance`, acquires an `ExecutionLease`, and returns a `dispatch-agent` effect for the first step. The adapter applies the effect.

**This is the only authorized entry point for durable execution.** No other code path may create a `WorkflowInstance` or acquire an `ExecutionLease`. See [ADR 0004](0004-workflow-first-execution-contract.md).

#### 5. Tapestry: plan execution

Tapestry is the `implement` step agent in the builtin `plan-and-execute` workflow. It reads the plan file and executes each task, typically by delegating bounded coding tasks to Shuttle workers.

Tapestry's role is now defined by the `.weave` DSL — it is a named agent with declared capabilities, not a special hook-registered entity. The engine dispatches Tapestry through the same `RunAgentEffect` mechanism used for any other step agent.

#### 6. Weft and Warp: review and security gates

After implementation, the workflow advances to gate steps:

- **Weft** (`review` step, `type gate`) — code review. Returns `review_verdict`. On rejection, `on_reject pause` halts the workflow for user input.
- **Warp** (`security` step, `type gate`) — security audit. Returns `review_verdict`. On rejection, `on_reject pause` halts the workflow for user input.

Gate steps are the only steps that can reject. Rejection routes through the engine's `on_reject` policy (`pause`, `fail`, or `retry`). The engine owns this decision; adapters apply the resulting `pause-execution` or `complete-execution` effect.

---

## Legacy Model vs. Current Model

| Concern | Legacy (`/start-work`) | Current (workflow-first) |
| --- | --- | --- |
| Execution entry point | `/start-work` OpenCode command → `start-work-hook` → `switchAgent: "tapestry"` effect | `startExecution()` engine lifecycle method, called by adapter after explicit user trigger |
| Execution semantics owner | OpenCode adapter (hook callbacks, `switchAgent` effects) | Engine (`@weaveio/weave-engine`) — harness-agnostic |
| Continuation on idle | `workContinuation` hook fires on every `session.idle`, re-injects Tapestry context implicitly | `resumeExecution()` — requires explicit adapter-mediated trigger; idle hooks may call `observeSession` only |
| Tapestry's role | Registered via OpenCode-specific hook; activated by `switchAgent` effect | Named agent in `.weave` DSL; dispatched by engine through `RunAgentEffect` |
| Portability | OpenCode-only | Any harness that implements the adapter delivery path |
| State location | OpenCode session context + hook state | Engine-owned Runtime Store (`.weave/runtime/weave.db`) |

The legacy `/start-work` → Tapestry flow is documented in [`docs/legacy-architecture.md`](../legacy-architecture.md) as migration context. The OpenCode adapter may expose a backward-compatible command, but it must be implemented as an adapter-owned projection of `startExecution` — not as a hook-driven agent switch.

---

## Where Issue #52 Fits

> **⚠ Superseded interpretation** — The guidance below (adding `default_workflow`, selecting `plan-and-execute` as a hidden default, updating Loom's prompt to name a workflow) was the original reading of issue #52. [Spec 29 — Default Usage Is Not Workflow-Driven](../specs/29-spec-default-usage-not-workflow-driven/29-spec-default-usage-not-workflow-driven.md) supersedes that interpretation. Ordinary Weave usage is Loom-led; workflows are explicit, user-invoked constructs. The plumbing described below remains valid for named workflow execution; the "default on-ramp" framing does not apply to ordinary usage. Read this section as historical context only.

**Issue #52: `[config] Add builtin default-plan workflow`**

PR #82 built the execution plumbing:

- The engine's `startExecution` / `dispatchStep` / `completeStep` lifecycle surface (Spec 13, Spec 22).
- The `WorkflowInstance` and `ExecutionLease` runtime records (Spec 12).
- The `before-plan` extension point DSL and schema (Spec 22 Unit 2).
- The `plan-and-execute` builtin workflow in `packages/config/src/builtins.ts` — including the `extension_points { before-plan }` publication, the `role planning` step, and the Tapestry `implement` step.

**Issue #52 is the next layer**: it would define the canonical default route through that plumbing in builtin config. Concretely, this means deciding and declaring in `BUILTIN_WEAVE_SOURCE`:

1. **Which workflow is the default** when a user starts execution without specifying a workflow name. Currently `plan-and-execute` exists as a builtin but there is no engine or adapter mechanism that selects it as the default. Issue #52 would add that selection — either as a `settings { default_workflow "plan-and-execute" }` DSL field, an adapter convention, or an engine-level default resolution helper.

2. **Whether a default `extend before-plan` configuration ships as a builtin**. The `before-plan` slot is published by `plan-and-execute` but no builtin steps fill it. Issue #52 could add a minimal default (e.g. a `user_confirm` review step after planning) or leave the slot empty for users to fill.

3. **How Loom signals that large work should route to the default workflow**. Currently Loom's prompt describes delegation intent; issue #52 would make the routing explicit — either through a DSL `default_workflow` field that adapters read, or through a Loom prompt update that names the workflow.

In summary: **PR #82 built the roads; issue #52 paves the default on-ramp.**

---

## Consequences

### What this ADR clarifies

- The full agent sequence (Loom → before-plan → Pattern → trigger → Tapestry → Weft → Warp) is documented in one place.
- The distinction between legacy `/start-work` and the current `startExecution` model is explicit.
- Issue #52's scope is bounded: it is a config-layer concern (what the builtin DSL declares as the default route), not an engine or adapter concern.

### What remains adapter-owned

- The concrete delivery mechanism for `startExecution` (command, skill, script, UI button).
- The harness-specific trigger name (e.g. `/run-workflow`, `/weave start`, `/weave:start`).
- Continuation and compaction recovery behavior (adapters call `resumeExecution`; the engine does not auto-resume).

### What remains engine-owned

- The execution contract: `startExecution` is the sole authorized entry point.
- Step dispatch, artifact passing, gate decisions, and `on_reject` policy.
- The `WorkflowInstance` and `ExecutionLease` lifecycle.

### What issue #52 would add

> **⚠ Superseded** — See [Spec 29](../specs/29-spec-default-usage-not-workflow-driven/29-spec-default-usage-not-workflow-driven.md). The items below reflect the original interpretation; they are preserved as historical context.

- ~~A `default_workflow` DSL field or equivalent engine/adapter convention.~~ (Spec 29: ordinary usage is Loom-led; no hidden default workflow is selected.)
- ~~Optionally, a default `extend before-plan` configuration in builtins.~~ (Spec 29: pre-plan behavior belongs to Loom config/prompt composition, not workflow extension machinery.)
- ~~A Loom prompt or routing update that names the canonical workflow for large work.~~ (Spec 29: Loom's prompt may describe delegation intent, but it shall not implicitly select a workflow for ordinary usage.)

---

## References

- [`packages/config/src/builtins.ts`](../../packages/config/src/builtins.ts) — Builtin agent and workflow DSL source, including `plan-and-execute`, `quick-fix`, and `tapestry-execution`.
- [`packages/adapters/opencode/src/run-workflow.ts`](../../packages/adapters/opencode/src/run-workflow.ts) — OpenCode adapter's explicit user-driven `startExecution` delivery path.
- [`docs/adr/0004-workflow-first-execution-contract.md`](0004-workflow-first-execution-contract.md) — ADR establishing `startExecution` as the sole authorized execution entry point and forbidding implicit execution start.
- [`docs/specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md`](../specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md) — Normative spec for the workflow-first execution model.
- [`docs/workflow-schema.md`](../workflow-schema.md) — Workflow DSL fields, step types, completion methods, artifact passing, and the `before-plan` extension surface.
- [`docs/adapter-boundary.md`](../adapter-boundary.md) — Engine/adapter ownership matrix; Execution Lifecycle Surface section.
- [`docs/legacy-architecture.md`](../legacy-architecture.md) — Documents the `/start-work` → Tapestry flow this ADR supersedes.
- [`docs/product-vision.md`](../product-vision.md) — Harness-agnostic architecture and core mental model.
- [`docs/specs/29-spec-default-usage-not-workflow-driven/29-spec-default-usage-not-workflow-driven.md`](../specs/29-spec-default-usage-not-workflow-driven/29-spec-default-usage-not-workflow-driven.md) — Spec 29: supersedes the "add default_workflow" interpretation; defines ordinary usage as Loom-led.
