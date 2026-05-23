# Adapter Readiness — Close the 30% Gap

## TL;DR
> **Summary**: Delete `WeaveRunner`, change `materializeAgents` to partial-by-default semantics (breaking), build a production-grade `@weave/adapter-opencode` pinned against `@opencode-ai/sdk` types, close three user-facing DSL/boundary gaps (workflow step extension via `extends`/`insert_before`/`insert_after`, per-router delegation exclusion via `routing { delegation_exclude [...] }`, plan-file checks behind a `PlanStateProvider`), and outright delete `registerHook` / `loadSkill` from `HarnessAdapter`. Result: third-party adapters can be built against the engine without crossing the boundary.
> **Estimated Effort**: Large

## Context

### Original Request
Produce a sequenced plan that closes the gaps blocking third-party `@weave/adapter-*` packages from being built against the engine. The audit established the project is ~70% adapter-ready; five user-facing capabilities exist but workflow surgery, delegation surgery, plan-file boundary leak, and the absent reference adapter block external adopters.

### Key Findings (from investigation)
- **`WeaveRunner` is dead weight.** `packages/engine/src/runner.ts` (284 LOC) self-identifies as "the current transitional orchestration entry point". Its `run()` method is `init` → `loadAvailableSkills` → `generateCategoryShuttles` → per-agent `resolveSkillsForAgent` → per-agent `composeAgentDescriptor` → `adapter.spawnSubagent`. Every step is already exported as a pure function. It violates `docs/adapter-boundary.md` by orchestrating `adapter.spawnSubagent` inside the engine. No production code outside tests uses it.
- **`materializeAgents` is the replacement** and already lives at `packages/engine/src/materialization.ts`. It currently returns `ResultAsync<MaterializationPlan, MaterializationError>` from `composeAgentDescriptor`'s first failure — i.e. fail-fast. The runner's behaviour was skip-and-continue. Decision (see Resolved Decisions §1): change `materializeAgents` itself to partial-by-default and keep one function with explicit partial semantics.
- **`packages/adapters/opencode/src/index.ts` is a 0-byte file** with `package.json` wired but no implementation. There is no reference adapter to validate the engine API end-to-end. Decision (§6): pin against real `@opencode-ai/sdk` types — production-grade reference.
- **Workflow merge collapses to copy-paste.** `packages/config/src/merge.ts` union-merges `workflow.steps[]` by `JSON.stringify` equality. To insert a step into a builtin workflow the user must re-declare the entire workflow. The four builtin workflows in `packages/config/src/builtins.ts` (`plan-and-execute`, `quick-fix`, `tapestry-execution`) are the targets users want to extend.
- **Delegation exclusion is all-or-nothing.** `engine/src/compose.ts` lines 137-161 (`buildDelegationTargets`) auto-includes every non-disabled subagent with `delegate: allow`. Removing one target from one router's table requires globally disabling the agent.
- **Engine reads `.weave/plans/<plan>.md` directly.** `engine/src/execution-lifecycle.ts` lines 1861 and 1898 (`checkPlanFileExists`, `checkPlanComplete`) call `Bun.file(planPath)` inside the engine. `docs/adapter-boundary.md` is explicit that file discovery is adapter-owned; the engine should only own `.weave/runtime/**`.
- **Deprecated `HarnessAdapter` methods (`registerHook`, `loadSkill`)** are still required interface members at `packages/engine/src/adapter.ts:97` and `:109`. There is no production implementor — only `MockAdapter` and the empty opencode stub. They can be deleted outright (Decision §5).
- **Specs 15 + 16** already establish `MaterializationPlan` and the Stable Adapter Descriptor Contract. Spec 13 establishes the 7-method Execution Lifecycle Surface. The pieces exist; only the assembly is missing.

---

## Resolved Decisions

These six choices were made by the user before planning concluded. Every TODO below honours them.

1. **`materializeAgents` is partial-by-default.** The function changes its return shape from `ResultAsync<MaterializationPlan, MaterializationError>` to `ResultAsync<MaterializationPlan, MaterializationError>` **where `MaterializationPlan` now carries both `agents: MaterializedAgent[]` and `errors: readonly MaterializationError[]`**. The `ResultAsync` only rejects when the input itself is unusable (e.g. an irrecoverable upstream failure that prevents iteration); per-agent `DescriptorCompositionFailure` and the `CategoryShuttleConflict` case become entries in `plan.errors` so callers see successful descriptors alongside their failures. No sibling `materializeAgentsPartial` is added — one function with one explicit partial-success shape. *Rationale*: adapters need to surface partial states without a fork in the API; two near-duplicate functions create drift and force every adapter to pick a side. One function with an explicit `errors[]` channel keeps the contract honest and matches how `WeaveRunner` already behaved (skip-and-continue with logged warnings). This is a breaking change to the existing `materializeAgents` return shape and Spec 15; both must be updated in this work.

2. **Workflow extension uses `extends` + same-name replace + `insert_before` / `insert_after`.** New optional fields on `workflow { }`: `extends "<workflow-name>"` (optional string referencing another workflow by name). When `extends` is present, the override workflow inherits the parent's `steps[]`. Each child step is then applied in this order: (a) **parent steps first** — start from the inherited base; (b) **applied replacements** — any child step whose `name` matches a parent step name replaces the parent step in place; (c) **applied insertions** — child steps that carry `insert_before "<anchor-step-name>"` or `insert_after "<anchor-step-name>"` are inserted at the named anchor in declaration order; (d) any remaining child steps with neither marker nor a same-name parent append to the end. **Both `insert_before` and `insert_after` on the same step → validation error.** Unknown `extends` target → validation error (`UnknownExtendsTarget`). Unknown anchor for `insert_before`/`insert_after` → validation error (`UnknownInsertionAnchor`). Cycles in `extends` chains → validation error (`ExtendsCycle`). Without `extends`, current behaviour is unchanged (backwards-compatible). *Rationale*: this surface lets users surgically modify any single builtin workflow without re-declaring the whole thing, while keeping the merge model declarative and explainable in one sentence per step.

