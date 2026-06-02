# ADR 0004: Workflow-First Execution Contract

**Status**: Accepted  
**Date**: 2026-06-02  
**Related**: [Spec 22 — Workflow-First Execution](../specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md) · [Adapter Boundary](../adapter-boundary.md) · [Context Glossary](../../CONTEXT.md) · [Product Vision](../product-vision.md) · [Spec 13 — Minimal Execution Lifecycle Surface](../specs/13-spec-minimal-execution-lifecycle-surface/13-spec-minimal-execution-lifecycle-surface.md) · [ADR 0002 — Runtime Persistence Store](0002-runtime-persistence-store.md) · [Legacy Architecture](../legacy-architecture.md)

---

## Context

### The legacy model

The alpha OpenCode-Weave system (documented in [`docs/legacy-architecture.md`](../legacy-architecture.md)) started durable execution through a chain of OpenCode-specific mechanisms:

1. The user typed `/start-work` in the OpenCode chat interface.
2. OpenCode parsed the command and fired the `start-work-hook`.
3. The hook produced a `switchAgent: "tapestry"` effect plus context injection with plan state.
4. Tapestry became the foreground agent and began executing the plan.
5. On `session.idle` events, the `workContinuation` hook re-injected a continuation prompt and another `switchAgent` effect to resume Tapestry automatically.
6. On `session.compacted` events, `compaction-recovery.ts` reconstructed execution state and re-injected plan or workflow context.

This model had three structural problems:

**1. Execution was OpenCode-specific.** The `/start-work` command, `switchAgent` effect, `session.idle` hook, and `session.compacted` hook are OpenCode runtime concepts. No other harness (Pi, Claude Code, Codex) could implement the same flow without replicating OpenCode-specific hook registration and effect application. Portability required a different foundation.

**2. Execution could start implicitly.** The `workContinuation` hook fired on every `session.idle` event and re-injected Tapestry context whenever an incomplete plan existed. This meant that ordinary Loom conversation could silently become durable execution if the session went idle while a plan was open. There was no explicit user-authorized transition separating conversational work from durable workflow execution.

**3. Execution semantics lived in the adapter.** The decision of when to start, resume, pause, or advance execution was encoded in OpenCode-specific hook callbacks and effect handlers. The engine had no harness-neutral model of execution state. This made it impossible to reason about execution correctness independently of the OpenCode runtime.

### The harness-agnostic successor

Weave's product vision (see [`docs/product-vision.md`](../product-vision.md)) requires that execution semantics be engine-owned and harness-agnostic. The engine should define what execution means; adapters should define how execution is delivered in a specific harness.

Spec 12 (Runtime Persistence Store, see [ADR 0002](0002-runtime-persistence-store.md)) established the `WorkflowInstance` and `ExecutionLease` as the engine-owned runtime concepts for tracking durable execution state. Spec 13 (Minimal Execution Lifecycle Surface) defined seven typed lifecycle methods — `observeSession`, `startExecution`, `resumeExecution`, `handleUserInterrupt`, `dispatchStep`, `completeStep`, and `beforeTool` — as the engine-owned API that adapters call after mapping harness events into normalized inputs.

Spec 22 (Workflow-First Execution) builds on these foundations to make the execution boundary explicit and portable.

---

## Decision

### 1. Execution is an engine-owned workflow contract

Weave defines execution as a durable, engine-owned contract for starting, resuming, pausing, inspecting, and advancing workflow runs. The contract is expressed through the seven lifecycle methods in `packages/engine/src/execution-lifecycle.ts` and grounded in `WorkflowInstance` and `ExecutionLease` records in the Runtime Store.

The contract is harness-agnostic: it defines what execution means without assuming any specific harness command, hook, event name, or session model. Adapters implement the delivery path; the engine owns the semantics.

### 2. Execution requires an explicit, user-authorized transition

Durable execution begins only through an explicit, user-authorized transition. The engine enforces this through `startExecution`: a lifecycle method that creates a `WorkflowInstance` and acquires an `ExecutionLease`. Nothing else starts durable execution.

