## Relevant Files

| File | Why It Is Relevant |
| --- | --- |
| `packages/engine/src/plan-state-provider.ts` | New file: `PlanStateProvider` interface and `PlanStateError` union exported from `@weave/engine`. |
| `packages/engine/src/index.ts` | Export `PlanStateProvider` and `PlanStateError` from the engine barrel. |
| `packages/engine/src/execution-lifecycle.ts` | Add `planStateProvider?: PlanStateProvider` to `CompleteStepInput`; replace `checkPlanFileExists`/`checkPlanComplete` with provider delegation; add absent-provider guard. |
| `packages/config/src/plan-state-provider.ts` | New file: `BunFilesystemPlanStateProvider` — default Bun-backed implementation. |
| `packages/config/src/index.ts` | Export `BunFilesystemPlanStateProvider` from the config barrel. |
| `packages/engine/src/__tests__/execution-lifecycle.test.ts` | Update existing `plan_created`/`plan_complete` tests to supply a mock `PlanStateProvider`; add absent-provider and provider-error tests. |
| `docs/adapter-boundary.md` | Add "Plan State Provider" subsection and ownership-matrix row. |
| `docs/specs/19-spec-plan-state-provider/19-spec-plan-state-provider.md` | Source specification for this work. |

### Notes

- Unit tests for `completeStep` plan paths must use a mock `PlanStateProvider` — never real filesystem I/O.
- Use `bun test packages/engine/src/__tests__/execution-lifecycle.test.ts` for focused lifecycle validation.
- Use `bun run typecheck` to verify the full workspace compiles after changes.
- Follow the engine/adapter boundary: the engine owns the interface and validation; `@weave/config` owns the default Bun implementation.

## Tasks

### [ ] 1.0 Define `PlanStateProvider` interface and `PlanStateError` union

#### 1.0 Proof Artifact(s)

- Code review artifact: `packages/engine/src/plan-state-provider.ts` contains only the interface and error union — no implementation code, no `Bun.file()` calls.
- Typecheck: `bun run typecheck` passes with the new file.
- Export test: `PlanStateProvider` and `PlanStateError` are importable from `@weave/engine`.

#### 1.0 Tasks

- [ ] 1.1 Create `packages/engine/src/plan-state-provider.ts` with `PlanStateError` discriminated union and `PlanStateProvider` interface.
- [ ] 1.2 Export `PlanStateProvider` and `PlanStateError` from `packages/engine/src/index.ts`.
- [ ] 1.3 Run `bun run typecheck` and confirm the new exports compile.

---

### [ ] 2.0 Wire `planStateProvider` into `CompleteStepInput` and update `completeStep`

#### 2.0 Proof Artifact(s)

- Test: absent-provider + `plan_created` step → `policy_decision` error.
- Test: absent-provider + `plan_complete` step → `policy_decision` error.
- Test: provider returns `ok(false)` for `planExists` → `not_found` error.
- Test: provider returns `ok(false)` for `isPlanComplete` → `validation` error.
- Test: provider returns `err({ type: "InvalidPlanName" })` → `validation` error.
- Test: provider returns `err({ type: "ProviderUnavailable" })` → `persistence` error.
- Code review artifact: `execution-lifecycle.ts` contains no `Bun.file()` calls after migration.

#### 2.0 Tasks

- [ ] 2.1 Add `planStateProvider?: PlanStateProvider` to `CompleteStepInput` in `execution-lifecycle.ts`.
- [ ] 2.2 Add absent-provider guard: when `step.completion.method` is `"plan_created"` or `"plan_complete"` and `input.planStateProvider` is `undefined`, return `err(lifecyclePolicyDecisionError("plan completion method requires a planStateProvider", "plan_state_provider"))`.
- [ ] 2.3 Replace `checkPlanFileExists(planName)` call with `input.planStateProvider.planExists(planName)` and map the result to the appropriate `LifecycleError`.
- [ ] 2.4 Replace `checkPlanComplete(planName)` call with `input.planStateProvider.isPlanComplete(planName)` and map the result to the appropriate `LifecycleError`.
- [ ] 2.5 Remove the private `checkPlanFileExists` and `checkPlanComplete` functions from `execution-lifecycle.ts` once they have no remaining callers.
- [ ] 2.6 Update existing `plan_created`/`plan_complete` tests in `execution-lifecycle.test.ts` to supply a mock `PlanStateProvider` via `CompleteStepInput.planStateProvider`.
- [ ] 2.7 Add new tests for absent-provider and provider-error paths (see proof artifacts above).
- [ ] 2.8 Run `bun test packages/engine/src/__tests__/execution-lifecycle.test.ts` and confirm all tests pass.

---

### [ ] 3.0 Implement `BunFilesystemPlanStateProvider` in `@weave/config`

#### 3.0 Proof Artifact(s)

- Code review artifact: `packages/config/src/plan-state-provider.ts` uses `Bun.file()` and applies the safe-name regex before constructing paths.
- Export test: `BunFilesystemPlanStateProvider` is importable from `@weave/config`.
- Typecheck: `bun run typecheck` passes with the new file.

#### 3.0 Tasks

- [ ] 3.1 Create `packages/config/src/plan-state-provider.ts` with `BunFilesystemPlanStateProvider` implementing `PlanStateProvider`.
- [ ] 3.2 Apply the safe-name regex (`/^[a-zA-Z0-9_-]+$/`) inside `BunFilesystemPlanStateProvider` before constructing any filesystem path.
- [ ] 3.3 Export `BunFilesystemPlanStateProvider` from `packages/config/src/index.ts`.
- [ ] 3.4 Run `bun run typecheck` and confirm the new export compiles.

---

### [ ] 4.0 Update documentation

#### 4.0 Proof Artifact(s)

- Documentation: `docs/adapter-boundary.md` has a "Plan State Provider" subsection and an ownership-matrix row for "Plan file state" with `Adapter` as owner.

#### 4.0 Tasks

- [ ] 4.1 Add "Plan State Provider" subsection to `docs/adapter-boundary.md` (see spec for content).
- [ ] 4.2 Add "Plan file state" row to the Ownership Matrix in `docs/adapter-boundary.md` with `Adapter` as owner.
- [ ] 4.3 Add a link to Spec 19 in the `docs/adapter-boundary.md` Related section.