3. **`delegation_exclude` lives inside a `routing { }` block on `agent { }`.** DSL: `agent loom { routing { delegation_exclude ["warp", "spindle"] } }`. Schema adds an optional `routing?: { delegation_exclude?: string[] }` object to `AgentConfigSchema`. The block is intentionally open for future fields (`priority`, `fallback`, weighted routing knobs); JSDoc on the schema records this intent so future specs can extend the block without breaking compat. `buildDelegationTargets()` in `engine/src/compose.ts` consults `agentConfig.routing?.delegation_exclude` and filters targets out by name. *Rationale*: per-router routing knobs deserve a dedicated block. Hanging a single `delegation_exclude` field at the top level paints us into a corner the moment we want a second routing field; the `routing { }` block is the right structural home and matches how `tool_policy { }` already groups related fields.

4. **`PlanStateProvider` interface lives in `@weave/engine`; the default Bun-backed implementation lives in `@weave/config`.** The engine declares what it needs (the interface). The default reference implementation that reads `.weave/plans/<name>.md` ships from `@weave/config` as `BunFilesystemPlanStateProvider` (same package as prompt path resolution and other config-layer file I/O). Adapters that need different semantics (sandboxed checks, remote stores, in-memory test doubles) inject their own provider. **The engine receives the provider via `CompleteStepInput.planStateProvider?: PlanStateProvider`** — carried alongside the existing input shape, not on the `RuntimeStore`. *Rationale*: the provider is a per-call dispatch concern (not durable runtime state), so threading it through `CompleteStepInput` matches how `WorkflowExecutionContext` is already supplied and avoids polluting the store interface with adapter-replaceable behaviour.

5. **`registerHook` and `loadSkill` are deleted outright.** No backward-compat shim, no soft `LegacyHarnessAdapter` extension. The methods, their config types (`HookConfig`, `SkillConfig`), the corresponding `MockCall` discriminants, and the empty opencode-adapter stub references all go. *Rationale*: there is no production implementor (the only opencode adapter file is 0 bytes). Carrying deprecated methods on the interface forces every future adapter to ship dead no-op stubs and gives readers the impression these hooks are part of the contract. A clean break now costs nothing and keeps the interface honest.

6. **The reference OpenCode adapter pins against `@opencode-ai/sdk` types — production-grade.** Add `@opencode-ai/sdk` as a dependency in `packages/adapters/opencode/package.json`. The adapter translates `AgentDescriptor` into the **current** SDK agent-config shape (verified against the live SDK types, with `docs/legacy-architecture.md` §6.2 used only as a starting reference). The integration test instantiates and validates an agent config using real SDK types, with no `any`-casts past the package boundary. *Rationale*: a synthetic reference proves nothing about whether the engine API can be wired into a real harness. Pinning against the real SDK forces us to confront concrete tool-name mapping, model-field formatting, and any SDK gotchas that would otherwise surface for the first time in a downstream consumer. The cost is SDK-coupled test churn on breaking SDK releases; that cost is acknowledged in Risk & Rollback and flagged for periodic review.

---

## Objectives

### Core Objective
Make `@weave/engine` and `@weave/config` cleanly consumable by a third-party adapter package, with the engine/adapter boundary in `docs/adapter-boundary.md` respected at every callsite, and prove it by shipping a reference `@weave/adapter-opencode` that materialises a workflow end-to-end against real `@opencode-ai/sdk` types.

### Deliverables
- [ ] `WeaveRunner` removed from `@weave/engine`; canonical bootstrap pattern documented.
- [ ] `materializeAgents` returns a `MaterializationPlan` that carries both `agents[]` and `errors[]`; `WeaveRunner`'s skip-and-continue semantics preserved by the new return shape. Spec 15 updated to reflect the new contract.
- [ ] `@weave/adapter-opencode` implements `init`, `spawnSubagent`, `loadAvailableSkills`, consumes the new `MaterializationPlan`, applies at least one `DispatchAgentEffect` from `dispatchStep`, and uses real `@opencode-ai/sdk` types for its translation layer.
- [ ] DSL supports `extends "<base>"` + same-name replace + `insert_before` / `insert_after` for surgical workflow extension.
- [ ] DSL supports per-router delegation exclusion via `agent { routing { delegation_exclude [...] } }`.
- [ ] Plan-file existence and completeness checks live behind a `PlanStateProvider` (interface in `@weave/engine`, default Bun-backed impl in `@weave/config`).
- [ ] `registerHook()` and `loadSkill()` and the `HookConfig` / `SkillConfig` types are deleted outright from `@weave/engine`.
- [ ] All `docs/` updates landed in the same commits as the code: new `docs/adapter-bootstrap.md`, new specs 17 (workflow extension), 18 (delegation exclusion), 19 (plan-state provider); Spec 15 amended; relevant updates in `docs/adapter-boundary.md`.

### Definition of Done
- [ ] `bun test` passes from repo root.
- [ ] `bun run typecheck` passes from repo root (covers all packages including the new adapter).
- [ ] `bun run build` succeeds (`@weave/adapter-opencode` emits a `dist/` with declaration files).
- [ ] `grep -rn "WeaveRunner" packages/` returns zero hits outside `docs/` migration notes.
- [ ] `grep -n "Bun.file" packages/engine/src/execution-lifecycle.ts` returns zero hits.
- [ ] `grep -rn "registerHook\|loadSkill\|HookConfig\|SkillConfig" packages/engine/src/` returns zero hits.
- [ ] `grep -rn "as any\|as unknown as" packages/adapters/opencode/src/` returns zero hits past the runtime-context boundary.
- [ ] At least one new integration test in `packages/adapters/opencode/src/__tests__/` runs a small `plan-and-execute`-shaped fixture workflow against the reference adapter, asserts the `DispatchAgentEffect` was applied, and validates the produced agent config against `@opencode-ai/sdk` types.

### Guardrails (Must NOT)
- Do NOT change the `RuntimeStore` contract or schema (`packages/engine/src/runtime/**`).
- Do NOT touch the lexer (`packages/core/src/lexer.ts`) or AST node shapes beyond what new DSL keywords require.
- Do NOT start a real OpenCode process inside any test. All adapter tests use in-memory stubs of the `OpenCodeRuntimeContext`.
- Do NOT introduce `try/catch` for fallible paths — use `Result`/`ResultAsync` per AGENTS.md.
- Do NOT use `console.*`. Use `logger` from `@weave/engine`.
- Do NOT silently expand scope: the workflow extension is a schema + merge-semantics change, not a parser rewrite of unrelated constructs.
- Do NOT skip the four-level test rule on any schema change: `schema.test.ts`, `parser.test.ts`, `validate.test.ts`, `parse_config.test.ts`.
- Do NOT add a sibling `materializeAgentsPartial`. There is one function with partial semantics.
- Do NOT add a synthetic stand-in for `@opencode-ai/sdk` types. Real SDK or it does not count as a reference adapter.

