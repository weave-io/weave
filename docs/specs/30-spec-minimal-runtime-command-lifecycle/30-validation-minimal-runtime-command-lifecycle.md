# 30-validation-minimal-runtime-command-lifecycle.md

**Spec:** [`30-spec-minimal-runtime-command-lifecycle.md`](./30-spec-minimal-runtime-command-lifecycle.md)  
**Task list equivalent:** [`../../../.weave/plans/minimal-runtime-command-lifecycle.md`](../../../.weave/plans/minimal-runtime-command-lifecycle.md)  
**Validation Completed:** 2026-06-05 12:46:57 EDT  
**Validation Performed By:** OpenAI GPT-5.5

## 1) Executive Summary

**Overall:** PASS

No blocking gates were tripped.

- **Gate A:** PASS — no CRITICAL or HIGH issues found.
- **Gate B:** PASS — no `Unknown` Functional Requirement entries.
- **Gate C:** PASS — proof artifacts are accessible and functional.
- **Gate D:** PASS with one MEDIUM traceability note for supporting `.codesight/*` files committed on the branch but not explicitly linked in the plan.
- **Gate E:** PASS — implementation follows repository standards and patterns.
- **Gate F:** PASS — proof artifacts contain no real API keys, tokens, passwords, or sensitive credentials.

**Implementation Ready:** **Yes** — requirements are verified by passing targeted tests, accessible sanitized proof artifacts, complete task checkboxes, terminal Weft/Warp approvals, and passing repository quality gates.

**Key metrics:**

- Requirements Verified: **4/4 demoable requirement groups (100%)**
- Proof Artifacts Working: **3/3 proof files (100%)**
- Files Changed vs Expected: **All core source/runtime files mapped to Spec 30 requirements/tasks; one supporting traceability note for `.codesight/*` committed files**
- Quality Gates: `bun test` **2968 pass / 0 fail**, targeted SDD4 suites **306 pass / 0 fail**, `bun run typecheck` **pass**, `bun run build` **pass**

## 2) Coverage Matrix

### Functional Requirements

| Requirement ID/Name | Status | Evidence |
| --- | --- | --- |
| FR-1 / Unit 1: Reusable runtime command operations | Verified | Spec lines 27-42 require shared operations for start plan, run named workflow, status, abort/cancel, advance blocked step, and health. Evidence: `packages/engine/src/runtime-command-operations/{types,workflow-runner,run-named-workflow,start-plan,status,control,health}.ts`; tests `packages/engine/src/__tests__/runtime-command-operations.test.ts`, `start-plan.test.ts`, `status-control.test.ts`, `runtime-health.test.ts`; targeted SDD4 command returned **306 pass / 0 fail** across 7 files; proof README lines 1-81 summarize engine command-operation and health test coverage. |
| FR-2 / Unit 2: OpenCode explicit entrypoints and no hidden start | Verified | Spec lines 43-59 require explicit OpenCode delivery, `/weave:start` where feasible, named workflow separate from plan execution, no `/start-work`, no hidden/default workflow, and no `session.created` durable start. Evidence: `packages/adapters/opencode/src/start-plan-execution.ts`, `run-workflow.ts`, `runtime-command-projection.ts`; tests `start-plan-execution.test.ts`, `run-workflow.test.ts`, `plugin.test.ts`, `runtime-command-projection.test.ts`; proof dogfood doc covers `/weave:start` and `/weave:run`; proof README lines 35-38 document native slash delivery degradation and explicit handler invocation equivalent. |
| FR-3 / Unit 3: Runtime control, inspection, and health affordances | Verified | Spec lines 60-75 require status, abort/cancel, advance, health support/degradation, and event/journal evidence. Evidence: `packages/engine/src/runtime-command-operations/status.ts`, `control.ts`, `health.ts`; `packages/adapters/opencode/src/runtime-command-projection.ts`; tests `status-control.test.ts`, `runtime-health.test.ts`, `runtime-command-projection.test.ts`; proof dogfood doc includes `/weave:status`, `/weave:abort`, `/weave:advance`, `/weave:health`; `30-proofs/health-summary.json` lines 1-151 show sanitized `ready: true`, `commandEntrypointsSupported: true`, 12 capabilities, 8 degraded warnings, 0 failures. |
| FR-4 / Unit 4: Lifecycle, policy, completion-signal, and evidence integration | Verified | Spec lines 76-91 require session-context observation where exposed, `agent_signal`/`review_verdict` handling or degraded fallback, abstract tool policy after mapping, dispatch/RunAgent effects via adapter projection, and evidence linking invocation to lifecycle transition. Evidence: `completion-terminal.test.ts`, `runtime-command-operations.test.ts`, `runtime-command-projection.test.ts`, `tool-policy-mapping.test.ts`, `plugin.test.ts`; targeted SDD4 suites **306 pass / 0 fail**; proof dogfood doc connects command input to lifecycle/log transition and final `ProjectionResult<T>` for all six operations. |

