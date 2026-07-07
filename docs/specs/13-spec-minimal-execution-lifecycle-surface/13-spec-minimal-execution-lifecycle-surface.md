# 13-spec-minimal-execution-lifecycle-surface.md

## Introduction/Overview

Weave will add a minimal, engine-owned execution lifecycle surface for dogfood workflow execution. The feature replaces the idea of porting the full legacy lifecycle hook system with a small set of harness-neutral lifecycle entry points that adapters can call after mapping concrete harness events into Weave concepts.

The primary goal is to let adapters observe sessions, start or resume executions, pause on user interruption, dispatch workflow steps, complete steps, and evaluate tool policy without making the engine register concrete harness hooks or own harness-specific runtime behavior.

## Goals

- Define the MVP execution lifecycle surface for issue [#44](https://github.com/weave-io/weave/issues/44): `observeSession`, `startExecution`, `resumeExecution`, `handleUserInterrupt`, `dispatchStep`, `completeStep`, and `beforeTool`.
- Keep lifecycle APIs harness-neutral by requiring adapters to supply normalized event context and by returning typed state updates, decisions, or abstract effects.
- Connect lifecycle operations to the existing Runtime Store from [Spec 12](../12-spec-runtime-persistence/12-spec-runtime-persistence.md) instead of creating a parallel persistence mechanism.
- Replace or formally supersede transitional `registerHook()` behavior in `HarnessAdapter` without requiring the full legacy hook system.
- Provide isolated tests and proof artifacts that demonstrate lifecycle behavior without launching a real harness.

## User Stories

- **As a Weave user**, I want a workflow execution to start and resume predictably so that dogfood runs can survive session interruptions.
- **As an adapter author**, I want to translate concrete harness lifecycle events into a small Weave API so that my adapter does not need to reimplement workflow orchestration rules.
- **As an engine maintainer**, I want lifecycle decisions to use typed inputs, typed errors, and abstract effects so that runtime behavior stays testable and harness-agnostic.
- **As a security reviewer**, I want tool-policy lifecycle decisions to happen after concrete tools are mapped to abstract capabilities so that permissions are enforced consistently across harnesses.
- **As a future workflow-engine implementer**, I want `dispatchStep` and `completeStep` to establish the step execution contract before the full workflow engine is built.

## Demoable Units of Work

### Unit 1: Lifecycle vocabulary and public engine types

**Purpose:** Establish the shared typed vocabulary for adapter-to-engine lifecycle calls.

**Functional Requirements:**
- The system shall define public lifecycle input and output types in `@weaveio/weave-engine` for `observeSession`, `startExecution`, `resumeExecution`, `handleUserInterrupt`, `dispatchStep`, `completeStep`, and `beforeTool`.
- The system shall model lifecycle failures with discriminated `neverthrow` error types instead of throwing expected errors.
- The system shall export lifecycle types from `packages/engine/src/index.ts` so adapters and tests can import them intentionally.
- The system shall keep lifecycle inputs free of raw harness payloads, raw prompts, credentials, cookies, tokens, authorization headers, and provider-private data.
- The system shall document each lifecycle method's responsibility, required input fields, returned value, and relationship to the Runtime Store.

**Proof Artifacts:**
- Typecheck: `bun run typecheck` demonstrates the lifecycle types compile and are exported from `@weaveio/weave-engine`.
- Test: engine lifecycle type/unit tests demonstrate valid inputs, invalid or missing required fields where runtime validation exists, and typed error variants.
- Documentation: lifecycle API documentation links from `docs/adapter-boundary.md` or another architecture doc and describes the MVP surface.

### Unit 2: Session observation and execution start/resume

**Purpose:** Let adapters bind harness sessions to Weave execution state without owning Weave runtime persistence.

**Functional Requirements:**
- The system shall implement `observeSession` so an adapter can provide a normalized session ID, optional foreground agent, and model/context metadata when the harness exposes it.
- `observeSession` shall record only Weave-visible, sanitized session observations through the existing Runtime Store and journal boundaries.
- The system shall implement `startExecution` for starting a named workflow or the default plan workflow.
- `startExecution` shall create or update the appropriate `WorkflowInstance` state through the Runtime Store and shall acquire an execution lease according to Spec 12 semantics.
- The system shall implement `resumeExecution` so an adapter can explicitly rebind to an existing execution.
- `resumeExecution` shall fail with a typed conflict when an unexpired active lease is owned by another session or owner.
- `startExecution` and `resumeExecution` shall not inspect harness-owned files, UI state, or session stores directly.

**Proof Artifacts:**
- Test: `observeSession` stores a sanitized session snapshot and excludes raw harness-private data.
- Test: `startExecution` creates a workflow instance and active lease using an in-memory Runtime Store.
- Test: `resumeExecution` rebinds an expired or available execution and returns a typed conflict for an unexpired foreign lease.
- CLI/Test output: package-level `bun test packages/engine` or equivalent engine test command passes for lifecycle start/resume behavior.

### Unit 3: Interrupt, dispatch, and completion flow

**Purpose:** Provide the smallest step-execution loop needed for dogfood workflow runs.

**Functional Requirements:**
- The system shall implement `handleUserInterrupt` so adapters can pause an active execution when a user interruption occurs.
- `handleUserInterrupt` shall update the workflow instance status to a paused or equivalent non-running state without marking the workflow completed.
- The system shall implement `dispatchStep` so the engine can produce a `RunAgent` effect or equivalent abstract dispatch effect for the next runnable step.
- `dispatchStep` shall update Runtime Store state needed to identify the current step or pending dispatch without requiring adapter-owned workflow state.
- The system shall implement `completeStep` so adapters can report explicit command completion or structured completion signals.
- `completeStep` shall persist successful, blocked, failed, or paused step outcomes in a typed, inspectable shape.
- The dispatch/completion flow shall remain minimal and shall not implement the full workflow engine semantics deferred to issue #10.

**Proof Artifacts:**
- Test: user interrupt moves an active workflow instance to paused state and preserves resumability metadata.
- Test: `dispatchStep` emits a `RunAgent` or equivalent abstract effect containing only normalized agent/step references and safe metadata.
- Test: `completeStep` records a structured completion signal and advances or finalizes state according to the minimal lifecycle contract.
- Code review artifact: emitted effects do not include raw prompts, credentials, tokens, harness-private paths, or raw provider payloads.

### Unit 4: `beforeTool` policy lifecycle point and adapter integration contract

**Purpose:** Enforce abstract tool policy at the lifecycle boundary after adapters map concrete tools to Weave capabilities.

**Functional Requirements:**
- The system shall implement `beforeTool` as the lifecycle point called after an adapter maps a concrete harness tool to an abstract capability.
- `beforeTool` shall use the existing abstract tool policy evaluation behavior from [Spec 08](../08-spec-abstract-tool-policy-evaluation/08-spec-abstract-tool-policy-evaluation.md) rather than creating a second policy model.
- `beforeTool` shall return a normalized allow/deny/ask decision or typed error that adapters can translate into harness-specific enforcement.
- The system shall update the adapter boundary documentation to clarify that adapters own concrete tool names and event mapping, while the engine owns abstract policy decisions.
- The system shall update mock adapter tests to prove lifecycle methods are called with normalized inputs and no real harness process is started.

**Proof Artifacts:**
- Test: `beforeTool` returns the expected decision for allowed, denied, and ask policy cases using normalized capability inputs.
- Test: mock adapter lifecycle tests record call order for session observation, execution start/resume, dispatch, completion, and tool policy decisions.
- Documentation: `docs/adapter-boundary.md` describes the lifecycle surface as the replacement path for transitional `registerHook()`.
- Security review artifact: Warp reviews `beforeTool`, sanitized lifecycle inputs, and effect payload boundaries before implementation is accepted.

## Non-Goals (Out of Scope)

1. **Idle continuation**: This spec does not implement idle continuation or automatic work after session idle events.
2. **Full `onSessionIdle` policy behavior**: Legacy idle hook behavior remains deferred and is not part of the MVP lifecycle surface.
3. **Compaction recovery**: Context compaction recovery and continuation after compaction are not included.
4. **Context-window monitoring**: No context-window monitor, threshold policy, or alerting behavior is included.
5. **Analytics dashboard policies**: No analytics dashboard, reporting surface, or policy dashboard is included.
6. **Complete workflow engine**: This spec defines lifecycle primitives that issue #10 can build on; it does not implement every workflow graph, condition, artifact, or retry behavior.
7. **Harness-specific hook registration**: The engine shall not register OpenCode hooks, Pi callbacks, Claude Code runtime handlers, or any other concrete harness event listeners.

## Design Considerations

No graphical UI or visual design changes are required.

Any user-visible output produced as a proof artifact should be deterministic, readable, and safe to attach to an issue after normal secret redaction. If lifecycle state appears in CLI or test output, it should use stable names such as execution ID, workflow name, step name, status, and decision outcome rather than verbose harness payload dumps.

## Repository Standards

- Follow the engine/adapter boundary in [`docs/adapter-boundary.md`](../../adapter-boundary.md): adapters map harness-specific runtime events into normalized lifecycle inputs; engine helpers return abstract lifecycle decisions, state changes, or effects.
- Follow [`docs/product-vision.md`](../../product-vision.md): Weave provides harness-agnostic primitives and adapters translate those primitives into concrete harness behavior.
- Use the Runtime Store from [Spec 12](../12-spec-runtime-persistence/12-spec-runtime-persistence.md) for execution state, leases, session snapshots, and journal observations.
- Use the Adapter Capability Contract from [Spec 07](../07-spec-adapter-capability-contract/07-spec-adapter-capability-contract.md), especially the required `workflow-step-dispatch` and `workflow-persistence` capability expectations.
- Use the Abstract Tool Policy Evaluation model from [Spec 08](../08-spec-abstract-tool-policy-evaluation/08-spec-abstract-tool-policy-evaluation.md) for `beforeTool` decisions.
- Use Bun exclusively for runtime, tests, package scripts, and build commands.
- Use `neverthrow` result types for fallible lifecycle, persistence, and policy operations.
- Add isolated engine tests with mocks or in-memory stores; do not start real harnesses or rely on real harness runtime state.
- Export new public engine APIs through `packages/engine/src/index.ts`.
- Update docs for this non-trivial architecture change before implementation is considered done.

## Technical Considerations

- The likely implementation home is a new engine module such as `packages/engine/src/execution-lifecycle.ts` or `packages/engine/src/lifecycle-surface.ts`, with public exports from `packages/engine/src/index.ts`.
- `HarnessAdapter.registerHook()` is a transitional API. This spec should supersede it with adapter-owned event mapping into engine lifecycle functions; full removal may be deferred if immediate removal would break existing adapter implementations.
- Lifecycle operations should follow the established pure-helper pattern: accept explicit adapter-provided context and return normalized outputs, typed errors, or abstract effects.
- `RunAgentEffect` already establishes an effect-dispatch pattern. `dispatchStep` should reuse or extend that pattern rather than introducing harness-specific dispatch callbacks.
- `observeSession`, `startExecution`, `resumeExecution`, `handleUserInterrupt`, `dispatchStep`, and `completeStep` should coordinate with `WorkflowInstance`, `ExecutionLease`, `SessionSnapshot`, and Runtime Journal concepts from Spec 12.
- `beforeTool` should receive already-normalized tool/capability context. The adapter owns concrete tool-name mapping; the engine owns abstract policy evaluation.
- Latest-standards research summary: no external technology-specific standards research was needed because this feature defines internal Weave engine architecture over already-selected repository technologies. The material standards are repository-local: adapter-owned harness mapping, harness-neutral engine APIs, Bun-only runtime, `neverthrow` error modeling, pino logging, Runtime Store persistence, and mock-based testing.
- No tension with current external guidance was identified. The main design tension is internal: MVP lifecycle should supersede `registerHook()` without accidentally reintroducing the full legacy hook system.

## Security Considerations

- Lifecycle inputs, outputs, Runtime Store records, journal entries, and proof artifacts must not include API keys, tokens, credentials, cookies, authorization headers, raw prompts, raw completions, raw transcripts, raw provider payloads, or harness-private state.
- `observeSession` must store sanitized Weave-visible session metadata only.
- `beforeTool` is security-sensitive because incorrect concrete-tool-to-capability mapping or policy evaluation can grant broader permissions than intended.
- Emitted effects must contain only normalized agent, workflow, step, and decision metadata needed by adapters; they must not expose harness-private paths or secret-bearing adapter state.
- Runtime Store writes must preserve Spec 12 lease conflict behavior so two sessions do not actively drive the same execution without an explicit resume/rebind path.
- Implementation requires Warp security review because the feature touches tool policy, lifecycle event inputs, runtime state, and adapter trust boundaries.

## Success Metrics

1. **MVP surface completeness**: all issue #44 lifecycle points are represented by documented public engine APIs or intentionally equivalent names.
2. **Boundary compliance**: lifecycle tests and code review show the engine does not register concrete harness hooks or inspect harness-owned runtime state.
3. **Runtime integration**: start, resume, pause, dispatch, and completion behavior use the existing Runtime Store and lease model.
4. **Policy enforcement**: `beforeTool` returns deterministic abstract policy decisions for allow, deny, and ask cases.
5. **Dogfood readiness**: a mock adapter can drive the minimal lifecycle flow end-to-end without a real harness process.
6. **Safety**: tests or review artifacts prove lifecycle effects and records exclude raw prompts, credentials, tokens, and harness-private payloads.

## Open Questions

1. Should `dispatchStep` reuse the existing `RunAgentEffect` type directly, or should it introduce a broader lifecycle effect union that contains `RunAgentEffect` as one variant?
2. Should `registerHook()` be removed in the same implementation slice, or retained as deprecated until all adapters have migrated to the lifecycle surface?
3. What exact minimal structured completion signal should adapters provide to `completeStep` before issue #10 defines the full workflow engine semantics?
