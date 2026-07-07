## Relevant Files

| File | Why It Is Relevant |
| --- | --- |
| `packages/engine/src/execution-lifecycle.ts` | New engine-owned lifecycle surface and method implementations. |
| `packages/engine/src/__tests__/execution-lifecycle.test.ts` | Isolated tests for lifecycle methods using in-memory Runtime Store fixtures. |
| `packages/engine/src/lifecycle-effects.ts` | Potential home for a broader lifecycle effect union if `RunAgentEffect` is extended rather than reused directly. |
| `packages/engine/src/run-agent-effects.ts` | Existing `RunAgentEffect` type to reuse or include in lifecycle effect output. |
| `packages/engine/src/adapter.ts` | `HarnessAdapter.registerHook()` deprecation/reframing and lifecycle boundary documentation. |
| `packages/engine/src/runner.ts` | Transitional orchestration entry point with existing lifecycle TODOs. |
| `packages/engine/src/index.ts` | Public exports for lifecycle types, helpers, and effects. |
| `packages/engine/src/runtime/store.ts` | Runtime Store interfaces used by lifecycle operations. |
| `packages/engine/src/runtime/types.ts` | `WorkflowInstance`, `ExecutionLease`, `SessionSnapshot`, statuses, and IDs used by lifecycle inputs/outputs. |
| `packages/engine/src/runtime/memory-store.ts` | In-memory Runtime Store test utility used for lifecycle tests. |
| `packages/engine/src/tool-policy.ts` | Existing abstract tool policy evaluation model used by `beforeTool`. |
| `packages/engine/src/__tests__/mock-adapter.ts` | Mock adapter call log to extend for normalized lifecycle method assertions. |
| `packages/engine/src/__tests__/runner.test.ts` | Existing runner behavior tests to update for lifecycle call ordering where applicable. |
| `docs/adapter-boundary.md` | Architecture documentation for adapter-owned event mapping and engine-owned lifecycle decisions. |
| `packages/engine/README.md` | Engine package documentation mentioning future lifecycle surfaces. |

### Notes

- Use Bun commands only: `bun run --filter '@weaveio/weave-engine' test`, `bun run --filter '@weaveio/weave-engine' typecheck`, and repository-level `bun run test`, `bun run typecheck`, `bun run lint`, `bun run build` where appropriate.
- Keep tests isolated from real harnesses. Use `MockAdapter` and `createInMemoryRuntimeStore()` or equivalent in-memory fixtures.
- Use `neverthrow` `Result`/`ResultAsync` for fallible lifecycle operations and explicit discriminated error types.
- Do not persist or emit raw prompts, completions, transcripts, credentials, tokens, cookies, authorization headers, or harness-private payloads.
- Mention issue #44 in any future PR description.

### Planning Assumptions

- `dispatchStep` should introduce a lifecycle effect union that includes the existing `RunAgentEffect` as the dispatch variant, preserving current effect semantics while leaving room for future lifecycle effects.
- `registerHook()` should remain in this slice as deprecated compatibility; implementation should supersede it in docs and tests rather than remove it immediately.
- `completeStep` should use a minimal structured signal with `outcome: "success" | "blocked" | "failed" | "paused"`, optional safe message, optional artifact references, and optional next-step hint; full workflow graph semantics remain out of scope for issue #44.

## Tasks

### [x] 1.0 Define lifecycle vocabulary and public engine surface

#### 1.0 Proof Artifact(s)

- Typecheck: `bun run --filter '@weaveio/weave-engine' typecheck` demonstrates lifecycle types and exports compile.
- Test: `bun run --filter '@weaveio/weave-engine' test` with lifecycle type tests demonstrates typed inputs, typed outputs, and discriminated error variants.
- Documentation: diff for `docs/adapter-boundary.md` and/or `packages/engine/README.md` demonstrates lifecycle method responsibilities and Runtime Store relationship are documented.

#### 1.0 Tasks