### Repository Standards

| Standard Area | Status | Evidence & Compliance Notes |
| --- | --- | --- |
| Engine / adapter boundary | Verified | Spec lines 105-114 require harness-agnostic engine semantics and adapter-owned concrete command registration/hook/UI. Weft approved: engine command operations have zero OpenCode imports/concrete command names; adapter projection owns labels/parsing/rendering and delegates lifecycle logic. |
| Explicit user-authorized start / no hidden workflow | Verified | Spec non-goals lines 93-99 and Unit 2 lines 43-59 prohibit `/start-work`, hidden default workflow revival, and session hook start. `plugin.test.ts` and terminal Weft/Warp review verify `session.created` only reconciles agents. |
| PlanStateProvider boundary | Verified | Spec lines 105-114 and technical/security lines 116-140 require plan access through `PlanStateProvider`. `startPlan` validates provider and plan existence before store mutation; Warp approved fail-closed provider validation and path-safety delegation. |
| Testing patterns | Verified | Uses Bun tests, isolated in-memory runtime stores, mock providers/adapters, and focused suites. Targeted SDD4 suites: **306 pass / 0 fail**; full suite: **2968 pass / 0 fail**. |
| Bun-only and neverthrow | Verified | `bun run typecheck` passed all packages. Weft approved `ResultAsync`-based fallible paths and found no blocking style or boundary violations. |
| Documentation and proof policy | Verified | Spec 30, command-operation contract, proof README, dogfood proof, and health JSON exist under `docs/specs/30-spec-minimal-runtime-command-lifecycle/`; proof docs are sanitized and linked. |
| Security / proof sanitization | Verified | `python3 -m json.tool .../health-summary.json` returned `json ok`; proof secret scan returned `secret scan ok`; Warp approved proof-artifact sanitization. |

### Proof Artifacts

