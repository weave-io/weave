# Minimal Runtime Command Lifecycle

## TL;DR
> **Summary**: Implement issue #17 by adding reusable engine-owned runtime command operations, refactoring OpenCode execution helpers into adapter-owned projections, and proving explicit start/status/control/health behavior with isolated tests and dogfood evidence. Keep named workflow execution separate from ordinary plan execution; `/start-work` is out of scope for this issue.
> **Estimated Effort**: Large

## Context
### Original Request
Generate an implementation plan for GitHub issue #17, `[adapter-opencode] Minimal runtime command lifecycle`, based on the approved spec at `docs/specs/30-spec-minimal-runtime-command-lifecycle/30-spec-minimal-runtime-command-lifecycle.md`. Work only in the isolated worktree and create a planning artifact under `.weave/plans/` without implementing code.

### Key Findings
- The requested worktree is already an isolated linked worktree on branch `spec/issue-17`; existing changed files are `docs/specs/README.md` and the new spec directory. Do not undo those changes.
- Spec 30 defines four demoable units: reusable runtime command operations, OpenCode explicit execution entrypoints, runtime control/inspection/health affordances, and lifecycle/policy/dogfood proof.
- Existing engine lifecycle modules live under `packages/engine/src/execution-lifecycle/` and already expose `startExecution`, `runWorkflow`-adjacent primitives (`dispatchStep`, `completeStep`), `inspectExecution`, `handleUserInterrupt`, `beforeTool`, and `reconcileExecution` through `packages/engine/src/execution-lifecycle.ts` and `packages/engine/src/index.ts`.
- Existing OpenCode adapter helpers already separate plan and workflow paths: `packages/adapters/opencode/src/start-plan-execution.ts` models `/weave:start` plan execution, while `packages/adapters/opencode/src/run-workflow.ts` is explicit named workflow execution.
- `packages/adapters/opencode/src/plugin.ts` currently uses `session.created` only for deferred agent reconciliation. Tests document that it must not start durable execution from hooks.
- Current OpenCode docs confirm command delivery is adapter-owned: `opencode.jsonc` `command` entries are prompt templates, plugin custom tools are server-side extension points, and TUI palette slash commands require palette registration with `slashName`. Therefore issue #17 should first build reusable command handlers/results and OpenCode projections, then expose native slash affordances only where feasible without moving command semantics into the engine.
- Health/reporting primitives already exist in `packages/engine/src/capability-contract.ts` (`buildAdapterHealthReport`, `AdapterHealthReport`), but OpenCode-specific runtime command health needs a projection and proof path.

#### Risks / Unknowns
- The exact OpenCode delivery mechanism for status, abort/cancel, blocked-step advancement, and health may be staged. Default implementation path should be reusable adapter-owned handlers plus documented/plugin-tool equivalent; native TUI slash registration can remain degraded/documented if it requires a separate TUI plugin surface.
- Status, abort, and advance must operate on the intended execution only. If no execution ID or active lease can be resolved unambiguously, return a typed degraded/error result instead of mutating state.
- Existing `runWorkflow` is adapter-owned and applies OpenCode effects directly. Moving reusable semantics into the engine must not make the engine import OpenCode or own harness projection.
- Command proof artifacts must not include secrets, credentials, private prompts, raw tool arguments, or sensitive local paths.

#### Review Gates
- Weft review is required after the engine command API and OpenCode projection tests pass.
- Warp security audit is required if implementation touches tool policy evaluation, concrete tool-name mapping, input validation, command authorization, plugin tools, or any state-mutating command surface.

## Objectives
### Core Objective
Deliver the minimal OpenCode runtime command lifecycle for issue #17 by defining harness-agnostic command-operation semantics and projecting them through OpenCode-owned entrypoints without hidden workflow starts.

### Deliverables
- [x] Engine runtime command-operation module with typed results for start plan, run named workflow, status, abort/cancel, blocked-step advancement, and health.
- [x] OpenCode plan and named-workflow helpers refactored to delegate to reusable command operations while preserving separate execution modes.
- [x] OpenCode control/inspection/health projection with concise renderer-ready outputs and explicit unsupported/degraded states.
- [x] Isolated engine tests using in-memory stores, mock plan providers, and a mock second-adapter projection.
- [x] OpenCode adapter tests proving explicit delegation, plugin hook safety, command result rendering, policy mapping, and completion/degradation behavior.
- [x] Spec-local docs and dogfood proof artifacts under `docs/specs/30-spec-minimal-runtime-command-lifecycle/`.