- [ ] 1.1 Create `packages/engine/src/execution-lifecycle.ts` with exported input, output, and error types for `observeSession`, `startExecution`, `resumeExecution`, `handleUserInterrupt`, `dispatchStep`, `completeStep`, and `beforeTool`.
- [ ] 1.2 Model lifecycle errors as a discriminated union compatible with `neverthrow`, including validation, not-found, lease-conflict, persistence, and policy-decision failure cases.
- [ ] 1.3 Define sanitized metadata types that cannot represent raw prompts, completions, transcripts, credentials, cookies, tokens, authorization headers, or raw provider payloads.
- [ ] 1.4 Implement a lifecycle effect union that includes `RunAgentEffect` as the dispatch variant.
- [ ] 1.5 Export lifecycle types and helpers from `packages/engine/src/index.ts`.
- [ ] 1.6 Add focused type/unit tests proving valid lifecycle inputs, typed error variants, and public import paths compile.
- [ ] 1.7 Document the lifecycle vocabulary and method responsibilities in `docs/adapter-boundary.md` and/or `packages/engine/README.md`.

### [x] 2.0 Implement session observation and execution start/resume

#### 2.0 Proof Artifact(s)

- Test: `observeSession` test stores a sanitized `SessionSnapshot` and demonstrates secret-like/raw harness fields are excluded.
- Test: `startExecution` test creates or updates a `WorkflowInstance` and acquires an active `ExecutionLease` with an in-memory Runtime Store.
- Test: `resumeExecution` test rebinds an available or expired execution and returns a typed conflict for an unexpired foreign lease.
- CLI/Test output: `bun run --filter '@weaveio/weave-engine' test` demonstrates lifecycle start/resume behavior passes without a real harness.

#### 2.0 Tasks

- [ ] 2.1 Implement `observeSession` so adapters provide normalized session ID, harness name/version, optional foreground agent, optional model ID, current step, status, timestamp, and sanitized metadata.
- [ ] 2.2 Persist session observations through the Runtime Store snapshot/journal boundaries without accepting raw harness dumps or private payloads.
- [ ] 2.3 Implement `startExecution` for a named workflow or default plan workflow using Runtime Store instance and lease repositories.
- [ ] 2.4 Ensure `startExecution` records a running or created-to-running `WorkflowInstance` state and acquires the active execution lease using one clock source per operation.
- [ ] 2.5 Implement `resumeExecution` to explicitly rebind to an existing workflow execution when no unexpired foreign lease blocks it.
- [ ] 2.6 Map unexpired active lease conflicts to a typed lifecycle error without throwing.
- [ ] 2.7 Add in-memory Runtime Store tests for sanitized session snapshots, start execution state, lease acquisition, expired lease replacement, and active foreign lease conflict.

### [x] 3.0 Implement interrupt, dispatch, and completion lifecycle flow

#### 3.0 Proof Artifact(s)

- Test: `handleUserInterrupt` moves a running workflow instance to `paused` and preserves execution metadata needed for resume.
- Test: `dispatchStep` emits a `RunAgentEffect` or lifecycle dispatch effect with normalized agent/step references and safe metadata only.
- Test: `completeStep` records success, blocked, failed, and paused completion signals in a typed inspectable shape.
- Review artifact: code review checklist entry confirms emitted effects contain no raw prompts, credentials, tokens, harness-private paths, or raw provider payloads.

#### 3.0 Tasks

- [ ] 3.1 Implement `handleUserInterrupt` so user interruption updates active workflow state to `paused` or equivalent resumable non-running status.
- [ ] 3.2 Ensure interrupt handling does not mark a workflow completed or discard lease/execution metadata needed for explicit resume.
- [ ] 3.3 Implement `dispatchStep` to select or accept the next runnable step reference and return a safe abstract dispatch effect.
- [ ] 3.4 Update Runtime Store state during dispatch with the current step or pending dispatch metadata needed by later completion calls.
- [ ] 3.5 Define the minimal structured completion signal for `completeStep` with `success`, `blocked`, `failed`, and `paused` outcomes, optional safe message, optional artifact references, and optional next-step hint.
- [ ] 3.6 Implement `completeStep` to persist the structured outcome, update workflow status/current step, and return typed state/effect output.
- [ ] 3.7 Add tests for pause, dispatch state update, safe dispatch payload contents, completion outcomes, and non-goal boundaries that avoid full workflow graph semantics.

