## Relevant Files

| File | Why It Is Relevant |
| --- | --- |
| `packages/engine/src/execution-lifecycle.ts` | Main lifecycle surface containing `startExecution`, `dispatchStep`, `completeStep`, lifecycle effect types, completion signal types, and helper functions that must implement workflow topology and advancement. |
| `packages/engine/src/__tests__/execution-lifecycle.test.ts` | Focused unit tests for lifecycle validation, dispatch effect construction, completion method checks, gate rejection behavior, and typed error paths. |
| `packages/engine/src/__tests__/execution-lifecycle-integration.test.ts` | Integration-style engine tests for multi-step workflows, artifact passing across steps, auto-advance, and terminal completion without a real harness. |
| `packages/engine/src/runtime/types.ts` | Runtime domain types for `WorkflowInstance`, `ExecutionLease`, artifact references, statuses, and sanitized metadata invariants. |
| `packages/engine/src/runtime/store.ts` | Runtime store repository contract for creating/updating instances, persisting artifacts, and acquiring/releasing leases. |
| `packages/engine/src/runtime/memory-store.ts` | In-memory runtime store used by isolated tests to avoid real harness or database dependencies. |
| `packages/engine/src/template-renderer.ts` | Existing Mustache rendering helper that should render workflow step prompts and validate unresolved template paths. |
| `packages/engine/src/tool-policy.ts` | Existing abstract policy evaluator used to populate dispatch effects without concrete harness tool names. |
| `packages/engine/src/descriptors.ts` | Existing descriptor helper that should be reused when dispatch needs normalized agent descriptor data. |
| `packages/engine/src/model-resolution.ts` | Existing model intent helper if dispatch effects include resolved model data from explicit adapter-provided context. |
| `packages/engine/src/skill-resolution.ts` | Existing skill resolution helper if dispatch effects include resolved skills from adapter-provided skill context. |
| `packages/engine/src/run-agent-effects.ts` | Adapter-facing run-agent effect shape that may need to carry workflow completion metadata, correlation IDs, prompt metadata, or sanitized resolved context. |
| `packages/engine/src/index.ts` | Public barrel that must export any new lifecycle context, signal, effect, or helper types. |
| `packages/engine/README.md` | Engine package guide that should describe workflow execution responsibilities and adapter-owned event mapping. |
| `docs/adapter-boundary.md` | Canonical boundary document that must explain workflow topology, completion, artifact, and effect ownership. |
| `docs/workflow-schema.md` | Workflow schema reference that should describe how engine execution consumes steps, artifacts, completion methods, and `on_reject`. |
| `docs/specs/10-spec-workflow-engine/10-tasks-workflow-engine.md` | Task list for issue #10 implementation and later proof collection. |
| `docs/specs/10-spec-workflow-engine/10-audit-workflow-engine.md` | Planning audit report required before implementation handoff. |

### Notes

- Unit and integration tests should live under `packages/engine/src/__tests__/` and use in-memory runtime fixtures where possible.
- Use focused commands such as `bun test packages/engine/src/__tests__/execution-lifecycle.test.ts` and `bun test packages/engine/src/__tests__/execution-lifecycle-integration.test.ts` during development.
- Use repository gates `bun run lint`, `bun run typecheck`, `bun run test`, and `bun run build` before considering implementation complete.
- Keep lifecycle helpers harness-neutral: no OpenCode/Pi/Claude Code session mutation, no concrete tool names, no harness-owned filesystem scans, and no real harness startup in tests.
- Treat prompt text, artifact values, and completion metadata as potentially sensitive; use fingerprints or sanitized metadata in journals and proof artifacts.

## Planning Assumptions

- Use an explicit workflow execution context passed to lifecycle helpers. Prefer the narrowest context that contains validated workflows, agents, disabled settings, adapter-provided model context, adapter-provided skills, and policy defaults; do not make adapters decide workflow topology.
- For `on_reject: "fail"`, persist the failed terminal state first, then release or invalidate the active lease according to the existing runtime-store contract.
- `RunAgentEffect` should expose prompt metadata, expected completion, correlation ID, policy, model, and resolved skills; runtime journals should use prompt fingerprints or sanitized metadata instead of full prompt text.

## Tasks

### [x] 1.0 Validate workflow start and execution context

#### 1.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/execution-lifecycle.test.ts` passes cases showing `startExecution` rejects an unknown `workflowName` before dispatch and returns a typed `LifecycleError`.
- Test: `bun test packages/engine/src/__tests__/execution-lifecycle.test.ts` passes cases showing a valid workflow creates a `WorkflowInstance`, initializes the first step, records artifacts/summaries/session metadata, and acquires an `ExecutionLease`.
- Test: `bun test packages/engine/src/__tests__/execution-lifecycle.test.ts` passes single-active-execution coverage demonstrating a second active or paused execution in the same repo is blocked for MVP.
- Typecheck: `bun run typecheck` passes demonstrating lifecycle helper signatures and exported execution-context types compile across the workspace.

