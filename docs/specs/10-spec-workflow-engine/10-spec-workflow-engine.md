# 10-spec-workflow-engine.md

## Introduction/Overview

Implement the harness-agnostic workflow execution engine in `@weave/engine` so validated `.weave` workflow definitions can drive multi-step dogfood execution. The primary goal is to turn workflow declarations into deterministic runtime behavior: start a workflow instance, dispatch each step to the correct agent, evaluate step completion, pass artifacts forward, and return abstract effects that adapters can materialize in their own harnesses.

This spec is based on GitHub issue [#10](https://github.com/weave-io/weave/issues/10). It builds on the existing workflow schema, runtime persistence store, and execution lifecycle surface while preserving the boundary that the engine owns workflow semantics and adapters own harness-specific event mapping and effect application.

## Goals

- Start workflow execution from a validated `WorkflowConfig` and reject unknown workflow names before runtime work begins.
- Dispatch workflow steps using the configured step topology, agent name, rendered step prompt, effective tool policy, resolved model and skill metadata when available, and completion expectations.
- Persist and advance `WorkflowInstance` state across current step, status, artifacts, summaries, participating sessions, and lease ownership.
- Evaluate supported completion methods: `plan_created`, `plan_complete`, `user_confirm`, `review_verdict`, and `agent_signal`.
- Return harness-neutral lifecycle effects such as agent dispatch, pause, failure, retry, and completion without adding concrete OpenCode, Claude Code, Pi, or future-harness mutations.

## User Stories

- **As a Weave user running dogfood workflows**, I want a declared workflow to advance through its steps automatically so that I can rely on `.weave` workflow configuration as the canonical execution plan.
- **As an adapter maintainer**, I want the engine to return abstract effects with enough context to spawn or resume harness agents so that my adapter does not need to reimplement workflow semantics.
- **As an engine developer**, I want workflow state transitions to be deterministic and testable with an in-memory runtime store so that workflow execution can be validated without starting a real harness.
- **As a reviewer or maintainer**, I want completion methods and gate outcomes to be explicit so that pauses, retries, failures, and approvals are auditable.
- **As a future workflow author**, I want artifacts produced by earlier steps to be available to later step prompts so that multi-step workflows can pass useful context forward without harness-specific glue.

## Demoable Units of Work

### Unit 1: Workflow Start and Config Resolution

**Purpose:** Establish a validated entry point that connects runtime workflow instances to declared `.weave` workflow definitions before any step is dispatched.

**Functional Requirements:**
- The system shall validate that `StartExecutionInput.workflowName` exists in the provided `WeaveConfig.workflows` before creating or resuming an execution.
- The system shall create a `WorkflowInstance` with the requested workflow name, goal, slug, initial status, current step, artifacts collection, summaries collection, and participating session metadata.
- The system shall acquire or validate an `ExecutionLease` so that only one active or paused execution exists per repository for MVP.
- The system shall return a typed `neverthrow` error when the workflow name is unknown, the runtime store cannot persist state, or the lease cannot be acquired.
- The system shall not require adapters to inspect workflow definitions or decide workflow topology.

**Proof Artifacts:**
- `Test: startExecution rejects unknown workflowName` demonstrates invalid workflow references fail before dispatch.
- `Test: startExecution creates WorkflowInstance and ExecutionLease` demonstrates canonical runtime state is persisted.
- `Test: second active repo execution is rejected or blocked` demonstrates the MVP single-execution invariant.
- `Typecheck: bun run typecheck` demonstrates lifecycle signatures and public types compile across the workspace.

### Unit 2: Step Dispatch With Prompt, Agent, Policy, and Artifacts

**Purpose:** Convert the current workflow step into a harness-neutral `DispatchAgentEffect` that adapters can apply without knowing workflow internals.

**Functional Requirements:**
- The system shall resolve the current step from `WorkflowConfig.steps` by the instance's current step name or the first step when starting a new workflow.
- The system shall use `step.agent` to resolve the target agent descriptor from the provided config.
- The system shall render `step.prompt` with workflow context including `instance.goal`, `instance.slug`, current workflow metadata, and available `artifacts.<name>` values.
- The system shall verify every declared `step.inputs` artifact exists before rendering a prompt that depends on it.
- The system shall emit a `DispatchAgentEffect` containing a `RunAgentEffect` with the agent name, composed or rendered prompt metadata, interaction intent, correlation ID, expected completion method, effective tool policy, and optional resolved model and resolved skills when available.
- The system shall return a typed error when the step name, step agent, required input artifact, prompt template, policy evaluation, or descriptor composition cannot be resolved.
- The system shall not include concrete harness tool names, harness session mutation instructions, or harness-owned resource paths in the effect.

**Proof Artifacts:**
- `Test: dispatchStep emits configured step agent` demonstrates `step.agent` replaces the current hardcoded step-name-as-agent behavior.
- `Test: dispatchStep renders instance and artifact variables` demonstrates `{{instance.goal}}`, `{{instance.slug}}`, and `{{artifacts.plan_path}}` resolve correctly.
- `Test: missing input artifact returns typed error` demonstrates downstream steps cannot silently run with missing context.
- `Code review artifact: DispatchAgentEffect contains abstract policy and completion metadata only` demonstrates adapter-boundary compliance.

### Unit 3: Completion Evaluation and Step Advancement

**Purpose:** Advance workflow instances based on declared completion methods and persisted state, ending the workflow when the final step succeeds.

**Functional Requirements:**
- The system shall validate that a `StepCompletionSignal` is compatible with the current step's declared `completion.method`.
- The system shall evaluate `agent_signal`, `user_confirm`, and `review_verdict` from adapter-reported events or explicit commands.
- The system shall evaluate `plan_created` by checking for the expected Weave-owned plan file derived from the completion configuration and rendered workflow context.
- The system shall evaluate `plan_complete` by checking that the expected markdown plan has all required task checkboxes completed.
- The system shall persist output artifacts supplied by the completed step under their declared artifact names.
- The system shall advance a successful non-final step to the next declared workflow step and emit a dispatch effect for that next step.
- The system shall transition a successful final step to `completed`, release the active lease, and emit a completion effect.
- The system shall return typed errors for incompatible completion signals, failed state persistence, missing expected plans, incomplete plans, and malformed artifact output.

**Proof Artifacts:**
- `Test: successful first step dispatches next step` demonstrates automatic advancement through workflow topology.
- `Test: final successful step completes execution and releases lease` demonstrates terminal success behavior.
- `Test: completion method mismatch returns typed error` demonstrates declared completion methods constrain runtime signals.
- `Test: plan_created and plan_complete checks use Weave-owned plan files` demonstrates state-based completion paths work without harness-specific inspection.

### Unit 4: Gate Rejection, Pause, Retry, and Failure Behavior

**Purpose:** Make gate steps and rejected review outcomes predictable, auditable, and consistent with `on_reject` workflow configuration.

**Functional Requirements:**
- The system shall support review verdict completion signals that explicitly distinguish approved and rejected outcomes.
- The system shall treat an approved gate as a successful step and advance according to normal step sequencing.
- The system shall apply `on_reject: "pause"` by transitioning the workflow to paused state and emitting a pause effect.
- The system shall apply `on_reject: "fail"` by transitioning the workflow to failed state and releasing or invalidating the active lease according to runtime store semantics.
- The system shall apply `on_reject: "retry"` by recording the rejection and re-dispatching the same gate step with a new correlation ID.
- The system shall default any missing gate rejection behavior to the existing schema or runtime default documented in the workflow schema.
- The system shall preserve enough summary or event data to explain why a gate paused, failed, or retried without storing sensitive prompt contents verbatim.

**Proof Artifacts:**
- `Test: approved review_verdict advances to next step` demonstrates the happy path for gate approval.
- `Test: rejected gate with on_reject pause emits pause-execution` demonstrates user intervention behavior.
- `Test: rejected gate with on_reject fail marks execution failed` demonstrates terminal rejection behavior.
- `Test: rejected gate with on_reject retry re-dispatches same step` demonstrates retry behavior.

## Non-Goals (Out of Scope)

1. **Idle continuation**: This spec does not implement idle-based continuation, idle hooks, or automatic resume behavior triggered by inactive harness sessions.
2. **Multiple active executions per repository**: MVP supports exactly one active or paused workflow execution per repository.
3. **Harness-specific effect application**: This spec does not implement concrete switch, inject, restore, spawn, or session mutation behavior for OpenCode, Claude Code, Pi, or any future harness.
4. **Structured substep parsing for every markdown checkbox**: This spec may check plan completion state, but it does not convert every markdown task checkbox into a first-class workflow substep.
5. **New workflow DSL syntax**: This spec uses the existing workflow schema and completion method vocabulary; it does not add new DSL keywords or block forms unless a later task discovers a blocking schema defect.
6. **A full runtime UI or dashboard**: This spec returns effects and persisted state; it does not create a visual workflow monitor.
7. **Security or policy redesign**: This spec consumes existing effective tool policy, resolved model, and resolved skill APIs where needed; it does not redefine those systems.

## Design Considerations

No specific UI design requirements identified. Any CLI, log, debug, or proof output derived from workflow execution should use plain language step names, workflow names, correlation IDs, and statuses so a junior developer or adapter maintainer can understand what happened without reading runtime internals.

## Repository Standards

- Follow [`docs/adapter-boundary.md`](../../adapter-boundary.md): the engine owns workflow topology traversal, step sequencing, artifact resolution, completion decisions, and abstract effects; adapters own harness event mapping and concrete effect application.
- Follow [`docs/workflow-schema.md`](../../workflow-schema.md): workflow steps, completion methods, artifact references, and `on_reject` semantics are already defined by the Core workflow schema.
- Follow runtime persistence decisions from [`docs/specs/12-spec-runtime-persistence/12-spec-runtime-persistence.md`](../12-spec-runtime-persistence/12-spec-runtime-persistence.md) and ADR 0002: `.weave/runtime/**` is engine-owned persistence space.
- Use `neverthrow` for all expected failure paths. Lifecycle helpers should return `Result` or `ResultAsync` with discriminated error types rather than throwing exceptions.
- Use Bun-only tooling and commands: `bun test`, `bun run typecheck`, `bun run build`, and `bun run lint` where available.
- Use `bun:test` with `createInMemoryRuntimeStore()` or equivalent in-memory fixtures for unit and integration coverage. Do not start a real harness in engine tests.
- Keep engine code free of `console.*`; use the shared pino logger only when structured logging is required.
- Preserve early-return style, avoid nested ternaries and nested `try/catch`, and keep side effects isolated behind named functions or class methods.
- Update docs for non-trivial workflow engine behavior before the task is considered complete, especially adapter-boundary and workflow-schema usage notes.
- Use Conventional Commits when the later SDD task workflow creates the planning commit.

## Technical Considerations

- Primary implementation is expected in `packages/engine/src/execution-lifecycle.ts`, especially `startExecution`, `dispatchStep`, and `completeStep`.
- Lifecycle helpers should accept explicit Weave-owned workflow configuration, preferably by passing `WeaveConfig` or the relevant workflow/agent maps into the engine helper rather than requiring adapters to look up workflow topology.
- `dispatchStep` should replace the current placeholder behavior that uses the step name as the agent and emits hardcoded allow-all policy data.
- `completeStep` should replace the current placeholder behavior where successful completion records state but does not auto-advance or emit next-step effects.
- Prompt rendering should use the existing engine template rendering layer and a workflow-specific context object rather than adding an ad hoc string replacement implementation.
- Step input artifacts should be validated before prompt rendering; step output artifacts should be validated against the step's declared `outputs` before persistence.
- Completion checks for `plan_created` and `plan_complete` may inspect Weave-owned plan files because plans are part of Weave workflow state, not harness-owned runtime state.
- `RunAgentEffect` data should include enough information for debugging: agent, prompt metadata, interaction intent, correlation ID, expected completion, effective tool policy, optional resolved model, and resolved skills where already available.
- Runtime journal entries and summaries should use prompt fingerprints or metadata rather than storing full prompt text when that text may contain user goals or sensitive context.
- Latest-standards research summary: no external technology-specific guidance was needed because this spec introduces no new external framework, SDK, cloud service, or protocol. The relevant standards are repository-local architecture documents and existing package APIs.

## Security Considerations

- Step prompts may contain user goals, file paths, work summaries, or artifact values. Runtime journal entries and debug data must not store sensitive prompt contents verbatim when a fingerprint or metadata is sufficient.
- Effects must not include API keys, tokens, credentials, `.env` values, secret-bearing file contents, or harness-private state.
- Artifact values should be treated as user-controlled runtime data. Prompt rendering must avoid executing artifact contents as code or interpreting them as anything beyond template values.
- Completion events reported by adapters or explicit commands should be validated against the current workflow instance, current step, expected completion method, lease, and correlation ID where available.
- Gate rejection and approval handling is security-relevant because it can allow or block follow-up work; `review_verdict` signals should be explicit and auditable.
- This work touches runtime state, artifact passing, user-controlled template data, and step-completion validation, so the later implementation plan and completed changes should receive a Warp security audit before execution is considered complete.

## Success Metrics

1. **Workflow validation**: Unknown workflow names return typed errors and valid workflow names create persisted runtime instances with leases.
2. **Correct dispatch**: Tests prove `dispatchStep` uses configured workflow steps, agents, prompts, artifacts, policies, and completion expectations rather than hardcoded placeholders.
3. **Automatic advancement**: Tests prove successful non-final steps dispatch the next step and successful final steps complete the execution and release the lease.
4. **Completion coverage**: Tests cover `agent_signal`, `user_confirm`, `review_verdict`, `plan_created`, and `plan_complete` behavior.
5. **Gate behavior**: Tests cover approval plus `on_reject` pause, fail, and retry paths.
6. **Boundary compliance**: Code review confirms engine output remains abstract and contains no concrete harness session mutation or tool identifiers.
7. **Quality gates**: `bun run typecheck`, `bun test`, `bun run lint`, and `bun run build` pass after implementation.

## Open Questions

1. Should lifecycle helpers receive the full `WeaveConfig` or a narrower workflow execution context containing only workflows, agents, resolved models, resolved skills, and policy defaults?
2. What exact status and lease semantics should be used for `on_reject: "fail"`: immediate lease release, retained failed lease for inspection, or a store-level terminal transition that records failure before release?
3. How much prompt metadata should appear in `RunAgentEffect` versus only in runtime journal entries, given the need for debugging without exposing full prompt contents?