---

## TODOs

### P0 — Hard blockers (must complete before P1)

- [x] 1. Change `materializeAgents` to partial-by-default
  **What**: Modify `MaterializationPlan` to include a new field: `errors: readonly MaterializationError[]` (alongside the existing `agents: MaterializedAgent[]`). Rewrite the body of `materializeAgents` so it iterates every explicit agent and every generated category shuttle, accumulating successful descriptors into `agents[]` and per-agent failures into `errors[]` instead of short-circuiting. The `ResultAsync` itself only rejects on irrecoverable upstream failure (none currently — category shuttle conflict becomes an entry in `errors[]`, not a top-level reject). Preserve deterministic ordering: explicit agents in config order, then generated category shuttles in category declaration order, with disabled agents filtered before iteration. Update `MaterializationError` JSDoc to clarify that values are now collected rather than returned as the rejection.
  **Files**: `packages/engine/src/materialization.ts`, `packages/engine/src/index.ts` (re-exports unchanged — same names, new shape).
  **Acceptance**: Function compiles with new shape; `bun run typecheck` clean for the materialization module in isolation; behaviour change is intentional and visible in the diff.

- [x] 2. Update materialization tests for partial-by-default
  **What**: Audit `packages/engine/src/__tests__/materialization.test.ts` for every test that asserts the rejected-`Result` path of `materializeAgents`. Rewrite each to assert that the value resolves to a `MaterializationPlan` carrying the expected entries in `errors[]` instead. Add new tests for: (a) one good agent + one bad agent both surface in their respective arrays; (b) category shuttle conflict appears in `errors[]` and explicit agents still resolve; (c) all-failures case yields empty `agents[]` and populated `errors[]`; (d) ordering invariant — successful agents preserve config order regardless of which earlier agents failed.
  **Files**: `packages/engine/src/__tests__/materialization.test.ts`.
  **Acceptance**: All materialization tests pass under the new shape; no test still expects a top-level `ResultAsync` rejection for per-agent failures.

- [x] 3. Update every other consumer of `materializeAgents` for the new shape
  **What**: Grep the repo for `materializeAgents` callers (`grep -rn "materializeAgents" packages/`). Today the function is exported from `@weave/engine` and the canonical consumer surface is empty (only test/spec references). Update each callsite to read `result.value.agents` and `result.value.errors` separately, logging or surfacing errors as appropriate. Confirm via grep that nothing else still expects the old rejected-Result-per-agent-failure flow.
  **Files**: any package source files that reference `materializeAgents` (likely only test files plus the soon-to-be-deleted runner).
  **Acceptance**: `grep -rn "materializeAgents" packages/` returns only callsites that read `.agents` and `.errors`; no caller treats per-agent failure as a top-level rejection.

- [ ] 4. Update Spec 15 to reflect partial-by-default
  **What**: Edit `docs/specs/15-spec-adapter-facing-materialization-api/15-spec-adapter-facing-materialization-api.md` to (a) reflect the new `MaterializationPlan { agents, errors }` shape, (b) replace any "fail-fast" wording with "partial-by-default" and explain the rationale (mirror the rationale from Resolved Decision §1), (c) record this as a breaking change to the spec contract with a version bump or migration note. Also update `docs/adapter-boundary.md` §"Agent Materialization API" so its description of the data contract matches the new shape. Update `15-validation-…md` artefacts to match if they cite the old shape.
  **Files**: `docs/specs/15-spec-adapter-facing-materialization-api/15-spec-adapter-facing-materialization-api.md`, `docs/specs/15-spec-adapter-facing-materialization-api/15-validation-adapter-facing-materialization-api.md`, `docs/adapter-boundary.md`.
  **Acceptance**: Spec text matches code; cross-links unbroken; the boundary doc no longer claims `materializeAgents` fails fast.