#### 1.0 Tasks

- [ ] 1.1 Define the workflow execution context type accepted by lifecycle helpers, using explicit Weave-owned workflow config plus adapter-provided model/skill context where needed.
- [ ] 1.2 Update `StartExecutionInput` or the `startExecution` signature so unknown `workflowName` values can be validated against declared workflows before instance creation.
- [ ] 1.3 Create or update instance initialization so new executions persist the declared `workflowName`, goal, slug, first workflow step name, empty artifacts, and initial summaries/session metadata supported by the runtime store.
- [ ] 1.4 Preserve the single active or paused execution invariant by relying on existing lease acquisition behavior and returning typed lease-conflict errors.
- [ ] 1.5 Add tests for unknown workflow rejection, valid workflow instance creation, first-step initialization, lease acquisition, and active-lease conflict behavior.
- [ ] 1.6 Export any new execution context or lifecycle input types from `packages/engine/src/index.ts`.

### [x] 2.0 Dispatch configured workflow steps as abstract effects

#### 2.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/execution-lifecycle.test.ts` passes cases showing `dispatchStep` resolves the current `WorkflowConfig.steps` entry and emits the configured `step.agent` instead of using the step name as the agent.
- Test: `bun test packages/engine/src/__tests__/execution-lifecycle.test.ts` passes cases showing `dispatchStep` renders `{{instance.goal}}`, `{{instance.slug}}`, and `{{artifacts.plan_path}}` in step prompts.
- Test: `bun test packages/engine/src/__tests__/execution-lifecycle.test.ts` passes cases showing missing required `step.inputs` artifacts return a typed error before dispatch.
- Code review artifact: `packages/engine/src/execution-lifecycle.ts` emitted `DispatchAgentEffect` values contain abstract policy, completion expectation, model, skill, prompt metadata, and correlation data, with no concrete harness tool names or session mutations.

#### 2.0 Tasks

- [ ] 2.1 Replace current `dispatchStep` fallback logic with workflow step resolution from `WorkflowConfig.steps`, using `input.stepName`, `instance.currentStepName`, or the first declared step in that order.
- [ ] 2.2 Return typed validation or not-found errors when the resolved step name does not exist in the workflow definition.
- [ ] 2.3 Resolve the target agent from `step.agent` and reuse existing descriptor, policy, model, and skill helpers instead of constructing hardcoded allow-all placeholder data.
- [ ] 2.4 Build a workflow template context containing `instance.goal`, `instance.slug`, workflow metadata, current step metadata, and persisted artifact references.
- [ ] 2.5 Render `step.prompt` through `renderTemplate()` and return typed lifecycle errors for unresolved template paths or unsafe values.
- [ ] 2.6 Validate every declared `step.inputs` artifact exists before rendering and dispatching the step.
- [ ] 2.7 Emit `DispatchAgentEffect` with agent name, prompt metadata or sanitized prompt representation, expected completion method, interaction intent from step type, correlation ID, effective policy, raw policy, resolved model, and resolved skills.
- [ ] 2.8 Add tests for configured agent dispatch, prompt rendering, artifact input validation, missing step, missing agent, and absence of concrete harness tool/session data in effects.

### [ ] 3.0 Complete successful steps, persist artifacts, and auto-advance

#### 3.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/execution-lifecycle.test.ts` passes cases showing a successful non-final step persists declared output artifacts and emits a dispatch effect for the next workflow step.
- Test: `bun test packages/engine/src/__tests__/execution-lifecycle.test.ts` passes cases showing malformed or undeclared output artifacts return typed errors and do not corrupt instance state.
- Test: `bun test packages/engine/src/__tests__/execution-lifecycle.test.ts` passes cases showing a successful final step transitions the instance to `completed`, emits `complete-execution`, and releases the active lease.
- Integration test: `bun test packages/engine/src/__tests__/execution-lifecycle-integration.test.ts` passes a multi-step workflow scenario proving artifacts produced by one step are available to a later step.

#### 3.0 Tasks

- [ ] 3.1 Update `completeStep` to load the current workflow and current step before applying a successful completion signal.
- [ ] 3.2 Validate completion artifacts against the current step's declared `outputs` before calling `store.instances.addArtifact()`.
- [ ] 3.3 Persist declared output artifact references sequentially and return typed persistence errors without hiding partial-failure behavior.
- [ ] 3.4 Determine the next workflow step from the declared step order after successful non-final completion.
- [ ] 3.5 Update `currentStepName` to the next step and emit a next-step `dispatch-agent` effect using the same dispatch-building path as `dispatchStep`.
- [ ] 3.6 For successful final-step completion, transition the instance to `completed`, clear or preserve `currentStepName` according to runtime convention, release the active lease, and emit `complete-execution`.
- [ ] 3.7 Add unit tests for non-final auto-advance, output artifact persistence, malformed/undeclared artifacts, final-step completion, and lease release.
- [ ] 3.8 Add an integration test for a multi-step workflow where one step outputs an artifact consumed by a later rendered prompt.