### [x] 4.0 Implement `beforeTool` policy lifecycle point

#### 4.0 Proof Artifact(s)

- Test: `beforeTool` returns deterministic allow, deny, and ask decisions for normalized capability inputs.
- Test: policy lifecycle tests demonstrate concrete tool names are adapter input context only and engine decisions use abstract capabilities.
- Security review artifact: Warp review notes cover `beforeTool`, sanitized lifecycle inputs, and effect payload boundaries.

#### 4.0 Tasks

- [ ] 4.1 Define `beforeTool` input as adapter-provided normalized capability context plus the effective tool policy needed for evaluation.
- [ ] 4.2 Reuse existing abstract tool policy evaluation behavior from `packages/engine/src/tool-policy.ts` instead of creating a second policy model.
- [ ] 4.3 Return normalized allow/deny/ask decisions or typed lifecycle errors that adapters can translate into harness-specific enforcement.
- [ ] 4.4 Add tests for allow, deny, ask, unknown capability or invalid context, and policy error handling.
- [ ] 4.5 Add a security-focused test or fixture proving `beforeTool` input/output records do not include credentials, tokens, raw tool payloads, or harness-private state.
- [ ] 4.6 Document that adapters own concrete tool-name mapping and the engine owns abstract policy decisions.

### [x] 5.0 Reframe adapter integration and transitional runner behavior

#### 5.0 Proof Artifact(s)

- Test: `MockAdapter` lifecycle call-order tests demonstrate session observation, start/resume, dispatch, completion, and tool policy decisions use normalized inputs.
- Test: runner tests demonstrate no real harness process starts and no concrete hook registration is introduced by the engine lifecycle surface.
- Documentation: `docs/adapter-boundary.md` describes the lifecycle surface as the replacement path for transitional `registerHook()`.

#### 5.0 Tasks

- [ ] 5.1 Update `packages/engine/src/adapter.ts` documentation so `registerHook()` is explicitly superseded while retained only as deprecated compatibility.
- [ ] 5.2 Avoid adding engine code that registers OpenCode hooks, Pi callbacks, Claude Code handlers, or any concrete harness lifecycle listener.
- [ ] 5.3 Extend `MockAdapter` call records only where adapter-facing integration tests need to prove normalized lifecycle input order.
- [ ] 5.4 Update `WeaveRunner` lifecycle TODO handling only as far as needed for the MVP surface; avoid implementing full workflow engine behavior.
- [ ] 5.5 Add tests proving `init()` remains read-only/probe-oriented and lifecycle methods are not called during adapter initialization.
- [ ] 5.6 Update package docs to distinguish adapter-owned event mapping from engine-owned lifecycle decisions.

### [x] 6.0 Final quality gates, documentation, and security review

#### 6.0 Proof Artifact(s)

- CLI: `bun run lint` passes and demonstrates repository style compliance.
- CLI: `bun run typecheck` passes and demonstrates workspace type safety.
- CLI: `bun run build` passes and demonstrates package build integrity.
- CLI: `bun run test` passes and demonstrates full workspace regression coverage.
- Security review artifact: Warp approval or findings/remediation notes are attached for issue #44 lifecycle policy/input boundaries.

#### 6.0 Tasks

- [x] 6.1 Run `bun run --filter '@weaveio/weave-engine' test` and resolve engine lifecycle regressions.
- [x] 6.2 Run `bun run --filter '@weaveio/weave-engine' typecheck` and resolve engine type/export issues.
- [x] 6.3 Run repository-level `bun run lint`, `bun run typecheck`, `bun run build`, and `bun run test`.
- [x] 6.4 Verify proof artifacts are sanitized and contain no real credentials, tokens, private identifiers, raw prompts, raw completions, transcripts, or harness-private payloads.
- [x] 6.5 Request Warp security review for tool policy, lifecycle input validation, Runtime Store writes, and adapter trust boundaries.
- [x] 6.6 Ensure final documentation links issue #44 and relevant specs/docs before implementation is marked complete.