- [x] 5. Write `docs/adapter-bootstrap.md`
  **What**: New guide showing the canonical adapter bootstrap pattern with a runnable snippet using `MockAdapter`. Cover: `loadConfig` → `materializeAgents` → read `plan.agents` and surface `plan.errors` → adapter loop calling `spawnSubagent(descriptor)` → workflow path with `startExecution` → `dispatchStep` → adapter applies `LifecycleEffect[]` → `completeStep` (with `planStateProvider` injected from `@weave/config`'s `BunFilesystemPlanStateProvider` once Task 18 lands; cross-reference forward to that task). Link from `docs/adapter-boundary.md` (Transitional Interfaces section) and `docs/product-vision.md`. Include an explicit "you do not need `WeaveRunner` — it has been removed" callout.
  **Files**: `docs/adapter-bootstrap.md` (new), `docs/adapter-boundary.md` (add link), `docs/product-vision.md` (add link).
  **Acceptance**: File exists; cross-links resolve; snippet uses only public exports from `@weave/engine` and `@weave/config`.

- [x] 6. Remove `WeaveRunner` from `@weave/engine`
  **What**: Delete `packages/engine/src/runner.ts`. Remove `runner.js` export block from `packages/engine/src/index.ts` (lines 112-117 — types and class). Remove references in `packages/engine/src/run-agent-effects.ts` JSDoc (line 6) and `packages/engine/src/adapter.ts` JSDoc (lines 57, 114) — replace with references to the documented bootstrap pattern in `docs/adapter-bootstrap.md`.
  **Files**: delete `packages/engine/src/runner.ts`; edit `packages/engine/src/index.ts`, `packages/engine/src/run-agent-effects.ts`, `packages/engine/src/adapter.ts`.
  **Acceptance**: `grep -rn "WeaveRunner\|runner.js\|runner.ts" packages/engine/src/` returns zero hits outside the deletion target. `bun run typecheck` fails until task 7 runs (expected).

- [x] 7. Rewrite `runner.test.ts` and update `execution-lifecycle-integration.test.ts`
  **What**: `packages/engine/src/__tests__/runner.test.ts` (1335 LOC) is the regression suite for the `init → loadAvailableSkills → spawnSubagent` orchestration. Rename to `materialization-orchestration.test.ts` and rewrite each test to exercise the documented adapter bootstrap pattern: a small `orchestrate(config, adapter)` helper inside the test file performs `adapter.init()` → `adapter.loadAvailableSkills()` → `materializeAgents({ config })` → reads `plan.agents` and `plan.errors` → loop calling `adapter.spawnSubagent(descriptor)`. Each existing test transplants to the new harness (lifecycle ordering, agent spawning, category shuttle generation, skill resolution warnings, `onEffect` observer hook becomes a parameter to the bootstrap fn, descriptor composition failure tolerance now reads from `plan.errors`). Update `execution-lifecycle-integration.test.ts` lines 30, 283-400 to use the new orchestration fn rather than `WeaveRunner`. Drop tests that specifically asserted `WeaveRunnerError` discriminants — replace with assertions against `plan.errors` entries.
  **Files**: `packages/engine/src/__tests__/runner.test.ts` (rewrite + rename to `materialization-orchestration.test.ts`), `packages/engine/src/__tests__/execution-lifecycle-integration.test.ts` (edit), `packages/engine/src/__tests__/mock-adapter.ts` (JSDoc tweaks; no API changes — `MockAdapter` interface unchanged until task 21).
  **Acceptance**: `bun test --filter materialization-orchestration` and `bun test --filter execution-lifecycle-integration` both pass; `WeaveRunner` is referenced nowhere in `packages/engine/src/__tests__/`.

- [ ] 8. Scaffold `@weave/adapter-opencode` package skeleton with `@opencode-ai/sdk` dependency
  **What**: Add `"@opencode-ai/sdk": "<pin to current stable>"` to `packages/adapters/opencode/package.json` dependencies. Run `bun install`. Create the source modules: `src/index.ts` (`OpenCodeAdapter` class implementing `HarnessAdapter`), `src/runtime-context.ts` (`OpenCodeRuntimeContext` interface — the injection seam that abstracts process spawning, file I/O against `.opencode/`, and any other host-level concerns), `src/errors.ts` (typed `OpenCodeAdapterError` discriminated union). The `HarnessAdapter` methods (`init`, `spawnSubagent`, `loadAvailableSkills`) take `Promise` for interface compatibility; internal helpers return `ResultAsync<T, OpenCodeAdapterError>` and convert at the boundary using `.match()`. Real `@opencode-ai/sdk` types are imported in `src/index.ts` and `src/sdk-types.ts` (re-exports for internal use); the runtime context interface uses those SDK types directly so call sites are type-checked end to end.
  **Files**: `packages/adapters/opencode/package.json` (add dependency), `packages/adapters/opencode/src/index.ts` (new), `packages/adapters/opencode/src/runtime-context.ts` (new), `packages/adapters/opencode/src/errors.ts` (new), `packages/adapters/opencode/src/sdk-types.ts` (new — internal re-export module for SDK types so a single file pins what we use).
  **Acceptance**: `bun install` resolves cleanly; `bun run --filter @weave/adapter-opencode typecheck` passes; `bun run --filter @weave/adapter-opencode build` produces `dist/index.js` + `dist/index.d.ts`; the package can be imported by a downstream consumer that doesn't separately install `@opencode-ai/sdk` because the adapter depends on it.

- [ ] 9. Implement `OpenCodeAdapter.spawnSubagent` translation against real SDK types
  **What**: Translate `AgentDescriptor` → the SDK's agent-config shape (verify the exact type name and field list against `@opencode-ai/sdk` — `docs/legacy-architecture.md` §6.2 documents the legacy shape as `{ model, prompt, temperature, tools, mode, description }` but the current SDK may have evolved; consult the live `.d.ts` files in `node_modules/@opencode-ai/sdk/` and pin to the current export). Map only the descriptor's stable fields (`name`, `displayName`, `composedPrompt`, `models[0]`, `mode`, `temperature`, `effectiveToolPolicy`). The adapter maps abstract `effectiveToolPolicy` capabilities to concrete OpenCode tool names internally (e.g. `write → ["write","edit"]`, `execute → ["bash"]`) in a pure mapping module. Skill content is delegated to `runtimeContext.attachSkill(agentName, resolvedSkillName)`. The output value is typed as the SDK's real agent-config type (no `any`).
  **Files**: `packages/adapters/opencode/src/index.ts`, `packages/adapters/opencode/src/tool-policy-mapping.ts` (new — pure mapping table), `packages/adapters/opencode/src/translate-agent.ts` (new — pure `descriptor → SDK agent config` function returning `Result<SDKAgentConfig, OpenCodeAdapterError>`), `packages/adapters/opencode/src/__tests__/translate-agent.test.ts` (new).
  **Acceptance**: Unit test asserts that translating a fixture descriptor with `effectiveToolPolicy { read: allow, write: ask, execute: deny, delegate: allow, network: deny }` produces an agent config that **passes a runtime type check against the SDK's exported schema/parser** (if the SDK provides one) or **structurally satisfies the SDK's TypeScript type** (verified at compile time, no `any` casts). The `@opencode-ai/sdk` import appears only in `src/sdk-types.ts`, `src/translate-agent.ts`, and `src/index.ts` — not in any test that mocks the runtime context.

- [ ] 10. Wire workflow execution end-to-end in the adapter
  **What**: Implement an `OpenCodeAdapter.runWorkflow(input: { workflowName, goal, slug, store })` method that demonstrates the lifecycle surface. Call `startExecution` → loop on `dispatchStep` and convert returned `DispatchAgentEffect[]` into `runtimeContext.dispatchAgent` calls → adapter receives step completion signals from the runtime context and calls `completeStep` (injecting the `PlanStateProvider` from task 18 once available — leave a `TODO` link until task 18 lands, or stage tasks so this depends on 18) → terminates on `complete-execution` effect. Use `createInMemoryRuntimeStore` so the test does not require SQLite. **Note:** for the integration test, inject an in-memory `PlanStateProvider` stub so this task does not block on `BunFilesystemPlanStateProvider`.
  **Files**: `packages/adapters/opencode/src/run-workflow.ts` (new), `packages/adapters/opencode/src/index.ts` (export); `packages/adapters/opencode/src/__tests__/run-workflow.test.ts` (new — integration test).
  **Acceptance**: Integration test parses a fixture `.weave` config with a 2-step `quick-fix`-shaped workflow, instantiates `OpenCodeAdapter` with a stub `OpenCodeRuntimeContext` that records dispatch calls, runs `runWorkflow`, and asserts (1) two `DispatchAgentEffect` calls were applied in order, (2) the workflow instance ends in `completed` status, (3) the produced agent configs validate against `@opencode-ai/sdk` types (no `any` past the boundary), (4) no `Bun.file` or `Bun.spawn` calls were made by the adapter directly (only through the stubbed runtime context).

### P1 — User criteria gaps

#### P1-A: Workflow extension DSL (`extends` + same-name replace + `insert_before` / `insert_after`)

- [x] 11. Specify workflow step extension DSL (Spec 17)
  **What**: Write `docs/specs/17-spec-workflow-extension/17-spec-workflow-extension.md` documenting the surface decided in Resolved Decision §2. Cover: (1) schema additions (`workflow.extends?: string`; `WorkflowStep.insert_before?: string` / `insert_after?: string` — anchor name only, attached to the *step*, not to a separate insertion block); (2) merge precedence: parent steps first → applied replacements (same-name) → applied insertions (anchor-based) → appended new steps; (3) validation errors: `UnknownExtendsTarget`, `UnknownInsertionAnchor`, `BothInsertBeforeAndAfter`, `ExtendsCycle`; (4) interaction with the existing workflow union-merge (replaced by step-aware merge when either side declares `extends` or when both sides define a workflow of the same name); (5) the migration story for the four builtin workflows (they remain unchanged; users gain the ability to extend them). Include adapter-boundary clause: workflow extension is a config-merge concern, fully owned by `@weave/config`; engine receives the post-merge `WorkflowConfig` unchanged. Also create `17-tasks-…md` and `17-validation-…md` skeletons.
  **Files**: `docs/specs/17-spec-workflow-extension/17-spec-workflow-extension.md` (new), `docs/specs/17-spec-workflow-extension/17-tasks-workflow-extension.md` (new), `docs/specs/17-spec-workflow-extension/17-validation-workflow-extension.md` (new — skeleton; filled in task 14), `docs/adapter-boundary.md` (link).
  **Acceptance**: Spec document exists; merge semantics are unambiguous; an example shows inserting a `spec` step before `plan` in builtin `plan-and-execute` using only the new keywords.

- [x] 12. P1-A: Schema + AST + parser support for `extends` and step-level `insert_before` / `insert_after`
  **What**:
  - **Schema** (`packages/core/src/schema.ts`): extend `WorkflowConfigSchema` with optional `extends: z.string().optional()`. Extend `WorkflowStepSchema` with optional `insert_before: z.string().optional()` and `insert_after: z.string().optional()`. Add `.refine()` to `WorkflowStepSchema` rejecting both `insert_before` and `insert_after` set simultaneously (`BothInsertBeforeAndAfter`). Add `.refine()` to `WorkflowConfigSchema` allowing `steps.min(1)` to relax when `extends` is set (extension can override-only). Document the new fields in the JSDoc.
  - **AST** (`packages/core/src/ast.ts`): add optional `extends` to workflow AST node; add optional `insert_before` / `insert_after` to step AST node.
  - **Parser** (`packages/core/src/parser.ts`): recognise `extends "<name>"` as a scalar inside `workflow { ... }`, and `insert_before "<anchor>"` / `insert_after "<anchor>"` as scalars inside `step <name> { ... }`. Use existing scalar-parsing primitives; no new lexer tokens.
  - **Validator** (`packages/core/src/validate.ts`): map AST → schema input straightforwardly.
  - **Tests at all four levels** per AGENTS.md: `schema.test.ts` (accept valid combos, reject `BothInsertBeforeAndAfter` and `extends`-with-empty-steps-without-extension), `parser.test.ts` (lex the new scalars), `validate.test.ts` (AST → schema), `parse_config.test.ts` (E2E: parse a workflow with `extends` + step-level `insert_before`).
  **Files**: `packages/core/src/schema.ts`, `packages/core/src/parser.ts`, `packages/core/src/ast.ts`, `packages/core/src/validate.ts`, `packages/core/src/__tests__/schema.test.ts`, `packages/core/src/__tests__/parser.test.ts`, `packages/core/src/__tests__/validate.test.ts`, `packages/core/src/__tests__/parse_config.test.ts`.
  **Acceptance**: New schema fields accepted; refinements reject invalid combinations with descriptive paths; parser tokens for `extends`/`insert_before`/`insert_after` lex correctly; all four test files updated with positive + negative cases.

- [ ] 13. P1-A: Merge logic for workflow extension
  **What**: Update `packages/config/src/merge.ts`. The blanket array union-merge handles `workflow.steps[]` poorly; introduce a step-aware merge for `WorkflowConfig` values. New flow extracted into a `mergeWorkflow(base: WorkflowConfig, override: WorkflowConfig): Result<WorkflowConfig, WorkflowExtensionError>` helper:
  1. Resolve the effective base. If `override.extends` is set, look up the workflow named `override.extends` from the workflow map being merged; if missing → `UnknownExtendsTarget`. If `override.extends === override.name` (or a deeper cycle exists in the chain) → `ExtendsCycle`.
  2. Same-name replacement: walk `override.steps`. For each child step whose `name` matches a step in the resolved base, replace the base step in place.
  3. Anchored insertion: for any remaining child step with `insert_before` or `insert_after` set, look up the anchor in the post-replacement step list; if missing → `UnknownInsertionAnchor`. Insert at the resolved index.
  4. Append remaining child steps with no anchor and no same-name parent.
  5. Return the merged `WorkflowConfig`.
  Wire `mergeWorkflow` into the existing `mergeValues` path so that when both sides have a `WorkflowConfig` at the same key in the `workflows` record, the step-aware merge is used. **Detect cycles by walking the `extends` chain across the workflow map being merged**; a cycle longer than one is detected by tracking visited names.
  Because `mergeConfigs` currently returns `WeaveConfig` directly (not a `Result`), introduce a new `mergeConfigsResult(...) : Result<WeaveConfig, MergeError[]>` and migrate callers to it; keep a thin `mergeConfigs(...)` wrapper that throws a typed `MergeError` aggregate on the first failure for callers that haven't migrated yet (mark deprecated).
  **Files**: `packages/config/src/merge.ts`, `packages/config/src/__tests__/merge.test.ts` (confirm exists; create if not), `packages/config/src/__tests__/parse_config.test.ts` or equivalent E2E test for merge.
  **Acceptance**: Inserting a `spec` step before `plan` in builtin `plan-and-execute` via project config produces the expected ordered `steps[]`. Replacing the `implement` step's `prompt` via same-name replace works. Missing anchor returns `UnknownInsertionAnchor`. Unknown extends target returns `UnknownExtendsTarget`. Cycle detected returns `ExtendsCycle`. A backwards-compat test parses an override that defines a workflow without `extends` and confirms current union-merge-like behaviour still applies.

- [ ] 14. P1-A: Document workflow extension migration and fill validation artefact
  **What**: Document in `docs/config-loading.md` and link from Spec 17. Migration note: existing user configs without the new keywords behave identically to today. The four builtin workflows in `packages/config/src/builtins.ts` are not changed by this task; users gain the ability to extend them. Fill in `17-validation-workflow-extension.md` with concrete pre/post examples covering each merge case (same-name replace, `insert_before`, `insert_after`, anchor-missing error, cycle error).
  **Files**: `docs/config-loading.md`, `docs/specs/17-spec-workflow-extension/17-validation-workflow-extension.md` (fill in skeleton from task 11), `docs/adapter-boundary.md` (link to Spec 17 from the relevant ownership-matrix row).
  **Acceptance**: Validation doc contains pre/post DSL examples for every merge case; cross-links resolve; the boundary doc references Spec 17.

#### P1-B: Per-router delegation exclusion via `routing { delegation_exclude [...] }`

- [x] 15. P1-B: Specify per-router delegation exclusion (Spec 18)
  **What**: Write `docs/specs/18-spec-delegation-exclusion/18-spec-delegation-exclusion.md` documenting the surface decided in Resolved Decision §3. Cover: (1) DSL — `agent <name> { routing { delegation_exclude ["a","b"] } }`; (2) schema addition — `AgentConfigSchema` gains an optional `routing` object initially containing only `delegation_exclude?: string[]`, with JSDoc noting the block is open for future routing fields (priority, fallback, weighted routes); (3) semantics — `buildDelegationTargets()` filters out target names listed in `routing.delegation_exclude`; (4) validation — exclude entries that do not correspond to a known agent at validation time produce a debug-level log only, no validation error (forward references between config layers); (5) interaction with `disabled.agents` — excluded names that are also disabled are a no-op; (6) example showing Loom config that excludes `warp` from its delegation table while `warp` remains usable as a Tapestry delegation target. Create `18-tasks-…md` skeleton.
  **Files**: `docs/specs/18-spec-delegation-exclusion/18-spec-delegation-exclusion.md` (new), `docs/specs/18-spec-delegation-exclusion/18-tasks-delegation-exclusion.md` (new).
  **Acceptance**: Spec doc with worked example showing per-router exclusion without disabling the target.

- [x] 16. P1-B: Implement `routing { delegation_exclude }` end-to-end
  **What**:
  - **Schema** (`packages/core/src/schema.ts`): add `RoutingConfigSchema = z.object({ delegation_exclude: z.array(z.string()).optional() }).strict()` (strict so unknown keys in `routing { }` raise a validation error and signal the user mistyped a future field). Add `routing: RoutingConfigSchema.optional()` to `AgentConfigSchema`. JSDoc on `RoutingConfigSchema`: "Per-agent routing knobs. Open for future fields (priority, fallback, weighted routes). Strict — unknown keys are rejected so typos surface clearly."
  - **AST** (`packages/core/src/ast.ts`): add optional `routing` block to agent AST node carrying a string-array `delegation_exclude` field.
  - **Parser** (`packages/core/src/parser.ts`): recognise `routing { ... }` as a nested block inside `agent { }`, with `delegation_exclude ["...", "..."]` as an array-of-strings scalar inside it. Mirror the existing `tool_policy { }` nested-block parsing.
  - **Validator** (`packages/core/src/validate.ts`): map AST → schema input.
  - **Engine** (`packages/engine/src/compose.ts`): update `buildDelegationTargets` at lines 137-161 to consult `agentConfig.routing?.delegation_exclude` and filter targets out by name.
  - **Tests at all four DSL levels** + an engine test in `packages/engine/src/__tests__/compose.test.ts`: (1) excluded target absent from agent's delegation list; (2) excluded target still appears in other agents' lists; (3) excluding a non-existent target is a no-op (logged at debug level only); (4) strict `routing { }` rejects unknown nested keys.
  **Files**: `packages/core/src/schema.ts`, `packages/core/src/parser.ts`, `packages/core/src/ast.ts`, `packages/core/src/validate.ts`, `packages/engine/src/compose.ts`, `packages/core/src/__tests__/schema.test.ts`, `packages/core/src/__tests__/parser.test.ts`, `packages/core/src/__tests__/validate.test.ts`, `packages/core/src/__tests__/parse_config.test.ts`, `packages/engine/src/__tests__/compose.test.ts`.
  **Acceptance**: All four DSL-level test files updated; engine test proves per-agent filtering without disabling targets globally; strict block rejects unknown keys with a clear path; `bun run typecheck` clean.

#### P1-C: `PlanStateProvider` interface in `@weave/engine`, default `BunFilesystemPlanStateProvider` in `@weave/config`

- [x] 17. P1-C: Specify `PlanStateProvider` (Spec 19)
  **What**: Write `docs/specs/19-spec-plan-state-provider/19-spec-plan-state-provider.md` documenting the interface decided in Resolved Decision §4. Define:
  ```ts
  interface PlanStateProvider {
    planExists(planName: string): ResultAsync<boolean, PlanStateError>;
    isPlanComplete(planName: string): ResultAsync<boolean, PlanStateError>;
  }
  type PlanStateError =
    | { type: "InvalidPlanName"; planName: string; reason: string }
    | { type: "ProviderUnavailable"; reason: string };
  ```
  Specify: (1) interface and error union live in `@weave/engine` (export from `packages/engine/src/plan-state-provider.ts`); (2) `CompleteStepInput` gains an optional `planStateProvider?: PlanStateProvider`; (3) when `step.completion.method === "plan_created"` or `"plan_complete"` and `planStateProvider` is **absent**, `completeStep` returns `lifecyclePolicyDecisionError("plan completion method requires a planStateProvider")` — never silently passes; (4) the default Bun-backed implementation lives in `@weave/config` as `BunFilesystemPlanStateProvider`, reads `.weave/plans/<name>.md`, validates `<name>` against the same safe-name regex that `validatePlanName` currently uses; (5) `validatePlanName` itself remains an internal helper in `@weave/engine` (it's a sanitisation concern that any provider may want to apply, and the engine still validates input before calling the provider). Add `19-tasks-…md` skeleton. Add a "Plan State Provider" subsection to `docs/adapter-boundary.md` recording adapter ownership.
  **Files**: `docs/specs/19-spec-plan-state-provider/19-spec-plan-state-provider.md` (new), `docs/specs/19-spec-plan-state-provider/19-tasks-plan-state-provider.md` (new), `docs/adapter-boundary.md` (add subsection + ownership-matrix row "Plan file state" with `Adapter` as owner).
  **Acceptance**: Spec defines interface, error union, where the reference helper lives, and the engine's behaviour when the provider is absent.

- [ ] 18. P1-C: Implement `PlanStateProvider` and remove `Bun.file` from `execution-lifecycle.ts`
  **What**:
  - **Engine** (`packages/engine/src/plan-state-provider.ts`, new): define `PlanStateProvider` interface and `PlanStateError` union. Re-export from `packages/engine/src/index.ts`.
  - **Engine** (`packages/engine/src/execution-lifecycle.ts`): add `planStateProvider?: PlanStateProvider` to `CompleteStepInput`. In the success-path branch around lines 2467-2490, replace the inline `checkPlanFileExists` / `checkPlanComplete` calls with calls into the injected provider: `input.planStateProvider.planExists(renderedPlanName)` returning `Result<boolean, PlanStateError>` → mapped to the existing `LifecycleError` vocabulary. When `step.completion.method` requires a plan check and `planStateProvider` is `undefined`, return `lifecyclePolicyDecisionError("plan completion method requires a planStateProvider — inject one via CompleteStepInput")`. Delete `checkPlanFileExists`, `checkPlanComplete`, and the `Bun.file` usages around lines 1853-1925. Keep `validatePlanName` as an internal helper (still used by the default provider via re-export, and by any caller that wants to pre-validate names before calling the engine).
  - **Config** (`packages/config/src/plan-state-provider.ts`, new): implement `BunFilesystemPlanStateProvider`. Reads `.weave/plans/<planName>.md`, calls `validatePlanName` (imported from `@weave/engine`), returns `false` when missing, returns `false` when incomplete checkboxes remain (mirrors the old logic in `checkPlanComplete`). All file I/O wrapped in `ResultAsync.fromPromise`.
  - **Config** (`packages/config/src/index.ts`): export `BunFilesystemPlanStateProvider`.
  - **Tests**:
    - `packages/engine/src/__tests__/execution-lifecycle.test.ts`: update plan-related tests (around lines 5051 and 5199) to inject an in-memory `PlanStateProvider` stub. Add a new test asserting that omitting the provider when the step demands a plan check returns `lifecyclePolicyDecisionError`.
    - `packages/config/src/__tests__/plan-state-provider.test.ts` (new): covers the Bun helper for safe-name validation, missing file → `ok(false)`, complete plan → `ok(true)`, incomplete plan → `ok(false)`, invalid name → `err(InvalidPlanName)`.
  **Files**: `packages/engine/src/plan-state-provider.ts` (new), `packages/engine/src/execution-lifecycle.ts`, `packages/engine/src/index.ts`, `packages/engine/src/__tests__/execution-lifecycle.test.ts`, `packages/config/src/plan-state-provider.ts` (new), `packages/config/src/index.ts`, `packages/config/src/__tests__/plan-state-provider.test.ts` (new).
  **Acceptance**: `grep -n "Bun.file" packages/engine/src/execution-lifecycle.ts` returns zero hits; existing plan-related lifecycle tests pass with the stub provider; new `BunFilesystemPlanStateProvider` test covers safe-name validation, missing file, complete plan, incomplete plan. The adapter integration test from task 10 can swap its in-memory stub for `BunFilesystemPlanStateProvider` and still pass.

- [ ] 19. P1-C: Wire `BunFilesystemPlanStateProvider` into the reference adapter
  **What**: Update `packages/adapters/opencode/src/run-workflow.ts` from task 10 to import `BunFilesystemPlanStateProvider` from `@weave/config` and use it as the default when no provider is injected by the caller. The adapter still accepts a `planStateProvider?` override on its `runWorkflow` input for testability. Update the adapter's integration test (`run-workflow.test.ts`) to still use the in-memory stub, but add a second test that uses `BunFilesystemPlanStateProvider` against a tmp directory fixture to prove the full path works.
  **Files**: `packages/adapters/opencode/src/run-workflow.ts`, `packages/adapters/opencode/src/__tests__/run-workflow.test.ts`, `packages/adapters/opencode/package.json` (add `@weave/config` to dependencies if not already present).
  **Acceptance**: Both run-workflow tests pass (in-memory stub + real Bun provider against tmp directory); the adapter does not directly import `Bun.file` anywhere — file I/O happens only through the provider and through the injected runtime context.

### P2 — Polish and verification

- [ ] 20. P2-A: Outright deletion of `registerHook`, `loadSkill`, `HookConfig`, `SkillConfig`
  **What**: Delete the two methods from the `HarnessAdapter` interface in `packages/engine/src/adapter.ts` (lines 73-97 and 99-109). Delete the `HookConfig` and `SkillConfig` interfaces from the same file. Delete the corresponding implementations from `MockAdapter` (`packages/engine/src/__tests__/mock-adapter.ts` — drop `registerHook`, `loadSkill`, the two `MockCall` discriminants, and the imports of the deleted types). Verify no production code depends on either method via `grep -rn "registerHook\|loadSkill\|HookConfig\|SkillConfig" packages/` — expect zero hits outside this task's deletions. Update the reference adapter from tasks 8-10 if it implemented no-op stubs (it should not have if Resolved Decision §5 was honoured from the start). Update `docs/adapter-boundary.md` to remove the "Transitional Interfaces" paragraphs about `registerHook()` and `loadSkill()` — both are now gone.
  **Files**: `packages/engine/src/adapter.ts`, `packages/engine/src/__tests__/mock-adapter.ts`, `packages/adapters/opencode/src/index.ts` (only if stubs accidentally landed), `docs/adapter-boundary.md`.
  **Acceptance**: `grep -rn "registerHook\|loadSkill\|HookConfig\|SkillConfig" packages/engine/src/` returns zero hits. `bun test` passes. Boundary doc updated.

- [ ] 21. P2: Run full verification matrix
  **What**: Execute every command in Definition of Done. Capture any failures and treat them as blockers, not flake. Confirm grep-based acceptance checks all return zero.
  **Acceptance**: All commands in Definition of Done succeed. The integration test added in tasks 10 + 19 produces the expected `DispatchAgentEffect` trace and validates against real `@opencode-ai/sdk` types.

- [ ] 22. P2: Living-documentation sweep and adapter-readiness status report
  **What**: Audit `docs/` for outdated references introduced by this work:
  - `docs/adapter-boundary.md` "Transitional Interfaces" must reflect deletions in task 20 and the bootstrap pattern in task 5.
  - Spec 15 already updated in task 4 — verify cross-links from Spec 17 / 18 / 19 are consistent.
  - `docs/legacy-architecture.md` is read-only history — do NOT edit.
  - Add `docs/adapter-readiness-status.md` summarising what shipped (`WeaveRunner` deletion, partial-by-default materialization, real-SDK reference adapter, workflow extension, routing block, plan-state provider, deprecated-method deletion) and what is still adapter-owned territory.
  **Files**: `docs/adapter-boundary.md`, `docs/adapter-readiness-status.md` (new), audit of cross-links from Specs 17/18/19 to Spec 15.
  **Acceptance**: All four AGENTS.md "Documentation checklist" items satisfied. Cross-links resolve. The status report lists every guarantee a third-party adapter can now rely on.

---

## Risk and Rollback

| Risk | Likelihood | Reversible? | Mitigation |
| --- | --- | --- | --- |
| `materializeAgents` shape change breaks an unknown external consumer | Low (no published downstream adapters exist; opencode adapter is empty) | Yes — restore the old type and behaviour from git in a follow-up. Existing engine tests are the only consumers and are updated atomically. | Land tasks 1-4 as one PR. CHANGELOG entry: "BREAKING — `materializeAgents` now returns partial-by-default; `MaterializationPlan` includes `errors[]` alongside `agents[]`. See Spec 15." |
| `WeaveRunner` deletion breaks an unknown external consumer | Low (no published consumers; opencode adapter empty) | Yes — restore from git; the file is small and self-contained | Land tasks 6-7 as a single PR. CHANGELOG entry: "BREAKING — `WeaveRunner` removed in favour of `materializeAgents` + adapter bootstrap. Migration: see `docs/adapter-bootstrap.md`." |
| Workflow merge semantics break a builtin parse | Medium — the four builtin workflows go through `mergeConfigs` | Yes — backwards-compatibility regression test catches it | Add an E2E test in task 13 that parses + merges the builtin source against an empty override and asserts the four builtin workflows are unchanged from current snapshot. |
| Parser changes for `extends`/`insert_before`/`insert_after`/`routing` introduce token ambiguity | Low — block keywords and scalar names are distinct lexemes | Partially reversible — parser rollback requires test backfill | Land parser change with extensive negative tests before merge logic; gate task 13 on task 12. |
| Plan-state provider migration breaks plan-driven tests | Medium — `execution-lifecycle.test.ts` writes real files in places (line 5051 region) | Yes | In task 18, replace test fixtures with an in-memory `PlanStateProvider` stub atomically with the production code change. Task 19 validates the real Bun provider in a tmp directory. |
| `routing { }` block strict-mode rejects pre-existing typos in user configs | Low — the block is new; no existing configs use it | Yes — relax to non-strict in a patch release | The whole point of strict mode is to surface typos. Document in Spec 18 release notes. |
| **Pinning to `@opencode-ai/sdk` types couples our test suite to SDK breaking changes** | Medium — the SDK is alpha-shaped; minor releases may shift agent-config types | Yes — pin a specific SDK version range in `package.json`; bump deliberately | Pin to a known-good version (e.g. `^X.Y.Z`). Add a note in `docs/adapter-readiness-status.md` flagging this as a periodic-review item: when the SDK ships a breaking change, the adapter's translation layer and tests need a deliberate update. Worth it for fidelity. |
| Real-SDK type validation in tests is flakier than synthetic type checks | Low — the SDK provides static types; runtime validators are optional | Yes — fall back to compile-time-only assertions if needed | Prefer compile-time typed values over runtime schema validators where possible; only use runtime validators when the SDK exports them. |

**Point-of-no-return moments:**
- **Tasks 1-3** (`materializeAgents` shape change + all callers + tests). Land as one PR. The new return shape is incompatible with any caller still expecting the old `MaterializationError` rejection path for per-agent failures.
- **Tasks 6-7** (`WeaveRunner` deletion + test rewrite). Must land in the same commit; every test that imported it must already be updated.
- **Task 18** (deleting `Bun.file` from `execution-lifecycle.ts`). After this lands, plan-completion semantics in production runs require an adapter provider. Land tasks 18 + 19 in the same PR so the reference adapter ships a working default at the same moment the engine drops its inline file I/O.
- **Task 20** (deleting `registerHook` / `loadSkill`). After this lands, any future adapter must not implement them. Update `MockAdapter` and any reference-adapter stubs in the same commit.

**Reversible:** all schema additions (tasks 12, 16, 18) are additive — rolling back means removing the optional fields; existing configs continue to parse.

---

## Verification

- [ ] `bun test` passes from repo root
- [ ] `bun run typecheck` passes from repo root
- [ ] `bun run build` passes (all packages emit dist + declarations, including `@weave/adapter-opencode`)
- [ ] `grep -rn "WeaveRunner" packages/` returns zero hits in source
- [ ] `grep -n "Bun.file" packages/engine/src/execution-lifecycle.ts` returns zero hits
- [ ] `grep -rn "registerHook\|loadSkill\|HookConfig\|SkillConfig" packages/engine/src/` returns zero hits
- [ ] `grep -rn "as any\|as unknown as" packages/adapters/opencode/src/` returns zero hits past the runtime-context boundary
- [ ] `grep -rn "materializeAgents" packages/` shows every caller reads `.agents` and `.errors`
- [ ] Reference adapter integration tests (tasks 10, 19) run a 2-step workflow against real `@opencode-ai/sdk` types and assert `DispatchAgentEffect` was applied
- [ ] All schema-changing tasks (12, 16) updated all four test layers per AGENTS.md
- [ ] New specs 17, 18, 19 exist under `docs/specs/` and are linked from `docs/adapter-boundary.md`
- [ ] Spec 15 amended to document partial-by-default `materializeAgents`
- [ ] `docs/adapter-bootstrap.md` exists and is linked from at least one other doc
- [ ] `docs/adapter-readiness-status.md` summarises the shipped surface and flags `@opencode-ai/sdk` pinning as a periodic-review item