### Definition of Done
- [x] `bun test packages/engine/src/__tests__/runtime-command-operations.test.ts` passes.
- [x] `bun test packages/adapters/opencode/src/__tests__/runtime-command-projection.test.ts packages/adapters/opencode/src/__tests__/start-plan-execution.test.ts packages/adapters/opencode/src/__tests__/run-workflow.test.ts packages/adapters/opencode/src/__tests__/plugin.test.ts` passes.
- [x] `bun test` passes.
- [x] `bun run typecheck` passes.
- [x] Spec 30 proof artifacts document command invocation, lifecycle transition, status/health output, and any degraded OpenCode affordances.
- [x] Weft review is complete; Warp audit is complete if authorization/tool-policy boundaries changed.

### Guardrails (Must NOT)
- [x] Do not implement, rename, or require `/start-work` for issue #17; existing legacy references may remain untouched but must not become the issue #17 delivery path.
- [x] Do not make named workflow execution the ordinary plan execution path; `runWorkflow` remains explicit and user-invoked with a named workflow.
- [x] Do not wire `session.created`, idle hooks, continuation hooks, or config hooks to `startExecution`, `runWorkflow`, `startPlanExecution`, or a shared command start operation.
- [x] Do not import OpenCode, concrete command names, concrete tool names, or harness plugin APIs from engine command-operation modules.
- [x] Do not let the engine read `.weave/plans/**`; plan existence/completion stays behind `PlanStateProvider`.
- [x] Do not write proof artifacts containing secrets, API keys, raw prompts, raw completions, credentials, or sensitive local-only data.

## TODOs

- [x] 1. Add engine command-operation type vocabulary
  **What**: Create a reusable command-operation contract with operation kinds, typed inputs, typed success/failure/degraded/unsupported results, effect projection seams, and renderer-ready but harness-neutral result data. Keep command names and parsing out of the engine.
  **Files**: `packages/engine/src/runtime-command-operations/types.ts`, `packages/engine/src/runtime-command-operations/index.ts`, `packages/engine/src/runtime-command-operations.ts`, `packages/engine/src/index.ts`
  **Acceptance**: Engine exports compile; command-operation types reference only core/engine concepts, `RuntimeStore`, `PlanStateProvider`, lifecycle types, and neverthrow `ResultAsync` types.

- [x] 2. Add reusable workflow command runner over lifecycle primitives
  **What**: Extract reusable run/start semantics into engine-owned command operations that validate workflow existence, create/drive execution through lifecycle methods, and return `LifecycleEffect`/projection summaries without applying OpenCode behavior. Require adapter-supplied effect projection when an operation needs concrete dispatch application.
  **Files**: `packages/engine/src/runtime-command-operations/workflow-runner.ts`, `packages/engine/src/runtime-command-operations/run-named-workflow.ts`, `packages/engine/src/runtime-command-operations/index.ts`
  **Acceptance**: A named workflow operation requires an explicit workflow name, calls lifecycle methods in order, returns typed lifecycle errors, and contains no OpenCode imports or concrete command names.

- [x] 3. Add reusable start-plan operation
  **What**: Implement a plan-start command operation that validates the named plan via `PlanStateProvider`, accepts the plan-execution workflow name as adapter/config input, and delegates to the reusable workflow runner. Preserve plan execution as distinct from named workflow execution.
  **Files**: `packages/engine/src/runtime-command-operations/start-plan.ts`, `packages/engine/src/runtime-command-operations/types.ts`, `packages/engine/src/runtime-command-operations/index.ts`
  **Acceptance**: Missing provider, invalid plan name, missing plan, missing workflow, and lifecycle failure all return typed results without creating a `WorkflowInstance` when validation fails.

- [x] 4. Add status, abort/cancel, and blocked-step advancement operations
  **What**: Implement status inspection via `inspectExecution`, active lease resolution through the runtime store, abort/cancel via `handleUserInterrupt` with `signal: "cancel"`, and blocked-step advancement via `completeStep` with an explicit completion signal. Return typed ambiguous/missing/terminal-state results rather than guessing.
  **Files**: `packages/engine/src/runtime-command-operations/status.ts`, `packages/engine/src/runtime-command-operations/control.ts`, `packages/engine/src/runtime-command-operations/types.ts`, `packages/engine/src/runtime-command-operations/index.ts`
  **Acceptance**: Status is read-only; abort affects only the resolved intended active execution; advance requires workflow instance, lease, step name, and completion signal; all fallible paths use `ResultAsync`.