The following paths are explicitly forbidden from implicitly starting durable execution:

- Ordinary Loom conversation (chat turns, tool calls, model responses)
- Session idle events or idle hooks
- Continuation hooks or compaction recovery
- Lifecycle observations (`observeSession`)
- Agent-initiated self-start (no agent may call `startExecution` on its own behalf without an explicit user-authorized signal)

This replaces the legacy model where `session.idle` could silently resume Tapestry and where `/start-work` was the only explicit boundary — a boundary that was OpenCode-specific and not portable.

### 3. Adapters are delivery layers, not semantic owners

Adapters expose the execution contract through harness-appropriate mechanisms: commands, skills, hooks, scripts, or UI affordances. The adapter decides how a user triggers execution in a specific harness; the engine decides what happens when that trigger fires.

Examples of valid adapter delivery paths:
- A harness command (e.g. `/run-workflow`) that calls `startExecution` with a workflow name and goal
- A skill invocation that calls `startExecution` after confirming user intent
- A UI button that calls `startExecution` through an adapter-owned helper
- A script that calls `startExecution` from a CLI entry point

In all cases, the adapter maps the harness-specific trigger into a `StartExecutionInput` and calls the engine lifecycle method. The engine validates the input, creates the `WorkflowInstance`, acquires the `ExecutionLease`, and returns typed effects. The adapter applies those effects in the harness.

Adapters must not implement their own execution state machines, their own lease tracking, or their own step-dispatch logic. Those concerns belong to the engine.

### 4. Legacy `/start-work` → Tapestry is no longer the core model

The `/start-work` → Tapestry flow is a legacy OpenCode-specific delivery path. It is not the architectural center of execution in the harness-agnostic successor.

The OpenCode adapter may continue to expose a `/start-work`-compatible command as a delivery path for backward compatibility, but that command must be implemented as an adapter-owned projection of the engine's `startExecution` lifecycle method — not as a hook-driven agent switch with implicit continuation semantics.

The Tapestry agent remains a valid workflow execution agent, but its role is now defined by the `.weave` DSL (as a named agent with declared capabilities) rather than by OpenCode-specific hook registration and `switchAgent` effects.

### 5. Execution state is grounded in engine-owned runtime concepts

All execution state lives in the Runtime Store under `.weave/runtime/weave.db`. The engine owns this state through the `WorkflowInstance` and `ExecutionLease` records defined in Spec 12.

- A `WorkflowInstance` is the durable record of a workflow run's execution state, coordination metadata, and artifact references.
- An `ExecutionLease` is the coordination record that grants one actor permission to actively drive a workflow run.
- A valid `ExecutionLease` is the only mechanism that identifies an actively driven `WorkflowInstance`.

Adapters do not own execution state. They may emit sanitized observations through the engine-provided Runtime Journal writer, but they do not write to the Runtime Store directly.

---

## Consequences

### What changes

- The engine's `startExecution` lifecycle method is the sole authorized entry point for durable execution. No other code path may create a `WorkflowInstance` or acquire an `ExecutionLease`.
- Ordinary Loom conversation, session idle events, continuation hooks, and lifecycle observations are explicitly forbidden from implicitly starting durable execution.
- The OpenCode adapter's `/start-work` hook must be refactored to call `startExecution` rather than producing a `switchAgent` effect directly.
- The `workContinuation` hook's implicit Tapestry re-injection behavior is superseded by `resumeExecution`, which requires an explicit adapter-mediated trigger.
- Adapters must declare their execution-contract delivery mechanism through the Spec 07 `command-entrypoints` capability readiness vocabulary (`native`, `emulated`, `degraded`, `unsupported`) rather than assuming every harness exposes literal commands.

### What is now possible

- Any harness adapter can implement the execution contract by mapping its harness-specific triggers into the seven lifecycle methods. No OpenCode-specific hook registration is required.
- Execution state is inspectable through the Runtime Store without depending on harness session context.
- The engine can enforce the explicit execution boundary in tests without launching a real harness.
- Future harnesses (Pi, Claude Code, Codex) can implement the execution contract through adapter-owned delivery paths without replicating OpenCode-specific behavior.

