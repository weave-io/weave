# Learnings: Minimal Runtime Command Lifecycle

## Task 1: Add engine command-operation type vocabulary
- **Discrepancy**: The first Shuttle attempt wrote the new engine files into the main checkout instead of the `spec/issue-17` worktree.
- **Resolution**: Retried the task with an explicit worktree-only instruction and required cleanup of the main checkout before verification.
- **Suggestion**: Future delegations for this plan should repeat the exact worktree path and explicitly forbid edits outside the issue-17 worktree.

## Task 3: Add reusable start-plan operation
- **Discrepancy**: The plan’s `**Files**` list did not mention a focused engine test file, but implementation required `packages/engine/src/__tests__/start-plan.test.ts` to prove the validation guarantees.
- **Resolution**: Verified the added test file alongside the operation and export changes because the acceptance criteria required proving no `WorkflowInstance` creation on validation failure.
- **Suggestion**: Future plan tasks that add new engine command operations should explicitly include the expected focused test file in the `**Files**` list.

## Task 4: Add status, abort/cancel, and blocked-step advancement operations
- **Discrepancy**: The plan’s `**Files**` list again omitted the focused engine test file needed to prove the new command operations, and the implementation added `packages/engine/src/__tests__/status-control.test.ts`.
- **Resolution**: Verified the new test file together with `status.ts`, `control.ts`, and barrel changes because the acceptance criteria required proof of read-only status inspection and explicit control validation.
- **Suggestion**: Plan tasks for new engine command operations should consistently include the corresponding focused test file in `**Files**`.

## Task 5: Add runtime health command operation
- **Discrepancy**: The plan’s `**Files**` list omitted the focused engine test file needed to prove the pure health operation, and implementation added `packages/engine/src/__tests__/runtime-health.test.ts`.
- **Resolution**: Verified the new health test file together with `health.ts` and barrel changes because the acceptance criteria required proof of pure, sanitized readiness reporting.
- **Suggestion**: Engine operation tasks should include their focused test files up front instead of relying on later discovery.

## Task 7: Refactor OpenCode plan-start helper onto shared operations
- **Discrepancy**: The first implementation refactored `start-plan-execution.ts` correctly, but `packages/adapters/opencode/src/__tests__/start-plan-execution.test.ts` still described and asserted `runWorkflow` behavior instead of the new shared `startPlan` boundary.
- **Resolution**: Retried the task and verified the test file now removes stale `runWorkflow` references and explicitly frames the behavior as delegation to shared `startPlan` semantics.
- **Suggestion**: When refactoring adapter helpers onto shared engine operations, include the test-language and assertion updates in the same first pass so behavioral proof matches the new boundary immediately.

## Task 8: Refactor OpenCode named-workflow helper onto shared operations
- **Discrepancy**: The plan’s `**Files**` list covered only adapter files, but the refactor also required engine-side changes in `packages/engine/src/runtime-command-operations/types.ts` and `run-named-workflow.ts` to thread optional `planStateProvider` through the shared operation.
- **Resolution**: Verified the additional engine changes were minimal, boundary-safe, and necessary to preserve plan-oriented completion behavior while shifting `runWorkflow` onto the shared engine runner.
- **Suggestion**: Future adapter-refactor tasks should note when shared-engine operation signatures may need coordinated updates, especially for provider/context plumbing.

## Task 9: Add OpenCode runtime command projection and result rendering
- **Discrepancy**: The plan’s `**Files**` list did not mention that the engine compatibility barrel and engine public barrel were missing exports for several newly added shared operations, so adapter projection work required coordinated updates in `packages/engine/src/runtime-command-operations.ts` and `packages/engine/src/index.ts`.
- **Resolution**: Verified the extra barrel exports were necessary so the adapter projection layer could consume the shared operations through the supported engine surface instead of reaching into private paths.
- **Suggestion**: When a plan adds a new adapter projection over recent engine APIs, include any required engine barrel/export alignment in the task scope up front.

## Task 10: Integrate OpenCode plugin affordances without hidden execution start
- **Discrepancy**: By the time this task was reached, the required explicit affordance coverage was already satisfied by the existing `plugin.ts` boundary plus the projection tests added in task 9, so no code changes were necessary.
- **Resolution**: Verified `session.created` remains reconciliation-only and that explicit command handlers are separately tested, then marked the task complete without additional edits.
- **Suggestion**: Future plans should call out when a later task is expected to be verification-only if earlier tasks are likely to satisfy the acceptance criteria incidentally.

## Task 11: Verify tool-policy and command authorization boundaries
- **Discrepancy**: The plan’s `**Files**` list suggested possible production-code changes in `tool-policy-mapping.ts` and command-operation types, but the acceptance criteria were satisfied by adding boundary-focused tests only.
- **Resolution**: Verified the existing mapping and engine boundary were already correct, then added tests proving abstract-capability enforcement, secret-key rejection, and non-ambiguous mutating command inputs.
- **Suggestion**: Distinguish verification-only policy tasks from implementation tasks when the current code likely already satisfies the intended boundary.

## Task 12: Cover completion signals and blocked advancement behavior
- **Discrepancy**: The plan’s `**Files**` list omitted `packages/engine/src/__tests__/runtime-command-operations/fixtures.ts`, but additional shared workflow fixtures were required to cover `review_verdict`, `plan_created`, and `plan_complete` scenarios consistently across engine and adapter tests.
- **Resolution**: Verified the added fixture updates plus the targeted test expansions in engine lifecycle, engine command-operation, and OpenCode projection suites.
- **Suggestion**: When a task expands cross-suite workflow coverage, include the shared test-fixture file in the planned scope.

## Task 13: Add command-operation contract documentation
- **Discrepancy**: The plan listed only the new contract document, but proper documentation linkage also required updating `30-spec-minimal-runtime-command-lifecycle.md` to add a backlink in the Related header.
- **Resolution**: Verified both the new contract doc and the spec backlink so the repository documentation graph remains navigable.
- **Suggestion**: Documentation tasks should explicitly include any expected backlink or index updates, not just the newly created file.

## Task 15: Run focused review gates
- **Discrepancy**: The task ended up being verification-only because the prior implementation and test work already satisfied the gate criteria without any new edits.
- **Resolution**: Verified the findings were documented and that no additional file changes were needed before proceeding to final validation.
- **Suggestion**: Future plans should mark similar late-stage gate tasks as verification-only when no further code or doc edits are expected unless findings fail.