- [x] 5. Add runtime health command operation
  **What**: Add a health operation that wraps engine readiness primitives from explicit adapter-supplied health inputs and includes command-entrypoint support/degradation details without performing harness I/O.
  **Files**: `packages/engine/src/runtime-command-operations/health.ts`, `packages/engine/src/runtime-command-operations/types.ts`, `packages/engine/src/runtime-command-operations/index.ts`
  **Acceptance**: Health reports include adapter readiness, command support status, and unsupported/degraded operation details while remaining pure and sanitized.

- [x] 6. Add engine command-operation tests and mock second-adapter proof
  **What**: Cover all reusable operations with in-memory runtime stores, mock `PlanStateProvider`, mock effect projection, and a non-OpenCode adapter fixture to prove portability. Include tests for success, degraded/unsupported, validation, no implicit start, and event/journal evidence summaries where available.
  **Files**: `packages/engine/src/__tests__/runtime-command-operations.test.ts`, `packages/engine/src/__tests__/runtime-command-operations/fixtures.ts`
  **Acceptance**: Tests prove start plan, named workflow, status, abort/cancel, advance, and health semantics without importing `@weave/adapter-opencode` or any OpenCode registration code.

- [x] 7. Refactor OpenCode plan-start helper onto shared operations
  **What**: Update `startPlanExecution` to become an OpenCode-owned projection of the reusable start-plan operation. Preserve public constants and adapter-owned command naming, but do not add or rely on `/start-work` for issue #17. Ensure callers pass a shared runtime store when status/control will inspect the execution later.
  **Files**: `packages/adapters/opencode/src/start-plan-execution.ts`, `packages/adapters/opencode/src/index.ts`, `packages/adapters/opencode/src/__tests__/start-plan-execution.test.ts`
  **Acceptance**: Existing plan validation behavior remains; tests assert the helper delegates to shared start-plan semantics and still fails before store mutation on missing/invalid plans.

- [x] 8. Refactor OpenCode named-workflow helper onto shared operations
  **What**: Update `runWorkflow` to delegate lifecycle semantics to the reusable named-workflow operation while retaining OpenCode-specific effect projection through `OpenCodeAdapter.spawnSubagent`. Keep the named workflow path separate from ordinary plan execution.
  **Files**: `packages/adapters/opencode/src/run-workflow.ts`, `packages/adapters/opencode/src/index.ts`, `packages/adapters/opencode/src/__tests__/run-workflow.test.ts`
  **Acceptance**: Tests prove `runWorkflow` requires an explicit workflow name, applies `DispatchAgentEffect` through the OpenCode adapter projection, and is not used as a default/hidden workflow path.

- [x] 9. Add OpenCode runtime command projection and result rendering
  **What**: Add adapter-owned command handlers/renderers for plan start, named workflow run, status, abort/cancel, blocked-step advancement, and health. Keep argument parsing, command labels, and OpenCode-specific messages in the adapter. Mark native slash/TUI affordances as degraded or documented equivalent if not implemented in this slice.
  **Files**: `packages/adapters/opencode/src/runtime-command-projection.ts`, `packages/adapters/opencode/src/index.ts`, `packages/adapters/opencode/src/__tests__/runtime-command-projection.test.ts`
  **Acceptance**: Adapter tests verify each handler calls the matching shared command operation, renders typed success/failure/degraded results, and never duplicates lifecycle state-transition logic.

- [x] 10. Integrate OpenCode plugin affordances without hidden execution start
  **What**: If the implementation chooses plugin custom tools or other OpenCode server-plugin affordances, register only explicit user-invoked handlers and preserve `session.created` as agent reconciliation only. If native plugin command delivery is not safe/available, document the equivalent handler/script path and report command-entrypoint readiness as degraded/emulated in health.
  **Files**: `packages/adapters/opencode/src/plugin.ts`, `packages/adapters/opencode/src/__tests__/plugin.test.ts`, `packages/adapters/opencode/src/__tests__/runtime-command-projection.test.ts`
  **Acceptance**: Plugin tests prove `session.created` does not call `runWorkflow`, `startPlanExecution`, or any shared command start operation; command affordances are explicit and separately tested.