### What is now forbidden

- Agents, idle hooks, continuation hooks, or lifecycle events may not implicitly call `startExecution` or create `WorkflowInstance` records.
- Adapters may not implement their own execution state machines, lease tracking, or step-dispatch logic outside the engine lifecycle surface.
- Engine code may not inspect harness-owned session state, hook registrations, or command surfaces to determine execution status.
- The legacy `switchAgent` effect pattern may not be used as a substitute for the engine's `startExecution` / `resumeExecution` lifecycle methods.

### What is deferred

- Full adapter implementation for OpenCode, Claude Code, and Pi delivery paths is deferred to follow-up work (Spec 22 Unit 6 and adapter-specific slices).
- The `before-plan` extension contract, artifact approval semantics, and reconciliation routing are defined in Spec 22 Units 2–4 and implemented in follow-up tasks.
- Prompt composition at workflow and step scope is defined in Spec 22 Unit 4 and implemented in follow-up tasks.

### Trade-offs accepted

- **Explicit over implicit.** Requiring an explicit user-authorized transition adds a step compared to the legacy implicit continuation model. This is intentional: the explicit boundary makes execution inspectable, auditable, and portable.
- **Adapter refactoring required.** The OpenCode adapter's `/start-work` hook and `workContinuation` hook must be refactored to use the engine lifecycle surface. This is a one-time migration cost that enables long-term portability.
- **No automatic continuation.** The legacy `workContinuation` hook's automatic Tapestry re-injection is not replicated. Adapters that want continuation behavior must implement it as an explicit `resumeExecution` call triggered by an adapter-owned mechanism, not as an implicit idle-event response.

---

## Ownership Matrix — Execution Contract

| Concern | Owner | Why |
| --- | --- | --- |
| Execution contract definition (`startExecution`, `resumeExecution`, `pauseExecution`, `dispatchStep`, `completeStep`) | Engine (`@weave/engine`) | Semantics must be harness-agnostic and testable without a real harness |
| `WorkflowInstance` and `ExecutionLease` lifecycle | Engine (`@weave/engine`) | Runtime state is Weave product state, not harness state |
| Explicit execution boundary enforcement | Engine (`@weave/engine`) | The engine must reject implicit start attempts regardless of adapter |
| Harness-specific trigger delivery (commands, skills, hooks, scripts, UI) | Adapter | Delivery mechanisms differ by harness |
| Adapter capability declaration for execution-contract delivery | Adapter | Adapters know what their harness supports |
| Core Readiness Profile evaluation for execution-contract support | Engine (`@weave/engine`) | Pure function; accepts explicit adapter-supplied inputs |
| Continuation and compaction recovery behavior | Adapter | Recovery mechanisms are harness-specific; adapters call `resumeExecution` |

---

## References

- [`packages/engine/src/execution-lifecycle.ts`](../../packages/engine/src/execution-lifecycle.ts) — The seven lifecycle methods that implement the execution contract.
- [`docs/specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md`](../specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md) — Normative spec for this work; Unit 1 defines the execution contract requirements.
- [`docs/specs/13-spec-minimal-execution-lifecycle-surface/13-spec-minimal-execution-lifecycle-surface.md`](../specs/13-spec-minimal-execution-lifecycle-surface/13-spec-minimal-execution-lifecycle-surface.md) — Spec that defined the seven lifecycle methods this ADR builds on.
- [`docs/adr/0002-runtime-persistence-store.md`](0002-runtime-persistence-store.md) — ADR that established `WorkflowInstance`, `ExecutionLease`, and the Runtime Store.
- [`docs/adapter-boundary.md`](../adapter-boundary.md) — Ownership rules for engine/adapter boundary; the Execution Lifecycle Surface section describes the adapter's role.
- [`docs/legacy-architecture.md`](../legacy-architecture.md) — Documents the `/start-work` → Tapestry flow this ADR supersedes.
- [`docs/product-vision.md`](../product-vision.md) — Product vision requiring harness-agnostic execution semantics.