| Unit/Task | Proof Artifact | Status | Verification Result |
| --- | --- | --- | --- |
| Unit 1 / reusable command operations | `packages/engine/src/__tests__/runtime-command-operations.test.ts`, `start-plan.test.ts`, `status-control.test.ts`, `runtime-health.test.ts` | Verified | Targeted SDD4 suite included engine runtime command tests; result **306 pass / 0 fail** across 7 files. |
| Unit 1 / portability proof | `packages/engine/src/__tests__/runtime-command-operations/fixtures.ts` and mock second-adapter coverage | Verified | Task execution and Weft review confirmed mock second-adapter portability; committed diff includes fixtures and integration tests. |
| Unit 1 / contract docs | `docs/specs/30-spec-minimal-runtime-command-lifecycle/30-command-operation-contract.md` | Verified | File exists; documents all six command operations, lifecycle mappings, adapter context, typed results, degradation paths, `/start-work` out of scope, and plan/workflow separation. |
| Unit 2 / OpenCode explicit path | `packages/adapters/opencode/src/__tests__/start-plan-execution.test.ts`, `run-workflow.test.ts`, `plugin.test.ts`, `runtime-command-projection.test.ts` | Verified | Targeted SDD4 suite included all four adapter tests; result **306 pass / 0 fail** across 7 files. Proof dogfood doc includes `/weave:start` and `/weave:run`. |
| Unit 3 / runtime control and health | `docs/specs/30-spec-minimal-runtime-command-lifecycle/30-proofs/opencode-runtime-command-dogfood.md` | Verified | Proof doc includes sanitized evidence and typed `ProjectionResult<T>` for `/weave:status`, `/weave:abort`, `/weave:advance`, and `/weave:health`; raw evidence is preceded by explanatory context. |
| Unit 3 / health summary | `docs/specs/30-spec-minimal-runtime-command-lifecycle/30-proofs/health-summary.json` | Verified | JSON validates; sanitized metadata; `ready: true`; `commandEntrypointsSupported: true`; 12 capabilities; 8 degraded warnings; 0 failures. |
| Unit 4 / policy and completion behavior | `tool-policy-mapping.test.ts`, `completion-terminal.test.ts`, `runtime-command-operations.test.ts`, `runtime-command-projection.test.ts` | Verified | Targeted SDD4 suite passed; Warp approved abstract-capability mapping, secret-key metadata rejection, lease validation, terminal-state guards, and explicit invocation only. |
| Task completion evidence | `.weave/plans/minimal-runtime-command-lifecycle.md` | Verified | Grep found no unchecked boxes; deliverables, guardrails, 16 tasks, and verification checklist are checked. |

## 3) Validation Issues

| Severity | Issue | Impact | Recommendation |
| --- | --- | --- | --- |
| MEDIUM | Supporting-file traceability gap: committed diff vs `main` includes `.codesight/CODESIGHT.md`, `.codesight/coverage.md`, `.codesight/graph.md`, and `.codesight/libs.md`, but these supporting analysis files are not listed in Spec 30 or the plan. Evidence: `git diff --name-only main..HEAD` included `.codesight/*`; no core runtime behavior depends on them. | Traceability only; does not obscure Functional Requirement verification and does not trip Gate D1 because these are supporting documentation/analysis files, not source/runtime code. | Add a short note in the plan, validation appendix, or commit body explaining that `.codesight/*` files are generated supporting analysis for the issue-17 validation/review scope, or remove them if they are accidental. |
| LOW | Non-blocking style inconsistency from Weft: `status.ts` and `control.ts` use inline `import("neverthrow").ResultAsync<…>` return-type syntax instead of the top-level import style used elsewhere. | Maintainability/style only; code compiles and tests pass. | Normalize the import style in a future cleanup if desired. |
| LOW | Non-blocking documentation drift from Warp: `control.ts` header says abort calls `handleUserInterrupt` with `signal: "cancel"`, while implementation correctly passes caller signal (`cancel` or `pause`). | Documentation precision only; behavior is correct and tested. | Update the header wording in a small follow-up cleanup. |
| LOW | Non-blocking dead input note from Weft: `RunWorkflowInput.maxSteps` is documented but no longer forwarded to `runNamedWorkflow`. | API/documentation cleanup only; engine default still applies and tests pass. | Either forward `maxSteps` through the shared operation or remove/deprecate the input in a future cleanup. |

No CRITICAL or HIGH issues were found.

## 4) Evidence Appendix

### Inputs Discovered

- Spec: `docs/specs/30-spec-minimal-runtime-command-lifecycle/30-spec-minimal-runtime-command-lifecycle.md`
- Task-list equivalent: `.weave/plans/minimal-runtime-command-lifecycle.md`
- Note: no `30-tasks-*` file exists for this SDD run, so the executed Weave plan is the task-list equivalent.

### Git Commits Analyzed

Recent issue-17 commit chain from `main..HEAD`:

1. `95fc247 feat(engine): add reusable workflow runner and run-named-workflow operation`
2. `f8da540 feat(engine): add start-plan command operation`
3. `b043e65 refactor(adapter-opencode): delegate runWorkflow to engine runNamedWorkflow`
4. `b07fc97 test(tool-policy): verify adapter/engine boundary and command authorization`
5. `c8445f1 test(engine,opencode): cover completion signals and blocked advancement`
6. `aec05a1 docs(spec-30): add dogfood/proof artifacts for runtime command lifecycle`

The commit story maps coherently to Spec 30: engine reusable operations, OpenCode adapter refactor, policy/completion tests, and proof artifacts. Commits do not all mention `#17` explicitly, but their scopes and messages map to the spec requirements.

### Changed File Classification

Core implementation files mapped to Spec 30 requirements/tasks:

- Engine command operations: `packages/engine/src/runtime-command-operations.ts`, `runtime-command-operations/index.ts`, `types.ts`, `workflow-runner.ts`, `run-named-workflow.ts`, `start-plan.ts`, `status.ts`, `control.ts`, `health.ts`
- Engine public exports: `packages/engine/src/index.ts`
- OpenCode adapter implementation: `packages/adapters/opencode/src/start-plan-execution.ts`, `run-workflow.ts`, `runtime-command-projection.ts`, `index.ts`

Supporting verification/documentation files linked to requirements:

- Engine tests and fixtures: `start-plan.test.ts`, `status-control.test.ts`, `runtime-health.test.ts`, `runtime-command-operations.test.ts`, `runtime-command-operations/fixtures.ts`, `execution-lifecycle/completion-terminal.test.ts`
- OpenCode tests: `start-plan-execution.test.ts`, `run-workflow.test.ts`, `runtime-command-projection.test.ts`, `tool-policy-mapping.test.ts`, `plugin.test.ts`
- Docs/proofs: Spec 30, command-operation contract, proof README, dogfood proof, health summary, spec index, plan, learnings
- Supporting traceability note: `.codesight/*` files appear in committed diff and should be linked or removed before merge if the team wants perfectly clean traceability.

Current uncommitted issue-17 worktree changes from `git status --short -uall` are limited to issue-17 implementation, tests, docs/proofs, plan, and learnings. Main checkout was verified clean during task 16.

### Commands Executed

```bash
bun test packages/engine/src/__tests__/runtime-command-operations.test.ts \
  packages/engine/src/__tests__/execution-lifecycle/completion-terminal.test.ts \
  packages/adapters/opencode/src/__tests__/runtime-command-projection.test.ts \
  packages/adapters/opencode/src/__tests__/start-plan-execution.test.ts \
  packages/adapters/opencode/src/__tests__/run-workflow.test.ts \
  packages/adapters/opencode/src/__tests__/plugin.test.ts \
  packages/adapters/opencode/src/__tests__/tool-policy-mapping.test.ts
# 306 pass, 0 fail, 873 expects, 7 files

bun run typecheck
# all packages exit 0

python3 -m json.tool docs/specs/30-spec-minimal-runtime-command-lifecycle/30-proofs/health-summary.json
# json ok

# secret scan across proof artifacts for common API key/token/password/secret patterns
# secret scan ok
```

Prior terminal gates from task 16 and terminal validators:

```bash
bun run build
# pass

bun test
# 2968 pass, 0 fail

# Weft review
# APPROVE

# Warp audit
# APPROVE
```

### Proof Artifact Results

- `30-proofs/README.md`: accessible; explains evidence model, no-secret policy, degraded native slash delivery, explicit handler invocation equivalent, and test summary.
- `30-proofs/opencode-runtime-command-dogfood.md`: accessible; includes sanitized evidence for `/weave:start`, `/weave:run`, `/weave:status`, `/weave:abort`, `/weave:advance`, `/weave:health`, plus lifecycle/log transitions and typed results.
- `30-proofs/health-summary.json`: accessible and valid JSON; sanitized; `ready: true`; `commandEntrypointsSupported: true`; 12 capabilities; 8 degraded warnings; 0 failures.

## Final Verdict

**PASS.** Spec 30 implementation is validated and ready for final human code review before merge.