- [x] 11. Verify tool-policy and command authorization boundaries
  **What**: Add or update tests only where implementation touches policy/input boundaries: concrete OpenCode tool names must map to abstract capabilities before calling `beforeTool`; state-mutating command operations must carry explicit user authorization metadata and reject unsafe/ambiguous inputs.
  **Files**: `packages/adapters/opencode/src/tool-policy-mapping.ts`, `packages/adapters/opencode/src/__tests__/tool-policy-mapping.test.ts`, `packages/engine/src/__tests__/execution-lifecycle/before-tool-inspect.test.ts`, `packages/engine/src/runtime-command-operations/types.ts`
  **Acceptance**: Tests prove no engine code branches on OpenCode tool names and no command operation accepts secret-bearing metadata or ambiguous execution targets.

- [x] 12. Cover completion signals and blocked advancement behavior
  **What**: Test `agent_signal` and `review_verdict` completion handling where supported, and document/return typed degraded fallback where OpenCode cannot detect structured signals automatically. Ensure blocked/gate advancement returns effects that adapters can project.
  **Files**: `packages/engine/src/__tests__/runtime-command-operations.test.ts`, `packages/engine/src/__tests__/execution-lifecycle/completion-terminal.test.ts`, `packages/adapters/opencode/src/__tests__/runtime-command-projection.test.ts`
  **Acceptance**: Tests cover completion success, rejection/pause behavior, missing provider for plan completion, and unsupported automatic signal detection paths.

- [x] 13. Add command-operation contract documentation
  **What**: Create spec-local notes mapping each command operation to lifecycle methods, required adapter context, typed results, and degradation paths. Link back to Spec 30, adapter boundary, Spec 13, Spec 19, Spec 22, and Spec 29.
  **Files**: `docs/specs/30-spec-minimal-runtime-command-lifecycle/30-command-operation-contract.md`
  **Acceptance**: Documentation clearly distinguishes ordinary plan execution from named workflow execution and states `/start-work` is out of scope for issue #17.

- [x] 14. Add dogfood/proof artifacts
  **What**: Capture sanitized evidence for explicit plan start, named workflow invocation or deliberate non-exposure, status, abort/cancel, blocked-step advancement, health summary, lifecycle state transition, and event/journal output. Use real OpenCode output where feasible; otherwise document the equivalent explicit adapter handler invocation and why native delivery is degraded.
  **Files**: `docs/specs/30-spec-minimal-runtime-command-lifecycle/30-proofs/README.md`, `docs/specs/30-spec-minimal-runtime-command-lifecycle/30-proofs/opencode-runtime-command-dogfood.md`, `docs/specs/30-spec-minimal-runtime-command-lifecycle/30-proofs/health-summary.json`
  **Acceptance**: Proof artifacts connect user-invoked command/handler input to lifecycle transition and final status/health result without leaking secrets or sensitive local data.

- [x] 15. Run focused review gates
  **What**: Request Weft review after tests and docs pass. Request Warp audit if plugin tools, command authorization, input validation, tool-policy mapping, or `beforeTool` integration changed.
  **Acceptance**: Review findings are resolved or documented before marking the plan complete.

- [x] 16. Run final validation suite
  **What**: Run targeted tests, full tests, typecheck, and build. Inspect the final diff to ensure only issue #17 files changed and existing spec/README worktree changes were preserved.
  **Acceptance**: `bun test`, `bun run typecheck`, and `bun run build` pass; final diff includes implementation, tests, docs/proofs, and this plan only as expected.

## Verification
- [x] `bun test packages/engine/src/__tests__/runtime-command-operations.test.ts`
- [x] `bun test packages/engine/src/__tests__/execution-lifecycle/before-tool-inspect.test.ts packages/engine/src/__tests__/execution-lifecycle/dispatch.test.ts packages/engine/src/__tests__/execution-lifecycle/completion-terminal.test.ts`
- [x] `bun test packages/adapters/opencode/src/__tests__/runtime-command-projection.test.ts packages/adapters/opencode/src/__tests__/start-plan-execution.test.ts packages/adapters/opencode/src/__tests__/run-workflow.test.ts packages/adapters/opencode/src/__tests__/plugin.test.ts`
- [x] `bun test`
- [x] `bun run typecheck`
- [x] `bun run build`
- [x] Confirm plugin tests and code review prove no `session.created`, idle, continuation, or config hook starts durable execution.
- [x] Confirm docs/proofs under `docs/specs/30-spec-minimal-runtime-command-lifecycle/` are sanitized and mention issue #17.
- [x] Confirm `/start-work` was not implemented or made required for issue #17.