### [ ] 4.0 Evaluate completion methods and gate rejection policies

#### 4.0 Proof Artifact(s)

- Test: `bun test packages/engine/src/__tests__/execution-lifecycle.test.ts` passes cases showing `agent_signal`, `user_confirm`, and `review_verdict` signals are accepted only when they match the current step's declared completion method.
- Test: `bun test packages/engine/src/__tests__/execution-lifecycle.test.ts` passes cases showing `plan_created` checks the expected Weave-owned plan file path and `plan_complete` rejects incomplete markdown checkbox plans.
- Test: `bun test packages/engine/src/__tests__/execution-lifecycle.test.ts` passes cases showing approved `review_verdict` gate steps advance normally.
- Test: `bun test packages/engine/src/__tests__/execution-lifecycle.test.ts` passes cases showing rejected gate steps apply `on_reject: "pause"`, `"fail"`, and `"retry"` with the expected status and lifecycle effects.

#### 4.0 Tasks

- [ ] 4.1 Extend `StepCompletionSignal` to represent the data needed for `agent_signal`, `user_confirm`, `review_verdict`, `plan_created`, and `plan_complete` without accepting ambiguous success values.
- [ ] 4.2 Validate every completion signal against the current step's declared `completion.method` and return typed errors for mismatches.
- [ ] 4.3 Implement `agent_signal` and `user_confirm` completion paths using adapter-reported or explicit command signals.
- [ ] 4.4 Implement `review_verdict` so approved verdicts follow normal success advancement and rejected verdicts are routed through `on_reject` handling.
- [ ] 4.5 Implement `plan_created` by rendering the configured `plan_name` and checking the expected Weave-owned plan file exists.
- [ ] 4.6 Implement `plan_complete` by rendering the configured `plan_name` and checking the expected markdown plan has no incomplete task checkboxes required for completion.
- [ ] 4.7 Implement `on_reject: "pause"` by persisting paused status and emitting `pause-execution`.
- [ ] 4.8 Implement `on_reject: "fail"` by persisting failed terminal status, recording a sanitized reason, and releasing or invalidating the active lease according to runtime-store semantics.
- [ ] 4.9 Implement `on_reject: "retry"` by recording the rejected attempt and re-dispatching the same gate step with a fresh correlation ID.
- [ ] 4.10 Add tests for all five completion methods, completion-method mismatch, approved gate, and rejected gate pause/fail/retry behavior.

### [ ] 5.0 Document workflow engine behavior and pass quality gates

#### 5.0 Proof Artifact(s)

- Diff: `docs/adapter-boundary.md`, `docs/workflow-schema.md`, and `packages/engine/README.md` document how the workflow engine uses schema topology, completion methods, artifact passing, and abstract lifecycle effects.
- Test: `bun run lint` passes demonstrating source formatting and lint rules remain satisfied.
- Test: `bun run typecheck` passes demonstrating public API and test fixtures compile.
- Test: `bun run test` passes demonstrating the full workspace test suite remains green.
- Build: `bun run build` passes demonstrating all packages still bundle and emit declarations.
- Security review artifact: Warp review notes for issue #10 confirm prompt metadata, artifact values, completion signals, and lifecycle effects do not expose secrets or harness-owned state.

#### 5.0 Tasks

- [ ] 5.1 Update `docs/adapter-boundary.md` with workflow-engine ownership rules: engine owns topology, artifact resolution, completion evaluation, gate decisions, and abstract effects; adapters own event mapping and effect application.
- [ ] 5.2 Update `docs/workflow-schema.md` with an execution semantics section explaining how the engine consumes step order, `inputs`, `outputs`, completion methods, and `on_reject`.
- [ ] 5.3 Update `packages/engine/README.md` so the execution lifecycle section names the workflow engine behavior and required adapter-provided context.
- [ ] 5.4 Confirm runtime journals, dispatch effects, and tests do not commit raw prompts, credentials, tokens, `.env` values, or harness-private paths as proof artifacts.
- [ ] 5.5 Run `bun run lint` and save the command result in the later proof file.
- [ ] 5.6 Run `bun run typecheck` and save the command result in the later proof file.
- [ ] 5.7 Run `bun run test` and save the command result in the later proof file.
- [ ] 5.8 Run `bun run build` and save the command result in the later proof file.
- [ ] 5.9 Request Warp security review for issue #10 because the implementation touches user-controlled prompt templates, artifact values, completion validation, and runtime state transitions.
